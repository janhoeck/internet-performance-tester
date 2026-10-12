import { describe, expect, it } from 'vitest';
import {
  DAY,
  HOUR,
  MINUTE,
  MINUTE_STEPS,
  RAW_STEPS,
  SECOND,
  addLocalDays,
  bucketStart,
  chooseStep,
  fmtFileStamp,
  fmtLocalDateTime,
  localDayKey,
  localHourStarts,
  localOffsetMs,
  minuteStart,
  startOfLocalDay,
} from './time';

const rawOpts = { unit: SECOND, nice: RAW_STEPS, targetPoints: 1500, maxPoints: 10_000 };
const minOpts = { unit: MINUTE, nice: MINUTE_STEPS, targetPoints: 1500, maxPoints: 10_000 };

describe('chooseStep', () => {
  it('picks the smallest nice step with ≤ target points', () => {
    expect(chooseStep(15 * MINUTE, rawOpts)).toBe(SECOND);
    expect(chooseStep(3 * HOUR, rawOpts)).toBe(10 * SECOND); // 10 800 s / 1500 = 7.2 s → 10 s
    expect(chooseStep(2 * DAY, minOpts)).toBe(2 * MINUTE);
    expect(chooseStep(14 * DAY, minOpts)).toBe(15 * MINUTE);
  });

  it('honours a requested step (rounded up to the unit) unless it exceeds maxPoints', () => {
    expect(chooseStep(HOUR, { ...rawOpts, requested: 1500 })).toBe(2 * SECOND);
    expect(chooseStep(DAY, { ...minOpts, requested: 5 * MINUTE })).toBe(5 * MINUTE);
    expect(chooseStep(DAY, { ...minOpts, requested: 1000 })).toBe(MINUTE); // never below the unit
    // 1 s over 3 h would be 10 800 points > maxPoints 10 000 → bumped to a nice step
    expect(chooseStep(3 * HOUR, { ...rawOpts, requested: SECOND })).toBe(2 * SECOND);
  });

  it('falls back to multiples of the unit beyond the nice list', () => {
    const step = chooseStep(400 * 7 * DAY, { ...minOpts, targetPoints: 10 });
    expect(step % MINUTE).toBe(0);
    expect((400 * 7 * DAY) / step).toBeLessThanOrEqual(10);
  });
});

describe('local time helpers', () => {
  const ts = new Date(2026, 9, 9, 18, 29, 13).getTime();

  it('formats local days and timestamps', () => {
    expect(localDayKey(ts)).toBe('2026-10-09');
    expect(fmtLocalDateTime(ts)).toBe('2026-10-09 18:29:13');
    expect(fmtFileStamp(ts)).toBe('20261009-1829');
  });

  it('computes local midnights DST-safely', () => {
    const day = startOfLocalDay(ts);
    expect(new Date(day).getHours()).toBe(0);
    for (let i = -400; i <= 400; i += 37) {
      const d = addLocalDays(day, i);
      expect(new Date(d).getHours()).toBe(0);
      expect(new Date(d).getMinutes()).toBe(0);
    }
    // across the spring/autumn change the day length differs, but every step is one calendar day
    const keys = new Set<string>();
    for (let i = 0; i < 366; i++) keys.add(localDayKey(addLocalDays(day, i)));
    expect(keys.size).toBe(366);
  });

  it('returns 24 non-decreasing hour starts beginning at local midnight', () => {
    for (const month of [0, 2, 5, 9]) {
      for (const date of [1, 25, 26, 27, 28, 29, 30, 31]) {
        const day = new Date(2026, month, date).getTime();
        const hours = localHourStarts(day);
        expect(hours).toHaveLength(24);
        expect(hours[0]).toBe(day);
        for (let h = 1; h < 24; h++) expect(hours[h]).toBeGreaterThanOrEqual(hours[h - 1]);
        expect(addLocalDays(day, 1) - hours[23]).toBeGreaterThanOrEqual(HOUR);
      }
    }
  });

  it('aligns buckets to local wall-clock multiples', () => {
    const offset = localOffsetMs(ts);
    const b = bucketStart(ts, 6 * HOUR, offset);
    expect(new Date(b).getHours() % 6).toBe(0);
    expect(new Date(b).getMinutes()).toBe(0);
    expect(b).toBeLessThanOrEqual(ts);
    expect(minuteStart(ts + 999)).toBe(ts - 13 * SECOND);
  });
});
