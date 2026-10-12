// R11 ipv4-vs-ipv6: in ≥ 30 % of the 15-min windows IPv4 has ≥ 1 percentage point more loss or a
// ≥ 30 ms higher p95 than IPv6 to the same anycast operator – for every evaluated provider pair
// (Cloudflare and Google), with the router clean in those windows and ≥ 24 h of windows.
// Sources: MESSPLAN R11, critique.md H5/R11, environment.md §2.3/§2.4.
import { fmtNumber } from '../../../shared/format';
import type { Finding, FindingEvidence } from '../../../shared/types';
import { fmtShare, ms, pct } from '../text';
import type { DiagnosisInput, TargetMeta, WindowStat } from '../types';
import { aftrTarget, dualStackPairs, findingScore, gatewayTarget, median, statsOf } from '../util';

export const IPV4_VS_IPV6 = 'ipv4-vs-ipv6';

/** a 15-min window needs ≥ 10 min of 1 Hz samples per target */
const MIN_WINDOW_SENT = 600;
/** 24 h of windows */
const FULL_WINDOWS = 96;
const PRELIM_WINDOWS = 16;

export interface PairEval {
  v4: TargetMeta;
  v6: TargetMeta;
  compared: number;
  flagged: number;
  share: number;
  /** medians over the flagged windows */
  lossDiff: number | null;
  p95Diff: number | null;
  /** median p50 difference v4 − v6 over all compared windows (constant offset, e.g. other PoP) */
  p50Offset: number | null;
}

export function evaluatePair(input: DiagnosisInput, v4: TargetMeta, v6: TargetMeta): PairEval {
  const w6 = new Map((input.windows[v6.id] ?? []).map((w) => [w.ts, w]));
  const gw = gatewayTarget(input);
  const gwWin = new Map((gw ? input.windows[gw.id] ?? [] : []).map((w) => [w.ts, w]));
  const lossDiffs: number[] = [];
  const p95Diffs: number[] = [];
  const p50Diffs: number[] = [];
  let compared = 0;
  let flagged = 0;
  for (const a of input.windows[v4.id] ?? []) {
    const b = w6.get(a.ts);
    if (!b || a.sent < MIN_WINDOW_SENT || b.sent < MIN_WINDOW_SENT) continue;
    if (!routerClean(gwWin.get(a.ts))) continue;
    compared++;
    const lossDiff = (a.lossPct ?? 0) - (b.lossPct ?? 0);
    const p95Diff = a.p95 !== null && b.p95 !== null ? a.p95 - b.p95 : null;
    if (a.p50 !== null && b.p50 !== null) p50Diffs.push(a.p50 - b.p50);
    if (lossDiff >= 1 || (p95Diff !== null && p95Diff >= 30)) {
      flagged++;
      lossDiffs.push(lossDiff);
      if (p95Diff !== null) p95Diffs.push(p95Diff);
    }
  }
  return {
    v4,
    v6,
    compared,
    flagged,
    share: compared > 0 ? flagged / compared : 0,
    lossDiff: median(lossDiffs),
    p95Diff: median(p95Diffs),
    p50Offset: median(p50Diffs),
  };
}

function routerClean(w: WindowStat | undefined): boolean {
  if (!w || w.sent === 0) return true;
  return (w.lossPct ?? 0) < 1 && (w.p95 === null || w.p95 < 20);
}

export function ipv4VsIpv6(input: DiagnosisInput): Finding | null {
  const evals = dualStackPairs(input, 'icmp')
    .map(([v4, v6]) => evaluatePair(input, v4, v6))
    .filter((e) => e.compared >= PRELIM_WINDOWS);
  if (evals.length === 0) return null;
  if (!evals.every((e) => e.share >= 0.3)) return null;

  const full = evals.every((e) => e.compared >= FULL_WINDOWS);
  const bothProviders = evals.length >= 2;
  const s = input.seconds;
  const wanBad = s ? s.access + s.aftr + s.backbone : 0;
  const aftrShare = s && wanBad > 0 ? s.aftr / wanBad : null;
  const corroborated = aftrShare !== null && aftrShare >= 0.3;

  const confirmed = full && bothProviders;
  const severity = !confirmed ? 'info' : evals.every((e) => e.share >= 0.6) ? 'critical' : 'warn';
  const confidence = !confirmed
    ? 'low'
    : evals.every((e) => e.compared >= 3 * FULL_WINDOWS) && corroborated
      ? 'high'
      : 'medium';

  const p95 = median(evals.map((e) => e.p95Diff).filter((v): v is number => v !== null));
  const loss = median(evals.map((e) => e.lossDiff).filter((v): v is number => v !== null));
  const dsLite = input.router?.dsLite ?? (input.nat.some((n) => n.family === 4 && n.cgnat === true) ? true : null);
  const parts: string[] = [];
  if (!confirmed) parts.push(full ? 'Vorläufig (nur ein Anbieter-Paar auswertbar):' : 'Vorläufig (weniger als 24 h Messdaten):');
  const diffText = [
    p95 !== null && p95 >= 30 ? `${ms(p95)} höhere Spitzen (p95)` : null,
    loss !== null && loss >= 1 ? `${fmtNumber(loss, 1)} Prozentpunkte mehr Verlust` : null,
  ].filter((x): x is string => x !== null);
  const minShare = fmtShare(Math.min(...evals.map((e) => e.share)));
  const maxShare = fmtShare(Math.max(...evals.map((e) => e.share)));
  parts.push(
    `IPv4 zeigt in ${minShare === maxShare ? minShare : `${minShare} bis ${maxShare}`} der 15-Minuten-Fenster ` +
      `${diffText.length > 0 ? diffText.join(' bzw. ') : 'deutlich schlechtere Werte'} als IPv6 zu denselben Zielen.`,
  );
  parts.push(
    dsLite === false
      ? 'Betroffen ist nur der IPv4-Weg (Carrier-NAT bzw. IPv4-Routing des Anbieters).'
      : 'IPv4 läuft bei diesem Anschluss durch einen Tunnel zum Vodafone-Gateway (AFTR, DS-Lite) – die meisten Spiele nutzen IPv4.',
  );
  if (!corroborated && evals.every((e) => (e.p50Offset ?? 0) >= 20)) {
    parts.push('Hinweis: Der Unterschied ist fast immer gleich groß – möglich ist auch, dass IPv4 einen weiter entfernten Cloudflare-/Google-Standort erreicht.');
  }

  const evidence: FindingEvidence[] = evals.map((e) => ({
    label: `${e.v4.name} vs. ${e.v6.name}`,
    value: `IPv4 schlechter in ${e.flagged} von ${e.compared} Fenstern (${fmtShare(e.share)}), p50 im Mittel ${e.p50Offset !== null ? `${e.p50Offset >= 0 ? '+' : '−'}${ms(Math.abs(e.p50Offset))}` : '–'}`,
  }));
  const v4 = statsOf(input, '@internet4');
  const v6 = statsOf(input, '@internet6');
  if (v4 && v6) {
    evidence.push({ label: 'Internet IPv4 / IPv6: p95', value: `${ms(v4.p95)} / ${ms(v6.p95)}` });
    evidence.push({ label: 'Internet IPv4 / IPv6: Verlust', value: `${pct(v4.lossPct)} / ${pct(v6.lossPct)}` });
  }
  if (s && s.aftr > 0) evidence.push({ label: 'AFTR-Sekunden (nur IPv4 gestört)', value: `${fmtNumber(s.aftr)} s${aftrShare !== null ? ` (${fmtShare(aftrShare)} der Internet-Störungen)` : ''}` });
  const aftr = aftrTarget(input);
  const aftrStats = statsOf(input, aftr?.id);
  if (aftrStats) evidence.push({ label: 'DS-Lite-Gateway (AFTR) p50 / p99', value: `${ms(aftrStats.p50)} / ${ms(aftrStats.p99)}` });
  const publicV4 = input.nat.find((n) => n.family === 4)?.publicIp;
  if (publicV4) evidence.push({ label: 'Öffentliche IPv4 (Carrier-NAT)', value: publicV4 });

  return {
    id: IPV4_VS_IPV6,
    severity,
    confidence,
    segment: 'aftr',
    title: dsLite === false ? 'Nur IPv4 betroffen' : 'Nur IPv4 betroffen: DS-Lite-Gateway (AFTR) überlastet',
    summary: parts.join(' '),
    evidence,
    recommendations: [
      'Bei Vodafone eine Umstellung auf Dual-Stack (eigene öffentliche IPv4-Adresse) anfragen – nur auf Kulanz, kein Rechtsanspruch. Den Bericht mit dem IPv4/IPv6-Vergleich beilegen.',
      'Wo möglich IPv6 nutzen (z. B. Spiele/Plattformen mit IPv6-Unterstützung wie Xbox Live oder Steam-Direktverbindungen).',
    ],
    score: findingScore(severity, confidence, aftrShare ?? 0),
  };
}
