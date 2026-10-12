// HTTP client for the probe engine's control API (engine/server.ts on 127.0.0.1:3901).
// Every call has a timeout; failures are reported as German messages, never thrown.
import { engineBaseUrl } from '../shared/db/path';
import type { ControlRequest, ControlResponse, EngineStatus } from '../shared/types';

export type EngineCall<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number | null; error: string; offline: boolean };

export const STATUS_TIMEOUT_MS = 2000;
export const CONTROL_TIMEOUT_MS = 15_000;
export const LIVE_CONNECT_TIMEOUT_MS = 4000;

type Holder = { since: number | null };
const g = globalThis as typeof globalThis & { __netdiagEngineOffline?: Holder };
const offline: Holder = g.__netdiagEngineOffline ?? (g.__netdiagEngineOffline = { since: null });

/** Time of the first failed engine call since the last successful one (null = online/unknown). */
export function engineOfflineSince(): number | null {
  return offline.since;
}

function markOnline(): void {
  offline.since = null;
}

function markOffline(now: number = Date.now()): number {
  if (offline.since === null) offline.since = now;
  return offline.since;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function errorCode(err: unknown): string | null {
  let e: unknown = err;
  for (let depth = 0; depth < 5 && e !== undefined && e !== null; depth++) {
    if (isRecord(e) || e instanceof Error) {
      const rec = e as { code?: unknown; cause?: unknown; errors?: unknown };
      if (typeof rec.code === 'string') return rec.code;
      if (Array.isArray(rec.errors) && rec.errors.length > 0) {
        e = rec.errors[0];
        continue;
      }
      e = rec.cause;
    } else break;
  }
  return null;
}

function errorName(err: unknown): string {
  return err instanceof Error || (isRecord(err) && typeof err.name === 'string') ? String((err as { name: unknown }).name) : '';
}

/** German description of a failed engine request. */
export function describeEngineError(err: unknown, timeoutMs: number): string {
  const name = errorName(err);
  if (name === 'TimeoutError') {
    return `Zeitüberschreitung: Der Messdienst (Engine) hat nicht innerhalb von ${Math.round(timeoutMs / 100) / 10} s geantwortet.`;
  }
  if (name === 'AbortError') return 'Anfrage an den Messdienst wurde abgebrochen.';
  const code = errorCode(err);
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'UND_ERR_SOCKET') {
    return `Der Messdienst (Engine) läuft nicht oder ist nicht erreichbar (${engineBaseUrl()}).`;
  }
  const msg = err instanceof Error ? err.message : String(err);
  return `Messdienst nicht erreichbar: ${code ?? msg}`;
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (text.trim() === '') return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** GET /status of the engine. */
export async function getEngineStatus(timeoutMs = STATUS_TIMEOUT_MS): Promise<EngineCall<EngineStatus>> {
  try {
    const res = await fetch(`${engineBaseUrl()}/status`, {
      cache: 'no-store',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await readJson(res);
    markOnline();
    if (!res.ok) {
      const detail = isRecord(body) && typeof body.error === 'string' ? `: ${body.error}` : '';
      return { ok: false, status: res.status, error: `Der Messdienst antwortete mit HTTP ${res.status}${detail}.`, offline: false };
    }
    if (!isRecord(body)) return { ok: false, status: res.status, error: 'Ungültige Statusantwort des Messdienstes.', offline: false };
    return { ok: true, status: res.status, data: body as unknown as EngineStatus };
  } catch (err) {
    markOffline();
    return { ok: false, status: null, error: describeEngineError(err, timeoutMs), offline: true };
  }
}

/**
 * POST /control. A ControlResponse from the engine is passed through with its HTTP status
 * (also for 4xx, e.g. unknown action); transport failures yield ok: false.
 */
export async function sendEngineControl(req: ControlRequest, timeoutMs = CONTROL_TIMEOUT_MS): Promise<EngineCall<ControlResponse>> {
  try {
    const res = await fetch(`${engineBaseUrl()}/control`, {
      method: 'POST',
      cache: 'no-store',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(req),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await readJson(res);
    markOnline();
    if (isRecord(body) && typeof body.ok === 'boolean') {
      const data: ControlResponse = { ok: body.ok };
      if ('result' in body) data.result = body.result;
      if (typeof body.error === 'string') data.error = body.error;
      return { ok: true, status: res.status, data };
    }
    if (!res.ok) {
      const detail = isRecord(body) && typeof body.error === 'string' ? `: ${body.error}` : '';
      return { ok: false, status: res.status, error: `Der Messdienst antwortete mit HTTP ${res.status}${detail}.`, offline: false };
    }
    return { ok: false, status: res.status, error: 'Ungültige Antwort des Messdienstes.', offline: false };
  } catch (err) {
    markOffline();
    return { ok: false, status: null, error: describeEngineError(err, timeoutMs), offline: true };
  }
}

export type LiveConnection =
  | { ok: true; body: ReadableStream<Uint8Array>; abort: () => void }
  | { ok: false; error: string; since: number };

/**
 * Open the engine's SSE stream (GET /live). The connect timeout only covers the response
 * headers; afterwards the stream lives until `signal` aborts or `abort()` is called.
 */
export async function openEngineLive(signal: AbortSignal, connectTimeoutMs = LIVE_CONNECT_TIMEOUT_MS): Promise<LiveConnection> {
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  if (signal.aborted) ctrl.abort();
  else signal.addEventListener('abort', onAbort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, connectTimeoutMs);
  const release = () => signal.removeEventListener('abort', onAbort);
  try {
    const res = await fetch(`${engineBaseUrl()}/live`, {
      cache: 'no-store',
      headers: { accept: 'text/event-stream' },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok || !res.body) {
      ctrl.abort();
      release();
      markOnline();
      return { ok: false, error: `Der Live-Stream des Messdienstes ist nicht verfügbar (HTTP ${res.status}).`, since: Date.now() };
    }
    markOnline();
    return {
      ok: true,
      body: res.body,
      abort: () => {
        ctrl.abort();
        release();
      },
    };
  } catch (err) {
    clearTimeout(timer);
    release();
    const since = markOffline();
    const error = timedOut
      ? `Zeitüberschreitung: Der Messdienst (Engine) hat nicht innerhalb von ${connectTimeoutMs / 1000} s geantwortet.`
      : describeEngineError(err, connectTimeoutMs);
    return { ok: false, error, since };
  }
}
