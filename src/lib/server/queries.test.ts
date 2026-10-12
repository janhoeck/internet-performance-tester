import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decodeHistogram, mergeRollups } from '../shared/stats';
import { getConfig } from './config-store';
import { getDb } from './db';
import {
  RAW_MAX_SPAN_MS,
  getClient,
  getDbInfo,
  getEvents,
  getHeatmap,
  getHourProfile,
  getMetrics,
  getPath,
  getRouter,
  getSamples,
  getSeconds,
  getSeries,
  getSessions,
  getSpeedtest,
  getStats,
  insertNote,
  listSpeedtests,
  listTraceroutes,
  speedtestMinutes,
  speedtestWindows,
} from './queries';
import { TEST_END, TEST_FROM, type SeededDb, seedTempDb } from './test-seed';
import { HOUR, MINUTE } from './time';

let seeded: SeededDb;
const from = TEST_FROM;
const to = TEST_END;
const at = (f: number) => Math.round((from + (to - from) * f) / 1000) * 1000; // same layout as buildPlan

beforeAll(() => {
  seeded = seedTempDb();
});
afterAll(() => seeded.cleanup());

const one = (sql: string, ...p: (string | number)[]) => Number((getDb().prepare(sql).get(...p) as { n: number | bigint }).n);

describe('seeded fixture', () => {
  it('contains the planned data', () => {
    expect(seeded.summary.samples).toBeGreaterThan(90_000);
    expect(seeded.summary.speedtests).toBe(6);
    expect(seeded.summary.sessions).toBe(2);
    expect(getConfig().tariff.downMbps).toBe(500);
  });

  it('db info finds first/last sample with PK seeks', () => {
    const info = getDbInfo();
    expect(info.firstSampleTs).toBe(from);
    expect(info.lastSampleTs).toBeLessThan(to);
    expect(info.lastSampleTs).toBeGreaterThan(to - 11_000);
    expect(info.sizeBytes).toBeGreaterThan(0);
  });
});

describe('getSeries', () => {
  it('serves short ranges from raw samples with aligned columns', () => {
    const f = to - HOUR;
    const res = getSeries({ targets: ['gw', 'cf4', 'cf4-udp', 'nope'], from: f, to });
    expect(res.source).toBe('raw');
    expect(res.stepMs).toBe(5000);
    for (const id of ['gw', 'cf4', 'cf4-udp']) {
      const s = res.series[id];
      for (const col of [s.avg, s.min, s.max, s.p95, s.lossPct, s.sent]) expect(col).toHaveLength(s.ts.length);
      const sent = s.sent.reduce((a, b) => a + b, 0);
      expect(sent).toBe(one('SELECT COUNT(*) AS n FROM samples WHERE target_id = ? AND ts >= ? AND ts < ?', id, f, to));
      for (let i = 1; i < s.ts.length; i++) expect(s.ts[i]).toBeGreaterThan(s.ts[i - 1]);
    }
    expect(res.series.nope.ts).toEqual([]);
  });

  it('serves long ranges from minute rollups (step multiple of 60 s)', () => {
    const f = from - HOUR;
    expect(to - f).toBeGreaterThan(RAW_MAX_SPAN_MS);
    const res = getSeries({ targets: ['isp6'], from: f, to, step: 90_000 });
    expect(res.source).toBe('rollup');
    expect(res.stepMs).toBe(120_000);
    const sent = res.series.isp6.sent.reduce((a, b) => a + b, 0);
    expect(sent).toBe(one('SELECT SUM(sent) AS n FROM rollup_1m WHERE target_id = ? AND ts >= ? AND ts < ?', 'isp6', f, to));
    // the standby gap and the session break produce null gap markers
    expect(res.series.isp6.avg.some((v) => v === null)).toBe(true);
  });
});

describe('getSamples', () => {
  it('returns ascending raw samples and flags truncation', () => {
    const res = getSamples('cf4', from, to, 100);
    expect(res.truncated).toBe(true);
    expect(res.ts).toHaveLength(100);
    expect(res.ts[0]).toBe(from);
    expect(res.rtt).toHaveLength(100);
    expect(res.status.every((s) => s >= 0 && s <= 4)).toBe(true);
    const all = getSamples('aws-irl', from, to, 1_000_000);
    expect(all.truncated).toBe(false);
    expect(all.ts.length).toBe(one("SELECT COUNT(*) AS n FROM samples WHERE target_id = 'aws-irl'"));
  });
});

describe('getStats', () => {
  it('merges rollups exactly like stats.ts mergeRollups', () => {
    const res = getStats({ from, to, targets: ['cf4'], excludeSpeedtests: false });
    const rows = getDb().prepare('SELECT * FROM rollup_1m WHERE target_id = ? AND ts >= ? AND ts < ? ORDER BY ts').all('cf4', from, to) as Record<string, number | string | null>[];
    const merged = mergeRollups(
      rows.map((r) => ({
        sent: Number(r.sent),
        lost: Number(r.lost),
        min: r.min as number | null,
        avg: r.avg as number | null,
        max: r.max as number | null,
        jitter: r.jitter as number | null,
        stddev: r.stddev as number | null,
        spikes: Number(r.spikes),
        hist: decodeHistogram(r.hist as string | null),
      })),
    );
    const s = res.stats[0];
    expect(s.sent).toBe(merged.sent);
    expect(s.lost).toBe(merged.lost);
    expect(s.p95).toBeCloseTo(merged.p95 ?? -1, 2);
    expect(s.avg).toBeCloseTo(merged.avg ?? -1, 2);
    expect(s.jitter).toBeCloseTo(merged.jitter ?? -1, 2);
    expect(s.spikes).toBe(merged.spikes);
    expect(s.spikesPerHour).toBeCloseTo(merged.spikes / (merged.minutes / 60), 2);
    expect(s.coveragePct).toBeCloseTo((rows.length / 180) * 100, 2);
    expect(s.coveragePct).toBeLessThan(100); // standby + session break
  });

  it('excludes speed test minutes by default', () => {
    const minutes = speedtestMinutes(from, to, getConfig());
    expect(minutes.size).toBeGreaterThanOrEqual(6);
    for (const f of [0.05, 0.22, 0.38, 0.55, 0.78, 0.95]) expect(minutes.has(Math.floor(at(f) / MINUTE) * MINUTE)).toBe(true);
    expect(speedtestWindows(from, to).length).toBe(12); // event + table row per test
    const incl = getStats({ from, to, targets: ['gw'], excludeSpeedtests: false }).stats[0];
    const excl = getStats({ from, to, targets: ['gw'], excludeSpeedtests: true }).stats[0];
    expect(excl.sent).toBeLessThan(incl.sent);
    expect(incl.sent - excl.sent).toBeLessThanOrEqual(minutes.size * 60);
    expect(excl.coveragePct).toBe(incl.coveragePct);
  });

  it('summarizes minutes without rollups from raw samples (rollups lag behind)', () => {
    getDb().prepare('DELETE FROM rollup_1m WHERE target_id = ? AND ts >= ?').run('g6', to - 10 * MINUTE);
    const s = getStats({ from, to, targets: ['g6'], excludeSpeedtests: false }).stats[0];
    expect(s.sent).toBe(one('SELECT COUNT(*) AS n FROM samples WHERE target_id = ? AND ts >= ? AND ts < ?', 'g6', from, to));
  });

  it('returns empty stats for unknown targets', () => {
    const s = getStats({ from, to, targets: ['unbekannt'], excludeSpeedtests: true }).stats[0];
    expect(s).toMatchObject({ targetId: 'unbekannt', sent: 0, lossPct: null, p50: null, coveragePct: 0, spikesPerHour: null });
  });
});

describe('getSeconds', () => {
  it('buckets classified seconds and totals them', () => {
    const res = getSeconds(from, to, null);
    expect(res.stepMs).toBe(MINUTE);
    const sum = getDb().prepare('SELECT SUM(covered) AS covered, SUM(link) AS link, SUM(access) AS access, SUM(self_load) AS sl FROM seconds_1m WHERE ts >= ? AND ts < ?').get(from, to) as Record<string, number>;
    expect(res.total.covered).toBe(sum.covered);
    expect(res.total.link).toBe(sum.link);
    expect(res.total.access).toBe(sum.access);
    expect(res.total.selfLoad).toBe(sum.sl);
    expect(res.buckets.reduce((a, b) => a + b.covered, 0)).toBe(res.total.covered);
    // planned incidents: link drops, evening congestion, own download
    expect(res.total.link).toBeGreaterThan(100);
    expect(res.total.access).toBeGreaterThan(0);
    expect(res.total.selfLoad).toBeGreaterThan(60);
    const hourly = getSeconds(from, to, HOUR);
    expect(hourly.buckets).toHaveLength(3);
    expect(hourly.total).toEqual({ ...res.total, ts: from });
  });
});

describe('getHeatmap / getHourProfile', () => {
  it('builds local day × hour cells with coverage', () => {
    const hm = getHeatmap('cf4', 'p95', 2, { now: to - 1 });
    expect(hm.days).toEqual(['2026-10-07', '2026-10-08']);
    expect(hm.values[0].every((v) => v === null)).toBe(true);
    expect(hm.values[1].slice(20, 23).every((v) => v !== null && v > 5)).toBe(true);
    expect(hm.values[1][19]).toBeNull();
    expect(hm.values[1][23]).toBeNull();
    expect(hm.coverage[1][22]).toBe(100);
    expect(hm.coverage[1][20]).toBeLessThan(100); // standby 20:54–20:57
    const loss = getHeatmap('cf4', 'loss', 2, { now: to - 1 });
    expect(loss.values[1][21]).toBeGreaterThan(0); // router reboot 21:48
  });

  it('profiles the hours of the range', () => {
    const p = getHourProfile('cf4', from, to);
    expect(p.filter((h) => h.minutes > 0).map((h) => h.hour)).toEqual([20, 21, 22]);
  });
});

describe('events', () => {
  it('lists newest first with total, filters and pagination', () => {
    const all = getEvents({ from, to, limit: 5000, offset: 0 });
    expect(all.total).toBe(all.events.length);
    for (let i = 1; i < all.events.length; i++) expect(all.events[i].ts).toBeLessThanOrEqual(all.events[i - 1].ts);
    const outages = getEvents({ from, to, types: ['outage'], limit: 10, offset: 0 });
    expect(outages.events.map((e) => e.details?.classification).sort()).toEqual(['client', 'lan']);
    const crit = getEvents({ from, to, severities: ['critical'], limit: 50, offset: 0 });
    expect(crit.events.every((e) => e.severity === 'critical')).toBe(true);
    expect(crit.events.some((e) => e.type === 'router_offline')).toBe(true);
    const p1 = getEvents({ from, to, limit: 5, offset: 0 });
    const p2 = getEvents({ from, to, limit: 5, offset: 5 });
    expect(p2.events[0].id).not.toBe(p1.events[0].id);
    expect(p2.total).toBe(all.total);
    const seg = getEvents({ from, to, segments: ['client'], sources: ['eventlog'], limit: 100, offset: 0 });
    expect(seg.events.length).toBeGreaterThan(0);
    expect(seg.events.every((e) => e.segment === 'client' && e.source === 'eventlog')).toBe(true);
  });

  it('includes episodes that started before `from` but end inside the range', () => {
    const outageStart = at(0.6);
    const res = getEvents({ from: outageStart + 60_000, to, types: ['outage'], limit: 10, offset: 0 });
    expect(res.events.map((e) => e.ts)).toContain(outageStart);
  });

  it('inserts user notes ("Lag jetzt markieren")', () => {
    const e = insertNote({ title: 'Lag jetzt', details: { game: 'cs2' } }, to - 30_000);
    expect(e.id).toBeGreaterThan(0);
    const notes = getEvents({ from, to, types: ['note'], limit: 10, offset: 0 }).events;
    expect(notes[0]).toMatchObject({ id: e.id, title: 'Lag jetzt', source: 'user', severity: 'info', details: { game: 'cs2' } });
  });
});

describe('getMetrics', () => {
  it('buckets with the registry aggregation and carries the last state in', () => {
    const f = at(0.75); // after the third drop: link at 100 Mbit/s
    const res = getMetrics(['nic.link_mbps', 'nic.rx_errors', 'docsis.ds.snr_min', 'unbekannt.key'], f, to, null);
    expect(res.stepMs).toBe(2000); // 45 min / 1500 points = 1.8 s → 2 s
    const link = res.series['nic.link_mbps'];
    expect(link.ts[0]).toBe(f); // carry-in point
    expect(link.value[0]).toBe(100);
    expect(link.value.at(-1)).toBe(1000); // fourth drop relinks at 1 Gbit/s
    expect(res.series['docsis.ds.snr_min'].value.every((v) => v !== null && v > 30)).toBe(true);
    expect(res.series['unbekannt.key']).toEqual({ ts: [], value: [] });
    // 3-h buckets are aligned to local wall-clock multiples (18–21 h, 21–24 h) → two buckets, 'sum' aggregation
    const errors = getMetrics(['nic.rx_errors'], from, to, 3 * HOUR).series['nic.rx_errors'];
    expect(errors.ts.map((t) => new Date(t).getHours())).toEqual([18, 21]);
    const total = errors.value.reduce<number>((a, b) => a + (b ?? 0), 0);
    expect(total).toBe(one("SELECT SUM(value) AS n FROM metrics WHERE key = 'nic.rx_errors' AND ts >= ? AND ts < ?", from, to));
  });
});

describe('speed tests, traceroutes, sessions', () => {
  it('lists speed tests without series and returns details with series', () => {
    const list = listSpeedtests(0, to + 1, 200).items;
    expect(list).toHaveLength(6);
    expect(list.every((s) => s.series.length === 0)).toBe(true);
    expect(list[0].ts).toBeGreaterThan(list[5].ts);
    expect(list.filter((s) => s.nicLinkMbps === 100)).toHaveLength(2);
    const detail = getSpeedtest(list[0].id ?? -1);
    expect(detail?.series.length).toBe(161);
    expect(getSpeedtest(999_999)).toBeNull();
    expect(listSpeedtests(0, to + 1, 2).items).toHaveLength(2);
  });

  it('lists traceroutes newest first, filtered by family', () => {
    const v4 = listTraceroutes({ family: 4, limit: 3 }).items;
    expect(v4).toHaveLength(3);
    expect(v4.every((t) => t.family === 4)).toBe(true);
    expect(v4[0].trigger).toBe('manual');
    expect(v4[0].hops.every((h) => h.mtr !== undefined)).toBe(true);
    expect(v4[0].hops[1].ip).toBeNull(); // AFTR hop never answers
    const v6 = listTraceroutes({ family: 6, from, to: at(0.5), limit: 500 }).items;
    expect(v6.every((t) => t.ts >= from && t.ts < at(0.5))).toBe(true);
    const changed = listTraceroutes({ family: 4, limit: 500 }).items.filter((t) => t.changed);
    expect(changed).toHaveLength(1); // route change at 52 %
  });

  it('returns sessions and the running one', () => {
    const s = getSessions();
    expect(s.items.map((i) => i.status)).toEqual(['running', 'completed']);
    expect(s.active?.label).toBe('Langzeittest 72 h');
  });
});

describe('path, router, client', () => {
  it('returns the latest MTU and NAT result per family', () => {
    const p = getPath();
    expect(p.mtu.map((m) => [m.family, m.mtu])).toEqual([[4, 1460], [6, 1500]]);
    expect(p.nat.map((n) => n.family)).toEqual([4, 6]);
    expect(p.nat[0]).toMatchObject({ publicIp: '92.208.40.112', cgnat: true, mapping: 'endpoint-independent' });
  });

  it('returns router status, DOCSIS history, log and HTTP history', () => {
    const r = getRouter(from, to, getConfig());
    expect(r.status?.model).toContain('TG6442');
    expect(r.status?.docsis?.ds).toHaveLength(33);
    expect(r.status?.uptimeSec).toBeLessThan(2 * 3600);
    const h = r.docsisHistory;
    for (const col of [h.dsPowerMin, h.dsPowerMax, h.dsSnrMin, h.usPowerMin, h.usPowerMax, h.corrDelta, h.uncorrDelta]) expect(col).toHaveLength(h.ts.length);
    expect(h.ts.length).toBeGreaterThan(20);
    expect(h.corrDelta.every((v) => v === null)).toBe(true); // Vodafone Station has no codeword counters
    expect(r.log.length).toBeGreaterThanOrEqual(5);
    for (let i = 1; i < r.log.length; i++) expect(r.log[i].ts ?? 0).toBeLessThanOrEqual(r.log[i - 1].ts ?? 0);
    expect(r.log.some((e) => e.category === 'T4' && e.severity === 'critical')).toBe(true);
    expect(r.log.every((e) => !/cm-mac/i.test(e.message))).toBe(true);
    expect(r.httpHistory.ms).toHaveLength(r.httpHistory.ts.length);
    expect(r.httpHistory.ms.some((v) => v === null)).toBe(true); // router unreachable during the reboot
  });

  it('returns adapters and link KPIs (only runtime drops count)', () => {
    const c = getClient(from, to);
    expect(c.adapters?.adapters.map((a) => a.name)).toEqual(['Ethernet', 'WLAN', 'CloudflareWARP']);
    expect(c.vpn?.warp?.splitTunnel).toBe('include');
    expect(c.wlan?.present).toBe(true);
    expect(c.linkEvents).toHaveLength(14); // 4 runtime drops, 2 reboot flaps, 1 resume relink (down + up each)
    expect(c.linkSummary).toEqual({
      runtimeDrops24h: 4,
      runtimeDrops7d: c.linkSummary.runtimeDrops7d,
      bootRelinks: 1,
      relinkBelow1gPct: 40,
      wlanFailovers24h: 3,
      lastDropTs: at(0.88),
    });
    expect(c.linkSummary.runtimeDrops7d).toBeGreaterThan(4); // imported history
    expect(c.linkDays.at(-1)?.day).toBe('2026-10-08');
    expect(c.linkDays.length).toBe(11);
  });
});
