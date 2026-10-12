// Incremental, mergeable latency accumulators. Same math as `mergeRollups` in shared/stats.ts
// (exact counts/min/max/avg/stddev sums, histogram-estimated percentiles), but accumulators can
// be merged with each other, so minute rollups can be pre-aggregated in SQL per 15-min bucket.
import { type MergeableRollup, countAbove, emptyHistogram, histogramQuantile, lossPct } from '../../shared/stats';
import type { StatsSummary } from './types';

export interface StatsAcc {
  /** rollups (minutes) with sent > 0 */
  minutes: number;
  sent: number;
  lost: number;
  spikes: number;
  /** successful samples of rollups that carry an avg */
  ok: number;
  /** Σ avg·ok */
  sum: number;
  /** Σ ok·(stddev² + avg²) */
  sumSq: number;
  min: number | null;
  max: number | null;
  /** Σ jitter·(ok − 1) */
  jitW: number;
  /** Σ (ok − 1) */
  jitP: number;
  hist: number[];
}

export function newAcc(): StatsAcc {
  return { minutes: 0, sent: 0, lost: 0, spikes: 0, ok: 0, sum: 0, sumSq: 0, min: null, max: null, jitW: 0, jitP: 0, hist: emptyHistogram() };
}

const minN = (a: number | null, b: number | null): number | null => (a === null ? b : b === null ? a : Math.min(a, b));
const maxN = (a: number | null, b: number | null): number | null => (a === null ? b : b === null ? a : Math.max(a, b));

/** Adds one minute rollup (identical semantics to mergeRollups). */
export function addRollup(acc: StatsAcc, r: MergeableRollup): void {
  if (r.sent <= 0) return;
  acc.minutes++;
  acc.sent += r.sent;
  acc.lost += r.lost;
  acc.spikes += r.spikes;
  const n = Math.min(acc.hist.length, r.hist.length);
  for (let i = 0; i < n; i++) acc.hist[i] += r.hist[i] || 0;
  const ok = r.sent - r.lost;
  if (ok > 0 && r.avg !== null) {
    acc.ok += ok;
    acc.sum += r.avg * ok;
    const sd = r.stddev ?? 0;
    acc.sumSq += ok * (sd * sd + r.avg * r.avg);
    acc.min = minN(acc.min, r.min);
    acc.max = maxN(acc.max, r.max);
    if (r.jitter !== null && ok > 1) {
      acc.jitW += r.jitter * (ok - 1);
      acc.jitP += ok - 1;
    }
  }
}

/** acc += other */
export function addAcc(acc: StatsAcc, other: StatsAcc): void {
  acc.minutes += other.minutes;
  acc.sent += other.sent;
  acc.lost += other.lost;
  acc.spikes += other.spikes;
  acc.ok += other.ok;
  acc.sum += other.sum;
  acc.sumSq += other.sumSq;
  acc.min = minN(acc.min, other.min);
  acc.max = maxN(acc.max, other.max);
  acc.jitW += other.jitW;
  acc.jitP += other.jitP;
  for (let i = 0; i < acc.hist.length && i < other.hist.length; i++) acc.hist[i] += other.hist[i];
}

/**
 * Adds encoded histograms (encodeHistogram format, comma separated) to `hist`. Several encoded
 * histograms may be joined with ';' (SQLite group_concat). Allocation free.
 */
export function addEncodedHistograms(hist: number[], encoded: string): void {
  let idx = 0;
  let cur = 0;
  let has = false;
  let frac = false;
  let scale = 1;
  const len = encoded.length;
  for (let i = 0; i <= len; i++) {
    const c = i < len ? encoded.charCodeAt(i) : 59; // virtual ';' at the end
    if (c === 44 /* , */ || c === 59 /* ; */) {
      if (has && idx < hist.length) hist[idx] += cur;
      idx = c === 59 ? 0 : idx + 1;
      cur = 0;
      has = false;
      frac = false;
      scale = 1;
    } else if (c >= 48 && c <= 57) {
      if (frac) {
        scale /= 10;
        cur += (c - 48) * scale;
      } else cur = cur * 10 + (c - 48);
      has = true;
    } else if (c === 46 /* . */) {
      frac = true;
    }
  }
}

/** Pre-aggregated sums of several rollups (one SQL GROUP BY row). */
export interface AccParts {
  minutes: number;
  sent: number;
  lost: number;
  spikes: number;
  min: number | null;
  max: number | null;
  ok: number;
  sum: number;
  sumSq: number;
  jitW: number;
  jitP: number;
  /** group_concat(hist, ';') */
  hists: string | null;
}

export function accFromParts(p: AccParts): StatsAcc {
  const acc = newAcc();
  acc.minutes = p.minutes;
  acc.sent = p.sent;
  acc.lost = p.lost;
  acc.spikes = p.spikes;
  acc.min = p.min;
  acc.max = p.max;
  acc.ok = p.ok;
  acc.sum = p.sum;
  acc.sumSq = p.sumSq;
  acc.jitW = p.jitW;
  acc.jitP = p.jitP;
  if (p.hists) addEncodedHistograms(acc.hist, p.hists);
  return acc;
}

export const EMPTY_SUMMARY: Readonly<StatsSummary> = Object.freeze({
  sent: 0, lost: 0, lossPct: null, min: null, avg: null, max: null, p50: null, p95: null, p99: null,
  jitter: null, spikes: 0, over200: 0, minutes: 0,
});

export function summarizeAcc(acc: StatsAcc): StatsSummary {
  if (acc.minutes === 0 || acc.sent === 0) return { ...EMPTY_SUMMARY };
  const avg = acc.ok > 0 ? acc.sum / acc.ok : null;
  return {
    sent: acc.sent,
    lost: acc.lost,
    lossPct: lossPct(acc.sent, acc.lost),
    min: acc.min,
    avg,
    max: acc.max,
    p50: histogramQuantile(acc.hist, 0.5),
    p95: histogramQuantile(acc.hist, 0.95),
    p99: histogramQuantile(acc.hist, 0.99),
    jitter: acc.jitP > 0 ? acc.jitW / acc.jitP : null,
    spikes: acc.spikes,
    over200: countAbove(acc.hist, 200),
    minutes: acc.minutes,
  };
}

/** Population stddev from the accumulator (exposed for tests / completeness). */
export function accStddev(acc: StatsAcc): number | null {
  if (acc.ok === 0) return null;
  const avg = acc.sum / acc.ok;
  return Math.sqrt(Math.max(0, acc.sumSq / acc.ok - avg * avg));
}
