/**
 * Live-Daten der Mess-Engine: EIN gemeinsamer EventSource auf /api/live für die ganze App.
 *
 *   const client = useLive(selectClient);                 // ≤ 4 Updates/s
 *   const samples = useLiveSamples("cf4");               // ≤ 1 Update/s (für Diagramme)
 *   const { online, status } = useLiveConnection();
 *
 * - Verbindet sich beim ersten Abonnenten (lazy), verbindet automatisch neu (SSE `retry` bzw.
 *   eigener Backoff, wenn die Route fehlt/abweist), schließt 30 s nach dem letzten Abonnenten.
 * - Nachrichten = JSON `LiveMessage` (src/lib/shared/types.ts), inkl. `offline` vom Next-Proxy.
 * - Zustand: Engine-Status, Verbindungskontext (client), Ringpuffer je Ziel (letzte 15 min),
 *   letzte 200 Ereignisse (neueste zuerst), Speedtest-Fortschritt, Router-Status, letzte Traceroute.
 * - Benachrichtigungen gedrosselt: Kanal "fast" ≤ 4/s (bei verborgenem Tab 1/s), "slow" ≤ 1/s.
 * - Nach dem ersten `hello` werden die Ringpuffer einmalig aus /api/series (Schritt 1 s) gefüllt.
 */
import { useMemo, useSyncExternalStore } from "react";
import type { RouterResponse, SeriesResponse } from "@/lib/shared/api-types";
import {
  SampleStatus,
  type ClientState,
  type EngineStatus,
  type LiveMessage,
  type MetricPoint,
  type NetEvent,
  type RouterStatus,
  type Sample,
  type SpeedtestProgress,
  type TestSession,
  type TracerouteResult,
} from "@/lib/shared/types";
import { fetchJson } from "./api";

export const LIVE_URL = "/api/live";
/** Länge der Ringpuffer je Ziel */
export const LIVE_WINDOW_MS = 15 * 60_000;
export const LIVE_MAX_EVENTS = 200;

/**
 * idle         – noch nie verbunden (Server-Render, vor dem ersten Abonnenten)
 * connecting   – erster Verbindungsaufbau
 * open         – Stream offen, Engine liefert Daten
 * reconnecting – Verbindung unterbrochen, neuer Versuch läuft
 * offline      – Next antwortet, aber die Mess-Engine ist nicht erreichbar (`offline`-Nachricht)
 * unavailable  – /api/live antwortet nicht (Route fehlt, Next-Fehler) – erneuter Versuch mit Backoff
 */
export type LiveConnectionStatus = "idle" | "connecting" | "open" | "reconnecting" | "offline" | "unavailable";

export interface LiveConnection {
  status: LiveConnectionStatus;
  /** Engine erreichbar und liefert Daten */
  online: boolean;
  /** seit wann nicht erreichbar (epoch ms) */
  since: number | null;
  /** deutsche Fehlerbeschreibung, wenn nicht erreichbar */
  error: string | null;
}

export interface LiveState {
  conn: LiveConnection;
  status: EngineStatus | null;
  /** laufender Langzeittest (aus status/hello und `session`-Nachrichten) */
  session: TestSession | null;
  client: ClientState | null;
  /** Ringpuffer je Ziel-ID, aufsteigend nach ts, letzte 15 min */
  samples: Readonly<Record<string, readonly Sample[]>>;
  /** neuester Sample-Zeitstempel über alle Ziele */
  lastSampleTs: number | null;
  /** letzte 200 Ereignisse, neueste zuerst */
  events: readonly NetEvent[];
  /** letzter Wert je Kennzahl */
  metrics: Readonly<Record<string, MetricPoint>>;
  speedtest: SpeedtestProgress | null;
  router: RouterStatus | null;
  lastTraceroute: TracerouteResult | null;
  /** Empfangszeit der letzten Nachricht (epoch ms) */
  lastMessageAt: number | null;
}

const EMPTY_SAMPLES: readonly Sample[] = Object.freeze([]) as readonly Sample[];

const INITIAL: LiveState = Object.freeze({
  conn: Object.freeze({ status: "idle", online: false, since: null, error: null }) as LiveConnection,
  status: null,
  session: null,
  client: null,
  samples: Object.freeze({}),
  lastSampleTs: null,
  events: Object.freeze([]) as readonly NetEvent[],
  metrics: Object.freeze({}),
  speedtest: null,
  router: null,
  lastTraceroute: null,
  lastMessageAt: null,
}) as LiveState;

/* -------------------------------------------------------------------------- */
/* Store mit gedrosselter Veröffentlichung                                     */
/* -------------------------------------------------------------------------- */

let current: LiveState = INITIAL; // immer aktuell
let publishedFast: LiveState = INITIAL; // ≤ 4/s
let publishedSlow: LiveState = INITIAL; // ≤ 1/s
const fastListeners = new Set<() => void>();
const slowListeners = new Set<() => void>();
let fastTimer: ReturnType<typeof setTimeout> | null = null;
let slowTimer: ReturnType<typeof setTimeout> | null = null;
let lastFastAt = 0;
let lastSlowAt = 0;

const FAST_MS = 250;
const FAST_HIDDEN_MS = 1000;
const SLOW_MS = 1000;

function hidden(): boolean {
  return typeof document !== "undefined" && document.hidden;
}

function flushFast(): void {
  fastTimer = null;
  lastFastAt = Date.now();
  if (publishedFast === current) return;
  publishedFast = current;
  for (const l of [...fastListeners]) l();
}

function flushSlow(): void {
  slowTimer = null;
  lastSlowAt = Date.now();
  if (publishedSlow === current) return;
  publishedSlow = current;
  for (const l of [...slowListeners]) l();
}

function schedulePublish(urgent = false): void {
  const now = Date.now();
  if (!fastTimer) {
    const gap = urgent ? 0 : hidden() ? FAST_HIDDEN_MS : FAST_MS;
    fastTimer = setTimeout(flushFast, Math.max(0, lastFastAt + gap - now));
  }
  if (!slowTimer) {
    const gap = urgent ? 0 : SLOW_MS;
    slowTimer = setTimeout(flushSlow, Math.max(0, lastSlowAt + gap - now));
  }
}

function update(patch: Partial<LiveState>, urgent = false): void {
  current = { ...current, ...patch };
  schedulePublish(urgent);
}

function setConn(patch: Partial<LiveConnection>, urgent = true): void {
  const next = { ...current.conn, ...patch };
  const c = current.conn;
  if (next.status === c.status && next.online === c.online && next.since === c.since && next.error === c.error) return;
  update({ conn: next }, urgent);
}

/* -------------------------------------------------------------------------- */
/* Reduzierer                                                                  */
/* -------------------------------------------------------------------------- */

/** Zwei aufsteigend sortierte Sample-Listen zusammenführen (gleicher ts: neu gewinnt). */
export function mergeSamples(existing: readonly Sample[], incoming: readonly Sample[]): Sample[] {
  if (incoming.length === 0) return existing.slice();
  if (existing.length === 0 || incoming[0].ts > existing[existing.length - 1].ts) return existing.concat(incoming);
  const out: Sample[] = [];
  let i = 0;
  let j = 0;
  while (i < existing.length || j < incoming.length) {
    const a = existing[i];
    const b = incoming[j];
    if (b === undefined || (a !== undefined && a.ts < b.ts)) {
      out.push(a);
      i++;
    } else if (a === undefined || b.ts < a.ts) {
      out.push(b);
      j++;
    } else {
      out.push(b);
      i++;
      j++;
    }
  }
  return out;
}

function firstIndexAtOrAfter(arr: readonly Sample[], ts: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid].ts < ts) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function isSample(v: unknown): v is Sample {
  if (!v || typeof v !== "object") return false;
  const s = v as Record<string, unknown>;
  return typeof s.ts === "number" && typeof s.targetId === "string" && (s.rtt === null || typeof s.rtt === "number");
}

function addSamples(batch: readonly unknown[]): void {
  const byTarget = new Map<string, Sample[]>();
  let maxTs = current.lastSampleTs ?? 0;
  for (const raw of batch) {
    if (!isSample(raw)) continue;
    let list = byTarget.get(raw.targetId);
    if (!list) byTarget.set(raw.targetId, (list = []));
    list.push(raw);
    if (raw.ts > maxTs) maxTs = raw.ts;
  }
  if (byTarget.size === 0) return;
  const cutoff = maxTs - LIVE_WINDOW_MS;
  const next: Record<string, readonly Sample[]> = {};
  for (const [id, arr] of Object.entries(current.samples)) {
    const start = arr.length && arr[0].ts < cutoff ? firstIndexAtOrAfter(arr, cutoff) : 0;
    if (start >= arr.length && !byTarget.has(id)) continue; // Ziel liefert nichts mehr
    next[id] = start > 0 ? arr.slice(start) : arr;
  }
  for (const [id, list] of byTarget) {
    list.sort((a, b) => a.ts - b.ts);
    const merged = mergeSamples(next[id] ?? EMPTY_SAMPLES, list);
    const start = merged.length && merged[0].ts < cutoff ? firstIndexAtOrAfter(merged, cutoff) : 0;
    next[id] = start > 0 ? merged.slice(start) : merged;
  }
  update({ samples: next, lastSampleTs: maxTs || null });
}

function eventKey(e: NetEvent): string {
  return e.id != null ? `id:${e.id}` : `${e.type}|${e.ts}|${e.title}`;
}

function addEvent(e: unknown): void {
  if (!e || typeof e !== "object") return;
  const ev = e as NetEvent;
  if (typeof ev.ts !== "number" || typeof ev.type !== "string") return;
  const key = eventKey(ev);
  const rest = current.events.filter((x) => eventKey(x) !== key);
  const next = [ev, ...rest].sort((a, b) => b.ts - a.ts).slice(0, LIVE_MAX_EVENTS);
  update({ events: next }, true);
}

function applyStatus(s: EngineStatus | null | undefined): void {
  if (!s || typeof s !== "object") return;
  update(
    {
      status: s,
      session: s.session ?? null,
      client: s.client ?? current.client,
      speedtest: s.speedtest ?? current.speedtest,
    },
    current.status === null,
  );
}

let backfilled = false;

function handleMessage(raw: string): void {
  let msg: LiveMessage;
  try {
    msg = JSON.parse(raw) as LiveMessage;
  } catch {
    return;
  }
  if (!msg || typeof msg !== "object" || typeof msg.type !== "string") return;
  const now = Date.now();
  current = { ...current, lastMessageAt: now };
  armWatchdog();
  clearGrace();

  if (msg.type === "offline") {
    const since = typeof msg.data?.since === "number" ? msg.data.since : now;
    setConn({ status: "offline", online: false, since, error: msg.data?.error || "Mess-Engine nicht erreichbar" });
    return;
  }
  // auch nach kurzer Unterbrechung (innerhalb der Gnadenfrist, online blieb true) wieder "open"
  if (current.conn.status !== "open" || !current.conn.online) setConn({ status: "open", online: true, since: null, error: null });

  switch (msg.type) {
    case "hello":
      applyStatus(msg.data);
      if (!backfilled) {
        backfilled = true;
        void backfill(msg.data);
        void backfillRouter();
      }
      break;
    case "status":
      applyStatus(msg.data);
      break;
    case "samples":
      if (Array.isArray(msg.data)) addSamples(msg.data);
      break;
    case "event":
      addEvent(msg.data);
      break;
    case "metrics":
      if (Array.isArray(msg.data)) {
        const metrics = { ...current.metrics };
        for (const p of msg.data) if (p && typeof p.key === "string") metrics[p.key] = p;
        update({ metrics });
      }
      break;
    case "speedtest":
      update({ speedtest: msg.data ?? null }, true);
      break;
    case "traceroute":
      update({ lastTraceroute: msg.data ?? null });
      break;
    case "router":
      routerFromLive = true;
      update({ router: msg.data ?? null });
      break;
    case "session":
      update({ session: msg.data ?? null, status: current.status ? { ...current.status, session: msg.data ?? null } : null }, true);
      break;
    case "client":
      update({ client: msg.data ?? null });
      break;
    default:
      break;
  }
}

let routerFromLive = false;

/** Router-Status einmalig aus GET /api/router holen (Live-Nachrichten kommen nur alle 60–300 s). */
async function backfillRouter(): Promise<void> {
  try {
    const to = Date.now();
    const res = await fetchJson<RouterResponse>(`/api/router?from=${to - 15 * 60_000}&to=${to}`, { timeoutMs: 15_000 });
    // eine inzwischen eingetroffene Live-Nachricht gewinnt
    if (!routerFromLive && res && typeof res === "object" && res.status) update({ router: res.status }, true);
  } catch {
    /* Router-API (noch) nicht verfügbar – Status kommt mit der nächsten Live-Nachricht */
  }
}

/** Ringpuffer einmalig mit den letzten 15 Minuten aus der Datenbank füllen (falls die API schon existiert). */
async function backfill(s: EngineStatus): Promise<void> {
  const targets = (s.probes ?? []).map((p) => p.targetId).filter(Boolean);
  if (targets.length === 0) return;
  const to = Date.now();
  const from = to - LIVE_WINDOW_MS;
  try {
    const res = await fetchJson<SeriesResponse>(
      `/api/series?targets=${encodeURIComponent(targets.join(","))}&from=${from}&to=${to}&step=1000`,
      { timeoutMs: 15_000 },
    );
    const batch: Sample[] = [];
    for (const [targetId, d] of Object.entries(res?.series ?? {})) {
      if (!d || !Array.isArray(d.ts)) continue;
      for (let i = 0; i < d.ts.length; i++) {
        if (!(d.sent?.[i] > 0)) continue;
        const rtt = d.avg?.[i] ?? null;
        batch.push({ ts: d.ts[i], targetId, rtt, status: rtt == null ? SampleStatus.TIMEOUT : SampleStatus.OK });
      }
    }
    // Live-Samples, die inzwischen ankamen, gewinnen (mergeSamples: gleicher ts -> neu gewinnt)
    if (batch.length) {
      const live = current.samples;
      addSamples(batch);
      const restored: Record<string, readonly Sample[]> = { ...current.samples };
      for (const [id, arr] of Object.entries(live)) restored[id] = mergeSamples(restored[id] ?? EMPTY_SAMPLES, arr);
      update({ samples: restored }, true);
    }
  } catch {
    /* API noch nicht verfügbar – Puffer füllen sich live */
  }
}

/* -------------------------------------------------------------------------- */
/* Verbindung                                                                  */
/* -------------------------------------------------------------------------- */

let es: EventSource | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let closeTimer: ReturnType<typeof setTimeout> | null = null;
let watchdogTimer: ReturnType<typeof setTimeout> | null = null;
let graceTimer: ReturnType<typeof setTimeout> | null = null;
let failures = 0;
const BACKOFF_MS = [2_000, 5_000, 10_000, 20_000, 30_000];
/** ohne Nachricht (status alle 5 s, client 1 Hz) gilt die Verbindung als hängend */
const WATCHDOG_MS = 20_000;
/** Stream abgebrochen und nach dieser Frist keine neue Nachricht -> "nicht erreichbar" */
const GRACE_MS = 5_000;
const CLOSE_AFTER_MS = 30_000;

function clearGrace(): void {
  if (graceTimer) clearTimeout(graceTimer);
  graceTimer = null;
}

/** Kurze Unterbrechungen (Neustart des Dev-Servers) nicht sofort als Ausfall melden. */
function armGrace(): void {
  if (graceTimer) return;
  graceTimer = setTimeout(() => {
    graceTimer = null;
    const st = current.conn.status;
    if (st === "connecting") {
      setConn({ status: "unavailable", online: false, since: Date.now(), error: "Server nicht erreichbar. Läuft die Mess-Engine? (Start: npm run dev bzw. npm run start:all)" });
    } else if (st === "reconnecting") {
      setConn({ online: false, since: current.lastMessageAt ?? Date.now(), error: "Verbindung zur Mess-Engine unterbrochen" });
    }
  }, GRACE_MS);
}

function armWatchdog(): void {
  if (watchdogTimer) clearTimeout(watchdogTimer);
  watchdogTimer = setTimeout(() => {
    watchdogTimer = null;
    if (!es) return;
    setConn({
      status: "reconnecting",
      online: false,
      since: current.lastMessageAt ?? Date.now(),
      error: "Keine Daten von der Mess-Engine",
    });
    // hängenden Stream schließen und neu aufbauen
    es.close();
    es = null;
    connect();
  }, WATCHDOG_MS);
}

function connect(): void {
  if (es || typeof window === "undefined" || typeof EventSource === "undefined") return;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  const st = current.conn.status;
  if (st === "idle") setConn({ status: "connecting" });
  else if (st === "open") setConn({ status: "reconnecting" });

  const source = new EventSource(LIVE_URL);
  es = source;
  source.onopen = () => {
    failures = 0;
  };
  source.onmessage = (ev: MessageEvent<string>) => {
    if (es === source) handleMessage(ev.data);
  };
  source.onerror = () => {
    if (es !== source) return;
    if (source.readyState === EventSource.CLOSED) {
      // dauerhaft abgewiesen (HTTP-Fehler / falscher Content-Type, z. B. Route noch nicht gebaut)
      source.close();
      es = null;
      setConn({
        status: "unavailable",
        online: false,
        since: current.conn.since ?? Date.now(),
        error: "Live-Stream nicht verfügbar (/api/live)",
      });
      const delay = BACKOFF_MS[Math.min(failures, BACKOFF_MS.length - 1)];
      failures++;
      reconnectTimer = setTimeout(connect, delay);
    } else if (current.conn.status !== "offline") {
      // Browser verbindet selbst neu (SSE `retry`); nach GRACE_MS ohne Nachricht -> nicht erreichbar
      setConn({ status: current.conn.online ? "reconnecting" : current.conn.status === "idle" ? "connecting" : current.conn.status });
      armGrace();
    }
  };
  armWatchdog();
}

function disconnect(): void {
  if (es) es.close();
  es = null;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (watchdogTimer) clearTimeout(watchdogTimer);
  clearGrace();
  reconnectTimer = null;
  watchdogTimer = null;
}

function retain(): void {
  if (closeTimer) {
    clearTimeout(closeTimer);
    closeTimer = null;
  }
  connect();
}

function release(): void {
  if (fastListeners.size + slowListeners.size > 0 || closeTimer) return;
  closeTimer = setTimeout(() => {
    closeTimer = null;
    if (fastListeners.size + slowListeners.size === 0) disconnect();
  }, CLOSE_AFTER_MS);
}

/** Abonnieren ohne React (Kanal "fast" ≤ 4/s oder "slow" ≤ 1/s). Startet die Verbindung. */
export function subscribeLive(onChange: () => void, rate: "fast" | "slow" = "fast"): () => void {
  const set = rate === "slow" ? slowListeners : fastListeners;
  set.add(onChange);
  retain();
  return () => {
    set.delete(onChange);
    release();
  };
}

const subscribeFast = (cb: () => void) => subscribeLive(cb, "fast");
const subscribeSlow = (cb: () => void) => subscribeLive(cb, "slow");
const getFast = () => publishedFast;
const getSlow = () => publishedSlow;

/** Aktueller (ungedrosselter) Zustand – für Event-Handler. */
export function getLiveState(): LiveState {
  return current;
}

/**
 * Ereignis sofort in den Live-Zustand übernehmen (z. B. die Antwort von addNote() bei
 * "Lag markieren"), ohne auf die Live-Nachricht der Engine zu warten. Doppelte werden zusammengeführt.
 */
export function pushLiveEvent(e: NetEvent): void {
  addEvent(e);
}

/** Sofort neu verbinden (z. B. Button "Erneut verbinden"). */
export function reconnectLive(): void {
  failures = 0;
  disconnect();
  connect();
}

/* -------------------------------------------------------------------------- */
/* React-Hooks                                                                 */
/* -------------------------------------------------------------------------- */

export interface UseLiveOptions<T> {
  /** "fast" (Standard, ≤ 4/s) oder "slow" (≤ 1/s – für Diagramme/teure Ableitungen) */
  rate?: "fast" | "slow";
  /** Gleichheit der Auswahl (Standard Object.is); gleiche Auswahl = kein Re-Render */
  isEqual?: (a: T, b: T) => boolean;
}

function memoSelector<T>(selector: (s: LiveState) => T, isEqual: (a: T, b: T) => boolean) {
  let hasValue = false;
  let lastState: LiveState | null = null;
  let lastValue: T;
  return (s: LiveState): T => {
    if (hasValue && s === lastState) return lastValue;
    const next = selector(s);
    lastState = s;
    if (hasValue && isEqual(lastValue, next)) return lastValue;
    hasValue = true;
    lastValue = next;
    return next;
  };
}

/**
 * Teil des Live-Zustands abonnieren. Selektoren möglichst als stabile Funktionen
 * (außerhalb der Komponente oder useCallback) definieren; sie dürfen abgeleitete Objekte
 * liefern, wenn `isEqual` passt.
 */
export function useLive<T>(selector: (s: LiveState) => T, opts: UseLiveOptions<T> = {}): T {
  const slow = opts.rate === "slow";
  const isEqual = opts.isEqual ?? Object.is;
  const select = useMemo(() => memoSelector(selector, isEqual), [selector, isEqual]);
  return useSyncExternalStore(
    slow ? subscribeSlow : subscribeFast,
    () => select(slow ? getSlow() : getFast()),
    () => select(INITIAL),
  );
}

export const selectConnection = (s: LiveState): LiveConnection => s.conn;
export const selectStatus = (s: LiveState): EngineStatus | null => s.status;
export const selectSession = (s: LiveState): TestSession | null => s.session;
export const selectClient = (s: LiveState): ClientState | null => s.client;
export const selectSamples = (s: LiveState): Readonly<Record<string, readonly Sample[]>> => s.samples;
export const selectEvents = (s: LiveState): readonly NetEvent[] => s.events;
export const selectSpeedtest = (s: LiveState): SpeedtestProgress | null => s.speedtest;
export const selectRouter = (s: LiveState): RouterStatus | null => s.router;
export const selectLastTraceroute = (s: LiveState): TracerouteResult | null => s.lastTraceroute;
export const selectMetrics = (s: LiveState): Readonly<Record<string, MetricPoint>> => s.metrics;

/** Verbindungszustand: { status, online, since, error } */
export const useLiveConnection = (): LiveConnection => useLive(selectConnection);
/** Letzter EngineStatus (hello/status, alle 5 s) – auch wenn offline (dann veraltet). */
export const useEngineStatus = (): EngineStatus | null => useLive(selectStatus);
/** Laufender Langzeittest oder null */
export const useSession = (): TestSession | null => useLive(selectSession);
/** Verbindungskontext des PCs (1 Hz): Link, Ausgangsschnittstelle, eigener Durchsatz */
export const useClientState = (): ClientState | null => useLive(selectClient);
/** Letzte 200 Ereignisse seit dem Laden der Seite (neueste zuerst) */
export const useLiveEvents = (): readonly NetEvent[] => useLive(selectEvents);
export const useSpeedtestProgress = (): SpeedtestProgress | null => useLive(selectSpeedtest);
export const useRouterLive = (): RouterStatus | null => useLive(selectRouter);
export const useLastTraceroute = (): TracerouteResult | null => useLive(selectLastTraceroute);
/** Alle Ringpuffer (≤ 1 Update/s) */
export const useLiveSampleMap = (): Readonly<Record<string, readonly Sample[]>> => useLive(selectSamples, { rate: "slow" });

/** Ringpuffer eines Ziels (letzte 15 min, aufsteigend), ≤ 1 Update/s. */
export function useLiveSamples(targetId: string): readonly Sample[] {
  const selector = useMemo(() => (s: LiveState) => s.samples[targetId] ?? EMPTY_SAMPLES, [targetId]);
  return useLive(selector, { rate: "slow" });
}

/** Letzter Wert einer Kennzahl (z. B. "sys.cpu_pct") oder null. */
export function useLiveMetric(key: string): MetricPoint | null {
  const selector = useMemo(() => (s: LiveState) => s.metrics[key] ?? null, [key]);
  return useLive(selector);
}
