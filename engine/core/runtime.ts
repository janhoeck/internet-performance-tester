// Engine runtime: module lifecycle (init/start/stop/dispose with timeouts), config reload,
// EngineStatus, the 1 s ticker (gap detection, client state, planned session end, heartbeat)
// and the event-loop lag metric.
import { type AppConfig, mergeConfig } from '../../src/lib/shared/config';
import type { EngineStatus, ModuleState, PingerStatus, ProbeState, SpeedtestProgress } from '../../src/lib/shared/types';
import type { LoadedModule } from '../modules';
import type { PingerSleepInfo } from './client-state';
import type { ContextHandle } from './context';
import { GapDetector, gapEvent, type LoopLagMonitor, startLoopLagMonitor } from './gaps';
import type { SessionManager } from './session';
import type { EngineModule, Logger } from './types';
import { errorMessage, invoke, isRecord, settleWithin } from './util';

export const HEARTBEAT_SETTING = 'engine.heartbeat';
const HEARTBEAT_EVERY_TICKS = 5;

export interface LifecycleTimeouts {
  initMs: number;
  startMs: number;
  stopMs: number;
  disposeMs: number;
}

export const DEFAULT_TIMEOUTS: LifecycleTimeouts = { initMs: 15_000, startMs: 10_000, stopMs: 5000, disposeMs: 5000 };

/** Reads settings['config'] and merges it onto the defaults (never throws). */
export function loadConfig(getSetting: (key: string) => string | null, log?: Logger): AppConfig {
  let raw: string | null = null;
  try {
    raw = getSetting('config');
  } catch (err) {
    log?.error('Einstellungen konnten nicht gelesen werden – Standardwerte aktiv', err);
  }
  if (!raw) return mergeConfig({});
  try {
    return mergeConfig(JSON.parse(raw));
  } catch (err) {
    log?.warn(`Gespeicherte Einstellungen sind kein gültiges JSON – Standardwerte aktiv (${errorMessage(err)})`);
    return mergeConfig({});
  }
}

/** Top-level config sections that differ (for the config_change event). */
export function changedSections(a: AppConfig, b: AppConfig): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const out: string[] = [];
  for (const k of keys) {
    const va: unknown = (a as unknown as Record<string, unknown>)[k];
    const vb: unknown = (b as unknown as Record<string, unknown>)[k];
    if (JSON.stringify(va) !== JSON.stringify(vb)) out.push(k);
  }
  return out;
}

function unavailableState(name: string, error: string): ModuleState {
  return { name, enabled: false, running: false, busy: false, lastRunTs: null, nextRunTs: null, lastError: error };
}

/** state() of a module, never throwing; missing modules are reported as disabled. */
export function moduleStateOf(l: LoadedModule, extraError: string | null = null): ModuleState {
  if (!l.module) return unavailableState(l.entry.name, `Modul nicht verfügbar: ${l.error ?? 'unbekannt'}`);
  try {
    const s = l.module.state();
    const state: ModuleState = { ...s, name: l.entry.name };
    if (extraError && !state.lastError) state.lastError = extraError;
    return state;
  } catch (err) {
    return unavailableState(l.entry.name, `Status nicht abrufbar: ${errorMessage(err)}`);
  }
}

function isProbeState(v: unknown): v is ProbeState {
  return isRecord(v) && typeof v.targetId === 'string';
}

/** Optional `probeStates()` of the probes module (validated). */
export function probeStatesOf(mod: EngineModule | null): ProbeState[] {
  if (!mod) return [];
  const fn = (mod as unknown as Record<string, unknown>).probeStates;
  if (typeof fn !== 'function') return [];
  try {
    const list: unknown = (fn as () => unknown).call(mod);
    return Array.isArray(list) ? list.filter(isProbeState) : [];
  } catch {
    return [];
  }
}

/**
 * Optional `pingerInfo()` of the probes module (pinger agent mode + SetThreadExecutionState).
 * null = no pinger (module missing / no agent running), undefined = the module cannot tell.
 */
export function pingerSleepInfoOf(mod: EngineModule | null): PingerSleepInfo | null | undefined {
  if (!mod) return null;
  const fn = (mod as unknown as Record<string, unknown>).pingerInfo;
  if (typeof fn !== 'function') return undefined;
  try {
    const info: unknown = (fn as () => unknown).call(mod);
    if (!isRecord(info) || typeof info.mode !== 'string') return null;
    return { mode: info.mode, preventSleepActive: typeof info.preventSleepActive === 'boolean' ? info.preventSleepActive : null };
  } catch {
    return undefined;
  }
}

/** Optional `pingerInfo()` of the probes module mapped to the public PingerStatus. */
export function pingerStatusOf(mod: EngineModule | null): PingerStatus | null {
  if (!mod) return null;
  const fn = (mod as unknown as Record<string, unknown>).pingerInfo;
  if (typeof fn !== 'function') return null;
  try {
    const info: unknown = (fn as () => unknown).call(mod);
    if (!isRecord(info) || typeof info.mode !== 'string') return null;
    const mode = ['stopped', 'starting', 'agent', 'fallback'].includes(info.mode) ? (info.mode as PingerStatus['mode']) : 'stopped';
    return {
      mode,
      restarts: typeof info.restarts === 'number' ? info.restarts : 0,
      preventSleepActive: typeof info.preventSleepActive === 'boolean' ? info.preventSleepActive : null,
      lastError: typeof info.lastError === 'string' ? info.lastError : null,
    };
  } catch {
    return null;
  }
}

export interface RuntimeOptions {
  handle: ContextHandle;
  modules: LoadedModule[];
  sessions: SessionManager;
  log: Logger;
  timeouts?: Partial<LifecycleTimeouts>;
  now?: () => number;
}

export class EngineRuntime {
  readonly log: Logger;
  private readonly timeouts: LifecycleTimeouts;
  private readonly now: () => number;
  private readonly initErrors = new Map<string, string>();
  private speedtest: SpeedtestProgress | null = null;
  private ticker: NodeJS.Timeout | null = null;
  private loopLag: LoopLagMonitor | null = null;
  private readonly gaps = new GapDetector();
  private tickCount = 0;
  private readonly unsubscribe: (() => void)[] = [];
  /** lifecycle hooks run strictly one after another (a stop never overtakes a slow start) */
  private lifecycle: Promise<void> = Promise.resolve();
  /** session parts of the modules are running (start() called, stop() not yet) */
  private started = false;

  constructor(private readonly opts: RuntimeOptions) {
    this.log = opts.log;
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...opts.timeouts };
    this.now = opts.now ?? Date.now;
    this.unsubscribe.push(
      opts.handle.ctx.bus.on('speedtest', (p) => {
        this.speedtest = p;
      }),
    );
  }

  get ctx() {
    return this.opts.handle.ctx;
  }

  get sessions(): SessionManager {
    return this.opts.sessions;
  }

  /** module instance by registry name (null when missing) */
  module(name: string): EngineModule | null {
    return this.opts.modules.find((l) => l.entry.name === name)?.module ?? null;
  }

  private active(): { name: string; module: EngineModule }[] {
    const out: { name: string; module: EngineModule }[] = [];
    for (const l of this.opts.modules) if (l.module) out.push({ name: l.entry.name, module: l.module });
    return out;
  }

  /**
   * Runs one lifecycle hook on all modules (sequentially, in registry order or reversed).
   * A failing or hanging module is logged and never blocks the others for longer than the timeout.
   */
  private async runHook(hook: 'init' | 'start' | 'stop' | 'dispose', reverse = false): Promise<void> {
    const list = this.active();
    if (reverse) list.reverse();
    const t = this.timeouts;
    const timeout = { init: t.initMs, start: t.startMs, stop: t.stopMs, dispose: t.disposeMs }[hook];
    const verb = { init: 'initialisiert', start: 'gestartet', stop: 'gestoppt', dispose: 'beendet' }[hook];
    for (const { name, module } of list) {
      if (typeof module[hook] !== 'function') continue;
      const call = (): Promise<void> | void => {
        switch (hook) {
          case 'init':
            return module.init?.(this.opts.handle.forModule(name));
          case 'start':
            return module.start?.();
          case 'stop':
            return module.stop?.();
          case 'dispose':
            return module.dispose?.();
        }
      };
      const t0 = Date.now();
      const outcome = await settleWithin(invoke(call), timeout);
      if (outcome.status === 'rejected') {
        const msg = errorMessage(outcome.reason);
        if (hook === 'init') this.initErrors.set(name, `Initialisierung fehlgeschlagen: ${msg}`);
        this.log.error(`Modul ${name} konnte nicht ${verb} werden: ${msg}`, outcome.reason instanceof Error ? outcome.reason : undefined);
      } else if (outcome.status === 'timeout') {
        this.log.warn(`Modul ${name}: ${hook}() dauert länger als ${timeout / 1000} s – fahre fort`);
      } else {
        this.log.debug(`Modul ${name} ${verb} (${Date.now() - t0} ms)`);
      }
    }
  }

  /** Queues a lifecycle step behind the previous ones (runHook never rejects). */
  private enqueue(step: () => Promise<void>): Promise<void> {
    const run = this.lifecycle.then(step, step);
    this.lifecycle = run.catch(() => undefined);
    return run;
  }

  initModules(): Promise<void> {
    return this.enqueue(() => this.runHook('init'));
  }

  /** start() of all modules (session started/resumed); no-op while already started */
  startModules(): Promise<void> {
    return this.enqueue(async () => {
      if (this.started) return;
      this.started = true;
      await this.runHook('start');
    });
  }

  /** stop() of all modules in reverse order (session ended / shutdown); no-op when not started */
  stopModules(): Promise<void> {
    return this.enqueue(async () => {
      if (!this.started) return;
      this.started = false;
      await this.runHook('stop', true);
    });
  }

  disposeModules(): Promise<void> {
    return this.enqueue(() => this.runHook('dispose', true));
  }

  /** config.reload: re-read settings, publish, reconfigure modules; records config_change on change. */
  reloadConfig(): AppConfig {
    const { ctx } = this.opts.handle;
    const before = ctx.config();
    const cfg = loadConfig((k) => ctx.db.getSetting(k), this.log);
    this.opts.handle.setConfig(cfg);
    ctx.hosts.set({ gateway: cfg.router.ip }, 'config');
    const changed = changedSections(before, cfg);
    if (changed.length > 0) {
      ctx.recordEvent({
        ts: this.now(),
        type: 'config_change',
        severity: 'info',
        segment: null,
        title: 'Einstellungen geändert',
        details: { sections: changed },
        source: 'engine',
      });
    }
    ctx.bus.emit('config', cfg);
    for (const { name, module } of this.active()) {
      if (typeof module.reconfigure !== 'function') continue;
      try {
        module.reconfigure(cfg);
      } catch (err) {
        this.log.error(`Modul ${name}: Neukonfiguration fehlgeschlagen: ${errorMessage(err)}`, err instanceof Error ? err : undefined);
      }
    }
    this.log.info(changed.length > 0 ? `Einstellungen neu geladen (geändert: ${changed.join(', ')})` : 'Einstellungen neu geladen (unverändert)');
    return cfg;
  }

  moduleStates(): ModuleState[] {
    return this.opts.modules.map((l) => moduleStateOf(l, this.initErrors.get(l.entry.name) ?? null));
  }

  status(): EngineStatus {
    const { ctx } = this.opts.handle;
    let dbSizeBytes: number | null = null;
    try {
      dbSizeBytes = ctx.db.sizeBytes();
    } catch {
      dbSizeBytes = null;
    }
    return {
      version: ctx.version,
      pid: process.pid,
      startedAt: ctx.startedAt,
      now: this.now(),
      session: this.opts.sessions.current(),
      probes: probeStatesOf(this.module('probes')),
      modules: this.moduleStates(),
      dynamicHosts: ctx.hosts.get(),
      client: ctx.clientState(),
      pinger: pingerStatusOf(this.module('probes')),
      speedtest: this.speedtest,
      dbPath: ctx.db.path,
      dbSizeBytes,
    };
  }

  /** One ticker step (exposed for tests). */
  tick(wall = this.now(), mono: number | null = performance.now()): void {
    const { ctx } = this.opts.handle;
    const gap = this.gaps.tick(wall, mono);
    if (gap) {
      this.loopLag?.reset();
      if (this.opts.sessions.current()) ctx.recordEvent(gapEvent(gap));
      this.log.info(`Timer-Lücke von ${Math.round(gap.gapMs / 1000)} s erkannt (Standby oder blockierte Engine)`);
    }
    const sessions = this.opts.sessions;
    sessions.tick(wall);
    try {
      const state = this.opts.handle.tickClient(wall, pingerSleepInfoOf(this.module('probes')));
      // session started without a detectable egress (network down): adopt the first one seen
      if (state?.egressV4If && sessions.current() && sessions.expectedInterface() === null) {
        sessions.adoptExpectedInterface(state.egressV4If);
      }
    } catch (err) {
      this.log.error(`Verbindungsstatus konnte nicht berechnet werden: ${errorMessage(err)}`);
    }
    if (++this.tickCount % HEARTBEAT_EVERY_TICKS === 0) {
      try {
        ctx.db.setSetting(HEARTBEAT_SETTING, String(wall));
      } catch {
        /* DB busy – next heartbeat */
      }
    }
  }

  startTimers(): void {
    if (this.ticker) return;
    this.tick();
    this.ticker = setInterval(() => {
      try {
        this.tick();
      } catch (err) {
        this.log.error(`Fehler im Sekundentakt: ${errorMessage(err)}`, err instanceof Error ? err : undefined);
      }
    }, 1000);
    // engine health is recorded always (also without a session): p99 lag every 10 s
    this.loopLag = startLoopLagMonitor({
      onSample: (lagMs, ts) => this.ctx.recordMetrics([{ key: 'engine.loop_lag_ms', ts, value: lagMs }]),
    });
  }

  stopTimers(): void {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
    this.loopLag?.stop();
    this.loopLag = null;
  }

  /**
   * Graceful shutdown: stop timers, stop session parts (the session itself stays 'running' in the
   * DB and is resumed on the next start), dispose modules, dispose PowerShell (before the tree
   * kill, so the worker is not respawned), kill remaining children.
   */
  async shutdown(): Promise<void> {
    this.stopTimers();
    try {
      this.opts.handle.ctx.db.setSetting(HEARTBEAT_SETTING, String(this.now()));
    } catch {
      /* ignore */
    }
    await this.stopModules();
    await this.disposeModules();
    try {
      this.opts.handle.ctx.ps.dispose();
    } catch (err) {
      this.log.warn(`PowerShell-Host konnte nicht beendet werden: ${errorMessage(err)}`);
    }
    await this.opts.handle.killChildren();
    for (const off of this.unsubscribe) off();
    this.opts.handle.dispose();
  }
}
