import { describe, expect, it } from 'vitest';
import type { NetEvent } from '../shared/types';
import { routerLogFromEvent, routerLogFromSnapshot } from './router-log';

const ev = (details: Record<string, unknown> | null, extra: Partial<NetEvent> = {}): NetEvent => ({
  id: 1,
  ts: 1_791_500_000_000,
  type: 'router_log',
  severity: 'warn',
  segment: 'docsis',
  title: 'Router-Protokoll: T3-Timeout',
  details,
  source: 'router',
  ...extra,
});

describe('routerLogFromEvent', () => {
  it('maps a categorized log entry stored in details', () => {
    const e = ev({
      ts: 1_791_499_999_000,
      timeText: '08.10.2026 21:13:19',
      level: '3',
      message: 'No Ranging Response received - T3 time-out',
      category: 'T3',
      key: 'us_t3_timeout',
      rawMessage: 'No Ranging Response received - T3 time-out;CM-MAC=a4:bb:6d:12:34:56;',
    });
    expect(routerLogFromEvent(e)).toEqual({
      ts: 1_791_499_999_000,
      timeText: '08.10.2026 21:13:19',
      level: '3',
      message: 'No Ranging Response received - T3 time-out',
      category: 'T3',
      severity: 'warn',
    });
  });

  it('accepts an { entry } wrapper and raw ARRIS field names, falls back to title/event ts', () => {
    const wrapped = routerLogFromEvent(ev({ entry: { Timestamp: '09.10.2026 18:29:13', Priority: '5', Text: 'Honoring MDD' } }));
    expect(wrapped).toMatchObject({ timeText: '09.10.2026 18:29:13', level: '5', message: 'Honoring MDD', category: 'other', ts: 1_791_500_000_000 });
    const bare = routerLogFromEvent(ev(null, { severity: 'critical' }));
    expect(bare).toEqual({ ts: 1_791_500_000_000, timeText: '', level: null, message: 'Router-Protokoll: T3-Timeout', category: 'other', severity: 'critical' });
  });

  it('keeps an explicit null ts (router clock unknown)', () => {
    expect(routerLogFromEvent(ev({ ts: null, message: 'x' })).ts).toBeNull();
  });
});

describe('routerLogFromSnapshot', () => {
  it('reads arrays and wrapper objects, newest first, skipping junk', () => {
    const entries = [
      { ts: 1, message: 'old', category: 'T3', severity: 'warn' },
      { ts: 3, Text: 'newest', severity: 'bogus' },
      { ts: 2, message: 'middle' },
      'junk',
      { ts: 4 }, // no message
    ];
    const fromArray = routerLogFromSnapshot(entries);
    expect(fromArray.map((e) => e.message)).toEqual(['newest', 'middle', 'old']);
    expect(fromArray[0].severity).toBe('info');
    expect(fromArray[2]).toMatchObject({ category: 'T3', severity: 'warn' });
    expect(routerLogFromSnapshot({ entries }).length).toBe(3);
    expect(routerLogFromSnapshot({ eventLog: entries }).length).toBe(3);
    expect(routerLogFromSnapshot(null)).toEqual([]);
    expect(routerLogFromSnapshot({ foo: 1 })).toEqual([]);
  });
});
