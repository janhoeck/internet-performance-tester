import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ActiveRoute, AdapterInfo } from '../../src/lib/shared/types';
import {
  counterDelta,
  counterSample,
  diffAdapters,
  diffRoutes,
  isConnected,
  nicMetrics,
  parseNetSnapshot,
  pickPrimary,
  powerShellNetSnapshotSource,
  relevantAdvanced,
  router6From,
  serviceMap,
  snapshotScript,
  snapshotSignature,
  toActiveRoutes,
  toAdapterInfos,
  type RawAdvanced,
} from './adapter';

/** Real `Get-NdNetSnapshot -Routes -Services -AdvancedFor WLAN` on Jan-PC, 2026-10-09 ~19:05 (Ethernet 1 Gbit/s + WLAN, trimmed). */
const REAL = {
  t: 1791565466127,
  adapters: [
    { name: 'CloudflareWARP', ifIndex: 19, guid: '{DB484304-DB04-6AA0-A33D-7236836B364D}', description: 'Cloudflare WARP Interface Tunnel', status: 'Up', mediaConnectState: 1, mediaType: 'IP', physicalMedium: 0, rxBps: 100000000000, txBps: 100000000000, mac: '', driverVersion: '0.14.0.0', driverDate: '2021-10-13', virtual: true, hardware: false },
    { name: 'Bluetooth-Netzwerkverbindung', ifIndex: 14, guid: '{737DCAA8-CA1C-4541-B801-C6A713D7B2A5}', description: 'Bluetooth Device (Personal Area Network)', status: 'Disconnected', mediaConnectState: 2, mediaType: '802.3', physicalMedium: 10, rxBps: 3000000, txBps: 3000000, mac: 'E4-60-17-12-34-05', driverVersion: '10.0.26100.8972', driverDate: '2006-06-21', virtual: true, hardware: false },
    { name: 'WLAN', ifIndex: 6, guid: '{1CDB0EF5-CB64-4B03-9B8D-3DE53AB40921}', description: 'Intel(R) Wi-Fi 6E AX211 160MHz', status: 'Up', mediaConnectState: 1, mediaType: 'Native 802.11', physicalMedium: 9, rxBps: 206000000, txBps: 138000000, mac: 'E4-60-17-12-34-01', driverVersion: '23.40.0.4', driverDate: '2024-03-10', virtual: false, hardware: true },
    { name: 'Ethernet', ifIndex: 4, guid: '{178AF0A6-93F5-4ACE-ACE2-2ECDF78704F2}', description: 'Intel(R) Ethernet Controller (3) I225-V', status: 'Up', mediaConnectState: 1, mediaType: '802.3', physicalMedium: 14, rxBps: 1000000000, txBps: 1000000000, mac: 'D8-43-AE-12-34-56', driverVersion: '2.1.5.7', driverDate: '2025-09-03', virtual: false, hardware: true },
  ],
  stats: [
    { name: 'CloudflareWARP', rxBytes: 4199, txBytes: 57830, rxErrors: 0, rxDiscards: 0, txErrors: 0, txDiscards: 0 },
    { name: 'WLAN', rxBytes: 3694952, txBytes: 3137323, rxErrors: 0, rxDiscards: 0, txErrors: 0, txDiscards: 0 },
    { name: 'Ethernet', rxBytes: 148776563, txBytes: 79802024, rxErrors: 0, rxDiscards: 0, txErrors: 0, txDiscards: 0 },
  ],
  addresses: [
    { ifIndex: 4, ip: 'fe80::374c:2a6a:2786:ee2e%4', prefixLength: 64, family: 'IPv6', prefixOrigin: 'WellKnown', suffixOrigin: 'Link', state: 'Preferred' },
    { ifIndex: 4, ip: '3fff:8071:7ca0:c980:7df5:ffbf:6014:ea67', prefixLength: 128, family: 'IPv6', prefixOrigin: 'RouterAdvertisement', suffixOrigin: 'Random', state: 'Preferred' },
    { ifIndex: 6, ip: '3fff:8071:7ca0:c980:dc61:7ba6:f49b:7d89', prefixLength: 128, family: 'IPv6', prefixOrigin: 'RouterAdvertisement', suffixOrigin: 'Random', state: 'Preferred' },
    { ifIndex: 19, ip: '2606:4700:cf1:1000::7', prefixLength: 128, family: 'IPv6', prefixOrigin: 'Manual', suffixOrigin: 'Manual', state: 'Preferred' },
    { ifIndex: 4, ip: '192.168.0.192', prefixLength: 24, family: 'IPv4', prefixOrigin: 'Dhcp', suffixOrigin: 'Dhcp', state: 'Preferred' },
    { ifIndex: 6, ip: '192.168.0.35', prefixLength: 24, family: 'IPv4', prefixOrigin: 'Dhcp', suffixOrigin: 'Dhcp', state: 'Preferred' },
    { ifIndex: 19, ip: '100.96.0.7', prefixLength: 32, family: 'IPv4', prefixOrigin: 'Manual', suffixOrigin: 'Manual', state: 'Preferred' },
  ],
  routes: [
    { remote: '1.1.1.1', found: true, sourceAddress: '192.168.0.192', ifIndex: 4, ifAlias: 'Ethernet', nextHop: '192.168.0.1', prefix: '0.0.0.0/0', routeMetric: 0, ifMetric: 25 },
    { remote: '2606:4700:4700::1111', found: true, sourceAddress: '3fff:8071:7ca0:c980:7df5:ffbf:6014:ea67', ifIndex: 4, ifAlias: 'Ethernet', nextHop: 'fe80::de73:6ff:fe12:34df', prefix: '::/0', routeMetric: 256, ifMetric: 25 },
  ],
  services: [
    { guid: '{1CDB0EF5-CB64-4B03-9B8D-3DE53AB40921}', serviceName: 'Netwtw14' },
    { guid: '{178AF0A6-93F5-4ACE-ACE2-2ECDF78704F2}', serviceName: 'e2fnexpress' },
    { guid: '{DB484304-DB04-6AA0-A33D-7236836B364D}', serviceName: 'wintun' },
  ],
  advanced: [
    { keyword: '*PacketCoalescing', value: '1', displayName: 'Packet Coalescing', displayValue: 'Enabled' },
    { keyword: 'MIMOPowerSaveMode', value: '0', displayName: 'MIMO Power Save Mode', displayValue: 'Auto SMPS' },
    { keyword: 'RoamAggressiveness', value: '2', displayName: 'Roaming Aggressiveness', displayValue: '3. Medium' },
    { keyword: 'NetworkAddress', value: '', displayName: 'Locally Administered Address', displayValue: '' },
  ],
};

function infos(raw: unknown = REAL): AdapterInfo[] {
  const snap = parseNetSnapshot(raw);
  if (!snap) throw new Error('parse failed');
  return toAdapterInfos(snap, serviceMap(snap.services ?? []));
}

const byName = (list: AdapterInfo[], name: string) => list.find((a) => a.name === name) as AdapterInfo;

describe('parseNetSnapshot / toAdapterInfos (real capture)', () => {
  it('maps adapters, kinds, link speed, addresses and service names', () => {
    const list = infos();
    expect(list).toHaveLength(4);
    const eth = byName(list, 'Ethernet');
    expect(eth).toMatchObject({
      ifIndex: 4, guid: '{178af0a6-93f5-4ace-ace2-2ecdf78704f2}', status: 'Up', linkMbps: 1000, isWifi: false, isVirtual: false, mediaConnected: true, serviceName: 'e2fnexpress',
      mac: 'D8-43-AE-12-34-56', driverVersion: '2.1.5.7', rxBytes: 148776563, txErrors: 0,
    });
    expect(eth.addresses).toEqual(['fe80::374c:2a6a:2786:ee2e%4', '3fff:8071:7ca0:c980:7df5:ffbf:6014:ea67', '192.168.0.192']);
    expect(byName(list, 'WLAN')).toMatchObject({ isWifi: true, isVirtual: false, linkMbps: 206, serviceName: 'Netwtw14', addresses: ['3fff:8071:7ca0:c980:dc61:7ba6:f49b:7d89', '192.168.0.35'] });
    expect(byName(list, 'CloudflareWARP')).toMatchObject({ isVirtual: true, isWifi: false, serviceName: 'wintun', mac: null });
    expect(byName(list, 'Bluetooth-Netzwerkverbindung')).toMatchObject({ isVirtual: true, linkMbps: null, mediaConnected: false, rxBytes: null });
  });

  it('soft-disconnected WLAN (Up but MediaConnectState 2) and disabled adapters have no link speed', () => {
    const raw = structuredClone(REAL);
    raw.adapters[2].mediaConnectState = 2;
    raw.adapters[3].status = 'Disabled';
    raw.adapters[3].mediaConnectState = 0;
    const list = infos(raw);
    expect(byName(list, 'WLAN')).toMatchObject({ status: 'Up', mediaConnected: false, linkMbps: null });
    expect(isConnected(byName(list, 'WLAN'))).toBe(false);
    expect(byName(list, 'Ethernet')).toMatchObject({ status: 'Disabled', mediaConnected: null, linkMbps: null });
  });

  it('tolerates PowerShell single-element unwrapping and junk', () => {
    const single = { ...REAL, adapters: REAL.adapters[3], stats: REAL.stats[2], addresses: REAL.addresses[4], routes: REAL.routes[0], services: undefined, advanced: undefined };
    const snap = parseNetSnapshot(single);
    expect(snap?.adapters).toHaveLength(1);
    expect(snap?.routes).toHaveLength(1);
    expect(snap?.services).toBeNull();
    expect(snap?.advanced).toBeNull();
    expect(parseNetSnapshot('Fehler')).toBeNull();
    expect(parseNetSnapshot({ adapters: [{ name: 'x' }] })?.adapters).toEqual([]);
  });
});

describe('routes, $router6, primary adapter', () => {
  const snap = parseNetSnapshot(REAL);
  const routes = toActiveRoutes(snap?.routes ?? []);
  it('maps Find-NetRoute results', () => {
    expect(routes).toEqual([
      { family: 4, destination: '1.1.1.1', ifAlias: 'Ethernet', ifIndex: 4, sourceAddress: '192.168.0.192', nextHop: '192.168.0.1' },
      { family: 6, destination: '2606:4700:4700::1111', ifAlias: 'Ethernet', ifIndex: 4, sourceAddress: '3fff:8071:7ca0:c980:7df5:ffbf:6014:ea67', nextHop: 'fe80::de73:6ff:fe12:34df' },
    ]);
    expect(toActiveRoutes([{ remote: '1.1.1.1', found: false, sourceAddress: null, ifIndex: null, ifAlias: null, nextHop: null }])).toEqual([]);
  });
  it('derives $router6 with zone id', () => {
    expect(router6From(routes)).toBe('fe80::de73:6ff:fe12:34df%4');
    expect(router6From([{ ...routes[1], ifIndex: 6 }])).toBe('fe80::de73:6ff:fe12:34df%6');
    expect(router6From([{ ...routes[1], nextHop: '3fff:8071:7ca0:c980:de73:6ff:fe12:34df' }])).toBe('3fff:8071:7ca0:c980:de73:6ff:fe12:34df');
    expect(router6From([{ ...routes[1], nextHop: '::' }])).toBeNull();
    expect(router6From([routes[0]])).toBeNull();
  });
  it('picks the primary adapter: expected interface → IPv4 route → first connected wired', () => {
    const list = infos();
    expect(pickPrimary(list, routes, null)?.name).toBe('Ethernet');
    expect(pickPrimary(list, routes, 'wlan')?.name).toBe('WLAN');
    expect(pickPrimary(list, [], null)?.name).toBe('Ethernet');
    const wlanRoute: ActiveRoute[] = [{ ...routes[0], ifAlias: 'WLAN', ifIndex: 6 }];
    expect(pickPrimary(list, wlanRoute, null)?.name).toBe('WLAN');
  });
});

describe('nic metrics', () => {
  const eth = byName(infos(), 'Ethernet');
  const t0 = 1_791_565_466_000;
  it('computes rates and only non-zero error deltas', () => {
    const prev = { ...counterSample(eth, t0), rxBytes: eth.rxBytes! - 1_250_000, txBytes: eth.txBytes! - 125_000, rxErrors: 0 };
    const cur = { ...eth, rxErrors: 3 };
    const pts = nicMetrics(cur, prev, t0 + 10_000, 60_000, { full: true });
    expect(Object.fromEntries(pts.map((p) => [p.key, p.value]))).toEqual({
      'nic.up': 1, 'nic.link_mbps': 1000, 'nic.rx_mbps': 1, 'nic.tx_mbps': 0.1, 'nic.rx_errors': 3,
    });
  });
  it('is reset-safe and skips gaps / adapter switches', () => {
    const prev = counterSample(eth, t0);
    expect(nicMetrics({ ...eth, rxBytes: 10 }, prev, t0 + 10_000, 60_000, { full: false }).map((p) => p.key)).toEqual(['nic.tx_mbps']);
    expect(nicMetrics(eth, prev, t0 + 120_000, 60_000, { full: false })).toEqual([]);
    expect(nicMetrics(eth, { ...prev, name: 'WLAN' }, t0 + 10_000, 60_000, { full: false })).toEqual([]);
    expect(nicMetrics(eth, null, t0, 60_000, { full: true }).map((p) => p.key)).toEqual(['nic.up', 'nic.link_mbps']);
    expect(counterDelta(5, 3)).toBeNull();
    expect(counterDelta(null, 3)).toBeNull();
    expect(counterDelta(3, 5)).toBe(2);
  });
  it('reports a down link without speed', () => {
    const down = { ...eth, status: 'Disconnected', linkMbps: null, mediaConnected: false };
    expect(nicMetrics(down, null, t0, 60_000, { full: true })).toEqual([{ ts: t0, key: 'nic.up', value: 0 }]);
  });
});

describe('diffAdapters / diffRoutes', () => {
  const ts = 1_791_565_500_000;
  const base = infos();
  const eth = byName(base, 'Ethernet');
  const replace = (patch: Partial<AdapterInfo>) => base.map((a) => (a.name === 'Ethernet' ? { ...a, ...patch } : a));

  it('link down of the expected interface is a warning; disabled adapter is named', () => {
    const down = replace({ status: 'Disconnected', mediaConnected: false, linkMbps: null });
    const [e] = diffAdapters(base, down, { ts, expectedIf: 'Ethernet' });
    expect(e).toMatchObject({ type: 'adapter_change', severity: 'warn', title: 'Ethernet: Verbindung getrennt', source: 'adapter', details: { change: 'status', from: 'Up', to: 'Disconnected' } });
    const [d] = diffAdapters(base, replace({ status: 'Disabled', mediaConnected: null, linkMbps: null }), { ts, expectedIf: null });
    expect(d).toMatchObject({ severity: 'info', title: 'Ethernet: Adapter deaktiviert' });
    const [u] = diffAdapters(down, base, { ts, expectedIf: null });
    expect(u.title).toBe('Ethernet: Verbindung hergestellt (1 Gbit/s)');
  });

  it('speed drop below 1 Gbit/s is a warning; WLAN rate changes are ignored', () => {
    const [e] = diffAdapters(base, replace({ linkMbps: 100 }), { ts, expectedIf: null });
    expect(e).toMatchObject({ severity: 'warn', title: 'Ethernet: Link-Geschwindigkeit 1 Gbit/s → 100 Mbit/s', details: { change: 'speed', from: 1000, to: 100 } });
    const wlanRate = base.map((a) => (a.name === 'WLAN' ? { ...a, linkMbps: 866 } : a));
    expect(diffAdapters(base, wlanRate, { ts, expectedIf: null })).toEqual([]);
  });

  it('driver change (also across restarts), added/removed adapters, virtual adapters ignored', () => {
    const old = replace({ driverVersion: '1.1.4.43', serviceName: 'e2fexpress' });
    const [e] = diffAdapters(old, base, { ts, expectedIf: null, driverOnly: true });
    expect(e).toMatchObject({ title: 'Ethernet: Treiber geändert (1.1.4.43 → 2.1.5.7)', details: { change: 'driver', from: { serviceName: 'e2fexpress' }, to: { serviceName: 'e2fnexpress' } } });
    expect(diffAdapters(replace({ status: 'Disconnected', mediaConnected: false, linkMbps: null }), base, { ts, expectedIf: null, driverOnly: true })).toEqual([]);
    const without = base.filter((a) => a.name !== 'Ethernet');
    expect(diffAdapters(base, without, { ts, expectedIf: 'Ethernet' })[0]).toMatchObject({ severity: 'warn', title: 'Netzwerkadapter entfernt: Ethernet' });
    expect(diffAdapters(without, base, { ts, expectedIf: null })[0].title).toBe('Netzwerkadapter hinzugefügt: Ethernet');
    const warpDown = base.map((a) => (a.name === 'CloudflareWARP' ? { ...a, status: 'Disconnected' } : a));
    expect(diffAdapters(base, warpDown, { ts, expectedIf: null })).toEqual([]);
    expect(eth.isVirtual).toBe(false);
  });

  it('route switch Ethernet → WLAN (failover) and back', () => {
    const routes = toActiveRoutes(parseNetSnapshot(REAL)?.routes ?? []);
    const wlan: ActiveRoute[] = routes.map((r) => ({ ...r, ifAlias: 'WLAN', ifIndex: 6, sourceAddress: r.family === 4 ? '192.168.0.35' : r.sourceAddress }));
    const events = diffRoutes(routes, wlan, base, { ts, expectedIf: 'Ethernet' });
    expect(events.map((e) => e.title)).toEqual([
      'Internetverkehr (IPv4) läuft jetzt über WLAN statt Ethernet',
      'Internetverkehr (IPv6) läuft jetzt über WLAN statt Ethernet',
    ]);
    expect(events[0]).toMatchObject({ type: 'route_switch', severity: 'warn', source: 'route', details: { family: 4, from: 'Ethernet', to: 'WLAN', toWifi: true, fromWifi: false, sourceAddress: '192.168.0.35' } });
    const back = diffRoutes(wlan, routes, base, { ts, expectedIf: null });
    expect(back[0]).toMatchObject({ severity: 'info', details: { to: 'Ethernet', toWifi: false } });
    expect(diffRoutes(routes, [routes[1]], base, { ts, expectedIf: null })[0]).toMatchObject({ severity: 'warn', title: 'Keine IPv4-Internetroute mehr (zuvor Ethernet)' });
    expect(diffRoutes(routes, routes, base, { ts, expectedIf: null })).toEqual([]);
  });
});

describe('advanced properties, signature, script', () => {
  it('keeps relevant keywords of the real I225-V property dump', () => {
    const fixture = JSON.parse(fs.readFileSync(new URL('../../fixtures/windows/pscol_advancedProps_Ethernet_all.json', import.meta.url), 'utf8')) as RawAdvanced[];
    const list = relevantAdvanced(fixture);
    const byKey = Object.fromEntries(list.map((x) => [x.keyword, x]));
    expect(byKey['*SelectiveSuspend']).toMatchObject({ registryValue: '1' });
    expect(byKey['*SpeedDuplex']).toMatchObject({ registryValue: '0' });
    expect(byKey.LogLinkStateEvent).toMatchObject({ registryValue: '51' });
    expect(byKey['*FlowControl']).toMatchObject({ name: 'Flow Control', value: 'Rx & Tx Enabled', registryValue: '3' });
    expect(byKey.DriverDesc).toBeUndefined();
    expect(byKey['*EEE']).toBeUndefined(); // not exposed by this driver
    const wlan = relevantAdvanced(REAL.advanced);
    expect(wlan.map((x) => x.keyword)).toEqual(['MIMOPowerSaveMode', '*PacketCoalescing', 'RoamAggressiveness']);
  });
  it('signature ignores byte counters and WLAN rates but sees status/route changes', () => {
    const list = infos();
    const routes = toActiveRoutes(parseNetSnapshot(REAL)?.routes ?? []);
    const sig = snapshotSignature({ adapters: list, routes, advanced: [], primary: 'Ethernet' });
    const counters = list.map((a) => ({ ...a, rxBytes: (a.rxBytes ?? 0) + 1000, linkMbps: a.isWifi ? 866 : a.linkMbps }));
    expect(snapshotSignature({ adapters: counters, routes, advanced: [], primary: 'Ethernet' })).toBe(sig);
    const down = list.map((a) => (a.name === 'Ethernet' ? { ...a, status: 'Disconnected' } : a));
    expect(snapshotSignature({ adapters: down, routes, advanced: [], primary: 'Ethernet' })).not.toBe(sig);
    expect(snapshotSignature({ adapters: list, routes: routes.slice(1), advanced: [], primary: 'Ethernet' })).not.toBe(sig);
  });
  it('builds the PowerShell call with quoted adapter names', () => {
    expect(snapshotScript({ routes: true, services: false, advancedFor: null })).toBe('Get-NdNetSnapshot -Routes');
    expect(snapshotScript({ routes: false, services: true, advancedFor: "Jan's LAN" })).toBe("Get-NdNetSnapshot -Services -AdvancedFor 'Jan''s LAN'");
  });
});

describe('Windows net snapshot source', () => {
  it('requires the PowerShell worker and parses Get-NdNetSnapshot', async () => {
    const off = { available: false, json: () => Promise.reject(new Error('x')), text: () => Promise.reject(new Error('x')), dispose: () => undefined };
    await expect(powerShellNetSnapshotSource(off).fetch({ routes: true, services: true, advancedFor: null })).rejects.toThrow('PowerShell nicht verfügbar');
    const scripts: string[] = [];
    const on = { ...off, available: true, json: <T>(script: string) => (scripts.push(script), Promise.resolve(REAL as T)) };
    const raw = await powerShellNetSnapshotSource(on).fetch({ routes: true, services: false, advancedFor: 'WLAN' });
    expect(scripts).toEqual(["Get-NdNetSnapshot -Routes -AdvancedFor 'WLAN'"]);
    expect(raw.adapters).toHaveLength(4);
    expect(raw.adapters.every((a) => a.device === undefined)).toBe(true);
    const bad = { ...on, json: <T>() => Promise.resolve(42 as T) };
    await expect(powerShellNetSnapshotSource(bad).fetch({ routes: false, services: false, advancedFor: null })).rejects.toThrow('Unerwartete Antwort von Get-NdNetSnapshot');
  });
});
