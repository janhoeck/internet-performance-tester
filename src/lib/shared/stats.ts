// Statistics helpers shared by the engine (minute rollups, spike detection) and the
// API layer (merging rollups over arbitrary ranges). Pure functions, no imports.

/**
 * Upper bounds (ms, inclusive) of the latency histogram buckets. A value v falls into the first
 * bucket i with v <= LATENCY_BUCKETS_MS[i]; values above the last bound go into the overflow
 * bucket (index LATENCY_BUCKETS_MS.length). Histograms therefore have length
 * LATENCY_BUCKETS_MS.length + 1. NEVER change existing bounds (stored data depends on them).
 */
export const LATENCY_BUCKETS_MS: readonly number[] = [
  0.5, 1, 1.5, 2, 3, 4, 5, 6, 8, 10, 12, 15, 18, 22, 26, 30, 35, 40, 45, 50, 60, 70, 80, 90,
  100, 120, 140, 160, 180, 200, 250, 300, 350, 400, 500, 600, 800, 1000, 1500, 2000, 3000, 5000,
];
export const HIST_LENGTH = LATENCY_BUCKETS_MS.length + 1;
/** Upper bound used for interpolation inside the overflow bucket. */
const OVERFLOW_UPPER_MS = 10000;

export function emptyHistogram(): number[] {
  return new Array<number>(HIST_LENGTH).fill(0);
}

export function bucketIndex(v: number): number {
  // binary search for first bound >= v
  let lo = 0;
  let hi = LATENCY_BUCKETS_MS.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (LATENCY_BUCKETS_MS[mid] >= v) hi = mid;
    else lo = mid + 1;
  }
  return lo; // === LATENCY_BUCKETS_MS.length for overflow
}

export function addToHistogram(hist: number[], v: number): void {
  hist[bucketIndex(v)] += 1;
}

export function mergeHistograms(target: number[], src: readonly number[]): number[] {
  const n = Math.min(target.length, src.length);
  for (let i = 0; i < n; i++) target[i] += src[i] || 0;
  return target;
}

/** Percentile (q in 0..1) estimated from a histogram with linear interpolation inside the bucket. */
export function histogramQuantile(hist: readonly number[], q: number): number | null {
  let total = 0;
  for (const c of hist) total += c;
  if (total === 0) return null;
  const rank = q * total;
  let cum = 0;
  for (let i = 0; i < hist.length; i++) {
    const c = hist[i];
    if (c === 0) continue;
    if (cum + c >= rank) {
      const lower = i === 0 ? 0 : LATENCY_BUCKETS_MS[i - 1];
      const upper = i < LATENCY_BUCKETS_MS.length ? LATENCY_BUCKETS_MS[i] : OVERFLOW_UPPER_MS;
      const within = c === 0 ? 0 : (rank - cum) / c;
      return lower + (upper - lower) * Math.min(1, Math.max(0, within));
    }
    cum += c;
  }
  return LATENCY_BUCKETS_MS[LATENCY_BUCKETS_MS.length - 1];
}

/** Serialize histogram compactly for SQLite (comma separated, trailing zeros trimmed). */
export function encodeHistogram(hist: readonly number[]): string {
  let end = hist.length;
  while (end > 0 && hist[end - 1] === 0) end--;
  return hist.slice(0, end).join(',');
}

export function decodeHistogram(s: string | null | undefined): number[] {
  const h = emptyHistogram();
  if (!s) return h;
  const parts = s.split(',');
  for (let i = 0; i < parts.length && i < h.length; i++) {
    const n = Number(parts[i]);
    h[i] = Number.isFinite(n) ? n : 0;
  }
  return h;
}

/** Quantile of an ascending sorted array (linear interpolation, "type 7"). */
export function quantileSorted(sorted: readonly number[], q: number): number | null {
  const n = sorted.length;
  if (n === 0) return null;
  if (n === 1) return sorted[0];
  const pos = (n - 1) * Math.min(1, Math.max(0, q));
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function median(values: readonly number[]): number | null {
  return quantileSorted([...values].sort((a, b) => a - b), 0.5);
}

/** Mean absolute difference between consecutive values (jitter as used in the UI). */
export function meanAbsSuccessiveDiff(values: readonly number[]): number | null {
  if (values.length < 2) return null;
  let sum = 0;
  for (let i = 1; i < values.length; i++) sum += Math.abs(values[i] - values[i - 1]);
  return sum / (values.length - 1);
}

/** Median absolute deviation (unscaled). */
export function mad(values: readonly number[]): number | null {
  const m = median(values);
  if (m === null) return null;
  return median(values.map((v) => Math.abs(v - m)));
}

export function lossPct(sent: number, lost: number): number | null {
  return sent > 0 ? (lost / sent) * 100 : null;
}

export interface SampleSummary {
  sent: number;
  lost: number;
  min: number | null;
  avg: number | null;
  max: number | null;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  /** mean absolute successive difference of successful RTTs in send order */
  jitter: number | null;
  /** population standard deviation */
  stddev: number | null;
  hist: number[];
}

/**
 * Jitter as MASD over consecutive SUCCESSFUL samples in send order; a loss breaks the chain
 * (same definition as Cloudflare/PingPlotter). Returns sum and pair count for exact merging.
 */
export function chainJitter(rtts: readonly (number | null)[]): { sum: number; pairs: number } {
  let sum = 0;
  let pairs = 0;
  let prev: number | null = null;
  for (const r of rtts) {
    if (r === null || !Number.isFinite(r)) {
      prev = null;
      continue;
    }
    if (prev !== null) {
      sum += Math.abs(r - prev);
      pairs++;
    }
    prev = r;
  }
  return { sum, pairs };
}

/** Summarize RTTs in send order; null entries are losses. */
export function summarize(rtts: readonly (number | null)[]): SampleSummary {
  const ok: number[] = [];
  let lost = 0;
  for (const r of rtts) {
    if (r === null || !Number.isFinite(r)) lost++;
    else ok.push(r);
  }
  const jit = chainJitter(rtts);
  const hist = emptyHistogram();
  for (const v of ok) addToHistogram(hist, v);
  if (ok.length === 0) {
    return { sent: rtts.length, lost, min: null, avg: null, max: null, p50: null, p95: null, p99: null, jitter: null, stddev: null, hist };
  }
  const sorted = [...ok].sort((a, b) => a - b);
  let sum = 0;
  for (const v of ok) sum += v;
  const avg = sum / ok.length;
  let sq = 0;
  for (const v of ok) sq += (v - avg) * (v - avg);
  return {
    sent: rtts.length,
    lost,
    min: sorted[0],
    avg,
    max: sorted[sorted.length - 1],
    p50: quantileSorted(sorted, 0.5),
    p95: quantileSorted(sorted, 0.95),
    p99: quantileSorted(sorted, 0.99),
    jitter: jit.pairs > 0 ? jit.sum / jit.pairs : null,
    stddev: Math.sqrt(sq / ok.length),
    hist,
  };
}

/** Minimal rollup shape needed for merging (compatible with types.ts Rollup). */
export interface MergeableRollup {
  sent: number;
  lost: number;
  min: number | null;
  avg: number | null;
  max: number | null;
  jitter: number | null;
  stddev: number | null;
  spikes: number;
  hist: readonly number[];
}

export interface MergedStats {
  sent: number;
  lost: number;
  lossPct: number | null;
  min: number | null;
  avg: number | null;
  max: number | null;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  jitter: number | null;
  stddev: number | null;
  spikes: number;
  /** number of rollups (minutes) that contained at least one sample */
  minutes: number;
  hist: number[];
}

/** Merge minute rollups: exact for counts/min/max/avg/stddev, histogram-estimated percentiles. */
export function mergeRollups(rollups: readonly MergeableRollup[]): MergedStats {
  const hist = emptyHistogram();
  let sent = 0, lost = 0, spikes = 0, minutes = 0;
  let min: number | null = null, max: number | null = null;
  let okTotal = 0, sum = 0, sumSq = 0;
  let jitterWeighted = 0, jitterPairs = 0;
  for (const r of rollups) {
    if (r.sent <= 0) continue;
    minutes++;
    sent += r.sent;
    lost += r.lost;
    spikes += r.spikes;
    mergeHistograms(hist, r.hist);
    const ok = r.sent - r.lost;
    if (ok > 0 && r.avg !== null) {
      okTotal += ok;
      sum += r.avg * ok;
      const sd = r.stddev ?? 0;
      sumSq += ok * (sd * sd + r.avg * r.avg);
      if (r.min !== null) min = min === null ? r.min : Math.min(min, r.min);
      if (r.max !== null) max = max === null ? r.max : Math.max(max, r.max);
      if (r.jitter !== null && ok > 1) {
        jitterWeighted += r.jitter * (ok - 1);
        jitterPairs += ok - 1;
      }
    }
  }
  const avg = okTotal > 0 ? sum / okTotal : null;
  const variance = okTotal > 0 && avg !== null ? Math.max(0, sumSq / okTotal - avg * avg) : null;
  return {
    sent,
    lost,
    lossPct: lossPct(sent, lost),
    min,
    avg,
    max,
    p50: histogramQuantile(hist, 0.5),
    p95: histogramQuantile(hist, 0.95),
    p99: histogramQuantile(hist, 0.99),
    jitter: jitterPairs > 0 ? jitterWeighted / jitterPairs : null,
    stddev: variance === null ? null : Math.sqrt(variance),
    spikes,
    minutes,
    hist,
  };
}

/** Number of samples in a histogram strictly above `thresholdMs` (exact when it is a bucket bound, e.g. 200). */
export function countAbove(hist: readonly number[], thresholdMs: number): number {
  let n = 0;
  for (let i = 0; i < hist.length; i++) {
    const lower = i === 0 ? 0 : LATENCY_BUCKETS_MS[i - 1];
    if (lower >= thresholdMs) n += hist[i] || 0;
  }
  return n;
}

/** Wilson 95 % confidence interval for a loss rate, in percent. */
export function wilsonInterval(lost: number, sent: number): { low: number; high: number } | null {
  if (sent <= 0) return null;
  const z = 1.96;
  const p = lost / sent;
  const denom = 1 + (z * z) / sent;
  const center = (p + (z * z) / (2 * sent)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / sent + (z * z) / (4 * sent * sent))) / denom;
  return { low: Math.max(0, center - half) * 100, high: Math.min(1, center + half) * 100 };
}

// ─── Spike detection (docs/research/methodology.md §6) ─────────────────────

export interface SpikeRule {
  /** robust deviation multiplier (default 5) */
  k: number;
  /** minimum increase over the median in ms (LAN 10, WAN 25) */
  minDeltaMs: number;
  /** absolute lag threshold in ms – a sample at/above it is always a spike (default 200) */
  lagMs: number;
}

export interface Baseline {
  median: number;
  mad: number;
}

/** threshold = median + max(k · max(1.4826 · MAD, 1 ms), minDeltaMs), capped at lagMs */
export function spikeThreshold(b: Baseline, r: SpikeRule): number {
  const sigma = Math.max(1.4826 * b.mad, 1);
  return Math.min(r.lagMs, b.median + Math.max(r.k * sigma, r.minDeltaMs));
}

export function isSpike(rtt: number, b: Baseline | null, r: SpikeRule): boolean {
  if (rtt >= r.lagMs) return true;
  if (b === null) return false;
  return rtt >= spikeThreshold(b, r);
}

export type SpikeSeverity = 'minor' | 'major' | 'severe';

/** major ≥ median + 50 ms; severe ≥ lagMs or ≥ median + 150 ms */
export function spikeSeverity(rtt: number, b: Baseline | null, r: SpikeRule): SpikeSeverity {
  const median = b?.median ?? 0;
  if (rtt >= r.lagMs || rtt >= median + 150) return 'severe';
  if (rtt >= median + 50) return 'major';
  return 'minor';
}

/**
 * Baseline over the last `size` successful RTTs: median and MAD, recomputed every
 * `recomputeEvery` pushes (sorting 600 numbers is cheap). Needs `minCount` values.
 */
export class BaselineWindow {
  private readonly ring: number[] = [];
  private next = 0;
  private pushes = 0;
  private cached: Baseline | null = null;

  constructor(
    private readonly size = 600,
    private readonly minCount = 60,
    private readonly recomputeEvery = 10,
  ) {}

  get count(): number {
    return this.ring.length;
  }

  push(v: number): void {
    if (!Number.isFinite(v)) return;
    if (this.ring.length < this.size) this.ring.push(v);
    else {
      this.ring[this.next] = v;
      this.next = (this.next + 1) % this.size;
    }
    this.pushes++;
    if (this.cached === null || this.pushes % this.recomputeEvery === 0) this.recompute();
  }

  get(): Baseline | null {
    return this.ring.length >= this.minCount ? this.cached : null;
  }

  private recompute(): void {
    const sorted = [...this.ring].sort((a, b) => a - b);
    const med = quantileSorted(sorted, 0.5);
    if (med === null) {
      this.cached = null;
      return;
    }
    const dev = sorted.map((x) => Math.abs(x - med)).sort((a, b) => a - b);
    this.cached = { median: med, mad: quantileSorted(dev, 0.5) ?? 0 };
  }
}

// ─── Periodicity ───────────────────────────────────────────────────────────

/**
 * Detects a dominant period in event timestamps (e.g. spikes every ~60 s caused by Wi-Fi
 * background scans). Builds a histogram of intervals between consecutive events and returns
 * the most common interval if it explains at least `minShare` of all intervals.
 */
export function dominantInterval(
  timestamps: readonly number[],
  opts: { binMs?: number; minEvents?: number; minShare?: number; minPeriodMs?: number } = {},
): { periodMs: number; share: number; events: number } | null {
  const binMs = opts.binMs ?? 2000;
  const minEvents = opts.minEvents ?? 6;
  const minShare = opts.minShare ?? 0.4;
  // intervals shorter than this belong to the same burst/episode, not to a period
  const minPeriodMs = opts.minPeriodMs ?? 10_000;
  if (timestamps.length < minEvents) return null;
  const ts = [...timestamps].sort((a, b) => a - b);
  const bins = new Map<number, number>();
  let intervals = 0;
  for (let i = 1; i < ts.length; i++) {
    const d = ts[i] - ts[i - 1];
    if (d < minPeriodMs) continue;
    const b = Math.round(d / binMs);
    bins.set(b, (bins.get(b) ?? 0) + 1);
    intervals++;
  }
  if (intervals < minEvents - 1) return null;
  let bestBin = -1, bestCount = 0;
  for (const [b, c] of bins) {
    // count neighbours too (jitter of the period)
    const c2 = c + (bins.get(b - 1) ?? 0) + (bins.get(b + 1) ?? 0);
    if (c2 > bestCount) { bestCount = c2; bestBin = b; }
  }
  if (bestBin <= 0 || intervals === 0) return null;
  const share = bestCount / intervals;
  if (share < minShare) return null;
  return { periodMs: bestBin * binMs, share, events: ts.length };
}
