// R12 remote-only: only the way to the game/cloud servers is disturbed while Cloudflare, Google
// and the Vodafone hops are clean – classifier class 'remote' or game targets with loss/spikes
// while the internet references are fine (critique.md H8/R12, methodology.md §8).
import { rateBand } from '../../../shared/config';
import { fmtNumber } from '../../../shared/format';
import type { Finding, FindingEvidence } from '../../../shared/types';
import { fmtShare, joinDe, ms, pct } from '../text';
import type { DiagnosisInput, StatsSummary, TargetMeta } from '../types';
import { findingScore, internetWideLossPct, segmentTargets, statsOf } from '../util';

export const REMOTE_ONLY = 'remote-only';

/** TCP probes every 10 s → ≥ 100 samples ≈ 17 min */
const MIN_GAME_SENT = 100;

export interface GameEval {
  target: TargetMeta;
  stats: StatsSummary;
  bad: boolean;
  reasons: string[];
}

export function evaluateGameTargets(input: DiagnosisInput): GameEval[] {
  const band = input.config.thresholds.latency.game;
  const out: GameEval[] = [];
  for (const t of segmentTargets(input, 'game')) {
    const s = statsOf(input, t.id);
    if (!s || s.sent < MIN_GAME_SENT) continue;
    const reasons: string[] = [];
    if ((s.lossPct ?? 0) >= 1) reasons.push(`${pct(s.lossPct)} Verlust`);
    if (s.p95 !== null && s.p50 !== null && s.p95 - s.p50 >= 50) reasons.push(`Spitzen bis ${ms(s.p95)} (p95)`);
    if (rateBand(s.p50, band) === 'bad') reasons.push(`Latenz ${ms(s.p50)} (p50)`);
    out.push({ target: t, stats: s, bad: reasons.length > 0, reasons });
  }
  return out;
}

/** internet references clean: internet-wide loss < 0.5 %, tail p99 − p50 < 50 ms */
export function internetClean(input: DiagnosisInput): boolean {
  const loss = internetWideLossPct(input);
  const inet = statsOf(input, '@internet');
  if (!inet) return false;
  const tail = inet.p99 !== null && inet.p50 !== null ? inet.p99 - inet.p50 : null;
  return (loss === null || loss < 0.5) && (tail === null || tail < 50);
}

export function remoteOnly(input: DiagnosisInput): Finding | null {
  const games = evaluateGameTargets(input);
  const badGames = games.filter((g) => g.bad);
  const clean = internetClean(input);
  const s = input.seconds;
  const remoteShare = s && s.bad > 0 ? s.remote / s.bad : 0;
  const bySeconds = s !== null && s.remote >= 100 && remoteShare >= 0.3;
  const byStats = badGames.length > 0 && clean;
  if (!bySeconds && !byStats) return null;

  const severity = 'warn';
  const confidence = bySeconds && byStats ? 'high' : bySeconds || badGames.some((g) => g.stats.sent >= 1000) ? 'medium' : 'low';
  const names = (badGames.length > 0 ? badGames : games).map((g) => g.target.name);
  const who = names.length > 0 ? joinDe(names) : 'der Weg zu den Spieleservern';
  const summary = clean
    ? `Nur ${who} ${names.length === 1 ? 'ist' : 'sind'} betroffen; Cloudflare, Google und das Vodafone-Netz sind unauffällig. ` +
      'Das Problem liegt auf dem Weg zum Rechenzentrum oder beim Betreiber – nicht an deinem Anschluss.'
    : `${fmtShare(remoteShare)} der gestörten Sekunden betreffen nur ${who}, während Cloudflare, Google und das Vodafone-Netz in diesen Sekunden sauber waren. ` +
      'Dieser Anteil entsteht auf dem Weg zum Rechenzentrum oder beim Betreiber – nicht an deinem Anschluss.';

  const evidence: FindingEvidence[] = badGames.map((g) => ({
    label: g.target.name,
    value: `${g.reasons.join(', ')} (p50 ${ms(g.stats.p50)}, ${fmtNumber(g.stats.sent)} Messungen)`,
  }));
  const inet = statsOf(input, '@internet');
  if (inet) evidence.push({ label: 'Internetziele p50 / p99 / Verlust', value: `${ms(inet.p50)} / ${ms(inet.p99)} / ${pct(internetWideLossPct(input) ?? inet.lossPct)}` });
  if (s && s.remote > 0) evidence.push({ label: 'REMOTE-Sekunden (nur Spieleserver gestört)', value: `${fmtNumber(s.remote)} s (${fmtShare(remoteShare)} der gestörten Sekunden)` });

  return {
    id: REMOTE_ONLY,
    severity,
    confidence,
    segment: 'game',
    title: 'Problem auf dem Weg zum Rechenzentrum, nicht an deinem Anschluss',
    summary,
    evidence,
    recommendations: [
      'Statusseite des Spiels bzw. des Betreibers prüfen und eine andere Server-Region testen.',
      'Bei anhaltenden Problemen den Bericht (inkl. Traceroute/MTR) an den Spielebetreiber bzw. Vodafone weitergeben – das Problem liegt hinter deinem Anschluss.',
    ],
    score: findingScore(severity, confidence, remoteShare),
  };
}
