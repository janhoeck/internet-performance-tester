import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ExportKind } from '../shared/api-types';
import type { DiagnosisReport } from '../shared/types';
import { getConfig } from './config-store';
import { getDb } from './db';
import { type DiagnoseFn, type ExportFormat, exportFileName, exportResponse, flagsText, statusText } from './export';
import { TEST_END, TEST_FROM, type SeededDb, seedTempDb } from './test-seed';

let seeded: SeededDb;
const from = TEST_FROM;
const to = TEST_END;
const NOW = new Date(2026, 9, 9, 8, 5, 0).getTime();
const MAC = /[0-9a-f]{2}([:-])(?:[0-9a-f]{2}\1){4}[0-9a-f]{2}/i;

const fakeReport = (f: number, t: number): DiagnosisReport => ({
  from: f,
  to: t,
  generatedAt: NOW,
  verdict: { severity: 'warn', title: 'Hauptursache: instabile Netzwerkverbindung am PC', text: 'Test', primarySegment: 'client' },
  findings: [],
  segments: [],
  seconds: null,
  gamingScore: null,
  dataQuality: { samples: 1, coveragePct: 97, gaps: 1, notes: [] },
});
const diagnose: DiagnoseFn = async (f, t) => fakeReport(f, t);

beforeAll(() => {
  seeded = seedTempDb();
});
afterAll(() => seeded.cleanup());

async function run(kind: ExportKind, format: ExportFormat, extra: { targets?: string[]; keys?: string[]; diagnose?: DiagnoseFn } = {}) {
  const res = await exportResponse({ kind, format, from, to, targets: extra.targets, keys: extra.keys }, getConfig(), extra.diagnose ?? diagnose, NOW);
  // Response.text() would strip the BOM – decode the raw bytes as a browser download keeps them
  return { res, text: new TextDecoder('utf-8', { ignoreBOM: true }).decode(await res.arrayBuffer()) };
}

const lines = (csv: string) => csv.split('\r\n').filter((l) => l !== '');
const count = (sql: string, ...p: (string | number)[]) => Number((getDb().prepare(sql).get(...p) as { n: number }).n);

describe('export helpers', () => {
  it('names files and translates codes', () => {
    expect(exportFileName('report', 'json', NOW)).toBe('netzdiagnose-bericht-20261009-0805.json');
    expect(exportFileName('samples', 'csv', NOW)).toBe('netzdiagnose-samples-20261009-0805.csv');
    expect(statusText(1)).toBe('Zeitüberschreitung');
    expect(statusText(9)).toBe('9');
    expect(flagsText(3)).toBe('Last (Speedtest), WLAN-Ausweichen');
    expect(flagsText(0)).toBe('');
  });
});

describe('table exports', () => {
  it('samples as CSV for German Excel (BOM, ;, decimal comma, attachment)', async () => {
    const { res, text } = await run('samples', 'csv', { targets: ['gw', 'aws-irl'] });
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="netzdiagnose-samples-20261009-0805.csv"');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(text.charCodeAt(0)).toBe(0xfeff);
    const rows = lines(text.slice(1));
    expect(rows[0]).toBe('Zeit;Zeitstempel (ms);Ziel;RTT (ms);Status;Kennzeichen');
    const expected = count("SELECT COUNT(*) AS n FROM samples WHERE target_id IN ('gw', 'aws-irl') AND ts >= ? AND ts < ?", from, to);
    expect(rows.length - 1).toBe(expected);
    expect(rows[1]).toMatch(/^2026-10-08 20:00:00;\d+;gw;[\d,]+;OK;$/);
    expect(text).toContain('WLAN-Ausweichen');
    expect(text).toMatch(/;aws-irl;\d+,\d+;OK;/); // TCP RTTs carry decimals
  });

  it('samples as streamed JSON', async () => {
    const { res, text } = await run('samples', 'json', { targets: ['aws-fra'] });
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    const body = JSON.parse(text) as { kind: string; from: number; items: { targetId: string; ts: number; rtt: number | null; flags: number }[] };
    expect(body).toMatchObject({ kind: 'samples', from, to, generatedAt: NOW });
    expect(body.items.length).toBe(count("SELECT COUNT(*) AS n FROM samples WHERE target_id = 'aws-fra'"));
    expect(body.items[0]).toMatchObject({ targetId: 'aws-fra' });
  });

  it('rollups and metrics', async () => {
    const r = await run('rollups', 'csv', { targets: ['cf4'] });
    const rows = lines(r.text.slice(1));
    expect(rows[0].split(';')).toHaveLength(15);
    expect(rows.length - 1).toBe(count("SELECT COUNT(*) AS n FROM rollup_1m WHERE target_id = 'cf4'"));
    const rj = JSON.parse((await run('rollups', 'json', { targets: ['cf4'] })).text) as { items: { hist: string }[] };
    expect(typeof rj.items[0].hist).toBe('string');
    const m = await run('metrics', 'csv', { keys: ['nic.link_mbps', 'router.http_ms'] });
    expect(m.text).toContain(';nic.link_mbps;Link-Geschwindigkeit;');
    expect(m.text).toContain(';Mbit/s');
    const all = JSON.parse((await run('metrics', 'json')).text) as { items: { key: string }[] };
    expect(new Set(all.items.map((i) => i.key))).toContain('udp.burst.cf4-udp.loss_pct');
  });

  it('events with redacted MAC addresses (router log CM-MAC/CMTS-MAC)', async () => {
    const raw = count("SELECT COUNT(*) AS n FROM events WHERE details LIKE '%CM-MAC=a4:bb%'");
    expect(raw).toBeGreaterThan(0);
    const csv = await run('events', 'csv');
    expect(csv.text).not.toMatch(MAC);
    expect(csv.text).toContain('CM-MAC=xx:xx:xx:xx:xx:xx');
    expect(lines(csv.text.slice(1))[0]).toBe('ID;Beginn;Ende;Dauer (s);Typ;Schweregrad;Abschnitt;Quelle;Titel;Details');
    const json = JSON.parse((await run('events', 'json')).text) as { items: { ts: number; type: string }[] };
    expect(json.items.length).toBe(count('SELECT COUNT(*) AS n FROM events WHERE ts >= ? AND ts < ?', from, to));
    expect(JSON.stringify(json)).not.toMatch(MAC);
    for (let i = 1; i < json.items.length; i++) expect(json.items[i].ts).toBeGreaterThanOrEqual(json.items[i - 1].ts);
  });

  it('speed tests and traceroutes', async () => {
    const st = await run('speedtests', 'csv');
    expect(lines(st.text.slice(1))).toHaveLength(7);
    expect(st.text).toContain(';manuell;Cloudflare FRA;');
    const sj = JSON.parse((await run('speedtests', 'json')).text) as { items: { series: unknown[] }[] };
    expect(sj.items).toHaveLength(6);
    expect(sj.items[0].series.length).toBe(161);
    const tr = await run('traceroutes', 'csv');
    expect(tr.text).toContain(';IPv4;');
    expect(tr.text).toContain(';*;'); // silent AFTR hop
  });
});

describe('report bundle', () => {
  it('bundles diagnosis, stats, link history, router data – all MAC-free', async () => {
    const { res, text } = await run('report', 'csv'); // format is ignored: always JSON
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="netzdiagnose-bericht-20261009-0805.json"');
    const r = JSON.parse(text) as Record<string, unknown> & {
      diagnosis: DiagnosisReport | null;
      stats: { targetId: string }[];
      outages: unknown[];
      link: { summary: { runtimeDrops24h: number } };
      router: { status: { attachedDevices: { mac: string }[] } };
      timeProfile: Record<string, unknown[]>;
    };
    expect(r.app).toBe('Netzdiagnose');
    expect(r.generatedAt).toBe(NOW);
    expect(r.diagnosis?.verdict.title).toContain('Hauptursache');
    expect(r.diagnosisError).toBeNull();
    expect(r.stats.map((s) => s.targetId)).toContain('isp6');
    expect(r.outages).toHaveLength(2);
    expect(r.link.summary.runtimeDrops24h).toBe(4);
    expect(r.router.status.attachedDevices[0].mac).toBe('xx:xx:xx:xx:xx:xx');
    expect(Object.keys(r.timeProfile)).toEqual(['gw', 'isp6', 'aftr', 'cf4', 'cf6', 'g4', 'g6']);
    expect(text).not.toMatch(MAC);
  });

  it('still delivers the report when the diagnosis fails', async () => {
    const { text } = await run('report', 'json', {
      diagnose: () => {
        throw new Error('Regel kaputt');
      },
    });
    const r = JSON.parse(text) as { diagnosis: unknown; diagnosisError: string };
    expect(r.diagnosis).toBeNull();
    expect(r.diagnosisError).toBe('Diagnose fehlgeschlagen: Regel kaputt');
  });
});
