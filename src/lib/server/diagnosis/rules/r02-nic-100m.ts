// R02 nic-100m: ≥ 20 % of the recent relinks below 1 Gbit/s (≥ 5 cases), > 10 min at 100 Mbit/s
// in range, or the router reports the PC with "100 Mbps". High (critical) when the tariff is
// above 100 Mbit/s (docs/research/critique.md §5.3 R02).
import { fmtDuration, fmtMbps } from '../../../shared/format';
import type { Finding, FindingEvidence } from '../../../shared/types';
import { relinkStats } from '../links';
import { fmtLinkSpeed, fmtShare } from '../text';
import { DAY, MINUTE, localDayKey } from '../time';
import type { DiagnosisInput } from '../types';
import { findingScore } from '../util';

export const NIC_100M = 'nic-100m';

/** router-side port speed of this PC, e.g. '100 Mbps' (null when unknown or ≥ 1 Gbit/s) */
export function routerReportedSlowPort(input: DiagnosisInput): string | null {
  const devices = input.router?.attachedDevices ?? [];
  const pc = devices.find((d) => d.isThisPc && d.kind === 'lan');
  if (!pc || !pc.speed) return null;
  const m = /(\d+(?:[.,]\d+)?)\s*(g|m)/i.exec(pc.speed);
  if (!m) return null;
  const value = Number(m[1].replace(',', '.')) * (m[2].toLowerCase() === 'g' ? 1000 : 1);
  return value > 0 && value < 1000 ? pc.speed : null;
}

/** speed tests whose download hit ≥ 85 % of a sub-gigabit link */
export function linkLimitedSpeedtests(input: DiagnosisInput): number {
  return input.speedtests.filter(
    (s) => s.error === null && s.nicLinkMbps !== null && s.nicLinkMbps < 1000 && s.downMbps !== null && s.downMbps >= 0.85 * s.nicLinkMbps,
  ).length;
}

export function nic100m(input: DiagnosisInput): Finding | null {
  const windowStart = Math.min(input.from, input.to - 30 * DAY);
  const drops = input.linkDrops.filter((d) => d.ts >= windowStart && d.ts < input.to);
  const rs = relinkStats(drops);
  const share = rs.total > 0 ? rs.below1g / rs.total : 0;
  const fixed = rs.fixedRun >= 10;
  const byRelinks = rs.total >= 5 && share >= 0.2 && !fixed;
  const ls = input.linkSpeed;
  const currentSlow = ls.currentMbps !== null && ls.currentMbps > 0 && ls.currentMbps < 1000;
  const byDuration = ls.msBelow1g > 10 * MINUTE;
  const routerSlow = routerReportedSlowPort(input);
  if (!byRelinks && !byDuration && !routerSlow) return null;

  const tariff = input.config.tariff.downMbps;
  const tariffAbove = tariff !== null && tariff > 100;
  const severity = tariffAbove && (byDuration || currentSlow || routerSlow !== null) ? 'critical' : 'warn';
  const confidence = (byRelinks && rs.total >= 10) || (byRelinks && routerSlow) ? 'high' : byRelinks || routerSlow ? 'medium' : 'low';

  const sentences: string[] = [];
  if (byRelinks) {
    sentences.push(`${rs.below1g} der letzten ${rs.total} Verbindungsaufbauten endeten unter 1 Gbit/s (meist 100 Mbit/s statt Gigabit).`);
  }
  if (byDuration) sentences.push(`Im Zeitraum lief die Verbindung insgesamt ${fmtDuration(ls.msBelow1g)} mit weniger als 1 Gbit/s.`);
  if (routerSlow) sentences.push(`Auch der Router meldet den PC mit „${routerSlow}“.`);
  sentences.push('Gigabit benötigt alle vier Adernpaare des Kabels, 100 Mbit/s nur zwei – typisch für ein beschädigtes Kabel, einen schlechten Stecker oder Port.');
  if (tariffAbove) sentences.push(`Dein Tarif (${fmtMbps(tariff)}) wird dadurch ausgebremst.`);

  const evidence: FindingEvidence[] = [];
  if (rs.total > 0) evidence.push({ label: 'Verbindungsaufbauten unter 1 Gbit/s', value: `${rs.below1g} von ${rs.total} (${fmtShare(share)})` });
  if (rs.fixedRun > 0) evidence.push({ label: 'Zuletzt in Folge mit 1 Gbit/s', value: String(rs.fixedRun) });
  if (ls.currentMbps !== null) evidence.push({ label: 'Aktuelle Link-Geschwindigkeit', value: fmtLinkSpeed(ls.currentMbps), ts: ls.currentTs ?? undefined });
  if (ls.msBelow1g > 0) evidence.push({ label: 'Zeit unter 1 Gbit/s (Zeitraum)', value: fmtDuration(ls.msBelow1g) });
  if (routerSlow) evidence.push({ label: 'Port-Geschwindigkeit laut Router', value: routerSlow });
  const limited = linkLimitedSpeedtests(input);
  if (limited > 0) evidence.push({ label: 'Speedtests durch den Link begrenzt', value: String(limited) });
  const firstDay = localDayKey(windowStart);
  const hist = input.linkDays.filter((d) => d.day >= firstDay);
  const up100 = hist.reduce((s, d) => s + d.up100m, 0);
  const up1g = hist.reduce((s, d) => s + d.up1g, 0);
  if (up100 + up1g > 0) evidence.push({ label: 'Link-Aufbauten laut Ereignisprotokoll (30 Tage)', value: `${up1g}× 1 Gbit/s, ${up100}× 100 Mbit/s` });
  if (tariff !== null) evidence.push({ label: 'Tarif (Download)', value: fmtMbps(tariff) });

  const recommendations = [
    'Netzwerkkabel tauschen (neues Cat-6-Kabel direkt PC ↔ Vodafone Station) und einen anderen LAN-Port am Router testen.',
    'Gegenprobe: Gerätemanager → Intel I225-V → Erweitert → „Speed & Duplex“ kurz auf „1.0 Gbps Full Duplex“ stellen. Kommt die Verbindung dann nicht oder nur instabil zustande, schafft Kabel oder Port kein Gigabit. Danach wieder auf „Auto Negotiation“ zurückstellen.',
    'Bis zur Behebung große Downloads während des Spielens pausieren.',
  ];
  if (tariffAbove) recommendations.push('Geschwindigkeitsmessungen (z. B. Breitbandmessung der Bundesnetzagentur) erst mit 1-Gbit/s-Link durchführen.');

  return {
    id: NIC_100M,
    severity,
    confidence,
    segment: 'client',
    title: 'Kabel/Port schafft kein Gigabit',
    summary: sentences.join(' '),
    evidence,
    recommendations,
    score: findingScore(severity, confidence, 0, byRelinks ? Math.round(share * 10) : 0),
    relatedEventIds: drops.filter((d) => d.relinkMbps !== null && d.relinkMbps < 1000).map((d) => d.id).filter((id): id is number => id !== null).slice(-50),
  };
}
