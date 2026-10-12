import fs from 'node:fs';
import type os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AdapterInfo } from '../../src/lib/shared/types';
import type { EgressTick } from '../core/types';
import { EGRESS_V4_TARGET, EGRESS_V6_TARGET, EgressChecker, checkEgress, interfaceForAddress, probeSourceAddress } from './egress';
import { flushPromises } from './test-helpers';

const FIX = path.join(process.cwd(), 'fixtures', 'windows');

/** Adapters (name + addresses) built from the captured Get-NetIPAddress output of this PC. */
function fixtureAdapters(): Pick<AdapterInfo, 'name' | 'addresses'>[] {
  const rows = JSON.parse(fs.readFileSync(path.join(FIX, 'pscol_ipAddresses.json'), 'utf8')) as { alias: string; ip: string }[];
  const byName = new Map<string, string[]>();
  for (const r of rows) byName.set(r.alias, [...(byName.get(r.alias) ?? []), r.ip]);
  return [...byName].map(([name, addresses]) => ({ name, addresses }));
}

function adapter(name: string, addresses: string[]): AdapterInfo {
  return {
    name, description: name, ifIndex: 1, status: 'Up', linkMbps: 1000, mediaType: null, mac: null, driverVersion: null,
    driverDate: null, serviceName: null, isWifi: name === 'WLAN', isVirtual: false, mediaConnected: true, addresses,
    rxBytes: null, txBytes: null, rxErrors: null, rxDiscards: null, txErrors: null, txDiscards: null,
  };
}

const ROUTE_V4 = JSON.parse(fs.readFileSync(path.join(FIX, 'pscol_route_v4_1.1.1.1.json'), 'utf8')) as { sourceAddress: string; interfaceAlias: string }[];
const ROUTE_V6 = JSON.parse(fs.readFileSync(path.join(FIX, 'pscol_route_v6_cloudflare.json'), 'utf8')) as { sourceAddress: string; interfaceAlias: string }[];

const live = (entries: Record<string, string[]>): NodeJS.Dict<os.NetworkInterfaceInfo[]> =>
  Object.fromEntries(
    Object.entries(entries).map(([name, addrs]) => [
      name,
      addrs.map((address) => ({
        address, netmask: '', family: address.includes(':') ? 'IPv6' : 'IPv4', mac: '00:00:00:00:00:00', internal: false, cidr: null,
      }) as os.NetworkInterfaceInfo),
    ]),
  );

describe('interfaceForAddress', () => {
  const adapters = fixtureAdapters();

  it('maps the source addresses Windows chose (Find-NetRoute fixtures) to the interface alias', () => {
    expect(interfaceForAddress(ROUTE_V4[0].sourceAddress, adapters, null)).toBe(ROUTE_V4[0].interfaceAlias);
    expect(interfaceForAddress(ROUTE_V6[0].sourceAddress, adapters, null)).toBe(ROUTE_V6[0].interfaceAlias);
  });

  it('compares IPv6 addresses normalized (case, zero compression, zone ids)', () => {
    expect(interfaceForAddress('3fff:8071:7ca0:c980:D8DE:C10F:0ADB:AC10', adapters, null)).toBe('Ethernet');
    expect(interfaceForAddress('fe80::374c:2a6a:2786:ee2e', adapters, null)).toBe('Ethernet');
    expect(interfaceForAddress('fe80::374c:2a6a:2786:ee2e%4', adapters, null)).toBe('Ethernet');
  });

  it('falls back to the live interface list, then null', () => {
    expect(interfaceForAddress('192.168.0.35', adapters, live({ WLAN: ['192.168.0.35'] }))).toBe('WLAN');
    expect(interfaceForAddress('10.9.9.9', adapters, live({ WLAN: ['192.168.0.35'] }))).toBeNull();
    expect(interfaceForAddress(null, adapters, null)).toBeNull();
    expect(interfaceForAddress('192.168.0.192', null, null)).toBeNull();
  });
});

describe('checkEgress', () => {
  it('detects the WLAN failover: v4 address only known to the live list, v6 via the snapshot', async () => {
    let liveCalls = 0;
    const tick = await checkEgress(1000, [adapter('Ethernet', ['192.168.0.192', '3fff:8071:7ca0:c980:d8de:c10f:adb:ac10'])], {
      probe: async (family, host) => {
        expect(host).toBe(family === 4 ? EGRESS_V4_TARGET : EGRESS_V6_TARGET);
        return family === 4 ? '192.168.0.35' : '3fff:8071:7ca0:c980:d8de:c10f:adb:ac10';
      },
      liveInterfaces: () => {
        liveCalls++;
        return live({ WLAN: ['192.168.0.35'] });
      },
    });
    expect(tick).toEqual({
      ts: 1000,
      v4Address: '192.168.0.35',
      v6Address: '3fff:8071:7ca0:c980:d8de:c10f:adb:ac10',
      v4If: 'WLAN',
      v6If: 'Ethernet',
    });
    expect(liveCalls).toBe(1);
  });

  it('does not query the live list when the snapshot knows both addresses; null without route', async () => {
    const liveInterfaces = vi.fn(() => live({}));
    const tick = await checkEgress(2000, [adapter('Ethernet', ['192.168.0.192'])], {
      probe: async (family) => (family === 4 ? '192.168.0.192' : null),
      liveInterfaces,
    });
    expect(tick).toEqual({ ts: 2000, v4Address: '192.168.0.192', v6Address: null, v4If: 'Ethernet', v6If: null });
    expect(liveInterfaces).not.toHaveBeenCalled();
  });

  it('works without any adapters snapshot (live list only)', async () => {
    const tick = await checkEgress(3000, null, {
      probe: async (family) => (family === 4 ? '192.168.0.192' : 'fe80::1'),
      liveInterfaces: () => live({ Ethernet: ['192.168.0.192'] }),
    });
    expect(tick).toMatchObject({ v4If: 'Ethernet', v6Address: 'fe80::1', v6If: null });
  });
});

describe('probeSourceAddress (real sockets, no packet is sent)', () => {
  it('returns the loopback source for loopback destinations', async () => {
    expect(await probeSourceAddress(4, '127.0.0.1')).toBe('127.0.0.1');
    expect(await probeSourceAddress(6, '::1')).toBe('::1');
  });

  it('returns null for an unusable destination', async () => {
    expect(await probeSourceAddress(4, '::1')).toBeNull();
    expect(await probeSourceAddress(4, '0.0.0.0', 0)).toBeNull();
  });
});

describe('EgressChecker', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('checks once per whole second and stops cleanly', async () => {
    vi.useFakeTimers({ now: 1_791_550_560_250 });
    const ticks: EgressTick[] = [];
    const checker = new EgressChecker(
      { onTick: (t) => ticks.push(t), adapters: () => [adapter('Ethernet', ['192.168.0.192'])] },
      { probe: async (family) => (family === 4 ? '192.168.0.192' : null), liveInterfaces: () => live({}) },
    );
    checker.start();
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(1000);
      await flushPromises();
    }
    expect(ticks.map((t) => t.ts)).toEqual([1_791_550_561_000, 1_791_550_562_000, 1_791_550_563_000]);
    expect(ticks.every((t) => t.v4If === 'Ethernet' && t.v6If === null)).toBe(true);
    checker.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(ticks).toHaveLength(3);
  });
});
