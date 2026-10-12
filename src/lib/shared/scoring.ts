// Explainable gaming score (docs/research/methodology.md "Composite gaming score"):
//   score = 100 · Π fᵢ, each factor fᵢ ∈ [0, 1] interpolated piecewise-linearly (clamped) from
//   latency p50, jitter (MASD), spike tail (p99 − p50), loss % and outages per hour.
// "Points lost" per factor = (100 − 100·Π f) · ln fᵢ / Σ ln fⱼ (additive, sums to the deficit).
// Pure module (no Node built-ins) – usable by server and client code.
import { fmtMs, fmtNumber, fmtPct } from './format';
import type { GamingScore } from './types';

export type ScoreKey = GamingScore['parts'][number]['key'];
export type ScoreAnchor = readonly [value: number, factor: number];

/** Anchor points (value → factor), ascending by value. Values outside the range are clamped. */
export const SCORE_ANCHORS: Readonly<Record<ScoreKey, readonly ScoreAnchor[]>> = {
  p50: [[35, 1], [60, 0.92], [100, 0.75], [150, 0.5], [200, 0.3], [300, 0]],
  jitter: [[3, 1], [5, 0.97], [10, 0.9], [20, 0.75], [30, 0.6], [50, 0.35], [100, 0]],
  tail: [[15, 1], [30, 0.95], [50, 0.85], [100, 0.65], [200, 0.4], [400, 0.1]],
  loss: [[0, 1], [0.1, 0.98], [0.5, 0.9], [1, 0.8], [2, 0.6], [5, 0.3], [10, 0]],
  outages: [[0, 1], [0.04, 0.95], [0.25, 0.85], [1, 0.6], [3, 0.3], [6, 0.1]],
};

export const SCORE_LABELS: Readonly<Record<ScoreKey, string>> = {
  p50: 'Latenz (p50)',
  jitter: 'Jitter',
  tail: 'Latenzspitzen (p99 − p50)',
  loss: 'Paketverlust',
  outages: 'Ausfälle pro Stunde',
};

/** German grade descriptions (A/B green, C yellow, D/F red). */
export const GRADE_LABELS: Readonly<Record<GamingScore['grade'], string>> = {
  A: 'sehr gut',
  B: 'gut',
  C: 'ok',
  D: 'mäßig',
  F: 'schlecht',
};

const KEYS: readonly ScoreKey[] = ['p50', 'jitter', 'tail', 'loss', 'outages'];
/** factors below this count as "limiting" (methodology: lowest fᵢ if < 0.97) */
const LIMITING_BELOW = 0.97;
/** ln(0) guard */
const MIN_FACTOR = 1e-6;

/** Piecewise-linear interpolation over ascending anchors, clamped at both ends. */
export function interpolate(x: number, anchors: readonly ScoreAnchor[]): number {
  if (anchors.length === 0) return 1;
  if (x <= anchors[0][0]) return anchors[0][1];
  for (let i = 1; i < anchors.length; i++) {
    const [x1, y1] = anchors[i];
    if (x <= x1) {
      const [x0, y0] = anchors[i - 1];
      return x1 === x0 ? y1 : y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return anchors[anchors.length - 1][1];
}

/** A ≥ 85, B ≥ 70, C ≥ 55, D ≥ 40, F < 40 */
export function scoreGrade(score: number): GamingScore['grade'] {
  if (score >= 85) return 'A';
  if (score >= 70) return 'B';
  if (score >= 55) return 'C';
  if (score >= 40) return 'D';
  return 'F';
}

/**
 * Simplified E-model MOS (PingPlotter/NetBeez variant) for voice chat:
 * EL = avgRTT + 2·jitter + 10; R = EL < 160 ? 93.2 − EL/40 : 93.2 − (EL − 120)/10; R −= 2.5·loss%;
 * MOS = 1 + 0.035R + 7e-6·R(R − 60)(100 − R); R < 0 → 1, R > 100 → 4.5.
 */
export function eModelMos(avgRttMs: number, jitterMs: number, lossPct: number): number {
  const effective = avgRttMs + 2 * jitterMs + 10;
  let r = effective < 160 ? 93.2 - effective / 40 : 93.2 - (effective - 120) / 10;
  r -= 2.5 * lossPct;
  if (r < 0) return 1;
  if (r > 100) return 4.5;
  return 1 + 0.035 * r + 0.000007 * r * (r - 60) * (100 - r);
}

export interface GamingScoreInput {
  /** RTT median to the reference/game target (ms) */
  p50Ms?: number | null;
  /** MASD jitter (ms) */
  jitterMs?: number | null;
  /** p99 − p50 (ms) */
  tailMs?: number | null;
  /** internet-wide packet loss (%) */
  lossPct?: number | null;
  /** outages ≥ 3 s per hour */
  outagesPerHour?: number | null;
  /** mean RTT for the MOS estimate (falls back to p50) */
  avgRttMs?: number | null;
}

const finite = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);

function formatValue(key: ScoreKey, v: number): string {
  switch (key) {
    case 'loss':
      return fmtPct(v);
    case 'outages':
      return `${fmtNumber(v, v === 0 ? 0 : v < 1 ? 2 : 1)} /h`;
    default:
      return fmtMs(v);
  }
}

function inputValue(input: GamingScoreInput, key: ScoreKey): number | null | undefined {
  switch (key) {
    case 'p50':
      return input.p50Ms;
    case 'jitter':
      return input.jitterMs;
    case 'tail':
      return input.tailMs;
    case 'loss':
      return input.lossPct;
    case 'outages':
      return input.outagesPerHour;
  }
}

/** rounds to 0.1 and normalizes −0 to 0 */
const round1 = (v: number) => Math.round(v * 10) / 10 || 0;

/**
 * Computes the multiplicative gaming score from the available metrics. Missing metrics are left
 * out (their factor is not part of the product). Returns null when no metric is available.
 */
export function computeGamingScore(input: GamingScoreInput): GamingScore | null {
  const factors: { key: ScoreKey; value: number; factor: number }[] = [];
  for (const key of KEYS) {
    const raw = inputValue(input, key);
    if (!finite(raw)) continue;
    const value = Math.max(0, raw);
    factors.push({ key, value, factor: interpolate(value, SCORE_ANCHORS[key]) });
  }
  if (factors.length === 0) return null;

  const product = factors.reduce((p, f) => p * f.factor, 1);
  const score = Math.round(100 * product);
  const deficit = 100 - 100 * product;
  const lnSum = factors.reduce((s, f) => s + Math.log(Math.max(f.factor, MIN_FACTOR)), 0);

  const parts: GamingScore['parts'] = factors.map((f) => ({
    key: f.key,
    label: SCORE_LABELS[f.key],
    value: formatValue(f.key, f.value),
    factor: Math.round(f.factor * 1000) / 1000,
    pointsLost: lnSum < 0 ? round1((deficit * Math.log(Math.max(f.factor, MIN_FACTOR))) / lnSum) : 0,
  }));

  // stable sort keeps the canonical key order on ties
  const worst = [...factors].sort((a, b) => a.factor - b.factor)[0];
  const limiting = worst && worst.factor < LIMITING_BELOW ? worst.key : null;

  const avg = finite(input.avgRttMs) ? input.avgRttMs : finite(input.p50Ms) ? input.p50Ms : null;
  const mos = avg === null
    ? null
    : Math.round(eModelMos(avg, finite(input.jitterMs) ? input.jitterMs : 0, finite(input.lossPct) ? input.lossPct : 0) * 100) / 100;

  return { score, grade: scoreGrade(score), parts, limiting, mos };
}
