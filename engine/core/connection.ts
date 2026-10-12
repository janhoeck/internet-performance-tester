// Connection context at session start (ARCHITECTURE §4.2): which interface the session expects
// internet traffic on, plus link/WLAN details for the A/B comparison of LAN, new cable and WLAN.
import dgram from 'node:dgram';
import os, { type NetworkInterfaceInfo } from 'node:os';
import { normalizeIp } from '../../src/lib/shared/net';
import type { AdapterInfo, AdapterSnapshot, ClientState, WlanInfo } from '../../src/lib/shared/types';
import type { NicTick } from './types';
import { isRecord, sameInterface } from './util';

export type ExpectedIfSource = 'client' | 'egress' | 'adapters' | 'stored' | null;

export interface ConnectionContext {
  expectedIf: string | null;
  expectedIfSource: ExpectedIfSource;
  primaryAdapter: string | null;
  isWifi: boolean | null;
  linkMbps: number | null;
  ssid: string | null;
  band: string | null;
  channel: number | null;
  signalPct: number | null;
}

/** client state younger than this counts as "current" */
const CLIENT_CURRENT_MS = 10_000;

// ─── snapshot validation (snapshots are written by other modules – never trust the shape) ───

export function asAdapterSnapshot(data: unknown): AdapterSnapshot | null {
  if (!isRecord(data) || !Array.isArray(data.adapters) || !Array.isArray(data.routes)) return null;
  return data as unknown as AdapterSnapshot;
}

export function asWlanInfo(data: unknown): WlanInfo | null {
  if (!isRecord(data) || typeof data.connected !== 'boolean') return null;
  return data as unknown as WlanInfo;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Interface alias of the primary IPv4 internet route (route to 1.1.1.1 / default route). */
export function primaryRouteInterface(snap: AdapterSnapshot | null, family: 4 | 6 = 4): string | null {
  if (!snap) return null;
  const routes = snap.routes.filter((r) => isRecord(r) && r.family === family && str(r.ifAlias));
  const preferred = routes.find((r) => r.destination === (family === 4 ? '1.1.1.1' : '2606:4700:4700::1111'));
  return str((preferred ?? routes[0])?.ifAlias);
}

export function findAdapter(snap: AdapterSnapshot | null, name: string | null): AdapterInfo | null {
  if (!snap || !name) return null;
  return snap.adapters.find((a) => isRecord(a) && sameInterface(a.name, name)) ?? null;
}

/** Interface alias owning a local address: adapters snapshot first, then os.networkInterfaces(). */
export function interfaceForAddress(
  address: string | null,
  snap: AdapterSnapshot | null,
  osInterfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = safeNetworkInterfaces(),
): string | null {
  if (!address) return null;
  const want = normalizeIp(address);
  const matches = (a: string) => normalizeIp(a) === want;
  for (const a of snap?.adapters ?? []) {
    if (isRecord(a) && Array.isArray(a.addresses) && a.addresses.some((x) => typeof x === 'string' && matches(x))) {
      return str(a.name);
    }
  }
  for (const [name, list] of Object.entries(osInterfaces)) {
    if ((list ?? []).some((info) => matches(info.address))) return name;
  }
  return null;
}

function safeNetworkInterfaces(): NodeJS.Dict<NetworkInterfaceInfo[]> {
  try {
    return os.networkInterfaces();
  } catch {
    return {};
  }
}

/** Local source address Windows would use for internet traffic (UDP connect – sends no packet). */
export function localEgressAddress(family: 4 | 6, timeoutMs = 1000): Promise<string | null> {
  return new Promise((resolve) => {
    let done = false;
    let sock: dgram.Socket | null = null;
    const finish = (v: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        sock?.close();
      } catch {
        /* already closed */
      }
      resolve(v);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    try {
      sock = dgram.createSocket(family === 4 ? 'udp4' : 'udp6');
      sock.on('error', () => finish(null));
      sock.connect(53, family === 4 ? '1.1.1.1' : '2606:4700:4700::1111', () => {
        try {
          finish(sock?.address().address ?? null);
        } catch {
          finish(null);
        }
      });
    } catch {
      finish(null);
    }
  });
}

const WIFI_NAME = /wlan|wi-?fi|wireless|802\.11/i;

export interface ConnectionInputs {
  expectedIf: string | null;
  expectedIfSource: ExpectedIfSource;
  adapters: AdapterSnapshot | null;
  wlan: WlanInfo | null;
  /** latest NIC tick of the expected adapter (pinger), if any */
  nic: NicTick | null;
}

/** Pure: assembles the session_start connection details. */
export function buildConnectionContext(i: ConnectionInputs): ConnectionContext {
  const adapter = findAdapter(i.adapters, i.expectedIf);
  const isWifi =
    adapter && typeof adapter.isWifi === 'boolean'
      ? adapter.isWifi
      : i.nic
        ? i.nic.isWifi
        : i.expectedIf
          ? WIFI_NAME.test(i.expectedIf)
          : null;
  const linkMbps = num(adapter?.linkMbps) ?? (i.nic?.up ? num(i.nic.mbps) : null);
  const wlan = isWifi && i.wlan && i.wlan.connected ? i.wlan : null;
  return {
    expectedIf: i.expectedIf,
    expectedIfSource: i.expectedIf ? i.expectedIfSource : null,
    primaryAdapter: i.expectedIf,
    isWifi,
    linkMbps,
    ssid: str(wlan?.ssid),
    band: str(wlan?.band),
    channel: num(wlan?.channel),
    signalPct: num(wlan?.signalPct),
  };
}

export interface ConnectionSources {
  now(): number;
  clientState(): ClientState | null;
  latestAdapters(): AdapterSnapshot | null;
  latestWlan(): WlanInfo | null;
  nic(name: string): NicTick | null;
  /** live egress check; default: UDP connect + interface mapping */
  egressInterface?: (adapters: AdapterSnapshot | null) => Promise<string | null>;
}

export async function defaultEgressInterface(adapters: AdapterSnapshot | null): Promise<string | null> {
  const address = await localEgressAddress(4);
  return interfaceForAddress(address, adapters);
}

/**
 * Determines the expected interface: fresh client state → live egress check → adapters snapshot
 * primary route. `stored` (resume) wins when given.
 */
export async function resolveConnectionContext(src: ConnectionSources, stored: string | null = null): Promise<ConnectionContext> {
  const adapters = src.latestAdapters();
  let expectedIf: string | null = null;
  let source: ExpectedIfSource = null;
  if (stored) {
    expectedIf = stored;
    source = 'stored';
  }
  if (!expectedIf) {
    const cs = src.clientState();
    if (cs && cs.egressV4If && src.now() - cs.ts <= CLIENT_CURRENT_MS) {
      expectedIf = cs.egressV4If;
      source = 'client';
    }
  }
  if (!expectedIf) {
    try {
      expectedIf = await (src.egressInterface ?? defaultEgressInterface)(adapters);
      if (expectedIf) source = 'egress';
    } catch {
      expectedIf = null;
    }
  }
  if (!expectedIf) {
    expectedIf = primaryRouteInterface(adapters);
    if (expectedIf) source = 'adapters';
  }
  return buildConnectionContext({
    expectedIf,
    expectedIfSource: source,
    adapters,
    wlan: src.latestWlan(),
    nic: expectedIf ? src.nic(expectedIf) : null,
  });
}
