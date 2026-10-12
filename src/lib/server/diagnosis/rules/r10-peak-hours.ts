// R10 peak-hours: in the evening (19–23 h) the CMTS hop or the internet targets are clearly worse
// than in the baseline hours (03–17 h) of the same day – p50 ≥ base + 15 ms or × 1.5, p95 ≥ 2 × base
// and + 20 ms, or loss > 0.5 % – while the router stays < 3 ms, on ≥ 3 days (≥ 3 of 7 evaluated
// evenings). Uses the "stable" minutes (no link drops, no own downloads).
// Sources: MESSPLAN R10, environment.md §3.1, critique.md R10, docsis-thresholds.md §12/§14.4.
import { fmtDay } from '../../../shared/format';
import type { Finding, FindingEvidence, Segment } from '../../../shared/types';
import { aggregateSecondsHours } from '../seconds';
import { ms, pct } from '../text';
import { HOUR, EVENING_HOURS } from '../time';
import type { DayPeriods, DiagnosisInput, StatsSummary } from '../types';
import { cmtsTarget, findingScore, gatewayTarget, median, segmentTargets } from '../util';

export const PEAK_HOURS = 'peak-hours';

const EVENING_MIN_MINUTES = 30;
const BASE_MIN_MINUTES = 60;
/** router p50 in the evening must stay below this (otherwise it is a LAN problem) */
const GW_MAX_P50 = 3;

/** evening clearly worse than the baseline of the same day */
export function eveningRise(e: StatsSummary, b: StatsSummary): boolean {
  if (e.sent === 0 || b.sent === 0) return false;
  if (e.p50 !== null && b.p50 !== null) {
    if (e.p50 - b.p50 >= 15) return true;
    if (b.p50 > 0 && e.p50 >= 1.5 * b.p50 && e.p50 - b.p50 >= 5) return true;
  }
  if (e.p95 !== null && b.p95 !== null && e.p95 >= 2 * b.p95 && e.p95 - b.p95 >= 20) return true;
  const el = e.lossPct ?? 0;
  const bl = b.lossPct ?? 0;
  return el > 0.5 && el >= 2 * bl;
}

export interface PeakDay {
  day: string;
  dayStart: number;
  flagged: boolean;
  cmts: boolean;
  internet: boolean;
  v4: boolean;
  v6: boolean;
  /** internet reference of that day (display values) */
  evening: StatsSummary | null;
  base: StatsSummary | null;
  gwEveningP50: number | null;
}

function byDay(list: readonly DayPeriods[] | undefined): Map<string, DayPeriods> {
  return new Map((list ?? []).map((d) => [d.day, d]));
}

function rose(m: Map<string, DayPeriods>, day: string): boolean {
  const d = m.get(day);
  return d ? eveningRise(d.evening, d.base) : false;
}

/** evaluates every day with enough evening and baseline coverage */
export function evaluatePeakDays(input: DiagnosisInput): PeakDay[] {
  const gw = gatewayTarget(input);
  const cmts = cmtsTarget(input);
  const firstInternet = segmentTargets(input, 'internet', 'icmp')[0];
  const coverageId = [gw?.id, cmts?.id, firstInternet?.id].find((id) => id !== undefined && (input.daily[id]?.length ?? 0) > 0);
  if (!coverageId) return [];
  const coverage = input.daily[coverageId] ?? [];
  const gwDays = byDay(gw ? input.daily[gw.id] : undefined);
  const cmtsDays = byDay(cmts ? input.daily[cmts.id] : undefined);
  const inet = byDay(input.daily['@internet']);
  const v4 = byDay(input.daily['@internet4']);
  const v6 = byDay(input.daily['@internet6']);

  const out: PeakDay[] = [];
  for (const c of coverage) {
    if (c.evening.minutes < EVENING_MIN_MINUTES || c.base.minutes < BASE_MIN_MINUTES) continue;
    const g = gwDays.get(c.day);
    const gwEveningP50 = g && g.evening.sent > 0 ? g.evening.p50 : null;
    const gwOk = gwEveningP50 === null || gwEveningP50 < GW_MAX_P50;
    const flags = {
      cmts: rose(cmtsDays, c.day),
      internet: rose(inet, c.day),
      v4: rose(v4, c.day),
      v6: rose(v6, c.day),
    };
    const ref = inet.get(c.day);
    out.push({
      day: c.day,
      dayStart: c.dayStart,
      flagged: gwOk && (flags.cmts || flags.internet),
      ...flags,
      evening: ref?.evening ?? null,
      base: ref?.base ?? null,
      gwEveningP50,
    });
  }
  return out;
}

function medianOf(values: (number | null | undefined)[]): number | null {
  return median(values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v)));
}

export function peakHours(input: DiagnosisInput): Finding | null {
  const days = evaluatePeakDays(input);
  const flagged = days.filter((d) => d.flagged);
  if (flagged.length === 0) return null;
  const confirmed = flagged.length >= 3 && flagged.length >= 0.4 * days.length;
  const preliminary = !confirmed && days.length < 3 && flagged.length === days.length;
  if (!confirmed && !preliminary) return null;

  const cmtsDays = flagged.filter((d) => d.cmts).length;
  const v4Only = flagged.filter((d) => d.v4 && !d.v6 && !d.cmts).length;
  const segment: Segment = cmtsDays >= flagged.length / 2 ? 'docsis' : v4Only > flagged.length / 2 ? 'aftr' : 'isp';

  const eP50 = medianOf(flagged.map((d) => d.evening?.p50));
  const bP50 = medianOf(flagged.map((d) => d.base?.p50));
  const eP95 = medianOf(flagged.map((d) => d.evening?.p95));
  const bP95 = medianOf(flagged.map((d) => d.base?.p95));
  const eLoss = medianOf(flagged.map((d) => d.evening?.lossPct));

  const severity = preliminary ? 'info' : (eP95 !== null && eP95 >= 100) || (eLoss !== null && eLoss >= 1) ? 'critical' : 'warn';
  const confidence = preliminary ? 'low' : flagged.length >= 5 && flagged.length >= 0.6 * days.length ? 'high' : 'medium';

  const where =
    segment === 'docsis'
      ? 'Der Anstieg beginnt schon an der Vodafone-Kopfstation (erster Knoten hinter dem Router), Router und Heimnetz bleiben unauffällig – typisch für ein überlastetes Kabelsegment.'
      : segment === 'aftr'
        ? 'Betroffen ist vor allem IPv4 – also der Weg über das DS-Lite-Gateway (AFTR) von Vodafone.'
        : 'Die Kopfstation bleibt stabil; der Anstieg entsteht dahinter im Vodafone-Netz bzw. an den Übergängen ins Internet.';
  const lossText = eLoss !== null && eLoss > 0 ? `, Paketverlust ${pct(eLoss)}` : '';
  const summary =
    `${preliminary ? 'Vorläufig: ' : ''}An ${flagged.length} von ${days.length} gemessenen Abenden war die Verbindung zwischen 19 und 23 Uhr deutlich schlechter als tagsüber ` +
    `(Latenz p50 ${ms(eP50)} statt ${ms(bP50)}, p95 ${ms(eP95)} statt ${ms(bP95)}${lossText}). ${where}`;

  const evidence: FindingEvidence[] = [{ label: 'Abende mit deutlichem Anstieg', value: `${flagged.length} von ${days.length}` }];
  const cm = cmtsTarget(input);
  const cmPeriods = cm ? input.periods[cm.id] : undefined;
  if (cmPeriods && cmPeriods.evening.sent > 0 && cmPeriods.base.sent > 0) {
    evidence.push({ label: 'Kopfstation p50 abends / tagsüber', value: `${ms(cmPeriods.evening.p50)} / ${ms(cmPeriods.base.p50)}` });
  }
  const inetPeriods = input.periods['@internet'];
  if (inetPeriods && inetPeriods.evening.sent > 0 && inetPeriods.base.sent > 0) {
    evidence.push({ label: 'Internetziele p95 abends / tagsüber', value: `${ms(inetPeriods.evening.p95)} / ${ms(inetPeriods.base.p95)}` });
  }
  const gwP50 = medianOf(flagged.map((d) => d.gwEveningP50));
  if (gwP50 !== null) evidence.push({ label: 'Router-Ping p50 abends', value: ms(gwP50) });
  const sh = aggregateSecondsHours(input.secondsHourly, EVENING_HOURS.from, EVENING_HOURS.to);
  if (sh.covered > 0 && sh.otherCovered > 0) {
    evidence.push({
      label: 'Gestörte Sekunden abends / sonst',
      value: `${pct((sh.bad / sh.covered) * 100)} / ${pct((sh.otherBad / sh.otherCovered) * 100)}`,
    });
  }
  for (const d of flagged.slice(-5).reverse()) {
    const e = d.evening;
    evidence.push({
      label: `Abend ${fmtDay(d.dayStart)}`,
      value: e ? `p50 ${ms(e.p50)} (tagsüber ${ms(d.base?.p50)}), p95 ${ms(e.p95)}, Verlust ${pct(e.lossPct)}` : 'Anstieg an der Kopfstation',
      ts: d.dayStart + EVENING_HOURS.from * HOUR,
      tsEnd: d.dayStart + EVENING_HOURS.to * HOUR,
    });
  }
  if (input.docsis?.rating === 'bad' || input.docsis?.rating === 'warn') {
    evidence.push({ label: 'Hinweis', value: 'Die DOCSIS-Werte sind zusätzlich auffällig – eine Leitungsstörung ist ebenfalls möglich.' });
  }

  const recommendations = [
    'Messreihe mindestens 7 Tage inklusive der Abende laufen lassen (Standby verhindern), dann den Bericht exportieren.',
    segment === 'aftr'
      ? 'Störung bei Vodafone melden und die IPv4/IPv6-Auswertung beilegen (DS-Lite-Gateway zu Stoßzeiten überlastet).'
      : 'Störung bei Vodafone melden und eine Prüfung der Segment-/Node-Auslastung anfragen – Uhrzeiten und Bericht beilegen.',
    'Für eine Geschwindigkeitsminderung zusätzlich die Breitbandmessung der Bundesnetzagentur nutzen (nur per LAN mit 1-Gbit/s-Link).',
  ];

  const impact = sh.bad + sh.otherBad > 0 ? sh.bad / (sh.bad + sh.otherBad) : 0;
  return {
    id: PEAK_HOURS,
    severity,
    confidence,
    segment,
    title: segment === 'docsis' ? 'Überlastung zu Stoßzeiten (Kabelsegment)' : 'Abends deutlich schlechter (Stoßzeiten)',
    summary,
    evidence,
    recommendations,
    score: findingScore(severity, confidence, impact),
  };
}
