import { describe, expect, it } from 'vitest';
import { type LinkEventLite, computeLinkSummary, linkCause, linkEventDays, relinkMbps, upSpeedMbps } from './link-events';
import { DAY, HOUR } from './time';

const day = (d: number, h = 12) => new Date(2026, 9, d, h, 0, 0).getTime();
const down = (ts: number, details: Record<string, unknown>): LinkEventLite => ({ ts, type: 'nic_link_down', details });
const up = (ts: number, speedMbps: number | null): LinkEventLite => ({ ts, type: 'nic_link_up', details: speedMbps === null ? null : { speedMbps } });

describe('link event helpers', () => {
  it('reads cause and speeds tolerantly', () => {
    expect(linkCause({ cause: 'runtime' })).toBe('runtime');
    expect(linkCause({ cause: 'other' })).toBeNull();
    expect(linkCause(null)).toBeNull();
    expect(upSpeedMbps({ speedMbps: 1000 })).toBe(1000);
    expect(upSpeedMbps({ mbps: '100' })).toBe(100);
    expect(relinkMbps({ relinkMbps: 100, speedMbps: 1000 })).toBe(100);
    expect(relinkMbps({})).toBeNull();
  });
});

describe('linkEventDays', () => {
  it('counts per local day, splits link-ups by speed and zero-fills gaps', () => {
    const events: LinkEventLite[] = [
      down(day(5, 8), { cause: 'boot' }),
      up(day(5, 8) + 3000, 100),
      down(day(7, 15), { cause: 'runtime' }),
      up(day(7, 15) + 6000, 1000),
      up(day(7, 18), 2500),
      up(day(7, 19), null),
      { ts: day(7, 20), type: 'nic_link_flap', details: null },
    ];
    const days = linkEventDays(events, day(9));
    expect(days.map((d) => d.day)).toEqual(['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09']);
    expect(days[0]).toEqual({ day: '2026-10-05', down: 1, up1g: 0, up100m: 1, upOther: 0 });
    expect(days[1]).toEqual({ day: '2026-10-06', down: 0, up1g: 0, up100m: 0, upOther: 0 });
    expect(days[2]).toEqual({ day: '2026-10-07', down: 1, up1g: 2, up100m: 0, upOther: 1 });
    expect(days[4].down).toBe(0);
  });

  it('returns an empty list without events', () => {
    expect(linkEventDays([], day(9))).toEqual([]);
  });
});

describe('computeLinkSummary', () => {
  const to = day(9, 18);
  const events: LinkEventLite[] = [
    down(to - 2 * HOUR, { cause: 'runtime', relinkMbps: 1000, wlanFailover: true }),
    down(to - 5 * HOUR, { cause: 'runtime', relinkMbps: 100, wlanFailover: false }),
    down(to - 3 * DAY, { cause: 'runtime', relinkMbps: 1000, wlanFailover: true }),
    down(to - 8 * DAY, { cause: 'runtime', relinkMbps: 100 }),
    down(to - 10 * HOUR, { cause: 'boot', relinkMbps: 100 }),
    down(to - 11 * HOUR, { cause: 'router_reboot', relinkMbps: 1000, wlanFailover: false }),
    down(to - 12 * HOUR, { cause: 'pre_sleep' }),
    down(to + HOUR, { cause: 'runtime', relinkMbps: 100 }), // after `to` → ignored
  ];

  it('counts only runtime drops as faults and computes relink speed shares', () => {
    const s = computeLinkSummary(events, to - DAY, to);
    expect(s.runtimeDrops24h).toBe(2);
    expect(s.runtimeDrops7d).toBe(3);
    expect(s.bootRelinks).toBe(1);
    // relinks in range with known speed: runtime 1000, runtime 100, boot 100 → 2 of 3 below 1 Gbit/s
    expect(s.relinkBelow1gPct).toBe(66.7);
    expect(s.wlanFailovers24h).toBe(1);
    expect(s.lastDropTs).toBe(to - 2 * HOUR);
  });

  it('handles an empty history', () => {
    expect(computeLinkSummary([], 0, to)).toEqual({
      runtimeDrops24h: 0, runtimeDrops7d: 0, bootRelinks: 0, relinkBelow1gPct: null, wlanFailovers24h: 0, lastDropTs: null,
    });
  });
});
