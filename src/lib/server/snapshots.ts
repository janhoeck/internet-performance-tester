// Tolerant normalization of JSON snapshot data written by engine modules (shapes are typed in
// types.ts, but snapshots outlive code versions – never let a malformed row crash the UI).
import type {
  AdapterSnapshot,
  DocsisSnapshot,
  IpFamily,
  MtuResult,
  NatMapping,
  NatResult,
  RouterStatus,
  VpnInfo,
  WlanInfo,
} from '../shared/types';

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const family = (v: unknown): IpFamily | null => (v === 4 || v === 6 ? v : v === '4' ? 4 : v === '6' ? 6 : null);

export function normalizeRouterStatus(data: unknown, snapshotTs: number, fallbackIp: string): RouterStatus | null {
  if (!isRecord(data)) return null;
  const defaults: RouterStatus = {
    ts: snapshotTs,
    ip: fallbackIp,
    reachable: false,
    httpMs: null,
    adapter: 'generic',
    vendor: null,
    model: null,
    firmware: null,
    loginConfigured: false,
    loginEnabled: false,
    loggedIn: false,
    loginError: null,
    lockoutUntil: null,
    connectionStatus: null,
    wanIpv4: null,
    wanIpv6: null,
    aftrAddress: null,
    dsLite: null,
    gwMode: null,
    uptimeSec: null,
    lastRebootReason: null,
    docsis: null,
    attachedDevices: null,
    extra: {},
  };
  const merged = { ...defaults, ...(data as Partial<RouterStatus>) };
  if (typeof merged.ts !== 'number') merged.ts = snapshotTs;
  if (!isRecord(merged.extra)) merged.extra = {};
  if (merged.attachedDevices !== null && !Array.isArray(merged.attachedDevices)) merged.attachedDevices = null;
  merged.docsis = normalizeDocsis(merged.docsis);
  return merged;
}

export function normalizeDocsis(data: unknown): DocsisSnapshot | null {
  if (!isRecord(data)) return null;
  const ds = Array.isArray(data.ds) ? data.ds : [];
  const us = Array.isArray(data.us) ? data.us : [];
  return {
    ...(data as Partial<DocsisSnapshot>),
    ts: numOrNull(data.ts) ?? 0,
    ds,
    us,
    rating: data.rating === 'good' || data.rating === 'warn' || data.rating === 'bad' ? data.rating : 'unknown',
    notes: Array.isArray(data.notes) ? data.notes.filter((n): n is string => typeof n === 'string') : [],
  } as DocsisSnapshot;
}

export function normalizeAdapterSnapshot(data: unknown, snapshotTs: number): AdapterSnapshot | null {
  if (!isRecord(data)) return null;
  return {
    ...(data as Partial<AdapterSnapshot>),
    ts: numOrNull(data.ts) ?? snapshotTs,
    adapters: Array.isArray(data.adapters) ? (data.adapters as AdapterSnapshot['adapters']) : [],
    routes: Array.isArray(data.routes) ? (data.routes as AdapterSnapshot['routes']) : [],
    advanced: Array.isArray(data.advanced) ? (data.advanced as AdapterSnapshot['advanced']) : [],
  };
}

export function normalizeWlan(data: unknown, snapshotTs: number): WlanInfo | null {
  if (!isRecord(data)) return null;
  const defaults: WlanInfo = {
    ts: snapshotTs,
    present: false,
    connected: false,
    ssid: null,
    bssid: null,
    radioType: null,
    band: null,
    channel: null,
    signalPct: null,
    rssiDbm: null,
    rxMbps: null,
    txMbps: null,
    raw: {},
  };
  const merged = { ...defaults, ...(data as Partial<WlanInfo>) };
  if (!isRecord(merged.raw)) merged.raw = {};
  return merged;
}

export function normalizeVpn(data: unknown, snapshotTs: number): VpnInfo | null {
  if (!isRecord(data)) return null;
  return {
    ts: numOrNull(data.ts) ?? snapshotTs,
    warp: isRecord(data.warp) ? (data.warp as VpnInfo['warp']) : null,
    otherTunnels: Array.isArray(data.otherTunnels) ? data.otherTunnels.filter((t): t is string => typeof t === 'string') : [],
  };
}

/** Flatten snapshot data that may hold one result, an array or a wrapper object. */
function resultRecords(data: unknown, depth = 0): Record<string, unknown>[] {
  if (depth > 3) return [];
  if (Array.isArray(data)) return data.flatMap((d) => resultRecords(d, depth + 1));
  if (!isRecord(data)) return [];
  if ('family' in data) return [data];
  const out: Record<string, unknown>[] = [];
  for (const key of ['results', 'items', 'data', 'mtu', 'nat', 'v4', 'v6']) {
    if (key in data) out.push(...resultRecords(data[key], depth + 1));
  }
  return out;
}

export function mtuResults(data: unknown, snapshotTs: number): MtuResult[] {
  const out: MtuResult[] = [];
  for (const r of resultRecords(data)) {
    const fam = family(r.family);
    if (fam === null) continue;
    out.push({
      ts: numOrNull(r.ts) ?? snapshotTs,
      family: fam,
      target: strOrNull(r.target) ?? '',
      mtu: numOrNull(r.mtu),
      maxPayload: numOrNull(r.maxPayload),
      note: strOrNull(r.note),
    });
  }
  return out;
}

const NAT_MAPPINGS: readonly NatMapping[] = ['endpoint-independent', 'endpoint-dependent', 'blocked', 'unknown'];

export function natResults(data: unknown, snapshotTs: number): NatResult[] {
  const out: NatResult[] = [];
  for (const r of resultRecords(data)) {
    const fam = family(r.family);
    if (fam === null) continue;
    const mappings = Array.isArray(r.mappings)
      ? r.mappings.filter(isRecord).map((m) => ({
          server: strOrNull(m.server) ?? '',
          mapped: strOrNull(m.mapped),
          rttMs: numOrNull(m.rttMs),
          error: strOrNull(m.error),
        }))
      : [];
    const mapping = NAT_MAPPINGS.find((m) => m === r.mapping) ?? 'unknown';
    out.push({
      ts: numOrNull(r.ts) ?? snapshotTs,
      family: fam,
      localAddress: strOrNull(r.localAddress),
      publicIp: strOrNull(r.publicIp),
      mappings,
      mapping,
      cgnat: typeof r.cgnat === 'boolean' ? r.cgnat : null,
    });
  }
  return out;
}

/** Newest entry per IP family, IPv4 first. */
export function latestPerFamily<T extends { ts: number; family: IpFamily }>(items: readonly T[]): T[] {
  const best = new Map<IpFamily, T>();
  for (const it of items) {
    const cur = best.get(it.family);
    if (!cur || it.ts > cur.ts) best.set(it.family, it);
  }
  return [...best.values()].sort((a, b) => a.family - b.family);
}
