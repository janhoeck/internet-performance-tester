// Time helpers for bucketing and local-time grouping (pure; local time = server time zone,
// which is the user's PC because Next runs locally).

export const SECOND = 1000;
export const MINUTE = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;

/** "Nice" bucket steps for raw samples (ms). */
export const RAW_STEPS: readonly number[] = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600].map((s) => s * SECOND);
/** "Nice" bucket steps for minute rollups / per-minute tables (ms). */
export const MINUTE_STEPS: readonly number[] = [1, 2, 5, 10, 15, 30, 60, 120, 180, 360, 720, 1440, 2880, 10_080].map(
  (m) => m * MINUTE,
);
/** Nice steps for irregular metric series (ms). */
export const METRIC_STEPS: readonly number[] = [...RAW_STEPS.filter((s) => s < MINUTE), ...MINUTE_STEPS];

export interface StepOptions {
  /** explicitly requested step (ms), optional */
  requested?: number | null;
  /** steps are multiples of this unit (1000 for raw, 60000 for rollups) */
  unit: number;
  nice: readonly number[];
  /** auto step: smallest nice step giving at most this many buckets */
  targetPoints: number;
  /** hard cap for explicit steps */
  maxPoints: number;
}

function roundUp(v: number, unit: number): number {
  return Math.max(unit, Math.ceil(v / unit) * unit);
}

function smallestNiceAtLeast(minStep: number, unit: number, nice: readonly number[]): number {
  for (const s of nice) if (s >= minStep) return s;
  return roundUp(minStep, unit);
}

/**
 * Bucket step for a span: the requested step rounded up to `unit` (bumped to a nice step if it
 * would exceed `maxPoints`), otherwise the smallest nice step with ≤ `targetPoints` buckets.
 */
export function chooseStep(spanMs: number, opts: StepOptions): number {
  const span = Math.max(1, spanMs);
  if (opts.requested !== undefined && opts.requested !== null && opts.requested > 0) {
    const step = roundUp(opts.requested, opts.unit);
    if (span / step <= opts.maxPoints) return step;
    return smallestNiceAtLeast(span / opts.maxPoints, opts.unit, opts.nice);
  }
  return smallestNiceAtLeast(span / opts.targetPoints, opts.unit, opts.nice);
}

/** Offset of local time to UTC in ms at `ts` (Berlin summer time: +7 200 000). */
export function localOffsetMs(ts: number): number {
  return -new Date(ts).getTimezoneOffset() * MINUTE;
}

/** Start of the bucket containing ts, aligned to local wall-clock multiples of `step`. */
export function bucketStart(ts: number, step: number, offsetMs: number): number {
  return Math.floor((ts + offsetMs) / step) * step - offsetMs;
}

export function minuteStart(ts: number): number {
  return Math.floor(ts / MINUTE) * MINUTE;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** Local calendar day "YYYY-MM-DD". */
export function localDayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Local midnight of the day containing ts. */
export function startOfLocalDay(ts: number): number {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Local midnight `n` calendar days after the day containing `ts` (DST-safe). */
export function addLocalDays(ts: number, n: number): number {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n).getTime();
}

/**
 * Start timestamps of the 24 local hours of the day starting at `dayStart`. On the spring DST
 * day hour 2 does not exist (its start equals hour 3's start → empty interval); on the autumn
 * day hour 2 lasts two hours.
 */
export function localHourStarts(dayStart: number): number[] {
  const d = new Date(dayStart);
  const out: number[] = [];
  for (let h = 0; h < 24; h++) out.push(new Date(d.getFullYear(), d.getMonth(), d.getDate(), h).getTime());
  return out;
}

/** "2026-10-09 18:29:13" (local time, sortable, Excel-friendly). */
export function fmtLocalDateTime(ts: number): string {
  const d = new Date(ts);
  return `${localDayKey(ts)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** "20261009-1829" for file names. */
export function fmtFileStamp(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}`;
}
