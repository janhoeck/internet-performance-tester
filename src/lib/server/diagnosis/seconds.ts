// Helpers for classified-second totals (seconds_1m). Pure.
import type { SecondsRollup } from '../../shared/types';
import type { SecondsTotals } from './types';

type SecondsCounts = Omit<SecondsRollup, 'ts'>;

const KEYS: readonly (keyof SecondsCounts)[] = [
  'covered', 'good', 'link', 'lan', 'access', 'aftr', 'backbone', 'remote', 'unknown', 'es', 'ses', 'selfLoad',
];

export function emptySecondsTotals(): SecondsTotals {
  return { covered: 0, good: 0, link: 0, lan: 0, access: 0, aftr: 0, backbone: 0, remote: 0, unknown: 0, es: 0, ses: 0, selfLoad: 0, minutes: 0, bad: 0 };
}

/** acc += counts of one minute (or of another total); `minutes` is the number of minutes added */
export function addSeconds(acc: SecondsTotals, r: SecondsCounts, minutes = 1): void {
  for (const k of KEYS) acc[k] += Number(r[k]) || 0;
  acc.minutes += minutes;
  acc.bad = Math.max(0, acc.covered - acc.good);
}

/** bad seconds inside [fromHour, toHour) of a 24-entry hourly profile vs. the other hours */
export function aggregateSecondsHours(
  hourly: readonly SecondsTotals[],
  fromHour: number,
  toHour: number,
): { covered: number; bad: number; otherCovered: number; otherBad: number } {
  let covered = 0;
  let bad = 0;
  let otherCovered = 0;
  let otherBad = 0;
  hourly.forEach((h, hour) => {
    if (hour >= fromHour && hour < toHour) {
      covered += h.covered;
      bad += h.bad;
    } else {
      otherCovered += h.covered;
      otherBad += h.bad;
    }
  });
  return { covered, bad, otherCovered, otherBad };
}
