// Target address resolution: dynamic placeholders via the hosts registry ($gateway, $isp6, …),
// IP literals as they are, hostnames via dns.lookup per family (cached 5 min, failures 30 s).
import { promises as dns } from 'node:dns';
import { isIpLiteral } from '../../src/lib/shared/net';
import type { TargetConfig } from '../../src/lib/shared/types';
import type { DynamicHostRegistry } from '../core/types';

export type TargetAddress =
  /** ready to probe */
  | { kind: 'ip'; ip: string }
  /** hostname that still needs a DNS lookup */
  | { kind: 'dns'; host: string }
  /** dynamic host placeholder not known yet (e.g. $isp6 before the first traceroute) */
  | { kind: 'pending'; placeholder: string };

/** Classify a target's host using the dynamic hosts registry. */
export function targetAddress(hosts: Pick<DynamicHostRegistry, 'resolve'>, target: Pick<TargetConfig, 'host'>): TargetAddress {
  const host = target.host.trim();
  const resolved = hosts.resolve(host);
  if (resolved === null || resolved.trim() === '') return { kind: 'pending', placeholder: host };
  if (isIpLiteral(resolved)) return { kind: 'ip', ip: resolved };
  if (resolved.startsWith('$')) return { kind: 'pending', placeholder: resolved };
  return { kind: 'dns', host: resolved };
}

const PENDING_TEXT: Record<string, string> = {
  $gateway: 'Router-Adresse ist nicht konfiguriert',
  $isp4: 'Wird bei der nächsten Pfaderkennung ermittelt (1. IPv4-Hop)',
  $isp6: 'Wird bei der nächsten Pfaderkennung ermittelt (Kopfstation)',
  $aftr: 'AFTR-Adresse noch unbekannt (kommt vom Router)',
  $router6: 'IPv6-Adresse des Routers noch unbekannt (kommt von der Adapter-Abfrage)',
};

/** German status text for a placeholder that is not resolved yet. */
export function pendingText(placeholder: string): string {
  return PENDING_TEXT[placeholder] ?? `Adresse von „${placeholder}“ noch unbekannt`;
}

export type LookupFn = (host: string, family: 4 | 6) => Promise<string[]>;

const defaultLookup: LookupFn = async (host, family) => {
  const res = await dns.lookup(host, { family, all: true });
  return res.map((r) => r.address);
};

interface CacheEntry {
  ips: string[];
  error: string | null;
  expires: number;
}

export interface HostCacheOptions {
  ttlMs?: number;
  negativeTtlMs?: number;
  lookup?: LookupFn;
  now?: () => number;
}

/** DNS cache for probe targets (dns.lookup = OS resolver incl. hosts file). */
export class HostCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<string[]>>();
  private readonly ttlMs: number;
  private readonly negativeTtlMs: number;
  private readonly lookup: LookupFn;
  private readonly now: () => number;

  constructor(opts: HostCacheOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 5 * 60_000;
    this.negativeTtlMs = opts.negativeTtlMs ?? 30_000;
    this.lookup = opts.lookup ?? defaultLookup;
    this.now = opts.now ?? Date.now;
  }

  /** All addresses of `host` for `family` (cached). Throws when the lookup failed. */
  async resolveAll(host: string, family: 4 | 6): Promise<string[]> {
    if (isIpLiteral(host)) return [host];
    const key = `${family}|${host.toLowerCase()}`;
    const hit = this.entries.get(key);
    if (hit && hit.expires > this.now()) {
      if (hit.error !== null) throw new Error(hit.error);
      return hit.ips;
    }
    const running = this.inflight.get(key);
    if (running) return running;
    const p = this.lookup(host, family)
      .then((ips) => {
        if (ips.length === 0) throw new Error(`DNS: keine IPv${family}-Adresse für ${host}`);
        this.entries.set(key, { ips, error: null, expires: this.now() + this.ttlMs });
        return ips;
      })
      .catch((err: unknown) => {
        const code = typeof err === 'object' && err !== null && 'code' in err ? String((err as { code: unknown }).code) : '';
        const msg = err instanceof Error && err.message.startsWith('DNS:') ? err.message : `DNS-Auflösung fehlgeschlagen (${code || 'Fehler'})`;
        this.entries.set(key, { ips: [], error: msg, expires: this.now() + this.negativeTtlMs });
        throw new Error(msg);
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  /** First address of `host` (cached). Throws when the lookup failed. */
  async resolve(host: string, family: 4 | 6): Promise<string> {
    return (await this.resolveAll(host, family))[0];
  }

  /** Cached first address without a lookup (null when unknown or expired). */
  peek(host: string, family: 4 | 6): string | null {
    if (isIpLiteral(host)) return host;
    const hit = this.entries.get(`${family}|${host.toLowerCase()}`);
    return hit && hit.expires > this.now() && hit.ips.length > 0 ? hit.ips[0] : null;
  }

  clear(): void {
    this.entries.clear();
  }
}
