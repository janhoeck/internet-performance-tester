import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openEngineDb } from '../../../../engine/db/engine-db';
import { DEFAULT_CONFIG } from '../../shared/config';
import { summarize } from '../../shared/stats';
import type { MetricPoint, Rollup, SecondsRollup } from '../../shared/types';
import { runDiagnosis } from './index';
import { buildDiagnosisInput, isLagMark, speedtestMinutes } from './input';
import { DAY, HOUR, MINUTE } from './time';
import type { DiagnosisInput } from './types';

const TO = new Date(2026, 9, 9, 12, 0).getTime();
const FROM = TO - 2 * DAY;
const GAP_FROM = FROM + 20 * HOUR;
const GAP_TO = GAP_FROM + 2 * HOUR;
/** minute with a speed test, a link problem and own high load */
const SPEED_MIN = FROM + 30 * HOUR;
const LINK_MIN = FROM + 40 * HOUR;
const LOAD_MIN = FROM + 41 * HOUR;
const RTT: Record<string, number> = { gw: 1, isp6: 12, cf4: 18, cf6: 17, g4: 17, g6: 18, 'aws-fra': 22 };

let dir = '';
let dbFile = '';
let input: DiagnosisInput;

function minutes(): number[] {
  const out: number[] = [];
  for (let t = FROM; t < TO; t += MINUTE) if (t < GAP_FROM || t >= GAP_TO) out.push(t);
  return out;
}

function seed(file: string): void {
  const db = openEngineDb(file, { flushIntervalMs: 60_000 });
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.tariff = { name: 'Cable 500', downMbps: 500, upMbps: 50 };
  db.setSetting('config', JSON.stringify(cfg));

  const rollups: Rollup[] = [];
  const seconds: SecondsRollup[] = [];
  for (const ts of minutes()) {
    for (const [targetId, base] of Object.entries(RTT)) {
      const n = targetId === 'aws-fra' ? 6 : 60;
      let v = base;
      if (targetId === 'cf4' && ts === SPEED_MIN) v = 200;
      if (targetId === 'cf4' && ts === LINK_MIN) v = 90;
      rollups.push({ ts, targetId, spikes: 0, ...summarize(Array<number>(n).fill(v)) });
    }
    const link = ts === LINK_MIN ? 30 : 0;
    const access = ts % (97 * MINUTE) === 0 ? 5 : 0;
    const selfLoad = ts === LOAD_MIN ? 20 : 0;
    const es = access + (ts === LOAD_MIN ? 3 : 0);
    seconds.push({
      ts, covered: 60, good: 60 - link - access - (ts === LOAD_MIN ? 3 : 0), link, lan: 0, access, aftr: 0, backbone: 0, remote: 0,
      unknown: ts === LOAD_MIN ? 3 : 0, es, ses: 0, selfLoad,
    });
  }
  db.upsertRollups(rollups);
  db.upsertSecondsRollups(seconds);

  // events
  const runtimeDown = LINK_MIN - 10_000;
  db.insertEvent({
    ts: runtimeDown, endTs: runtimeDown + 6000, type: 'nic_link_down', severity: 'warn', title: 'Netzwerkkabel getrennt', source: 'eventlog',
    details: { cause: 'runtime', relinkMbps: 100, downtimeMs: 6000, wlanFailover: true }, dedupeKey: 'evt:1',
  });
  db.insertEvent({ ts: runtimeDown + 6000, type: 'nic_link_up', severity: 'info', title: 'Link 100 Mbit/s', source: 'eventlog', details: { speedMbps: 100 }, dedupeKey: 'evt:2' });
  db.insertEvent({ ts: TO - 20 * DAY, type: 'nic_link_down', severity: 'info', title: 'Link down (Start)', source: 'eventlog', details: { cause: 'boot' }, dedupeKey: 'evt:3' });
  db.insertEvent({ ts: TO - 20 * DAY + 4000, type: 'nic_link_up', severity: 'info', title: 'Link 1 Gbit/s', source: 'eventlog', details: { speedMbps: 1000 }, dedupeKey: 'evt:4' });
  db.insertEvent({ ts: FROM + 5 * HOUR, endTs: FROM + 5 * HOUR + 5000, type: 'outage', severity: 'critical', title: 'Ausfall: Kabelnetz', source: 'icmp', details: { classification: 'docsis', durationMs: 5000 } });
  for (let i = 0; i < 3; i++) {
    db.insertEvent({ ts: FROM + (6 + i) * HOUR, type: 'latency_spike', severity: 'info', title: 'Latenzspitze', source: 'icmp', details: { targetId: 'cf4', peakMs: 150 } });
  }
  db.insertEvent({ ts: FROM + 9 * HOUR, type: 'router_log', severity: 'warn', title: 'T3-Timeout', source: 'router', details: { category: 'T3' }, dedupeKey: 'router:1' });
  db.insertEvent({ ts: FROM + 10 * HOUR, type: 'note', severity: 'info', title: 'Kabel getauscht', source: 'user' });
  db.insertEvent({ ts: FROM + 12 * HOUR, type: 'note', severity: 'info', title: 'Lag im Spiel bemerkt', source: 'user', details: { origin: 'Lag jetzt markieren' } });
  db.insertEvent({ ts: FROM, type: 'session_start', severity: 'info', title: 'Langzeittest gestartet', source: 'engine', details: { label: 'Neues Kabel', resumed: false } });

  // snapshots
  const router = (firmware: string, ts: number) => ({
    ts, ip: '192.168.0.1', reachable: true, httpMs: 90, adapter: 'arris-vodafone-station', vendor: 'ARRIS', model: 'TG6442', firmware,
    loginConfigured: false, loginEnabled: false, loggedIn: false, loginError: null, lockoutUntil: null, connectionStatus: 'DOCSIS Online',
    wanIpv4: '0.0.0.0', wanIpv6: '2a02:8071::1', aftrAddress: '2a00:0:cff:84a0::3', dsLite: true, gwMode: 'Ipv6', uptimeSec: 3 * 86_400,
    lastRebootReason: 'Power On', docsis: null, attachedDevices: null, extra: { isDFSEnabled: false },
  });
  db.insertSnapshot('router', FROM + HOUR, router('01.05.063.10', FROM + HOUR));
  db.insertSnapshot('router', TO - HOUR, router('01.05.069.14', TO - HOUR));
  const adapters = (driverVersion: string, ts: number) => ({
    ts,
    adapters: [
      { name: 'Ethernet', description: 'Intel(R) Ethernet Controller (3) I225-V', ifIndex: 4, status: 'Up', linkMbps: 1000, mediaType: '802.3', mac: null, driverVersion, driverDate: '2024-02-15', serviceName: 'e2fexpress', isWifi: false, isVirtual: false, mediaConnected: true, addresses: ['192.168.0.192'], rxBytes: 1, txBytes: 1, rxErrors: 0, rxDiscards: 0, txErrors: 0, txDiscards: 0 },
      { name: 'WLAN', description: 'Intel(R) Wi-Fi 6E AX211', ifIndex: 7, status: 'Disconnected', linkMbps: null, mediaType: null, mac: null, driverVersion: '23.40.0.4', driverDate: null, serviceName: 'Netwtw14', isWifi: true, isVirtual: false, mediaConnected: false, addresses: [], rxBytes: null, txBytes: null, rxErrors: null, rxDiscards: null, txErrors: null, txDiscards: null },
    ],
    routes: [],
    advanced: [{ name: 'Speed & Duplex', value: 'Auto Negotiation' }],
  });
  db.insertSnapshot('adapters', FROM + 2 * HOUR, adapters('1.1.4.43', FROM + 2 * HOUR));
  db.insertSnapshot('adapters', FROM + 30 * HOUR, adapters('2.1.5.12', FROM + 30 * HOUR));
  db.insertSnapshot('adapters', TO - 2 * HOUR, adapters('2.1.5.12', TO - 2 * HOUR));
  db.insertSnapshot('docsis', TO - 30 * MINUTE, {
    ts: TO - 30 * MINUTE,
    ds: [{ dir: 'ds', channelId: 5, type: 'SC-QAM', frequencyMHz: 602, frequencyText: null, powerDbmv: 3, snrDb: 31, modulation: '256QAM', locked: true, corrected: null, uncorrectable: null, rating: 'warn', ratingNote: 'SNR 31,0 dB (Monatsfrist)' }],
    us: [],
    rating: 'warn',
    notes: ['DS 602 MHz: SNR 31,0 dB (Monatsfrist)'],
  });
  db.insertSnapshot('vpn', FROM - HOUR, { ts: FROM - HOUR, warp: { installed: true, connected: true, status: 'Connected', mode: 'tunnel_only', splitTunnel: 'include' }, otherTunnels: [] });
  db.insertSnapshot('vpn', FROM + 24 * HOUR, { ts: FROM + 24 * HOUR, warp: { installed: true, connected: false, status: 'Disconnected', mode: 'tunnel_only', splitTunnel: 'include' }, otherTunnels: [] });
  db.insertSnapshot('nat', TO - HOUR, [
    { ts: TO - HOUR, family: 4, localAddress: '192.168.0.192', publicIp: '92.208.29.229', mappings: [], mapping: 'endpoint-independent', cgnat: true },
    { ts: TO - HOUR, family: 6, localAddress: '2a02:8071::5', publicIp: '2a02:8071::5', mappings: [], mapping: 'endpoint-independent', cgnat: false },
  ]);
  db.insertSnapshot('mtu', TO - HOUR, { ts: TO - HOUR, family: 4, target: '1.1.1.1', mtu: 1460, maxPayload: 1432 });
  db.insertSnapshot('wlan', TO - HOUR, { ts: TO - HOUR, present: true, connected: false, ssid: null, bssid: null, radioType: null, band: null, channel: null, signalPct: null, rssiDbm: null, rxMbps: null, txMbps: null, raw: {} });

  // metrics: link speed 100 Mbit/s for 30 min after the runtime drop
  const points: MetricPoint[] = [];
  for (let t = FROM; t < TO; t += MINUTE) {
    if (t >= GAP_FROM && t < GAP_TO) continue;
    points.push({ ts: t, key: 'nic.link_mbps', value: t >= LINK_MIN && t < LINK_MIN + 30 * MINUTE ? 100 : 1000 });
    if (t % (10 * MINUTE) === 0) points.push({ ts: t, key: 'tcp.retrans_pct', value: 0.5 }, { ts: t, key: 'router.http_ms', value: 80 });
  }
  points.push({ ts: FROM + HOUR, key: 'udp.burst.cf4-udp.loss_pct', value: 0 });
  db.addMetrics(points);

  db.insertSpeedtest({
    ts: SPEED_MIN + 5000, endTs: SPEED_MIN + 50_000, trigger: 'schedule', server: 'Cloudflare DUS', downMbps: 120, upMbps: 40,
    idleLatencyMs: 18, idleJitterMs: 2, loadedDownLatencyMs: 60, loadedDownP95Ms: 90, loadedUpLatencyMs: 40, loadedUpP95Ms: 60,
    bloatDownMs: 42, bloatUpMs: 22, grade: 'B', bytesDown: 1e8, bytesUp: 1e7, streams: 6, nicLinkMbps: 1000, error: null,
    series: [{ t: 0, phase: 'idle', rtt: 18 }],
  });
  db.insertTraceroute({ ts: FROM + HOUR, target: '1.1.1.1', family: 4, hops: [{ hop: 1, ip: '192.168.0.1', rtts: [1, 1, 1], lossPct: 0, avgMs: 1 }], reached: true, pathHash: 'a', changed: false, trigger: 'startup', durationMs: 3000 });
  db.insertTraceroute({ ts: FROM + 5 * HOUR, target: '2606:4700:4700::1111', family: 6, hops: [], reached: true, pathHash: 'b', changed: true, trigger: 'incident', durationMs: 4000 });
  db.createSession({ startedAt: FROM, endedAt: null, plannedEndAt: null, label: 'Neues Kabel', status: 'running', note: null });
  db.close();

  // a row written by an older/broken version: invalid JSON must not break the queries
  const raw = new DatabaseSync(file);
  raw.prepare('INSERT INTO events(ts, type, severity, title, details, source) VALUES (?, ?, ?, ?, ?, ?)').run(FROM + 11 * HOUR, 'latency_spike', 'info', 'kaputt', 'not json', 'icmp');
  raw.close();
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'netdiag-diag-'));
  dbFile = path.join(dir, 'diag.db');
  seed(dbFile);
  process.env.NETDIAG_DB = dbFile;
  input = buildDiagnosisInput(FROM, TO, { now: TO });
});

afterAll(() => {
  const g = globalThis as typeof globalThis & { __netdiagDb?: { db: DatabaseSync; path: string } };
  try {
    g.__netdiagDb?.db.close();
  } catch {
    /* already closed */
  }
  delete g.__netdiagDb;
  delete process.env.NETDIAG_DB;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* windows may keep the file locked briefly */
  }
});

describe('buildDiagnosisInput (temp DB)', () => {
  const measured = minutes().length;

  it('reads the config and targets from the settings table', () => {
    expect(input.config.tariff.downMbps).toBe(500);
    expect(input.targets.find((t) => t.id === 'gw')?.host).toBe('$gateway');
  });

  it('merges minute rollups and excludes speed-test minutes', () => {
    expect(input.stats.gw.sent).toBe((measured - 1) * 60);
    expect(input.stats.gw.p50).toBeLessThan(1.5);
    expect(input.loadStats.cf4.sent).toBe(60);
    expect(input.loadStats.cf4.p50).toBeGreaterThan(180);
    expect(input.stats.cf4.p99).toBeLessThan(100);
    expect(input.stats['aws-fra'].sent).toBe((measured - 1) * 6);
  });

  it('keeps "stable" minutes without link problems and own load', () => {
    expect(input.statsStable.cf4.sent).toBe((measured - 3) * 60);
    expect(input.statsStable.cf4.max).toBe(18);
  });

  it('merges the internet groups', () => {
    const ids = ['cf4', 'cf6', 'g4', 'g6'];
    expect(input.stats['@internet'].sent).toBe(ids.reduce((s, id) => s + input.stats[id].sent, 0));
    expect(input.stats['@internet4'].sent).toBe(input.stats.cf4.sent + input.stats.g4.sent);
    expect(input.stats['@game'].sent).toBe(input.stats['aws-fra'].sent);
  });

  it('builds hourly/daily profiles, windows and LAN hours', () => {
    expect(input.hourly.gw).toHaveLength(24);
    expect(input.daily.gw.map((d) => d.day)).toEqual(['2026-10-07', '2026-10-08', '2026-10-09']);
    expect(input.daily.gw[1].evening.minutes).toBe(240);
    expect(input.periods['@internet'].base.sent).toBeGreaterThan(0);
    expect(input.windows.cf4.length).toBeGreaterThan(180);
    expect(input.windows.gw.length).toBe(input.windows.cf4.length);
    expect(input.lanHours.length).toBe(46);
  });

  it('sums classified seconds, the load correlation and the ES series', () => {
    expect(input.seconds?.covered).toBe(measured * 60);
    expect(input.seconds?.link).toBe(30);
    expect(input.seconds?.selfLoad).toBe(20);
    expect(input.secondsHourly).toHaveLength(24);
    expect(input.secondsDaily).toHaveLength(3);
    expect(input.loadCorrelation).toMatchObject({ loadMinutes: 1, esLoad: 3, coveredLoad: 60 });
    expect(input.esPerMinute).toHaveLength(measured);
    expect(input.secondsWindows.length).toBeGreaterThan(180);
  });

  it('computes coverage and gaps', () => {
    expect(input.coverage.coveredSeconds).toBe(measured * 60);
    expect(input.coverage.coveragePct).toBeCloseTo((measured / (2 * 1440)) * 100, 5);
    expect(input.coverage.gaps).toEqual({ count: 1, totalMs: 2 * HOUR, longestMs: 2 * HOUR });
    expect(input.coverage.daysCovered).toBe(3);
    expect(input.coverage.hasSeconds).toBe(true);
    expect(input.coverage.samples).toBe(measured * (6 * 60 + 6));
    expect(input.coverage.analysisFrom).toBe(FROM);
  });

  it('reads events by type, spike times and link drops', () => {
    expect(input.events.counts.outage).toBe(1);
    expect(input.events.byType.outage?.[0].details?.classification).toBe('docsis');
    expect(input.events.byType.router_log).toHaveLength(1);
    expect(input.events.truncated).toEqual([]);
    expect(input.spikeTimes.map((s) => s.targetId)).toEqual(['cf4', 'cf4', 'cf4', null]);
    expect(input.linkDrops).toHaveLength(2);
    expect(input.linkDrops[1]).toMatchObject({ cause: 'runtime', relinkMbps: 100, downtimeMs: 6000, wlanFailover: true });
    expect(input.linkDrops[0].cause).toBe('boot');
    expect(input.linkDays.reduce((s, d) => s + d.up100m, 0)).toBe(1);
  });

  it('summarizes link speed and metrics', () => {
    expect(input.linkSpeed.currentMbps).toBe(1000);
    expect(input.linkSpeed.msBelow1g).toBe(30 * MINUTE);
    expect(input.linkSpeed.minMbps).toBe(100);
    expect(input.metrics['tcp.retrans_pct']).toMatchObject({ avg: 0.5, p95: 0.5, last: 0.5 });
    expect(input.metrics['udp.burst.cf4-udp.loss_pct']?.count).toBe(1);
  });

  it('reads the latest snapshots tolerantly', () => {
    expect(input.router?.firmware).toBe('01.05.069.14');
    expect(input.router?.dsLite).toBe(true);
    expect(input.docsis?.rating).toBe('warn');
    expect(input.docsisTs).toBe(TO - 30 * MINUTE);
    expect(input.adapters?.adapters[0].driverVersion).toBe('2.1.5.12');
    expect(input.vpn?.warp?.connected).toBe(false);
    expect(input.nat.map((n) => n.family)).toEqual([4, 6]);
    expect(input.nat[0].publicIp).toBe('92.208.29.229');
    expect(input.mtu[0].mtu).toBe(1460);
    expect(input.wlan?.connected).toBe(false);
  });

  it('detects changes (driver, firmware, notes, labelled sessions)', () => {
    const labels = input.changes.map((c) => `${c.kind}:${c.label}`);
    expect(labels).toContain('driver:Treiber Ethernet: 1.1.4.43 → 2.1.5.12');
    expect(labels).toContain('firmware:Router-Firmware: 01.05.063.10 → 01.05.069.14');
    expect(labels).toContain('note:Kabel getauscht');
    expect(labels).toContain('session:Langzeittest „Neues Kabel“');
    expect(labels.some((l) => l.includes('Lag im Spiel'))).toBe(false);
    expect(input.changes.find((c) => c.kind === 'driver')?.ts).toBe(FROM + 30 * HOUR);
  });

  it('builds the VPN timeline and the WARP on/off comparison', () => {
    expect(input.vpnTimeline.map((v) => v.connected)).toEqual([true, false]);
    expect(input.vpnCompare?.onMs).toBeGreaterThan(10 * HOUR);
    expect(input.vpnCompare?.offMs).toBeGreaterThan(10 * HOUR);
  });

  it('reads speed tests (without series), traceroutes and sessions', () => {
    expect(input.speedtests).toHaveLength(1);
    expect(input.speedtests[0].series).toEqual([]);
    expect(input.speedtests[0].grade).toBe('B');
    expect(input.traceroutes.count).toBe(2);
    expect(input.traceroutes.changed).toBe(1);
    expect(input.traceroutes.latest6?.target).toBe('2606:4700:4700::1111');
    expect(input.sessions[0].label).toBe('Neues Kabel');
  });

  it('runs the full diagnosis end to end', () => {
    const r = runDiagnosis(FROM, TO);
    expect(r.verdict.title.length).toBeGreaterThan(10);
    expect(r.segments).toHaveLength(8);
    expect(r.seconds?.covered).toBe(measured * 60);
    expect(r.gamingScore?.grade).toBe('A');
    expect(r.findings.some((f) => f.id === 'docsis-values')).toBe(true);
    expect(() => runDiagnosis(TO, FROM)).toThrow(RangeError);
  });
});

describe('input helpers', () => {
  const note = (title: string, details: Record<string, unknown> | null = null) => ({ ts: 0, type: 'note' as const, severity: 'info' as const, title, source: 'user' as const, details });

  it('tells lag marks from change notes', () => {
    expect(isLagMark(note('Lag im Spiel bemerkt'))).toBe(true);
    expect(isLagMark(note('Notiz', { origin: 'Lag jetzt markieren' }))).toBe(true);
    expect(isLagMark(note('Ping-Spitzen in CS2'))).toBe(true);
    expect(isLagMark(note('Kabel getauscht (Cat 6, direkt)'))).toBe(false);
    expect(isLagMark(note('Treiber aktualisiert'))).toBe(false);
  });

  it('lists the minutes overlapping speed tests', () => {
    const m = 60_000;
    expect(speedtestMinutes([{ ts: 10 * m + 5000, endTs: 11 * m + 30_000 }], 0, 100 * m)).toEqual([10 * m, 11 * m]);
    expect(speedtestMinutes([{ ts: 10 * m, endTs: 10 * m }], 0, 100 * m)).toEqual([]);
    expect(speedtestMinutes([{ ts: 10 * m, endTs: 10 * m + 1e12 }], 0, 1e13)).toHaveLength(60);
  });
});
