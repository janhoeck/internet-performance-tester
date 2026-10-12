import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TEST_END, TEST_FROM, type SeededDb, seedTempDb } from '../../../../src/lib/server/test-seed';
import type { TestSession } from '../../../../src/lib/shared/types';
import { renderAnlage } from './anlage';
import { niceMax, renderGrafik, tickCount } from './charts';
import { type AuswertungData, collectData, median, parseLocalDate, resolveZeitraum } from './data';
import { buildFacts } from './digest';
import { insertGrafiken, markPlaceholders, stripComments, wrapDocument } from './render';
import { esc, mdTable, share } from './text';

const NOW = new Date(2026, 9, 10, 12, 0, 0).getTime();
const H = 3_600_000;

function session(id: number, startedAt: number, endedAt: number | null, status: TestSession['status'], label: string | null = null): TestSession {
  return { id, startedAt, endedAt, plannedEndAt: null, label, status, note: null };
}

describe('resolveZeitraum', () => {
  const sessions = [session(3, NOW - 5 * H, null, 'running', 'LAN-Kabel'), session(2, NOW - 30 * H, NOW - 10 * H, 'completed'), session(1, NOW - 40 * H, NOW - 39.9 * H, 'completed')];

  it('auto picks the running session and ends it now', () => {
    const z = resolveZeitraum({ kind: 'auto' }, sessions, NOW);
    expect(z).toMatchObject({ from: NOW - 5 * H, to: NOW, laeuftNoch: true, quelle: 'Langzeittest „LAN-Kabel“ (#3)' });
  });

  it('auto falls back to the newest session of at least 30 min, then to 24 h', () => {
    expect(resolveZeitraum({ kind: 'auto' }, sessions.slice(1), NOW)).toMatchObject({ from: NOW - 30 * H, to: NOW - 10 * H, laeuftNoch: false });
    expect(resolveZeitraum({ kind: 'auto' }, sessions.slice(2), NOW)).toMatchObject({ from: NOW - 24 * H, to: NOW, session: null });
  });

  it('rejects unknown sessions and empty ranges with German messages', () => {
    expect(() => resolveZeitraum({ kind: 'session', id: 9 }, sessions, NOW)).toThrow(/#9 gibt es nicht/);
    expect(() => resolveZeitraum({ kind: 'range', from: NOW, to: NOW - 1 }, sessions, NOW)).toThrow(/Ungültiger Zeitraum/);
  });

  it('clamps a free range to now', () => {
    expect(resolveZeitraum({ kind: 'range', from: NOW - H, to: NOW + H }, [], NOW)).toMatchObject({ to: NOW, laeuftNoch: true });
  });
});

describe('small helpers', () => {
  it('parses German and ISO dates as local time', () => {
    expect(parseLocalDate('2026-10-10 18:30')).toBe(new Date(2026, 9, 10, 18, 30).getTime());
    expect(parseLocalDate('10.10.2026, 18:30')).toBe(new Date(2026, 9, 10, 18, 30).getTime());
    expect(parseLocalDate('10.10.2026')).toBe(new Date(2026, 9, 10).getTime());
    expect(() => parseLocalDate('gestern')).toThrow(/nicht erkannt/);
  });

  it('median ignores null values', () => {
    expect(median([3, null, 1, 2])).toBe(2);
    expect(median([4, 1])).toBe(2.5);
    expect(median([null])).toBeNull();
  });

  it('chart axes use round steps', () => {
    expect(niceMax(37)).toBe(50);
    expect(niceMax(120)).toBe(200);
    expect(tickCount(50)).toBe(5);
    expect(tickCount(200)).toBe(4);
  });

  it('formats shares and escapes markup', () => {
    expect(share(1, 4)).toBe('25 %');
    expect(share(1, 0)).toBe('–');
    expect(esc('<b>"x" & y</b>')).toBe('&lt;b&gt;&quot;x&quot; &amp; y&lt;/b&gt;');
    expect(mdTable(['a'], [['x|y']])).toContain('| x/y |');
  });

  it('placeholders are highlighted and listed; template comments are dropped', () => {
    const r = markPlaceholders('<p>Kundennummer [[Kundennummer]]</p>');
    expect(r.fields).toEqual(['Kundennummer']);
    expect(r.html).toContain('<span class="fill">Kundennummer</span>');
    expect(stripComments('<!-- Hinweis [[x]] --><p>a</p><!--GRAFIK:verlauf-->')).toBe('<p>a</p><!--GRAFIK:verlauf-->');
  });
});

describe('collect → fact sheet → documents (seeded demo database)', () => {
  let seeded: SeededDb;
  let data: AuswertungData;

  beforeAll(async () => {
    seeded = seedTempDb();
    data = await collectData({ range: { kind: 'range', from: TEST_FROM, to: TEST_END }, now: TEST_END + 60_000 });
  });
  afterAll(() => seeded.cleanup());

  it('collects the report bundle, hourly seconds and key figures', () => {
    expect(data.zeitraum).toMatchObject({ from: TEST_FROM, to: TEST_END });
    expect(data.bundle.diagnosis).not.toBeNull();
    expect(data.stunden.length).toBeGreaterThanOrEqual(3);
    expect(data.kennzahlen.seconds.covered).toBeGreaterThan(0);
    expect(data.kennzahlen.stats.map((s) => s.targetId)).toContain('gw');
    expect(JSON.parse(JSON.stringify(data))).toEqual(data);
  });

  it('builds a complete German fact sheet', () => {
    const md = buildFacts(data);
    for (const heading of ['# Netzpuls – Fakten zur Auswertung', '## 1. Diagnose der App', '## 2. Gestörte Sekunden nach Abschnitt', '## 5. Messziele', '## 10. Router']) {
      expect(md).toContain(heading);
    }
    expect(md).toContain('VORLÄUFIG');
    expect(md).not.toMatch(/undefined|NaN|\[object Object\]/);
  });

  it('renders the measurement record and every chart', () => {
    const html = renderAnlage(data);
    expect(html).toContain('Messprotokoll Internetanschluss');
    expect(html).toContain('<svg');
    expect(html).not.toMatch(/undefined|NaN|\[object Object\]/);
    for (const name of ['stundenprofil', 'verlauf', 'verlauf-anschluss', 'abschnitte', 'abschnitte-anschluss']) {
      expect(renderGrafik(name, data)).toMatch(/^<svg /);
    }
    expect(renderGrafik('gibtsnicht', data)).toBeNull();
  });

  it('wraps a fragment into a printable document with charts inserted', () => {
    const unknown: string[] = [];
    const body = insertGrafiken('<h1>Test</h1><!--GRAFIK:abschnitte--><!-- GRAFIK:falsch -->', data, unknown);
    expect(unknown).toEqual(['falsch']);
    const doc = wrapDocument('Auswertung', body, data, 'body{}');
    expect(doc).toMatch(/^<!doctype html>/);
    expect(doc).toContain('<html lang="de">');
    expect(doc).toContain('<svg');
  });
});
