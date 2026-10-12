// Time helpers (local time = time zone of the server process, i.e. the user's PC).

export const SECOND = 1000;
export const MINUTE = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;
export const WINDOW_MS = 15 * MINUTE;

/** Evening hours [19, 23) and baseline hours [3, 17) (MESSPLAN R10). */
export const EVENING_HOURS = { from: 19, to: 23 } as const;
export const BASE_HOURS = { from: 3, to: 17 } as const;

const pad2 = (n: number) => String(n).padStart(2, '0');

/** 'YYYY-MM-DD' in local time */
export function localDayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** local midnight of the day containing ts */
export function localDayStart(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function localHour(ts: number): number {
  return new Date(ts).getHours();
}

export function isEveningHour(h: number): boolean {
  return h >= EVENING_HOURS.from && h < EVENING_HOURS.to;
}

export function isBaseHour(h: number): boolean {
  return h >= BASE_HOURS.from && h < BASE_HOURS.to;
}

export function alignDown(ts: number, step: number): number {
  return Math.floor(ts / step) * step;
}

/** Largest number of timestamps inside any window of `windowMs` (sliding, inclusive). */
export function maxInWindow(sortedTs: readonly number[], windowMs: number): { count: number; startTs: number | null; endTs: number | null } {
  let best = 0;
  let bestStart: number | null = null;
  let bestEnd: number | null = null;
  let lo = 0;
  for (let hi = 0; hi < sortedTs.length; hi++) {
    while (sortedTs[hi] - sortedTs[lo] > windowMs) lo++;
    const n = hi - lo + 1;
    if (n > best) {
      best = n;
      bestStart = sortedTs[lo];
      bestEnd = sortedTs[hi];
    }
  }
  return { count: best, startTs: bestStart, endTs: bestEnd };
}

/** Max number of timestamps on one local day. */
export function maxPerLocalDay(ts: readonly number[]): { count: number; day: string | null } {
  const m = new Map<string, number>();
  for (const t of ts) {
    const k = localDayKey(t);
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  let best = 0;
  let day: string | null = null;
  for (const [k, n] of m) {
    if (n > best) {
      best = n;
      day = k;
    }
  }
  return { count: best, day };
}
