import { describe, expect, it } from 'vitest';
import { GapDetector, gapEvent, loopLagFromHistogram } from './gaps';

describe('GapDetector', () => {
  it('reports gaps longer than 5 s with last tick and resume time', () => {
    const d = new GapDetector();
    const t0 = 1_791_550_000_000;
    expect(d.tick(t0, 0)).toBeNull();
    expect(d.tick(t0 + 1000, 1000)).toBeNull();
    expect(d.tick(t0 + 6000, 6000)).toBeNull(); // exactly 5 s is no gap
    const gap = d.tick(t0 + 48_000, 6500); // standby: monotonic clock stopped
    expect(gap).toEqual({ from: t0 + 6000, to: t0 + 48_000, gapMs: 42_000, monotonicMs: 500 });
    expect(d.tick(t0 + 49_000, 7500)).toBeNull();
    d.reset();
    expect(d.tick(t0 + 99_000)).toBeNull();
  });

  it('builds the engine_gap event (info, not an outage)', () => {
    const e = gapEvent({ from: 1000, to: 43_000, gapMs: 42_000, monotonicMs: 400 });
    expect(e).toMatchObject({ ts: 1000, endTs: 43_000, type: 'engine_gap', severity: 'info', source: 'engine', dedupeKey: 'engine_gap:1000' });
    expect(e.title).toBe('Messlücke: 42 s ohne Messung (Standby oder Engine hing)');
    expect(e.details).toMatchObject({ cause: 'timer', gapMs: 42_000, monotonicMs: 400 });
    expect(gapEvent({ from: 0, to: 192_000, gapMs: 192_000, monotonicMs: null }, 'restart').title).toBe(
      'Messlücke: Engine war 3 min 12 s nicht aktiv (Neustart)',
    );
  });
});

describe('loopLagFromHistogram', () => {
  const hist = (p50Ms: number, p99Ms: number, count = 600) => ({
    count,
    percentile: (p: number) => (p === 99 ? p99Ms * 1e6 : p === 50 ? p50Ms * 1e6 : NaN),
  });

  it('uses the typical tick interval (Windows timer quantum) as the baseline', () => {
    // measured on this PC (resolution 10 ms): idle p50 15.54 / p99 16.18 ms
    expect(loopLagFromHistogram(hist(15.54, 16.18))).toBe(0.6);
    // 20 ms blocks once per second: min collapses to 0.02 ms (catch-up tick), p50 15.55, p99 20.32
    expect(loopLagFromHistogram(hist(15.55, 20.32))).toBe(4.8);
    expect(loopLagFromHistogram(hist(15.6, 215.6))).toBe(200);
    // with the high-resolution timer active (games/browsers) the quantum is ~10 ms
    expect(loopLagFromHistogram(hist(10.1, 10.9))).toBe(0.8);
  });

  it('returns null for empty histograms', () => {
    expect(loopLagFromHistogram(hist(0, 0, 0))).toBeNull();
    expect(loopLagFromHistogram({ percentile: () => 0 })).toBeNull();
    expect(loopLagFromHistogram({ percentile: (p: number) => (p === 99 ? 1e7 : 0) })).toBeNull();
  });
});
