// Engine startup sequence (ARCHITECTURE §4.1 steps 2–5) and graceful shutdown. engine/main.ts
// adds process-level concerns (warning filter, signals, exit codes).
import type { ChildProcess } from 'node:child_process';
import { ENGINE_PORT, resolveDbPath } from '../../src/lib/shared/db/path';
import { loadModules, type ModuleImporter } from '../modules';
import { createControlServer, ENGINE_HOST, type ControlServer } from '../server';
import { createBus } from './bus';
import { resolveConnectionContext } from './connection';
import { dispatchControl } from './control';
import { createEngineContext } from './context';
import { createHostRegistry, HOSTS_SETTING, parsePersistedHosts, serializeHosts } from './hosts';
import { LiveHub } from './live';
import { EngineRuntime, HEARTBEAT_SETTING, loadConfig } from './runtime';
import { createSessionManager } from './session';
import type { EngineDb, Logger } from './types';
import { errorMessage } from './util';
import { type Importer, loadPowerShellHost, loadSecretStore } from './windows';

export interface StartOptions {
  version: string;
  log: Logger;
  openDb: (path: string, opts: { onError: (err: unknown) => void }) => EngineDb;
  dbPath?: string;
  port?: number;
  host?: string;
  /** module importer (tests) */
  importer?: ModuleImporter;
  /** importer for the E-windows PowerShell host + secret store (tests) */
  windowsImporter?: Importer;
}

export interface EngineHandle {
  readonly runtime: EngineRuntime;
  readonly server: ControlServer;
  readonly port: number;
  readonly db: EngineDb;
  /** graceful shutdown; idempotent */
  shutdown(reason: string): Promise<void>;
}

function parseTs(v: string | null): number | null {
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export async function startEngine(opts: StartOptions): Promise<EngineHandle> {
  const { log, version } = opts;
  const dbPath = opts.dbPath ?? resolveDbPath();

  // 2. database
  let lastDbError = 0;
  const db = opts.openDb(dbPath, {
    onError: (err) => {
      const t = Date.now();
      if (t - lastDbError < 30_000) return;
      lastDbError = t;
      log.error(`Datenbank: Schreiben fehlgeschlagen (${errorMessage(err)})`, err instanceof Error ? err : undefined);
    },
  });
  log.info(`Datenbank: ${db.path}`);

  // 3. control server (fails fast when another engine runs)
  const server = createControlServer({ version, log: log.child('api') });
  let port: number;
  try {
    port = await server.listen(opts.port ?? ENGINE_PORT, opts.host ?? ENGINE_HOST);
  } catch (err) {
    try {
      db.close();
    } catch {
      /* ignore */
    }
    throw err;
  }
  log.info(`Steuer-API auf http://${opts.host ?? ENGINE_HOST}:${port}`);

  // 4. config, context, PowerShell worker, secret store, hosts, modules
  const lastAliveTs = parseTs(db.getSetting(HEARTBEAT_SETTING));
  const config = loadConfig((k) => db.getSetting(k), log);
  const bus = createBus(log.child('bus'));
  const hosts = createHostRegistry({
    bus,
    log: log.child('hosts'),
    gateway: config.router.ip,
    initial: parsePersistedHosts(db.getSetting(HOSTS_SETTING)),
    persist: (h) => db.setSetting(HOSTS_SETTING, serializeHosts(h)),
  });
  // the worker is lazy (powershell.exe starts with the first command) – spawns are tracked by the
  // context created right below, so the worker is killed with the engine
  let trackChild: ((child: ChildProcess) => void) | null = null;
  const ps = await loadPowerShellHost(log, {
    importer: opts.windowsImporter,
    onSpawn: (child) => trackChild?.(child),
  });
  const secrets = await loadSecretStore(ps, db, log, opts.windowsImporter);
  const handle = createEngineContext({ version, log, bus, db, ps, hosts, secrets, config });
  const { ctx } = handle;
  trackChild = (child) => ctx.trackChild(child);

  const modules = await loadModules(log, opts.importer);

  let runtime: EngineRuntime | null = null;
  const sessions = createSessionManager({
    db,
    bus,
    log: log.child('session'),
    recordEvent: (e) => ctx.recordEvent(e),
    connection: (stored) =>
      resolveConnectionContext(
        {
          now: Date.now,
          clientState: () => ctx.clientState(),
          latestAdapters: () => handle.latestAdapters(),
          latestWlan: () => handle.latestWlan(),
          nic: (name) => handle.nic(name),
        },
        stored,
      ),
    onStart: () => runtime?.startModules(),
    onStop: () => runtime?.stopModules(),
  });
  handle.attachSessions(sessions);
  const rt = new EngineRuntime({ handle, modules, sessions, log });
  runtime = rt;

  await rt.initModules();

  const live = new LiveHub({ bus, log: log.child('live'), status: () => rt.status() });
  server.attach({
    status: () => rt.status(),
    control: (req) =>
      dispatchControl(req, {
        sessions,
        module: (name) => rt.module(name),
        secrets,
        config: () => ctx.config(),
        reloadConfig: () => rt.reloadConfig(),
        log: log.child('control'),
      }),
    live,
  });
  rt.startTimers();

  // 5. resume a running session
  try {
    await sessions.resumeOnBoot({ lastAliveTs });
  } catch (err) {
    log.error(`Laufender Langzeittest konnte nicht fortgesetzt werden: ${errorMessage(err)}`, err instanceof Error ? err : undefined);
  }
  log.info(`Engine ${version} bereit (PID ${process.pid})`);

  let shutdownPromise: Promise<void> | null = null;
  return {
    runtime: rt,
    server,
    port,
    db,
    shutdown: (reason) => {
      shutdownPromise ??= (async () => {
        log.info(`Engine wird beendet (${reason}) …`);
        await server.close();
        try {
          await rt.shutdown();
        } catch (err) {
          log.error(`Fehler beim Beenden der Module: ${errorMessage(err)}`, err instanceof Error ? err : undefined);
        }
        try {
          db.flush();
        } catch (err) {
          log.error(`Datenbank konnte nicht geschrieben werden: ${errorMessage(err)}`);
        }
        try {
          db.close();
        } catch (err) {
          log.error(`Datenbank konnte nicht geschlossen werden: ${errorMessage(err)}`);
        }
        log.info('Engine beendet');
      })();
      return shutdownPromise;
    },
  };
}
