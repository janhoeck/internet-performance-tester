import { describe, expect, it } from 'vitest';
import { SCORE_ANCHORS, computeGamingScore, eModelMos, interpolate, scoreGrade } from './scoring';

describe('interpolate', () => {
  it('clamps below the first and above the last anchor', () => {
    expect(interpolate(10, SCORE_ANCHORS.p50)).toBe(1);
    expect(interpolate(35, SCORE_ANCHORS.p50)).toBe(1);
    expect(interpolate(500, SCORE_ANCHORS.p50)).toBe(0);
    expect(interpolate(-1, SCORE_ANCHORS.loss)).toBe(1);
    expect(interpolate(1000, SCORE_ANCHORS.tail)).toBe(0.1);
  });

  it('interpolates linearly between anchors', () => {
    expect(interpolate(80, SCORE_ANCHORS.p50)).toBeCloseTo(0.835, 6); // between 60→0.92 and 100→0.75
    expect(interpolate(12, SCORE_ANCHORS.jitter)).toBeCloseTo(0.87, 6);
    expect(interpolate(120, SCORE_ANCHORS.tail)).toBeCloseTo(0.6, 6);
    expect(interpolate(0.8, SCORE_ANCHORS.loss)).toBeCloseTo(0.84, 6);
    expect(interpolate(0.5, SCORE_ANCHORS.outages)).toBeCloseTo(0.85 - 0.25 / 3, 6);
    expect(interpolate(0.04, SCORE_ANCHORS.outages)).toBe(0.95); // 1 outage per day
  });
});

describe('scoreGrade', () => {
  it('uses the A/B/C/D/F boundaries', () => {
    expect(scoreGrade(100)).toBe('A');
    expect(scoreGrade(85)).toBe('A');
    expect(scoreGrade(84)).toBe('B');
    expect(scoreGrade(70)).toBe('B');
    expect(scoreGrade(69)).toBe('C');
    expect(scoreGrade(55)).toBe('C');
    expect(scoreGrade(54)).toBe('D');
    expect(scoreGrade(40)).toBe('D');
    expect(scoreGrade(39)).toBe('F');
    expect(scoreGrade(0)).toBe('F');
  });
});

describe('computeGamingScore', () => {
  it('reproduces the evening-like example from the methodology (34, F)', () => {
    const s = computeGamingScore({ p50Ms: 25, jitterMs: 12, tailMs: 120, lossPct: 0.8, outagesPerHour: 0.5 });
    expect(s).not.toBeNull();
    expect(s!.score).toBe(34);
    expect(s!.grade).toBe('F');
    const lost = Object.fromEntries(s!.parts.map((p) => [p.key, p.pointsLost]));
    expect(lost).toEqual({ p50: 0, jitter: 8.5, tail: 31.1, loss: 10.6, outages: 16.2 });
    expect(s!.limiting).toBe('tail');
    // points lost add up to the deficit (rounding to 0.1 per part)
    const sum = s!.parts.reduce((a, p) => a + p.pointsLost, 0);
    expect(sum).toBeCloseTo(100 - 33.62, 0);
    expect(s!.parts.find((p) => p.key === 'p50')?.value).toBe('25 ms');
    expect(s!.parts.find((p) => p.key === 'loss')?.value).toBe('0,80 %');
    expect(s!.parts.find((p) => p.key === 'outages')?.value).toBe('0,50 /h');
    expect(s!.parts.find((p) => p.key === 'tail')?.label).toBe('Latenzspitzen (p99 − p50)');
  });

  it('gives 100 (A) without limiting factor for an ideal line', () => {
    const s = computeGamingScore({ p50Ms: 22, jitterMs: 3, tailMs: 12, lossPct: 0, outagesPerHour: 0 });
    expect(s!.score).toBe(100);
    expect(s!.grade).toBe('A');
    expect(s!.limiting).toBeNull();
    expect(s!.parts.every((p) => p.pointsLost === 0 && p.factor === 1)).toBe(true);
  });

  it('lets one severe problem dominate (multiplicative)', () => {
    const s = computeGamingScore({ p50Ms: 20, jitterMs: 2, tailMs: 10, lossPct: 5, outagesPerHour: 0 });
    expect(s!.score).toBe(30);
    expect(s!.limiting).toBe('loss');
    expect(s!.parts.find((p) => p.key === 'loss')?.pointsLost).toBe(70);
  });

  it('only includes available factors and returns null without any', () => {
    expect(computeGamingScore({})).toBeNull();
    expect(computeGamingScore({ p50Ms: null, lossPct: Number.NaN })).toBeNull();
    const s = computeGamingScore({ p50Ms: 80 });
    expect(s!.parts.map((p) => p.key)).toEqual(['p50']);
    expect(s!.score).toBe(84); // 0.835 → 83.5 → 84
    expect(s!.limiting).toBe('p50');
  });

  it('does not mark a factor ≥ 0.97 as limiting', () => {
    const s = computeGamingScore({ p50Ms: 20, jitterMs: 5 });
    expect(s!.score).toBe(97);
    expect(s!.limiting).toBeNull();
  });

  it('computes an E-model MOS (avg RTT falls back to p50)', () => {
    const s = computeGamingScore({ p50Ms: 25, jitterMs: 12, lossPct: 0.8 });
    expect(s!.mos).toBeCloseTo(4.33, 2);
    const withAvg = computeGamingScore({ p50Ms: 25, avgRttMs: 300, jitterMs: 12, lossPct: 0.8 });
    expect(withAvg!.mos!).toBeLessThan(s!.mos!);
  });
});

describe('eModelMos', () => {
  it('matches the PingPlotter/NetBeez simplification', () => {
    expect(eModelMos(25, 12, 0.8)).toBeCloseTo(4.332, 3);
    expect(eModelMos(0, 0, 0)).toBeGreaterThan(4.3);
    expect(eModelMos(2000, 100, 50)).toBe(1); // R < 0
    expect(eModelMos(200, 20, 1)).toBeLessThan(eModelMos(100, 20, 1)); // EL ≥ 160 branch
  });
});
