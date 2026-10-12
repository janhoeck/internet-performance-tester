import { describe, expect, it } from 'vitest';
import type { Finding } from '../../shared/types';
import { buildVerdict, causeCandidates, diagnose, evaluateRules, gamingScoreFor, selectPrimary } from './report';
import { T_END, drop, ev, healthyInput, hourlySeconds, secondsTotals, stats, withEvents } from './test-utils';
import { DAY, HOUR, MINUTE } from './time';
import type { DiagnosisInput, LinkDrop } from './types';

const healthy = healthyInput();

function finding(p: Partial<Finding>): Finding {
  return { id: 'x', severity: 'warn', confidence: 'high', segment: 'client', title: 'Titel', summary: 'Text.', evidence: [], recommendations: [], score: 50, ...p };
}

/** the situation of this PC: cable drops (cluster on 08.10.) + spikes in the cable network */
function twoProblems(): DiagnosisInput {
  const cluster = Array.from({ length: 8 }, (_, i) => drop(T_END - 18 * HOUR + i * 2 * MINUTE, 'runtime', { wlanFailover: true }));
  const drops = [...cluster, drop(T_END - 2 * DAY), drop(T_END - 50 * HOUR), drop(T_END - DAY - HOUR, 'boot', { relinkMbps: 100 })];
  const seconds = secondsTotals({ link: 1200, access: 2600, unknown: 1000, aftr: 50 });
  return healthyInput({ linkDrops: drops, seconds, secondsHourly: hourlySeconds(seconds) });
}

describe('verdict', () => {
  it('says the line is fine when nothing is found', () => {
    const r = diagnose(healthy);
    expect(r.verdict.severity).toBe('info');
    expect(r.verdict.title).toBe('Keine Auffälligkeiten – die Leitung ist unauffällig');
    expect(r.verdict.primarySegment).toBeNull();
    expect(r.verdict.text).toContain('Gaming-Score 100 (Note A)');
    expect(r.findings.every((f) => f.severity === 'info')).toBe(true);
  });

  it('says honestly that there is no data', () => {
    const empty = healthyInput({
      stats: {}, statsStable: {}, seconds: null, secondsHourly: [], secondsDaily: [],
      coverage: { ...healthy.coverage, coveredSeconds: 0, coveragePct: 0, hasSeconds: false, samples: 0, daysCovered: 0, firstTs: null, lastTs: null },
    });
    const r = diagnose(empty);
    expect(r.verdict.title).toBe('Noch keine Messdaten im Zeitraum');
    expect(r.gamingScore).toBeNull();
    expect(r.seconds).toBeNull();
    expect(r.findings.map((f) => f.id)).toContain('data-quality');
  });

  it('is provisional with thin data and never names data quality as the cause', () => {
    const thin = healthyInput({ coverage: { ...healthy.coverage, coveredSeconds: 5 * 3600, coveragePct: 7, daysCovered: 1 } });
    const r = diagnose(thin);
    expect(r.findings.find((f) => f.id === 'data-quality')?.severity).toBe('warn');
    expect(r.verdict.title).toBe('Bisher keine Auffälligkeiten (noch zu wenige Messdaten)');
    const withCause = diagnose({ ...thin, linkDrops: [drop(T_END - DAY), drop(T_END - 2 * DAY), drop(T_END - 3 * DAY)] });
    expect(withCause.verdict.title).toBe('Hauptursache (vorläufig): instabile Netzwerkverbindung am PC (Kabel/Port)');
    expect(withCause.verdict.text).toContain('das Ergebnis ist vorläufig');
  });

  it('names the PC cable as main cause and mentions the second problem (two-problem case)', () => {
    const r = diagnose(twoProblems());
    expect(r.verdict.title).toBe('Hauptursache: instabile Netzwerkverbindung am PC (Kabel/Port)');
    expect(r.verdict.severity).toBe('critical');
    expect(r.verdict.primarySegment).toBe('client');
    expect(r.verdict.text).toContain('Außerdem auffällig: Störung/Überlastung im Kabelnetz');
    expect(r.verdict.text).toContain('Die meisten gestörten Sekunden entfallen allerdings auf „Kabelnetz (Zugang/CMTS)“');
    const ids = r.findings.map((f) => f.id);
    expect(ids).toEqual(expect.arrayContaining(['nic-link-flaps', 'access-spikes', 'top-cause', 'wlan-failover']));
    // sorted by score
    for (let i = 1; i < r.findings.length; i++) expect(r.findings[i - 1].score).toBeGreaterThanOrEqual(r.findings[i].score);
    expect(r.seconds?.byClass).toEqual({ link: 1200, lan: 0, access: 2600, aftr: 50, backbone: 0, remote: 0, unknown: 1000 });
    expect(r.segments.find((s) => s.segment === 'client')?.status).toBe('bad');
    expect(r.segments.find((s) => s.segment === 'docsis')?.status).toBe('bad');
  });

  it('prefers the specific finding over the seconds summary (R17) of the same segment', () => {
    const primary = selectPrimary([
      finding({ id: 'top-cause', segment: 'docsis', score: 86 }),
      finding({ id: 'access-spikes', segment: 'docsis', score: 80 }),
      finding({ id: 'data-quality', severity: 'warn', score: 99 }),
      finding({ id: 'vpn-active', severity: 'info', score: 95 }),
    ]);
    expect(primary?.id).toBe('access-spikes');
    expect(causeCandidates([finding({ id: 'data-quality' }), finding({ id: 'a', severity: 'info' })])).toHaveLength(0);
  });

  it('uses the top-cause class label when R17 is the primary finding', () => {
    const input = healthyInput({ seconds: secondsTotals({ backbone: 2000 }) });
    const v = buildVerdict(input, evaluateRules(input).findings);
    expect(v.title).toBe('Hauptursache: Vodafone-Backbone/Internet');
    expect(v.primarySegment).toBe('isp');
  });
});

describe('rule evaluation', () => {
  it('isolates failing rules', () => {
    const broken = healthyInput({ linkDrops: null as unknown as LinkDrop[] });
    const { errors } = evaluateRules(broken);
    expect(errors).toContain('R01');
    expect(errors).not.toContain('R07');
  });
});

describe('gaming score', () => {
  it('uses the IPv4 internet references, internet-wide loss and outages per hour', () => {
    const input = withEvents(
      healthyInput({
        stats: {
          ...healthy.stats,
          '@internet4': stats({ p50: 25, jitter: 12, p99: 145, sent: 518_400 }),
          cf4: stats({ p50: 25, sent: 259_200, lost: 2074 }),
          g4: stats({ p50: 25, sent: 259_200, lost: 2100 }),
        },
        coverage: { ...healthy.coverage, coveredSeconds: 10 * 3600 },
      }),
      [ev('outage', T_END - HOUR), ev('outage', T_END - 2 * HOUR), ev('outage', T_END - 3 * HOUR), ev('outage', T_END - 4 * HOUR), ev('outage', T_END - 5 * HOUR)],
    );
    const s = gamingScoreFor(input)!;
    // methodology example: p50 25, MASD 12, tail 120, loss 0.8 %, 0.5 outages/h → 34 (F)
    expect(s.score).toBe(34);
    expect(s.grade).toBe('F');
    expect(s.limiting).toBe('tail');
  });

  it('returns null without internet samples or with less than 15 min per target', () => {
    expect(gamingScoreFor(healthyInput({ stats: {} }))).toBeNull();
    const few = { ...healthy.stats, '@internet4': stats({ p50: 21, sent: 182, minutes: 6 }), '@internet': stats({ p50: 21, sent: 364, minutes: 12 }) };
    expect(gamingScoreFor(healthyInput({ stats: few }))).toBeNull();
  });
});

describe('report', () => {
  it('fills the data-quality block with German notes', () => {
    const r = diagnose(healthy);
    expect(r.dataQuality.coveragePct).toBe(90);
    expect(r.dataQuality.notes[0]).toMatch(/^Gemessen: /);
    expect(r.dataQuality.notes).toContain('DOCSIS-Werte nicht verfügbar (Router-Login nicht eingerichtet).');
    expect(r.generatedAt).toBe(T_END);
    expect(r.from).toBe(healthy.from);
  });
});
