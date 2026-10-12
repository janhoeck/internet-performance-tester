import { describe, expect, it } from 'vitest';
import { encodeHistogram, mergeRollups, summarize } from '../../shared/stats';
import { accFromParts, accStddev, addAcc, addEncodedHistograms, addRollup, newAcc, summarizeAcc } from './aggregate';

function minuteRollup(rtts: (number | null)[], spikes = 0) {
  const s = summarize(rtts);
  return { ...s, spikes };
}

const rollups = [
  minuteRollup([10, 12, null, 11, 40, 13], 1),
  minuteRollup([9, 9.5, 10, 10, 250]),
  minuteRollup([null, null, null]),
  minuteRollup([20, 21, 22, 23, 24, 25, 26, 27, 28, 29]),
];

describe('StatsAcc', () => {
  it('summarizes exactly like mergeRollups', () => {
    const acc = newAcc();
    for (const r of rollups) addRollup(acc, r);
    const s = summarizeAcc(acc);
    const m = mergeRollups(rollups);
    expect(s.sent).toBe(m.sent);
    expect(s.lost).toBe(m.lost);
    expect(s.lossPct).toBeCloseTo(m.lossPct ?? 0, 10);
    expect(s.min).toBe(m.min);
    expect(s.max).toBe(m.max);
    expect(s.avg).toBeCloseTo(m.avg ?? 0, 10);
    expect(s.p50).toBeCloseTo(m.p50 ?? 0, 10);
    expect(s.p95).toBeCloseTo(m.p95 ?? 0, 10);
    expect(s.p99).toBeCloseTo(m.p99 ?? 0, 10);
    expect(s.jitter).toBeCloseTo(m.jitter ?? 0, 10);
    expect(s.spikes).toBe(1);
    expect(s.minutes).toBe(4);
    expect(s.over200).toBe(1);
    expect(accStddev(acc)).toBeCloseTo(m.stddev ?? 0, 10);
  });

  it('merges partial accumulators (addAcc) like one pass', () => {
    const a = newAcc();
    const b = newAcc();
    addRollup(a, rollups[0]);
    addRollup(a, rollups[1]);
    addRollup(b, rollups[2]);
    addRollup(b, rollups[3]);
    addAcc(a, b);
    const one = newAcc();
    for (const r of rollups) addRollup(one, r);
    expect(summarizeAcc(a)).toEqual(summarizeAcc(one));
  });

  it('rebuilds an accumulator from SQL parts with group_concat histograms', () => {
    const one = newAcc();
    for (const r of rollups) addRollup(one, r);
    const parts = {
      minutes: one.minutes,
      sent: one.sent,
      lost: one.lost,
      spikes: one.spikes,
      min: one.min,
      max: one.max,
      ok: one.ok,
      sum: one.sum,
      sumSq: one.sumSq,
      jitW: one.jitW,
      jitP: one.jitP,
      hists: rollups.map((r) => encodeHistogram(r.hist)).join(';'),
    };
    expect(summarizeAcc(accFromParts(parts))).toEqual(summarizeAcc(one));
  });

  it('returns the empty summary without samples', () => {
    const s = summarizeAcc(newAcc());
    expect(s.sent).toBe(0);
    expect(s.p50).toBeNull();
    expect(s.lossPct).toBeNull();
  });
});

describe('addEncodedHistograms', () => {
  it('adds several encoded histograms incl. empty ones and decimals', () => {
    const h = [0, 0, 0, 0];
    addEncodedHistograms(h, '1,2;;0,0,3;1.5');
    expect(h).toEqual([2.5, 2, 3, 0]);
  });

  it('ignores values beyond the histogram length', () => {
    const h = [0, 0];
    addEncodedHistograms(h, '1,1,1,1');
    expect(h).toEqual([1, 1]);
  });
});
