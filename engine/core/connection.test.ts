import { describe, expect, it } from 'vitest';
import type { AdapterInfo, AdapterSnapshot, ClientState, WlanInfo } from '../../src/lib/shared/types';
import {
  buildConnectionContext,
  interfaceForAddress,
  localEgressAddress,
  primaryRouteInterface,
  resolveConnectionContext,
} from './connection';

const T0 = 1_791_550_214_941;

function adapter(name: string, extra: Partial<AdapterInfo>): AdapterInfo {
  return {
    name, description: name, ifIndex: 1, status: 'Up', linkMbps: 1000, mediaType: '802.3', mac: null, driverVersion: null,
    driverDate: null, serviceName: null, isWifi: false, isVirtual: false, mediaConnected: null, addresses: [],
    rxBytes: null, txBytes: null, rxErrors: null, rxDiscards: null, txErrors: null, txDiscards: null, ...extra,
  };
}

// values from fixtures/windows/pscol_adapters.json, pscol_ipAddresses.json, pscol_route_v4_1.1.1.1.json
const snapshot: AdapterSnapshot = {
  ts: T0,
  adapters: [
    adapter('CloudflareWARP', { ifIndex: 35, linkMbps: 100_000, isVirtual: true, addresses: ['100.96.0.7'] }),
    adapter('Ethernet', { ifIndex: 4, description: 'Intel(R) Ethernet Controller (3) I225-V', serviceName: 'e2fexpress', addresses: ['192.168.0.192', 'fe80::374c:2a6a:2786:ee2e%4', '3fff:8071:7ca0:c980:b219:6c3e:eadc:4c15'] }),
    adapter('WLAN', { ifIndex: 6, linkMbps: 961, isWifi: true, status: 'Disconnected', mediaConnected: false, addresses: [] }),
  ],
  routes: [
    { family: 4, destination: '1.1.1.1', ifAlias: 'Ethernet', ifIndex: 4, sourceAddress: '192.168.0.192', nextHop: '192.168.0.1' },
    { family: 6, destination: '2606:4700:4700::1111', ifAlias: 'Ethernet', ifIndex: 4, sourceAddress: '3fff:8071:7ca0:c980:b219:6c3e:eadc:4c15', nextHop: 'fe80::de73:6ff:fe12:34df' },
  ],
  advanced: [],
};

const wlanConnected: WlanInfo = {
  ts: T0, present: true, connected: true, ssid: 'Vodafone-43FE', bssid: null, radioType: '802.11ax', band: '5 GHz',
  channel: 36, signalPct: 88, rssiDbm: -52, rxMbps: 961, txMbps: 961, raw: {},
};

describe('connection context', () => {
  it('finds the primary IPv4 route interface', () => {
    expect(primaryRouteInterface(snapshot)).toBe('Ethernet');
    expect(primaryRouteInterface(snapshot, 6)).toBe('Ethernet');
    expect(primaryRouteInterface({ ...snapshot, routes: [] })).toBeNull();
    expect(primaryRouteInterface(null)).toBeNull();
  });

  it('maps a local address to its interface (snapshot first, then OS list)', () => {
    expect(interfaceForAddress('192.168.0.192', snapshot, {})).toBe('Ethernet');
    expect(interfaceForAddress('3fff:8071:7ca0:c980:B219:6C3E:EADC:4C15', snapshot, {})).toBe('Ethernet');
    const os = { WLAN: [{ address: '192.168.0.35', family: 'IPv4', internal: false, cidr: null, mac: '', netmask: '' }] };
    expect(interfaceForAddress('192.168.0.35', snapshot, os as never)).toBe('WLAN');
    expect(interfaceForAddress('10.9.9.9', snapshot, {})).toBeNull();
    expect(interfaceForAddress(null, snapshot, {})).toBeNull();
  });

  it('describes a wired session without WLAN details', () => {
    const c = buildConnectionContext({ expectedIf: 'Ethernet', expectedIfSource: 'adapters', adapters: snapshot, wlan: wlanConnected, nic: null });
    expect(c).toEqual({
      expectedIf: 'Ethernet', expectedIfSource: 'adapters', primaryAdapter: 'Ethernet', isWifi: false, linkMbps: 1000,
      ssid: null, band: null, channel: null, signalPct: null,
    });
  });

  it('adds WLAN details for a WLAN session and falls back to NIC ticks / name heuristics', () => {
    const c = buildConnectionContext({ expectedIf: 'WLAN', expectedIfSource: 'egress', adapters: null, wlan: wlanConnected, nic: null });
    expect(c).toMatchObject({ isWifi: true, linkMbps: null, ssid: 'Vodafone-43FE', band: '5 GHz', channel: 36, signalPct: 88 });
    const tick = { ts: T0, name: 'WLAN', up: true, mbps: 573, rxBytes: 0, txBytes: 0, rxErrors: 0, rxDiscards: 0, isWifi: true };
    expect(buildConnectionContext({ expectedIf: 'WLAN', expectedIfSource: 'client', adapters: null, wlan: null, nic: tick }).linkMbps).toBe(573);
    expect(buildConnectionContext({ expectedIf: null, expectedIfSource: null, adapters: null, wlan: null, nic: null })).toMatchObject({ expectedIf: null, isWifi: null });
  });

  it('resolves the expected interface: stored → client → egress → adapters', async () => {
    const client = { ts: T0, egressV4If: 'WLAN' } as ClientState;
    const base = {
      now: () => T0 + 1000,
      latestAdapters: () => snapshot,
      latestWlan: () => null,
      nic: () => null,
    };
    const egress = async () => 'Ethernet';
    expect((await resolveConnectionContext({ ...base, clientState: () => client, egressInterface: egress }, 'LAN 2')).expectedIf).toBe('LAN 2');
    expect((await resolveConnectionContext({ ...base, clientState: () => client, egressInterface: egress })).expectedIfSource).toBe('client');
    const viaEgress = await resolveConnectionContext({ ...base, clientState: () => null, egressInterface: egress });
    expect(viaEgress).toMatchObject({ expectedIf: 'Ethernet', expectedIfSource: 'egress', linkMbps: 1000 });
    const viaRoute = await resolveConnectionContext({ ...base, clientState: () => ({ ...client, ts: T0 - 60_000 }), egressInterface: async () => null });
    expect(viaRoute).toMatchObject({ expectedIf: 'Ethernet', expectedIfSource: 'adapters' });
  });

  it('determines the live egress address without sending packets', async () => {
    const addr = await localEgressAddress(4);
    // null only when the PC has no IPv4 route at all
    if (addr !== null) expect(addr).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
  });
});
