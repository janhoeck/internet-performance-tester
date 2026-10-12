// Runtime-resolved hosts ($gateway, $isp4, $isp6, $aftr, $router6), see ARCHITECTURE §4.3.
// $gateway always follows config.router.ip; the others are set by the modules that discover
// them and are persisted (setting 'hosts.dynamic') so probes can use them right after a restart.
import { isIpLiteral } from '../../src/lib/shared/net';
import type { DynamicHost, DynamicHosts } from '../../src/lib/shared/types';
import type { Bus, DynamicHostRegistry, Logger } from './types';
import { isRecord } from './util';

export const HOSTS_SETTING = 'hosts.dynamic';

export const PLACEHOLDER_KEYS: Record<DynamicHost, keyof DynamicHosts> = {
  $gateway: 'gateway',
  $isp4: 'isp4',
  $isp6: 'isp6',
  $aftr: 'aftr',
  $router6: 'router6',
};

const KEYS: readonly (keyof DynamicHosts)[] = ['gateway', 'isp4', 'isp6', 'aftr', 'router6'];
const PERSISTED_KEYS: readonly (keyof DynamicHosts)[] = ['isp4', 'isp6', 'aftr', 'router6'];

export function emptyHosts(): DynamicHosts {
  return { gateway: null, isp4: null, isp6: null, aftr: null, router6: null };
}

/** null stays null; IP literals are trimmed; anything else is invalid (undefined). */
function normalizeHostValue(v: unknown): string | null | undefined {
  if (v === null) return null;
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  if (s === '') return null;
  return isIpLiteral(s) ? s : undefined;
}

const same = (a: string | null, b: string | null) => (a ?? '').toLowerCase() === (b ?? '').toLowerCase();

/** Parses the persisted JSON (setting 'hosts.dynamic'); invalid entries are dropped. */
export function parsePersistedHosts(json: string | null): Partial<DynamicHosts> {
  if (!json) return {};
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return {};
  }
  if (!isRecord(data)) return {};
  const out: Partial<DynamicHosts> = {};
  for (const k of PERSISTED_KEYS) {
    const v = normalizeHostValue(data[k]);
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

export function serializeHosts(h: DynamicHosts): string {
  const out: Partial<DynamicHosts> = {};
  for (const k of PERSISTED_KEYS) out[k] = h[k];
  return JSON.stringify(out);
}

export interface HostRegistryOptions {
  bus: Bus;
  log: Logger;
  /** config.router.ip */
  gateway: string | null;
  /** restored values (e.g. parsePersistedHosts(db.getSetting('hosts.dynamic'))) */
  initial?: Partial<DynamicHosts>;
  /** called after every change (persist) */
  persist?: (hosts: DynamicHosts) => void;
}

export function createHostRegistry(opts: HostRegistryOptions): DynamicHostRegistry {
  const hosts = emptyHosts();
  for (const k of PERSISTED_KEYS) {
    const v = normalizeHostValue(opts.initial?.[k]);
    if (typeof v === 'string') hosts[k] = v;
  }
  const gw = normalizeHostValue(opts.gateway);
  hosts.gateway = typeof gw === 'string' ? gw : null;

  return {
    get: () => ({ ...hosts }),
    set(patch, source) {
      const changes: string[] = [];
      for (const k of KEYS) {
        if (!(k in patch)) continue;
        const raw = patch[k];
        if (raw === undefined) continue;
        const v = normalizeHostValue(raw);
        if (v === undefined) {
          opts.log.warn(`Ungültiger Wert für dynamischen Host ${k} ignoriert: ${String(raw)} (Quelle: ${source})`);
          continue;
        }
        if (same(hosts[k], v)) continue;
        changes.push(`$${k}: ${hosts[k] ?? '–'} → ${v ?? '–'}`);
        hosts[k] = v;
      }
      if (changes.length === 0) return;
      opts.log.info(`Dynamische Hosts geändert (${source}): ${changes.join(', ')}`);
      try {
        opts.persist?.({ ...hosts });
      } catch (err) {
        opts.log.warn('Dynamische Hosts konnten nicht gespeichert werden', err);
      }
      opts.bus.emit('dynamicHosts', { ...hosts });
    },
    resolve(host) {
      const h = host.trim();
      if (h.startsWith('$')) {
        const key = (PLACEHOLDER_KEYS as Record<string, keyof DynamicHosts | undefined>)[h];
        return key ? hosts[key] : null;
      }
      return h === '' ? null : h;
    },
  };
}
