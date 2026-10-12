import { describe, expect, it } from 'vitest';
import type { DocsisChannel, DocsisSnapshot, SpeedtestResult } from '../../../shared/types';
import { cmStatusCode, isSevereLineEntry, isUpstreamPartial, lineLogKind } from '../router-log';
import { T_END, dayPeriods, ev, healthyInput, secondsTotals, stats, withEvents } from '../test-utils';
import { DAY, HOUR, MINUTE, WINDOW_MS } from '../time';
import type { DayPeriods, DiagnosisInput, StatsSummary, WindowStat } from '../types';
import { accessSpikes } from './r07-access-spikes';
import { docsisValues } from './r09-docsis-values';
import { eveningRise, evaluatePeakDays, peakHours } from './r10-peak-hours';
import { ipv4VsIpv6 } from './r11-ipv4-vs-ipv6';
import { remoteOnly } from './r12-remote-only';
import { computeTopCause, topCauseFinding } from './r17-top-cause';
import { limitedByLink, speedBelowTariff } from './r18-speed-below-tariff';

const healthy = healthyInput();

describe('R07 access-spikes', () => {
  const withSeconds = (p: Parameters<typeof secondsTotals>[0]) => healthyInput({ seconds: secondsTotals(p) });

  it('blames the cable network when internet spikes coincide with the CMTS hop', () => {
    const f = accessSpikes(withSeconds({ access: 3000, aftr: 100, backbone: 100, unknown: 400 }))!;
    expect(f.segment).toBe('docsis');
    expect(f.title).toBe('Störung/Überlastung im Kabelnetz');
    expect(f.severity).toBe('critical'); // ≥ 1 % of the measured time
    expect(f.confidence).toBe('high');
    expect(f.recommendations[1]).toMatch(/Bericht exportieren/);
  });

  it('needs a clean router, little own load and enough ACCESS seconds', () => {
    const dirtyGw = healthyInput({
      seconds: secondsTotals({ access: 3000 }),
      statsStable: { ...healthy.statsStable, gw: stats({ p50: 1, p99: 15, sent: 259_200 }) },
    });
    expect(accessSpikes(dirtyGw)).toBeNull();
    expect(accessSpikes(withSeconds({ access: 3000, selfLoad: 1500 }))).toBeNull();
    expect(accessSpikes(withSeconds({ access: 20 }))).toBeNull();
    expect(accessSpikes(withSeconds({ access: 300, aftr: 200, backbone: 200 }))).toBeNull();
    expect(accessSpikes(healthy)).toBeNull();
  });
});

describe('router log classification', () => {
  it('classifies English DOCSIS messages, German titles and categories', () => {
    const log = (title: string, details: Record<string, unknown> = {}) => ev('router_log', 0, { title, details, source: 'router' });
    expect(lineLogKind(log('No Ranging Response received - T3 time-out'))).toBe('T3');
    expect(lineLogKind(log('T4-Timeout (CMTS fragt das Modem nicht mehr ab)'))).toBe('T4');
    expect(lineLogKind(log('Unicast Maintenance Ranging attempted - No response - Retries exhausted'))).toBe('ranging');
    expect(lineLogKind(log('SYNC Timing Synchronization failure - Loss of Sync'))).toBe('sync');
    expect(lineLogKind(log('Teilbetrieb Upstream (Kanäle verloren)'))).toBe('partial');
    expect(lineLogKind(log('irgendwas', { category: 'T3' }))).toBe('T3');
    expect(lineLogKind(log('Cable Modem Reboot'))).toBe('reboot');
    expect(cmStatusCode(log('CM-STATUS message sent. Event Type Code: 16; Chan ID: 193'))).toBe(16);
    expect(isSevereLineEntry(log('CM-STATUS message sent. Event Type Code: 16'))).toBe(false);
    expect(isSevereLineEntry(log('CM-STATUS message sent. Event Type Code: 2'))).toBe(true);
    expect(isUpstreamPartial(log('TCS Partial Service'))).toBe(true);
    expect(isUpstreamPartial(log('RCS Partial Service'))).toBe(false);
  });
});

describe('R09 docsis-values', () => {
  const ch = (p: Partial<DocsisChannel>): DocsisChannel => ({
    dir: 'ds', channelId: 5, type: 'SC-QAM', frequencyMHz: 602, frequencyText: null, powerDbmv: 3, snrDb: 38, modulation: '256QAM',
    locked: true, corrected: null, uncorrectable: null, rating: 'good', ratingNote: null, ...p,
  });
  const snapshot = (channels: DocsisChannel[], rating: DocsisSnapshot['rating']): DocsisSnapshot => ({
    ts: T_END - HOUR, ds: channels.filter((c) => c.dir === 'ds'), us: channels.filter((c) => c.dir === 'us'), rating, notes: [],
  });

  it('is critical for a channel in the "sofort" range', () => {
    const docsis = snapshot([ch({}), ch({ channelId: 6, frequencyMHz: 610, snrDb: 29.5, rating: 'bad', ratingNote: 'SNR 29,5 dB (sofort)' })], 'bad');
    const f = docsisValues(healthyInput({ docsis, docsisTs: docsis.ts }))!;
    expect(f.severity).toBe('critical');
    expect(f.confidence).toBe('medium');
    expect(f.segment).toBe('docsis');
    expect(f.evidence.some((e) => e.label === 'Downstream SC-QAM 610 MHz' && e.value.includes('SNR 29,5 dB'))).toBe(true);
  });

  it('is critical for T3 clusters and T4/sync events', () => {
    const t3 = [0, 2, 4, 6].map((m) => ev('router_log', T_END - HOUR + m * MINUTE, { title: 'T3-Timeout', details: { category: 'T3' }, source: 'router' }));
    expect(docsisValues(withEvents(healthy, t3))!.severity).toBe('critical');
    const t4 = ev('router_log', T_END - HOUR, { title: 'Started Unicast Maintenance Ranging - No Response received - T4 time-out', source: 'router' });
    const f = docsisValues(withEvents(healthy, [t4]))!;
    expect(f.severity).toBe('critical');
    expect(f.summary).toMatch(/schwerer Leitungsfehler/);
  });

  it('flags lost channels from the DOCSIS metrics', () => {
    const f = docsisValues(
      healthyInput({ metrics: { 'docsis.ds.locked': { key: 'docsis.ds.locked', count: 800, avg: 31.9, min: 29, max: 32, p95: null, last: 32, lastTs: T_END } } }),
    )!;
    expect(f.severity).toBe('critical');
    expect(f.summary).toContain('3 Downstream-Kanäle weniger');
  });

  it('tolerates single T3 timeouts and stays silent for good values', () => {
    const single = ev('router_log', T_END - HOUR, { title: 'No Ranging Response received - T3 time-out', source: 'router' });
    expect(docsisValues(withEvents(healthy, [single]))).toBeNull();
    expect(docsisValues(healthyInput({ docsis: snapshot([ch({})], 'good') }))).toBeNull();
    expect(docsisValues(healthy)).toBeNull();
  });

  it('reports a borderline snapshot as warning with low confidence', () => {
    const f = docsisValues(healthyInput({ docsis: snapshot([ch({ snrDb: 31, rating: 'warn', ratingNote: 'SNR 31,0 dB (Monatsfrist)' })], 'warn') }))!;
    expect(f.severity).toBe('warn');
    expect(f.confidence).toBe('low');
  });
});

describe('R10 peak-hours', () => {
  const day0 = new Date(2026, 9, 9).getTime();
  function days(n: number, f: (i: number) => { gw?: [number, number]; cmts: [number, number]; inet: [number, number]; v4?: [number, number]; v6?: [number, number]; p95?: number }) {
    const out: Record<string, DayPeriods[]> = { gw: [], isp6: [], '@internet': [], '@internet4': [], '@internet6': [] };
    for (let i = 0; i < n; i++) {
      const dayStart = day0 - (n - i) * DAY;
      const key = new Date(dayStart).toISOString().slice(0, 10);
      const d = f(i);
      const mk = (e: number, b: number, p95?: number) => dayPeriods(key, dayStart, { p50: e, p95: p95 ?? e * 1.3, sent: 7200 }, { p50: b, sent: 36_000 });
      out.gw.push(mk(d.gw?.[0] ?? 1, d.gw?.[1] ?? 1));
      out.isp6.push(mk(d.cmts[0], d.cmts[1]));
      out['@internet'].push(mk(d.inet[0], d.inet[1], d.p95));
      out['@internet4'].push(mk(d.v4?.[0] ?? d.inet[0], d.v4?.[1] ?? d.inet[1]));
      out['@internet6'].push(mk(d.v6?.[0] ?? d.inet[0], d.v6?.[1] ?? d.inet[1]));
    }
    return out;
  }

  it('applies the evening rise criteria', () => {
    const s = (p50: number, p95?: number, lost = 0): StatsSummary => stats({ p50, p95, lost });
    expect(eveningRise(s(35), s(18))).toBe(true); // + 17 ms
    expect(eveningRise(s(19), s(12))).toBe(true); // × 1,58 and + 7 ms
    expect(eveningRise(s(3), s(2))).toBe(false); // × 1,5 but only + 1 ms
    expect(eveningRise(s(20, 70), s(18, 30))).toBe(true); // p95 × 2,3 and + 40 ms
    expect(eveningRise(s(18, 23, 36), s(18))).toBe(true); // 1 % loss
    expect(eveningRise(s(20), s(18))).toBe(false);
  });

  it('detects evening congestion that starts at the CMTS', () => {
    const input = healthyInput({ daily: days(4, () => ({ cmts: [40, 12], inet: [50, 18] })) });
    expect(evaluatePeakDays(input).filter((d) => d.flagged)).toHaveLength(4);
    const f = peakHours(input)!;
    expect(f.segment).toBe('docsis');
    expect(f.title).toBe('Überlastung zu Stoßzeiten (Kabelsegment)');
    expect(f.severity).toBe('warn');
    expect(f.confidence).toBe('medium');
    expect(f.summary).toContain('An 4 von 4 gemessenen Abenden');
  });

  it('is critical with high evening p95 on many days', () => {
    const f = peakHours(healthyInput({ daily: days(6, () => ({ cmts: [40, 12], inet: [60, 18], p95: 140 })) }))!;
    expect(f.severity).toBe('critical');
    expect(f.confidence).toBe('high');
  });

  it('attributes an IPv4-only evening rise to the AFTR', () => {
    const f = peakHours(healthyInput({ daily: days(4, () => ({ cmts: [12, 12], inet: [40, 18], v4: [55, 18], v6: [18, 18] })) }))!;
    expect(f.segment).toBe('aftr');
  });

  it('needs a quiet router, ≥ 3 days and ≥ 40 % of the evenings', () => {
    expect(peakHours(healthyInput({ daily: days(4, () => ({ gw: [4, 1], cmts: [40, 12], inet: [50, 18] })) }))).toBeNull();
    expect(peakHours(healthyInput({ daily: days(8, (i) => ({ cmts: i < 2 ? [40, 12] : [12, 12], inet: i < 2 ? [50, 18] : [18, 18] })) }))).toBeNull();
    expect(peakHours(healthy)).toBeNull();
  });

  it('gives a preliminary hint after a single evening', () => {
    const f = peakHours(healthyInput({ daily: days(1, () => ({ cmts: [40, 12], inet: [50, 18] })) }))!;
    expect(f.severity).toBe('info');
    expect(f.confidence).toBe('low');
    expect(f.summary).toMatch(/^Vorläufig/);
  });
});

describe('R11 ipv4-vs-ipv6', () => {
  function windows(n: number, worseEvery: number | null, opts: { gwDirty?: boolean; pairs?: [string, string][] } = {}): Record<string, WindowStat[]> {
    const out: Record<string, WindowStat[]> = { gw: [] };
    const pairs = opts.pairs ?? [['cf4', 'cf6'], ['g4', 'g6']];
    const t0 = Math.floor((T_END - n * WINDOW_MS) / WINDOW_MS) * WINDOW_MS;
    for (const [a, b] of pairs) {
      out[a] = [];
      out[b] = [];
    }
    for (let i = 0; i < n; i++) {
      const ts = t0 + i * WINDOW_MS;
      out.gw.push({ ts, sent: 900, lost: 0, lossPct: opts.gwDirty ? 3 : 0, p50: 1, p95: 2 });
      const worse = worseEvery !== null && i % worseEvery === 0;
      for (const [a, b] of pairs) {
        out[a].push({ ts, sent: 900, lost: 0, lossPct: 0, p50: 18, p95: worse ? 75 : 30 });
        out[b].push({ ts, sent: 900, lost: 0, lossPct: 0, p50: 17, p95: 29 });
      }
    }
    return out;
  }

  it('blames DS-Lite when IPv4 is worse in ≥ 30 % of the windows for both providers', () => {
    const f = ipv4VsIpv6(healthyInput({ windows: windows(200, 2) }))!;
    expect(f.segment).toBe('aftr');
    expect(f.severity).toBe('warn');
    expect(f.confidence).toBe('medium');
    expect(f.title).toBe('Nur IPv4 betroffen: DS-Lite-Gateway (AFTR) überlastet');
    expect(f.summary).toContain('IPv4 zeigt in 50 % der 15-Minuten-Fenster 46 ms höhere Spitzen (p95)');
  });

  it('is confident with ≥ 3 days of windows and AFTR seconds', () => {
    const f = ipv4VsIpv6(healthyInput({ windows: windows(320, 1), seconds: secondsTotals({ aftr: 900, access: 100 }) }))!;
    expect(f.confidence).toBe('high');
    expect(f.severity).toBe('critical');
  });

  it('stays silent when only one provider shows it, the router is dirty or IPv4 = IPv6', () => {
    const w = windows(200, 2);
    w.g4 = w.g4.map((x) => ({ ...x, p95: 30 }));
    expect(ipv4VsIpv6(healthyInput({ windows: w }))).toBeNull();
    expect(ipv4VsIpv6(healthyInput({ windows: windows(200, 2, { gwDirty: true }) }))).toBeNull();
    expect(ipv4VsIpv6(healthyInput({ windows: windows(200, null) }))).toBeNull();
    expect(ipv4VsIpv6(healthy)).toBeNull();
  });

  it('gives a preliminary hint with less than 24 h', () => {
    const f = ipv4VsIpv6(healthyInput({ windows: windows(40, 2) }))!;
    expect(f.severity).toBe('info');
    expect(f.confidence).toBe('low');
  });
});

describe('R12 remote-only', () => {
  it('blames the way to the data centre when only a game target is bad', () => {
    const f = remoteOnly(healthyInput({ stats: { ...healthy.stats, 'aws-irl': stats({ p50: 41, lost: 260, sent: 25_920 }) } }))!;
    expect(f.segment).toBe('game');
    expect(f.summary).toContain('Nur AWS Irland (eu-west-1) ist betroffen');
    expect(f.confidence).toBe('medium');
  });

  it('uses REMOTE seconds', () => {
    const f = remoteOnly(healthyInput({ seconds: secondsTotals({ remote: 600, access: 100, unknown: 300 }) }))!;
    expect(f.summary).toMatch(/Rechenzentrum/);
  });

  it('stays silent when the internet references are bad too or nothing is wrong', () => {
    const input = healthyInput({
      stats: {
        ...healthy.stats,
        'aws-irl': stats({ p50: 41, lost: 520, sent: 25_920 }),
        cf4: stats({ p50: 18, lost: 2600, sent: 259_200 }),
        cf6: stats({ p50: 18, lost: 2600, sent: 259_200 }),
        g4: stats({ p50: 18, lost: 2600, sent: 259_200 }),
        g6: stats({ p50: 18, lost: 2600, sent: 259_200 }),
      },
    });
    expect(remoteOnly(input)).toBeNull();
    expect(remoteOnly(healthy)).toBeNull();
  });
});

describe('R17 top-cause', () => {
  it('names the class with the largest share of bad seconds', () => {
    const input = healthyInput({ seconds: secondsTotals({ link: 600, access: 300, unknown: 100 }) });
    const t = computeTopCause(input)!;
    expect(t.cls).toBe('link');
    expect(t.share).toBeCloseTo(0.6, 5);
    expect(t.confidence).toBe('high');
    const f = topCauseFinding(input)!;
    expect(f.title).toBe('Hauptursache: PC-Kabel/WLAN-Umschaltung');
    expect(f.segment).toBe('client');
    expect(f.severity).toBe('warn');
    expect(f.summary).toContain('60 % der gestörten Sekunden');
  });

  it('lowers the confidence for a low share, unclear seconds or short coverage', () => {
    expect(computeTopCause(healthyInput({ seconds: secondsTotals({ link: 400, access: 350, aftr: 250 }) }))!.confidence).toBe('medium');
    expect(computeTopCause(healthyInput({ seconds: secondsTotals({ access: 300, unknown: 500 }) }))!.confidence).toBe('low');
    const short = healthyInput({
      seconds: secondsTotals({ covered: 7200, access: 300 }),
      coverage: { ...healthy.coverage, coveredSeconds: 7200, daysCovered: 1 },
    });
    expect(computeTopCause(short)!.confidence).toBe('low');
    expect(topCauseFinding(short)!.title).toBe('Hauptursache (vorläufig): Kabelnetz (Zugang/CMTS)');
  });

  it('is only a hint (info) after a few minutes of measurement', () => {
    // live run: 4 ACCESS seconds out of 138 measured seconds must not become a critical root cause
    const input = healthyInput({
      seconds: secondsTotals({ covered: 138, access: 4, aftr: 1 }),
      coverage: { ...healthy.coverage, coveredSeconds: 138, coveragePct: 0.02, daysCovered: 0 },
    });
    const f = topCauseFinding(input)!;
    expect(f.severity).toBe('info');
    expect(f.confidence).toBe('low');
  });

  it('returns null without attributable bad seconds', () => {
    expect(computeTopCause(healthy)).toBeNull();
    expect(topCauseFinding(healthyInput({ seconds: null }))).toBeNull();
  });
});

describe('R18 speed-below-tariff', () => {
  const st = (down: number, link = 1000, p: Partial<SpeedtestResult> = {}): SpeedtestResult => ({
    id: 1, ts: T_END - DAY, endTs: T_END - DAY + 45_000, trigger: 'schedule', server: 'Cloudflare DUS', downMbps: down, upMbps: 40,
    idleLatencyMs: 18, idleJitterMs: 2, loadedDownLatencyMs: 30, loadedDownP95Ms: 40, loadedUpLatencyMs: 30, loadedUpP95Ms: 40,
    bloatDownMs: 12, bloatUpMs: 12, grade: 'A', bytesDown: 0, bytesUp: 0, streams: 6, nicLinkMbps: link, error: null, series: [], ...p,
  });
  const withTariff = (tests: SpeedtestResult[], down: number | null = 500, up: number | null = 50): DiagnosisInput => {
    const input = healthyInput({ speedtests: tests });
    input.config.tariff = { name: 'Cable 500', downMbps: down, upMbps: up };
    return input;
  };

  it('flags downloads below 50 % of the tariff', () => {
    const f = speedBelowTariff(withTariff([st(120), st(110), st(140)]))!;
    expect(f.title).toBe('Bandbreite unter Vertrag');
    expect(f.severity).toBe('critical'); // median < 30 % of the tariff
    expect(f.summary).toContain('Bei 3 von 3 Speedtests');
    expect(f.recommendations[0]).toMatch(/Breitbandmessung/);
  });

  it('ignores tests limited by a 100-Mbit/s link', () => {
    expect(limitedByLink(st(94, 100))).toBe(true);
    expect(speedBelowTariff(withTariff([st(94, 100), st(93, 100)]))).toBeNull();
  });

  it('stays silent without tariff or with sufficient speed', () => {
    expect(speedBelowTariff(withTariff([st(120)], null, null))).toBeNull();
    expect(speedBelowTariff(withTariff([st(480), st(470), st(200)]))).toBeNull();
    expect(speedBelowTariff(healthy)).toBeNull();
  });
});
