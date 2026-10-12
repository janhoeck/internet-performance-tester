/**
 * Kleine Fetch-Schicht für die Next-API-Routen (nur im Browser verwenden).
 * Fehler werden als ApiFailure mit deutscher Meldung geworfen (bzw. bei control() als
 * ControlResponse { ok: false } zurückgegeben), damit Seiten sie direkt anzeigen können.
 */
import type { ConfigResponse } from "@/lib/shared/api-types";
import type { AppConfig } from "@/lib/shared/config";
import type { ControlAction, ControlResponse, NetEvent } from "@/lib/shared/types";

export class ApiFailure extends Error {
  /** HTTP-Status, 0 = Netzwerkfehler/Abbruch */
  readonly status: number;
  /** zusätzliche Fehlerdetails aus der Antwort (z. B. Validierungsfehler) */
  readonly details: string[];
  constructor(message: string, status: number, details: string[] = []) {
    super(message);
    this.name = "ApiFailure";
    this.status = status;
    this.details = details;
  }
}

export function isAbortError(e: unknown): boolean {
  return e instanceof DOMException ? e.name === "AbortError" : e instanceof Error && e.name === "AbortError";
}

function statusMessage(status: number): string {
  if (status === 404) return "Schnittstelle nicht gefunden (wird evtl. noch gebaut).";
  if (status === 400 || status === 422) return "Ungültige Anfrage.";
  if (status === 409) return "Aktion gerade nicht möglich.";
  if (status === 503 || status === 502) return "Mess-Engine nicht erreichbar.";
  if (status >= 500) return "Serverfehler beim Laden der Daten.";
  return `Anfrage fehlgeschlagen (HTTP ${status}).`;
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

async function readError(res: Response): Promise<ApiFailure> {
  let message = statusMessage(res.status);
  let details: string[] = [];
  try {
    const body: unknown = await res.json();
    if (body && typeof body === "object") {
      const rec = body as Record<string, unknown>;
      if (typeof rec.error === "string" && rec.error.trim()) message = rec.error;
      details = asStringArray(rec.issues ?? rec.details);
    }
  } catch {
    /* kein JSON */
  }
  return new ApiFailure(message, res.status, details);
}

export interface FetchJsonInit extends Omit<RequestInit, "body"> {
  /** wird als JSON gesendet (Content-Type gesetzt) */
  json?: unknown;
  /** Abbruch nach ms (Standard 20 s) */
  timeoutMs?: number;
}

/** GET/POST/PUT mit JSON. Wirft ApiFailure (deutsche Meldung) oder AbortError. */
export async function fetchJson<T>(url: string, init: FetchJsonInit = {}): Promise<T> {
  const { json, timeoutMs = 20_000, signal, headers, ...rest } = init;
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let res: Response;
  try {
    res = await fetch(url, {
      cache: "no-store",
      ...rest,
      headers: { Accept: "application/json", ...(json !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
      body: json !== undefined ? JSON.stringify(json) : undefined,
      signal: combined,
    });
  } catch (e) {
    if (signal?.aborted) throw e; // vom Aufrufer abgebrochen
    if (timeout.aborted) throw new ApiFailure("Zeitüberschreitung – der Server antwortet nicht.", 0);
    throw new ApiFailure("Server nicht erreichbar. Läuft die Mess-Engine? (Start: npm run dev bzw. npm run start:all)", 0);
  }
  if (!res.ok) throw await readError(res);
  if (res.status === 204) return undefined as T;
  try {
    return (await res.json()) as T;
  } catch {
    throw new ApiFailure("Antwort des Servers ist kein gültiges JSON.", res.status);
  }
}

/** Fehlermeldung für die Anzeige (ApiFailure, Error oder unbekannt). */
export function errorMessage(e: unknown): string {
  if (e instanceof ApiFailure) return e.message;
  if (e instanceof Error && e.message) return e.message;
  return "Unbekannter Fehler.";
}

/**
 * Steuerbefehl an die Mess-Engine (POST /api/control). Wirft nie: Fehler kommen als
 * { ok: false, error } zurück. Lange Aufgaben (Speedtest, Traceroute, MTR) antworten sofort
 * mit { ok: true, result: { started: true } } und melden den Fortschritt über den Live-Stream.
 */
export async function control(action: ControlAction, params?: Record<string, unknown>): Promise<ControlResponse> {
  try {
    const res = await fetchJson<ControlResponse>("/api/control", {
      method: "POST",
      json: params ? { action, params } : { action },
      timeoutMs: 30_000,
    });
    if (res && typeof res === "object" && typeof res.ok === "boolean") return res;
    return { ok: false, error: "Unerwartete Antwort der Mess-Engine." };
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
}

/** Tiefes Partial für Konfigurations-Patches (Arrays wie `targets` ersetzen die Liste komplett). */
export type DeepPartial<T> = T extends readonly (infer U)[]
  ? U[]
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

export type ConfigPatch = DeepPartial<AppConfig> & {
  /** Router-Passwort: string = setzen, null = löschen; wird nie von Next gespeichert */
  routerPassword?: string | null;
};

/** Einstellungen speichern (PUT /api/config). Wirft ApiFailure mit `details` bei Validierungsfehlern. */
export function saveConfig(patch: ConfigPatch): Promise<ConfigResponse> {
  return fetchJson<ConfigResponse>("/api/config", { method: "PUT", json: patch });
}

/**
 * Notiz anlegen (POST /api/events) – z. B. "Lag markieren". `ts` default = jetzt (im Handler
 * ermitteln, nicht im Render). Gibt das gespeicherte Ereignis zurück, falls die API es liefert.
 */
export async function addNote(
  title: string,
  opts: { ts?: number; details?: Record<string, unknown> } = {},
): Promise<NetEvent | null> {
  const body = { title, ts: opts.ts ?? Date.now(), ...(opts.details ? { details: opts.details } : {}) };
  const res = await fetchJson<unknown>("/api/events", { method: "POST", json: body });
  if (res && typeof res === "object") {
    const rec = res as Record<string, unknown>;
    const ev = (rec.event ?? rec) as Record<string, unknown>;
    if (typeof ev.ts === "number" && typeof ev.type === "string" && typeof ev.title === "string") return ev as unknown as NetEvent;
  }
  return null;
}

/** Query-String bauen (null/undefined werden ausgelassen, Arrays komma-getrennt). */
export function qs(params: Record<string, string | number | boolean | readonly (string | number)[] | null | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined) continue;
    if (Array.isArray(v)) {
      if (v.length) sp.set(k, v.join(","));
    } else sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}
