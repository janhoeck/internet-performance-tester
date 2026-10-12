// Per-target latency baselines (docs/ARCHITECTURE.md §4.6, methodology.md §5).
// One tracker per engine is shared by the incident detector, the per-second classifier and the
// minute rollups. Every sample is judged exactly once (memoized per (targetId, ts)) and OK
// samples feed the baseline exactly once, no matter how many modules ask for the verdict.
import { type AppConfig, spikeRuleFor } from '../../src/lib/shared/config';
import {
  type Baseline,
  BaselineWindow,
  type SpikeRule,
  type SpikeSeverity,
  isSpike,
  spikeSeverity,
} from '../../src/lib/shared/stats';
import { type DynamicHosts, type Rollup, type Sample, SampleFlag, type TargetConfig } from '../../src/lib/shared/types';
import type { Bus, EngineContext } from '../core/types';
import { MINUTE_MS, TargetIndex, errorMessage, guard, hasFlag, isLost } from './common';

export interface SpikeVerdict {
  /** successful reply with a finite RTT */
  ok: boolean;
  spike: boolean;
  /** null unless spike */
  severity: SpikeSeverity | null;
  /** baseline the sample was judged against (before it was added), null while warming up */
  baseline: Baseline | null;
  /**
   * RTT measured by the engine process itself (TCP/UDP/HTTP probes) while its event loop was
   * blocked (noteStall) – the value includes the stall and is no valid latency measurement.
   * Such samples are never spikes, never feed the baseline and are skipped by the analysis.
   */
  unreliable: boolean;
}

export interface BaselineTrackerOptions {
  config: () => AppConfig;
  now?: () => number;
  /** BaselineWindow size (successful samples), default 600 */
  windowSize?: number;
  /** samples needed before a baseline exists, default 60 */
  minCount?: number;
  /** how long verdicts stay memoized, default 120 s */
  memoTtlMs?: number;
  /** hard cap of memoized verdicts, default 50 000 */
  memoMax?: number;
  /** how long stall windows are remembered, default 10 min */
  stallKeepMs?: number;
}

/** minute p50 values pushed per target when warming from rollups (= BaselineWindow minCount) */
export const WARM_MINUTES = 60;
/** rollups are looked up this far back for warming (EngineDb.rollupsSince allows ≤ 24 h) */
export const WARM_LOOKBACK_MS = 24 * 60 * MINUTE_MS;
/** slack added to the probe interval [ts, ts + rtt] when matching stall windows */
const STALL_SLACK_MS = 100;

const HOST_PLACEHOLDER: Record<keyof DynamicHosts, string> = {
  gateway: '$gateway',
  isp4: '$isp4',
  isp6: '$isp6',
  aftr: '$aftr',
  router6: '$router6',
};

function targetSignature(t: TargetConfig): string {
  return `${t.host}|${t.family}|${t.kind}|${t.port ?? ''}|${t.query ?? ''}|${t.path ?? ''}|${t.segment}`;
}

export class BaselineTracker {
  private readonly windows = new Map<string, BaselineWindow>();
  private readonly memo = new Map<string, { at: number; v: SpikeVerdict }>();
  private readonly index: TargetIndex;
  private readonly now: () => number;
  private readonly windowSize: number;
  private readonly minCount: number;
  private readonly memoTtlMs: number;
  private readonly memoMax: number;
  private readonly stallKeepMs: number;
  private signatures = new Map<string, string>();
  private stalls: { from: number; to: number }[] = [];
  /** samples judged unreliable because of an engine stall */
  unreliableCount = 0;

  constructor(opts: BaselineTrackerOptions) {
    this.index = new TargetIndex(opts.config);
    this.now = opts.now ?? Date.now;
    this.windowSize = opts.windowSize ?? 600;
    this.minCount = opts.minCount ?? 60;
    this.memoTtlMs = opts.memoTtlMs ?? 120_000;
    this.memoMax = opts.memoMax ?? 50_000;
    this.stallKeepMs = opts.stallKeepMs ?? 10 * MINUTE_MS;
    this.signatures = this.snapshotSignatures(this.index.current());
  }

  /**
   * Spike verdict of a sample, judged against the baseline BEFORE the sample is added.
   * Memoized per (targetId, ts); OK samples (without the LOAD flag) feed the baseline once.
   */
  verdict(s: Sample): SpikeVerdict {
    const key = `${s.targetId}|${s.ts}`;
    const hit = this.memo.get(key);
    if (hit) return hit.v;
    const v = this.evaluate(s);
    this.remember(key, v);
    return v;
  }

  /** current baseline of a target (null while warming up) */
  baseline(targetId: string): Baseline | null {
    return this.windows.get(targetId)?.get() ?? null;
  }

  /** number of values in the target's baseline window */
  count(targetId: string): number {
    return this.windows.get(targetId)?.count ?? 0;
  }

  ruleFor(targetId: string): SpikeRule {
    const cfg = this.index.current();
    const t = this.index.get(targetId);
    return spikeRuleFor(cfg, t?.segment ?? 'internet');
  }

  /** spike test against the current baseline without feeding it (rollup backfill) */
  isSpikeNow(targetId: string, rtt: number): boolean {
    return isSpike(rtt, this.baseline(targetId), this.ruleFor(targetId));
  }

  /**
   * The engine's event loop was blocked in [from, to] (e.g. a synchronous retention purge).
   * Must be called synchronously right after the blocking call returns – before any I/O callback
   * can deliver a probe result measured across the stall.
   */
  noteStall(from: number, to: number): void {
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return;
    this.stalls.push({ from, to });
    const keepAfter = Math.max(...this.stalls.map((w) => w.to)) - this.stallKeepMs;
    this.stalls = this.stalls.filter((w) => w.to >= keepAfter);
  }

  /**
   * Warm baselines from minute rollups: the p50 of each of the last `perTarget` minutes with
   * data counts as one value. With `onlyEmpty`, targets that already have values are skipped
   * (re-warm after a backfill). Returns the number of values pushed.
   */
  warm(rollups: readonly Rollup[], opts: { onlyEmpty?: boolean; perTarget?: number } = {}): number {
    const perTarget = Math.max(0, opts.perTarget ?? Number.POSITIVE_INFINITY);
    const byTarget = new Map<string, Rollup[]>();
    for (const r of rollups) {
      if (r.p50 === null || !Number.isFinite(r.p50)) continue;
      if (opts.onlyEmpty && this.count(r.targetId) > 0) continue;
      let list = byTarget.get(r.targetId);
      if (!list) {
        list = [];
        byTarget.set(r.targetId, list);
      }
      list.push(r);
    }
    let pushed = 0;
    for (const [id, list] of byTarget) {
      list.sort((a, b) => a.ts - b.ts);
      const w = this.window(id);
      for (const r of list.slice(Math.max(0, list.length - perTarget))) {
        w.push(r.p50 as number);
        pushed++;
      }
    }
    return pushed;
  }

  /** forget the baseline of one target (or all) – e.g. after the target's host changed */
  reset(targetId?: string): void {
    if (targetId === undefined) this.windows.clear();
    else this.windows.delete(targetId);
  }

  /** reset targets whose dynamic host placeholder now resolves to a different address */
  onHostsChanged(prev: DynamicHosts | null, next: DynamicHosts): string[] {
    if (!prev) return [];
    const changed = (Object.keys(HOST_PLACEHOLDER) as (keyof DynamicHosts)[])
      .filter((k) => prev[k] !== null && prev[k] !== next[k])
      .map((k) => HOST_PLACEHOLDER[k]);
    if (changed.length === 0) return [];
    const reset = this.index
      .current()
      .targets.filter((t) => changed.includes(t.host))
      .map((t) => t.id);
    for (const id of reset) this.reset(id);
    return reset;
  }

  /** reset targets whose host/kind/segment changed in a new config */
  onConfigChanged(cfg: AppConfig): string[] {
    const next = this.snapshotSignatures(cfg);
    const reset: string[] = [];
    for (const [id, sig] of next) {
      const old = this.signatures.get(id);
      if (old !== undefined && old !== sig) reset.push(id);
    }
    this.signatures = next;
    for (const id of reset) this.reset(id);
    return reset;
  }

  private snapshotSignatures(cfg: AppConfig): Map<string, string> {
    return new Map(cfg.targets.map((t) => [t.id, targetSignature(t)]));
  }

  private window(targetId: string): BaselineWindow {
    let w = this.windows.get(targetId);
    if (!w) {
      w = new BaselineWindow(this.windowSize, this.minCount);
      this.windows.set(targetId, w);
    }
    return w;
  }

  /** engine-measured probe whose measurement interval overlaps a known stall */
  private stalled(s: Sample, rtt: number): boolean {
    if (this.stalls.length === 0) return false;
    const t = this.index.get(s.targetId);
    // ICMP is timed by the pinger agent (separate process) – engine stalls do not distort it
    if (!t || t.kind === 'icmp') return false;
    const from = s.ts;
    const to = s.ts + rtt + STALL_SLACK_MS;
    return this.stalls.some((w) => from <= w.to && to >= w.from);
  }

  private evaluate(s: Sample): SpikeVerdict {
    const win = this.window(s.targetId);
    const baseline = win.get();
    const rtt = s.rtt;
    if (rtt === null || isLost(s)) return { ok: false, spike: false, severity: null, baseline, unreliable: false };
    if (this.stalled(s, rtt)) {
      this.unreliableCount++;
      return { ok: true, spike: false, severity: null, baseline, unreliable: true };
    }
    const rule = this.ruleFor(s.targetId);
    const spike = isSpike(rtt, baseline, rule);
    const verdict: SpikeVerdict = {
      ok: true,
      spike,
      severity: spike ? spikeSeverity(rtt, baseline, rule) : null,
      baseline,
      unreliable: false,
    };
    // RTTs measured while a speed test saturates the line would inflate the baseline
    if (!hasFlag(s, SampleFlag.LOAD)) win.push(rtt);
    return verdict;
  }

  private remember(key: string, v: SpikeVerdict): void {
    const now = this.now();
    this.memo.set(key, { at: now, v });
    for (const [k, e] of this.memo) {
      if (this.memo.size > this.memoMax || now - e.at > this.memoTtlMs) this.memo.delete(k);
      else break;
    }
  }
}

// ─── one shared tracker per engine ─────────────────────────────────────────

/**
 * Keyed by the bus: E-core hands every module its own copy of the context (forModule() with a
 * scoped logger), but bus and db are the same objects for the whole engine.
 */
const trackers = new WeakMap<Bus, BaselineTracker>();

/**
 * The engine-wide baseline tracker. Created on first use: warmed from minute rollups (the last
 * 60 minutes with data within 24 h, one p50 per minute), then fed with every recorded sample
 * (bus 'sample') at arrival time.
 */
export function getBaselineTracker(ctx: EngineContext): BaselineTracker {
  const existing = trackers.get(ctx.bus);
  if (existing) return existing;
  const log = ctx.log.child('baseline');
  const onError = (err: unknown) => log.warn(`Baseline-Fehler: ${errorMessage(err)}`);
  const tracker = new BaselineTracker({ config: () => ctx.config() });
  trackers.set(ctx.bus, tracker);
  guard(onError, () => {
    const pushed = tracker.warm(ctx.db.rollupsSince(Date.now() - WARM_LOOKBACK_MS), { perTarget: WARM_MINUTES });
    log.debug('baselines warmed from rollups', { values: pushed });
  });
  let hosts: DynamicHosts | null = null;
  guard(onError, () => {
    hosts = { ...ctx.hosts.get() };
  });
  ctx.bus.on('sample', (s) => guard(onError, () => tracker.verdict(s)));
  ctx.bus.on('dynamicHosts', (h) =>
    guard(onError, () => {
      const reset = tracker.onHostsChanged(hosts, h);
      if (reset.length > 0) log.info('baselines reset after host change', { targets: reset });
      hosts = { ...h };
    }),
  );
  ctx.bus.on('config', (cfg) =>
    guard(onError, () => {
      const reset = tracker.onConfigChanged(cfg);
      if (reset.length > 0) log.info('baselines reset after target change', { targets: reset });
    }),
  );
  return tracker;
}
