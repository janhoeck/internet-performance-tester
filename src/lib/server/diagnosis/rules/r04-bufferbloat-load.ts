// R04 bufferbloat-load: latency under load (speed tests) p95 ≥ 50 ms above idle or grade ≤ C in
// at least half of the tests. LAN variant when the router ping rises too (100 Mbit/s link).
import { fmtDateTime } from '../../../shared/format';
import type { Finding, FindingEvidence, SpeedtestResult } from '../../../shared/types';
import { fmtLinkSpeed, ms } from '../text';
import type { DiagnosisInput } from '../types';
import { cmtsTarget, findingScore, gatewayTarget, stableStatsOf } from '../util';

export const BUFFERBLOAT_LOAD = 'bufferbloat-load';

interface TestEval {
  s: SpeedtestResult;
  down: number | null;
  up: number | null;
  worst: number | null;
  bad: boolean;
  severe: boolean;
}

const maxN = (a: number | null, b: number | null) => (a === null ? b : b === null ? a : Math.max(a, b));

export function evaluateSpeedtest(s: SpeedtestResult): TestEval {
  const idle = s.idleLatencyMs;
  const down = idle !== null && s.loadedDownP95Ms !== null ? s.loadedDownP95Ms - idle : s.bloatDownMs;
  const up = idle !== null && s.loadedUpP95Ms !== null ? s.loadedUpP95Ms - idle : s.bloatUpMs;
  const worst = maxN(down, up);
  const gradeBad = s.grade === 'C' || s.grade === 'D' || s.grade === 'F';
  const severe = s.grade === 'D' || s.grade === 'F' || (worst !== null && worst >= 200);
  return { s, down, up, worst, bad: gradeBad || (worst !== null && worst >= 50), severe };
}

function fmtDelta(v: number | null): string {
  return v === null ? '–' : `${v >= 0 ? '+' : '−'}${ms(Math.abs(v))}`;
}

export function bufferbloatLoad(input: DiagnosisInput): Finding | null {
  const tests = input.speedtests.filter(
    (s) => s.error === null && (s.loadedDownP95Ms !== null || s.loadedUpP95Ms !== null || s.grade !== null || s.bloatDownMs !== null),
  );
  if (tests.length === 0) return null;
  const evals = tests.map(evaluateSpeedtest);
  const bad = evals.filter((e) => e.bad);
  if (bad.length === 0 || bad.length / evals.length < 0.5) return null;

  const severeShare = evals.filter((e) => e.severe).length / evals.length;
  const severity = severeShare >= 0.5 ? 'critical' : 'warn';
  const confidence = tests.length >= 3 ? 'high' : tests.length === 2 ? 'medium' : 'low';

  const gw = gatewayTarget(input);
  const gwLoad = gw ? input.loadStats[gw.id] : undefined;
  const gwIdle = stableStatsOf(input, gw?.id);
  const gwRise = gwLoad && gwLoad.sent > 0 && gwLoad.p95 !== null && gwIdle?.p95 != null ? gwLoad.p95 - gwIdle.p95 : null;
  const slowLink = bad.find((e) => e.s.nicLinkMbps !== null && e.s.nicLinkMbps < 1000)?.s.nicLinkMbps ?? null;
  const lanVariant = (gwRise !== null && gwRise >= 20) || slowLink !== null;

  const cmts = cmtsTarget(input);
  const cmtsLoad = cmts ? input.loadStats[cmts.id] : undefined;
  const cmtsIdle = stableStatsOf(input, cmts?.id);
  const cmtsRise = cmtsLoad && cmtsLoad.sent > 0 && cmtsLoad.p95 !== null && cmtsIdle?.p95 != null ? cmtsLoad.p95 - cmtsIdle.p95 : null;
  const upDominant = bad.filter((e) => (e.up ?? 0) > (e.down ?? 0)).length > bad.length / 2;

  const latest = bad[bad.length - 1];
  const parts = [
    `Bei ${bad.length} von ${evals.length} Speedtests stieg die Latenz unter Last deutlich an (zuletzt p95 ${fmtDelta(latest.worst)}${latest.s.grade ? `, Note ${latest.s.grade}` : ''}).`,
    'Läuft gleichzeitig ein Download oder Upload, entstehen Lags – die Warteschlange im Router/Modem läuft voll.',
  ];
  if (lanVariant) {
    const link = slowLink ?? input.linkSpeed.currentMbps;
    parts.push(`Die Spitzen treten schon zum Router auf – der ${link !== null && link < 1000 ? `${fmtLinkSpeed(link)}-` : ''}Link zwischen PC und Router ist der Engpass.`);
  } else if (upDominant && cmtsRise !== null && cmtsRise >= 20) {
    parts.push('Beim Upload steigt schon die Latenz zur Kopfstation – der Sendepuffer des Kabelmodems läuft voll.');
  }

  const evidence: FindingEvidence[] = bad.slice(-3).reverse().map((e) => ({
    label: `Speedtest ${fmtDateTime(e.s.ts)}`,
    value: `${e.s.grade ? `Note ${e.s.grade}, ` : ''}Download ${fmtDelta(e.down)}, Upload ${fmtDelta(e.up)} (p95 unter Last ggü. Leerlauf)`,
    ts: e.s.ts,
    tsEnd: e.s.endTs,
  }));
  if (gwRise !== null && gwLoad && gwIdle) evidence.push({ label: 'Router-Ping unter Last (p95)', value: `${ms(gwLoad.p95)} statt ${ms(gwIdle.p95)}` });
  if (cmtsRise !== null && cmtsLoad && cmtsIdle) evidence.push({ label: 'Kopfstation unter Last (p95)', value: `${ms(cmtsLoad.p95)} statt ${ms(cmtsIdle.p95)}` });
  if (slowLink !== null) evidence.push({ label: 'Link-Geschwindigkeit beim Test', value: fmtLinkSpeed(slowLink) });

  const recommendations = [
    'Downloads/Updates (Steam, Launcher, Windows Update) beim Spielen pausieren oder auf ca. 70 % der Leitungsgeschwindigkeit begrenzen.',
    'Falls vorhanden, eine Bandbreitenbegrenzung bzw. QoS für andere Geräte im Heimnetz nutzen.',
  ];
  if (lanVariant) recommendations.push('Link wieder auf 1 Gbit/s bringen (Kabel/Port, siehe „Kabel/Port schafft kein Gigabit“).');

  const impact = input.seconds && input.seconds.bad > 0 ? Math.min(1, input.seconds.selfLoad / input.seconds.bad) : 0;
  return {
    id: BUFFERBLOAT_LOAD,
    severity,
    confidence,
    segment: lanVariant ? 'lan' : 'router',
    title: 'Lags unter Last (Bufferbloat)',
    summary: parts.join(' '),
    evidence,
    recommendations,
    score: findingScore(severity, confidence, impact),
  };
}
