import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpeedtestProgress } from '../../src/lib/shared/types';
import { ProgressThrottle } from './speed-progress';

const p = (progress: number, phase: SpeedtestProgress['phase'] = 'download'): SpeedtestProgress => ({
  running: true,
  phase,
  progress,
  currentMbps: null,
  currentRtt: null,
});

describe('ProgressThrottle', () => {
  let now = 0;
  const clock = () => now;
  const advance = async (ms: number) => {
    now += ms;
    await vi.advanceTimersByTimeAsync(ms);
  };

  beforeEach(() => {
    vi.useFakeTimers();
    now = 1000;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('publishes at most one message per 250 ms and coalesces intermediate updates', async () => {
    const out: { t: number; v: number }[] = [];
    const t = new ProgressThrottle((m) => out.push({ t: now, v: m.progress }), 250, clock);
    t.push(p(0.1)); // immediately
    t.push(p(0.2)); // pending
    t.push(p(0.3)); // replaces 0.2
    expect(out).toEqual([{ t: 1000, v: 0.1 }]);
    await advance(250);
    expect(out).toEqual([
      { t: 1000, v: 0.1 },
      { t: 1250, v: 0.3 },
    ]);
    // a push every 50 ms for 2 s → ≤ 4 messages per second
    for (let i = 0; i < 40; i++) {
      t.push(p(0.4 + i / 100));
      await advance(50);
    }
    for (let i = 1; i < out.length; i++) expect(out[i].t - out[i - 1].t).toBeGreaterThanOrEqual(250);
    expect(out.length).toBeLessThanOrEqual(2 + 9);
    expect(out.at(-1)?.v).toBeGreaterThan(0.7);
  });

  it('final() waits for the interval, drops pending updates and is never lost', async () => {
    const out: SpeedtestProgress[] = [];
    const t = new ProgressThrottle((m) => out.push(m), 250, clock);
    t.push(p(0.5));
    t.push(p(0.6)); // pending – superseded by the final message
    const done = t.final({ ...p(1, 'done'), running: false });
    expect(out).toHaveLength(1);
    await advance(260);
    await done;
    expect(out.map((m) => m.phase)).toEqual(['download', 'done']);
    expect(out[1].running).toBe(false);
    await advance(1000);
    expect(out).toHaveLength(2);
  });

  it('never publishes early when a timer fires before the interval elapsed on its clock', async () => {
    const out: number[] = [];
    const t = new ProgressThrottle((m) => out.push(m.progress), 250, clock);
    t.push(p(0.1));
    t.push(p(0.2));
    // the timer fires after 250 ms of timer time, but the monotonic clock only advanced 249 ms
    now += 249;
    await vi.advanceTimersByTimeAsync(250);
    expect(out).toEqual([0.1]);
    await advance(1);
    expect(out).toEqual([0.1, 0.2]);
    // same for final()
    now += 100;
    const done = t.final({ ...p(1, 'done'), running: false });
    now += 149;
    await vi.advanceTimersByTimeAsync(150);
    expect(out).toEqual([0.1, 0.2]);
    await advance(1);
    await done;
    expect(out).toEqual([0.1, 0.2, 1]);
  });

  it('cancel() drops a pending update', async () => {
    const out: SpeedtestProgress[] = [];
    const t = new ProgressThrottle((m) => out.push(m), 250, clock);
    t.push(p(0.1));
    t.push(p(0.2));
    t.cancel();
    await advance(500);
    expect(out).toHaveLength(1);
  });
});
