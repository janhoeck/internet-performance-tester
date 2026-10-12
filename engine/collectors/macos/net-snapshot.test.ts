import { afterEach, describe, expect, it } from 'vitest';
import type { AdapterInfo, NetEvent } from '../../../src/lib/shared/types';
import { fakeProbeContext } from '../../probes/test-helpers';
import { setPlatformOverride } from '../../platform';
import {
  type AdapterInfoExt,
  type AdapterSnapshotExt,
  createAdapterModule,
  diffAdapters,
  pickPrimary,
  router6From,
  serviceMap,
  snapshotSignature,
  toActiveRoutes,
  toAdapterInfos,
} from '../adapter';
import { FakeToolRunner, macFixture } from './fake-runner';
import { MAC_TOOLS } from './tools';
import { createMacNetSnapshotSource } from './net-snapshot';

const IFCONFIG = `${MAC_TOOLS.ifconfig} -a`;
const NETSTAT = `${MAC_TOOLS.netstat} -ibn`;
const PORTS = `${MAC_TOOLS.networksetup} -listallhardwareports`;
const ROUTE4 = `${MAC_TOOLS.route} -n get 1.1.1.1`;
const ROUTE6 = `${MAC_TOOLS.route} -n get -inet6 2606:4700:4700::1111`;

function runner(): FakeToolRunner {
  return new FakeToolRunner({
    [IFCONFIG]: { stdout: macFixture('ifconfig_a.txt') },
    [NETSTAT]: { stdout: macFixture('netstat_ibn.txt') },
    [PORTS]: { stdout: macFixture('networksetup_listallhardwareports.txt') },
    [ROUTE4]: { stdout: macFixture('route_get_v4.txt') },
    [ROUTE6]: { stdout: macFixture('route_get_v6.txt') },
  });
}

const sourceAddress = (family: 4 | 6) => Promise.resolve(family === 4 ? '192.168.0.43' : '2001:db8:aa00:1234:14a3:9d1e:3b1a:7f02');

async function snapshot(r = runner(), routes = true) {
  const src = createMacNetSnapshotSource({ runner: r, sourceAddress, now: () => 1_000 });
  const raw = await src.fetch({ routes, services: true, advancedFor: 'Ethernet' });
  return { raw, adapters: toAdapterInfos(raw, serviceMap(raw.services ?? [])) as AdapterInfoExt[] };
}

const byName = (list: AdapterInfo[], name: string) => list.find((a) => a.name === name) as AdapterInfoExt;

describe('macOS net snapshot source', () => {
  it('maps the interface catalog to adapter infos', async () => {
    const { raw, adapters } = await snapshot();
    expect(raw.t).toBe(1_000);
    expect(adapters.map((a) => a.name)).toEqual(['Wi-Fi', 'Thunderbolt 1', 'Thunderbolt Bridge', 'Ethernet', 'utun4']);
    expect(byName(adapters, 'Ethernet')).toMatchObject({
      device: 'en7',
      description: 'en7 · Ethernet',
      ifIndex: 16,
      guid: null,
      status: 'Up',
      linkMbps: 1000,
      mediaType: '802.3',
      mac: '00:e0:4c:aa:bb:03',
      isWifi: false,
      isVirtual: false,
      mediaConnected: true,
      driverVersion: null,
      serviceName: null,
      rxBytes: 61234567890,
      txBytes: 2345678901,
      rxErrors: 12,
      rxDiscards: null,
      txErrors: 0,
      txDiscards: null,
    });
    expect(byName(adapters, 'Ethernet').addresses).toEqual(['192.168.0.43', 'fe80::14a3:9d1e:3b1a:7f02', '2001:db8:aa00:1234:14a3:9d1e:3b1a:7f02']);
    expect(byName(adapters, 'Wi-Fi')).toMatchObject({ device: 'en0', isWifi: true, status: 'Up', linkMbps: null, mediaConnected: true });
    expect(byName(adapters, 'Thunderbolt Bridge')).toMatchObject({ isVirtual: true, status: 'Disconnected', mediaConnected: false });
    expect(byName(adapters, 'utun4')).toMatchObject({ description: 'utun4', isVirtual: true, status: 'Up', mediaConnected: null, mediaType: null });
    expect(raw.services).toBeNull();
    expect(raw.advanced).toEqual([]);
  });

  it('routes use shown names and keep the zone id of the IPv6 next hop', async () => {
    const { raw, adapters } = await snapshot();
    const routes = toActiveRoutes(raw.routes ?? []);
    expect(routes).toEqual([
      { family: 4, destination: '1.1.1.1', ifAlias: 'Ethernet', ifIndex: 16, sourceAddress: '192.168.0.43', nextHop: '192.168.0.1' },
      { family: 6, destination: '2606:4700:4700::1111', ifAlias: 'Ethernet', ifIndex: 16, sourceAddress: '2001:db8:aa00:1234:14a3:9d1e:3b1a:7f02', nextHop: 'fe80::de73:6ff:fe12:34df%en7' },
    ]);
    expect(router6From(routes)).toBe('fe80::de73:6ff:fe12:34df%en7');
    expect(pickPrimary(adapters, routes, null)?.name).toBe('Ethernet');
  });

  it('adds the BSD zone to a link-local next hop printed without one', async () => {
    const r = runner();
    r.set(ROUTE6, { stdout: macFixture('route_get_v6.txt').replace('%en7', '') });
    const { raw } = await snapshot(r);
    expect(raw.routes?.[1].nextHop).toBe('fe80::de73:6ff:fe12:34df%en7');
  });

  it('missing routes and skipped route queries', async () => {
    const r = runner();
    r.set(ROUTE4, { stdout: '', stderr: macFixture('route_get_noroute.txt'), code: 1 });
    r.set(ROUTE6, { error: Object.assign(new Error('timeout'), { code: 'X' }) });
    const { raw } = await snapshot(r);
    expect(raw.routes).toEqual([
      { remote: '1.1.1.1', found: false, sourceAddress: null, ifIndex: null, ifAlias: null, nextHop: null },
      { remote: '2606:4700:4700::1111', found: false, sourceAddress: null, ifIndex: null, ifAlias: null, nextHop: null },
    ]);
    const plain = runner();
    const { raw: noRoutes } = await snapshot(plain, false);
    expect(noRoutes.routes).toBeNull();
    expect(plain.commands().some((c) => c.startsWith(MAC_TOOLS.route))).toBe(false);
  });

  it('a missing ifconfig fails the poll with a German error', async () => {
    const r = runner();
    r.set(IFCONFIG, { error: Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }), code: null });
    const src = createMacNetSnapshotSource({ runner: r, sourceAddress });
    await expect(src.fetch({ routes: false, services: false, advancedFor: null })).rejects.toThrow('ifconfig: nicht gefunden');
  });

  it('unplugged cable → adapter_change event, signature changes', async () => {
    const { adapters: before } = await snapshot();
    const r = runner();
    const unplugged = macFixture('ifconfig_a.txt').replace(
      '\tmedia: autoselect (1000baseT <full-duplex>)\n\tstatus: active',
      '\tmedia: autoselect (none)\n\tstatus: inactive',
    );
    r.set(IFCONFIG, { stdout: unplugged });
    const { adapters: after } = await snapshot(r);
    expect(byName(after, 'Ethernet')).toMatchObject({ status: 'Disconnected', linkMbps: null, mediaConnected: false });
    const events = diffAdapters(before, after, { ts: 5, expectedIf: 'Ethernet' });
    expect(events.map((e) => [e.title, e.severity])).toEqual([['Ethernet: Verbindung getrennt', 'warn']]);
    const sig = (list: AdapterInfo[]) => snapshotSignature({ adapters: list, routes: [], advanced: [], primary: 'Ethernet' });
    expect(sig(before)).not.toBe(sig(after));
  });

  it('dispose kills the tools', () => {
    const r = runner();
    createMacNetSnapshotSource({ runner: r }).dispose?.();
    expect(r.killed).toBe(1);
  });
});

describe('adapter module with the macOS source', () => {
  afterEach(() => setPlatformOverride(null));

  it('polls, emits nic metrics, events, snapshot and $router6', async () => {
    setPlatformOverride('macos');
    const fake = fakeProbeContext();
    const events: NetEvent[] = [];
    const snapshots: AdapterSnapshotExt[] = [];
    const ctx = {
      ...fake.ctx,
      recordEvent: (e: NetEvent) => {
        events.push(e);
        return events.length;
      },
      recordSnapshot: <T>(_kind: string, data: T) => {
        snapshots.push(data as AdapterSnapshotExt);
      },
    };
    const r = runner();
    const mod = createAdapterModule({ createSource: () => createMacNetSnapshotSource({ runner: r, sourceAddress }), autoStart: false });
    mod.init?.(ctx);
    await mod.runNow?.();
    expect(mod.state().lastError).toBeNull();
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].primary).toBe('Ethernet');
    expect(snapshots[0].adapters.find((a) => a.name === 'Ethernet')).toMatchObject({ device: 'en7' });
    expect(fake.metrics.filter((m) => m.key === 'nic.link_mbps')).toEqual([{ ts: expect.any(Number), key: 'nic.link_mbps', value: 1000 }]);
    expect(ctx.hosts.get().router6).toBe('fe80::de73:6ff:fe12:34df%en7');
    expect(events).toEqual([]);
    mod.dispose?.();
    expect(r.killed).toBe(1);
  });
});
