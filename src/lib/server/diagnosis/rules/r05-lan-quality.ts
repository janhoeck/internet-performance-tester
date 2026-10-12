// R05 lan-quality: gateway loss ≥ 0.5 % (per hour) or p99 ≥ 20 ms while the link is up and the PC
// itself is not loading the line (docs/research/critique.md H6/R05). Gateway-only latency without
// matching internet spikes is a router control-plane artefact → info only.
import type { Finding, FindingEvidence } from '../../../shared/types';
import { fmtSecondsCount, fmtShare, ms, pct } from '../text';
import type { DiagnosisInput } from '../types';
import { findingScore, gatewayTarget, segmentImpact, stableStatsOf, statsOf } from '../util';

export const LAN_QUALITY = 'lan-quality';

export function lanQuality(input: DiagnosisInput): Finding | null {
  const gw = gatewayTarget(input);
  if (!gw) return null;
  const s = stableStatsOf(input, gw.id);
  if (!s || s.sent < 600) return null;

  const hours = input.lanHours.filter((h) => h.sent >= 1800);
  const badHours = hours.filter((h) => (h.lossPct ?? 0) >= 0.5);
  const lossBad = (s.lossPct ?? 0) >= 0.5 && s.lost >= 5;
  const hoursBad = badHours.length >= Math.max(2, Math.ceil(hours.length * 0.1));
  const p99Bad = s.p99 !== null && s.p99 >= 20 && s.sent >= 3600;
  if (!lossBad && !hoursBad && !p99Bad) return null;

  const internet = input.statsStable['@internet'] ?? statsOf(input, '@internet');
  const controlPlaneOnly = !lossBad && !hoursBad && p99Bad && internet?.p99 != null && s.p99 !== null && internet.p99 < s.p99;

  const gw6 = input.targets.find((t) => t.enabled && t.host === '$router6');
  const s6 = gw6 ? stableStatsOf(input, gw6.id) : null;
  const corroborated = s6 !== null && s6.sent >= 600 && ((s6.lossPct ?? 0) >= 0.5 || (s6.p99 ?? 0) >= 20);

  const severity = controlPlaneOnly
    ? 'info'
    : (s.lossPct ?? 0) >= 2 || badHours.length >= Math.max(3, hours.length * 0.25)
      ? 'critical'
      : 'warn';
  const confidence = controlPlaneOnly ? 'low' : corroborated || s.sent >= 86_400 ? 'high' : 'medium';
  const ip = input.config.router.ip;

  const summary = controlPlaneOnly
    ? `Der Router (${ip}) antwortet gelegentlich verzögert (p99 ${ms(s.p99)}), die Internetziele zeigen diese Spitzen aber nicht. Das ist typisch für die niedrige Priorität von Ping-Antworten im Router selbst und für Spiele meist unkritisch.`
    : `Zum Router (${ip}) gingen ${pct(s.lossPct)} der Pakete verloren bzw. es gab Spitzen bis ${ms(s.p99)} (p99), obwohl das Kabel verbunden war und kaum eigener Verkehr lief.`;

  const evidence: FindingEvidence[] = [
    { label: 'Verlust zum Router (stehender Link)', value: `${pct(s.lossPct)} (${s.lost} von ${s.sent})` },
    { label: 'Router-Ping p50 / p99', value: `${ms(s.p50)} / ${ms(s.p99)}` },
  ];
  if (hours.length > 0) evidence.push({ label: 'Stunden mit ≥ 0,5 % Verlust', value: `${badHours.length} von ${hours.length}` });
  if (s6 && s6.sent > 0) evidence.push({ label: 'Router IPv6 (link-lokal) Verlust / p99', value: `${pct(s6.lossPct)} / ${ms(s6.p99)}` });
  if (internet?.p99 != null) evidence.push({ label: 'Internetziele p99 (zum Vergleich)', value: ms(internet.p99) });
  if (input.seconds && input.seconds.lan > 0) {
    evidence.push({ label: 'LAN-Sekunden', value: `${fmtSecondsCount(input.seconds.lan)} (${fmtShare(input.seconds.bad > 0 ? input.seconds.lan / input.seconds.bad : null)} der gestörten Sekunden)` });
  }
  for (const h of badHours.slice(-3).reverse()) evidence.push({ label: 'Stunde mit Verlust', value: pct(h.lossPct), ts: h.ts, tsEnd: h.ts + 3_600_000 });

  const primary = input.adapters?.adapters.find((a) => a.status.toLowerCase() === 'up' && !a.isVirtual && a.isWifi);
  const recommendations = controlPlaneOnly
    ? ['Kein Handlungsbedarf, solange die Internetziele unauffällig bleiben.']
    : [
        'Anderen LAN-Port und ein anderes Netzwerkkabel testen.',
        'Router neu starten; tritt das Problem danach wieder auf, bei Vodafone einen Gerätetausch anfragen.',
        'Prüfen, ob andere Geräte das Heimnetz stark belasten (z. B. große Uploads, Backups).',
      ];
  if (!controlPlaneOnly && primary) recommendations.push('Bei WLAN: näher an den Router, 5-GHz-Band und einen festen Kanal 36–48 verwenden.');

  return {
    id: LAN_QUALITY,
    severity,
    confidence,
    segment: 'lan',
    title: controlPlaneOnly ? 'Router antwortet verzögert (Control-Plane)' : 'Problem zwischen PC und Router',
    summary,
    evidence,
    recommendations,
    score: findingScore(severity, confidence, controlPlaneOnly ? 0 : segmentImpact(input, 'lan')),
  };
}
