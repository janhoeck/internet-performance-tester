// Ordered module registry (ARCHITECTURE §4.3). Modules are loaded with dynamic imports so that a
// missing or broken module is logged and skipped instead of stopping the engine.
import type { EngineModule, Logger } from './core/types';
import { errorCode, errorMessage, isRecord } from './core/util';

export interface ModuleEntry {
  name: string;
  /** factory export, e.g. 'createSystemModule' */
  factory: string;
  /** path relative to the project root */
  file: string;
}

/** Initialization order = array order. */
export const MODULES: readonly ModuleEntry[] = [
  { name: 'system', factory: 'createSystemModule', file: 'engine/collectors/system.ts' },
  { name: 'identity', factory: 'createIdentityModule', file: 'engine/collectors/identity.ts' },
  { name: 'adapter', factory: 'createAdapterModule', file: 'engine/collectors/adapter.ts' },
  { name: 'eventlog', factory: 'createEventLogModule', file: 'engine/collectors/eventlog.ts' },
  { name: 'wlan', factory: 'createWlanModule', file: 'engine/collectors/wlan.ts' },
  { name: 'vpn', factory: 'createVpnModule', file: 'engine/collectors/vpn.ts' },
  { name: 'router', factory: 'createRouterModule', file: 'engine/router/index.ts' },
  { name: 'probes', factory: 'createProbesModule', file: 'engine/probes/manager.ts' },
  { name: 'traceroute', factory: 'createTracerouteModule', file: 'engine/tasks/traceroute.ts' },
  { name: 'mtr', factory: 'createMtrModule', file: 'engine/tasks/mtr.ts' },
  { name: 'mtu', factory: 'createMtuModule', file: 'engine/tasks/mtu.ts' },
  { name: 'stun', factory: 'createStunModule', file: 'engine/tasks/stun.ts' },
  { name: 'speedtest', factory: 'createSpeedtestModule', file: 'engine/tasks/speedtest.ts' },
  { name: 'udpburst', factory: 'createUdpBurstModule', file: 'engine/probes/udp-burst.ts' },
  { name: 'incidents', factory: 'createIncidentsModule', file: 'engine/analysis/incidents.ts' },
  { name: 'classifier', factory: 'createClassifierModule', file: 'engine/analysis/classifier.ts' },
  { name: 'rollup', factory: 'createRollupModule', file: 'engine/aggregate/rollup.ts' },
];

/** file:// URL of a project file (this file lives in <root>/engine). */
export function projectFileUrl(file: string): string {
  return new URL(`../${file.replace(/\\/g, '/')}`, import.meta.url).href;
}

export type ModuleImporter = (entry: ModuleEntry) => Promise<unknown>;

export const defaultImporter: ModuleImporter = (entry) => import(projectFileUrl(entry.file));

export interface LoadedModule {
  entry: ModuleEntry;
  module: EngineModule | null;
  /** why the module is not available (null when loaded) */
  error: string | null;
}

function normalizePath(p: string): string {
  return p
    .replace(/^file:\/+/i, '')
    .replace(/\\/g, '/')
    .replace(/\.(ts|mts|js|mjs)$/i, '')
    .toLowerCase();
}

/**
 * Reason text for a failed import: a missing module file vs. a module that is present but
 * broken (syntax error, missing dependency, …).
 */
export function importFailureReason(entry: ModuleEntry, err: unknown): string {
  const msg = errorMessage(err);
  if (errorCode(err) === 'ERR_MODULE_NOT_FOUND') {
    const m = /Cannot find (?:module|package) '([^']+)'/.exec(msg);
    const own = normalizePath(entry.file);
    if (m && normalizePath(m[1]).endsWith(own)) return `Datei ${entry.file} fehlt`;
    if (m) return `Abhängigkeit fehlt: ${m[1]}`;
  }
  return msg;
}

export function isEngineModule(v: unknown): v is EngineModule {
  return isRecord(v) && typeof v.name === 'string' && typeof v.state === 'function';
}

/** Turns an imported namespace into a module instance (throws with a German reason). */
export function instantiate(entry: ModuleEntry, ns: unknown): EngineModule {
  const factory = isRecord(ns) ? ns[entry.factory] : undefined;
  if (typeof factory !== 'function') throw new Error(`Export ${entry.factory} fehlt`);
  const instance: unknown = (factory as () => unknown)();
  if (!isEngineModule(instance)) throw new Error(`${entry.factory}() liefert kein gültiges Modul (name/state fehlen)`);
  return instance;
}

/**
 * Imports all registry entries (in parallel) and instantiates them in registry order.
 * Failures are logged as "Modul <name> nicht verfügbar: …" and returned with module = null.
 */
export async function loadModules(
  log: Logger,
  importer: ModuleImporter = defaultImporter,
  registry: readonly ModuleEntry[] = MODULES,
): Promise<LoadedModule[]> {
  const imports = await Promise.all(
    registry.map(async (entry) => {
      try {
        return { entry, ns: await importer(entry), error: null as string | null };
      } catch (err) {
        return { entry, ns: null as unknown, error: importFailureReason(entry, err) };
      }
    }),
  );
  const loaded: LoadedModule[] = [];
  for (const { entry, ns, error } of imports) {
    if (error !== null) {
      log.warn(`Modul ${entry.name} nicht verfügbar: ${error}`);
      loaded.push({ entry, module: null, error });
      continue;
    }
    try {
      const instance = instantiate(entry, ns);
      if (instance.name !== entry.name) {
        log.warn(`Modul ${entry.name} meldet den Namen „${instance.name}“ – verwendet wird „${entry.name}“`);
      }
      loaded.push({ entry, module: instance, error: null });
    } catch (err) {
      const reason = errorMessage(err);
      log.warn(`Modul ${entry.name} nicht verfügbar: ${reason}`);
      loaded.push({ entry, module: null, error: reason });
    }
  }
  const ok = loaded.filter((l) => l.module).map((l) => l.entry.name);
  const missing = loaded.filter((l) => !l.module).map((l) => l.entry.name);
  log.info(`Module geladen: ${ok.length ? ok.join(', ') : 'keine'}${missing.length ? ` · nicht verfügbar: ${missing.join(', ')}` : ''}`);
  return loaded;
}
