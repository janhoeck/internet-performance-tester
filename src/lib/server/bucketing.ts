// Pure bucketing/aggregation helpers for the API query layer (columnar chart data).
import type { SeriesData } from '../shared/api-types';
import type { SecondsRollup } from '../shared/types';
import { decodeHistogram, emptyHistogram, histogramQuantile, mergeHistograms, quantileSorted } from '../shared/stats';
import { bucketStart, localHourStarts } from './time';

/** Round to 3 decimals (µs precision is plenty for ms values) to keep JSON small. */
export function round3(v: number | null): number | null {
  if (v === null || !Number.isFinite(v)) return null;
  return Math.round(v * 1000) / 1000;
}

const DIGITS_AND_COMMAS = /^[0-9,]*$/;

/**
 * Add an encoded histogram ("3,0,12" – see encodeHistogram) into `acc` without allocating.
 * Anything other than integer counts takes the tolerant decodeHistogram path.
 */
export function addEncodedHistogram(acc: number[], s: string | null | undefined): void {
  if (!s) return;
  if (!DIGITS_AND_COMMAS.test(s)) {
    mergeHistograms(acc, decodeHistogram(s));
    return;
  }
  let idx = 0;
  let cur = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 44 /* , */) {
      if (idx < acc.length) acc[idx] += cur;
      idx++;
      cur = 0;
    } else {
      cur = cur * 10 + (c - 48);
    }
  }
  if (idx < acc.length) acc[idx] += cur;
}

/** Decode a histogram string quickly (same result as decodeHistogram for integer counts). */
export function fastDecodeHistogram(s: string | null | undefined): number[] {
  const h = emptyHistogram();
  addEncodedHistogram(h, s);
  return h;
}

// ─── latency series ─────────────────────────────────────────────────────────

export interface SeriesBucketOptions {
  stepMs: number;
  /** local time offset used to align buckets to wall-clock multiples */
  offsetMs: number;
  /** distance between two non-empty buckets above which a null "gap" point is inserted */
  gapMs: number;
}

export function emptySeriesData(): SeriesData {
  return { ts: [], avg: [], min: [], max: [], p95: [], lossPct: [], sent: [] };
}

function pushGap(out: SeriesData, ts: number): void {
  out.ts.push(ts);
  out.avg.push(null);
  out.min.push(null);
  out.max.push(null);
  out.p95.push(null);
  out.lossPct.push(null);
  out.sent.push(0);
}

interface BucketValues {
  avg: number | null;
  min: number | null;
  max: number | null;
  p95: number | null;
  sent: number;
  lost: number;
}

class SeriesWriter {
  readonly out = emptySeriesData();
  private last: number | null = null;
  constructor(private readonly opts: SeriesBucketOptions) {}

  push(ts: number, v: BucketValues): void {
    if (v.sent <= 0) return;
    if (this.last !== null && ts - this.last > this.opts.gapMs) pushGap(this.out, this.last + this.opts.stepMs);
    this.out.ts.push(ts);
    this.out.avg.push(round3(v.avg));
    this.out.min.push(round3(v.min));
    this.out.max.push(round3(v.max));
    this.out.p95.push(round3(v.p95));
    this.out.lossPct.push(round3((v.lost / v.sent) * 100));
    this.out.sent.push(v.sent);
    this.last = ts;
  }
}

/**
 * Bucket raw samples (ascending ts; rtt null = lost) into columnar series data. Only buckets
 * with samples are emitted; a single null point marks gaps longer than `gapMs` so charts break
 * the line where nothing was measured (PC asleep) without fragmenting sparse series.
 */
export function bucketRawSamples(
  ts: readonly number[],
  rtt: readonly (number | null)[],
  opts: SeriesBucketOptions,
): SeriesData {
  const w = new SeriesWriter(opts);
  let cur = Number.NaN;
  let sent = 0;
  let lost = 0;
  let ok: number[] = [];
  const flush = () => {
    if (sent === 0) return;
    ok.sort((a, b) => a - b);
    let sum = 0;
    for (const v of ok) sum += v;
    w.push(cur, {
      avg: ok.length ? sum / ok.length : null,
      min: ok.length ? ok[0] : null,
      max: ok.length ? ok[ok.length - 1] : null,
      p95: quantileSorted(ok, 0.95),
      sent,
      lost,
    });
  };
  for (let i = 0; i < ts.length; i++) {
    const b = bucketStart(ts[i], opts.stepMs, opts.offsetMs);
    if (b !== cur) {
      flush();
      cur = b;
      sent = 0;
      lost = 0;
      ok = [];
    }
    sent++;
    const r = rtt[i];
    if (r === null || !Number.isFinite(r)) lost++;
    else ok.push(r);
  }
  flush();
  return w.out;
}

/** Minimal rollup row for series/heatmap aggregation (hist = encoded string). */
export interface RollupLite {
  ts: number;
  sent: number;
  lost: number;
  min: number | null;
  avg: number | null;
  max: number | null;
  spikes: number;
  hist: string | null;
}

/**
 * Accumulates minute rollups exactly like stats.ts mergeRollups (counts, ok-weighted avg,
 * min/max of minutes with successful samples, merged histogram) – without per-row allocations.
 */
export class RollupAccumulator {
  sent = 0;
  lost = 0;
  spikes = 0;
  minutes = 0;
  ok = 0;
  sum = 0;
  min: number | null = null;
  max: number | null = null;
  readonly hist: number[] | null;

  constructor(withHist = true) {
    this.hist = withHist ? emptyHistogram() : null;
  }

  add(r: RollupLite): void {
    if (r.sent <= 0) return;
    this.minutes++;
    this.sent += r.sent;
    this.lost += r.lost;
    this.spikes += r.spikes;
    if (this.hist) addEncodedHistogram(this.hist, r.hist);
    const ok = r.sent - r.lost;
    if (ok > 0 && r.avg !== null) {
      this.ok += ok;
      this.sum += r.avg * ok;
      if (r.min !== null) this.min = this.min === null ? r.min : Math.min(this.min, r.min);
      if (r.max !== null) this.max = this.max === null ? r.max : Math.max(this.max, r.max);
    }
  }

  reset(): void {
    this.sent = 0;
    this.lost = 0;
    this.spikes = 0;
    this.minutes = 0;
    this.ok = 0;
    this.sum = 0;
    this.min = null;
    this.max = null;
    if (this.hist) this.hist.fill(0);
  }

  avg(): number | null {
    return this.ok > 0 ? this.sum / this.ok : null;
  }

  quantile(q: number): number | null {
    return this.hist ? histogramQuantile(this.hist, q) : null;
  }

  lossPct(): number | null {
    return this.sent > 0 ? (this.lost / this.sent) * 100 : null;
  }
}

/** Bucket minute rollups (ascending ts) into series data (p95 from merged histograms). */
export function bucketRollups(rows: readonly RollupLite[], opts: SeriesBucketOptions): SeriesData {
  const w = new SeriesWriter(opts);
  const acc = new RollupAccumulator(true);
  let cur = Number.NaN;
  const flush = () => {
    if (acc.sent === 0) return;
    w.push(cur, { avg: acc.avg(), min: acc.min, max: acc.max, p95: acc.quantile(0.95), sent: acc.sent, lost: acc.lost });
  };
  for (const r of rows) {
    const b = bucketStart(r.ts, opts.stepMs, opts.offsetMs);
    if (b !== cur) {
      flush();
      acc.reset();
      cur = b;
    }
    acc.add(r);
  }
  flush();
  return w.out;
}

// ─── metrics ────────────────────────────────────────────────────────────────

export type MetricAgg = 'avg' | 'max' | 'sum' | 'last';

/** Bucket an irregular metric series (ascending ts). Only non-empty buckets are returned. */
export function bucketMetric(
  ts: readonly number[],
  values: readonly number[],
  agg: MetricAgg,
  stepMs: number,
  offsetMs: number,
): { ts: number[]; value: (number | null)[] } {
  const outTs: number[] = [];
  const outV: (number | null)[] = [];
  let cur = Number.NaN;
  let n = 0;
  let acc = 0;
  const flush = () => {
    if (n === 0) return;
    outTs.push(cur);
    outV.push(round3(agg === 'avg' ? acc / n : acc));
  };
  for (let i = 0; i < ts.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    const b = bucketStart(ts[i], stepMs, offsetMs);
    if (b !== cur) {
      flush();
      cur = b;
      n = 0;
      acc = agg === 'max' ? Number.NEGATIVE_INFINITY : 0;
    }
    n++;
    if (agg === 'max') acc = Math.max(acc, v);
    else if (agg === 'last') acc = v;
    else acc += v;
  }
  flush();
  return { ts: outTs, value: outV };
}

// ─── classified seconds ─────────────────────────────────────────────────────

export const SECONDS_FIELDS = [
  'covered', 'good', 'link', 'lan', 'access', 'aftr', 'backbone', 'remote', 'unknown', 'es', 'ses', 'selfLoad',
] as const;

export function emptySeconds(ts: number): SecondsRollup {
  return { ts, covered: 0, good: 0, link: 0, lan: 0, access: 0, aftr: 0, backbone: 0, remote: 0, unknown: 0, es: 0, ses: 0, selfLoad: 0 };
}

export function addSecondsInto(acc: SecondsRollup, s: SecondsRollup): void {
  for (const f of SECONDS_FIELDS) acc[f] += s[f];
}

/** Sum per-minute second classes into buckets (only buckets with rows) plus a range total. */
export function bucketSeconds(
  rows: readonly SecondsRollup[],
  stepMs: number,
  offsetMs: number,
  totalTs: number,
): { buckets: SecondsRollup[]; total: SecondsRollup } {
  const total = emptySeconds(totalTs);
  const buckets: SecondsRollup[] = [];
  let cur: SecondsRollup | null = null;
  for (const r of rows) {
    const b = bucketStart(r.ts, stepMs, offsetMs);
    if (!cur || cur.ts !== b) {
      cur = emptySeconds(b);
      buckets.push(cur);
    }
    addSecondsInto(cur, r);
    addSecondsInto(total, r);
  }
  return { buckets, total };
}

// ─── heatmap (local day × hour) ─────────────────────────────────────────────

export type HeatmapMetric = 'p95' | 'avg' | 'loss' | 'spikes';

export interface HeatmapGrid {
  /** values[day][hour] */
  values: (number | null)[][];
  /** coverage[day][hour]: minutes with data / 60, in % (0..100) */
  coverage: number[][];
}

/**
 * Aggregate minute rollups (ascending ts) into local-day × hour cells. `dayStarts` are local
 * midnights (oldest first); rows outside [dayStarts[0], end of last day) are ignored. Minutes in
 * `excluded` (speed tests) still count as measured for the coverage but not for the values.
 */
export function buildHeatmap(
  rows: readonly RollupLite[],
  dayStarts: readonly number[],
  metric: HeatmapMetric,
  dayEnd: number,
  excluded?: ReadonlySet<number>,
): HeatmapGrid {
  const starts: number[] = [];
  for (const d of dayStarts) starts.push(...localHourStarts(d));
  const nCells = starts.length;
  const cells: RollupAccumulator[] = [];
  for (let i = 0; i < nCells; i++) cells.push(new RollupAccumulator(metric === 'p95'));
  const measured = new Array<number>(nCells).fill(0);
  let c = 0;
  for (const r of rows) {
    if (nCells === 0 || r.ts < starts[0] || r.ts >= dayEnd) continue;
    while (c + 1 < nCells && r.ts >= starts[c + 1]) c++;
    if (r.sent > 0) measured[c]++;
    if (excluded?.has(r.ts)) continue;
    cells[c].add(r);
  }
  const values: (number | null)[][] = [];
  const coverage: number[][] = [];
  for (let d = 0; d < dayStarts.length; d++) {
    const vRow: (number | null)[] = [];
    const cRow: number[] = [];
    for (let h = 0; h < 24; h++) {
      const cell = cells[d * 24 + h];
      cRow.push(Math.min(100, Math.round((measured[d * 24 + h] / 60) * 100)));
      if (cell.minutes === 0) {
        vRow.push(null);
        continue;
      }
      switch (metric) {
        case 'p95':
          vRow.push(round3(cell.quantile(0.95)));
          break;
        case 'avg':
          vRow.push(round3(cell.avg()));
          break;
        case 'loss':
          vRow.push(round3(cell.lossPct()));
          break;
        case 'spikes':
          vRow.push(cell.spikes);
          break;
      }
    }
    values.push(vRow);
    coverage.push(cRow);
  }
  return { values, coverage };
}

/** Hour-of-day profile (local time) over arbitrary rollups: p50/p95/loss/spikes per hour 0..23. */
export interface HourProfileEntry {
  hour: number;
  minutes: number;
  sent: number;
  lossPct: number | null;
  avg: number | null;
  p50: number | null;
  p95: number | null;
  spikes: number;
}

export function buildHourProfile(rows: readonly RollupLite[]): HourProfileEntry[] {
  const acc: RollupAccumulator[] = [];
  for (let h = 0; h < 24; h++) acc.push(new RollupAccumulator(true));
  let nextBoundary = Number.NEGATIVE_INFINITY;
  let hour = 0;
  for (const r of rows) {
    if (r.ts >= nextBoundary || r.ts < nextBoundary - 3_600_000) {
      const d = new Date(r.ts);
      hour = d.getHours();
      nextBoundary = new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours() + 1).getTime();
    }
    acc[hour].add(r);
  }
  return acc.map((a, h) => ({
    hour: h,
    minutes: a.minutes,
    sent: a.sent,
    lossPct: round3(a.lossPct()),
    avg: round3(a.avg()),
    p50: round3(a.quantile(0.5)),
    p95: round3(a.quantile(0.95)),
    spikes: a.spikes,
  }));
}
