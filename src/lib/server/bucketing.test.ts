import { describe, expect, it } from 'vitest';
import { addToHistogram, decodeHistogram, emptyHistogram, encodeHistogram, mergeRollups, summarize } from '../shared/stats';
import {
  type RollupLite,
  addEncodedHistogram,
  bucketMetric,
  bucketRawSamples,
  bucketRollups,
  bucketSeconds,
  buildHeatmap,
  buildHourProfile,
  emptySeconds,
  fastDecodeHistogram,
  round3,
} from './bucketing';
import { addLocalDays, localHourStarts, startOfLocalDay } from './time';

const T0 = Date.UTC(2026, 9, 8, 10, 0, 0); // whole minute

function rollupOf(ts: number, rtts: (number | null)[], spikes = 0): RollupLite {
  const s = summarize(rtts);
  return { ts, sent: s.sent, lost: s.lost, min: s.min, avg: s.avg, max: s.max, spikes, hist: encodeHistogram(s.hist) };
}

describe('histogram helpers', () => {
  it('addEncodedHistogram equals decodeHistogram for integer counts', () => {
    const h = emptyHistogram();
    for (const v of [0.4, 3, 3, 17, 250, 9000, 12_000]) addToHistogram(h, v);
    const enc = encodeHistogram(h);
    expect(fastDecodeHistogram(enc)).toEqual(decodeHistogram(enc));
    const acc = emptyHistogram();
    addEncodedHistogram(acc, enc);
    addEncodedHistogram(acc, enc);
    expect(acc).toEqual(h.map((c) => c * 2));
  });

  it('falls back to the tolerant decoder for odd strings and ignores empty input', () => {
    const acc = emptyHistogram();
    addEncodedHistogram(acc, '1.5,x,2');
    expect(acc.slice(0, 3)).toEqual([1.5, 0, 2]);
    addEncodedHistogram(acc, null);
    addEncodedHistogram(acc, '');
    expect(acc.slice(0, 3)).toEqual([1.5, 0, 2]);
  });

  it('round3 keeps null and rounds to µs', () => {
    expect(round3(null)).toBeNull();
    expect(round3(Number.NaN)).toBeNull();
    expect(round3(1.23456)).toBe(1.235);
  });
});

describe('bucketRawSamples', () => {
  it('aggregates per bucket with loss %, min/max/avg and p95', () => {
    const ts = [0, 1, 2, 3, 4, 5].map((i) => T0 + i * 1000);
    const rtt = [10, 20, null, 30, 12, 14];
    const out = bucketRawSamples(ts, rtt, { stepMs: 5000, offsetMs: 0, gapMs: 20_000 });
    expect(out.ts).toEqual([T0, T0 + 5000]);
    expect(out.sent).toEqual([5, 1]);
    expect(out.lossPct).toEqual([20, 0]);
    expect(out.min[0]).toBe(10);
    expect(out.max[0]).toBe(30);
    expect(out.avg[0]).toBe(18);
    expect(out.p95[0]).toBeCloseTo(28.5, 3); // type-7 quantile of [10,12,20,30]: 20 + 0.85 · 10
    expect(out.avg[1]).toBe(14);
  });

  it('inserts one null point for gaps longer than gapMs and keeps all columns aligned', () => {
    const ts = [T0, T0 + 1000, T0 + 60_000, T0 + 61_000];
    const out = bucketRawSamples(ts, [5, 6, 7, 8], { stepMs: 1000, offsetMs: 0, gapMs: 2500 });
    expect(out.ts).toEqual([T0, T0 + 1000, T0 + 2000, T0 + 60_000, T0 + 61_000]);
    expect(out.avg).toEqual([5, 6, null, 7, 8]);
    expect(out.sent).toEqual([1, 1, 0, 1, 1]);
    for (const col of [out.avg, out.min, out.max, out.p95, out.lossPct, out.sent]) expect(col).toHaveLength(out.ts.length);
  });

  it('an all-lost bucket has 100 % loss and null latency', () => {
    const out = bucketRawSamples([T0, T0 + 1000], [null, null], { stepMs: 10_000, offsetMs: 0, gapMs: 30_000 });
    expect(out.lossPct).toEqual([100]);
    expect(out.avg).toEqual([null]);
    expect(out.p95).toEqual([null]);
  });

  it('aligns buckets to the local offset', () => {
    const offset = 2 * 3_600_000;
    const out = bucketRawSamples([T0 + 30 * 60_000], [1], { stepMs: 3_600_000 * 3, offsetMs: offset, gapMs: 1e9 });
    // (T0 + 30 min + 2 h) floored to 3 h, minus 2 h
    const expected = Math.floor((T0 + 30 * 60_000 + offset) / (3 * 3_600_000)) * 3 * 3_600_000 - offset;
    expect(out.ts).toEqual([expected]);
  });
});

describe('bucketRollups', () => {
  it('matches mergeRollups for counts, avg, min/max and histogram percentiles', () => {
    const minutes = [
      rollupOf(T0, [10, 12, 11, null, 50]),
      rollupOf(T0 + 60_000, [9, 9, 10, 220]),
      rollupOf(T0 + 120_000, [null, null]),
    ];
    const out = bucketRollups(minutes, { stepMs: 5 * 60_000, offsetMs: 0, gapMs: 1e9 });
    const merged = mergeRollups(minutes.map((m) => ({ ...m, jitter: null, stddev: null, hist: decodeHistogram(m.hist) })));
    expect(out.ts).toHaveLength(1);
    expect(out.sent[0]).toBe(merged.sent);
    expect(out.lossPct[0]).toBeCloseTo(merged.lossPct ?? -1, 3);
    expect(out.avg[0]).toBeCloseTo(merged.avg ?? -1, 3);
    expect(out.min[0]).toBe(merged.min);
    expect(out.max[0]).toBe(merged.max);
    expect(out.p95[0]).toBeCloseTo(merged.p95 ?? -1, 3);
  });

  it('starts a new bucket per step and inserts gaps', () => {
    const rows = [rollupOf(T0, [1]), rollupOf(T0 + 60_000, [2]), rollupOf(T0 + 10 * 60_000, [3])];
    const out = bucketRollups(rows, { stepMs: 60_000, offsetMs: 0, gapMs: 150_000 });
    expect(out.ts).toEqual([T0, T0 + 60_000, T0 + 120_000, T0 + 10 * 60_000]);
    expect(out.avg).toEqual([1, 2, null, 3]);
  });
});

describe('bucketMetric', () => {
  const ts = [T0, T0 + 10_000, T0 + 20_000, T0 + 70_000];
  const values = [1, 3, 2, 10];
  it.each([
    ['avg', [2, 10]],
    ['max', [3, 10]],
    ['sum', [6, 10]],
    ['last', [2, 10]],
  ] as const)('%s aggregation', (agg, expected) => {
    const out = bucketMetric(ts, values, agg, 60_000, 0);
    expect(out.ts).toEqual([T0, T0 + 60_000]);
    expect(out.value).toEqual(expected);
  });

  it('skips non-finite values and empty buckets', () => {
    const out = bucketMetric([T0, T0 + 1000, T0 + 120_000], [Number.NaN, 4, 5], 'avg', 60_000, 0);
    expect(out.ts).toEqual([T0, T0 + 120_000]);
    expect(out.value).toEqual([4, 5]);
  });
});

describe('bucketSeconds', () => {
  it('sums per bucket and in total', () => {
    const a = { ...emptySeconds(T0), covered: 60, good: 50, access: 10, es: 10 };
    const b = { ...emptySeconds(T0 + 60_000), covered: 30, good: 30 };
    const c = { ...emptySeconds(T0 + 3_600_000), covered: 60, link: 60, selfLoad: 5 };
    const { buckets, total } = bucketSeconds([a, b, c], 3_600_000, 0, T0 - 5);
    expect(buckets).toHaveLength(2);
    expect(buckets[0]).toMatchObject({ covered: 90, good: 80, access: 10, es: 10 });
    expect(buckets[1]).toMatchObject({ covered: 60, link: 60, selfLoad: 5 });
    expect(total).toMatchObject({ ts: T0 - 5, covered: 150, good: 80, link: 60, access: 10, es: 10, selfLoad: 5 });
  });
});

describe('buildHeatmap / buildHourProfile', () => {
  const day0 = startOfLocalDay(T0);
  const dayStarts = [addLocalDays(day0, -1), day0];
  const end = addLocalDays(day0, 1);
  const hours = localHourStarts(day0);
  const rows: RollupLite[] = [
    rollupOf(hours[9], [10, 10, 10]),
    rollupOf(hours[9] + 60_000, [20, null]),
    rollupOf(hours[21], [100, 120], 2),
    rollupOf(end + 60_000, [999]), // outside → ignored
  ];

  it('aggregates local day × hour cells with coverage', () => {
    const avg = buildHeatmap(rows, dayStarts, 'avg', end);
    expect(avg.values).toHaveLength(2);
    expect(avg.values[0].every((v) => v === null)).toBe(true);
    expect(avg.values[1][9]).toBeCloseTo(12.5, 3);
    expect(avg.values[1][21]).toBe(110);
    expect(avg.coverage[1][9]).toBe(3); // 2 of 60 minutes
    expect(avg.coverage[1][10]).toBe(0);
    const loss = buildHeatmap(rows, dayStarts, 'loss', end);
    expect(loss.values[1][9]).toBe(20);
    const spikes = buildHeatmap(rows, dayStarts, 'spikes', end);
    expect(spikes.values[1][21]).toBe(2);
    const p95 = buildHeatmap(rows, dayStarts, 'p95', end);
    expect(p95.values[1][21]).toBeGreaterThan(100);
  });

  it('excluded minutes (speed tests) count for coverage but not for values', () => {
    const excl = buildHeatmap(rows, dayStarts, 'avg', end, new Set([hours[9] + 60_000, hours[21]]));
    expect(excl.values[1][9]).toBe(10);
    expect(excl.coverage[1][9]).toBe(3);
    expect(excl.values[1][21]).toBeNull();
    expect(excl.coverage[1][21]).toBe(2);
  });

  it('profiles hours of day across days', () => {
    const profile = buildHourProfile([rollupOf(hours[21] - 86_400_000, [80]), ...rows.slice(0, 3)]);
    expect(profile).toHaveLength(24);
    expect(profile[9]).toMatchObject({ hour: 9, minutes: 2, sent: 5, spikes: 0 });
    expect(profile[21].minutes).toBe(2);
    expect(profile[21].avg).toBeCloseTo((80 + 100 + 120) / 3, 3);
    expect(profile[3]).toMatchObject({ minutes: 0, avg: null, p50: null });
  });
});
