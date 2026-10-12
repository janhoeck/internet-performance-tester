/** Filtergruppen und Hilfen für die Ereignisseite (reine Daten/Funktionen). */
import type { EventType, NetEvent, Segment, Severity } from "@/lib/shared/types";
import { EVENT_TYPE_LABEL, eventDetail } from "@/lib/client/adapters";

export type EventGroupId = "pc" | "faults" | "router" | "path" | "speedtest" | "system" | "notes";

export interface EventGroupDef {
  id: EventGroupId;
  label: string;
  hint: string;
}

export const EVENT_GROUPS: readonly EventGroupDef[] = [
  { id: "pc", label: "Verbindung/PC", hint: "Link-Abbrüche, WLAN, Standby, Adapter, VPN, Spiel" },
  { id: "faults", label: "Ausfälle & Spitzen", hint: "Ausfälle, Verlust-Häufungen, Ping-Spitzen" },
  { id: "router", label: "Router & DOCSIS", hint: "Neustarts, Router-Protokoll, DOCSIS-Änderungen, Anmeldung" },
  { id: "path", label: "Pfad", hint: "Routenwechsel, IP-, MTU- und NAT-Änderungen" },
  { id: "speedtest", label: "Speedtest", hint: "Speedtest-Fenster mit Ergebnis" },
  { id: "system", label: "System", hint: "Messlücken, Langzeittest Start/Ende, Einstellungen" },
  { id: "notes", label: "Notizen", hint: "Von dir markierte Momente" },
];

/** Jeder Ereignistyp gehört zu genau einer Gruppe (Record erzwingt Vollständigkeit). */
export const TYPE_GROUP: Record<EventType, EventGroupId> = {
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
  identity_change: "pc",
  outage: "faults",
  loss_burst: "faults",
  latency_spike: "faults",
  router_reboot: "router",
  router_offline: "router",
  router_log: "router",
  docsis_change: "router",
  router_login: "router",
  route_change: "path",
  ip_change: "path",
  mtu_change: "path",
  nat_change: "path",
  speedtest: "speedtest",
  engine_gap: "system",
  session_start: "system",
  session_end: "system",
  config_change: "system",
  note: "notes",
};

export const ALL_GROUP_IDS: readonly EventGroupId[] = EVENT_GROUPS.map((g) => g.id);

/** Ereignistypen der gewählten Gruppen; null = alle (kein Filter nötig). */
export function typesForGroups(groups: ReadonlySet<EventGroupId>): EventType[] | null {
  if (ALL_GROUP_IDS.every((g) => groups.has(g))) return null;
  return (Object.keys(TYPE_GROUP) as EventType[]).filter((t) => groups.has(TYPE_GROUP[t]));
}

export const SEVERITY_ORDER: readonly Severity[] = ["critical", "warn", "info"];

/** Abschnitte in Reihenfolge des Leitungswegs (Filter "Abschnitt"). */
export const SEGMENT_ORDER: readonly Segment[] = ["client", "lan", "router", "docsis", "aftr", "isp", "internet", "game"];

/** Suchtext eines Ereignisses (Titel, Typname, Kontextzeile, Text-Details). */
export function searchText(e: NetEvent): string {
  const parts: string[] = [e.title, EVENT_TYPE_LABEL[e.type] ?? e.type];
  const detail = eventDetail(e);
  if (detail) parts.push(detail);
  if (e.details && typeof e.details === "object") {
    for (const v of Object.values(e.details)) if (typeof v === "string") parts.push(v);
  }
  return parts.join(" ").toLocaleLowerCase("de-DE");
}

/** Alle Suchwörter müssen vorkommen (Groß-/Kleinschreibung egal). */
export function matchesSearch(e: NetEvent, query: string): boolean {
  const words = query.toLocaleLowerCase("de-DE").split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const text = searchText(e);
  return words.every((w) => text.includes(w));
}
