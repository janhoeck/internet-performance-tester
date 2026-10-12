// R16 data-quality: little data (< 24 h measured), coverage < 70 %, long gaps (standby/PC off),
// no per-second classification or hardly any evening coverage → "Länger messen, Standby
// deaktivieren". Never a root cause – the verdict treats it separately (critique.md R16).
import { fmtDateTime, fmtDuration } from '../../../shared/format';
import type { Finding, FindingEvidence } from '../../../shared/types';
import { aggregateSecondsHours } from '../seconds';
import { fmtCoverage, pct } from '../text';
import { DAY, EVENING_HOURS, HOUR } from '../time';
import type { DiagnosisInput } from '../types';
import { coveredHours, findingScore } from '../util';

export const DATA_QUALITY = 'data-quality';

export interface DataQualityIssues {
  fewData: boolean;
  lowCoverage: boolean;
  longGap: boolean;
  noSeconds: boolean;
  noEvenings: boolean;
  noData: boolean;
}

export function dataQualityIssues(input: DiagnosisInput): DataQualityIssues {
  const cov = input.coverage;
  const hours = coveredHours(input);
  const evening = aggregateSecondsHours(input.secondsHourly, EVENING_HOURS.from, EVENING_HOURS.to);
  return {
    noData: cov.coveredSeconds <= 0 && cov.samples <= 0,
    fewData: hours < 24,
    lowCoverage: cov.coveragePct < 70,
    longGap: cov.gaps.longestMs >= HOUR,
    noSeconds: !cov.hasSeconds && cov.samples > 0,
    noEvenings: cov.hasSeconds && input.secondsHourly.length === 24 && cov.rangeMs >= DAY && evening.covered < 4 * 3600,
  };
}

/** extra hints (no trigger on their own): missing DOCSIS access, missing tariff */
export function setupHints(input: DiagnosisInput): string[] {
  const out: string[] = [];
  if (!input.docsis) {
    out.push('Für DOCSIS-Werte (Kabelleitung) das Router-Passwort in den Einstellungen hinterlegen und den Router-Login erlauben.');
  }
  if (input.config.tariff.downMbps === null) {
    out.push('Tarif (Download/Upload) in den Einstellungen eintragen – nötig für die Bewertung der Speedtests und der Eigenlast.');
  }
  return out;
}

export function dataQuality(input: DiagnosisInput): Finding | null {
  const q = dataQualityIssues(input);
  if (!q.noData && !q.fewData && !q.lowCoverage && !q.longGap && !q.noSeconds && !q.noEvenings) return null;
  const cov = input.coverage;
  const hours = coveredHours(input);
  const measured = fmtCoverage(cov.coveredSeconds);

  let title: string;
  if (q.noData) title = 'Keine Messdaten im Zeitraum';
  else if (q.fewData) title = 'Zu wenige Messdaten für eine sichere Aussage';
  else if (q.lowCoverage) title = `Messung lückenhaft – nur ${pct(cov.coveragePct, 0)} des Zeitraums gemessen`;
  else if (q.longGap) title = `Messlücke ${fmtDuration(cov.gaps.longestMs)} (Standby, PC aus oder kein Test) – kein Netzproblem`;
  else if (q.noSeconds) title = 'Keine sekundengenaue Auswertung vorhanden';
  else title = 'Abende kaum gemessen';

  const sentences: string[] = [];
  if (q.noData) sentences.push('Im gewählten Zeitraum wurde nicht gemessen. Starte einen Langzeittest, damit die Diagnose Daten hat.');
  else {
    sentences.push(`Gemessen wurden ${measured} von ${fmtDuration(cov.rangeMs)} (${pct(cov.coveragePct, 0)}).`);
    if (q.fewData) sentences.push('Für eine sichere Aussage sind mindestens 24 h nötig, besser 72 h inklusive zweier Abende.');
    if (q.longGap) {
      sentences.push(`${cov.gaps.count === 1 ? 'Eine Messlücke' : `${cov.gaps.count} Messlücken`} (längste ${fmtDuration(cov.gaps.longestMs)}) – Standby, ausgeschalteter PC oder kein laufender Test, kein Netzproblem.`);
    }
    if (q.noSeconds) sentences.push('Es liegt keine Sekunden-Klassifizierung vor; die Diagnose beruht nur auf Minutenwerten und Ereignissen.');
    if (q.noEvenings) sentences.push('Die Abendstunden (19–23 Uhr), in denen Kabelnetze am stärksten ausgelastet sind, wurden kaum gemessen.');
  }

  const evidence: FindingEvidence[] = [
    { label: 'Messabdeckung', value: `${measured} (${pct(cov.coveragePct, 0)})` },
    { label: 'Tage mit mindestens 1 h Messung', value: String(cov.daysCovered) },
  ];
  if (cov.gaps.count > 0) evidence.push({ label: 'Messlücken (gesamt / längste)', value: `${cov.gaps.count} (${fmtDuration(cov.gaps.totalMs)} / ${fmtDuration(cov.gaps.longestMs)})` });
  if (cov.firstTs !== null && cov.lastTs !== null) {
    evidence.push({ label: 'Erste / letzte Messung', value: `${fmtDateTime(cov.firstTs)} – ${fmtDateTime(cov.lastTs)}`, ts: cov.firstTs, tsEnd: cov.lastTs });
  }
  if (cov.analysisFrom > input.from) evidence.push({ label: 'Detailauswertung ab', value: 'Minutenwerte nur für die letzten 31 Tage', ts: cov.analysisFrom });

  const recommendations = [
    'Langzeittest über mindestens 24 h, besser 72 h inklusive zweier Abende laufen lassen.',
    'Standby-Verhinderung in den Einstellungen eingeschaltet lassen und den PC während des Tests nicht manuell in den Ruhezustand schicken.',
    ...setupHints(input),
  ];
  const severity = q.noData || hours < 6 || cov.coveragePct < 30 ? 'warn' : 'info';
  return {
    id: DATA_QUALITY,
    severity,
    confidence: 'high',
    segment: 'client',
    title,
    summary: sentences.join(' '),
    evidence,
    recommendations,
    score: findingScore(severity, 'high'),
  };
}
