// Delayed, time-ordered sample stream. The pinger sends all targets in the same tick but replies
// (and timeouts after up to 2 s) arrive in arbitrary order, so per-second analysis waits ~3 s
// after a tick and then processes everything up to that point sorted by timestamp.
import type { Sample } from '../../src/lib/shared/types';
import { isLost, tickOf } from './common';

export interface SequencedSample {
  sample: Sample;
  /** recorded while a speed test was running (LOAD flag or ctx.speedtestActive() at arrival) */
  load: boolean;
}

export class SampleSequencer {
  private buf: SequencedSample[] = [];
  /** newest processed ts per target – older arrivals are late and dropped */
  private readonly highWater = new Map<string, number>();
  /** number of samples dropped because they arrived after their slot was processed */
  late = 0;

  constructor(readonly delayMs = 3000) {}

  /** queue a sample; returns false when it arrived too late (already processed past its ts) */
  add(entry: SequencedSample): boolean {
    const hw = this.highWater.get(entry.sample.targetId);
    if (hw !== undefined && entry.sample.ts <= hw) {
      this.late++;
      return false;
    }
    this.buf.push(entry);
    return true;
  }

  /** samples with ts ≤ now − delay, sorted by ts (then target id) */
  drain(now: number): SequencedSample[] {
    return this.drainUntil(now - this.delayMs);
  }

  /** samples with ts ≤ cutoff, sorted by ts (then target id) */
  drainUntil(cutoff: number): SequencedSample[] {
    if (this.buf.length === 0) return [];
    const ready: SequencedSample[] = [];
    const keep: SequencedSample[] = [];
    for (const e of this.buf) (e.sample.ts <= cutoff ? ready : keep).push(e);
    this.buf = keep;
    ready.sort((a, b) => a.sample.ts - b.sample.ts || (a.sample.targetId < b.sample.targetId ? -1 : a.sample.targetId > b.sample.targetId ? 1 : 0));
    for (const e of ready) {
      const hw = this.highWater.get(e.sample.targetId);
      if (hw === undefined || e.sample.ts > hw) this.highWater.set(e.sample.targetId, e.sample.ts);
    }
    return ready;
  }

  get pending(): number {
    return this.buf.length;
  }

  clear(): void {
    this.buf = [];
    this.highWater.clear();
  }
}

/** All ICMP samples of one pinger tick. */
export interface Round {
  /** scheduled tick (whole second) */
  ts: number;
  samples: Map<string, SequencedSample>;
  /** any sample of the round was taken during a speed test */
  load: boolean;
}

function worse(a: SequencedSample, b: SequencedSample): SequencedSample {
  const aLost = isLost(a.sample);
  const bLost = isLost(b.sample);
  if (aLost !== bLost) return aLost ? a : b;
  return (a.sample.rtt ?? 0) >= (b.sample.rtt ?? 0) ? a : b;
}

/**
 * Split an ordered batch into pinger rounds (ICMP samples grouped by tick) and the remaining
 * non-ICMP samples. If a target appears twice in one tick (unaligned ping.exe fallback), the
 * worse result is kept.
 */
export function splitRounds(
  entries: readonly SequencedSample[],
  isIcmp: (targetId: string) => boolean,
): { rounds: Round[]; others: SequencedSample[] } {
  const byTick = new Map<number, Round>();
  const others: SequencedSample[] = [];
  for (const e of entries) {
    if (!isIcmp(e.sample.targetId)) {
      others.push(e);
      continue;
    }
    const ts = tickOf(e.sample.ts);
    let r = byTick.get(ts);
    if (!r) {
      r = { ts, samples: new Map(), load: false };
      byTick.set(ts, r);
    }
    const prev = r.samples.get(e.sample.targetId);
    r.samples.set(e.sample.targetId, prev ? worse(prev, e) : e);
    if (e.load) r.load = true;
  }
  const rounds = [...byTick.values()].sort((a, b) => a.ts - b.ts);
  return { rounds, others };
}
