// PowerShell RPC worker + DPAPI secret store come from E-windows (engine/collectors/*). They are
// imported dynamically; when unavailable the engine keeps running with local fallbacks.
import type { ChildProcess } from 'node:child_process';
import { projectFileUrl } from '../modules';
import type { EngineDb, Logger, PowerShellHost, SecretStore } from './types';
import { errorMessage, isRecord } from './util';

export const POWERSHELL_HOST_FILE = 'engine/collectors/powershell-host.ts';
export const SECRET_STORE_FILE = 'engine/collectors/secret-store.ts';

/** PowerShell host stand-in: available = false, every call rejects. */
export function createUnavailablePowerShellHost(reason = 'PowerShell-Worker nicht verfügbar'): PowerShellHost {
  const fail = () => Promise.reject(new Error(reason));
  return {
    available: false,
    json: <T>() => fail() as Promise<T>,
    text: () => fail() as Promise<string>,
    dispose: () => undefined,
  };
}

/** Secret store stand-in: keeps the router password in memory only (never written to disk). */
export function createMemorySecretStore(): SecretStore {
  let password: string | null = null;
  return {
    getRouterPassword: () => Promise.resolve(password),
    setRouterPassword: (p) => {
      password = p && p.length > 0 ? p : null;
      return Promise.resolve();
    },
    hasRouterPassword: () => password !== null,
  };
}

export function isPowerShellHost(v: unknown): v is PowerShellHost {
  return (
    isRecord(v) &&
    typeof v.available === 'boolean' &&
    typeof v.json === 'function' &&
    typeof v.text === 'function' &&
    typeof v.dispose === 'function'
  );
}

export function isSecretStore(v: unknown): v is SecretStore {
  return (
    isRecord(v) &&
    typeof v.getRouterPassword === 'function' &&
    typeof v.setRouterPassword === 'function' &&
    typeof v.hasRouterPassword === 'function'
  );
}

export type Importer = (url: string) => Promise<unknown>;
const defaultImport: Importer = (url) => import(url);

async function loadFactory(file: string, exportName: string, importer: Importer): Promise<(...args: unknown[]) => unknown> {
  const ns = await importer(projectFileUrl(file));
  const factory = isRecord(ns) ? ns[exportName] : undefined;
  if (typeof factory !== 'function') throw new Error(`Export ${exportName} fehlt`);
  return factory as (...args: unknown[]) => unknown;
}

export interface PowerShellLoadOptions {
  importer?: Importer;
  /**
   * Called for every powershell.exe the worker spawns (→ ctx.trackChild, so it is killed on
   * shutdown). Passed to `createPowerShellHost({ log, onSpawn })`; factories without options
   * simply ignore the argument.
   */
  onSpawn?: (child: ChildProcess) => void;
}

export async function loadPowerShellHost(log: Logger, opts: PowerShellLoadOptions = {}): Promise<PowerShellHost> {
  try {
    const factory = await loadFactory(POWERSHELL_HOST_FILE, 'createPowerShellHost', opts.importer ?? defaultImport);
    const host = factory({ log: log.child('powershell'), onSpawn: opts.onSpawn });
    if (!isPowerShellHost(host)) throw new Error('createPowerShellHost() liefert kein gültiges Objekt');
    return host;
  } catch (err) {
    log.warn(`PowerShell-Host nicht verfügbar (${errorMessage(err)}) – Engine läuft ohne PowerShell-Abfragen weiter`);
    return createUnavailablePowerShellHost();
  }
}

export async function loadSecretStore(
  ps: PowerShellHost,
  db: EngineDb,
  log: Logger,
  importer: Importer = defaultImport,
): Promise<SecretStore> {
  try {
    const factory = await loadFactory(SECRET_STORE_FILE, 'createSecretStore', importer);
    const store = factory(ps, db);
    if (!isSecretStore(store)) throw new Error('createSecretStore() liefert kein gültiges Objekt');
    return store;
  } catch (err) {
    log.warn(`Passwortspeicher nicht verfügbar (${errorMessage(err)}) – Router-Passwort wird nur im Arbeitsspeicher gehalten`);
    return createMemorySecretStore();
  }
}
