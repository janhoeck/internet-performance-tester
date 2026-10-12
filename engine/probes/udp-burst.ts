// UDP burst test (module 'udpburst', ARCHITECTURE §4.5): for every enabled udp-dns INTERNET target,
// `packetsPerSecond × durationSec` DNS queries at drift-corrected spacing over one persistent
// socket (game-like packet rate through NAT/AFTR). One warm-up query (mapping creation) is not
// counted. Metrics udp.burst.<id>.{loss_pct, avg_ms, p99_ms, jitter_ms}. Runs every
// `udpBurstEveryMin` during a session and manually (also without a session); skipped – and
// discarded when it starts meanwhile – while a speed test saturates the line.
import { performance } from 'node:perf_hooks';
import type { AppConfig } from '../../src/lib/shared/config';
import { enabledTargets } from '../../src/lib/shared/config';
import { udpBurstKey } from '../../src/lib/shared/metrics';
import { chainJitter, quantileSorted } from '../../src/lib/shared/stats';
import { type MetricPoint, type ModuleState, SampleStatus, type TargetConfig } from '../../src/lib/shared/types';
import type { EngineContext, EngineModule, TaskResult } from '../core/types';
import { errorMessage, sleep } from './common';
import { HostCache, pendingText, targetAddress } from './resolve';
import { type DnsProbeResult, type DnsQuestionSpec, UdpDnsClient, questionForQuery } from './udp-dns';

export interface BurstStats {
  targetId: string;
  sent: number;
  received: number;
  lossPct: number;
  avgMs: number | null;
  p50Ms: number | null;
  p99Ms: number | null;
  maxMs: number | null;
  /** MASD over consecutive answers in send order (a loss breaks the chain) */
  jitterMs: number | null;
  /** Cloudflare PoP from the id.server TXT answer */
  pop: string | null;
}

export interface BurstRunResult {
  ts: number;
  trigger: 'schedule' | 'manual';
  pps: number;
  durationSec: number;
  targets: BurstStats[];
  skipped: { targetId: string; reason: string }[];
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/** Statistics of one burst; `rtts` in send order, null = lost. Pure. */
export function computeBurstStats(targetId: string, rtts: readonly (number | null)[], pop: string | null = null): BurstStats {
  const ok = rtts.filter((r): r is number => r !== null && Number.isFinite(r));
  const sorted = [...ok].sort((a, b) => a - b);
  const sent = rtts.length;
  const jit = chainJitter(rtts);
  const sum = ok.reduce((a, b) => a + b, 0);
  const q = (p: number) => {
    const v = quantileSorted(sorted, p);
    return v === null ? null : round2(v);
  };
  return {
    targetId,
    sent,
    received: ok.length,
    lossPct: sent > 0 ? round2(((sent - ok.length) / sent) * 100) : 0,
    avgMs: ok.length > 0 ? round2(sum / ok.length) : null,
    p50Ms: q(0.5),
    p99Ms: q(0.99),
    maxMs: sorted.length > 0 ? round2(sorted[sorted.length - 1]) : null,
    jitterMs: jit.pairs > 0 ? round2(jit.sum / jit.pairs) : null,
    pop,
  };
}

/** Metric points of one burst (keys from metrics.ts); null statistics are omitted. */
export function burstMetrics(ts: number, s: BurstStats): MetricPoint[] {
  const out: MetricPoint[] = [];
  if (s.sent > 0) out.push({ ts, key: udpBurstKey(s.targetId, 'loss_pct'), value: s.lossPct });
  if (s.avgMs !== null) out.push({ ts, key: udpBurstKey(s.targetId, 'avg_ms'), value: s.avgMs });
  if (s.p99Ms !== null) out.push({ ts, key: udpBurstKey(s.targetId, 'p99_ms'), value: s.p99Ms });
  if (s.jitterMs !== null) out.push({ ts, key: udpBurstKey(s.targetId, 'jitter_ms'), value: s.jitterMs });
  return out;
}

export interface DnsClientLike {
  query(timeoutMs: number): Promise<DnsProbeResult>;
  close(): void;
}

export interface BurstOptions {
  server: string;
  port: number;
  family: 4 | 6;
  question: DnsQuestionSpec;
  pps: number;
  durationSec: number;
  timeoutMs: number;
  /** abort early (results are discarded by the caller) */
  shouldAbort?: () => boolean;
  createClient?: (server: string, port: number, family: 4 | 6, q: DnsQuestionSpec) => DnsClientLike;
  /** monotonic clock for the send schedule (ms) */
  now?: () => number;
}

/** Run one burst against one server. Returns RTTs in send order (null = lost) and the PoP name. */
export async function runUdpBurst(o: BurstOptions): Promise<{ rtts: (number | null)[]; pop: string | null; aborted: boolean }> {
  const client = (o.createClient ?? ((s, p, f, q) => new UdpDnsClient(s, p, f, q)))(o.server, o.port, o.family, o.question);
  try {
    // warm-up: creates the NAT/AFTR mapping, not counted
    const warm = await client.query(o.timeoutMs);
    let pop = warm.txt[0] ?? null;
    const total = Math.max(1, Math.round(o.pps * o.durationSec));
    const spacing = 1000 / o.pps;
    const now = o.now ?? (() => performance.now());
    const start = now() + 10;
    const results: Promise<DnsProbeResult>[] = [];
    let aborted = false;
    for (let k = 0; k < total; k++) {
      if (o.shouldAbort?.()) {
        aborted = true;
        break;
      }
      // drift-corrected: each send is due at start + k · spacing, independent of timer lateness
      const wait = start + k * spacing - now();
      if (wait > 1) await sleep(wait);
      results.push(client.query(o.timeoutMs));
    }
    const answers = await Promise.all(results);
    for (const a of answers) if (a.txt.length > 0) pop = a.txt[0];
    return { rtts: answers.map((a) => (a.status === SampleStatus.OK ? a.rtt : null)), pop, aborted };
  } finally {
    client.close();
  }
}

export interface UdpBurstDeps {
  createClient: BurstOptions['createClient'];
  hostCache: Pick<HostCache, 'resolve'>;
  /** delay of the first scheduled run after the session start */
  firstRunDelayMs: number;
  /** monotonic clock for the send schedule (default performance.now) */
  now?: () => number;
}

class UdpBurstModule implements EngineModule {
  readonly name = 'udpburst';
  private ctx: EngineContext | null = null;
  private timer: NodeJS.Timeout | null = null;
  private scheduledEveryMin: number | null = null;
  private sessionActive = false;
  private busy = false;
  private lastRunTs: number | null = null;
  private nextRunTs: number | null = null;
  private lastError: string | null = null;
  private lastResult: BurstRunResult | null = null;
  private readonly deps: UdpBurstDeps;

  constructor(deps: Partial<UdpBurstDeps>) {
    this.deps = {
      createClient: deps.createClient,
      hostCache: deps.hostCache ?? new HostCache(),
      firstRunDelayMs: deps.firstRunDelayMs ?? 60_000,
      now: deps.now,
    };
  }

  init(ctx: EngineContext): void {
    this.ctx = ctx;
  }

  start(): void {
    if (!this.ctx) return;
    this.sessionActive = true;
    this.scheduleAfter(this.deps.firstRunDelayMs);
  }

  stop(): void {
    this.sessionActive = false;
    this.clearTimer();
  }

  dispose(): void {
    this.stop();
  }

  reconfigure(cfg: AppConfig): void {
    if (!this.sessionActive || this.scheduledEveryMin === cfg.schedules.udpBurstEveryMin) return;
    this.scheduleAfter(cfg.schedules.udpBurstEveryMin * 60_000);
  }

  async runNow(): Promise<TaskResult<BurstRunResult>> {
    return this.run('manual');
  }

  /** Result of the most recent burst (for status/debugging). */
  latest(): BurstRunResult | null {
    return this.lastResult;
  }

  state(): ModuleState {
    return {
      name: this.name,
      enabled: true,
      running: this.sessionActive,
      busy: this.busy,
      lastRunTs: this.lastRunTs,
      nextRunTs: this.nextRunTs,
      lastError: this.lastError,
    };
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.nextRunTs = null;
    this.scheduledEveryMin = null;
  }

  private scheduleAfter(delayMs: number): void {
    if (!this.ctx) return;
    this.clearTimer();
    this.scheduledEveryMin = this.ctx.config().schedules.udpBurstEveryMin;
    this.nextRunTs = Date.now() + delayMs;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.run('schedule').finally(() => {
        if (this.sessionActive && this.ctx) this.scheduleAfter(this.ctx.config().schedules.udpBurstEveryMin * 60_000);
      });
    }, delayMs);
  }

  private async run(trigger: 'schedule' | 'manual'): Promise<TaskResult<BurstRunResult>> {
    const ctx = this.ctx;
    if (!ctx) return { ok: false, error: 'Modul nicht initialisiert' };
    if (this.busy) return { ok: false, error: 'UDP-Burst läuft bereits' };
    if (ctx.speedtestActive()) {
      this.lastError = 'Übersprungen: Speedtest läuft';
      return { ok: false, error: this.lastError };
    }
    const cfg = ctx.config();
    const targets = enabledTargets(cfg).filter((t) => t.kind === 'udp-dns' && t.segment === 'internet');
    if (targets.length === 0) {
      this.lastError = 'Kein aktives UDP-Ziel (Internet) konfiguriert';
      return { ok: false, error: this.lastError };
    }
    this.busy = true;
    const ts = Date.now();
    const pps = cfg.udpBurst.packetsPerSecond;
    const durationSec = cfg.udpBurst.durationSec;
    const skipped: BurstRunResult['skipped'] = [];
    try {
      const runs = await Promise.all(targets.map((t) => this.burstTarget(ctx, t, pps, durationSec, skipped)));
      if (ctx.speedtestActive() || runs.some((r) => r?.aborted)) {
        this.lastError = 'Abgebrochen: Speedtest gestartet';
        return { ok: false, error: this.lastError };
      }
      const stats = runs.filter((r): r is { stats: BurstStats; aborted: boolean } => r !== null).map((r) => r.stats);
      const points = stats.flatMap((s) => burstMetrics(ts, s));
      if (points.length > 0) ctx.recordMetrics(points);
      const result: BurstRunResult = { ts, trigger, pps, durationSec, targets: stats, skipped };
      this.lastResult = result;
      this.lastRunTs = ts;
      this.lastError = skipped.length > 0 ? skipped.map((s) => `${s.targetId}: ${s.reason}`).join('; ') : null;
      ctx.log.info(
        `udp burst (${trigger}): ${stats.map((s) => `${s.targetId} loss ${s.lossPct}% avg ${s.avgMs ?? '–'} ms p99 ${s.p99Ms ?? '–'} ms jitter ${s.jitterMs ?? '–'} ms`).join(' | ')}`,
      );
      return { ok: true, result };
    } catch (err) {
      this.lastError = `UDP-Burst fehlgeschlagen: ${errorMessage(err)}`;
      return { ok: false, error: this.lastError };
    } finally {
      this.busy = false;
    }
  }

  private async burstTarget(
    ctx: EngineContext,
    t: TargetConfig,
    pps: number,
    durationSec: number,
    skipped: BurstRunResult['skipped'],
  ): Promise<{ stats: BurstStats; aborted: boolean } | null> {
    const addr = targetAddress(ctx.hosts, t);
    let ip: string;
    if (addr.kind === 'pending') {
      skipped.push({ targetId: t.id, reason: pendingText(addr.placeholder) });
      return null;
    }
    if (addr.kind === 'dns') {
      try {
        ip = await this.deps.hostCache.resolve(addr.host, t.family);
      } catch (err) {
        skipped.push({ targetId: t.id, reason: errorMessage(err) });
        return null;
      }
    } else {
      ip = addr.ip;
    }
    const r = await runUdpBurst({
      server: ip,
      port: t.port ?? 53,
      family: t.family,
      question: questionForQuery(t.query),
      pps,
      durationSec,
      timeoutMs: t.timeoutMs,
      shouldAbort: () => ctx.speedtestActive(),
      createClient: this.deps.createClient,
      now: this.deps.now,
    });
    return { stats: computeBurstStats(t.id, r.rtts, r.pop), aborted: r.aborted };
  }
}

export function createUdpBurstModule(deps: Partial<UdpBurstDeps> = {}): EngineModule {
  return new UdpBurstModule(deps);
}
