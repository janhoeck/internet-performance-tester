// R08 household-load: errored seconds cluster in minutes in which this PC loads the line to
// ≥ 80 % (self-load). ≥ 60 % of the errored seconds fall into such minutes (critique H4), or the
// error rate there is ≥ 3× the rate otherwise. Load from other household devices is not visible to
// the PC – the "quiet household" experiment covers it.
import type { Finding, FindingEvidence } from '../../../shared/types';
import { fmtShare } from '../text';
import type { DiagnosisInput } from '../types';
import { findingScore } from '../util';

export const HOUSEHOLD_LOAD = 'household-load';

export function householdLoad(input: DiagnosisInput): Finding | null {
  const lc = input.loadCorrelation;
  if (!lc || lc.esLoad < 30 || lc.coveredLoad <= 0) return null;
  const esTotal = lc.esLoad + lc.esIdle;
  const shareInLoad = esTotal > 0 ? lc.esLoad / esTotal : 0;
  const rateLoad = lc.esLoad / lc.coveredLoad;
  const rateIdle = lc.coveredIdle > 0 ? lc.esIdle / lc.coveredIdle : 0;
  const lift = rateIdle > 0 ? rateLoad / rateIdle : Number.POSITIVE_INFINITY;
  const byShare = shareInLoad >= 0.6;
  const byLift = lift >= 3 && rateLoad - rateIdle >= 0.01;
  if (!byShare && !byLift) return null;

  const severity = shareInLoad >= 0.8 && rateLoad >= 0.05 ? 'critical' : 'warn';
  const confidence = lc.esLoad >= 100 && lc.loadMinutes >= 30 ? 'high' : lc.loadMinutes >= 10 ? 'medium' : 'low';
  const liftText = Number.isFinite(lift) ? `${lift >= 10 ? Math.round(lift) : Math.round(lift * 10) / 10}`.replace('.', ',') : 'deutlich';

  const summary =
    `${fmtShare(shareInLoad)} der gestörten Sekunden fielen in Minuten, in denen dieser PC die Leitung zu mindestens ${input.config.thresholds.selfLoadPct} % auslastete; ` +
    `dort war die Störrate ${liftText}-mal so hoch wie sonst. Downloads und Uploads füllen die Warteschlange im Router/Modem – andere Geräte im Haushalt können denselben Effekt haben.`;

  const evidence: FindingEvidence[] = [
    { label: 'Gestörte Sekunden in Minuten mit Eigenlast', value: `${lc.esLoad} von ${esTotal} (${fmtShare(shareInLoad)})` },
    { label: 'Störrate mit / ohne Eigenlast', value: `${fmtShare(rateLoad)} / ${fmtShare(rateIdle)}` },
    { label: 'Minuten mit Eigenlast', value: String(lc.loadMinutes) },
  ];

  return {
    id: HOUSEHOLD_LOAD,
    severity,
    confidence,
    segment: 'router',
    title: 'Andere Geräte/Downloads verursachen Lags',
    summary,
    evidence,
    recommendations: [
      'Downloads/Updates (Steam, Launcher, Windows Update, Cloud-Backups) beim Spielen pausieren oder auf ca. 70 % der Leitungsgeschwindigkeit drosseln.',
      'Test „Ruhiges Heimnetz“: alle anderen Geräte 15 Minuten offline nehmen und vergleichen, ob die Spitzen verschwinden – Ergebnis als Notiz festhalten.',
      'Konsolen-/TV-Updates und Backups in die Nacht verlegen.',
    ],
    score: findingScore(severity, confidence, shareInLoad * (input.seconds && input.seconds.bad > 0 ? Math.min(1, input.seconds.es / input.seconds.bad) : 1)),
  };
}
