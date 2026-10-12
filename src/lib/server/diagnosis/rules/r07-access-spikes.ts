// R07 access-spikes: ≥ 70 % of the internet-errored seconds (both families) coincide with errors of
// the CMTS hop in the same probe round (classifier class 'access'), router p99 < 10 ms, own load
// in < 20 % of the bad seconds (docs/research/critique.md H2/R07).
//
// Approximation: per-second co-occurrence is taken from seconds_1m: share = access /
// (access + aftr + backbone). 'unknown' seconds (e.g. v6-only errors or CMTS-only control-plane
// spikes) are reported but not counted.
import type { Finding, FindingEvidence } from '../../../shared/types';
import { fmtSecondsCount, fmtShare, ms, pct } from '../text';
import type { DiagnosisInput } from '../types';
import { cmtsTarget, coveredHours, findingScore, gatewayTarget, stableStatsOf, statsOf } from '../util';

export const ACCESS_SPIKES = 'access-spikes';

export const VODAFONE_REPORT_RECOMMENDATIONS: readonly string[] = [
  'Test „Ruhiges Heimnetz“ durchführen: alle anderen Geräte 15 Minuten offline nehmen. Bleiben die Spitzen, liegt es am Kabelnetz; verschwinden sie, das verursachende Gerät suchen (Uploads, Streaming, Updates).',
  'Bericht exportieren (Seite „Bericht“) und die Störung bei Vodafone melden – Uhrzeiten der Spitzen, Kopfstation-Werte und den Nachweis eines sauberen Heimnetzes beilegen.',
];

export function accessSpikes(input: DiagnosisInput): Finding | null {
  const s = input.seconds;
  if (!s || s.access < 30) return null;
  const wan = s.access + s.aftr + s.backbone;
  if (wan === 0) return null;
  const share = s.access / wan;
  const gw = gatewayTarget(input);
  const gwStats = stableStatsOf(input, gw?.id);
  const gwP99 = gwStats?.p99 ?? null;
  const selfLoadShare = s.bad > 0 ? s.selfLoad / s.bad : 0;
  if (share < 0.7 || (gwP99 !== null && gwP99 >= 10) || selfLoadShare >= 0.2) return null;

  const accessRate = s.covered > 0 ? s.access / s.covered : 0;
  if (accessRate < 0.001) return null; // < 0,1 % of the measured time: not a relevant problem
  const severity = accessRate >= 0.01 ? 'critical' : 'warn';
  const hours = coveredHours(input);
  const confidence = hours >= 6 && s.access >= 100 ? 'high' : hours >= 1 ? 'medium' : 'low';

  const cmts = cmtsTarget(input);
  const cmtsStats = statsOf(input, cmts?.id);
  const summary =
    `${fmtShare(share)} der gestörten Internet-Sekunden traten gleichzeitig an der Vodafone-Kopfstation (CMTS, erster Knoten hinter dem Router) auf, ` +
    `während die Verbindung zum Router sauber war${gwP99 !== null ? ` (p99 ${ms(gwP99)})` : ''} und dieser PC kaum Daten übertrug. ` +
    'IPv4 und IPv6 waren gleichermaßen betroffen – das spricht für eine Störung oder Überlastung im Kabelnetz.';

  const evidence: FindingEvidence[] = [
    { label: 'ACCESS-Sekunden (Kabelnetz)', value: `${fmtSecondsCount(s.access)} (${fmtShare(accessRate)} der Messzeit)` },
    { label: 'Anteil an den Internet-Störungen', value: fmtShare(share) },
    { label: 'Router-Ping p99', value: ms(gwP99) },
    { label: 'Sekunden mit Eigenlast', value: `${fmtShare(selfLoadShare)} der gestörten Sekunden` },
  ];
  if (cmtsStats) {
    evidence.push({ label: 'Kopfstation p50 / p99', value: `${ms(cmtsStats.p50)} / ${ms(cmtsStats.p99)}` });
    if (cmtsStats.over200 > 0) evidence.push({ label: 'Kopfstation: Pings über 200 ms', value: String(cmtsStats.over200) });
  }
  if (s.ses > 0) evidence.push({ label: 'Stark gestörte Sekunden (SES)', value: fmtSecondsCount(s.ses) });
  if (s.unknown > 0) evidence.push({ label: 'Nicht zuordenbare Sekunden', value: fmtSecondsCount(s.unknown) });
  const internet = statsOf(input, '@internet');
  if (internet) evidence.push({ label: 'Internetziele p50 / p99 / Verlust', value: `${ms(internet.p50)} / ${ms(internet.p99)} / ${pct(internet.lossPct)}` });

  return {
    id: ACCESS_SPIKES,
    severity,
    confidence,
    segment: 'docsis',
    title: 'Störung/Überlastung im Kabelnetz',
    summary,
    evidence,
    recommendations: [...VODAFONE_REPORT_RECOMMENDATIONS],
    score: findingScore(severity, confidence, s.bad > 0 ? s.access / s.bad : 0),
  };
}
