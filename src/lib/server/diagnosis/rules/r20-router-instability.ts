// R20 router-instability: router reboots (uptime reset), router offline, link drops classified as
// "router reboot" by the event-log collector, or a slow router web UI (TCP connect p95 > 50 ms).
// All evidence within 10 min belongs to one incident (one reboot drops the PC link several times
// and also makes the router module report "offline"). Critical at ≥ 2 incidents on one day
// (docsis-thresholds.md §14.3, environment.md §1.4, MESSPLAN §3.2/R20).
import { fmtDateTime } from '../../../shared/format';
import type { Finding, FindingEvidence, NetEvent } from '../../../shared/types';
import { fmtCount, ms } from '../text';
import { MINUTE, maxPerLocalDay } from '../time';
import type { DiagnosisInput } from '../types';
import { eventIds, eventsOf, findingScore, segmentImpact, statsOf } from '../util';

export const ROUTER_INSTABILITY = 'router-instability';

const INCIDENT_MS = 10 * MINUTE;

type Evidence = { ts: number; kind: 'reboot' | 'offline' | 'suspected'; endTs: number | null; event: NetEvent | null };

export interface RouterIncident {
  ts: number;
  endTs: number | null;
  /** confirmed by the router's uptime (router_reboot event) */
  confirmed: boolean;
  offline: boolean;
  suspected: boolean;
  events: NetEvent[];
}

/** groups reboot/offline/suspected-reboot evidence that lies within 10 min of each other */
export function routerIncidents(input: DiagnosisInput): RouterIncident[] {
  const list: Evidence[] = [
    ...eventsOf(input, 'router_reboot').map((e): Evidence => ({ ts: e.ts, kind: 'reboot', endTs: e.endTs ?? null, event: e })),
    ...eventsOf(input, 'router_offline').map((e): Evidence => ({ ts: e.ts, kind: 'offline', endTs: e.endTs ?? null, event: e })),
    ...input.linkDrops
      .filter((d) => d.cause === 'router_reboot' && d.ts >= input.from && d.ts < input.to)
      .map((d): Evidence => ({ ts: d.ts, kind: 'suspected', endTs: d.endTs, event: null })),
  ].sort((a, b) => a.ts - b.ts);
  const out: RouterIncident[] = [];
  let lastTs = Number.NEGATIVE_INFINITY;
  for (const e of list) {
    let cur = out[out.length - 1];
    if (!cur || e.ts - lastTs > INCIDENT_MS) {
      cur = { ts: e.ts, endTs: null, confirmed: false, offline: false, suspected: false, events: [] };
      out.push(cur);
    }
    lastTs = Math.max(e.ts, e.endTs ?? e.ts);
    cur.endTs = Math.max(cur.endTs ?? cur.ts, e.endTs ?? e.ts);
    if (e.kind === 'reboot') cur.confirmed = true;
    if (e.kind === 'offline') cur.offline = true;
    if (e.kind === 'suspected') cur.suspected = true;
    if (e.event) cur.events.push(e.event);
  }
  return out;
}

/** slow web UI: TCP connect p95 above the 'warn' band of the router segment (default 50 ms) */
function slowUi(input: DiagnosisInput): { p95: number; httpAvg: number | null } | null {
  const tcp = input.targets.find((t) => t.enabled && t.kind === 'tcp' && t.host === '$gateway');
  const s = statsOf(input, tcp?.id);
  const band = input.config.thresholds.latency.router;
  const http = input.metrics['router.http_ms'];
  if (s && s.sent >= 60 && s.p95 !== null && s.p95 > band.warn) return { p95: s.p95, httpAvg: http?.avg ?? null };
  return null;
}

function describe(i: RouterIncident): string {
  if (i.confirmed) return 'Neustart (Laufzeit zurückgesetzt)';
  if (i.suspected) return 'vermuteter Neustart (LAN und WLAN gleichzeitig weg)';
  return 'Router nicht erreichbar';
}

export function routerInstability(input: DiagnosisInput): Finding | null {
  const incidents = routerIncidents(input);
  const slow = slowUi(input);
  if (incidents.length === 0 && !slow) return null;

  const perDay = maxPerLocalDay(incidents.map((i) => i.ts));
  const confirmed = incidents.filter((i) => i.confirmed).length;
  const suspectedOnly = incidents.filter((i) => !i.confirmed && i.suspected).length;
  const offlineOnly = incidents.filter((i) => !i.confirmed && !i.suspected).length;
  const severity = perDay.count >= 2 ? 'critical' : incidents.length > 0 ? 'warn' : 'info';
  const confidence = confirmed > 0 ? 'high' : incidents.length > 0 ? 'medium' : 'low';

  const parts: string[] = [];
  if (confirmed > 0) {
    const last = incidents.filter((i) => i.confirmed).pop();
    parts.push(`Der Router ist im Zeitraum ${fmtCount(confirmed, 'Mal', 'Mal')} neu gestartet (Laufzeit-Rücksprung${last ? `, zuletzt am ${fmtDateTime(last.ts)}` : ''}).`);
  }
  if (suspectedOnly > 0) {
    parts.push(
      `Laut Windows-Ereignisprotokoll gab es ${suspectedOnly === 1 ? 'einen vermuteten Router-Neustart' : `${suspectedOnly} vermutete Router-Neustarts`} ` +
        '(LAN und WLAN gleichzeitig weg, Internet erst nach Minuten wieder da).',
    );
  }
  if (offlineOnly > 0) parts.push(`Der Router war ${offlineOnly}-mal nicht erreichbar.`);
  if (slow) parts.push(`Die Router-Oberfläche antwortet langsam (TCP-Aufbau p95 ${ms(slow.p95)}) – Hinweis auf einen überlasteten Router.`);
  if (incidents.length > 0) parts.push('Jeder Neustart unterbricht die Verbindung für mehrere Minuten.');

  const evidence: FindingEvidence[] = incidents
    .slice(-5)
    .reverse()
    .map((i) => ({ label: describe(i), value: fmtDateTime(i.ts), ts: i.ts, tsEnd: i.endTs !== null && i.endTs > i.ts ? i.endTs : undefined }));
  if (perDay.count >= 2 && perDay.day) evidence.push({ label: 'Meiste Neustarts/Ausfälle an einem Tag', value: `${perDay.count} (${perDay.day.split('-').reverse().join('.')})` });
  const r = input.router;
  if (r?.uptimeSec != null) evidence.push({ label: 'Router-Laufzeit (letzte Abfrage)', value: `${Math.floor(r.uptimeSec / 86_400)} T ${Math.floor((r.uptimeSec % 86_400) / 3600)} h`, ts: r.ts });
  if (r?.lastRebootReason && r.lastRebootReason.toLowerCase() !== 'unknown') evidence.push({ label: 'Letzter Neustartgrund laut Router', value: r.lastRebootReason });
  if (slow) {
    evidence.push({ label: 'Router-Oberfläche TCP-Aufbau p95', value: ms(slow.p95) });
    if (slow.httpAvg !== null) evidence.push({ label: 'Router-Antwortzeit (HTTP) Ø', value: ms(slow.httpAvg) });
  }

  return {
    id: ROUTER_INSTABILITY,
    severity,
    confidence,
    segment: 'router',
    title: incidents.length > 0 ? 'Router instabil (Neustarts/Ausfälle)' : 'Router antwortet langsam',
    summary: parts.join(' '),
    evidence,
    recommendations: incidents.length > 0
      ? [
          'Störung bei Vodafone melden und einen Gerätetausch verlangen – die Vodafone Station ist ein Mietgerät. Den Bericht (Neustarts, Laufzeit, Router-Protokoll) beilegen.',
          'Router frei aufstellen (Belüftung, nicht neben anderen Elektrogeräten) und nicht über eine Mehrfachsteckdose mit Großverbrauchern betreiben.',
        ]
      : ['Router einmal neu starten; bleibt die Oberfläche langsam, bei Vodafone einen Gerätetausch anfragen.'],
    score: findingScore(severity, confidence, segmentImpact(input, 'router'), Math.min(10, 3 * incidents.length)),
    relatedEventIds: eventIds(incidents.flatMap((i) => i.events)),
  };
}
