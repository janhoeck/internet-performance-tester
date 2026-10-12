// POST /control dispatch (ARCHITECTURE §4.3 "Manual actions", §4.4). Long tasks answer
// immediately with { started: true } and report via the live stream.
import type { AppConfig } from '../../src/lib/shared/config';
import type { ControlAction, ControlRequest, ControlResponse, TestSession } from '../../src/lib/shared/types';
import { SessionError, type SessionStopReason } from './session';
import type { EngineModule, Logger, SecretStore } from './types';
import { errorMessage, invoke, isRecord, settleWithin } from './util';

export const CONTROL_ACTIONS: readonly ControlAction[] = [
  'session.start',
  'session.stop',
  'speedtest.run',
  'traceroute.run',
  'mtr.run',
  'mtu.run',
  'stun.run',
  'udpburst.run',
  'router.poll',
  'router.login',
  'router.setPassword',
  'eventlog.import',
  'config.reload',
];

/** Invalid request (→ HTTP 400). */
export class ControlRequestError extends Error {
  override name = 'ControlRequestError';
}

export function isControlAction(v: unknown): v is ControlAction {
  return typeof v === 'string' && (CONTROL_ACTIONS as readonly string[]).includes(v);
}

/** Validates the JSON body of POST /control. Throws ControlRequestError (German message). */
export function parseControlRequest(body: unknown): ControlRequest {
  if (!isRecord(body)) throw new ControlRequestError('Ungültige Anfrage: JSON-Objekt erwartet.');
  if (!isControlAction(body.action)) {
    const a = typeof body.action === 'string' ? body.action : String(body.action);
    throw new ControlRequestError(`Unbekannte Aktion: ${a}`);
  }
  if (body.params !== undefined && body.params !== null && !isRecord(body.params)) {
    throw new ControlRequestError('Ungültige Parameter: Objekt erwartet.');
  }
  return { action: body.action, params: isRecord(body.params) ? body.params : undefined };
}

interface TaskRoute {
  module: string;
  /** answer { started: true } right away (contract: speed test, traceroute, MTR, …) */
  long: boolean;
  params?: (p: Record<string, unknown>, cfg: AppConfig) => Record<string, unknown>;
}

function familyParam(p: Record<string, unknown>): Record<string, unknown> {
  if (p.family === undefined || p.family === null || p.family === '') return {};
  const f = Number(p.family);
  if (f !== 4 && f !== 6) throw new ControlRequestError('Ungültige IP-Version – erlaubt sind 4 oder 6.');
  return { family: f };
}

function daysParam(p: Record<string, unknown>, cfg: AppConfig): Record<string, unknown> {
  if (p.days === undefined || p.days === null || p.days === '') {
    return { days: cfg.eventLog.importDays > 0 ? cfg.eventLog.importDays : 365 };
  }
  const d = Number(p.days);
  if (!Number.isInteger(d) || d < 1 || d > 3650) throw new ControlRequestError('Ungültige Anzahl Tage (1 … 3650).');
  return { days: d };
}

export const TASK_ROUTES: Partial<Record<ControlAction, TaskRoute>> = {
  'speedtest.run': { module: 'speedtest', long: true },
  'traceroute.run': { module: 'traceroute', long: true, params: familyParam },
  'mtr.run': { module: 'mtr', long: true },
  'mtu.run': { module: 'mtu', long: true },
  'udpburst.run': { module: 'udpburst', long: true },
  'eventlog.import': { module: 'eventlog', long: true, params: daysParam },
  'stun.run': { module: 'stun', long: false },
  'router.poll': { module: 'router', long: false, params: () => ({ action: 'poll' }) },
  'router.login': { module: 'router', long: false, params: () => ({ action: 'login' }) },
};

export interface ControlDeps {
  sessions: {
    start(durationMin: number | null, label: string | null): Promise<TestSession>;
    stop(reason: SessionStopReason): Promise<TestSession | null>;
  };
  module(name: string): EngineModule | null;
  secrets: SecretStore;
  config(): AppConfig;
  reloadConfig(): Promise<AppConfig> | AppConfig;
  log: Logger;
  /** how long a short task may take before we answer { started: true } (default 3000 ms) */
  shortTaskWaitMs?: number;
  /** grace period to catch immediate rejections of long tasks, e.g. "läuft bereits" (default 150 ms) */
  longTaskWaitMs?: number;
}

const MAX_PASSWORD_LENGTH = 256;

/** Maps a module result to a ControlResponse (TaskResult { ok, result, error } passes through). */
export function normalizeTaskResult(value: unknown): ControlResponse {
  if (isRecord(value) && typeof value.ok === 'boolean' && ('result' in value || 'error' in value)) {
    const res: ControlResponse = { ok: value.ok };
    if (value.result !== undefined) res.result = value.result;
    if (typeof value.error === 'string') res.error = value.error;
    else if (!value.ok) res.error = 'Aufgabe fehlgeschlagen';
    return res;
  }
  return { ok: true, result: value ?? null };
}

async function runTask(action: ControlAction, route: TaskRoute, params: Record<string, unknown>, deps: ControlDeps): Promise<ControlResponse> {
  const mod = deps.module(route.module);
  if (!mod) return { ok: false, error: `Modul „${route.module}“ ist nicht verfügbar.` };
  if (typeof mod.runNow !== 'function') return { ok: false, error: `Modul „${route.module}“ unterstützt keine manuelle Ausführung.` };
  const runNow = mod.runNow.bind(mod);
  const taskParams = route.params ? route.params(params, deps.config()) : params;
  const started = Date.now();
  const promise = invoke(() => runNow(taskParams));
  const wait = route.long ? (deps.longTaskWaitMs ?? 150) : (deps.shortTaskWaitMs ?? 3000);
  const outcome = await settleWithin(promise, wait);
  if (outcome.status === 'fulfilled') return normalizeTaskResult(outcome.value);
  if (outcome.status === 'rejected') return { ok: false, error: errorMessage(outcome.reason) };
  // still running – report the outcome in the log; results arrive via bus/live stream
  promise.then(
    (value) => {
      const res = normalizeTaskResult(value);
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      if (res.ok) deps.log.info(`Manuelle Aufgabe ${action} beendet (${secs} s)`);
      else deps.log.warn(`Manuelle Aufgabe ${action} fehlgeschlagen: ${res.error ?? 'unbekannt'}`);
    },
    (err: unknown) => deps.log.warn(`Manuelle Aufgabe ${action} fehlgeschlagen: ${errorMessage(err)}`),
  );
  return { ok: true, result: { started: true } };
}

async function setPassword(params: Record<string, unknown>, deps: ControlDeps): Promise<ControlResponse> {
  const raw = params.password;
  let password: string | null;
  if (raw === null || raw === undefined || raw === '') password = null;
  else if (typeof raw === 'string' && raw.length <= MAX_PASSWORD_LENGTH) password = raw;
  else throw new ControlRequestError('Ungültiges Passwort.');
  await deps.secrets.setRouterPassword(password);
  deps.log.info(password === null ? 'Router-Passwort entfernt' : 'Router-Passwort gespeichert');
  const router = deps.module('router');
  if (router?.reconfigure) {
    try {
      router.reconfigure(deps.config());
    } catch (err) {
      deps.log.warn(`Router-Modul konnte nicht neu konfiguriert werden: ${errorMessage(err)}`);
    }
  }
  return { ok: true, result: { hasPassword: deps.secrets.hasRouterPassword() } };
}

/**
 * Executes one control request. Never throws: invalid input → ControlRequestError is rethrown
 * only by parseControlRequest (HTTP 400); everything else becomes `{ ok: false, error }`.
 */
export async function dispatchControl(req: ControlRequest, deps: ControlDeps): Promise<ControlResponse> {
  const params = req.params ?? {};
  try {
    switch (req.action) {
      case 'session.start': {
        const durationMin = params.durationMin as number | null | undefined;
        const label = params.label as string | null | undefined;
        const session = await deps.sessions.start(durationMin ?? null, label ?? null);
        return { ok: true, result: session };
      }
      case 'session.stop':
        return { ok: true, result: await deps.sessions.stop('user') };
      case 'router.setPassword':
        return await setPassword(params, deps);
      case 'config.reload': {
        const cfg = await deps.reloadConfig();
        return { ok: true, result: { reloaded: true, targets: cfg.targets.length } };
      }
      default: {
        const route = TASK_ROUTES[req.action];
        if (!route) return { ok: false, error: `Unbekannte Aktion: ${String(req.action)}` };
        return await runTask(req.action, route, params, deps);
      }
    }
  } catch (err) {
    if (!(err instanceof SessionError) && !(err instanceof ControlRequestError)) {
      deps.log.error(`Steuerbefehl ${req.action} fehlgeschlagen`, err);
    }
    return { ok: false, error: errorMessage(err) };
  }
}
