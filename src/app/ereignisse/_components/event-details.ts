/**
 * Deutsche Detailzeilen je Ereignistyp für die aufklappbare Zeitleiste. Reine Funktionen:
 * NetEvent (+ Zielnamen) -> [{ label, value, numeric }].
 */
import type { NetEvent, OutageClass, TargetConfig } from "@/lib/shared/types";
import { EVENT_TYPE_LABEL, OUTAGE_CLASS_LABEL, eventSourceText, isOngoingEpisode } from "@/lib/client/adapters";
import { targetName } from "@/lib/client/targets";
import { SHARED_SEGMENT_LABEL } from "@/lib/segments";
import { fmtDateTime, fmtDurationMs, fmtInt, fmtLinkSpeed, fmtLossPct, fmtMbit, fmtMs, fmtNumber, fmtPct } from "@/lib/format";

export interface DetailRow {
  label: string;
  value: string;
  /** Messwert/Adresse/Zeit -> np-num */
  numeric?: boolean;
}

type Rec = Record<string, unknown>;

function rec(v: unknown): Rec {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : {};
}
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);

const LINK_CAUSE_LABEL: Record<string, string> = {
  boot: "Start/Aufwachen (normal)",
  pre_sleep: "vor Standby (normal)",
  router_reboot: "Router-Neustart",
  runtime: "im Betrieb",
};

const SPIKE_SEVERITY_LABEL: Record<string, string> = { minor: "leicht", major: "deutlich", severe: "stark" };

const DUPLEX_LABEL: Record<string, string> = { full: "Vollduplex", half: "Halbduplex" };

const SESSION_END_REASON: Record<string, string> = {
  planned: "geplantes Ende erreicht",
  manual: "von dir beendet",
  user: "von dir beendet",
  shutdown: "Mess-Engine beendet",
  crash: "Mess-Engine abgebrochen",
};

const DIR_LABEL: Record<string, string> = { US: "Upstream (Senderichtung)", DS: "Downstream (Empfangsrichtung)" };

function isOutageClass(v: unknown): v is OutageClass {
  return typeof v === "string" && v in OUTAGE_CLASS_LABEL;
}

function push(rows: DetailRow[], label: string, value: string | null | undefined, numeric = false): void {
  if (value != null && value !== "" && value !== "–") rows.push({ label, value, numeric });
}

function durationOf(e: NetEvent, d: Rec, key = "durationMs"): string | null {
  const ms = num(d[key]) ?? (e.endTs != null && e.endTs > e.ts ? e.endTs - e.ts : null);
  return ms != null ? fmtDurationMs(ms) : null;
}

const yesNo = (v: boolean | null, yes = "ja", no = "nein"): string | null => (v == null ? null : v ? yes : no);

function targetList(v: unknown, targets: readonly TargetConfig[]): string | null {
  if (!Array.isArray(v)) return null;
  const names = v.filter((x): x is string => typeof x === "string").map((id) => targetName(id, targets));
  return names.length ? names.join(", ") : null;
}

/* ------------------------------ je Typ ------------------------------ */

function linkDown(e: NetEvent, d: Rec, rows: DetailRow[]): void {
  const cause = str(d.cause);
  push(rows, "Ursache", cause ? (LINK_CAUSE_LABEL[cause] ?? cause) : "noch nicht eingeordnet");
  const ongoing = isOngoingEpisode(e);
  push(rows, "Ausfalldauer", ongoing ? "Link noch getrennt" : durationOf(e, d, "downtimeMs"), !ongoing);
  const relink = num(d.relinkMbps);
  if (relink != null) push(rows, "Wiederaufbau", `mit ${fmtLinkSpeed(relink)}${relink < 1000 ? " statt 1 Gbit/s" : ""}`, true);
  else if (d.final === true) push(rows, "Wiederaufbau", "keine Wiederverbindung erkannt");
  const failover = bool(d.wlanFailover);
  if (failover === true) push(rows, "WLAN-Ausweichen", "ja, Windows wich aufs WLAN aus");
  else if (d.wlanAlreadyConnected === true) push(rows, "WLAN-Ausweichen", "WLAN war bereits verbunden");
  else push(rows, "WLAN-Ausweichen", yesNo(failover));
  const inetDown = num(d.internetDownMs);
  if (inetDown != null) push(rows, "Internet unterbrochen", fmtDurationMs(inetDown), true);
  else if (d.internetOngoing === true) push(rows, "Internet unterbrochen", "noch unterbrochen");
  const more = num(d.moreDowns180s);
  if (more != null && more > 0) push(rows, "Weitere Abbrüche in 3 min", fmtInt(more), true);
  push(rows, "Duplex", DUPLEX_LABEL[str(d.duplex) ?? ""] ?? null);
  push(rows, "Adapter", str(d.adapter));
}

function linkUp(d: Rec, rows: DetailRow[]): void {
  const mbps = num(d.speedMbps) ?? num(d.relinkMbps);
  push(rows, "Geschwindigkeit", mbps != null ? `${fmtLinkSpeed(mbps)}${mbps < 1000 ? " (erwartet 1 Gbit/s)" : ""}` : null, true);
  push(rows, "Duplex", DUPLEX_LABEL[str(d.duplex) ?? ""] ?? str(d.duplex));
  push(rows, "Adapter", str(d.adapter));
}

function outage(e: NetEvent, d: Rec, rows: DetailRow[], targets: readonly TargetConfig[]): void {
  const c = d.classification;
  push(rows, "Einordnung", isOutageClass(c) ? OUTAGE_CLASS_LABEL[c] : "unklar");
  const first = d.initialClassification;
  if (isOutageClass(first) && first !== c) push(rows, "Erste Einordnung", OUTAGE_CLASS_LABEL[first]);
  if (isOngoingEpisode(e)) push(rows, "Dauer", "Ausfall läuft noch");
  else {
    const dur = durationOf(e, d);
    push(rows, "Dauer", dur ? `${d.interrupted === true ? "mind. " : ""}${dur}` : null, true);
  }
  push(rows, "Betroffene Ziele", targetList(d.lostTargets, targets));
  const rounds = num(d.rounds);
  if (rounds != null) push(rows, "Messrunden ohne Antwort", fmtInt(rounds), true);
  const last = num(d.lastSuccessTs);
  if (last != null) push(rows, "Letzte Antwort davor", fmtDateTime(last), true);
}

function spike(e: NetEvent, d: Rec, rows: DetailRow[], targets: readonly TargetConfig[]): void {
  const id = str(d.targetId);
  push(rows, "Ziel", id ? targetName(id, targets) : null);
  push(rows, "Spitze", fmtMs(num(d.peakMs)), true);
  push(rows, "Basis (normal)", fmtMs(num(d.baselineMs)), true);
  const sev = str(d.severity);
  push(rows, "Schwere", sev ? (SPIKE_SEVERITY_LABEL[sev] ?? sev) : null);
  const n = num(d.spikeSamples);
  if (n != null) push(rows, "Pings über der Schwelle", fmtInt(n), true);
  push(rows, "Dauer", isOngoingEpisode(e) ? null : durationOf(e, d), true);
  push(rows, "Hinweis", str(d.note) ?? str(d.hint));
}

function lossBurst(e: NetEvent, d: Rec, rows: DetailRow[], targets: readonly TargetConfig[]): void {
  const id = str(d.targetId);
  push(rows, "Ziel", id ? targetName(id, targets) : null);
  const lost = num(d.lost);
  const sent = num(d.sent);
  if (lost != null && sent != null) push(rows, "Verloren", `${fmtInt(lost)} von ${fmtInt(sent)}`, true);
  const run = num(d.maxRun);
  if (run != null) push(rows, "Längste Serie", `${fmtInt(run)} in Folge`, true);
  push(rows, "Dauer", durationOf(e, d), true);
}

function speedtest(d: Rec, rows: DetailRow[]): void {
  const grade = str(d.grade);
  push(rows, "Note (Bufferbloat)", grade ? `${grade}${str(d.gradeLabel) ? ` – ${str(d.gradeLabel)}` : ""}` : null, true);
  push(rows, "Download", fmtMbit(num(d.downMbps)), true);
  push(rows, "Upload", fmtMbit(num(d.upMbps)), true);
  push(rows, "Latenz im Leerlauf", fmtMs(num(d.idleLatencyMs)), true);
  push(rows, "Latenz beim Download", fmtMs(num(d.loadedDownLatencyMs)), true);
  push(rows, "Latenz beim Upload", fmtMs(num(d.loadedUpLatencyMs)), true);
  push(rows, "Server", str(d.server) ?? str(d.colo));
  const link = num(d.nicLinkMbps);
  if (link != null) push(rows, "Linkgeschwindigkeit", fmtLinkSpeed(link), true);
  if (d.limitedByLink === true) push(rows, "Begrenzt durch", "Linkgeschwindigkeit des PCs");
  push(rows, "Engpass", str(rec(d.bottleneck).text));
  const loss = rec(d.lossPct);
  const ll = [num(loss.idle), num(loss.download), num(loss.upload)];
  if (ll.some((v) => v != null && v > 0))
    push(rows, "Verlust Leerlauf/Download/Upload", `${fmtLossPct(ll[0])} / ${fmtLossPct(ll[1])} / ${fmtLossPct(ll[2])}`, true);
}

function routerLog(d: Rec, rows: DetailRow[]): void {
  push(rows, "Kategorie", str(d.category));
  push(rows, "Text", str(d.message));
  push(rows, "Router-Zeit", str(d.timeText), true);
  push(rows, "Stufe", str(d.level));
  const dir = str(d.dir);
  push(rows, "Richtung", dir ? (DIR_LABEL[dir] ?? dir) : null);
  push(rows, "CM-Status-Code", num(d.cmStatusCode) != null ? String(d.cmStatusCode) : str(d.cmStatusCode), true);
}

function sessionStart(d: Rec, rows: DetailRow[]): void {
  push(rows, "Schnittstelle", str(d.expectedIf) ?? str(d.primaryAdapter), true);
  push(rows, "Verbindungsart", yesNo(bool(d.isWifi), "WLAN", "Kabel"));
  const link = num(d.linkMbps);
  if (link != null) push(rows, "Link", fmtLinkSpeed(link), true);
  push(rows, "WLAN-Name", str(d.ssid));
  push(rows, "WLAN-Band", str(d.band));
  const ch = num(d.channel);
  if (ch != null) push(rows, "WLAN-Kanal", fmtInt(ch), true);
  const sig = num(d.signalPct);
  if (sig != null) push(rows, "WLAN-Signal", fmtPct(sig), true);
  const dur = num(d.durationMin);
  push(rows, "Geplante Dauer", dur != null ? fmtDurationMs(dur * 60_000) : "unbegrenzt", dur != null);
  if (d.resumed === true) push(rows, "Fortgesetzt", "ja, nach Neustart der Mess-Engine");
}

function sessionEnd(e: NetEvent, d: Rec, rows: DetailRow[]): void {
  const reason = str(d.reason);
  push(rows, "Grund", reason ? (SESSION_END_REASON[reason] ?? reason) : null);
  push(rows, "Dauer", durationOf(e, d), true);
}

function routeSwitch(d: Rec, rows: DetailRow[]): void {
  const fam = num(d.family);
  push(rows, "Protokoll", fam != null ? `IPv${fam}` : null, true);
  push(rows, "Vorher", str(d.from) ?? "keine Route", true);
  push(rows, "Jetzt", str(d.to) ?? "keine Route", true);
  push(rows, "Erwartete Schnittstelle", str(d.expectedIf), true);
  push(rows, "Quelladresse", str(d.sourceAddress), true);
  push(rows, "Nächster Hop", str(d.nextHop), true);
}

function wlan(d: Rec, rows: DetailRow[]): void {
  push(rows, "WLAN-Name", str(d.ssid));
  push(rows, "Grund", str(d.reason));
  push(rows, "Standard", str(d.phyType));
  push(rows, "Verschlüsselung", str(d.authentication));
  const sig = num(d.signalPct);
  if (sig != null) push(rows, "Signal", fmtPct(sig), true);
  push(rows, "Zugangspunkt (BSSID)", str(d.bssid), true);
}

/* ------------------------------ generisch ------------------------------ */

const KEY_LABEL: Record<string, string> = {
  targetId: "Ziel",
  kind: "Art",
  reason: "Grund",
  message: "Text",
  note: "Notiz",
  text: "Text",
  family: "Protokoll",
  from: "Vorher",
  to: "Jetzt",
  old: "Vorher",
  new: "Jetzt",
  previous: "Vorher",
  current: "Jetzt",
  ip: "IP-Adresse",
  address: "Adresse",
  mtu: "MTU",
  mapping: "NAT-Verhalten",
  durationMs: "Dauer",
  uptimeSec: "Laufzeit",
  process: "Programm",
  status: "Status",
  mode: "Modus",
  adapter: "Adapter",
  serviceName: "Treiber",
  speedMbps: "Geschwindigkeit",
  linkMbps: "Link",
  ssid: "WLAN-Name",
  bssid: "Zugangspunkt",
  error: "Fehler",
  pathHash: "Pfad-Kennung",
  hops: "Hops",
};

/** interne Felder, die niemandem helfen */
const HIDDEN_KEYS = new Set([
  "recordId",
  "upRecordId",
  "interfaceGuid",
  "connectionId",
  "eventId",
  "provider",
  "marker",
  "mergedInto",
  "final",
  "dedupeKey",
  "sessionId",
  "speedtestId",
  "imagePath",
]);

function genericValue(key: string, v: unknown, targets: readonly TargetConfig[]): { value: string; numeric: boolean } | null {
  if (v == null) return null;
  if (typeof v === "boolean") return { value: v ? "ja" : "nein", numeric: false };
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return null;
    if (/Ms$/.test(key)) return { value: key === "durationMs" || /down|time/i.test(key) ? fmtDurationMs(v) : fmtMs(v), numeric: true };
    if (/Mbps$/.test(key)) return { value: fmtMbit(v), numeric: true };
    if (/Pct$/.test(key)) return { value: fmtPct(v), numeric: true };
    if (/Sec$/.test(key)) return { value: fmtDurationMs(v * 1000), numeric: true };
    if (/Ts$/.test(key) || (v > 1e12 && v < 1e13)) return { value: fmtDateTime(v), numeric: true };
    if (key === "family") return { value: `IPv${v}`, numeric: true };
    return { value: fmtNumber(v, 2), numeric: true };
  }
  if (typeof v === "string") {
    if (key === "targetId") return { value: targetName(v, targets), numeric: false };
    const s = v.trim();
    return s ? { value: s.length > 240 ? `${s.slice(0, 239)}…` : s, numeric: /^[\d.:a-f%]+$/i.test(s) } : null;
  }
  if (Array.isArray(v)) {
    const prim = v.filter((x) => typeof x === "string" || typeof x === "number").map(String);
    return prim.length ? { value: prim.slice(0, 12).join(", ") + (prim.length > 12 ? ` und ${prim.length - 12} weitere` : ""), numeric: true } : null;
  }
  return null; // verschachtelte Objekte bleiben im CSV-Export
}

function generic(d: Rec, rows: DetailRow[], targets: readonly TargetConfig[]): void {
  for (const [k, v] of Object.entries(d)) {
    if (HIDDEN_KEYS.has(k)) continue;
    const f = genericValue(k, v, targets);
    if (f) push(rows, KEY_LABEL[k] ?? k, f.value, f.numeric);
  }
}

/** Detailzeilen eines Ereignisses (typabhängig) plus Zeit, Ende, Abschnitt und Quelle. */
export function eventDetailRows(e: NetEvent, targets: readonly TargetConfig[]): DetailRow[] {
  const d = rec(e.details);
  const rows: DetailRow[] = [];
  push(rows, "Art", EVENT_TYPE_LABEL[e.type] ?? e.type);
  push(rows, "Beginn", fmtDateTime(e.ts), true);
  if (e.endTs != null && e.endTs > e.ts) push(rows, "Ende", fmtDateTime(e.endTs), true);
  switch (e.type) {
    case "nic_link_down":
      linkDown(e, d, rows);
      break;
    case "nic_link_up":
      linkUp(d, rows);
      break;
    case "outage":
      outage(e, d, rows, targets);
      break;
    case "latency_spike":
      spike(e, d, rows, targets);
      break;
    case "loss_burst":
      lossBurst(e, d, rows, targets);
      break;
    case "speedtest":
      speedtest(d, rows);
      break;
    case "router_log":
      routerLog(d, rows);
      break;
    case "session_start":
      sessionStart(d, rows);
      break;
    case "session_end":
      sessionEnd(e, d, rows);
      break;
    case "route_switch":
      routeSwitch(d, rows);
      break;
    case "wlan_connect":
    case "wlan_disconnect":
    case "wlan_roam":
      wlan(d, rows);
      break;
    default:
      generic(d, rows, targets);
  }
  if (e.segment) push(rows, "Abschnitt", SHARED_SEGMENT_LABEL[e.segment]);
  push(rows, "Quelle", eventSourceText(e));
  return rows;
}

