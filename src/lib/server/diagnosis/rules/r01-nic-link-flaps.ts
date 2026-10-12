// R01 nic-link-flaps: ≥ 3 genuine (runtime) link drops in 7 days or ≥ 3 within 30 min.
// Critical at ≥ 5 per day or ≥ 5 within 30 min (docs/research/critique.md §5.3 R01).
import { fmtDateTime } from '../../../shared/format';
import type { Finding, FindingEvidence } from '../../../shared/types';
import { isFaultDrop } from '../links';
import { fmtCount, fmtLinkSpeed, fmtSecondsCount, fmtSecondsRange, fmtShare } from '../text';
import { DAY, MINUTE, maxInWindow, maxPerLocalDay } from '../time';
import type { DiagnosisInput } from '../types';
import { findingScore, segmentImpact } from '../util';

export const NIC_LINK_FLAPS = 'nic-link-flaps';

export const LINK_RECOMMENDATIONS: readonly string[] = [
  'Netzwerkkabel direkt zwischen PC und Vodafone Station gegen ein neues Cat-6-Kabel tauschen (ohne Wanddose, Kupplung oder Switch). Stecker müssen hörbar einrasten; Kabel nicht knicken oder einklemmen.',
  'Einen anderen LAN-Port am Router verwenden und notieren, welcher Port genutzt wird.',
  'Zwischengeräte (Switch, Powerline, alte EasyBox, Wanddose) testweise überbrücken.',
  'Erst danach den Treiber aktualisieren (Intel „Network Adapter Driver for Windows 11“, NetAdapter-Treiber e2fn 2.1.x) – so bleibt die Ursache eindeutig.',
  'Immer nur eine Änderung zur Zeit vornehmen und als Notiz festhalten – die App vergleicht automatisch vorher/nachher.',
];

export function nicLinkFlaps(input: DiagnosisInput): Finding | null {
  const weekStart = input.to - 7 * DAY;
  const windowStart = Math.min(input.from, weekStart);
  const faults = input.linkDrops.filter((d) => isFaultDrop(d) && d.ts >= windowStart && d.ts < input.to);
  if (faults.length < 3) return null;

  const ts = faults.map((d) => d.ts).sort((a, b) => a - b);
  const week = maxInWindow(ts, 7 * DAY);
  const cluster = maxInWindow(ts, 30 * MINUTE);
  if (week.count < 3 && cluster.count < 3) return null;

  const last7 = faults.filter((d) => d.ts >= weekStart);
  const inRange = faults.filter((d) => d.ts >= input.from);
  const perDay = maxPerLocalDay(ts);
  const severity = perDay.count >= 5 || cluster.count >= 5 ? 'critical' : 'warn';
  const classified = faults.filter((d) => d.cause === 'runtime').length;
  const confidence = classified >= Math.max(3, faults.length * 0.8) ? 'high' : 'medium';

  const durations = faults.map((d) => d.downtimeMs).filter((v): v is number => v !== null);
  const last = faults[faults.length - 1];
  const boot = input.linkDrops.filter((d) => d.cause === 'boot' && d.ts >= windowStart && d.ts < input.to).length;
  const reboot = input.linkDrops.filter((d) => d.cause === 'router_reboot' && d.ts >= windowStart && d.ts < input.to).length;

  const longRange = input.to - input.from > 8 * DAY;
  const countText = longRange
    ? `im gewählten Zeitraum ${inRange.length}-mal (davon ${last7.length}-mal in den letzten 7 Tagen)`
    : `in den letzten 7 Tagen ${last7.length}-mal`;
  const detailParts: string[] = [];
  if (durations.length > 0) detailParts.push(`je ${fmtSecondsRange(durations)}`);
  detailParts.push(`zuletzt am ${fmtDateTime(last.ts)}`);
  const summary =
    `Die Netzwerkkarte hat ${countText} die Verbindung zum Router verloren (${detailParts.join(', ')}). ` +
    'Abbrüche nach Standby/Neustart sind herausgerechnet. Jeder Abbruch trennt laufende Spielverbindungen.';

  const evidence: FindingEvidence[] = [
    { label: 'Echte Abbrüche (letzte 7 Tage)', value: String(last7.length) },
  ];
  if (longRange) evidence.push({ label: 'Echte Abbrüche im Zeitraum', value: String(inRange.length) });
  if (cluster.count >= 2 && cluster.startTs !== null && cluster.endTs !== null) {
    evidence.push({
      label: 'Größte Häufung',
      value: `${fmtCount(cluster.count, 'Abbruch', 'Abbrüche')} innerhalb von 30 min`,
      ts: cluster.startTs,
      tsEnd: cluster.endTs,
    });
  }
  if (perDay.count >= 2 && perDay.day) evidence.push({ label: 'Meiste Abbrüche an einem Tag', value: `${perDay.count} (${perDay.day.split('-').reverse().join('.')})` });
  if (durations.length > 0) evidence.push({ label: 'Ausfalldauer je Abbruch', value: fmtSecondsRange(durations) });
  evidence.push({ label: 'Letzter Abbruch', value: fmtDateTime(last.ts), ts: last.ts, tsEnd: last.endTs ?? undefined });
  if (boot > 0) evidence.push({ label: 'Neuverbindungen nach Start/Standby (normal, herausgerechnet)', value: String(boot) });
  if (reboot > 0) evidence.push({ label: 'Abbrüche durch vermuteten Router-Neustart (herausgerechnet)', value: String(reboot) });
  const unknown = faults.length - classified;
  if (unknown > 0) evidence.push({ label: 'Davon nicht eindeutig eingeordnet', value: String(unknown) });
  if (input.seconds && input.seconds.link > 0) {
    evidence.push({
      label: 'LINK-Sekunden (Verbindung am PC gestört)',
      value: `${fmtSecondsCount(input.seconds.link)} (${fmtShare(input.seconds.bad > 0 ? input.seconds.link / input.seconds.bad : null)} der gestörten Sekunden)`,
    });
  }
  for (const d of faults.slice(-5).reverse()) {
    const parts = [d.downtimeMs !== null ? `${Math.round(d.downtimeMs / 1000)} s` : 'Dauer unbekannt'];
    if (d.relinkMbps !== null) parts.push(`danach ${fmtLinkSpeed(d.relinkMbps)}`);
    if (d.wlanFailover) parts.push('WLAN-Umschaltung');
    evidence.push({ label: 'Abbruch', value: parts.join(', '), ts: d.ts, tsEnd: d.endTs ?? undefined });
  }

  const impact = segmentImpact(input, 'client');
  return {
    id: NIC_LINK_FLAPS,
    severity,
    confidence,
    segment: 'client',
    title: 'Netzwerkverbindung am PC bricht ab',
    summary,
    evidence,
    recommendations: [...LINK_RECOMMENDATIONS],
    score: findingScore(severity, confidence, impact, Math.min(10, faults.length)),
    relatedEventIds: faults.map((d) => d.id).filter((id): id is number => id !== null).slice(-50),
  };
}
