// macOS source of the adapter module (docs/research/macos.md §3): the interface catalog
// (networksetup + ifconfig + netstat) and `route -n get [-inet6]` for the internet routes, mapped to
// the same RawNetSnapshot the PowerShell worker delivers on Windows. No driver service names and no
// advanced properties exist on macOS.
import { isLinkLocalV6 } from '../../../src/lib/shared/net';
import type { MacInterface } from '../../../src/lib/shared/parsers/macos/interfaces';
import { parseRouteGet } from '../../../src/lib/shared/parsers/macos/route';
import { probeSourceAddress } from '../../probes/egress';
import type { NetSnapshotRequest, NetSnapshotSource, RawAdapter, RawAddress, RawNetSnapshot, RawRoute, RawStats } from '../adapter';
import type { ProcessRunner } from '../util';
import { MacInterfaceCatalog } from './interfaces';
import { type ToolRunner, runTool } from './tools';

const ROUTE_TIMEOUT_MS = 5000;
/** synthetic interface indexes for interfaces without a netstat row (never collide with real ones) */
const FALLBACK_INDEX_BASE = 10_000;

export const MAC_ROUTE_TARGETS = { 4: '1.1.1.1', 6: '2606:4700:4700::1111' } as const;

/** One interface of the catalog → the Windows-shaped raw adapter row. */
export function toRawAdapter(i: MacInterface, fallbackIndex: number): RawAdapter {
  return {
    name: i.name,
    ifIndex: i.ifIndex ?? fallbackIndex,
    guid: null,
    device: i.device,
    description: i.port ? `${i.device} · ${i.port}` : i.device,
    status: i.status,
    mediaConnectState: i.linkUp === true ? 1 : i.linkUp === false ? 2 : null,
    mediaType: i.isWifi ? 'Native 802.11' : i.isVirtual ? null : '802.3',
    physicalMedium: i.isWifi ? 9 : i.isVirtual ? null : 14,
    rxBps: i.mediaMbps !== null ? i.mediaMbps * 1e6 : null,
    txBps: i.mediaMbps !== null ? i.mediaMbps * 1e6 : null,
    mac: i.mac,
    driverVersion: null,
    driverDate: null,
    virtual: i.isVirtual,
    hardware: !i.isVirtual,
  };
}

function toRawStats(i: MacInterface): RawStats | null {
  const c = i.counters;
  if (!c) return null;
  return { name: i.name, rxBytes: c.ibytes, txBytes: c.obytes, rxErrors: c.ierrs, rxDiscards: c.drops, txErrors: c.oerrs, txDiscards: null };
}

function toRawAddresses(i: MacInterface, ifIndex: number): RawAddress[] {
  const out: RawAddress[] = i.addresses
    .filter((ip) => !ip.includes(':'))
    .map((ip) => ({ ifIndex, ip, family: 'IPv4', prefixOrigin: null, suffixOrigin: null, state: 'Preferred' }));
  for (const a of i.inet6) {
    const flags = new Set(a.flags);
    out.push({
      ifIndex,
      ip: a.ip,
      family: 'IPv6',
      prefixOrigin: isLinkLocalV6(a.ip) ? 'WellKnown' : flags.has('autoconf') ? 'RouterAdvertisement' : 'Manual',
      suffixOrigin: flags.has('temporary') ? 'Random' : null,
      state: flags.has('deprecated') ? 'Deprecated' : flags.has('tentative') ? 'Tentative' : 'Preferred',
    });
  }
  return out;
}

/** Interface list → adapters, statistics and addresses of a RawNetSnapshot (pure). */
export function snapshotFromInterfaces(list: readonly MacInterface[], ts: number): Pick<RawNetSnapshot, 't' | 'adapters' | 'stats' | 'addresses'> {
  const adapters: RawAdapter[] = [];
  const stats: RawStats[] = [];
  const addresses: RawAddress[] = [];
  list.forEach((i, idx) => {
    const a = toRawAdapter(i, FALLBACK_INDEX_BASE + idx);
    adapters.push(a);
    const st = toRawStats(i);
    if (st) stats.push(st);
    addresses.push(...toRawAddresses(i, a.ifIndex));
  });
  return { t: ts, adapters, stats, addresses };
}

/**
 * `route -n get` output → RawRoute. The BSD interface becomes the shown name; a link-local next hop
 * without zone id gets the BSD name as zone (fe80::1%en7) so $router6 stays pingable.
 */
export function routeFromOutput(remote: string, text: string, list: readonly MacInterface[], sourceAddress: string | null): RawRoute {
  const r = parseRouteGet(text);
  if (!r || !r.interface) return { remote, found: false, sourceAddress: null, ifIndex: null, ifAlias: null, nextHop: null };
  const iface = list.find((i) => i.device === r.interface) ?? null;
  const idx = list.findIndex((i) => i.device === r.interface);
  let nextHop = r.gateway;
  if (nextHop && isLinkLocalV6(nextHop) && !nextHop.includes('%')) nextHop = `${nextHop}%${r.interface}`;
  return {
    remote,
    found: true,
    sourceAddress,
    ifIndex: iface ? (iface.ifIndex ?? FALLBACK_INDEX_BASE + idx) : null,
    ifAlias: iface?.name ?? r.interface,
    nextHop,
  };
}

export interface MacNetSnapshotDeps {
  runner: ToolRunner & Partial<Pick<ProcessRunner, 'killAll'>>;
  catalog?: MacInterfaceCatalog;
  /** local source address towards a target (default: UDP connect, no packet sent) */
  sourceAddress?: (family: 4 | 6, host: string) => Promise<string | null>;
  now?: () => number;
}

export function createMacNetSnapshotSource(deps: MacNetSnapshotDeps): NetSnapshotSource {
  const catalog = deps.catalog ?? new MacInterfaceCatalog(deps.runner);
  const sourceAddress = deps.sourceAddress ?? ((family: 4 | 6, host: string) => probeSourceAddress(family, host));
  const now = deps.now ?? Date.now;

  async function route(family: 4 | 6, list: readonly MacInterface[]): Promise<RawRoute> {
    const remote = MAC_ROUTE_TARGETS[family];
    const args = family === 6 ? ['-n', 'get', '-inet6', remote] : ['-n', 'get', remote];
    const [r, src] = await Promise.all([
      runTool(deps.runner, 'route', args, { timeoutMs: ROUTE_TIMEOUT_MS, maxBytes: 64 * 1024 }),
      sourceAddress(family, remote).catch(() => null),
    ]);
    // "not in table" exits non-zero – the parser decides (no interface line = no route)
    if (r.error || r.timedOut) return { remote, found: false, sourceAddress: null, ifIndex: null, ifAlias: null, nextHop: null };
    return routeFromOutput(remote, r.stdout.toString('utf8'), list, src);
  }

  return {
    async fetch(req: NetSnapshotRequest): Promise<RawNetSnapshot> {
      const list = await catalog.read({ counters: true });
      const base = snapshotFromInterfaces(list, now());
      const routes = req.routes ? await Promise.all([route(4, list), route(6, list)]) : null;
      return { ...base, routes, services: null, advanced: req.advancedFor ? [] : null };
    },
    dispose() {
      deps.runner.killAll?.();
    },
  };
}
