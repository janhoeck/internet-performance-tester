// Pure report assembly: runs all rules on a DiagnosisInput, selects the verdict (highest-scoring
// root-cause finding, honest wording for missing/thin data), builds segment health, the seconds
// breakdown, the gaming score (IPv4 internet references, methodology §12) and data-quality notes.
import { fmtDateTime, fmtDuration, fmtNumber } from '../../shared/format';
import { computeGamingScore } from '../../shared/scoring';
import type { DiagnosisReport, Finding, GamingScore, Segment } from '../../shared/types';
import { RULES } from './rules';
import { DATA_QUALITY, dataQualityIssues } from './rules/r16-data-quality';
import { TOP_CAUSE, computeTopCause } from './rules/r17-top-cause';
import { buildSegments } from './segments';
import { CLASS_LABELS, CONFIDENCE_LABELS, fmtCoverage, fmtShare, joinDe, pct } from './text';
import type { DiagnosisInput, StatsSummary } from './types';
import { CONFIDENCE_RANK, SEVERITY_RANK, coveredHours, eventCount, internetWideLossPct, segmentTargets, statsOf } from './util';

/** minutes of data per internet reference target before a gaming score is shown */
const MIN_SCORE_MINUTES = 15;

/** findings that are never the root cause (data quality) */
const NON_CAUSE: ReadonlySet<string> = new Set([DATA_QUALITY]);

/** German cause phrases for the verdict headline ("Hauptursache: …") */
const CAUSE_PHRASES: Readonly<Record<string, string>> = {
  'nic-link-flaps': 'instabile Netzwerkverbindung am PC (Kabel/Port)',
  'nic-100m': 'Kabel/Port schafft kein Gigabit (Rückfall auf 100 Mbit/s)',
  'wlan-failover': 'WLAN-Umschaltung bei Kabelabbrüchen',
  'bufferbloat-load': 'Lags unter Last (Bufferbloat)',
  'lan-quality': 'Problem zwischen PC und Router',
  'lan-unreachable': 'Router reagiert zeitweise nicht',
  'access-spikes': 'Störung/Überlastung im Kabelnetz (Vodafone)',
  'household-load': 'Downloads bzw. andere Geräte lasten die Leitung aus',
  'docsis-values': 'auffällige Leitungswerte am Kabelanschluss',
  'ipv4-vs-ipv6': 'DS-Lite-Gateway (IPv4) von Vodafone',
  'remote-only': 'Weg zum Spieleserver (nicht dein Anschluss)',
  'identity-change': 'fremdes bzw. zweites Gerät im Netz',
  'vpn-active': 'VPN leitet den Spieleverkehr um',
  'speed-below-tariff': 'Bandbreite unter Vertrag',
  'periodic-spikes': 'periodische Lag-Spitzen (Hintergrunddienst)',
  'router-instability': 'instabiler Router (Neustarts)',
};

const PEAK_PHRASES: Readonly<Partial<Record<Segment, string>>> = {
  docsis: 'Überlastung des Kabelsegments zu Stoßzeiten',
  aftr: 'Überlastung des DS-Lite-Gateways zu Stoßzeiten',
  isp: 'Überlastung im Vodafone-Netz zu Stoßzeiten',
};

function causePhrase(f: Finding, input: DiagnosisInput): string {
  if (f.id === TOP_CAUSE) {
    const t = computeTopCause(input);
    return t ? CLASS_LABELS[t.cls] : f.title;
  }
  if (f.id === 'peak-hours') return PEAK_PHRASES[f.segment] ?? 'Überlastung zu Stoßzeiten';
  return CAUSE_PHRASES[f.id] ?? f.title;
}

export interface RuleRun {
  findings: Finding[];
  /** codes of rules that threw */
  errors: string[];
}

export function byRelevance(a: Finding, b: Finding): number {
  return (
    b.score - a.score ||
    SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
    CONFIDENCE_RANK[b.confidence] - CONFIDENCE_RANK[a.confidence] ||
    a.id.localeCompare(b.id)
  );
}

/** runs every rule; a failing rule is reported in `errors` and never breaks the report */
export function evaluateRules(input: DiagnosisInput): RuleRun {
  const findings: Finding[] = [];
  const errors: string[] = [];
  for (const rule of RULES) {
    try {
      const f = rule.run(input);
      if (f) findings.push(f);
    } catch {
      errors.push(rule.code);
    }
  }
  findings.sort(byRelevance);
  return { findings, errors };
}

/** root-cause candidates: warn/critical findings except data quality, best first */
export function causeCandidates(findings: readonly Finding[]): Finding[] {
  return findings.filter((f) => !NON_CAUSE.has(f.id) && f.severity !== 'info').sort(byRelevance);
}

export function selectPrimary(findings: readonly Finding[]): Finding | null {
  const candidates = causeCandidates(findings);
  let primary = candidates[0] ?? null;
  // R17 only summarizes the seconds – prefer the specific, actionable finding of the same segment
  if (primary && primary.id === TOP_CAUSE) {
    const top = primary;
    const specific = candidates.find((f) => f.id !== TOP_CAUSE && f.segment === top.segment && f.score >= top.score - 10);
    if (specific) primary = specific;
  }
  return primary;
}

export function buildVerdict(input: DiagnosisInput, findings: readonly Finding[]): DiagnosisReport['verdict'] {
  const q = dataQualityIssues(input);
  const measured = fmtCoverage(input.coverage.coveredSeconds);
  const thin = q.fewData;
  const primary = selectPrimary(findings);
  const s = input.seconds;

  if (!primary) {
    if (q.noData) {
      return {
        severity: 'info',
        title: 'Noch keine Messdaten im Zeitraum',
        text:
          'Im gewählten Zeitraum liegen keine Messdaten vor. Starte einen Langzeittest (empfohlen 72 h, mindestens 24 h inklusive zweier Abende) ' +
          'und öffne die Diagnose danach erneut.',
        primarySegment: null,
      };
    }
    if (thin) {
      return {
        severity: 'info',
        title: 'Bisher keine Auffälligkeiten (noch zu wenige Messdaten)',
        text:
          `Gemessen wurden erst ${measured}. Bisher wurde nichts Auffälliges gefunden – für eine sichere Aussage mindestens 24 h messen, ` +
          'besser 72 h inklusive zweier Abende.',
        primarySegment: null,
      };
    }
    const score = gamingScoreFor(input);
    const parts = [`In ${measured} Messzeit wurde keine Störungsursache gefunden`];
    if (s && s.covered > 0) parts.push(`${fmtShare(s.bad / s.covered)} der Sekunden waren gestört`);
    if (score) parts.push(`Gaming-Score ${score.score} (Note ${score.grade})`);
    return {
      severity: 'info',
      title: 'Keine Auffälligkeiten – die Leitung ist unauffällig',
      text:
        `${parts.join('; ')}. Treten trotzdem Lags auf, im Moment des Lags „Lag jetzt markieren“ drücken – ` +
        'so lassen sich subjektive Lags mit den Messdaten abgleichen.',
      primarySegment: null,
    };
  }

  const provisional = primary.confidence === 'low' || thin;
  const sentences = [primary.summary];
  const others = causeCandidates(findings)
    .filter((f) => f !== primary && f.id !== TOP_CAUSE && f.segment !== primary.segment)
    .slice(0, 2);
  if (others.length > 0) sentences.push(`Außerdem auffällig: ${joinDe(others.map((f) => f.title))}.`);
  const top = computeTopCause(input);
  if (top && primary.id !== TOP_CAUSE && top.share >= 0.2 && top.severity !== 'info') {
    sentences.push(
      top.segment === primary.segment
        ? `Die sekundengenaue Auswertung bestätigt das: ${fmtShare(top.share)} der gestörten Sekunden entfallen auf „${CLASS_LABELS[top.cls]}“.`
        : `Die meisten gestörten Sekunden entfallen allerdings auf „${CLASS_LABELS[top.cls]}“ (${fmtShare(top.share)}).`,
    );
  }
  sentences.push(`Sicherheit: ${CONFIDENCE_LABELS[primary.confidence]}.`);
  if (thin) sentences.push(`Achtung: erst ${measured} gemessen – das Ergebnis ist vorläufig.`);

  return {
    severity: primary.severity,
    title: `Hauptursache${provisional ? ' (vorläufig)' : ''}: ${causePhrase(primary, input)}`,
    text: sentences.join(' '),
    primarySegment: primary.segment,
  };
}

/**
 * Gaming score from the IPv4 internet reference targets (games mostly use IPv4 via DS-Lite);
 * falls back to all internet targets. Loss = internet-wide loss (min over the references).
 */
export function gamingReference(input: DiagnosisInput): { stats: StatsSummary; family: 4 | undefined } | null {
  // ≥ 15 min of data per reference target (methodology §12: shortest window = 15 min)
  const enough = (id: '@internet' | '@internet4', family?: 4) => {
    const s = statsOf(input, id);
    const members = segmentTargets(input, 'internet', 'icmp').filter((t) => (family === undefined || t.family === family) && statsOf(input, t.id)).length;
    return s && s.minutes >= MIN_SCORE_MINUTES * Math.max(1, members) ? s : null;
  };
  const v4 = enough('@internet4', 4);
  if (v4) return { stats: v4, family: 4 };
  const all = enough('@internet');
  return all ? { stats: all, family: undefined } : null;
}

export function gamingScoreFor(input: DiagnosisInput): GamingScore | null {
  const r = gamingReference(input);
  if (!r) return null;
  const ref = r.stats;
  const loss = internetWideLossPct(input, r.family, 60) ?? ref.lossPct;
  const hours = coveredHours(input);
  return computeGamingScore({
    p50Ms: ref.p50,
    jitterMs: ref.jitter,
    tailMs: ref.p99 !== null && ref.p50 !== null ? ref.p99 - ref.p50 : null,
    lossPct: loss,
    outagesPerHour: hours >= 1 ? eventCount(input, 'outage') / hours : null,
    avgRttMs: ref.avg,
  });
}

export function secondsBreakdown(input: DiagnosisInput): DiagnosisReport['seconds'] {
  const s = input.seconds;
  if (!s) return null;
  return {
    covered: s.covered,
    bad: s.bad,
    es: s.es,
    ses: s.ses,
    selfLoad: s.selfLoad,
    byClass: { link: s.link, lan: s.lan, access: s.access, aftr: s.aftr, backbone: s.backbone, remote: s.remote, unknown: s.unknown },
  };
}

export function buildDataQuality(input: DiagnosisInput, ruleErrors: readonly string[]): DiagnosisReport['dataQuality'] {
  const cov = input.coverage;
  const notes: string[] = [`Gemessen: ${fmtCoverage(cov.coveredSeconds)} von ${fmtDuration(cov.rangeMs)} (${pct(cov.coveragePct, 0)}).`];
  if (cov.gaps.count > 0) {
    notes.push(
      `${cov.gaps.count === 1 ? '1 Messlücke' : `${fmtNumber(cov.gaps.count)} Messlücken`} (Standby, PC aus oder kein Test), zusammen ${fmtDuration(cov.gaps.totalMs)}, längste ${fmtDuration(cov.gaps.longestMs)} – kein Netzproblem.`,
    );
  }
  if (!cov.hasSeconds && cov.samples > 0) notes.push('Keine sekundengenaue Klassifizierung vorhanden – Auswertung nur auf Minutenbasis.');
  if (cov.analysisFrom > input.from) notes.push(`Minutenwerte wurden ab ${fmtDateTime(cov.analysisFrom)} ausgewertet (höchstens 31 Tage).`);
  if (!input.docsis) notes.push('DOCSIS-Werte nicht verfügbar (Router-Login nicht eingerichtet).');
  if (input.config.tariff.downMbps === null) notes.push('Tarif nicht hinterlegt – Speedtests und Eigenlast nur eingeschränkt bewertbar.');
  if (input.events.truncated.length > 0) notes.push(`Sehr viele Ereignisse (${input.events.truncated.join(', ')}) – ausgewertet wurden die neuesten.`);
  const ref = gamingReference(input);
  if (ref?.family === 4) notes.push('Gaming-Score aus den IPv4-Internetzielen (Spiele nutzen meist IPv4 über DS-Lite).');
  else if (!ref && cov.samples > 0) notes.push('Gaming-Score erst ab 15 min Messdaten je Internetziel.');
  for (const code of ruleErrors) notes.push(`Regel ${code} konnte nicht ausgewertet werden.`);
  return { samples: cov.samples, coveragePct: Math.round(cov.coveragePct * 10) / 10, gaps: cov.gaps.count, notes };
}

/** Full report from a prepared input (pure – used by runDiagnosis and the unit tests). */
export function diagnose(input: DiagnosisInput): DiagnosisReport {
  const { findings, errors } = evaluateRules(input);
  return {
    from: input.from,
    to: input.to,
    generatedAt: input.now,
    verdict: buildVerdict(input, findings),
    findings,
    segments: buildSegments(input, findings),
    seconds: secondsBreakdown(input),
    gamingScore: gamingScoreFor(input),
    dataQuality: buildDataQuality(input, errors),
  };
}
