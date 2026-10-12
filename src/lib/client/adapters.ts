/**
 * Adapter: API-Formate (src/lib/shared/types.ts, api-types.ts) -> Props der Design-Komponenten.
 *
 *   <EventTimeline events={events.map(toTimelineEvent)} now={nowIso} />
 *   <FindingCard finding={toFindingView(f)} />
 *   const { cells, days } = heatmapCells(res); <HourHeatmap cells={cells} days={days} {...HEATMAP_METRIC[res.metric]} />
 *
 * Reine Funktionen, keine Hooks – in Server- und Client-Komponenten nutzbar.
 */
import type { HeatmapResponse } from "@/lib/shared/api-types";
import type {
  Confidence,
  EventSource,
  EventType,
  Finding as SharedFinding,
  NetEvent,
  OutageClass,
  Segment,
} from "@/lib/shared/types";
import type { TimelineEvent } from "@/components/viz/EventTimeline";
import type { Finding as FindingView } from "@/components/viz/FindingCard";
import type { HeatCell } from "@/components/viz/HourHeatmap";
import type { ChartEvent, Outage } from "@/lib/echarts-theme";
import { fmtLinkSpeed } from "@/lib/format";
import { severityToUi } from "@/lib/health";
import { segmentFromShared, type SegmentId } from "@/lib/segments";
import { eventLogSourceText, isMacEventProvider } from "@/lib/shared/platform";

/* -------------------------------------------------------------------------- */
/* Ereignisse                                                                  */
/* -------------------------------------------------------------------------- */

/** Deutsche Namen der Ereignistypen (Filter, Legenden, Tabellen). */
export const EVENT_TYPE_LABEL: Record<EventType, string> = {
  nic_link_down: "Link-Abbruch",
  nic_link_up: "Link wieder verbunden",
  adapter_change: "Adapter-Änderung",
  route_switch: "Schnittstellenwechsel",
  standby: "Standby",
  resume: "Aufwachen",
  engine_gap: "Messlücke",
  outage: "Ausfall",
  loss_burst: "Verlust-Häufung",
  latency_spike: "Ping-Spitze",
  route_change: "Routenwechsel",
  speedtest: "Speedtest",
  router_reboot: "Router-Neustart",
  router_offline: "Router nicht erreichbar",
  router_log: "Router-Protokoll",
  docsis_change: "DOCSIS-Änderung",
  router_login: "Router-Anmeldung",
  wlan_connect: "WLAN verbunden",
  wlan_disconnect: "WLAN getrennt",
  wlan_roam: "WLAN-Zugangspunkt gewechselt",
  ip_change: "IP-Wechsel",
  identity_change: "Netzwerk-Identität geändert",
  gaming: "Spiel aktiv",
  vpn_change: "VPN-Änderung",
  mtu_change: "MTU-Änderung",
  nat_change: "NAT-Änderung",
  session_start: "Langzeittest gestartet",
  session_end: "Langzeittest beendet",
  config_change: "Einstellungen geändert",
  note: "Notiz",
};

/** Deutsche Namen der Quellen ("Quelle: …" in der Zeitleiste). */
export const EVENT_SOURCE_LABEL: Record<EventSource, string> = {
  engine: "Mess-Engine",
  icmp: "Ping",
  tcp: "TCP-Messung",
  udp: "UDP-Messung",
  eventlog: "Ereignisprotokoll",
  adapter: "Netzwerkadapter",
  wlan: "WLAN",
  route: "Routing-Tabelle",
  vpn: "VPN",
  system: "System",
  router: "Router",
  traceroute: "Traceroute",
  speedtest: "Speedtest",
  stun: "STUN/NAT-Test",
  mtu: "MTU-Test",
  user: "Von dir markiert",
};

/** Einordnung von Ausfällen (details.classification). */
export const OUTAGE_CLASS_LABEL: Record<OutageClass, string> = {
  client: "PC & Adapter",
  lan: "Heimnetz",
  docsis: "Kabelnetz (DOCSIS)",
  aftr: "DS-Lite-Gateway (nur IPv4)",
  isp: "Vodafone-Netz",
  internet: "Internet",
  unknown: "Unklar",
};

/** Abschnitt nach Ereignistyp, falls das Ereignis kein Segment mitbringt. */
const TYPE_SEGMENT: Partial<Record<EventType, SegmentId>> = {
  nic_link_down: "pc",
  nic_link_up: "pc",
  adapter_change: "pc",
  route_switch: "pc",
  standby: "pc",
  resume: "pc",
  wlan_connect: "pc",
  wlan_disconnect: "pc",
  wlan_roam: "pc",
  vpn_change: "pc",
  gaming: "pc",
  router_reboot: "router",
  router_offline: "router",
  router_login: "router",
  router_log: "docsis",
  docsis_change: "docsis",
  route_change: "internet",
};

const OUTAGE_SEGMENT: Record<OutageClass, SegmentId | undefined> = {
  client: "pc",
  lan: "lan",
  docsis: "docsis",
  aftr: "provider",
  isp: "provider",
  internet: "internet",
  unknown: undefined,
};

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

function isOutageClass(v: unknown): v is OutageClass {
  return typeof v === "string" && v in OUTAGE_CLASS_LABEL;
}

/** Design-Segment eines Ereignisses (Segment aus der API, sonst nach Typ/Einordnung). */
export function eventSegment(e: NetEvent): SegmentId | undefined {
  const fromApi = segmentFromShared(e.segment ?? null);
  if (fromApi) return fromApi;
  if (e.type === "outage") {
    const c = rec(e.details).classification;
    return isOutageClass(c) ? OUTAGE_SEGMENT[c] : undefined;
  }
  return TYPE_SEGMENT[e.type];
}

/**
 * Episode, die noch läuft (endTs fehlt, das Ende wird nachgetragen): laufender Ausfall, Router
 * weiterhin offline, Link noch getrennt, Speedtest läuft. Punkt-Ereignisse ohne Ende (z. B.
 * Standby aus dem Ereignisprotokoll) und Link-Abbrüche, deren Auswertung abgeschlossen ist
 * („keine Wiederverbindung erkannt“), zählen nicht.
 */
export function isOngoingEpisode(e: NetEvent): boolean {
  if (e.endTs != null) return false;
  const d = rec(e.details);
  switch (e.type) {
    case "outage":
      return d.ongoing !== false;
    case "router_offline":
    case "speedtest":
      return true;
    case "nic_link_down":
      return d.final !== true;
    default:
      return false;
  }
}

/** Dauer einer Episode in Sekunden (endTs oder details.durationMs), sonst undefined. */
export function eventDurationS(e: NetEvent): number | undefined {
  if (e.endTs != null && e.endTs > e.ts) return (e.endTs - e.ts) / 1000;
  const d = num(rec(e.details).durationMs) ?? num(rec(e.details).downtimeMs);
  return d != null && d > 0 ? d / 1000 : undefined;
}

/** Kontextzeile ("Beleg") aus bekannten Detail-Feldern. */
export function eventDetail(e: NetEvent): string | undefined {
  const d = rec(e.details);
  switch (e.type) {
    case "nic_link_up": {
      const mbps = num(d.speedMbps) ?? num(d.relinkMbps);
      return mbps != null ? `Wieder verbunden mit ${fmtLinkSpeed(mbps)}${mbps < 1000 ? " statt 1 Gbit/s" : ""}` : undefined;
    }
    case "nic_link_down": {
      const parts: string[] = [];
      const cause = str(d.cause);
      if (cause === "boot") parts.push("beim Start/Aufwachen – normal");
      else if (cause === "pre_sleep") parts.push("vor dem Standby – normal");
      else if (cause === "router_reboot") parts.push("vermutlich Router-Neustart");
      else if (cause === "runtime") parts.push("Abbruch im laufenden Betrieb");
      const relink = num(d.relinkMbps);
      if (relink != null) parts.push(`danach ${fmtLinkSpeed(relink)}`);
      if (d.wlanFailover === true) parts.push(isMacEventProvider(str(d.provider)) ? "macOS wich aufs WLAN aus" : "Windows wich aufs WLAN aus");
      return parts.length ? parts.join(", ") : undefined;
    }
    case "outage": {
      const c = d.classification;
      return isOutageClass(c) ? `Einordnung: ${OUTAGE_CLASS_LABEL[c]}` : undefined;
    }
    case "speedtest": {
      const down = num(d.downMbps);
      const up = num(d.upMbps);
      if (down == null && up == null) return undefined;
      return `Download ${down != null ? Math.round(down) : "–"} / Upload ${up != null ? Math.round(up) : "–"} Mbit/s`;
    }
    default:
      return str(d.note) ?? str(d.message) ?? undefined;
  }
}

/** "Windows-Ereignisprotokoll (e2fexpress, ID 27)" bzw. "macOS-Systemprotokoll (pmset)" */
export function eventSourceText(e: NetEvent): string {
  const d = rec(e.details);
  const base = EVENT_SOURCE_LABEL[e.source] ?? e.source;
  const provider = str(d.provider);
  const id = num(d.eventId) ?? num(d.id);
  if (e.source === "eventlog") return eventLogSourceText(provider, id) ?? base;
  if (provider && id != null) return `${base} (${provider}, ID ${id})`;
  if (provider) return `${base} (${provider})`;
  return base;
}

/** Stabiler Schlüssel (id aus der DB, sonst Typ + Zeit). */
export function eventKey(e: NetEvent): string {
  return e.id != null ? String(e.id) : `${e.type}-${e.ts}-${e.title}`;
}

/** NetEvent -> <EventTimeline/>/<EventStrip/>-Eintrag. */
export function toTimelineEvent(e: NetEvent): TimelineEvent {
  return {
    id: eventKey(e),
    at: new Date(e.ts).toISOString(),
    severity: severityToUi(e.severity),
    segment: eventSegment(e),
    title: e.title,
    detail: eventDetail(e),
    durationS: eventDurationS(e),
    source: eventSourceText(e),
  };
}

/** NetEvent -> senkrechte Linie für den Design-<LatencyChart/> (eigene Diagramme: eventOverlays() in charts.ts). */
export function toChartEvent(e: NetEvent): ChartEvent {
  return { at: e.ts, label: EVENT_TYPE_LABEL[e.type], severity: severityToUi(e.severity) };
}

/**
 * Episoden (Ausfall, Link weg …) -> getönter Bereich für den Design-<LatencyChart/>. Mit `now`
 * werden laufende Episoden (isOngoingEpisode) bis jetzt gezeichnet ("… läuft"), sonst entfallen sie.
 */
export function toOutage(e: NetEvent, now?: number | null): Outage | null {
  const ongoing = now != null && isOngoingEpisode(e) && now > e.ts;
  const end = ongoing ? (now as number) : e.endTs;
  if (end == null || end <= e.ts) return null;
  const sev = severityToUi(e.severity);
  return {
    from: e.ts,
    to: end,
    label: ongoing ? `${EVENT_TYPE_LABEL[e.type]} (läuft)` : EVENT_TYPE_LABEL[e.type],
    severity: sev === "crit" ? "crit" : sev === "warn" ? "warn" : "unknown",
  };
}

/* -------------------------------------------------------------------------- */
/* Befunde                                                                     */
/* -------------------------------------------------------------------------- */

export const CONFIDENCE_LABEL: Record<Confidence, "niedrig" | "mittel" | "hoch"> = {
  low: "niedrig",
  medium: "mittel",
  high: "hoch",
};

/** Diagnose-Befund (API) -> <FindingCard/>. Mehrere Empfehlungen werden zu einem Absatz verbunden. */
export function toFindingView(f: SharedFinding): FindingView {
  return {
    id: f.id,
    severity: severityToUi(f.severity),
    title: f.title,
    summary: f.summary,
    segment: segmentFromShared(f.segment),
    confidence: CONFIDENCE_LABEL[f.confidence],
    evidence: f.evidence.map((e) => ({ label: e.label, value: e.value })),
    recommendation: f.recommendations.length ? f.recommendations.join(" ") : undefined,
  };
}

/** Segment der Diagnose -> Design-Segment (für Chips); undefined bei unbekannt. */
export function findingSegment(s: Segment | null | undefined): SegmentId | undefined {
  return segmentFromShared(s ?? null);
}

/* -------------------------------------------------------------------------- */
/* Heatmap                                                                     */
/* -------------------------------------------------------------------------- */

export interface HeatmapMetricMeta {
  /** Messgröße für Legende/Tooltip */
  metric: string;
  unit: string;
  /** Oberes Ende der Skala (darüber = höchste Stufe) */
  max: number;
  digits: number;
}

/** Anzeige je Heatmap-Kennzahl (Props für <HourHeatmap/>). */
export const HEATMAP_METRIC: Record<HeatmapResponse["metric"], HeatmapMetricMeta> = {
  p95: { metric: "p95-Latenz", unit: "ms", max: 200, digits: 0 },
  avg: { metric: "Ø-Latenz", unit: "ms", max: 100, digits: 0 },
  loss: { metric: "Paketverlust", unit: "%", max: 5, digits: 1 },
  spikes: { metric: "Ping-Spitzen", unit: "Anzahl", max: 30, digits: 0 },
};

/**
 * Unter diesem Anteil gemessener Minuten (coverage, %) gilt eine Stunde als "wenig gemessen":
 * Zelle wird schraffiert, der Wert ist nur eingeschränkt aussagekräftig.
 */
export const HEATMAP_LOW_COVERAGE_PCT = 50;

/** HeatmapResponse (values[tag][stunde], coverage[tag][stunde]) -> Zellen + Tage für <HourHeatmap/> bzw. heatmapOption(). */
export function heatmapCells(res: HeatmapResponse | null | undefined): { cells: HeatCell[]; days: string[] } {
  if (!res || !Array.isArray(res.days)) return { cells: [], days: [] };
  const cells: HeatCell[] = [];
  res.days.forEach((day, d) => {
    const row = res.values?.[d] ?? [];
    const cov = Array.isArray(res.coverage) ? (res.coverage[d] ?? []) : [];
    for (let hour = 0; hour < 24; hour++) {
      const v = row[hour];
      const c = cov[hour];
      cells.push({
        day,
        hour,
        value: typeof v === "number" && Number.isFinite(v) ? v : null,
        coveragePct: typeof c === "number" && Number.isFinite(c) ? Math.max(0, Math.min(100, c)) : null,
      });
    }
  });
  return { cells, days: [...res.days] };
}

/** Zelle mit Messwert, aber wenig gemessener Zeit (coverage < HEATMAP_LOW_COVERAGE_PCT). */
export function isLowCoverage(c: Pick<HeatCell, "value" | "coveragePct">): boolean {
  return c.value != null && c.coveragePct != null && c.coveragePct < HEATMAP_LOW_COVERAGE_PCT;
}
