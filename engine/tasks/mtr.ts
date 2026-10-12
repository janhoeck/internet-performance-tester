// MTR pass (ARCHITECTURE §4.7, methodology §7.2–7.4): 20 TTL-limited probes per responding hop of
// the latest known path per family, ≤ 8 probes in flight, one round per second. Every round probes
// all hops together, so the stored round-aligned `rtts` (index r = round r + 1) allow the
// time-correlated propagation test (path-analysis.ts hopPropagation) besides the pathping-style
// attribution (persistent/link/node loss). Stored as a new traceroute row whose hops carry `mtr`
// statistics (trigger schedule/manual/incident) and published on bus 'traceroute'.
//
// Runs: every `mtrEveryMin` while a session runs (first pass 3 min after the start, after the
// startup discovery), on outage start (at most one per 10 min) and runNow(). Families run one after
// the other (≤ 8 concurrent probes overall). The probes run in ttl-probe.ps1 (shared runner in
// traceroute.ts), never in the shared PowerShell RPC worker.
import type { ChildProcess } from 'node:child_process';
import type { AppConfig } from '../../src/lib/shared/config';
import { sameIp } from '../../src/lib/shared/net';
import { buildMtrHops, buildTraceHops, hopPropagation, interpretPath } from '../../src/lib/shared/path-analysis';
import type { IpFamily, ModuleState, TraceHop, TracerouteResult } from '../../src/lib/shared/types';
import type { BusEvents, EngineContext, EngineModule, Logger, TaskResult } from '../core/types';
import {
  FAMILIES,
  FULL_MAX_HOPS,
  MAX_CONCURRENT_PROBES,
  PATH_TARGETS,
  PROBE_TIMEOUT_MS,
  discoveryPlan,
  errorText,
  isUsableTrace,
  localAddressChecker,
  pathHash,
  runTtlProbes,
  type TtlPlan,
  type TtlRunOptions,
  type TtlRunResult,
} from './traceroute';

export const MTR_ROUNDS = 20;
export const MTR_INTERVAL_MS = 1000;
export const MTR_INCIDENT_MIN_GAP_MS = 10 * 60_000;
/** a reached path older than this is no longer preferred over the latest discovery */
export const BASE_MAX_AGE_MS = 24 * 3_600_000;

const FIRST_RUN_DELAY_MS = 3 * 60_000;
const SPEEDTEST_RETRY_MS = 2 * 60_000;

export type MtrTrigger = 'schedule' | 'manual' | 'incident';

/** Row written by an MTR pass (hops carry `mtr` statistics). */
export function isMtrRow(r: Pick<TracerouteResult, 'hops'>): boolean {
  return r.hops.some((h) => h.mtr !== undefined && h.mtr !== null);
}

/** TTLs worth 20 probes: every hop that answered in the base path (silent hops are skipped). */
export function mtrTtls(base: readonly TraceHop[]): number[] {
  return base
    .filter((h) => h.ip !== null)
    .map((h) => h.hop)
    .sort((a, b) => a - b);
}

export function mtrPlan(dst: string, ttls: number[]): TtlPlan {
  return {
    dst,
    ttls,
    rounds: MTR_ROUNDS,
    timeoutMs: PROBE_TIMEOUT_MS,
    maxConc: MAX_CONCURRENT_PROBES,
    intervalMs: MTR_INTERVAL_MS,
    stopAtDest: true,
    trimSilent: 0,
    size: 32,
  };
}

/**
 * Base path of an MTR pass: the latest discovery that reached the destination (≤ 24 h old) – during
 * an outage this keeps probing the hops behind the break, which is exactly what shows where the
 * loss starts – else the latest usable discovery.
 */
export function pickBase(latest: TracerouteResult | null, latestReached: TracerouteResult | null, now: number): TracerouteResult | null {
  if (latestReached && now - latestReached.ts <= BASE_MAX_AGE_MS) return latestReached;
  return latest;
}

/** Hops of a stored row as MTR base (previous MTR statistics dropped). */
export function baseHops(r: Pick<TracerouteResult, 'hops'>): TraceHop[] {
  return r.hops.map((h) => ({ hop: h.hop, ip: h.ip, rtts: [...h.rtts], lossPct: h.lossPct, avgMs: h.avgMs }));
}

/** The destination answered at least once during the pass. */
export function mtrReached(hops: readonly TraceHop[], target: string): boolean {
  return hops.some(
    (h) => h.ip !== null && sameIp(h.ip, target) && (h.mtr ? h.mtr.lost < h.mtr.sent : h.rtts.some((r) => r !== null)),
  );
}

/** One log line: interpretation summary + propagation verdicts of the intermediate hops. */
export function describeMtr(r: TracerouteResult): string {
  const interp = interpretPath(r.hops, r.reached);
  const verdicts = hopPropagation(r.hops)
    .filter((p) => p.verdict !== null)
    .map((p) => `hop ${p.hop} ${p.verdict} (${p.propagated}/${p.events})`);
  const hops = r.hops
    .filter((h) => h.mtr)
    .map((h) => `${h.hop}:${h.mtr ? `${Math.round(h.mtr.lossPct)}%/${h.mtr.avgMs === null ? '–' : h.mtr.avgMs.toFixed(1)}ms` : ''}`)
    .join(' ');
  return `IPv${r.family} ${hops} | ${interp.summary}${verdicts.length ? ` | ${verdicts.join(', ')}` : ''}`;
}

export interface MtrModuleOptions {
  runTtl?: (plan: TtlPlan, opts: TtlRunOptions) => Promise<TtlRunResult>;
  /** schedule check interval (default 30 s; wall clock, survives standby) */
  checkIntervalMs?: number;
  /** first scheduled pass after the session start (default 3 min) */
  firstRunDelayMs?: number;
}

/** German failure for ModuleState.lastError */
class MtrError extends Error {}

export function createMtrModule(opts: MtrModuleOptions = {}): EngineModule {
  const runTtl = opts.runTtl ?? runTtlProbes;
  const checkMs = opts.checkIntervalMs ?? 30_000;
  const firstRunDelayMs = opts.firstRunDelayMs ?? FIRST_RUN_DELAY_MS;

  let ctx: EngineContext | null = null;
  let log: Logger | null = null;
  const unsubscribe: (() => void)[] = [];
  const paths: Record<IpFamily, { latest: TracerouteResult | null; reached: TracerouteResult | null }> = {
    4: { latest: null, reached: null },
    6: { latest: null, reached: null },
  };
  let scheduled = false;
  let checkTimer: NodeJS.Timeout | null = null;
  let nextRunTs: number | null = null;
  let lastRunTs: number | null = null;
  let lastError: string | null = null;
  let lastIncidentTs: number | null = null;
  let current: { abort: AbortController; trigger: MtrTrigger; done: Promise<TracerouteResult[]> } | null = null;

  const intervalMs = (cfg: AppConfig) => Math.max(1, cfg.schedules.mtrEveryMin) * 60_000;

  function remember(r: TracerouteResult): void {
    if (isMtrRow(r) || !isUsableTrace(r)) return;
    const p = paths[r.family];
    if (!p.latest || r.ts >= p.latest.ts) p.latest = r;
    if (r.reached && (!p.reached || r.ts >= p.reached.ts)) p.reached = r;
  }

  async function basePath(c: EngineContext, family: IpFamily, signal: AbortSignal, isLocal: (ip: string) => boolean): Promise<TraceHop[] | null> {
    const base = pickBase(paths[family].latest, paths[family].reached, Date.now());
    if (base) return baseHops(base);
    // no path known yet (first start, no discovery so far): quick discovery first
    const target = PATH_TARGETS[family];
    const disc = await runTtl(discoveryPlan(target, FULL_MAX_HOPS), { signal, track: (ch: ChildProcess) => c.trackChild(ch), isLocal });
    if (signal.aborted) return null;
    if (!disc.ok) throw new MtrError(`MTR IPv${family}: Pfad unbekannt, Pfaderkennung fehlgeschlagen (${disc.error ?? 'unbekannter Fehler'})`);
    return buildTraceHops(disc.probes, { silentTail: 2 }).hops;
  }

  async function measure(c: EngineContext, family: IpFamily, trigger: MtrTrigger, signal: AbortSignal): Promise<TracerouteResult | null> {
    const target = PATH_TARGETS[family];
    const ts = Date.now();
    const t0 = performance.now();
    const isLocal = localAddressChecker();
    const base = await basePath(c, family, signal, isLocal);
    if (!base) return null;
    const ttls = mtrTtls(base);
    if (ttls.length === 0) throw new MtrError(`MTR IPv${family}: kein antwortender Hop bekannt`);
    const run = await runTtl(mtrPlan(target, ttls), { signal, track: (ch: ChildProcess) => c.trackChild(ch), isLocal });
    if (signal.aborted) return null;
    if (!run.ok) throw new MtrError(`MTR IPv${family} fehlgeschlagen (${run.error ?? 'unbekannter Fehler'})`);
    if (run.error) log?.debug(`MTR IPv${family}: ${run.error}`);
    const hops = buildMtrHops(base, run.probes, MTR_ROUNDS);
    const result: TracerouteResult = {
      ts,
      target,
      family,
      hops,
      reached: mtrReached(hops, target),
      pathHash: pathHash(hops),
      changed: false,
      trigger,
      durationMs: Math.round(performance.now() - t0),
    };
    try {
      result.id = c.db.insertTraceroute(result);
    } catch (err) {
      log?.error('could not store MTR result', { error: errorText(err) });
    }
    c.bus.emit('traceroute', result);
    log?.info(`MTR ${describeMtr(result)} [${trigger}, ${result.durationMs} ms]`);
    return result;
  }

  function launch(trigger: MtrTrigger): Promise<TracerouteResult[]> {
    const c = ctx;
    if (!c) return Promise.resolve([]);
    const abort = new AbortController();
    const startedAt = Date.now();
    const done = (async () => {
      const results: TracerouteResult[] = [];
      const errors: string[] = [];
      for (const f of FAMILIES) {
        if (abort.signal.aborted) break;
        try {
          const r = await measure(c, f, trigger, abort.signal);
          if (r) results.push(r);
        } catch (err) {
          errors.push(err instanceof MtrError ? err.message : `MTR IPv${f}: unerwarteter Fehler (${errorText(err)})`);
          log?.warn(`MTR IPv${f} failed`, { error: errorText(err) });
        }
      }
      if (!abort.signal.aborted) {
        lastRunTs = startedAt;
        lastError = errors.length > 0 ? errors.join(' · ') : null;
      }
      return results;
    })().finally(() => {
      if (current?.abort === abort) current = null;
    });
    current = { abort, trigger, done };
    return done;
  }

  function check(): void {
    const c = ctx;
    if (!c || !scheduled || current) return;
    const now = Date.now();
    if (nextRunTs === null || now < nextRunTs) return;
    if (c.speedtestActive()) {
      nextRunTs = now + SPEEDTEST_RETRY_MS;
      return;
    }
    nextRunTs = now + intervalMs(c.config());
    void launch('schedule');
  }

  function onIncident(i: BusEvents['incident']): void {
    const c = ctx;
    if (!c || !scheduled || i.kind !== 'outage-start' || current || c.speedtestActive()) return;
    const now = Date.now();
    if (lastIncidentTs !== null && now - lastIncidentTs < MTR_INCIDENT_MIN_GAP_MS) return;
    lastIncidentTs = now;
    log?.info(`outage (${i.classification}) – incident MTR`);
    void launch('incident');
  }

  async function abortCurrent(includeManual: boolean): Promise<void> {
    const cur = current;
    if (!cur || (!includeManual && cur.trigger === 'manual')) return;
    cur.abort.abort();
    await Promise.race([cur.done.catch(() => undefined), new Promise((r) => setTimeout(r, 3000).unref())]);
  }

  function clearTimer(): void {
    if (checkTimer) clearInterval(checkTimer);
    checkTimer = null;
  }

  return {
    name: 'mtr',

    init(c: EngineContext) {
      ctx = c;
      log = c.log;
      for (const f of FAMILIES) {
        try {
          const last = c.db.latestTraceroute(f);
          // the latest row may be an MTR row – its hop addresses are a valid base as well
          if (last && isUsableTrace(last)) {
            paths[f].latest = last;
            if (last.reached) paths[f].reached = last;
          }
        } catch (err) {
          log.warn(`could not read the latest IPv${f} traceroute`, { error: errorText(err) });
        }
      }
      unsubscribe.push(c.bus.on('traceroute', remember), c.bus.on('incident', onIncident));
    },

    start() {
      if (!ctx) return;
      scheduled = true;
      nextRunTs = Date.now() + firstRunDelayMs;
      if (!checkTimer) {
        checkTimer = setInterval(check, checkMs);
        checkTimer.unref();
      }
    },

    async stop() {
      scheduled = false;
      clearTimer();
      nextRunTs = null;
      await abortCurrent(false);
    },

    async dispose() {
      scheduled = false;
      clearTimer();
      nextRunTs = null;
      await abortCurrent(true);
      for (const off of unsubscribe.splice(0)) off();
    },

    reconfigure(cfg: AppConfig) {
      if (!scheduled || nextRunTs === null || lastRunTs === null) return;
      nextRunTs = Math.max(Date.now() + 5_000, lastRunTs + intervalMs(cfg));
    },

    async runNow(): Promise<TaskResult<TracerouteResult[]>> {
      if (!ctx) throw new Error('MTR-Modul ist nicht initialisiert');
      if (current) throw new Error('Eine MTR-Messung läuft bereits');
      const results = await launch('manual');
      if (results.length === 0) return { ok: false, error: lastError ?? 'MTR-Messung fehlgeschlagen' };
      return { ok: true, result: results };
    },

    state(): ModuleState {
      return {
        name: 'mtr',
        enabled: true,
        running: scheduled,
        busy: current !== null,
        lastRunTs,
        nextRunTs: scheduled ? nextRunTs : null,
        lastError,
      };
    },
  };
}
