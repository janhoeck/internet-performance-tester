// Network adapters, addresses and active routes (ARCHITECTURE §4.9) via the PowerShell RPC worker
// (Get-NdNetSnapshot in ps-helpers.ps1): AdapterInfo list incl. MediaConnectState (WLAN truth),
// addresses (egress mapping), driver service names, relevant advanced properties (10 min) and the
// routes Windows uses for 1.1.1.1 / 2606:4700:4700::1111 (routePollSec). Emits metrics nic.* for the
// primary adapter (reset-safe counter deltas), adapter_change / route_switch events, bus 'adapters'
// on every poll, snapshot 'adapters' every 5 min + on change, and $router6.
// On macOS the same RawNetSnapshot comes from networksetup/ifconfig/netstat/route (macos/net-snapshot.ts).
import { isLinkLocalV6 } from '../../src/lib/shared/net';
import { fmtLinkSpeed } from '../../src/lib/shared/parsers/winevent';
import type { ActiveRoute, AdapterInfo, AdapterSnapshot, IpFamily, MetricPoint, ModuleState, NetEvent, Severity } from '../../src/lib/shared/types';
import type { EngineContext, EngineModule, Logger, PowerShellHost } from '../core/types';
import { isMac } from '../platform';
import { createMacNetSnapshotSource } from './macos/net-snapshot';
import { PollTimer, ProcessRunner, asArray, asBool, asNumber, asString, childTracker, errorMessage, isRecord, pollMs, psQuote, timersState } from './util';

// ─── raw shapes (Get-NdNetSnapshot) ────────────────────────────────────────

export interface RawAdapter {
  name: string;
  ifIndex: number;
  guid: string | null;
  description: string;
  status: string;
  mediaConnectState: number | null;
  mediaType: string | null;
  physicalMedium: number | null;
  rxBps: number | null;
  txBps: number | null;
  mac: string | null;
  driverVersion: string | null;
  driverDate: string | null;
  virtual: boolean;
  hardware: boolean;
  /** macOS: BSD name (Windows: undefined) */
  device?: string | null;
}

export interface RawStats {
  name: string;
  rxBytes: number | null;
  txBytes: number | null;
  rxErrors: number | null;
  rxDiscards: number | null;
  txErrors: number | null;
  txDiscards: number | null;
}

export interface RawAddress {
  ifIndex: number;
  ip: string;
  family: string | null;
  prefixOrigin: string | null;
  suffixOrigin: string | null;
  state: string | null;
}

export interface RawRoute {
  remote: string;
  found: boolean;
  sourceAddress: string | null;
  ifIndex: number | null;
  ifAlias: string | null;
  nextHop: string | null;
}

export interface RawAdvanced {
  keyword: string;
  value: string | null;
  displayName: string | null;
  displayValue: string | null;
}

export interface RawNetSnapshot {
  t: number | null;
  adapters: RawAdapter[];
  stats: RawStats[];
  addresses: RawAddress[];
  routes: RawRoute[] | null;
  services: { guid: string; serviceName: string }[] | null;
  advanced: RawAdvanced[] | null;
}

const s = (v: unknown): string | null => {
  const x = asString(v);
  return x !== null && x.trim() !== '' ? x.trim() : null;
};

function parseAdapter(v: unknown): RawAdapter | null {
  if (!isRecord(v)) return null;
  const name = s(v.name);
  const ifIndex = asNumber(v.ifIndex);
  if (!name || ifIndex === null) return null;
  return {
    name,
    ifIndex,
    guid: s(v.guid),
    description: s(v.description) ?? '',
    status: s(v.status) ?? 'Unknown',
    mediaConnectState: asNumber(v.mediaConnectState),
    mediaType: s(v.mediaType),
    physicalMedium: asNumber(v.physicalMedium),
    rxBps: asNumber(v.rxBps),
    txBps: asNumber(v.txBps),
    mac: s(v.mac),
    driverVersion: s(v.driverVersion),
    driverDate: s(v.driverDate),
    virtual: asBool(v.virtual) ?? false,
    hardware: asBool(v.hardware) ?? true,
  };
}

/** Validates the JSON of Get-NdNetSnapshot (PowerShell unwraps single-element arrays). */
export function parseNetSnapshot(v: unknown): RawNetSnapshot | null {
  if (!isRecord(v)) return null;
  const adapters = asArray(v.adapters).map(parseAdapter).filter((a): a is RawAdapter => a !== null);
  const stats: RawStats[] = [];
  for (const x of asArray(v.stats)) {
    if (!isRecord(x)) continue;
    const name = s(x.name);
    if (!name) continue;
    stats.push({
      name,
      rxBytes: asNumber(x.rxBytes),
      txBytes: asNumber(x.txBytes),
      rxErrors: asNumber(x.rxErrors),
      rxDiscards: asNumber(x.rxDiscards),
      txErrors: asNumber(x.txErrors),
      txDiscards: asNumber(x.txDiscards),
    });
  }
  const addresses: RawAddress[] = [];
  for (const x of asArray(v.addresses)) {
    if (!isRecord(x)) continue;
    const ip = s(x.ip);
    const ifIndex = asNumber(x.ifIndex);
    if (!ip || ifIndex === null) continue;
    addresses.push({ ifIndex, ip, family: s(x.family), prefixOrigin: s(x.prefixOrigin), suffixOrigin: s(x.suffixOrigin), state: s(x.state) });
  }
  const routes =
    v.routes === undefined
      ? null
      : asArray(v.routes)
          .filter(isRecord)
          .map((x) => ({
            remote: s(x.remote) ?? '',
            found: asBool(x.found) ?? false,
            sourceAddress: s(x.sourceAddress),
            ifIndex: asNumber(x.ifIndex),
            ifAlias: s(x.ifAlias),
            nextHop: s(x.nextHop),
          }))
          .filter((r) => r.remote !== '');
  const services =
    v.services === undefined
      ? null
      : asArray(v.services)
          .filter(isRecord)
          .map((x) => ({ guid: s(x.guid) ?? '', serviceName: s(x.serviceName) ?? '' }))
          .filter((x) => x.guid !== '' && x.serviceName !== '');
  const advanced =
    v.advanced === undefined
      ? null
      : asArray(v.advanced)
          .filter(isRecord)
          .map((x) => ({ keyword: s(x.keyword) ?? '', value: s(x.value), displayName: s(x.displayName), displayValue: s(x.displayValue) }))
          .filter((x) => x.keyword !== '');
  return { t: asNumber(v.t), adapters, stats, addresses, routes, services, advanced };
}

// ─── mapping ───────────────────────────────────────────────────────────────

const WIFI_TEXT = /802\.11|wireless|wi-?fi|wlan/i;

export function isWifiAdapter(a: Pick<RawAdapter, 'physicalMedium' | 'mediaType' | 'description' | 'name'>): boolean {
  if (a.physicalMedium === 1 || a.physicalMedium === 9) return true;
  return WIFI_TEXT.test(`${a.mediaType ?? ''} ${a.description} ${a.name}`);
}

/** connected = Up and not soft-disconnected (MSFT_NetAdapter.MediaConnectState 2) */
export function isConnected(a: Pick<AdapterInfo, 'status' | 'mediaConnected'>): boolean {
  return a.status === 'Up' && a.mediaConnected !== false;
}

const normGuid = (g: string) => g.replace(/[{}]/g, '').toLowerCase();

/** AdapterInfo + interface GUID (extra JSON field: maps NCSI/WLAN event-log entries to adapters) */
export interface AdapterInfoExt extends AdapterInfo {
  guid: string | null;
  /** macOS: BSD name of the interface (e.g. 'en7'; `name` is the hardware port, e.g. 'Ethernet') */
  device?: string | null;
}

export function toAdapterInfos(raw: RawNetSnapshot, serviceNames: ReadonlyMap<string, string>): AdapterInfoExt[] {
  const stats = new Map(raw.stats.map((x) => [x.name.toLowerCase(), x]));
  const byIf = new Map<number, string[]>();
  for (const a of raw.addresses) {
    const list = byIf.get(a.ifIndex) ?? [];
    list.push(a.ip);
    byIf.set(a.ifIndex, list);
  }
  return raw.adapters.map((a) => {
    const st = stats.get(a.name.toLowerCase());
    const mediaConnected = a.mediaConnectState === 1 ? true : a.mediaConnectState === 2 ? false : null;
    const up = a.status === 'Up' && mediaConnected !== false;
    const bps = Math.max(a.rxBps ?? 0, a.txBps ?? 0);
    return {
      name: a.name,
      description: a.description,
      ifIndex: a.ifIndex,
      guid: a.guid ? a.guid.toLowerCase() : null,
      ...(a.device ? { device: a.device } : {}),
      status: a.status,
      linkMbps: up && bps > 0 ? Math.round(bps / 1e6) : null,
      mediaType: a.mediaType,
      mac: a.mac,
      driverVersion: a.driverVersion,
      driverDate: a.driverDate,
      serviceName: a.guid ? (serviceNames.get(normGuid(a.guid)) ?? null) : null,
      isWifi: isWifiAdapter(a),
      isVirtual: a.virtual || !a.hardware,
      mediaConnected,
      addresses: byIf.get(a.ifIndex) ?? [],
      rxBytes: st?.rxBytes ?? null,
      txBytes: st?.txBytes ?? null,
      rxErrors: st?.rxErrors ?? null,
      rxDiscards: st?.rxDiscards ?? null,
      txErrors: st?.txErrors ?? null,
      txDiscards: st?.txDiscards ?? null,
    };
  });
}

export function serviceMap(list: { guid: string; serviceName: string }[]): Map<string, string> {
  return new Map(list.map((x) => [normGuid(x.guid), x.serviceName]));
}

export const ROUTE_TARGETS: Record<IpFamily, string> = { 4: '1.1.1.1', 6: '2606:4700:4700::1111' };

export function toActiveRoutes(raw: RawRoute[]): ActiveRoute[] {
  const out: ActiveRoute[] = [];
  for (const r of raw) {
    const family: IpFamily = r.remote === ROUTE_TARGETS[4] ? 4 : r.remote === ROUTE_TARGETS[6] ? 6 : r.remote.includes(':') ? 6 : 4;
    if (!r.found) continue;
    out.push({ family, destination: r.remote, ifAlias: r.ifAlias, ifIndex: r.ifIndex, sourceAddress: r.sourceAddress, nextHop: r.nextHop });
  }
  return out;
}

/** $router6 = IPv6 next hop of the IPv6 internet route, link-local with zone id (fe80::…%4). */
export function router6From(routes: readonly ActiveRoute[]): string | null {
  const r = routes.find((x) => x.family === 6);
  const hop = r?.nextHop?.trim();
  if (!r || !hop || hop === '::' || hop === '0.0.0.0') return null;
  if (isLinkLocalV6(hop) && !hop.includes('%')) return r.ifIndex !== null ? `${hop}%${r.ifIndex}` : null;
  return hop;
}

const sameName = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/** Adapter the nic.* metrics describe: expected interface (session) → IPv4 route → first connected physical. */
export function pickPrimary(adapters: readonly AdapterInfo[], routes: readonly ActiveRoute[], expectedIf: string | null): AdapterInfo | null {
  if (expectedIf) {
    const exp = adapters.find((a) => sameName(a.name, expectedIf));
    if (exp) return exp;
  }
  const physical = adapters.filter((a) => !a.isVirtual);
  const v4 = routes.find((r) => r.family === 4);
  const routed = v4 ? physical.find((a) => sameName(a.name, v4.ifAlias) || (v4.ifIndex !== null && a.ifIndex === v4.ifIndex)) : undefined;
  if (routed) return routed;
  const connected = physical.filter(isConnected);
  return connected.find((a) => !a.isWifi) ?? connected[0] ?? physical.find((a) => !a.isWifi) ?? physical[0] ?? null;
}

// ─── metrics ───────────────────────────────────────────────────────────────

export interface CounterSample {
  name: string;
  ts: number;
  rxBytes: number | null;
  txBytes: number | null;
  rxErrors: number | null;
  rxDiscards: number | null;
  txErrors: number | null;
  txDiscards: number | null;
}

export function counterSample(a: AdapterInfo, ts: number): CounterSample {
  return { name: a.name, ts, rxBytes: a.rxBytes, txBytes: a.txBytes, rxErrors: a.rxErrors, rxDiscards: a.rxDiscards, txErrors: a.txErrors, txDiscards: a.txDiscards };
}

/** Δ of a cumulative counter; null when unknown or reset (counter went backwards). */
export function counterDelta(prev: number | null, cur: number | null): number | null {
  if (prev === null || cur === null) return null;
  return cur >= prev ? cur - prev : null;
}

/**
 * nic.* metrics of the primary adapter. Rates and error deltas need a previous sample of the same
 * adapter not older than `maxGapMs` (first poll, adapter switch, standby gap → no rates).
 */
export function nicMetrics(primary: AdapterInfo, prev: CounterSample | null, ts: number, maxGapMs: number, opts: { full: boolean }): MetricPoint[] {
  const out: MetricPoint[] = [];
  const up = isConnected(primary);
  if (opts.full) {
    out.push({ ts, key: 'nic.up', value: up ? 1 : 0 });
    if (up && primary.linkMbps !== null) out.push({ ts, key: 'nic.link_mbps', value: primary.linkMbps });
  }
  if (!prev || prev.name !== primary.name) return out;
  const dt = ts - prev.ts;
  if (dt <= 0 || dt > maxGapMs) return out;
  const rx = counterDelta(prev.rxBytes, primary.rxBytes);
  const tx = counterDelta(prev.txBytes, primary.txBytes);
  if (rx !== null) out.push({ ts, key: 'nic.rx_mbps', value: Math.round(((rx * 8) / (dt / 1000) / 1e6) * 1000) / 1000 });
  if (tx !== null) out.push({ ts, key: 'nic.tx_mbps', value: Math.round(((tx * 8) / (dt / 1000) / 1e6) * 1000) / 1000 });
  const errs: [string, number | null][] = [
    ['nic.rx_errors', counterDelta(prev.rxErrors, primary.rxErrors)],
    ['nic.tx_errors', counterDelta(prev.txErrors, primary.txErrors)],
    ['nic.rx_discards', counterDelta(prev.rxDiscards, primary.rxDiscards)],
    ['nic.tx_discards', counterDelta(prev.txDiscards, primary.txDiscards)],
  ];
  // 'sum' metrics: only non-zero deltas are stored (missing = 0)
  for (const [key, d] of errs) if (d !== null && d > 0) out.push({ ts, key, value: d });
  return out;
}

// ─── events ────────────────────────────────────────────────────────────────

export interface DiffContext {
  ts: number;
  /** interface the running session expects (null without session) */
  expectedIf: string | null;
  /** first poll after start: compare only driver versions (status changes during downtime are unknown) */
  driverOnly?: boolean;
}

function adapterEvent(ts: number, severity: Severity, title: string, a: AdapterInfo, details: Record<string, unknown>): NetEvent {
  return {
    ts,
    type: 'adapter_change',
    severity,
    segment: 'client',
    title,
    details: { adapter: a.name, ifIndex: a.ifIndex, isWifi: a.isWifi, status: a.status, linkMbps: a.linkMbps, mediaConnected: a.mediaConnected, ...details },
    source: 'adapter',
  };
}

/** adapter_change events between two polls (physical adapters only). */
export function diffAdapters(prev: readonly AdapterInfo[], cur: readonly AdapterInfo[], c: DiffContext): NetEvent[] {
  const out: NetEvent[] = [];
  const key = (a: AdapterInfo) => a.name.toLowerCase();
  const before = new Map(prev.filter((a) => !a.isVirtual).map((a) => [key(a), a]));
  const after = new Map(cur.filter((a) => !a.isVirtual).map((a) => [key(a), a]));
  for (const [k, a] of after) {
    const p = before.get(k);
    if (!p) {
      if (!c.driverOnly && before.size > 0) out.push(adapterEvent(c.ts, 'info', `Netzwerkadapter hinzugefügt: ${a.name}`, a, { change: 'added' }));
      continue;
    }
    if (p.driverVersion && a.driverVersion && p.driverVersion !== a.driverVersion) {
      out.push(
        adapterEvent(c.ts, 'info', `${a.name}: Treiber geändert (${p.driverVersion} → ${a.driverVersion})`, a, {
          change: 'driver',
          from: { driverVersion: p.driverVersion, driverDate: p.driverDate, serviceName: p.serviceName },
          to: { driverVersion: a.driverVersion, driverDate: a.driverDate, serviceName: a.serviceName },
        }),
      );
    }
    if (c.driverOnly) continue;
    const wasUp = isConnected(p);
    const isUp = isConnected(a);
    const expected = sameName(c.expectedIf, a.name);
    if (wasUp && !isUp) {
      const title = a.status === 'Disabled' ? `${a.name}: Adapter deaktiviert` : `${a.name}: Verbindung getrennt`;
      out.push(adapterEvent(c.ts, expected ? 'warn' : 'info', title, a, { change: 'status', from: p.status, to: a.status }));
    } else if (!wasUp && isUp) {
      const speed = a.linkMbps !== null && !a.isWifi ? ` (${fmtLinkSpeed(a.linkMbps)})` : '';
      out.push(adapterEvent(c.ts, 'info', `${a.name}: Verbindung hergestellt${speed}`, a, { change: 'status', from: p.status, to: a.status }));
    } else if (isUp && !a.isWifi && p.linkMbps !== null && a.linkMbps !== null && p.linkMbps !== a.linkMbps) {
      const worse = a.linkMbps < p.linkMbps && a.linkMbps < 1000;
      out.push(
        adapterEvent(c.ts, worse ? 'warn' : 'info', `${a.name}: Link-Geschwindigkeit ${fmtLinkSpeed(p.linkMbps)} → ${fmtLinkSpeed(a.linkMbps)}`, a, {
          change: 'speed',
          from: p.linkMbps,
          to: a.linkMbps,
        }),
      );
    }
  }
  if (!c.driverOnly) {
    for (const [k, p] of before) {
      if (!after.has(k)) out.push(adapterEvent(c.ts, sameName(c.expectedIf, p.name) ? 'warn' : 'info', `Netzwerkadapter entfernt: ${p.name}`, p, { change: 'removed' }));
    }
  }
  return out;
}

const familyText = (f: IpFamily) => (f === 4 ? 'IPv4' : 'IPv6');

/** route_switch events when the interface carrying the internet route changes. */
export function diffRoutes(prev: readonly ActiveRoute[], cur: readonly ActiveRoute[], adapters: readonly AdapterInfo[], c: DiffContext): NetEvent[] {
  const out: NetEvent[] = [];
  const wifi = (alias: string | null) => (alias ? (adapters.find((a) => sameName(a.name, alias))?.isWifi ?? WIFI_TEXT.test(alias)) : false);
  for (const family of [4, 6] as const) {
    const p = prev.find((r) => r.family === family) ?? null;
    const n = cur.find((r) => r.family === family) ?? null;
    const from = p?.ifAlias ?? null;
    const to = n?.ifAlias ?? null;
    if ((from ?? '').toLowerCase() === (to ?? '').toLowerCase()) continue;
    const f = familyText(family);
    let title: string;
    if (from && to) title = `Internetverkehr (${f}) läuft jetzt über ${to} statt ${from}`;
    else if (to) title = `${f}-Internetroute über ${to} wiederhergestellt`;
    else title = `Keine ${f}-Internetroute mehr (zuvor ${from ?? '–'})`;
    const offExpected = c.expectedIf !== null && to !== null && !sameName(to, c.expectedIf);
    const severity: Severity = to === null || offExpected || (wifi(to) && from !== null && !wifi(from)) ? 'warn' : 'info';
    out.push({
      ts: c.ts,
      type: 'route_switch',
      severity,
      segment: 'client',
      title,
      details: {
        family,
        from,
        to,
        fromIfIndex: p?.ifIndex ?? null,
        toIfIndex: n?.ifIndex ?? null,
        sourceAddress: n?.sourceAddress ?? null,
        nextHop: n?.nextHop ?? null,
        fromWifi: wifi(from),
        toWifi: wifi(to),
        expectedIf: c.expectedIf,
      },
      source: 'route',
    });
  }
  return out;
}

// ─── advanced properties ───────────────────────────────────────────────────

/** RegistryKeywords worth showing (language independent); display names come from the driver. */
const ADVANCED_KEYWORDS = new Set(
  [
    '*SpeedDuplex', '*SelectiveSuspend', '*SSIdleTimeout', 'IdleTimeoutMs', '*EEE', 'EEELinkAdvertisement', 'AdvancedEEE',
    'EnableGreenEthernet', 'ReduceSpeedOnPowerDown', 'ULPMode', '*FlowControl', '*InterruptModeration', 'ITR',
    'WaitAutoNegComplete', '*DeviceSleepOnDisconnect', 'WakeOnLink', '*WakeOnMagicPacket', '*WakeOnPattern', 'EnablePME',
    'DMACoalescing', 'LogLinkStateEvent', '*JumboPacket', 'MasterSlave', 'EnableModernStandby', '*NumRssQueues', '*RSS',
    '*PMARPOffload', '*PMNSOffload', '*LsoV2IPv4', '*LsoV2IPv6',
    'RoamAggressiveness', 'MIMOPowerSaveMode', '*PacketCoalescing', 'uAPSDSupport', 'ThroughputBoosterEnabled',
    'ChannelWidth24', 'ChannelWidth52', 'ChannelWidth6', 'RoamingPreferredBandType', 'IbssTxPower', 'TxPower',
    '*PreferredBand', 'WirelessMode', 'MixedModeProtection', 'FatChannelIntolerant',
  ].map((k) => k.toLowerCase()),
);

export interface AdvancedProperty {
  name: string;
  value: string;
  keyword: string;
  registryValue: string | null;
}

export function relevantAdvanced(list: readonly RawAdvanced[]): AdvancedProperty[] {
  return list
    .filter((x) => ADVANCED_KEYWORDS.has(x.keyword.toLowerCase()))
    .map((x) => ({
      name: x.displayName ?? x.keyword,
      value: x.displayValue ?? x.value ?? '',
      keyword: x.keyword,
      registryValue: x.value,
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'de'));
}

// ─── snapshot ──────────────────────────────────────────────────────────────

export interface AdapterSnapshotExt extends AdapterSnapshot {
  advanced: AdvancedProperty[];
  /** adapter the nic.* metrics describe */
  primary: string | null;
  /** adapter the advanced properties belong to */
  advancedFor: string | null;
}

/** Everything that matters for "snapshot on change" (no byte counters, no WLAN rate fluctuations). */
export function snapshotSignature(snap: Pick<AdapterSnapshotExt, 'adapters' | 'routes' | 'advanced' | 'primary'>): string {
  return JSON.stringify({
    a: snap.adapters.map((a) => [a.name, a.status, a.mediaConnected, a.isWifi ? null : a.linkMbps, a.driverVersion, a.serviceName, [...a.addresses].sort()]),
    r: snap.routes.map((r) => [r.family, r.ifAlias, r.nextHop, r.sourceAddress]),
    v: snap.advanced.map((x) => [x.keyword, x.registryValue]),
    p: snap.primary,
  });
}

// ─── module ────────────────────────────────────────────────────────────────

const IDLE_POLL_SEC = 60;
const SNAPSHOT_EVERY_MS = 5 * 60_000;
const SLOW_EVERY_MS = 10 * 60_000;
const PS_TIMEOUT_MS = 30_000;

export function snapshotScript(opts: { routes: boolean; services: boolean; advancedFor: string | null }): string {
  const parts = ['Get-NdNetSnapshot'];
  if (opts.routes) parts.push('-Routes');
  if (opts.services) parts.push('-Services');
  if (opts.advancedFor) parts.push(`-AdvancedFor ${psQuote(opts.advancedFor)}`);
  return parts.join(' ');
}

// ─── raw data sources ──────────────────────────────────────────────────────

export interface NetSnapshotRequest {
  /** routes towards 1.1.1.1 / 2606:4700:4700::1111 */
  routes: boolean;
  /** driver service names (Windows only) */
  services: boolean;
  /** advanced properties of this adapter (Windows only) */
  advancedFor: string | null;
}

/** Raw adapter data of one poll; throws a German error when it cannot be read. */
export interface NetSnapshotSource {
  fetch(req: NetSnapshotRequest): Promise<RawNetSnapshot>;
  dispose?(): void;
}

/** Windows: Get-NdNetSnapshot through the PowerShell RPC worker. */
export function powerShellNetSnapshotSource(ps: PowerShellHost): NetSnapshotSource {
  return {
    async fetch(req) {
      if (!ps.available) throw new Error('PowerShell nicht verfügbar');
      const data = await ps.json<unknown>(snapshotScript(req), { timeoutMs: PS_TIMEOUT_MS });
      const raw = parseNetSnapshot(data);
      if (!raw) throw new Error('Unerwartete Antwort von Get-NdNetSnapshot');
      return raw;
    },
  };
}

/** Source for the current platform: macOS tools or the PowerShell worker. */
export function defaultNetSnapshotSource(ctx: EngineContext): NetSnapshotSource {
  return isMac() ? createMacNetSnapshotSource({ runner: new ProcessRunner(childTracker(ctx)) }) : powerShellNetSnapshotSource(ctx.ps);
}

export interface AdapterModuleOptions {
  /** raw data source (default: by platform) */
  createSource?: (ctx: EngineContext) => NetSnapshotSource;
  /** start the poll timer in init() (default true) */
  autoStart?: boolean;
}

class AdapterModule implements EngineModule {
  readonly name = 'adapter';
  private ctx: EngineContext | null = null;
  private log: Logger | null = null;
  private source: NetSnapshotSource | null = null;
  private timer: PollTimer | null = null;
  private adapters: AdapterInfo[] | null = null;
  private routes: ActiveRoute[] = [];
  private routesTs = 0;
  private services = new Map<string, string>();
  private servicesTs = 0;
  private advanced: AdvancedProperty[] = [];
  private advancedFor: string | null = null;
  private advancedTs = 0;
  private counters: CounterSample | null = null;
  private lastSnapshotTs = 0;
  private lastSignature = '';
  private lastMetricsFull = '';
  private firstPoll = true;
  private lastError: string | null = null;

  constructor(private readonly opts: AdapterModuleOptions = {}) {}

  init(ctx: EngineContext): void {
    this.ctx = ctx;
    this.log = ctx.log;
    this.source = (this.opts.createSource ?? defaultNetSnapshotSource)(ctx);
    // baseline for driver changes that happened while the engine was not running
    try {
      const prev = ctx.db.latestSnapshot<AdapterSnapshotExt>('adapters')?.data;
      if (prev && Array.isArray(prev.adapters)) this.adapters = prev.adapters;
      if (prev && Array.isArray(prev.routes)) this.routes = prev.routes;
    } catch {
      /* no snapshot yet */
    }
    this.timer = new PollTimer({
      intervalMs: () => pollMs(ctx, ctx.config().schedules.adapterPollSec, IDLE_POLL_SEC),
      run: () => this.poll(),
      onError: (err) => {
        this.lastError = errorMessage(err);
        this.log?.debug('Adapterabfrage fehlgeschlagen', { error: this.lastError });
      },
    });
    if (this.opts.autoStart !== false) this.timer.start(500);
  }

  start(): void {
    this.routesTs = 0; // fresh routes for the session start context
    this.timer?.trigger(0);
  }

  stop(): void {
    this.timer?.trigger(1000);
  }

  reconfigure(): void {
    this.timer?.trigger(1000);
  }

  async runNow(): Promise<AdapterSnapshotExt | null> {
    this.routesTs = 0;
    this.advancedTs = 0;
    await this.timer?.runNow();
    return this.ctx?.db.latestSnapshot<AdapterSnapshotExt>('adapters')?.data ?? null;
  }

  dispose(): void {
    this.timer?.stop();
    this.source?.dispose?.();
  }

  state(): ModuleState {
    return timersState(this.name, true, this.timer ? [this.timer] : [], this.lastError);
  }

  private async poll(): Promise<void> {
    const ctx = this.ctx;
    const source = this.source;
    if (!ctx || !source) return;
    const now = Date.now();
    const cfg = ctx.config();
    const expectedIf = ctx.expectedInterface();
    const wantRoutes = this.firstPoll || now - this.routesTs >= cfg.schedules.routePollSec * 1000 - 500;
    const wantServices = this.firstPoll || now - this.servicesTs >= SLOW_EVERY_MS;
    // advanced properties of the primary adapter (from the previous poll) every 10 min
    const prevPrimary = this.adapters ? pickPrimary(this.adapters, this.routes, expectedIf) : null;
    const advFor = prevPrimary && !prevPrimary.isVirtual ? prevPrimary.name : null;
    const wantAdvanced = advFor !== null && (now - this.advancedTs >= SLOW_EVERY_MS || !sameName(advFor, this.advancedFor));

    const raw = await source.fetch({ routes: wantRoutes, services: wantServices, advancedFor: wantAdvanced ? advFor : null });
    const ts = Date.now();
    if (raw.services) {
      this.services = serviceMap(raw.services);
      this.servicesTs = ts;
    }
    if (raw.advanced && wantAdvanced) {
      this.advanced = relevantAdvanced(raw.advanced);
      this.advancedFor = advFor;
      this.advancedTs = ts;
    }
    const adapters = toAdapterInfos(raw, this.services);
    const prevRoutes = this.routes;
    if (raw.routes) {
      this.routes = toActiveRoutes(raw.routes);
      this.routesTs = ts;
    }

    // events
    const diffCtx: DiffContext = { ts, expectedIf, driverOnly: this.firstPoll };
    const events = this.adapters ? diffAdapters(this.adapters, adapters, diffCtx) : [];
    const statusChanged = events.some((e) => e.details?.change === 'status');
    if (raw.routes && !this.firstPoll) events.push(...diffRoutes(prevRoutes, this.routes, adapters, diffCtx));
    for (const e of events) ctx.recordEvent(e);
    this.adapters = adapters;
    if (statusChanged) this.routesTs = 0; // re-check routes on the next poll

    // $router6
    if (raw.routes) {
      const r6 = router6From(this.routes);
      if (r6) ctx.hosts.set({ router6: r6 }, 'adapter');
    }

    // metrics
    const primary = pickPrimary(adapters, this.routes, expectedIf);
    if (primary) {
      const measuring = ctx.isMeasuring();
      const fullKey = `${primary.name}|${isConnected(primary)}|${primary.isWifi ? '' : primary.linkMbps}`;
      const full = measuring || fullKey !== this.lastMetricsFull;
      this.lastMetricsFull = fullKey;
      const maxGap = Math.max(5 * pollMs(ctx, cfg.schedules.adapterPollSec, IDLE_POLL_SEC), 30_000);
      const points = nicMetrics(primary, this.counters, ts, maxGap, { full });
      if (points.length) ctx.recordMetrics(points);
      this.counters = counterSample(primary, ts);
    }

    // snapshot + bus
    const snap: AdapterSnapshotExt = {
      ts,
      adapters,
      routes: this.routes,
      advanced: this.advanced,
      primary: primary?.name ?? null,
      advancedFor: this.advancedFor,
    };
    ctx.bus.emit('adapters', snap);
    const sig = snapshotSignature(snap);
    if (sig !== this.lastSignature || ts - this.lastSnapshotTs >= SNAPSHOT_EVERY_MS) {
      ctx.recordSnapshot('adapters', snap, ts);
      this.lastSignature = sig;
      this.lastSnapshotTs = ts;
    }
    this.firstPoll = false;
    this.lastError = null;
  }
}

export function createAdapterModule(opts: AdapterModuleOptions = {}): EngineModule {
  return new AdapterModule(opts);
}
