/**
 * useApi – kleiner, geteilter Daten-Cache für GET-Anfragen an die Next-API (Stale-while-revalidate).
 *
 *   const { data, error, loading, stale, reload } = useApi<StatusResponse>("/api/status", { refreshMs: 30_000 });
 *
 * - Gleiche URL = eine Anfrage, egal wie viele Komponenten sie nutzen.
 * - Neuladen im Intervall (`refreshMs`, pausiert bei verborgenem Tab) und beim Zurückkehren ins Fenster.
 * - Beim Nachladen und beim Wechsel der URL (z. B. anderer Zeitraum) bleiben die letzten Daten
 *   stehen (`stale = true`) – kein Flackern. Fehler lassen vorhandene Daten ebenfalls stehen.
 * - `url = null` = noch nichts laden, aber als „lädt“ melden (`loading: true`) – z. B. solange
 *   `from`/`to` beim Server-Render/der Hydration noch fehlen. So zeigt <DataState> den Ladezustand
 *   statt „Keine Daten“.
 * - `enabled: false` (ausdrücklich) = nichts laden, Ruhezustand (`loading: false`), z. B. wenn es
 *   gar nichts zu laden gibt (`enabled: !range.noSession`).
 * Hält sich an die React-Lint-Regeln: kein setState in Effekten, kein Date.now() im Render.
 */
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { ApiFailure, errorMessage, fetchJson, isAbortError } from "./api";

export interface ApiSnapshot<T> {
  data: T | null;
  error: ApiFailure | null;
  /** eine Anfrage läuft (auch beim Nachladen mit vorhandenen Daten) */
  loading: boolean;
  /** Zeitpunkt der letzten erfolgreichen Antwort (epoch ms) */
  updatedAt: number | null;
}

export interface UseApiResult<T> extends ApiSnapshot<T> {
  /** angezeigte Daten sind nicht (mehr) aktuell: gehören zur vorherigen URL oder werden gerade neu geladen */
  stale: boolean;
  /** `data` stammt von der vorherigen URL (neue Daten laden noch) */
  isPrevious: boolean;
  /** sofort neu laden (bricht eine laufende Anfrage ab) */
  reload: () => void;
}

export interface UseApiOptions {
  /** Intervall für automatisches Neuladen in ms (0 = aus). Pausiert, solange der Tab verborgen ist. */
  refreshMs?: number;
  /** false = nichts laden (Ruhezustand, `loading: false`). Eine `null`-URL ohne `enabled: false` gilt als „lädt“. */
  enabled?: boolean;
  /** letzte Daten beim URL-Wechsel stehen lassen (Standard: true) */
  keepPreviousData?: boolean;
}

interface Entry {
  key: string;
  snap: ApiSnapshot<unknown>;
  listeners: Set<() => void>;
  /** Intervall je Abonnent (das kleinste gewinnt) */
  intervals: Map<() => void, number>;
  controller: AbortController | null;
  timer: ReturnType<typeof setTimeout> | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  lastFetch: number;
  invalid: boolean;
}

const DEDUPE_MS = 2_000;
const FOCUS_REVALIDATE_MS = 5_000;
const IDLE_ABORT_MS = 1_000;
const GC_MS = 5 * 60_000;
const MAX_ENTRIES = 200;

const PENDING: ApiSnapshot<unknown> = Object.freeze({ data: null, error: null, loading: true, updatedAt: null });
const IDLE: ApiSnapshot<unknown> = Object.freeze({ data: null, error: null, loading: false, updatedAt: null });

const entries = new Map<string, Entry>();
let globalListenersInstalled = false;

function getEntry(key: string): Entry {
  let e = entries.get(key);
  if (!e) {
    e = {
      key,
      snap: PENDING,
      listeners: new Set(),
      intervals: new Map(),
      controller: null,
      timer: null,
      idleTimer: null,
      lastFetch: 0,
      invalid: false,
    };
    entries.set(key, e);
    gcEntries();
  }
  return e;
}

function gcEntries(): void {
  if (entries.size <= MAX_ENTRIES) return;
  for (const [k, e] of entries) {
    if (entries.size <= MAX_ENTRIES) break;
    if (e.listeners.size === 0 && !e.controller) entries.delete(k);
  }
}

const RANGE_GC_MS = 20_000;
const MAX_IDLE_RANGE_ENTRIES = 20;
const RANGE_KEY_RE = /[?&](from|to)=\d/;

function isRangeKey(key: string): boolean {
  return RANGE_KEY_RE.test(key);
}

/** Höchstens ~20 abonnentenlose Zeitraum-Einträge behalten (älteste zuerst verwerfen). */
function capRangeEntries(): void {
  const idle: Entry[] = [];
  for (const e of entries.values()) if (e.listeners.size === 0 && !e.controller && isRangeKey(e.key)) idle.push(e);
  for (let i = 0; i < idle.length - MAX_IDLE_RANGE_ENTRIES; i++) {
    const e = idle[i];
    if (e.idleTimer) clearTimeout(e.idleTimer);
    if (e.timer) clearTimeout(e.timer);
    entries.delete(e.key);
  }
}

function setSnap(e: Entry, next: ApiSnapshot<unknown>): void {
  e.snap = next;
  for (const l of [...e.listeners]) l();
}

function interval(e: Entry): number {
  let min = 0;
  for (const ms of e.intervals.values()) if (ms > 0 && (min === 0 || ms < min)) min = ms;
  return min;
}

function schedule(e: Entry): void {
  if (e.timer) clearTimeout(e.timer);
  e.timer = null;
  const ms = interval(e);
  if (ms <= 0 || e.listeners.size === 0) return;
  if (typeof document !== "undefined" && document.hidden) return; // beim Sichtbarwerden neu laden
  e.timer = setTimeout(() => revalidate(e, false), ms);
}

function revalidate(e: Entry, force: boolean): void {
  if (e.controller) {
    if (!force) return;
    e.controller.abort();
  }
  if (e.timer) clearTimeout(e.timer);
  e.timer = null;
  const ctrl = new AbortController();
  e.controller = ctrl;
  e.lastFetch = Date.now();
  e.invalid = false;
  if (!e.snap.loading) setSnap(e, { ...e.snap, loading: true });
  fetchJson<unknown>(e.key, { signal: ctrl.signal })
    .then(
      (data) => {
        if (e.controller !== ctrl) return;
        e.controller = null;
        setSnap(e, { data: data ?? null, error: null, loading: false, updatedAt: Date.now() });
      },
      (err: unknown) => {
        if (e.controller !== ctrl) return;
        e.controller = null;
        if (isAbortError(err)) {
          setSnap(e, { ...e.snap, loading: false });
          return;
        }
        const failure = err instanceof ApiFailure ? err : new ApiFailure(errorMessage(err), 0);
        setSnap(e, { data: e.snap.data, error: failure, loading: false, updatedAt: e.snap.updatedAt });
      },
    )
    .finally(() => {
      if (e.controller === null) schedule(e);
    });
}

function installGlobalListeners(): void {
  if (globalListenersInstalled || typeof window === "undefined") return;
  globalListenersInstalled = true;
  const onActive = () => {
    if (document.hidden) return;
    const now = Date.now();
    for (const e of entries.values()) {
      if (e.listeners.size === 0) continue;
      if (e.invalid || now - e.lastFetch > FOCUS_REVALIDATE_MS) revalidate(e, false);
      else schedule(e);
    }
  };
  window.addEventListener("focus", onActive);
  document.addEventListener("visibilitychange", onActive);
}

function subscribeKey(key: string, refreshMs: number, onChange: () => void): () => void {
  installGlobalListeners();
  const e = getEntry(key);
  if (e.idleTimer) {
    clearTimeout(e.idleTimer);
    e.idleTimer = null;
  }
  const first = e.listeners.size === 0;
  e.listeners.add(onChange);
  e.intervals.set(onChange, refreshMs);
  if (first && (e.snap.data == null || e.invalid || Date.now() - e.lastFetch > DEDUPE_MS)) revalidate(e, false);
  else if (!e.controller) schedule(e);

  return () => {
    e.listeners.delete(onChange);
    e.intervals.delete(onChange);
    if (e.listeners.size > 0) return;
    // kurz warten (StrictMode/Seitenwechsel), dann laufende Anfrage abbrechen und Polling stoppen
    e.idleTimer = setTimeout(() => {
      e.idleTimer = null;
      if (e.listeners.size > 0) return;
      if (e.timer) clearTimeout(e.timer);
      e.timer = null;
      e.controller?.abort();
      // Zeitraum-URLs (gleitende Zeiträume erzeugen je Tick eine neue URL) schnell verwerfen
      e.idleTimer = setTimeout(
        () => {
          if (e.listeners.size === 0 && !e.controller) entries.delete(key);
        },
        isRangeKey(key) ? RANGE_GC_MS : GC_MS,
      );
      capRangeEntries();
    }, IDLE_ABORT_MS);
  };
}

function snapshotOf(key: string | null, idle: boolean): ApiSnapshot<unknown> {
  if (!key) return idle ? IDLE : PENDING;
  return entries.get(key)?.snap ?? PENDING;
}

/**
 * Alle passenden Einträge neu laden (z. B. nach dem Speichern der Einstellungen:
 * `revalidateApi("/api/config")`). Ohne Abonnenten wird der Eintrag nur als veraltet markiert.
 * `match`: Präfix (String) oder Prädikat; ohne Angabe = alles.
 */
export function revalidateApi(match?: string | ((url: string) => boolean)): void {
  for (const e of entries.values()) {
    const hit = match === undefined ? true : typeof match === "string" ? e.key.startsWith(match) : match(e.key);
    if (!hit) continue;
    if (e.listeners.size > 0) revalidate(e, true);
    else e.invalid = true;
  }
}

/** Cache-Inhalt direkt setzen (z. B. mit der Antwort von PUT /api/config). */
export function setApiData<T>(url: string, data: T): void {
  const e = getEntry(url);
  setSnap(e, { data, error: null, loading: e.controller !== null, updatedAt: Date.now() });
}

interface ViewState<T> {
  data: T | null;
  error: ApiFailure | null;
  loading: boolean;
  updatedAt: number | null;
  stale: boolean;
  isPrevious: boolean;
}

/** Je Hook-Instanz: hält die letzten Daten für den URL-Wechsel fest (gecacht je Eingabe). */
function createView<T>(keepPrevious: boolean) {
  let lastInput: ApiSnapshot<unknown> | null = null;
  let lastKey: string | null | undefined;
  let lastOut: ViewState<T> | null = null;
  let prevData: T | null = null;
  return (input: ApiSnapshot<unknown>, key: string | null): ViewState<T> => {
    if (lastOut && input === lastInput && key === lastKey) return lastOut;
    lastInput = input;
    lastKey = key;
    const data = input.data as T | null;
    if (data != null) prevData = data;
    const showPrev = keepPrevious && key !== null && data == null && prevData != null && input.error == null;
    lastOut = {
      data: showPrev ? prevData : data,
      error: input.error,
      loading: input.loading,
      updatedAt: input.updatedAt,
      stale: showPrev || (input.loading && data != null),
      isPrevious: showPrev,
    };
    return lastOut;
  };
}

const SERVER_PENDING: ViewState<never> = { data: null, error: null, loading: true, updatedAt: null, stale: false, isPrevious: false };
const SERVER_IDLE: ViewState<never> = { data: null, error: null, loading: false, updatedAt: null, stale: false, isPrevious: false };

export function useApi<T>(url: string | null, opts: UseApiOptions = {}): UseApiResult<T> {
  const { refreshMs = 0, enabled = true, keepPreviousData = true } = opts;
  const key = enabled && url ? url : null;
  /** nur ausdrücklich abgeschaltet = Ruhezustand; fehlende URL = wartet noch (lädt) */
  const idle = !enabled;

  const subscribe = useCallback(
    (onChange: () => void) => (key ? subscribeKey(key, refreshMs, onChange) : () => {}),
    [key, refreshMs],
  );
  const view = useMemo(() => createView<T>(keepPreviousData), [keepPreviousData]);
  const getSnapshot = useCallback(() => view(snapshotOf(key, idle), key), [view, key, idle]);
  const getServerSnapshot = useCallback((): ViewState<T> => (idle ? SERVER_IDLE : SERVER_PENDING), [idle]);

  const state = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const reload = useCallback(() => {
    if (key) revalidate(getEntry(key), true);
  }, [key]);

  return useMemo(() => ({ ...state, reload }), [state, reload]);
}
