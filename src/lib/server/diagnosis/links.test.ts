import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { NetEvent } from '../../shared/types';
import { buildLinkDays, buildLinkDrops, isFaultDrop, linkCauseOf, relinkStats } from './links';

interface RawEvent {
  provider: string;
  id: number;
  recordId: number;
  t: number;
  msg: string;
}

/** real e2fexpress history of this PC (27 = link down, 32 = up 1 Gbit/s, 33 = up 100 Mbit/s) */
function fixtureEvents(): NetEvent[] {
  const file = path.resolve(__dirname, '../../../../fixtures/windows/pscol_events_e2fexpress_all.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as RawEvent[];
  return raw.map((e) => ({
    id: e.recordId,
    ts: e.t,
    type: e.id === 27 ? 'nic_link_down' : 'nic_link_up',
    severity: e.id === 27 ? 'warn' : 'info',
    title: e.msg,
    source: 'eventlog',
    details: e.id === 32 ? { speedMbps: 1000 } : e.id === 33 ? { speedMbps: 100 } : {},
  }));
}

describe('buildLinkDrops (real e2fexpress fixture)', () => {
  const events = fixtureEvents();
  const drops = buildLinkDrops(events, null);

  it('pairs every link-down with its relink and speed', () => {
    expect(drops).toHaveLength(77);
    expect(drops.every((d) => d.endTs !== null && d.downtimeMs !== null && d.downtimeMs >= 0)).toBe(true);
    expect(drops.filter((d) => d.relinkMbps === 1000)).toHaveLength(47);
    expect(drops.filter((d) => d.relinkMbps === 100)).toHaveLength(30);
    // unclassified warn events count as faults (eventlog collector did not classify them)
    expect(drops.every((d) => d.cause === 'unknown' && isFaultDrop(d))).toBe(true);
    expect(drops.every((d) => d.wlanFailover === null)).toBe(true);
  });

  it('builds per-day counts matching the relink speeds', () => {
    const days = buildLinkDays(events);
    expect(days.reduce((s, d) => s + d.down, 0)).toBe(77);
    expect(days.reduce((s, d) => s + d.up1g, 0)).toBe(47);
    expect(days.reduce((s, d) => s + d.up100m, 0)).toBe(30);
    expect(days[0].day <= days[days.length - 1].day).toBe(true);
  });

  it('reports the share of sub-gigabit relinks over the most recent 20', () => {
    const rs = relinkStats(drops);
    // the last relink of the fixture (09.10. 13:37 resume) came up at 100 Mbit/s → no fixed run
    expect(rs).toEqual({ total: 20, below1g: 7, fixedRun: 0 });
  });
});

describe('link helpers', () => {
  const base: NetEvent = { ts: 1000, type: 'nic_link_down', severity: 'warn', title: 'down', source: 'eventlog' };

  it('reads details.cause and falls back to the severity', () => {
    expect(linkCauseOf({ ...base, details: { cause: 'runtime' } })).toBe('runtime');
    expect(linkCauseOf({ ...base, details: { cause: 'boot' } })).toBe('boot');
    expect(linkCauseOf({ ...base, details: { cause: 'weird' } })).toBe('unknown');
    expect(linkCauseOf({ ...base, severity: 'info' })).toBe('boot');
  });

  it('prefers details over inferred values and infers WLAN failover from wlan_connect', () => {
    const events: NetEvent[] = [
      { ...base, ts: 10_000, details: { cause: 'runtime' } },
      { ...base, ts: 16_000, type: 'nic_link_up', details: { speedMbps: 100 } },
      { ...base, ts: 100_000, details: { cause: 'runtime', relinkMbps: 1000, downtimeMs: 4000, wlanFailover: false } },
    ];
    const drops = buildLinkDrops(events, [10_600]);
    expect(drops[0]).toMatchObject({ endTs: 16_000, relinkMbps: 100, downtimeMs: 6000, wlanFailover: true, cause: 'runtime' });
    expect(drops[1]).toMatchObject({ relinkMbps: 1000, downtimeMs: 4000, wlanFailover: false });
  });

  it('does not attribute a relink that comes more than 10 min later', () => {
    const drops = buildLinkDrops(
      [
        { ...base, ts: 0 },
        { ...base, ts: 11 * 60_000, type: 'nic_link_up', details: { speedMbps: 1000 } },
      ],
      null,
    );
    expect(drops[0].relinkMbps).toBeNull();
    expect(drops[0].endTs).toBeNull();
  });

  it('counts a run of ≥ 10 gigabit relinks as fixed run', () => {
    const drops = Array.from({ length: 14 }, (_, i) => ({
      id: i, ts: i * 1000, endTs: null, cause: 'boot' as const, downtimeMs: null, wlanFailover: null,
      relinkMbps: i < 3 ? 100 : 1000,
    }));
    const rs = relinkStats(drops);
    expect(rs).toEqual({ total: 14, below1g: 3, fixedRun: 11 });
  });
});
