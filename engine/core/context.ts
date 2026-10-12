// EngineContext implementation (ARCHITECTURE §4.2): persistence + publishing helpers, runtime
// flags (speed test, gaming), ClientState derivation from bus 'nic' + 'egress' and child tracking.
import type { ChildProcess } from 'node:child_process';
import type { AppConfig } from '../../src/lib/shared/config';
import type { AdapterSnapshot, ClientState, MetricPoint, NetEvent, TestSession, WlanInfo } from '../../src/lib/shared/types';
import { ClientTracker, effectivePreventSleep, OnExpectedTracker, type PingerSleepInfo } from './client-state';
import { asAdapterSnapshot, asWlanInfo } from './connection';
import { isAlive, killTree } from './process';
import type {
  Bus,
  DynamicHostRegistry,
  EngineContext,
  EngineDb,
  Logger,
  NicTick,
  PowerShellHost,
  SecretStore,
} from './types';
import { settleWithin } from './util';

/** recently recorded events kept in memory so updateEvent() can publish the full event */
const EVENT_CACHE_SIZE = 1000;
/** a client state older than this is dropped when no session runs */
const CLIENT_STALE_MS = 10_000;

export interface ContextOptions {
  version: string;
  log: Logger;
  bus: Bus;
  db: EngineDb;
  ps: PowerShellHost;
  hosts: DynamicHostRegistry;
  secrets: SecretStore;
  config: AppConfig;
  now?: () => number;
  startedAt?: number;
}

/** What the context needs to know about sessions (implemented by the session manager). */
export interface SessionView {
  current(): TestSession | null;
  expectedInterface(): string | null;
}

export interface ContextHandle {
  readonly ctx: EngineContext;
  setConfig(cfg: AppConfig): void;
  attachSessions(view: SessionView): void;
  /** context for one module: same object, but `log` is scoped to the module name */
  forModule(name: string): EngineContext;
  /**
   * derive + publish the client state (called by the 1 s ticker); null when nothing to derive.
   * `agent`: pinger agent info for `preventSleep` (undefined = unknown → config decides).
   */
  tickClient(now: number, agent?: PingerSleepInfo | null): ClientState | null;
  latestAdapters(): AdapterSnapshot | null;
  latestWlan(): WlanInfo | null;
  nic(name: string): NicTick | null;
  childCount(): number;
  /** kill all tracked child processes (tree) */
  killChildren(timeoutMs?: number): Promise<void>;
  dispose(): void;
}

export function createEngineContext(opts: ContextOptions): ContextHandle {
  const { log, bus, db } = opts;
  const now = opts.now ?? Date.now;
  let config = opts.config;
  let sessions: SessionView | null = null;
  let speedtest = false;
  let gaming = false;
  let clientState: ClientState | null = null;
  let adaptersCache: AdapterSnapshot | null = null;
  let wlanCache: WlanInfo | null = null;
  const tracker = new ClientTracker();
  const onExpected = new OnExpectedTracker();
  const events = new Map<number, NetEvent & { id: number }>();
  const children = new Set<ChildProcess>();

  const cacheEvent = (e: NetEvent & { id: number }) => {
    events.delete(e.id);
    events.set(e.id, e);
    if (events.size > EVENT_CACHE_SIZE) {
      const oldest = events.keys().next();
      if (!oldest.done) events.delete(oldest.value);
    }
  };

  const currentSession = () => sessions?.current() ?? null;

  const ctx: EngineContext = {
    version: opts.version,
    startedAt: opts.startedAt ?? now(),
    log,
    bus,
    db,
    ps: opts.ps,
    hosts: opts.hosts,
    secrets: opts.secrets,
    config: () => config,
    session: currentSession,
    isMeasuring: () => currentSession() !== null,
    speedtestActive: () => speedtest,
    setSpeedtestActive: (active) => {
      if (speedtest === active) return;
      speedtest = active;
      log.debug(active ? 'Speedtest aktiv – Leitung ausgelastet' : 'Speedtest beendet');
    },
    gamingActive: () => gaming,
    clientState: () => clientState,
    expectedInterface: () => (currentSession() ? (sessions?.expectedInterface() ?? null) : null),

    recordSample: (s) => {
      try {
        db.addSample(s);
      } catch (err) {
        log.error('Messwert konnte nicht gespeichert werden', err);
      }
      bus.emit('sample', s);
    },

    recordMetrics: (points) => {
      const valid: MetricPoint[] = points.filter((p) => Number.isFinite(p.value) && Number.isFinite(p.ts));
      if (valid.length === 0) return;
      try {
        db.addMetrics(valid);
      } catch (err) {
        log.error('Kennzahlen konnten nicht gespeichert werden', err);
      }
      bus.emit('metrics', valid);
    },

    recordEvent: (e) => {
      let id: number | null;
      try {
        id = db.insertEvent(e);
      } catch (err) {
        log.error(`Ereignis „${e.title}“ konnte nicht gespeichert werden`, err);
        return null;
      }
      if (id === null) return null;
      const stored: NetEvent & { id: number } = {
        ...e,
        id,
        endTs: e.endTs ?? null,
        segment: e.segment ?? null,
        details: e.details ?? null,
        dedupeKey: e.dedupeKey ?? null,
      };
      cacheEvent(stored);
      bus.emit('event', stored);
      return id;
    },

    updateEvent: (id, patch) => {
      try {
        db.updateEvent(id, patch);
      } catch (err) {
        log.error(`Ereignis #${id} konnte nicht aktualisiert werden`, err);
        return;
      }
      const cached = events.get(id);
      if (!cached) {
        log.debug(`Ereignis #${id} aktualisiert (nicht im Speicher – keine Live-Meldung)`);
        return;
      }
      const updated: NetEvent & { id: number } = { ...cached };
      if (patch.endTs !== undefined) updated.endTs = patch.endTs ?? null;
      if (patch.severity !== undefined) updated.severity = patch.severity;
      if (patch.title !== undefined) updated.title = patch.title;
      if (patch.details !== undefined) updated.details = patch.details ?? null;
      cacheEvent(updated);
      bus.emit('event', updated);
    },

    recordSnapshot: (kind, data, ts) => {
      try {
        db.insertSnapshot(kind, ts ?? now(), data);
      } catch (err) {
        log.error(`Schnappschuss „${kind}“ konnte nicht gespeichert werden`, err);
      }
      if (kind === 'adapters') adaptersCache = asAdapterSnapshot(data) ?? adaptersCache;
      if (kind === 'wlan') wlanCache = asWlanInfo(data) ?? wlanCache;
    },

    trackChild: (child) => {
      children.add(child);
      const forget = () => children.delete(child);
      child.once('exit', forget);
      child.once('close', forget);
      // a spawn error without listener would crash the engine
      child.on('error', (err) => {
        forget();
        log.debug('Kindprozess-Fehler', err);
      });
    },
  };

  const unsubscribe = [
    bus.on('gaming', (g) => {
      gaming = g.active;
    }),
    bus.on('nic', (t) => tracker.onNic(t)),
    bus.on('egress', (t) => tracker.onEgress(t)),
    bus.on('adapters', (s) => {
      adaptersCache = asAdapterSnapshot(s) ?? adaptersCache;
    }),
    bus.on('session', () => onExpected.reset()),
  ];

  return {
    ctx,
    setConfig: (cfg) => {
      config = cfg;
    },
    attachSessions: (view) => {
      sessions = view;
    },
    forModule: (name) => ({ ...ctx, log: log.child(name) }),
    tickClient: (t, agent) => {
      const session = currentSession();
      if (!session && !tracker.hasFreshData(t)) {
        if (clientState && t - clientState.ts > CLIENT_STALE_MS) clientState = null;
        return null;
      }
      const state = tracker.derive({
        now: t,
        expectedIf: session ? (sessions?.expectedInterface() ?? null) : null,
        gaming,
        preventSleep: effectivePreventSleep(session !== null, config.session.preventSleep, agent),
      });
      clientState = state;
      bus.emit('client', state);
      if (session) {
        const value = onExpected.update(state.onExpected);
        if (value !== null) ctx.recordMetrics([{ key: 'net.on_expected_if', ts: t, value }]);
      }
      return state;
    },
    latestAdapters: () => {
      if (adaptersCache) return adaptersCache;
      try {
        return asAdapterSnapshot(db.latestSnapshot<unknown>('adapters')?.data);
      } catch {
        return null;
      }
    },
    latestWlan: () => {
      if (wlanCache) return wlanCache;
      try {
        return asWlanInfo(db.latestSnapshot<unknown>('wlan')?.data);
      } catch {
        return null;
      }
    },
    nic: (name) => tracker.nic(name),
    childCount: () => [...children].filter(isAlive).length,
    killChildren: async (timeoutMs = 3000) => {
      const alive = [...children].filter(isAlive);
      if (alive.length === 0) return;
      log.info(`Beende ${alive.length} Kindprozess(e) …`);
      await settleWithin(Promise.all(alive.map((c) => killTree(c, timeoutMs))), timeoutMs + 500);
      children.clear();
    },
    dispose: () => {
      for (const off of unsubscribe) off();
    },
  };
}
