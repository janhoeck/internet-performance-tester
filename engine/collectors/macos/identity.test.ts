import { describe, expect, it } from 'vitest';
import { buildMacInterfaces } from '../../../src/lib/shared/parsers/macos/interfaces';
import { parseIfconfig } from '../../../src/lib/shared/parsers/macos/ifconfig';
import { parseNetstatInterfaces } from '../../../src/lib/shared/parsers/macos/netstat';
import { parseHardwarePorts } from '../../../src/lib/shared/parsers/macos/networksetup';
import type { NetEvent } from '../../../src/lib/shared/types';
import { fakeProbeContext } from '../../probes/test-helpers';
import { createIdentityModule, macIdentitySource, parseIdentity } from '../identity';
import { FakeToolRunner, macFixture } from './fake-runner';
import { buildMacIdentity, createMacProcessListSource, readMacIdentity } from './identity';
import { MacInterfaceCatalog } from './interfaces';
import { MAC_TOOLS } from './tools';

// isGlobalV6 excludes the documentation prefix 2001:db8::/32 of the synthetic fixture
const IFCONFIG_GLOBAL = macFixture('ifconfig_a.txt').replaceAll('2001:db8:aa00:1234:', '2a02:8109:aa00:1234:');

const LIST = buildMacInterfaces(
  parseHardwarePorts(macFixture('networksetup_listallhardwareports.txt')),
  parseIfconfig(IFCONFIG_GLOBAL),
  parseNetstatInterfaces(macFixture('netstat_ibn.txt')),
);

const OUTPUTS = {
  route: macFixture('route_get_gateway_onlink.txt'),
  arp: macFixture('arp_n_gateway.txt'),
  packet: macFixture('ipconfig_getpacket_en7.txt'),
  scutil: macFixture('scutil_dns.txt'),
};

function runner(): FakeToolRunner {
  return new FakeToolRunner({
    [`${MAC_TOOLS.route} -n get 192.168.0.1`]: { stdout: OUTPUTS.route },
    [`${MAC_TOOLS.arp} -n 192.168.0.1`]: { stdout: OUTPUTS.arp },
    [`${MAC_TOOLS.ipconfig} getpacket en7`]: { stdout: OUTPUTS.packet },
    [`${MAC_TOOLS.scutil} --dns`]: { stdout: OUTPUTS.scutil },
    [`${MAC_TOOLS.ifconfig} -a`]: { stdout: macFixture('ifconfig_a.txt') },
    [`${MAC_TOOLS.networksetup} -listallhardwareports`]: { stdout: macFixture('networksetup_listallhardwareports.txt') },
    [`${MAC_TOOLS.ps} -ww -A -o comm=`]: { stdout: macFixture('ps_comm.txt') },
  });
}

describe('buildMacIdentity', () => {
  it('produces a Get-NdIdentity record that parseIdentity understands', () => {
    const rec = buildMacIdentity(OUTPUTS, LIST, '192.168.0.1', 42);
    expect(rec).toMatchObject({ found: true, ifAlias: 'Ethernet', ifIndex: 16, dhcpServer: '192.168.0.1', dns: ['192.168.0.1', '2001:db8:aa00:1234::1'] });
    expect(parseIdentity(rec, 0)).toEqual({
      ts: 42,
      ifAlias: 'Ethernet',
      ifIndex: 16,
      gatewayMac: 'DC-73-06-12-34-DF',
      dhcpServer: '192.168.0.1',
      dns: ['192.168.0.1', '2001:db8:aa00:1234::1'],
      v6Prefix: '2a02:8109:aa00:1234::/64',
    });
  });

  it('falls back to the route gateway MAC and to the DHCP DNS servers', () => {
    const rec = buildMacIdentity({ ...OUTPUTS, arp: macFixture('arp_n_incomplete.txt'), scutil: '' }, LIST, '192.168.0.1', 1);
    const s = parseIdentity(rec, 0);
    expect(s?.gatewayMac).toBe('DC-73-06-12-34-DF'); // from the LLINFO route
    expect(s?.dns).toEqual(['192.168.0.1', '192.0.2.53']);
  });

  it('no MAC at all, no DHCP lease', () => {
    const route = macFixture('route_get_v4.txt').replace('route to: 1.1.1.1', 'route to: 192.168.0.1');
    const s = parseIdentity(buildMacIdentity({ route, arp: macFixture('arp_n_noentry.txt'), packet: '', scutil: '' }, LIST, '192.168.0.1', 1), 0);
    expect(s).toMatchObject({ gatewayMac: null, dhcpServer: null, dns: [] });
  });

  it('no route towards the router', () => {
    expect(buildMacIdentity({ ...OUTPUTS, route: macFixture('route_get_noroute.txt') }, LIST, '192.168.0.1', 7)).toEqual({ t: 7, found: false });
    expect(parseIdentity({ t: 7, found: false }, 0)).toBeNull();
  });
});

describe('readMacIdentity', () => {
  it('runs route first, then the optional tools in parallel', async () => {
    const r = runner();
    const rec = await readMacIdentity(r, new MacInterfaceCatalog(r), '192.168.0.1', () => 5);
    expect(rec).toMatchObject({ found: true, ifAlias: 'Ethernet' });
    expect(r.commands()[0]).toBe(`${MAC_TOOLS.route} -n get 192.168.0.1`);
    expect(r.commands()).toContain(`${MAC_TOOLS.ipconfig} getpacket en7`);
    expect(r.calls.find((c) => c.file === MAC_TOOLS.route)?.opts.env?.LC_ALL).toBe('C');
  });

  it('no route → found false without further tools; invalid router address is not spawned', async () => {
    const r = runner();
    r.set(`${MAC_TOOLS.route} -n get 192.168.0.1`, { stderr: macFixture('route_get_noroute.txt'), code: 1 });
    expect(await readMacIdentity(r, new MacInterfaceCatalog(r), '192.168.0.1', () => 5)).toEqual({ t: 5, found: false });
    expect(r.calls).toHaveLength(1);
    const r2 = runner();
    expect(await readMacIdentity(r2, new MacInterfaceCatalog(r2), 'easy.box', () => 5)).toEqual({ t: 5, found: false });
    expect(r2.calls).toHaveLength(0);
  });

  it('missing optional tools only leave fields empty', async () => {
    const r = new FakeToolRunner({
      [`${MAC_TOOLS.route} -n get 192.168.0.1`]: { stdout: OUTPUTS.route },
      [`${MAC_TOOLS.ifconfig} -a`]: { stdout: macFixture('ifconfig_a.txt') },
      [`${MAC_TOOLS.networksetup} -listallhardwareports`]: { stdout: macFixture('networksetup_listallhardwareports.txt') },
    });
    const s = await macIdentitySource(r, new MacInterfaceCatalog(r)).fetch('192.168.0.1');
    expect(s).toMatchObject({ ifAlias: 'Ethernet', gatewayMac: 'DC-73-06-12-34-DF', dhcpServer: null, dns: [] });
  });
});

describe('macOS process list + identity module', () => {
  it('lists executable basenames', async () => {
    expect(await createMacProcessListSource(runner()).list()).toContain('World of Warcraft');
  });

  it('detects a game by its macOS process name and stores identity per interface', async () => {
    const fake = fakeProbeContext();
    const settings = new Map<string, string | null>();
    const events: NetEvent[] = [];
    const ctx = {
      ...fake.ctx,
      db: { ...fake.ctx.db, getSetting: (k: string) => settings.get(k) ?? null, setSetting: (k: string, v: string | null) => void settings.set(k, v) },
      recordEvent: (e: NetEvent) => {
        events.push(e);
        return events.length;
      },
    };
    const r = runner();
    const mod = createIdentityModule({
      createIdentitySource: () => macIdentitySource(r, new MacInterfaceCatalog(r)),
      createProcessSource: () => createMacProcessListSource(r),
      os: 'macos',
      autoStart: false,
    });
    mod.init?.(ctx);
    const res = (await mod.runNow?.()) as { identity: Record<string, unknown>; gaming: string | null };
    expect(mod.state().lastError).toBeNull();
    expect(res.gaming).toBe('leagueoflegends');
    expect(events.map((e) => e.title)).toEqual(['Spiel läuft: leagueoflegends']);
    expect(Object.keys(res.identity)).toEqual(['Ethernet']);
    expect(fake.metrics.find((m) => m.key === 'pc.gaming')?.value).toBe(1);
    mod.dispose?.();
  });
});
