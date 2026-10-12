// Tolerant normalization of JSON snapshot data (shapes are typed in shared/types.ts, but snapshots
// outlive code versions and other modules are developed in parallel – a malformed row must never
// break the diagnosis). Pure.
import type {
  AdapterInfo,
  AdapterSnapshot,
  DocsisChannel,
  DocsisSnapshot,
  Health,
  MtuResult,
  NatMapping,
  NatResult,
  RouterAttachedDevice,
  RouterStatus,
  VpnInfo,
  WlanInfo,
} from '../../shared/types';
import { isRecord } from './util';

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);
const health = (v: unknown): Health => (v === 'good' || v === 'warn' || v === 'bad' ? v : 'unknown');
const fam = (v: unknown): 4 | 6 | null => (v === 4 || v === '4' ? 4 : v === 6 || v === '6' ? 6 : null);

function channel(v: unknown, dir: 'ds' | 'us'): DocsisChannel | null {
  if (!isRecord(v)) return null;
  return {
    dir: v.dir === 'us' || v.dir === 'ds' ? v.dir : dir,
    channelId: num(v.channelId),
    type: str(v.type) ?? 'SC-QAM',
    frequencyMHz: num(v.frequencyMHz),
    frequencyText: str(v.frequencyText),
    powerDbmv: num(v.powerDbmv),
    snrDb: num(v.snrDb),
    modulation: str(v.modulation),
    locked: bool(v.locked),
    corrected: num(v.corrected),
    uncorrectable: num(v.uncorrectable),
    rating: health(v.rating),
    ratingNote: str(v.ratingNote),
  };
}

export function normalizeDocsis(v: unknown, fallbackTs: number): DocsisSnapshot | null {
  if (!isRecord(v)) return null;
  const ds = Array.isArray(v.ds) ? v.ds.map((c) => channel(c, 'ds')).filter((c): c is DocsisChannel => c !== null) : [];
  const us = Array.isArray(v.us) ? v.us.map((c) => channel(c, 'us')).filter((c): c is DocsisChannel => c !== null) : [];
  if (ds.length === 0 && us.length === 0 && v.rating === undefined) return null;
  return {
    ts: num(v.ts) ?? fallbackTs,
    ds,
    us,
    rating: health(v.rating),
    notes: Array.isArray(v.notes) ? v.notes.filter((n): n is string => typeof n === 'string') : [],
  };
}

function device(v: unknown): RouterAttachedDevice | null {
  if (!isRecord(v)) return null;
  const kind = v.kind === 'lan' || v.kind === 'wlan' || v.kind === 'guest' ? v.kind : 'lan';
  return {
    kind,
    hostName: str(v.hostName),
    mac: str(v.mac),
    ipv4: str(v.ipv4),
    ipv6: str(v.ipv6),
    speed: str(v.speed),
    isThisPc: v.isThisPc === true,
  };
}

export function normalizeRouterStatus(v: unknown, fallbackTs: number, fallbackIp: string): RouterStatus | null {
  if (!isRecord(v)) return null;
  const extra: RouterStatus['extra'] = {};
  if (isRecord(v.extra)) {
    for (const [k, x] of Object.entries(v.extra)) {
      if (x === null || typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean') extra[k] = x;
    }
  }
  const ts = num(v.ts) ?? fallbackTs;
  return {
    ts,
    ip: str(v.ip) ?? fallbackIp,
    reachable: v.reachable === true,
    httpMs: num(v.httpMs),
    adapter: v.adapter === 'arris-vodafone-station' ? 'arris-vodafone-station' : 'generic',
    vendor: str(v.vendor),
    model: str(v.model),
    firmware: str(v.firmware),
    loginConfigured: v.loginConfigured === true,
    loginEnabled: v.loginEnabled === true,
    loggedIn: v.loggedIn === true,
    loginError: str(v.loginError),
    lockoutUntil: num(v.lockoutUntil),
    connectionStatus: str(v.connectionStatus),
    wanIpv4: str(v.wanIpv4),
    wanIpv6: str(v.wanIpv6),
    aftrAddress: str(v.aftrAddress),
    dsLite: bool(v.dsLite),
    gwMode: str(v.gwMode),
    uptimeSec: num(v.uptimeSec),
    lastRebootReason: str(v.lastRebootReason),
    docsis: normalizeDocsis(v.docsis, ts),
    attachedDevices: Array.isArray(v.attachedDevices)
      ? v.attachedDevices.map(device).filter((d): d is RouterAttachedDevice => d !== null)
      : null,
    extra,
  };
}

function adapter(v: unknown): AdapterInfo | null {
  if (!isRecord(v)) return null;
  const name = str(v.name);
  if (!name) return null;
  return {
    name,
    description: str(v.description) ?? '',
    ifIndex: num(v.ifIndex) ?? 0,
    status: str(v.status) ?? 'Unknown',
    linkMbps: num(v.linkMbps),
    mediaType: str(v.mediaType),
    mac: str(v.mac),
    driverVersion: str(v.driverVersion),
    driverDate: str(v.driverDate),
    serviceName: str(v.serviceName),
    isWifi: v.isWifi === true,
    isVirtual: v.isVirtual === true,
    mediaConnected: bool(v.mediaConnected),
    addresses: Array.isArray(v.addresses) ? v.addresses.filter((a): a is string => typeof a === 'string') : [],
    rxBytes: num(v.rxBytes),
    txBytes: num(v.txBytes),
    rxErrors: num(v.rxErrors),
    rxDiscards: num(v.rxDiscards),
    txErrors: num(v.txErrors),
    txDiscards: num(v.txDiscards),
  };
}

export function normalizeAdapters(v: unknown, fallbackTs: number): AdapterSnapshot | null {
  if (!isRecord(v) || !Array.isArray(v.adapters)) return null;
  return {
    ts: num(v.ts) ?? fallbackTs,
    adapters: v.adapters.map(adapter).filter((a): a is AdapterInfo => a !== null),
    routes: Array.isArray(v.routes) ? (v.routes.filter(isRecord) as unknown as AdapterSnapshot['routes']) : [],
    advanced: Array.isArray(v.advanced)
      ? v.advanced.filter(isRecord).map((a) => ({ name: String(a.name ?? ''), value: String(a.value ?? '') }))
      : [],
  };
}

/** the physical (non-virtual) wired adapter, preferring one that is up; else any physical adapter */
export function primaryWiredAdapter(s: AdapterSnapshot | null): AdapterInfo | null {
  if (!s) return null;
  const physical = s.adapters.filter((a) => !a.isVirtual);
  const wired = physical.filter((a) => !a.isWifi);
  return wired.find((a) => a.status.toLowerCase() === 'up') ?? wired[0] ?? physical[0] ?? null;
}

export function normalizeWlan(v: unknown, fallbackTs: number): WlanInfo | null {
  if (!isRecord(v)) return null;
  const raw: Record<string, string> = {};
  if (isRecord(v.raw)) for (const [k, x] of Object.entries(v.raw)) if (typeof x === 'string') raw[k] = x;
  return {
    ts: num(v.ts) ?? fallbackTs,
    present: v.present !== false,
    connected: v.connected === true,
    ssid: str(v.ssid),
    bssid: str(v.bssid),
    radioType: str(v.radioType),
    band: str(v.band),
    channel: num(v.channel),
    signalPct: num(v.signalPct),
    rssiDbm: num(v.rssiDbm),
    rxMbps: num(v.rxMbps),
    txMbps: num(v.txMbps),
    raw,
  };
}

export function normalizeVpn(v: unknown, fallbackTs: number): VpnInfo | null {
  if (!isRecord(v)) return null;
  const w = isRecord(v.warp) ? v.warp : null;
  return {
    ts: num(v.ts) ?? fallbackTs,
    warp: w
      ? {
          installed: w.installed !== false,
          connected: bool(w.connected),
          status: str(w.status),
          mode: str(w.mode),
          splitTunnel: w.splitTunnel === 'include' || w.splitTunnel === 'exclude' ? w.splitTunnel : null,
        }
      : null,
    otherTunnels: Array.isArray(v.otherTunnels) ? v.otherTunnels.filter((t): t is string => typeof t === 'string') : [],
  };
}

const MAPPINGS: readonly NatMapping[] = ['endpoint-independent', 'endpoint-dependent', 'blocked', 'unknown'];

function nat(v: unknown, fallbackTs: number): NatResult | null {
  if (!isRecord(v)) return null;
  const family = fam(v.family);
  if (family === null) return null;
  return {
    ts: num(v.ts) ?? fallbackTs,
    family,
    localAddress: str(v.localAddress),
    publicIp: str(v.publicIp),
    mappings: Array.isArray(v.mappings)
      ? v.mappings.filter(isRecord).map((m) => ({ server: String(m.server ?? ''), mapped: str(m.mapped), rttMs: num(m.rttMs), error: str(m.error) }))
      : [],
    mapping: MAPPINGS.includes(v.mapping as NatMapping) ? (v.mapping as NatMapping) : 'unknown',
    cgnat: bool(v.cgnat),
  };
}

function mtu(v: unknown, fallbackTs: number): MtuResult | null {
  if (!isRecord(v)) return null;
  const family = fam(v.family);
  if (family === null) return null;
  return { ts: num(v.ts) ?? fallbackTs, family, target: str(v.target) ?? '', mtu: num(v.mtu), maxPayload: num(v.maxPayload), note: str(v.note) };
}

/** snapshot data may be one result, an array or `{ results: [...] }`; returns the newest per family */
function perFamily<T extends { ts: number; family: 4 | 6 }>(
  snapshots: readonly { ts: number; data: unknown }[],
  parse: (v: unknown, ts: number) => T | null,
): T[] {
  const best = new Map<4 | 6, T>();
  for (const s of snapshots) {
    const list = Array.isArray(s.data) ? s.data : isRecord(s.data) && Array.isArray(s.data.results) ? s.data.results : [s.data];
    for (const item of list) {
      const r = parse(item, s.ts);
      if (!r) continue;
      const cur = best.get(r.family);
      if (!cur || r.ts > cur.ts) best.set(r.family, r);
    }
  }
  return [...best.values()].sort((a, b) => a.family - b.family);
}

export function normalizeNat(snapshots: readonly { ts: number; data: unknown }[]): NatResult[] {
  return perFamily(snapshots, nat);
}

export function normalizeMtu(snapshots: readonly { ts: number; data: unknown }[]): MtuResult[] {
  return perFamily(snapshots, mtu);
}
