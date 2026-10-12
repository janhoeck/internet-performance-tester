import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IntervalRunner, nextGridTime, prevGridTime, staggerOffset } from './runner';
import { flushPromises } from './test-helpers';

const T0 = 1_791_550_560_000; // a whole minute

describe('grid helpers', () => {
  it('nextGridTime is strictly after now, prevGridTime at or before now', () => {
    expect(nextGridTime(T0, 1000)).toBe(T0 + 1000);
    expect(nextGridTime(T0 + 1, 1000)).toBe(T0 + 1000);
    expect(nextGridTime(T0 + 999, 1000)).toBe(T0 + 1000);
    expect(prevGridTime(T0, 1000)).toBe(T0);
    expect(prevGridTime(T0 + 999, 1000)).toBe(T0);
    expect(nextGridTime(T0, 10_000, 3437)).toBe(T0 + 3437);
    expect(nextGridTime(T0 + 3437, 10_000, 3437)).toBe(T0 + 13_437);
    expect(prevGridTime(T0 + 3436, 10_000, 3437)).toBe(T0 - 6563);
  });

  it('staggerOffset is deterministic, inside the interval and away from whole seconds', () => {
    const ids = ['gw-tcp', 'gw-dns', 'cf4-udp', 'cf6-udp', 'cf4-tcp', 'cf6-tcp', 'aws-fra', 'aws-irl', 'x', 'game-1'];
    for (const interval of [1000, 5000, 10_000, 60_000]) {
      for (const id of ids) {
        const o = staggerOffset(id, interval);
        expect(o).toBe(staggerOffset(id, interval));
        expect(o).toBeGreaterThanOrEqual(0);
        expect(o).toBeLessThan(interval);
        const sub = o % 1000;
        expect(sub).toBeGreaterThanOrEqual(100);
        expect(sub).toBeLessThan(900);
      }
    }
    // spreads targets: the 8 default runner targets do not all share one slot
    expect(new Set(ids.slice(0, 8).map((id) => staggerOffset(id, 10_000))).size).toBeGreaterThan(4);
  });
});

describe('IntervalRunner', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: T0 + 250 });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs on the wall-clock grid with the scheduled slot as timestamp', async () => {
    const slots: number[] = [];
    const r = new IntervalRunner(5000, 1200, (ts) => {
      slots.push(ts);
    });
    r.start();
    expect(r.running).toBe(true);
    await vi.advanceTimersByTimeAsync(16_000);
    expect(slots).toEqual([T0 + 1200, T0 + 6200, T0 + 11_200, T0 + 16_200].filter((s) => s <= T0 + 16_250));
    r.stop();
    expect(r.running).toBe(false);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(slots).toHaveLength(4);
  });

  it('never overlaps: slots are skipped while a run is in flight', async () => {
    const slots: number[] = [];
    const gate: { release: (() => void) | null } = { release: null };
    const r = new IntervalRunner(1000, 0, (ts) => {
      slots.push(ts);
      return new Promise<void>((resolve) => {
        gate.release = resolve;
      });
    });
    r.start();
    await vi.advanceTimersByTimeAsync(3800); // slot 1 starts and hangs; slots 2, 3, 4 skipped
    expect(slots).toEqual([T0 + 1000]);
    gate.release?.();
    await flushPromises();
    await vi.advanceTimersByTimeAsync(1000);
    expect(slots).toEqual([T0 + 1000, T0 + 5000]);
    r.stop();
  });

  it('reports task errors and keeps running', async () => {
    const errors: unknown[] = [];
    let n = 0;
    const r = new IntervalRunner(
      1000,
      0,
      () => {
        n++;
        throw new Error('boom');
      },
      (e) => errors.push(e),
    );
    r.start();
    await vi.advanceTimersByTimeAsync(3000);
    expect(n).toBe(3);
    expect(errors).toHaveLength(3);
    r.stop();
  });

  it('after a long stall (standby) runs once with the latest slot instead of bursting', async () => {
    const slots: number[] = [];
    const r = new IntervalRunner(1000, 0, (ts) => {
      slots.push(ts);
    });
    r.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(slots).toEqual([T0 + 1000]);
    // the wall clock jumps 30.5 s while no timer could fire (the pending timer fires 1 s later)
    vi.setSystemTime(T0 + 31_500);
    await vi.advanceTimersByTimeAsync(1000);
    expect(slots).toHaveLength(2);
    expect(slots[1]).toBe(T0 + 32_000); // latest grid slot at the late fire time, no burst
    await vi.advanceTimersByTimeAsync(1000);
    expect(slots[2]).toBe(T0 + 33_000);
    r.stop();
  });
});
