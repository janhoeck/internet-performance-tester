// R17 top-cause: the segment with the largest share of bad seconds (seconds_1m) is the most likely
// root cause. Confidence high at ≥ 3 measured days (and ≥ 24 h measured), ≥ 100 bad seconds and
// ≥ 50 % share; medium at ≥ 24 h measured; low otherwise. When unclassifiable seconds outnumber
// the top class, the confidence drops one level (critique.md R17, ARCHITECTURE §6). Severity from
// the share of measured seconds (≥ 1 % critical, ≥ 0.1 % warn) – only with ≥ 1 h measured.
import { fmtNumber } from '../../../shared/format';
import type { Confidence, Finding, FindingEvidence, Segment, Severity } from '../../../shared/types';
import { ATTRIBUTABLE_CLASSES, type BadClass, CLASS_LABELS, CLASS_SEGMENT, fmtShare, joinDe } from '../text';
import type { DiagnosisInput } from '../types';
import { coveredHours, findingScore } from '../util';
import { linkRecommendations } from './r01-nic-link-flaps';
import { VODAFONE_REPORT_RECOMMENDATIONS } from './r07-access-spikes';

export const TOP_CAUSE = 'top-cause';

export type AttributableClass = Exclude<BadClass, 'unknown'>;

export interface TopCause {
  cls: AttributableClass;
  segment: Segment;
  count: number;
  /** share of all bad seconds (0..1) */
  share: number;
  /** share of the measured seconds (0..1) */
  rate: number;
  unknownShare: number;
  confidence: Confidence;
  severity: Severity;
  /** attributable classes with seconds, largest first */
  ranking: { cls: AttributableClass; count: number; share: number }[];
}

const LOWER: Readonly<Record<Confidence, Confidence>> = { high: 'medium', medium: 'low', low: 'low' };
/** below 1 h of classified seconds or 10 seconds of the top class the finding is only a hint (info) */
const MIN_COVERED_SEC = 3600;
const MIN_TOP_SECONDS = 10;

export function computeTopCause(input: DiagnosisInput): TopCause | null {
  const s = input.seconds;
  if (!s || s.bad <= 0) return null;
  const ranking = ATTRIBUTABLE_CLASSES.filter((c) => s[c] > 0)
    .map((cls) => ({ cls, count: s[cls], share: s[cls] / s.bad }))
    .sort((a, b) => b.count - a.count);
  if (ranking.length === 0) return null;
  const top = ranking[0];
  const hours = coveredHours(input);
  let confidence: Confidence =
    input.coverage.daysCovered >= 3 && hours >= 24 && s.bad >= 100 && top.share >= 0.5 ? 'high' : hours >= 24 ? 'medium' : 'low';
  if (s.unknown > top.count) confidence = LOWER[confidence];
  const rate = s.covered > 0 ? top.count / s.covered : 0;
  // a few bad seconds within minutes of measurement are no evidence for a root cause
  const enough = s.covered >= MIN_COVERED_SEC && top.count >= MIN_TOP_SECONDS;
  const severity: Severity = !enough ? 'info' : rate >= 0.01 ? 'critical' : rate >= 0.001 ? 'warn' : 'info';
  return {
    cls: top.cls,
    segment: CLASS_SEGMENT[top.cls] ?? 'internet',
    count: top.count,
    share: top.share,
    rate,
    unknownShare: s.unknown / s.bad,
    confidence,
    severity,
    ranking,
  };
}

const CLASS_RECOMMENDATIONS: Readonly<Record<AttributableClass, readonly string[]>> = {
  link: linkRecommendations(undefined).slice(0, 3),
  lan: [
    'Anderen LAN-Port und ein anderes Netzwerkkabel testen.',
    'Router neu starten; tritt das Problem danach wieder auf, bei Vodafone einen Gerätetausch anfragen.',
  ],
  access: VODAFONE_REPORT_RECOMMENDATIONS,
  aftr: [
    'Bei Vodafone eine Umstellung auf Dual-Stack (eigene öffentliche IPv4-Adresse) anfragen – nur auf Kulanz. Den Bericht mit dem IPv4/IPv6-Vergleich beilegen.',
  ],
  backbone: [
    'Bericht exportieren und die Störung bei Vodafone melden (Backbone/Peering); Traceroutes aus Problem- und Ruhezeiten beilegen.',
  ],
  remote: [
    'Statusseite des Spiels prüfen und eine andere Server-Region testen – das Problem liegt hinter deinem Anschluss.',
  ],
};

export function topCauseFinding(input: DiagnosisInput): Finding | null {
  const t = computeTopCause(input);
  const s = input.seconds;
  if (!t || !s) return null;
  const label = CLASS_LABELS[t.cls];
  const sentences = [`${fmtShare(t.share)} der gestörten Sekunden (${fmtNumber(t.count)} s) entfallen auf „${label}“.`];
  if (t.severity === 'info' && (s.covered < 3600 || t.count < 10)) sentences.push('Für eine Bewertung sind das noch zu wenige Messdaten.');
  const next = t.ranking.slice(1, 3).filter((r) => r.share >= 0.05);
  if (next.length > 0) sentences.push(`Danach folgen ${joinDe(next.map((r) => `${CLASS_LABELS[r.cls]} (${fmtShare(r.share)})`))}.`);
  if (t.unknownShare >= 0.2) {
    sentences.push(
      `${fmtShare(t.unknownShare)} der gestörten Sekunden lassen sich keinem Abschnitt eindeutig zuordnen (z. B. nur die Kopfstation antwortet verzögert oder nur IPv6 ist gestört).`,
    );
  }

  const evidence: FindingEvidence[] = [
    {
      label: 'Gestörte Sekunden gesamt',
      value: `${fmtNumber(s.bad)} von ${fmtNumber(s.covered)} gemessenen (${fmtShare(s.covered > 0 ? s.bad / s.covered : null)})`,
    },
  ];
  for (const r of t.ranking) evidence.push({ label: CLASS_LABELS[r.cls], value: `${fmtNumber(r.count)} s (${fmtShare(r.share)})` });
  if (s.unknown > 0) evidence.push({ label: CLASS_LABELS.unknown, value: `${fmtNumber(s.unknown)} s (${fmtShare(t.unknownShare)})` });
  if (s.ses > 0) evidence.push({ label: 'Stark gestörte Sekunden (SES)', value: `${fmtNumber(s.ses)} s` });
  if (s.selfLoad > 0) evidence.push({ label: 'Sekunden mit Eigenlast', value: `${fmtNumber(s.selfLoad)} s` });

  return {
    id: TOP_CAUSE,
    severity: t.severity,
    confidence: t.confidence,
    segment: t.segment,
    title: `${t.confidence === 'high' ? 'Hauptursache' : 'Hauptursache (vorläufig)'}: ${label}`,
    summary: sentences.join(' '),
    evidence,
    recommendations: t.cls === 'link' ? linkRecommendations(input.os).slice(0, 3) : [...CLASS_RECOMMENDATIONS[t.cls]],
    score: findingScore(t.severity, t.confidence, t.share),
  };
}
