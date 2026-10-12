// Per-second segment classifier (docs/ARCHITECTURE.md §4.6): every pinger tick is evaluated
// ~3 s after it was sent (all replies/timeouts are in by then), classified with classifySecond()
// and counted into one SecondsRollup row per minute (table seconds_1m).
// Game targets (TCP, every 10 s) are held for up to 10 s – except bad results that were measured
// while the ICMP reference groups were errored: a slow connect to AWS during a CMTS spike is a
// consequence of the access segment and must not turn the following seconds into 'remote'.
import type { AppConfig } from '../../src/lib/shared/config';
import { type ClientState, type ModuleState, type Sample, SampleFlag, type SecondsRollup } from '../../src/lib/shared/types';
import type { EngineContext, EngineModule } from '../core/types';
import { type SpikeVerdict, getBaselineTracker } from './baseline';
import {
  type MemberResult,
  type SecondResult,
  addSecond,
  classifySecond,
  emptySecondsRollup,
  groupState,
  isLinkSecond,
  isSelfLoad,
} from './classify';
import { ClientHistory } from './client-history';
import { GapWindows, MINUTE_MS, SECOND_MS, TargetIndex, errorMessage, guard, hasFlag, minuteOf } from './common';
import { GroupCache, type ReferenceGroups } from './groups';
import { type Round, SampleSequencer, type SequencedSample, splitRounds } from './sequencer';

export interface ClassifierDeps {
  config(): AppConfig;
  verdict(s: Sample): SpikeVerdict;
  /** client state of the second at ts (null if unknown) */
  clientAt(ts: number): ClientState | null;
  /** ≤ 60 s after the expected link came back */
  inRecovery(ts: number): boolean;
  /** ts lies inside an engine gap (stall / sleep) */
  isGap(ts: number): boolean;
  /** persist minute rows (db.upsertSecondsRollups) */
  write(rows: SecondsRollup[]): void;
  /** persisted row of a minute – seeds a minute first seen by this process (engine restart within that minute) */
  read?(minuteTs: number): SecondsRollup | null;
}

export interface ClassifierOptions {
  /** evaluate a tick this long after it was sent, default 3000 ms */
  delayMs?: number;
  /**
   * on finish(now): ticks younger than this may still miss their timeouts (pinger timeout 2 s)
   * and are dropped instead of being counted as good, default 2500 ms
   */
  completeAfterMs?: number;
  /** game targets: use the latest sample at most this old, default 10 s */
  gameMaxAgeMs?: number;
  /** keep written minute rows this long so late ticks are merged instead of overwriting, default 10 min */
  keepMs?: number;
  /** also write the running (partial) minute this often – crash safety, default 10 s */
  partialEveryMs?: number;
}

interface MinuteAcc {
  row: SecondsRollup;
  dirty: boolean;
}

/** latest result of a (non-ICMP) game target, held for up to gameMaxAgeMs */
interface HeldGame {
  /** send time */
  ts: number;
  member: MemberResult;
  /** pinger ticks bracketing the probe's measurement interval [ts, ts + rtt/timeout] */
  windowStart: number;
  windowEnd: number;
  /**
   * a bad result measured while the ICMP reference groups (or the link) were errored is caused
   * closer to the PC (MESSPLAN §2: the first failing segment is the candidate) – it is not held
   * for the following seconds, which would otherwise be counted as 'remote'
   */
  explained: boolean;
}

/** how long per-tick ICMP states are kept for explaining game results */
const ICMP_STATE_KEEP_MS = 30_000;

function memberOf(s: Sample, v: SpikeVerdict): MemberResult {
  return { targetId: s.targetId, lost: !v.ok, spike: v.spike, rtt: v.ok ? s.rtt : null };
}

const isBad = (m: MemberResult): boolean => m.lost || m.spike;

export class SecondClassifier {
  private readonly seq: SampleSequencer;
  private readonly groups = new GroupCache();
  private readonly index: TargetIndex;
  private readonly latestGame = new Map<string, HeldGame>();
  /** per evaluated tick: ICMP reference groups errored or link issue */
  private readonly icmpErrored = new Map<number, boolean>();
  private readonly minutes = new Map<number, MinuteAcc>();
  private lastTick = Number.NEGATIVE_INFINITY;
  private lastPartialWrite = Number.NEGATIVE_INFINITY;
  private readonly completeAfterMs: number;
  private readonly gameMaxAgeMs: number;
  private readonly keepMs: number;
  private readonly partialEveryMs: number;
  /** ticks skipped because they arrived after a later tick was already evaluated */
  lateTicks = 0;
  /** samples dropped on finish() because their tick was not complete yet */
  droppedIncomplete = 0;
  /** bad game results not held because closer segments were errored at the same time */
  explainedGame = 0;

  constructor(private readonly deps: ClassifierDeps, opts: ClassifierOptions = {}) {
    this.seq = new SampleSequencer(opts.delayMs ?? 3000);
    this.index = new TargetIndex(() => deps.config());
    this.completeAfterMs = opts.completeAfterMs ?? 2500;
    this.gameMaxAgeMs = opts.gameMaxAgeMs ?? 10_000;
    this.keepMs = opts.keepMs ?? 10 * MINUTE_MS;
    this.partialEveryMs = opts.partialEveryMs ?? 10_000;
  }

  /** queue a sample; `load` = a speed test was running when it arrived */
  add(sample: Sample, load: boolean): void {
    this.seq.add({ sample, load: load || hasFlag(sample, SampleFlag.LOAD) });
  }

  /** evaluate all ticks that are at least `delayMs` old; write finished minutes (and the running one every partialEveryMs) */
  process(now: number): SecondResult[] {
    const frontier = now - this.seq.delayMs;
    const results = this.evaluate(this.seq.drainUntil(frontier));
    const partial = now - this.lastPartialWrite >= this.partialEveryMs;
    if (partial) this.lastPartialWrite = now;
    this.flush(frontier, partial);
    return results;
  }

  /**
   * Session stop: evaluate every buffered tick that is complete at `now` (all replies and
   * timeouts are in), drop the younger ones and write all (also partial) minutes.
   */
  finish(now: number): SecondResult[] {
    const results = this.evaluate(this.seq.drainUntil(now - this.completeAfterMs));
    this.droppedIncomplete += this.seq.pending;
    this.seq.clear();
    this.flush(Number.NEGATIVE_INFINITY, true);
    return results;
  }

  /** forget buffered samples (new session); minute rows are kept so a restart in the same minute adds up */
  resetStream(): void {
    this.seq.clear();
    this.latestGame.clear();
    this.icmpErrored.clear();
  }

  /** current (unwritten or written) row of a minute – for tests and status */
  minuteRow(minuteTs: number): SecondsRollup | null {
    const acc = this.minutes.get(minuteTs);
    return acc ? { ...acc.row } : null;
  }

  /**
   * Write dirty rows of complete minutes (all ticks ≤ frontier evaluated); `force` writes partial
   * minutes too. Rows stay in memory for `keepMs` so late ticks update instead of replacing them.
   */
  flush(frontier: number, force = false): SecondsRollup[] {
    const rows: SecondsRollup[] = [];
    for (const [m, acc] of this.minutes) {
      const complete = m + MINUTE_MS - SECOND_MS <= frontier;
      if (acc.dirty && (complete || force)) {
        rows.push({ ...acc.row });
        acc.dirty = false;
      }
      if (!acc.dirty && frontier - (m + MINUTE_MS) > this.keepMs) this.minutes.delete(m);
    }
    if (rows.length > 0) this.deps.write(rows);
    return rows;
  }

  private evaluate(entries: SequencedSample[]): SecondResult[] {
    if (entries.length === 0) return [];
    const cfg = this.deps.config();
    const g = this.groups.get(cfg);
    const { rounds, others } = splitRounds(entries, (id) => g.icmp.has(id));
    const results: SecondResult[] = [];
    let oi = 0;
    for (const round of rounds) {
      while (oi < others.length && others[oi].sample.ts <= round.ts) this.noteOther(others[oi++], g);
      if (round.ts <= this.lastTick) {
        this.lateTicks++;
        continue;
      }
      this.lastTick = round.ts;
      const r = this.classifyRound(round, cfg, g);
      results.push(r);
      this.count(r);
    }
    while (oi < others.length) this.noteOther(others[oi++], g);
    return results;
  }

  /** non-ICMP samples: remember the latest result of game targets (TCP connect etc.) */
  private noteOther(e: SequencedSample, g: ReferenceGroups): void {
    const id = e.sample.targetId;
    if (!g.game.includes(id)) return;
    const prev = this.latestGame.get(id);
    if (prev && prev.ts >= e.sample.ts) return;
    const v = this.deps.verdict(e.sample);
    if (v.unreliable) return; // RTT distorted by an engine stall – keep the previous result
    const member = memberOf(e.sample, v);
    const duration = v.ok && e.sample.rtt !== null ? e.sample.rtt : (this.index.get(id)?.timeoutMs ?? 0);
    const held: HeldGame = {
      ts: e.sample.ts,
      member,
      windowStart: Math.floor(e.sample.ts / SECOND_MS) * SECOND_MS,
      windowEnd: Math.floor((e.sample.ts + duration) / SECOND_MS) * SECOND_MS + SECOND_MS,
      explained: false,
    };
    if (isBad(member)) {
      for (let k = held.windowStart; k <= held.windowEnd && !held.explained; k += SECOND_MS) {
        if (this.icmpErrored.get(k) === true) held.explained = true;
      }
      if (held.explained) this.explainedGame++;
    }
    this.latestGame.set(id, held);
  }

  private member(s: Sample): MemberResult {
    return memberOf(s, this.deps.verdict(s));
  }

  private classifyRound(round: Round, cfg: AppConfig, g: ReferenceGroups): SecondResult {
    const ts = round.ts;
    const pick = (ids: readonly string[]): MemberResult[] => {
      const out: MemberResult[] = [];
      for (const id of ids) {
        const e = round.samples.get(id);
        if (e) out.push(this.member(e.sample));
      }
      return out;
    };
    const client = this.deps.clientAt(ts);
    const link = isLinkSecond(client, this.deps.inRecovery(ts));
    const gw = pick(g.gw);
    const isp6 = pick(g.isp6);
    const v4 = pick(g.v4);
    const v6 = pick(g.v6);
    const icmpBad = link || [gw, isp6, v4, v6].some((m) => groupState(m) === 'bad');
    this.noteIcmpState(ts, icmpBad);

    const game: MemberResult[] = [];
    for (const id of g.game) {
      const e = round.samples.get(id);
      if (e) {
        game.push(this.member(e.sample)); // ICMP game target: same tick
        continue;
      }
      const held = this.latestGame.get(id);
      if (!held || held.ts > ts || ts - held.ts > this.gameMaxAgeMs) continue;
      if (isBad(held.member) && !held.explained && icmpBad && ts >= held.windowStart && ts <= held.windowEnd) {
        held.explained = true;
        this.explainedGame++;
      }
      if (!held.explained) game.push(held.member);
    }
    return classifySecond({
      ts,
      // the speed test saturates the line on purpose – those seconds say nothing about the segments
      excluded: round.load || this.deps.isGap(ts),
      link,
      gw,
      isp6,
      v4,
      v6,
      game,
      selfLoad: isSelfLoad(client, cfg),
    });
  }

  private noteIcmpState(ts: number, errored: boolean): void {
    this.icmpErrored.set(ts, errored);
    if (this.icmpErrored.size > ICMP_STATE_KEEP_MS / SECOND_MS + 10) {
      for (const k of this.icmpErrored.keys()) {
        if (ts - k > ICMP_STATE_KEEP_MS) this.icmpErrored.delete(k);
      }
    }
  }

  private count(r: SecondResult): void {
    if (r.cls === 'excluded') return;
    const m = minuteOf(r.ts);
    let acc = this.minutes.get(m);
    if (!acc) {
      const stored = this.deps.read?.(m) ?? null;
      acc = { row: stored ? { ...stored } : emptySecondsRollup(m), dirty: false };
      this.minutes.set(m, acc);
    }
    addSecond(acc.row, r);
    acc.dirty = true;
  }
}

// ─── engine module ─────────────────────────────────────────────────────────

export function createClassifierModule(): EngineModule {
  let ctx: EngineContext | null = null;
  let classifier: SecondClassifier | null = null;
  const history = new ClientHistory();
  const gaps = new GapWindows();
  let timer: ReturnType<typeof setInterval> | null = null;
  let unsubs: (() => void)[] = [];
  const st: ModuleState = {
    name: 'classifier',
    enabled: true,
    running: false,
    busy: false,
    lastRunTs: null,
    nextRunTs: null,
    lastError: null,
  };

  const onError = (err: unknown): void => {
    st.lastError = errorMessage(err);
    ctx?.log.warn(`Sekunden-Klassifizierung: ${st.lastError}`);
  };

  const tick = (): void =>
    guard(onError, () => {
      if (!ctx || !classifier) return;
      history.push(ctx.clientState());
      const now = Date.now();
      classifier.process(now);
      st.lastRunTs = now;
      st.nextRunTs = now + 1000;
    });

  const stop = (): void => {
    if (timer) clearInterval(timer);
    timer = null;
    for (const u of unsubs) u();
    unsubs = [];
    if (st.running) guard(onError, () => classifier?.finish(Date.now()));
    st.running = false;
    st.nextRunTs = null;
  };

  return {
    name: 'classifier',
    init(c: EngineContext): void {
      ctx = c;
      const tracker = getBaselineTracker(c);
      classifier = new SecondClassifier({
        config: () => c.config(),
        verdict: (s) => tracker.verdict(s),
        clientAt: (ts) => history.at(ts),
        inRecovery: (ts) => history.inRecovery(ts),
        isGap: (ts) => gaps.contains(ts),
        write: (rows) => c.db.upsertSecondsRollups(rows),
        read: (m) => c.db.secondsRollupAt(m),
      });
    },
    start(): void {
      const c = ctx;
      const cl = classifier;
      if (!c || !cl || st.running) return;
      history.clear();
      cl.resetStream();
      history.push(c.clientState());
      unsubs = [
        c.bus.on('sample', (s) => guard(onError, () => cl.add(s, c.speedtestActive()))),
        c.bus.on('client', (cs) => guard(onError, () => history.push(cs))),
        c.bus.on('event', (e) =>
          guard(onError, () => {
            if (e.type === 'engine_gap') gaps.add(e.ts, e.endTs ?? e.ts);
          }),
        ),
      ];
      timer = setInterval(tick, 1000);
      timer.unref?.();
      st.running = true;
      st.lastError = null;
    },
    stop,
    dispose: stop,
    state: (): ModuleState => ({ ...st }),
  };
}
