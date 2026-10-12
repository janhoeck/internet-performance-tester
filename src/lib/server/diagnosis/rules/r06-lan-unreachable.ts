// R06 lan-unreachable: the router (gateway ping) was unreachable for ≥ 30 s while the PC's link
// was up (outage events classified 'lan' that do not overlap a NIC link drop).
import { fmtDateTime, fmtDuration } from '../../../shared/format';
import type { Finding, FindingEvidence, NetEvent } from '../../../shared/types';
import { MINUTE } from '../time';
import type { DiagnosisInput } from '../types';
import { detailString, eventDurationMs, eventIds, eventsOf, findingScore, segmentImpact } from '../util';

export const LAN_UNREACHABLE = 'lan-unreachable';

export function lanUnreachable(input: DiagnosisInput): Finding | null {
  const linkWindows = input.linkDrops.map((d) => {
    const end = d.endTs ?? d.ts + (d.downtimeMs ?? 0);
    return [d.ts - 5000, end + 60_000] as const;
  });
  const relevant: { e: NetEvent; dur: number }[] = [];
  for (const e of eventsOf(input, 'outage')) {
    if (detailString(e, 'classification') !== 'lan') continue;
    const dur = eventDurationMs(e);
    if (dur === null || dur < 30_000) continue;
    const end = e.ts + dur;
    if (linkWindows.some(([a, b]) => e.ts < b && end > a)) continue;
    relevant.push({ e, dur });
  }
  if (relevant.length === 0) return null;

  const longest = relevant.reduce((m, r) => Math.max(m, r.dur), 0);
  const severity = relevant.length >= 3 || longest >= 5 * MINUTE ? 'critical' : 'warn';
  const routerEvents = [...eventsOf(input, 'router_reboot'), ...eventsOf(input, 'router_offline')];
  const corroborated = relevant.some(({ e, dur }) => routerEvents.some((r) => r.ts >= e.ts - 10 * MINUTE && r.ts <= e.ts + dur + 10 * MINUTE));
  const confidence = corroborated ? 'high' : 'medium';
  const first = relevant[relevant.length - 1];

  const summary =
    relevant.length === 1
      ? `Am ${fmtDateTime(first.e.ts)} war der Router ${fmtDuration(first.dur)} lang nicht erreichbar, obwohl die Netzwerkverbindung bestand.`
      : `Der Router war ${relevant.length}-mal für mindestens 30 s nicht erreichbar (längster Ausfall ${fmtDuration(longest)}, zuletzt am ${fmtDateTime(first.e.ts)}), obwohl die Netzwerkverbindung bestand.`;

  const evidence: FindingEvidence[] = relevant.slice(-5).reverse().map(({ e, dur }) => ({
    label: 'Router nicht erreichbar',
    value: fmtDuration(dur),
    ts: e.ts,
    tsEnd: e.ts + dur,
  }));
  if (corroborated) evidence.push({ label: 'Router-Neustart/-Ausfall laut Router-Abfrage', value: 'ja (zeitgleich)' });

  return {
    id: LAN_UNREACHABLE,
    severity,
    confidence,
    segment: 'router',
    title: 'Router reagiert nicht',
    summary: `${summary} Das spricht für einen Neustart oder Absturz des Routers.`,
    evidence,
    recommendations: [
      'Ereignisprotokoll und Laufzeit des Routers prüfen (Seite „Router“) – ein Neustart zeigt sich als Rücksprung der Laufzeit.',
      'Bei Wiederholung den Router bei Vodafone tauschen lassen und den Bericht dieser App beilegen.',
    ],
    score: findingScore(severity, confidence, segmentImpact(input, 'lan')),
    relatedEventIds: eventIds(relevant.map((r) => r.e)),
  };
}
