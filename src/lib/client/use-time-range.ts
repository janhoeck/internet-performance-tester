/**
 * Zeitraum einer Seite, synchron mit der URL (teilbar, bleibt beim Neuladen erhalten).
 *
 *   const range = useTimeRange({ defaultPreset: "24h" });
 *   const url = range.query ? `/api/series?targets=gw,cf4&${range.query}` : null;
 *   const series = useApi<SeriesResponse>(url);
 *
 * URL: `?range=24h` | `?range=session[&session=<id>]` | `?range=custom&from=<ms>&to=<ms>`
 * (mit `param: "b"` für einen zweiten Zeitraum: `?b=7d&bFrom=…&bTo=…&bSession=…`).
 *
 * - Gleitende Zeiträume ("Letzte 24 Stunden") enden bei "jetzt" und rücken in groben Schritten
 *   weiter (1 h: 10 s, 6 h: 30 s, 24 h: 1 min, 7 T: 5 min, 30 T: 15 min) – jede neue URL lädt
 *   die Daten neu, die alten bleiben bis dahin stehen (useApi). Pausiert bei verborgenem Tab.
 * - `from`/`to` sind null, bis die Uhrzeit im Browser bzw. der Langzeittest bekannt ist
 *   (Server-Render/Hydration) – dann `useApi(null)` übergeben.
 * - Live-Zeiträume erzeugen je Tick eine neue URL: `<DataState dimKey={range.rangeKey}>` dimmt dann
 *   nur beim Wechsel des Zeitraums, nicht bei jedem Tick. Bei `noSession` gibt es nichts zu laden:
 *   `useApi(url, { enabled: !range.noSession })` (sonst gilt die null-URL als „lädt“).
 * - Ohne useSearchParams: kein Suspense nötig, Seiten bleiben statisch vorrenderbar.
 */
import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { SessionsResponse } from "@/lib/shared/api-types";
import type { TestSession } from "@/lib/shared/types";
import { fmtTimeRange } from "@/lib/format";
import { useNow } from "@/lib/use-now";
import { sessionTitle } from "./sessions";
import { useApi } from "./use-api";

export type RangePreset = "1h" | "6h" | "24h" | "7d" | "30d" | "session" | "custom";

export interface RangePresetDef {
  id: RangePreset;
  /** "Letzte 24 Stunden" */
  label: string;
  /** Kurzform für Segment-Buttons: "24 h" */
  short: string;
  /** Länge gleitender Zeiträume */
  ms?: number;
  /** Raster, in dem "jetzt" weiterrückt */
  tickMs: number;
}

const H = 3_600_000;
const D = 86_400_000;

export const RANGE_PRESETS: readonly RangePresetDef[] = [
  { id: "1h", label: "Letzte Stunde", short: "1 h", ms: H, tickMs: 10_000 },
  { id: "6h", label: "Letzte 6 Stunden", short: "6 h", ms: 6 * H, tickMs: 30_000 },
  { id: "24h", label: "Letzte 24 Stunden", short: "24 h", ms: D, tickMs: 60_000 },
  { id: "7d", label: "Letzte 7 Tage", short: "7 T", ms: 7 * D, tickMs: 5 * 60_000 },
  { id: "30d", label: "Letzte 30 Tage", short: "30 T", ms: 30 * D, tickMs: 15 * 60_000 },
  { id: "session", label: "Langzeittest", short: "Test", tickMs: 60_000 },
  { id: "custom", label: "Eigener Zeitraum", short: "Eigener", tickMs: 60_000 },
] as const;

export const RANGE_PRESET_BY_ID: Record<RangePreset, RangePresetDef> = Object.fromEntries(
  RANGE_PRESETS.map((p) => [p.id, p]),
) as Record<RangePreset, RangePresetDef>;

const isPreset = (v: string | null): v is RangePreset => v != null && v in RANGE_PRESET_BY_ID;

export interface TimeRange {
  preset: RangePreset;
  /** Beginn in epoch ms (null = noch unbekannt) */
  from: number | null;
  /** Ende in epoch ms (null = noch unbekannt) */
  to: number | null;
  /** endet bei "jetzt" und rückt weiter */
  live: boolean;
  /** from/to bekannt */
  ready: boolean;
  /** "from=…&to=…" zum Anhängen an API-URLs, sonst null */
  query: string | null;
  /** Anzeige: "Letzte 24 Stunden", "08.10., 18:29 – 09.10., 06:00", "Langzeittest „Neues Kabel“" */
  label: string;
  /** bei preset "session": der verwendete Langzeittest (aktiv oder zuletzt beendet) */
  session: TestSession | null;
  /** preset "session", aber es gibt noch keinen Langzeittest */
  noSession: boolean;
  /**
   * Stabiler Schlüssel der Auswahl (ändert sich nur, wenn der Nutzer den Zeitraum wechselt –
   * NICHT beim Weiterrücken gleitender Zeiträume), z. B. "24h", "custom:…-…", "session:12".
   * Für <DataState dimKey> und Diagramm-Animationen (<LatencySeriesChart animationKey>).
   */
  rangeKey: string;
  setPreset: (preset: RangePreset) => void;
  setCustom: (from: number, to: number) => void;
  /** bestimmten Langzeittest wählen (preset "session"); null = aktiver/letzter */
  setSession: (id: number | null) => void;
}

export interface UseTimeRangeOptions {
  defaultPreset?: RangePreset;
  /** Name des URL-Parameters (Standard "range"); für einen 2. Zeitraum z. B. "b" */
  param?: string;
}

/* -------------------------------------------------------------------------- */
/* URL als externer Store                                                      */
/* -------------------------------------------------------------------------- */

const URL_EVENT = "np:urlchange";

function subscribeUrl(onChange: () => void): () => void {
  window.addEventListener("popstate", onChange);
  window.addEventListener(URL_EVENT, onChange);
  // Navigation API (Chrome/Edge): meldet auch Next-<Link>-Navigationen mit neuer Query
  const nav = (window as Window & { navigation?: EventTarget }).navigation;
  nav?.addEventListener("currententrychange", onChange);
  return () => {
    window.removeEventListener("popstate", onChange);
    window.removeEventListener(URL_EVENT, onChange);
    nav?.removeEventListener("currententrychange", onChange);
  };
}
const getSearch = () => window.location.search;
const getServerSearch = () => "";

/** URL-Parameter setzen (null = entfernen), ohne Neuladen und ohne neuen Verlaufseintrag. */
export function setUrlParams(updates: Record<string, string | null>): void {
  const sp = new URLSearchParams(window.location.search);
  for (const [k, v] of Object.entries(updates)) {
    if (v === null) sp.delete(k);
    else sp.set(k, v);
  }
  const q = sp.toString();
  const url = `${window.location.pathname}${q ? `?${q}` : ""}${window.location.hash}`;
  window.history.replaceState(null, "", url);
  window.dispatchEvent(new Event(URL_EVENT));
}

/** Aktuelle Query als URLSearchParams (Server/Hydration: leer). */
export function useUrlSearch(): URLSearchParams {
  const search = useSyncExternalStore(subscribeUrl, getSearch, getServerSearch);
  return useMemo(() => new URLSearchParams(search), [search]);
}

function parseTime(v: string | null): number | null {
  if (!v) return null;
  const n = /^\d+$/.test(v) ? Number(v) : Date.parse(v);
  return Number.isFinite(n) ? n : null;
}

function pickSession(res: SessionsResponse | null, id: number | null): TestSession | null {
  if (!res) return null;
  const items = Array.isArray(res.items) ? res.items : [];
  if (id != null) {
    const hit = items.find((s) => s.id === id) ?? (res.active?.id === id ? res.active : null);
    if (hit) return hit;
    // unbekannte ID (z. B. Test gelöscht): wie ohne Auswahl
  }
  if (res.active) return res.active;
  return items.reduce<TestSession | null>((best, s) => (!best || s.startedAt > best.startedAt ? s : best), null);
}

/* -------------------------------------------------------------------------- */
/* Hook                                                                        */
/* -------------------------------------------------------------------------- */

export function useTimeRange(opts: UseTimeRangeOptions = {}): TimeRange {
  const { defaultPreset = "24h", param = "range" } = opts;
  const keys = useMemo(
    () =>
      param === "range"
        ? { preset: "range", from: "from", to: "to", session: "session" }
        : { preset: param, from: `${param}From`, to: `${param}To`, session: `${param}Session` },
    [param],
  );
  const sp = useUrlSearch();

  const rawPreset = sp.get(keys.preset);
  const customFrom = parseTime(sp.get(keys.from));
  const customTo = parseTime(sp.get(keys.to));
  const sessionId = parseTime(sp.get(keys.session));
  let preset: RangePreset = isPreset(rawPreset) ? rawPreset : defaultPreset;
  if (preset === "custom" && (customFrom == null || customTo == null || customTo <= customFrom)) preset = defaultPreset;
  const def = RANGE_PRESET_BY_ID[preset];

  const sessions = useApi<SessionsResponse>("/api/sessions", { refreshMs: 60_000, enabled: preset === "session" });
  const now = useNow(def.tickMs);

  const session = preset === "session" ? pickSession(sessions.data, sessionId) : null;
  const noSession = preset === "session" && sessions.data != null && session == null;

  let from: number | null = null;
  let to: number | null = null;
  let live = false;
  let label = def.label;
  if (def.ms != null) {
    live = true;
    if (now != null) {
      to = now;
      from = now - def.ms;
    }
  } else if (preset === "custom") {
    from = customFrom;
    to = customTo;
    if (from != null && to != null) label = fmtTimeRange(from, to);
  } else if (preset === "session") {
    if (session) {
      const running = session.status === "running" && session.endedAt == null;
      live = running;
      from = session.startedAt;
      to = running ? now : (session.endedAt ?? session.plannedEndAt ?? now);
      if (to != null && to < from) to = from;
      label = sessionTitle(session);
    } else if (noSession) {
      label = "Noch kein Langzeittest";
    }
  }
  const ready = from != null && to != null;

  const setPreset = useCallback(
    (p: RangePreset) => {
      if (p === "custom") return; // eigener Zeitraum nur über setCustom
      setUrlParams({ [keys.preset]: p, [keys.from]: null, [keys.to]: null, [keys.session]: null });
    },
    [keys],
  );
  const setCustom = useCallback(
    (f: number, t: number) => {
      const a = Math.min(f, t);
      const b = Math.max(f, t);
      setUrlParams({ [keys.preset]: "custom", [keys.from]: String(Math.round(a)), [keys.to]: String(Math.round(b)), [keys.session]: null });
    },
    [keys],
  );
  const setSession = useCallback(
    (id: number | null) => {
      setUrlParams({ [keys.preset]: "session", [keys.from]: null, [keys.to]: null, [keys.session]: id == null ? null : String(id) });
    },
    [keys],
  );

  return {
    preset,
    from,
    to,
    live,
    ready,
    query: ready ? `from=${from}&to=${to}` : null,
    rangeKey:
      preset === "custom"
        ? `custom:${customFrom}-${customTo}`
        : preset === "session"
          ? `session:${session?.id ?? sessionId ?? "auto"}`
          : preset,
    label,
    session,
    noSession,
    setPreset,
    setCustom,
    setSession,
  };
}
