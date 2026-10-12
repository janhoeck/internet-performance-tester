import { describe, expect, it } from 'vitest';
import type { Sample } from '../../src/lib/shared/types';
import { createBus } from './bus';
import { createLogger } from './logger';

function capture() {
  const lines: string[] = [];
  const log = createLogger({ level: 'debug', sink: (_l, line) => lines.push(line) });
  return { lines, log };
}

const sample: Sample = { ts: 1_760_000_000_000, targetId: 'cf4', rtt: 18, status: 0 };

describe('bus', () => {
  it('delivers typed payloads to all listeners and supports unsubscribe', () => {
    const { log } = capture();
    const bus = createBus(log);
    const got: Sample[] = [];
    const off = bus.on('sample', (s) => got.push(s));
    bus.on('sample', (s) => got.push({ ...s, targetId: 'copy' }));
    bus.emit('sample', sample);
    expect(got.map((s) => s.targetId)).toEqual(['cf4', 'copy']);
    off();
    bus.emit('sample', sample);
    expect(got).toHaveLength(3);
    expect(bus.listenerCount('sample')).toBe(1);
  });

  it('catches listener errors, logs them and still calls the other listeners', () => {
    const { log, lines } = capture();
    const bus = createBus(log);
    let called = 0;
    bus.on('session', () => {
      throw new Error('kaputt');
    });
    bus.on('session', () => {
      called++;
    });
    expect(() => bus.emit('session', null)).not.toThrow();
    expect(called).toBe(1);
    expect(lines.some((l) => l.includes("Listener für 'session'") && l.includes('kaputt'))).toBe(true);
  });

  it('logs rejected promises of async listeners', async () => {
    const { log, lines } = capture();
    const bus = createBus(log);
    bus.on('config', async () => {
      throw new Error('async kaputt');
    });
    bus.emit('config', {} as never);
    await new Promise((r) => setTimeout(r, 0));
    expect(lines.some((l) => l.includes('async kaputt'))).toBe(true);
  });

  it('rate-limits repeated listener errors per event type', () => {
    const { log, lines } = capture();
    let t = 0;
    const bus = createBus(log, () => t);
    bus.on('sample', () => {
      throw new Error('immer');
    });
    for (let i = 0; i < 50; i++) bus.emit('sample', sample);
    expect(lines.filter((l) => l.includes('ERROR'))).toHaveLength(1);
    t = 11_000;
    bus.emit('sample', sample);
    const errors = lines.filter((l) => l.includes('ERROR'));
    expect(errors).toHaveLength(2);
    expect(errors[1]).toContain('+49 weitere unterdrückt');
  });

  it('tolerates (un)subscribing during emit', () => {
    const { log } = capture();
    const bus = createBus(log);
    const order: string[] = [];
    const offB = bus.on('gaming', () => order.push('b'));
    bus.on('gaming', () => {
      order.push('a');
      offB();
      bus.on('gaming', () => order.push('late'));
    });
    bus.emit('gaming', { active: true, process: 'cs2.exe', ts: 1 });
    expect(order).toEqual(['b', 'a']);
    order.length = 0;
    bus.emit('gaming', { active: false, process: null, ts: 2 });
    expect(order).toEqual(['a', 'late']);
  });
});
