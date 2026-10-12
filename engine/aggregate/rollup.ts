// Minute rollups per target (table rollup_1m) + retention (docs/ARCHITECTURE.md §4.6).
// Always on: every recorded sample goes into a (target, minute) bucket; a minute is finalized
// 65 s after it started (late replies/timeouts are in by then) with summarize() and the spike
// count from the shared baseline verdicts. On start, minutes with raw samples but no rollup
// (crash, restart) are backfilled; the database is purged hourly per config.retention.
import { summarize } from '../../src/lib/shared/stats';
import type { ModuleState, Rollup, Sample } from '../../src/lib/shared/types';
import type { EngineContext, EngineDb, EngineModule } from '../core/types';
import { WARM_LOOKBACK_MS, WARM_MINUTES, getBaselineTracker } from '../analysis/baseline';
import { MINUTE_MS, errorMessage, guard, isLost, minuteOf } from '../analysis/common';

const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
/** stalls shorter than this are not worth reporting to the baseline tracker */
const STALL_NOTE_MIN_MS = 50;

export interface RollupEntry {
  ts: number;
  /** null = lost */
  rtt: number | null;
  spike: boolean;
}

/** Minute aggregate of one target; entries are put in send order, duplicate ts are dropped. */
export function buildRollup(targetId: string, minuteTs: number, entries: readonly RollupEntry[]): Rollup {
  const sorted = [...entries].sort((a, b) => a.ts - b.ts);
  const rtts: (number | null)[] = [];
  let spikes = 0;
  let lastTs = Number.NaN;
  for (const e of sorted) {
    if (e.ts === lastTs) continue;
    lastTs = e.ts;
    rtts.push(e.rtt);
    if (e.rtt !== null && e.spike) spikes++;
  }
  return { ts: minuteTs, targetId, spikes, ...summarize(rtts) };
}

export type MissingMinute = { targetId: string; ts: number };

export interface RollupDeps {
  /** memoized live verdict (shared baseline tracker) */
  verdict(s: Sample): { ok: boolean; spike: boolean; unreliable?: boolean };
  /** spike test against the current baseline without feeding it (backfill) */
  isSpikeNow(targetId: string, rtt: number): boolean;
  db: Pick<EngineDb, 'upsertRollups' | 'samplesBetween' | 'minutesMissingRollup'>;
}

export interface RollupOptions {
  /** module start – minutes that began earlier may contain samples of the previous run (read from the DB) */
  startedAt: number;
  /** finalize a minute this long after its start, default 65 s */
  finalizeAfterMs?: number;
  /** keep finalized buckets this long for very late samples, default 10 min */
  retainMs?: number;
}

interface Bucket {
  targetId: string;
  minute: number;
  entries: RollupEntry[];
  finalized: boolean;
  /** late samples arrived after finalization → write again */
  dirty: boolean;
}

const defaultYield = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));

export class RollupAggregator {
  private readonly buckets = new Map<string, Bucket>();
  private readonly startedAt: number;
  private readonly finalizeAfterMs: number;
  private readonly retainMs: number;
  private stopped = false;
  /** samples dropped because their minute was finalized and evicted long ago */
  droppedLate = 0;
  /** samples dropped because their RTT was distorted by an engine stall */
  droppedUnreliable = 0;

  constructor(private readonly deps: RollupDeps, opts: RollupOptions) {
    this.startedAt = opts.startedAt;
    this.finalizeAfterMs = opts.finalizeAfterMs ?? 65_000;
    this.retainMs = opts.retainMs ?? 10 * MINUTE_MS;
  }

  get openBuckets(): number {
    return this.buckets.size;
  }

  hasBucket(targetId: string, minuteTs: number): boolean {
    return this.buckets.has(`${targetId}|${minuteTs}`);
  }

  add(s: Sample, now: number): void {
    const minute = minuteOf(s.ts);
    const key = `${s.targetId}|${minute}`;
    let b = this.buckets.get(key);
    if (!b && now - (minute + MINUTE_MS) > this.retainMs) {
      this.droppedLate++;
      return;
    }
    const v = this.deps.verdict(s);
    if (v.unreliable) {
      this.droppedUnreliable++;
      return;
    }
    if (!b) {
      b = { targetId: s.targetId, minute, entries: [], finalized: false, dirty: false };
      this.buckets.set(key, b);
    }
    b.entries.push({ ts: s.ts, rtt: v.ok ? s.rtt : null, spike: v.ok && v.spike });
    if (b.finalized) b.dirty = true;
  }

  /** finalize minutes that started ≥ finalizeAfterMs ago (and re-write late-updated ones) */
  finalizeDue(now: number): Rollup[] {
    const out: Rollup[] = [];
    for (const [key, b] of this.buckets) {
      if ((!b.finalized && b.minute + this.finalizeAfterMs <= now) || (b.finalized && b.dirty)) {
        out.push(this.summarizeBucket(b));
        b.finalized = true;
        b.dirty = false;
      }
      if (b.finalized && !b.dirty && now - (b.minute + MINUTE_MS) > this.retainMs) this.buckets.delete(key);
    }
    if (out.length > 0) this.deps.db.upsertRollups(out);
    return out;
  }

  /** shutdown: write every bucket (also the running minute) */
  flushAll(): Rollup[] {
    const out: Rollup[] = [];
    for (const b of this.buckets.values()) {
      if (!b.finalized || b.dirty) {
        out.push(this.summarizeBucket(b));
        b.finalized = true;
        b.dirty = false;
      }
    }
    if (out.length > 0) this.deps.db.upsertRollups(out);
    return out;
  }

  /**
   * Roll up minutes in [since, before) that have raw samples but no rollup row. Note that
   * EngineDb.minutesMissingRollup scans the whole samples table (≈ 1 s on a 14-day database) –
   * call it while no probe is running (module init).
   */
  findMissing(since: number, before: number, limit: number): MissingMinute[] {
    return this.deps.db.minutesMissingRollup(since, before, limit);
  }

  /**
   * Roll up the given minutes from the raw samples in the database, in chunks (yielding to the
   * event loop in between). Spikes are judged against the current baselines; minutes the live
   * aggregation owns are skipped. Returns the number of rollups written.
   */
  async backfill(
    missing: readonly MissingMinute[],
    opts: { chunk?: number; yieldFn?: () => Promise<void> } = {},
  ): Promise<number> {
    const chunk = Math.max(1, opts.chunk ?? 100);
    const yieldFn = opts.yieldFn ?? defaultYield;
    let written = 0;
    for (let i = 0; i < missing.length && !this.stopped; i += chunk) {
      const batch: Rollup[] = [];
      for (const m of missing.slice(i, i + chunk)) {
        if (this.hasBucket(m.targetId, m.ts)) continue; // live aggregation owns this minute
        const rows = this.deps.db.samplesBetween(m.targetId, m.ts, m.ts + MINUTE_MS);
        if (rows.length === 0) continue;
        batch.push(buildRollup(m.targetId, m.ts, rows.map((r) => this.entryFromDb(r))));
      }
      if (batch.length > 0 && !this.stopped) {
        this.deps.db.upsertRollups(batch);
        written += batch.length;
      }
      if (i + chunk < missing.length) await yieldFn();
    }
    return written;
  }

  stop(): void {
    this.stopped = true;
  }

  private entryFromDb(r: Sample): RollupEntry {
    if (r.rtt === null || isLost(r)) return { ts: r.ts, rtt: null, spike: false };
    return { ts: r.ts, rtt: r.rtt, spike: this.deps.isSpikeNow(r.targetId, r.rtt) };
  }

  private summarizeBucket(b: Bucket): Rollup {
    if (b.minute >= this.startedAt) return buildRollup(b.targetId, b.minute, b.entries);
    // minute began before this run: the earlier part of it exists only in the database
    const own = new Map(b.entries.map((e) => [e.ts, e]));
    const rows = this.deps.db.samplesBetween(b.targetId, b.minute, b.minute + MINUTE_MS);
    const merged: RollupEntry[] = rows.map((r) => own.get(r.ts) ?? this.entryFromDb(r));
    const fromDb = new Set(rows.map((r) => r.ts));
    for (const e of b.entries) if (!fromDb.has(e.ts)) merged.push(e);
    return buildRollup(b.targetId, b.minute, merged);
  }
}

// ─── engine module ─────────────────────────────────────────────────────────

export interface RollupModuleOptions {
  /** finalize check interval, default 5 s */
  finalizeEveryMs?: number;
  /** first retention purge after start, default 5 min */
  firstPurgeAfterMs?: number;
  /** retention purge interval, default 1 h */
  purgeEveryMs?: number;
}

export function createRollupModule(opts: RollupModuleOptions = {}): EngineModule {
  const finalizeEveryMs = opts.finalizeEveryMs ?? 5000;
  const firstPurgeAfterMs = opts.firstPurgeAfterMs ?? 5 * MINUTE_MS;
  const purgeEveryMs = opts.purgeEveryMs ?? HOUR_MS;
  let ctx: EngineContext | null = null;
  let agg: RollupAggregator | null = null;
  const timeouts: ReturnType<typeof setTimeout>[] = [];
  const intervals: ReturnType<typeof setInterval>[] = [];
  let unsub: (() => void) | null = null;
  let disposed = false;
  const st: ModuleState = {
    name: 'rollup',
    enabled: true,
    running: false,
    busy: false,
    lastRunTs: null,
    nextRunTs: null,
    lastError: null,
  };

  const onError = (err: unknown): void => {
    st.lastError = errorMessage(err);
    ctx?.log.warn(`Minutenwerte: ${st.lastError}`);
  };

  const later = (fn: () => void, ms: number): void => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    timeouts.push(t);
  };
  const every = (fn: () => void, ms: number): void => {
    const t = setInterval(fn, ms);
    t.unref?.();
    intervals.push(t);
  };

  const finalize = (): void =>
    guard(onError, () => {
      if (!agg || disposed) return;
      const now = Date.now();
      agg.finalizeDue(now);
      st.lastRunTs = now;
      st.nextRunTs = now + finalizeEveryMs;
    });

  const backfill = async (missing: MissingMinute[]): Promise<void> => {
    const c = ctx;
    const a = agg;
    if (!c || !a || disposed || missing.length === 0) return;
    st.busy = true;
    try {
      const written = await a.backfill(missing);
      if (written > 0 && !disposed) {
        c.log.info(`${written} Minutenwerte aus Rohdaten nachberechnet`);
        // minutes that were missing when the baselines were warmed
        getBaselineTracker(c).warm(c.db.rollupsSince(Date.now() - WARM_LOOKBACK_MS), { onlyEmpty: true, perTarget: WARM_MINUTES });
      }
    } catch (err) {
      onError(err);
    } finally {
      st.busy = false;
    }
  };

  /** synchronous DB maintenance; the stall is reported so probes timed across it are not judged */
  const blocking = <T>(c: EngineContext, fn: () => T): T => {
    const t0 = Date.now();
    try {
      return fn();
    } finally {
      const t1 = Date.now();
      if (t1 - t0 >= STALL_NOTE_MIN_MS) getBaselineTracker(c).noteStall(t0, t1);
    }
  };

  const purge = (): void =>
    guard(onError, () => {
      const c = ctx;
      if (!c || disposed) return;
      const t0 = Date.now();
      blocking(c, () => c.db.purge(c.config().retention, t0));
      c.log.debug(`Aufbewahrung: alte Daten gelöscht (${Date.now() - t0} ms)`);
    });

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    for (const t of timeouts) clearTimeout(t);
    for (const t of intervals) clearInterval(t);
    unsub?.();
    unsub = null;
    agg?.stop();
    guard(onError, () => agg?.flushAll());
    st.running = false;
    st.nextRunTs = null;
  };

  return {
    name: 'rollup',
    init(c: EngineContext): void {
      ctx = c;
      const startedAt = Date.now();
      const tracker = getBaselineTracker(c);
      const a = new RollupAggregator(
        {
          verdict: (s) => tracker.verdict(s),
          isSpikeNow: (id, rtt) => tracker.isSpikeNow(id, rtt),
          db: c.db,
        },
        { startedAt },
      );
      agg = a;
      // Crash/restart recovery. The lookup scans the whole samples table, so it runs here, before
      // any probe is started (modules init before a session resumes); `before` = now because no
      // live bucket exists yet – this also catches the minutes an ungraceful stop left behind.
      let missing: MissingMinute[] = [];
      guard(onError, () => {
        missing = blocking(c, () => a.findMissing(startedAt - DAY_MS, startedAt, 20_000));
      });
      unsub = c.bus.on('sample', (s) => guard(onError, () => a.add(s, Date.now())));
      every(finalize, finalizeEveryMs);
      if (missing.length > 0) {
        c.log.info(`${missing.length} Minutenwerte fehlen (Neustart/Absturz) – werden nachberechnet`);
        const todo = missing;
        later(() => void backfill(todo), 0);
      }
      // retention: first run after a few minutes, then hourly
      later(purge, firstPurgeAfterMs);
      every(purge, purgeEveryMs);
      st.running = true;
      st.nextRunTs = startedAt + finalizeEveryMs;
    },
    dispose,
    state: (): ModuleState => ({ ...st }),
  };
}
