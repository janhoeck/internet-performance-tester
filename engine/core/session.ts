// Measurement sessions ("Langzeittest", ARCHITECTURE §4.1/§4.2): start/stop, auto-stop at the
// planned end, resume on engine start, expected interface (setting 'session.expectedIf').
import { fmtDateTime } from '../../src/lib/shared/format';
import type { NetEvent, SessionStatus, TestSession } from '../../src/lib/shared/types';
import type { ConnectionContext } from './connection';
import { GAP_THRESHOLD_MS, gapEvent } from './gaps';
import type { Bus, EngineDb, Logger } from './types';
import { errorMessage, invoke, round, settleWithin } from './util';

export const EXPECTED_IF_SETTING = 'session.expectedIf';
/** 30 days */
export const MAX_DURATION_MIN = 43_200;
export const MAX_LABEL_LENGTH = 80;
/**
 * start()/stop() wait at most this long for the module hooks before they resolve (the control
 * API must answer quickly – the Next proxy gives up after 15 s); the hooks continue in background.
 */
export const LIFECYCLE_WAIT_MS = 5000;

export type SessionStopReason = 'user' | 'planned';

/** Expected/user-facing failure (German message), e.g. "Es läuft bereits ein Langzeittest." */
export class SessionError extends Error {
  override name = 'SessionError';
}

/** null/undefined → unlimited; positive minutes (number or numeric string) up to 30 days. */
export function parseDurationMin(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0 || n > MAX_DURATION_MIN) {
    throw new SessionError(`Ungültige Testdauer – erwartet werden Minuten (> 0, höchstens ${MAX_DURATION_MIN}) oder unbegrenzt.`);
  }
  return n;
}

export function parseLabel(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string') throw new SessionError('Ungültige Bezeichnung für den Langzeittest.');
  const s = v.replace(/\s+/g, ' ').trim();
  if (s === '') return null;
  return s.length > MAX_LABEL_LENGTH ? s.slice(0, MAX_LABEL_LENGTH) : s;
}

export interface SessionManagerDeps {
  db: EngineDb;
  bus: Bus;
  log: Logger;
  recordEvent(e: NetEvent): number | null;
  /** connection details; `stored` = expected interface remembered for a resumed session */
  connection(stored: string | null): Promise<ConnectionContext>;
  /** after a session started/resumed: start the session parts of all modules */
  onStart?(session: TestSession, resumed: boolean): Promise<void> | void;
  /** after a session ended: stop the session parts of all modules */
  onStop?(session: TestSession): Promise<void> | void;
  now?: () => number;
  /** max wait for onStart/onStop before start()/stop() resolve (default LIFECYCLE_WAIT_MS) */
  lifecycleWaitMs?: number;
}

export interface SessionManager {
  current(): TestSession | null;
  expectedInterface(): string | null;
  start(durationMin: number | null, label: string | null): Promise<TestSession>;
  stop(reason: SessionStopReason): Promise<TestSession | null>;
  /**
   * Engine start: resume a 'running' session whose planned end is in the future (or unlimited),
   * otherwise mark it completed at its planned end. `lastAliveTs` (engine heartbeat before the
   * restart) produces an engine_gap event for the downtime.
   */
  resumeOnBoot(opts?: { lastAliveTs?: number | null }): Promise<TestSession | null>;
  /** 1 s ticker: stops the session when its planned end is reached */
  tick(now: number): void;
  /**
   * The session started without a known expected interface (e.g. no network at that moment):
   * adopt the first observed IPv4 egress interface. Returns true when adopted.
   */
  adoptExpectedInterface(name: string): boolean;
}

export function sessionStartEvent(s: TestSession, conn: ConnectionContext, resumed: boolean, ts: number): NetEvent {
  const label = s.label ? ` „${s.label}“` : '';
  return {
    ts,
    type: 'session_start',
    severity: 'info',
    segment: null,
    title: resumed ? `Langzeittest${label} fortgesetzt (Engine neu gestartet)` : `Langzeittest${label} gestartet`,
    details: {
      sessionId: s.id,
      label: s.label,
      startedAt: s.startedAt,
      plannedEndAt: s.plannedEndAt,
      durationMin: s.plannedEndAt === null ? null : round((s.plannedEndAt - s.startedAt) / 60_000, 2),
      resumed,
      expectedIf: conn.expectedIf,
      expectedIfSource: conn.expectedIfSource,
      primaryAdapter: conn.primaryAdapter,
      isWifi: conn.isWifi,
      linkMbps: conn.linkMbps,
      ssid: conn.ssid,
      band: conn.band,
      channel: conn.channel,
      signalPct: conn.signalPct,
    },
    source: 'engine',
    dedupeKey: resumed ? `session_resume:${s.id}:${ts}` : `session_start:${s.id}`,
  };
}

export function sessionEndEvent(s: TestSession, reason: SessionStopReason, extra: Record<string, unknown> = {}): NetEvent {
  const ts = s.endedAt ?? Date.now();
  const label = s.label ? ` „${s.label}“` : '';
  const title =
    s.status === 'aborted'
      ? `Langzeittest${label} vorzeitig beendet`
      : reason === 'planned'
        ? `Langzeittest${label} beendet (geplantes Ende erreicht)`
        : `Langzeittest${label} beendet`;
  return {
    ts,
    type: 'session_end',
    severity: 'info',
    segment: null,
    title,
    details: {
      sessionId: s.id,
      label: s.label,
      reason,
      status: s.status,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      plannedEndAt: s.plannedEndAt,
      durationMs: s.endedAt === null ? null : s.endedAt - s.startedAt,
      ...extra,
    },
    source: 'engine',
    dedupeKey: `session_end:${s.id}`,
  };
}

/** Status of a session ended by the user: before the planned end = 'aborted', else 'completed'. */
export function statusForStop(s: TestSession, reason: SessionStopReason, now: number): SessionStatus {
  if (reason === 'planned') return 'completed';
  return s.plannedEndAt !== null && now < s.plannedEndAt ? 'aborted' : 'completed';
}

export function createSessionManager(deps: SessionManagerDeps): SessionManager {
  const now = deps.now ?? Date.now;
  const log = deps.log;
  let current: TestSession | null = null;
  let expectedIf: string | null = null;
  let plannedStopQueued = false;
  let chain: Promise<unknown> = Promise.resolve();

  /** start/stop/resume never run concurrently */
  const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => undefined);
    return run;
  };

  /**
   * Runs onStart/onStop but waits at most lifecycleWaitMs; a slower hook keeps running in the
   * background (the runtime serializes module hooks, so a later stop cannot overtake it).
   */
  const runHook = async (what: 'start' | 'stop', fn: () => Promise<void> | void): Promise<void> => {
    const failed = (err: unknown) =>
      log.error(
        `Messmodule konnten nicht vollständig ${what === 'start' ? 'gestartet' : 'gestoppt'} werden: ${errorMessage(err)}`,
        err,
      );
    const promise = invoke(fn);
    const outcome = await settleWithin(promise, deps.lifecycleWaitMs ?? LIFECYCLE_WAIT_MS);
    if (outcome.status === 'rejected') failed(outcome.reason);
    if (outcome.status === 'timeout') {
      log.warn(`Messmodule werden noch ${what === 'start' ? 'gestartet' : 'gestoppt'} – läuft im Hintergrund weiter`);
      promise.catch(failed);
    }
  };

  const begin = async (session: TestSession, resumed: boolean, conn: ConnectionContext) => {
    current = session;
    expectedIf = conn.expectedIf;
    if (conn.expectedIf) deps.db.setSetting(EXPECTED_IF_SETTING, conn.expectedIf);
    deps.recordEvent(sessionStartEvent(session, conn, resumed, now()));
    deps.bus.emit('session', session);
    const until = session.plannedEndAt === null ? 'unbegrenzt' : `bis ${fmtDateTime(session.plannedEndAt)}`;
    log.info(
      `Langzeittest #${session.id} ${resumed ? 'fortgesetzt' : 'gestartet'} (${until}, erwartete Schnittstelle: ${conn.expectedIf ?? 'unbekannt'})`,
    );
    await runHook('start', () => deps.onStart?.(session, resumed));
  };

  const stop = (reason: SessionStopReason): Promise<TestSession | null> =>
    serialize(async () => {
      const s = current;
      if (!s) return null;
      const t = now();
      const status = statusForStop(s, reason, t);
      const endedAt = reason === 'planned' && s.plannedEndAt !== null ? s.plannedEndAt : t;
      deps.db.updateSession(s.id, { status, endedAt });
      deps.db.setSetting(EXPECTED_IF_SETTING, null);
      const ended: TestSession = { ...s, status, endedAt };
      current = null;
      expectedIf = null;
      deps.recordEvent(sessionEndEvent(ended, reason));
      deps.bus.emit('session', null);
      log.info(`Langzeittest #${s.id} beendet (${reason === 'planned' ? 'geplantes Ende' : 'vom Benutzer'}, Status ${status})`);
      await runHook('stop', () => deps.onStop?.(ended));
      return ended;
    });

  return {
    current: () => current,
    expectedInterface: () => (current ? expectedIf : null),

    start: (durationMin, label) =>
      serialize(async () => {
        if (current) throw new SessionError('Es läuft bereits ein Langzeittest.');
        const minutes = parseDurationMin(durationMin);
        const lbl = parseLabel(label);
        const conn = await deps.connection(null);
        const t = now();
        const session = deps.db.createSession({
          startedAt: t,
          endedAt: null,
          plannedEndAt: minutes === null ? null : t + Math.round(minutes * 60_000),
          label: lbl,
          status: 'running',
          note: null,
        });
        await begin(session, false, conn);
        return session;
      }),

    stop,

    resumeOnBoot: (opts = {}) =>
      serialize(async () => {
        if (current) return current;
        const s = deps.db.runningSession();
        if (!s) return null;
        const t = now();
        if (s.plannedEndAt !== null && s.plannedEndAt <= t) {
          const ended: TestSession = { ...s, status: 'completed', endedAt: s.plannedEndAt };
          deps.db.updateSession(s.id, { status: 'completed', endedAt: s.plannedEndAt });
          deps.db.setSetting(EXPECTED_IF_SETTING, null);
          deps.recordEvent(sessionEndEvent(ended, 'planned', { completedAtStartup: true }));
          log.info(`Langzeittest #${s.id} war während der Engine-Pause planmäßig zu Ende – als abgeschlossen markiert`);
          return null;
        }
        const lastAlive = opts.lastAliveTs ?? null;
        if (lastAlive !== null && lastAlive >= s.startedAt && lastAlive < t && t - lastAlive > GAP_THRESHOLD_MS) {
          deps.recordEvent(gapEvent({ from: lastAlive, to: t, gapMs: t - lastAlive, monotonicMs: null }, 'restart'));
        }
        const stored = deps.db.getSetting(EXPECTED_IF_SETTING);
        const conn = await deps.connection(stored);
        await begin(s, true, conn);
        return s;
      }),

    tick: (t) => {
      const s = current;
      if (!s || plannedStopQueued || s.plannedEndAt === null || t < s.plannedEndAt) return;
      plannedStopQueued = true;
      stop('planned')
        .catch((err: unknown) => log.error(`Geplantes Testende fehlgeschlagen: ${errorMessage(err)}`, err))
        .finally(() => {
          plannedStopQueued = false;
        });
    },

    adoptExpectedInterface: (name) => {
      const iface = name.trim();
      if (!current || expectedIf || iface === '') return false;
      expectedIf = iface;
      try {
        deps.db.setSetting(EXPECTED_IF_SETTING, iface);
      } catch (err) {
        log.warn(`Erwartete Schnittstelle konnte nicht gespeichert werden: ${errorMessage(err)}`);
      }
      log.info(`Langzeittest #${current.id}: erwartete Schnittstelle nachträglich ermittelt: ${iface}`);
      return true;
    },
  };
}
