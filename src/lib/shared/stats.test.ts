import { describe, expect, it } from 'vitest';
import {
  BaselineWindow,
  HIST_LENGTH,
  bucketIndex,
  chainJitter,
  countAbove,
  decodeHistogram,
  dominantInterval,
  emptyHistogram,
  encodeHistogram,
  histogramQuantile,
  isSpike,
  mergeRollups,
  quantileSorted,
  spikeSeverity,
  spikeThreshold,
  summarize,
  wilsonInterval,
} from './stats';

describe('histogram', () => {
  it('assigns buckets by inclusive upper bound', () => {
    expect(bucketIndex(0.2)).toBe(0);
    expect(bucketIndex(0.5)).toBe(0);
    expect(bucketIndex(0.6)).toBe(1);
    expect(bucketIndex(1)).toBe(1);
    expect(bucketIndex(20)).toBe(13); // 18 < 20 <= 22
    expect(bucketIndex(99999)).toBe(HIST_LENGTH - 1);
  });

  it('round-trips encoding', () => {
    const h = emptyHistogram();
    h[3] = 5;
    h[10] = 2;
    const s = encodeHistogram(h);
    expect(s).toBe('0,0,0,5,0,0,0,0,0,0,2');
    expect(decodeHistogram(s)).toEqual(h);
    expect(decodeHistogram('')).toEqual(emptyHistogram());
  });

  it('estimates quantiles inside the right bucket', () => {
    const s = summarize(Array.from({ length: 100 }, (_, i) => 10 + (i % 10)));
    const p50 = histogramQuantile(s.hist, 0.5)!;
    expect(p50).toBeGreaterThanOrEqual(12);
    expect(p50).toBeLessThanOrEqual(18);
    expect(histogramQuantile(emptyHistogram(), 0.5)).toBeNull();
  });
});

describe('summarize', () => {
  it('handles losses and computes jitter on successful samples', () => {
    const s = summarize([10, null, 20, 10, null]);
    expect(s.sent).toBe(5);
    expect(s.lost).toBe(2);
    expect(s.min).toBe(10);
    expect(s.max).toBe(20);
    expect(s.avg).toBeCloseTo(13.333, 2);
    expect(s.jitter).toBe(10); // |20-10| + |10-20| / 2
  });

  it('returns nulls when everything is lost', () => {
    const s = summarize([null, null]);
    expect(s.lost).toBe(2);
    expect(s.avg).toBeNull();
    expect(s.p95).toBeNull();
  });

  it('quantileSorted interpolates', () => {
    expect(quantileSorted([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantileSorted([], 0.5)).toBeNull();
  });
});

describe('mergeRollups', () => {
  it('merges exact aggregates', () => {
    const a = summarize([10, 10, 10, 10]);
    const b = summarize([30, 30, null, 30]);
    const m = mergeRollups([
      { ...a, spikes: 0 },
      { ...b, spikes: 1 },
    ]);
    expect(m.sent).toBe(8);
    expect(m.lost).toBe(1);
    expect(m.lossPct).toBeCloseTo(12.5);
    expect(m.avg).toBeCloseTo((40 + 90) / 7);
    expect(m.min).toBe(10);
    expect(m.max).toBe(30);
    expect(m.spikes).toBe(1);
    expect(m.minutes).toBe(2);
    // stddev of [10,10,10,10,30,30,30]
    const vals = [10, 10, 10, 10, 30, 30, 30];
    const mean = vals.reduce((x, y) => x + y) / vals.length;
    const sd = Math.sqrt(vals.reduce((x, y) => x + (y - mean) ** 2, 0) / vals.length);
    expect(m.stddev).toBeCloseTo(sd, 6);
  });
});

describe('spikes', () => {
  const wan = { k: 5, minDeltaMs: 25, lagMs: 200 };
  const lan = { k: 5, minDeltaMs: 10, lagMs: 200 };

  it('uses median + max(5σ, minDelta), capped at the lag threshold', () => {
    expect(spikeThreshold({ median: 18, mad: 2 }, wan)).toBeCloseTo(18 + 25, 5); // 5σ = 14.8 < 25
    expect(spikeThreshold({ median: 18, mad: 6 }, wan)).toBeCloseTo(18 + 5 * 1.4826 * 6, 5);
    expect(spikeThreshold({ median: 0.5, mad: 0 }, lan)).toBeCloseTo(10.5, 5);
    expect(spikeThreshold({ median: 190, mad: 10 }, wan)).toBe(200);
    expect(isSpike(250, null, wan)).toBe(true); // absolute lag without baseline
    expect(isSpike(30, null, wan)).toBe(false);
    expect(isSpike(50, { median: 18, mad: 2 }, wan)).toBe(true);
    expect(isSpike(40, { median: 18, mad: 2 }, wan)).toBe(false);
    expect(spikeSeverity(80, { median: 18, mad: 2 }, wan)).toBe('major');
    expect(spikeSeverity(210, { median: 18, mad: 2 }, wan)).toBe('severe');
    expect(spikeSeverity(50, { median: 18, mad: 2 }, wan)).toBe('minor');
  });

  it('baseline window needs minCount values and tracks median/MAD', () => {
    const w = new BaselineWindow(100, 10, 1);
    for (let i = 0; i < 9; i++) w.push(20);
    expect(w.get()).toBeNull();
    w.push(20);
    expect(w.get()).toEqual({ median: 20, mad: 0 });
    for (let i = 0; i < 100; i++) w.push(i % 2 === 0 ? 10 : 30);
    const b = w.get()!;
    expect(b.median).toBe(20);
    expect(b.mad).toBe(10);
  });
});

describe('loss helpers', () => {
  it('chain jitter breaks at losses', () => {
    expect(chainJitter([10, 20, null, 50, 60])).toEqual({ sum: 20, pairs: 2 });
  });

  it('counts lag samples above 200 ms from the histogram', () => {
    const s = summarize([10, 199, 200, 201, 450, null]);
    expect(countAbove(s.hist, 200)).toBe(2);
  });

  it('wilson interval matches the methodology example', () => {
    const w = wilsonInterval(1, 900)!;
    expect(w.low).toBeCloseTo(0.02, 2);
    expect(w.high).toBeCloseTo(0.63, 2);
    expect(wilsonInterval(0, 0)).toBeNull();
  });
});

describe('dominantInterval', () => {
  it('finds a 60 s period with jitter', () => {
    const ts = [0, 60_500, 120_200, 181_000, 240_900, 300_100, 361_000, 420_400];
    const p = dominantInterval(ts);
    expect(p).not.toBeNull();
    expect(Math.abs(p!.periodMs - 60_000)).toBeLessThanOrEqual(2000);
  });

  it('returns null for random intervals', () => {
    const ts = [0, 3_000, 50_000, 51_000, 140_000, 300_000, 302_000, 600_000];
    expect(dominantInterval(ts)).toBeNull();
  });
});
