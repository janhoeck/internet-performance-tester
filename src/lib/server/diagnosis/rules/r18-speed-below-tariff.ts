// R18 speed-below-tariff: download (or upload) below 50 % of the booked tariff in at least half of
// the speed tests that were NOT limited by the PC's own link (100 Mbit/s link → see R02). The legal
// proof is the BNetzA "Breitbandmessung" – only valid over a 1-Gbit/s LAN link (environment.md §3.3).
import { fmtDateTime, fmtMbps } from '../../../shared/format';
import type { Finding, FindingEvidence, SpeedtestResult } from '../../../shared/types';
import { fmtShare, fmtLinkSpeed } from '../text';
import type { DiagnosisInput } from '../types';
import { findingScore, median } from '../util';

export const SPEED_BELOW_TARIFF = 'speed-below-tariff';

/** the test reached ≥ 85 % of a sub-gigabit link → limited by the PC's link, not the line */
export function limitedByLink(s: SpeedtestResult): boolean {
  return s.nicLinkMbps !== null && s.nicLinkMbps > 0 && s.downMbps !== null && s.downMbps >= 0.85 * s.nicLinkMbps;
}

export function speedBelowTariff(input: DiagnosisInput): Finding | null {
  const tariffDown = input.config.tariff.downMbps;
  const tariffUp = input.config.tariff.upMbps;
  if (tariffDown === null && tariffUp === null) return null;
  const valid = input.speedtests.filter((s) => s.error === null && (s.downMbps !== null || s.upMbps !== null));
  const limited = valid.filter(limitedByLink);
  const usable = valid.filter((s) => !limitedByLink(s));
  if (usable.length === 0) return null;

  const downs = usable.map((s) => s.downMbps).filter((v): v is number => v !== null);
  const ups = usable.map((s) => s.upMbps).filter((v): v is number => v !== null);
  const lowDown = tariffDown !== null ? usable.filter((s) => s.downMbps !== null && s.downMbps < 0.5 * tariffDown) : [];
  const lowUp = tariffUp !== null ? usable.filter((s) => s.upMbps !== null && s.upMbps < 0.5 * tariffUp) : [];
  const downBad = tariffDown !== null && downs.length > 0 && lowDown.length / downs.length >= 0.5;
  const upBad = tariffUp !== null && ups.length > 0 && lowUp.length / ups.length >= 0.5;
  if (!downBad && !upBad) return null;

  const medDown = median(downs);
  const medUp = median(ups);
  const severeDown = downBad && tariffDown !== null && medDown !== null && medDown < 0.3 * tariffDown;
  const severity = usable.length >= 3 && severeDown ? 'critical' : 'warn';
  const confidence = usable.length >= 5 ? 'high' : usable.length >= 2 ? 'medium' : 'low';

  const parts: string[] = [];
  if (downBad && tariffDown !== null) {
    parts.push(`Bei ${lowDown.length} von ${downs.length} Speedtests lag der Download unter 50 % des Tarifs (${fmtMbps(tariffDown)}); Median ${fmtMbps(medDown)} (${fmtShare(medDown !== null ? medDown / tariffDown : null)}).`);
  }
  if (upBad && tariffUp !== null) {
    parts.push(`Der Upload lag bei ${lowUp.length} von ${ups.length} Tests unter 50 % des Tarifs (${fmtMbps(tariffUp)}); Median ${fmtMbps(medUp)}.`);
  }
  parts.push('Nur Tests ohne Begrenzung durch die Netzwerkkarte des PCs wurden gewertet.');

  const evidence: FindingEvidence[] = usable.slice(-5).reverse().map((s) => ({
    label: `Speedtest ${fmtDateTime(s.ts)}`,
    value: `↓ ${fmtMbps(s.downMbps)} / ↑ ${fmtMbps(s.upMbps)}${s.server ? ` (${s.server})` : ''}`,
    ts: s.ts,
    tsEnd: s.endTs,
  }));
  if (tariffDown !== null || tariffUp !== null) evidence.push({ label: 'Tarif', value: `↓ ${fmtMbps(tariffDown)} / ↑ ${fmtMbps(tariffUp)}` });
  if (limited.length > 0) evidence.push({ label: 'Nicht gewertet (durch den PC-Link begrenzt)', value: `${limited.length} Test(s), Link ${fmtLinkSpeed(limited[0].nicLinkMbps)}` });

  const linkOk = (input.linkSpeed.currentMbps ?? 0) >= 1000;
  return {
    id: SPEED_BELOW_TARIFF,
    severity,
    confidence,
    segment: 'docsis',
    title: 'Bandbreite unter Vertrag',
    summary: parts.join(' '),
    evidence,
    recommendations: [
      linkOk
        ? 'Rechtssicherer Nachweis: Breitbandmessung der Bundesnetzagentur (Desktop-App, per LAN, 30 Messungen an 3 Tagen innerhalb von 14 Tagen).'
        : 'Breitbandmessung der Bundesnetzagentur erst durchführen, wenn die Netzwerkverbindung wieder mit 1 Gbit/s läuft – sonst ist die Messung ungültig.',
      'Minderleistung bei Vodafone melden und die Messprotokolle beilegen.',
    ],
    score: findingScore(severity, confidence),
  };
}
