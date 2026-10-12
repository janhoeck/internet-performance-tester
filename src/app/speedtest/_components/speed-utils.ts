/**
 * Hilfen für die Speedtest-Seite: Ereignis-Details (speedtest-Event) lesen, Labels, Bewertungen.
 * Reine Funktionen ohne React – nur von Client-Komponenten dieser Route importiert.
 */
import type { Health } from "@/lib/health";
import type { NetEvent, SpeedPhase, SpeedtestResult } from "@/lib/shared/types";

export const PHASE_LABEL: Record<SpeedPhase, string> = {
  idle: "Leerlauf",
  download: "Download",
  upload: "Upload",
  done: "Fertig",
  error: "Fehler",
};

const LAYER_LABEL: Record<string, string> = {
  gw: "Router (Vodafone Station)",
  isp6: "Kopfstation (CMTS, 1. IPv6-Hop)",
  aftr: "DS-Lite-Gateway (AFTR)",
  cf4: "Cloudflare (Ping IPv4)",
  udp: "Cloudflare (UDP wie Spieleverkehr)",
};
const LAYER_ORDER = ["gw", "isp6", "aftr", "cf4", "udp"] as const;

export interface BottleneckInfo {
  layer: string | null;
  label: string;
  phase: "download" | "upload" | null;
  riseMs: number | null;
  text: string | null;
}

export interface LayerRow {
  id: string;
  label: string;
  idleMs: number | null;
  downloadMs: number | null;
  uploadMs: number | null;
}

export interface SpeedEventInfo {
  limitedByLink: boolean | null;
  /** true, wenn das Ereignis überhaupt ein bottleneck-Feld hat (null = kein Engpass gefunden) */
  hasBottleneckField: boolean;
  bottleneck: BottleneckInfo | null;
  gradeIncreaseMs: number | null;
  gradePhase: "download" | "upload" | null;
  pop: string | null;
  latencySource: string | null;
  layers: LayerRow[];
  aborted: boolean;
  rateLimited: boolean;
}

function rec(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}
function phaseOf(v: unknown): "download" | "upload" | null {
  return v === "download" || v === "upload" ? v : null;
}

export function speedEventInfo(e: NetEvent | null | undefined): SpeedEventInfo | null {
  const d = rec(e?.details);
  if (!d) return null;
  const b = rec(d.bottleneck);
  const layersRec = rec(d.layers);
  const layers: LayerRow[] = [];
  if (layersRec) {
    for (const id of LAYER_ORDER) {
      const l = rec(layersRec[id]);
      if (!l) continue;
      const row = { id, label: LAYER_LABEL[id] ?? id, idleMs: num(l.idleMs), downloadMs: num(l.downloadMs), uploadMs: num(l.uploadMs) };
      if (row.idleMs !== null || row.downloadMs !== null || row.uploadMs !== null) layers.push(row);
    }
  }
  return {
    limitedByLink: typeof d.limitedByLink === "boolean" ? d.limitedByLink : null,
    hasBottleneckField: "bottleneck" in d,
    bottleneck: b
      ? {
          layer: str(b.layer),
          label: str(b.label) ?? "Unbekannter Abschnitt",
          phase: phaseOf(b.phase),
          riseMs: num(b.riseMs),
          text: str(b.text),
        }
      : null,
    gradeIncreaseMs: num(d.gradeIncreaseMs),
    gradePhase: phaseOf(d.gradePhase),
    pop: str(d.pop),
    latencySource: str(d.latencySource),
    layers,
    aborted: d.aborted === true,
    rateLimited: d.rateLimited === true,
  };
}

/** speedtest-Ereignisse nach details.speedtestId (Fallback: Startzeit) nachschlagen. */
export interface SpeedEventIndex {
  get(r: Pick<SpeedtestResult, "id" | "ts">): NetEvent | null;
}

export function indexSpeedEvents(events: readonly NetEvent[] | null | undefined): SpeedEventIndex {
  const byId = new Map<number, NetEvent>();
  const byTs = new Map<number, NetEvent>();
  for (const e of events ?? []) {
    if (e.type !== "speedtest") continue;
    const id = num(rec(e.details)?.speedtestId);
    if (id !== null && !byId.has(id)) byId.set(id, e);
    if (!byTs.has(e.ts)) byTs.set(e.ts, e);
  }
  return {
    get: (r) => (r.id != null ? byId.get(r.id) : undefined) ?? byTs.get(r.ts) ?? null,
  };
}

/** Test hat Messwerte (nicht komplett fehlgeschlagen). */
export function hasThroughput(r: Pick<SpeedtestResult, "downMbps" | "upMbps">): boolean {
  return r.downMbps !== null || r.upMbps !== null;
}

/** Anteil am Tarif in % (null ohne Tarif). */
export function tariffPct(value: number | null, tariff: number | null | undefined): number | null {
  if (value === null || tariff == null || !(tariff > 0)) return null;
  return (value / tariff) * 100;
}

/** ab 80 % des Tarifs gut, ab 50 % auffällig, darunter kritisch. */
export function rateTariff(pct: number | null): Health {
  if (pct === null) return "unknown";
  if (pct >= 80) return "good";
  if (pct >= 50) return "warn";
  return "crit";
}

export const TRIGGER_LABEL: Record<SpeedtestResult["trigger"], string> = {
  schedule: "geplant",
  manual: "manuell",
};

/** Lokale Stunde (Europe/Berlin) für die Ruhezeit-Anzeige. */
const dfHour = new Intl.DateTimeFormat("de-DE", { hour: "numeric", hourCycle: "h23", timeZone: "Europe/Berlin" });
export function berlinHour(ts: number): number {
  return Number(dfHour.format(ts));
}

/** Gleiche Logik wie die Engine (speed-schedule.ts): [from, to), über Mitternacht möglich. */
export function inQuietHours(hour: number, q: { from: number; to: number } | null | undefined): boolean {
  if (!q || q.from === q.to) return false;
  return q.from < q.to ? hour >= q.from && hour < q.to : hour >= q.from || hour < q.to;
}
