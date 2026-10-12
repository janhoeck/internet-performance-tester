import { describe, expect, it } from 'vitest';
import type { Finding } from '../../shared/types';
import { buildSegments, rateSecondsShare, worstHealth } from './segments';
import { T_END, drop, healthyInput, secondsTotals, stats } from './test-utils';
import { DAY } from './time';

const healthy = healthyInput();

function finding(p: Partial<Finding>): Finding {
  return { id: 'x', severity: 'warn', confidence: 'high', segment: 'client', title: 'Titel', summary: '', evidence: [], recommendations: [], score: 50, ...p };
}

describe('segment health', () => {
  it('returns all eight segments in path order with German labels', () => {
    const segs = buildSegments(healthy, []);
    expect(segs.map((s) => s.segment)).toEqual(['client', 'lan', 'router', 'docsis', 'aftr', 'isp', 'internet', 'game']);
    expect(segs[0].label).toBe('PC & Adapter');
    expect(segs[3].label).toBe('Kabelnetz (DOCSIS)');
  });

  it('rates a healthy line as good', () => {
    const segs = buildSegments(healthy, []);
    for (const s of segs) expect(s.status, s.segment).toBe('good');
    const internet = segs.find((s) => s.segment === 'internet')!;
    expect(internet.kpis.find((k) => k.label === 'Latenz p50')).toEqual({ label: 'Latenz p50', value: '18 ms', status: 'good' });
    expect(internet.summary).toBe('Verbindung ins Internet unauffällig.');
    const docsis = segs.find((s) => s.segment === 'docsis')!;
    expect(docsis.kpis.find((k) => k.label === 'DOCSIS-Werte')?.value).toBe('nicht verfügbar (Router-Login nötig)');
  });

  it('uses the configured bands and the findings of each segment', () => {
    const input = healthyInput({
      linkDrops: [drop(T_END - DAY), drop(T_END - 2 * DAY), drop(T_END - 3 * DAY)],
      linkSpeed: { currentMbps: 100, currentTs: T_END, msBelow1g: DAY, msObserved: 3 * DAY, minMbps: 100 },
      stats: { ...healthy.stats, '@internet': stats({ p50: 95, p99: 300, jitter: 20, sent: 1_036_800 }) },
    });
    const segs = buildSegments(input, [finding({ id: 'nic-link-flaps', severity: 'critical', title: 'Netzwerkverbindung am PC bricht ab' })]);
    const client = segs.find((s) => s.segment === 'client')!;
    expect(client.status).toBe('bad');
    expect(client.summary).toBe('Netzwerkverbindung am PC bricht ab');
    expect(client.kpis.find((k) => k.label === 'Link-Geschwindigkeit')).toMatchObject({ value: '100 Mbit/s', status: 'warn' });
    expect(client.kpis.find((k) => k.label === 'Echte Link-Abbrüche (7 Tage)')).toMatchObject({ value: '3', status: 'bad' });
    const internet = segs.find((s) => s.segment === 'internet')!;
    expect(internet.status).toBe('bad');
    expect(internet.kpis.find((k) => k.label === 'Latenz p50')?.status).toBe('bad'); // > 80 ms
    expect(internet.kpis.find((k) => k.label === 'Jitter')?.status).toBe('bad'); // > 15 ms
  });

  it('shows the seconds share per class', () => {
    const segs = buildSegments(healthyInput({ seconds: secondsTotals({ access: 3000 }) }), []);
    const docsis = segs.find((s) => s.segment === 'docsis')!;
    expect(docsis.kpis.find((k) => k.label.startsWith('ACCESS-Sekunden'))?.status).toBe('bad');
    expect(docsis.status).toBe('bad');
  });

  it('shows values from a few minutes of data without rating them', () => {
    const input = healthyInput({
      stats: { ...healthy.stats, '@internet': stats({ p50: 22, p99: 122, jitter: 16, sent: 364, minutes: 6 }) },
      seconds: secondsTotals({ covered: 138, access: 4 }),
    });
    const segs = buildSegments(input, []);
    const internet = segs.find((s) => s.segment === 'internet')!;
    expect(internet.kpis.find((k) => k.label === 'Spitzen (p99 − p50)')).toEqual({ label: 'Spitzen (p99 − p50)', value: '100 ms', status: undefined });
    const docsis = segs.find((s) => s.segment === 'docsis')!;
    expect(docsis.kpis.find((k) => k.label.startsWith('ACCESS-Sekunden'))?.status).toBeUndefined();
  });

  it('needs 15 min per member target for group KPIs and says so when nothing can be rated', () => {
    // 4 internet targets × 11 min = 44 group minutes → still below 4 × 15
    const few = (p50: number) => stats({ p50, p99: p50 + 100, jitter: 16, sent: 660, minutes: 11 });
    const input = healthyInput({
      stats: { cf4: few(22), cf6: few(19), g4: few(20), g6: few(21), '@internet': stats({ p50: 21, p99: 130, jitter: 15, sent: 2640, minutes: 44 }) },
      statsStable: {},
      seconds: secondsTotals({ covered: 600, access: 30 }),
      coverage: { ...healthy.coverage, coveredSeconds: 660, coveragePct: 0.1 },
    });
    const internet = buildSegments(input, []).find((s) => s.segment === 'internet')!;
    expect(internet.kpis.find((k) => k.label === 'Jitter')?.status).toBeUndefined();
    expect(internet.status).toBe('unknown');
    expect(internet.summary).toBe('Noch zu wenige Messdaten für eine Bewertung.');
  });

  it('reports unknown without data', () => {
    const empty = healthyInput({ stats: {}, statsStable: {}, seconds: null, linkSpeed: { currentMbps: null, currentTs: null, msBelow1g: 0, msObserved: 0, minMbps: null } });
    const segs = buildSegments(empty, []);
    expect(segs.find((s) => s.segment === 'lan')!.status).toBe('unknown');
    expect(segs.find((s) => s.segment === 'lan')!.summary).toBe('Keine Messdaten für diesen Abschnitt.');
  });

  it('combines health values', () => {
    expect(worstHealth(['good', undefined, 'warn'])).toBe('warn');
    expect(worstHealth(['unknown', 'good'])).toBe('good');
    expect(worstHealth([])).toBe('unknown');
    expect(rateSecondsShare(10, 100_000)).toBe('good');
    expect(rateSecondsShare(100, 100_000)).toBe('warn');
    expect(rateSecondsShare(1000, 100_000)).toBe('bad');
    expect(rateSecondsShare(1, 0)).toBe('unknown');
  });
});
