import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ifconfigAddresses, ifconfigLinkUp, mediaDuplex, mediaSpeedMbps, parseIfconfig } from './ifconfig';
import { padMac, parseNetstatInterfaces, parseNetstatTcp } from './netstat';
import { isBridgePort, isWifiPort, parseHardwarePorts } from './networksetup';
import { parseRouteGet } from './route';
import { buildMacInterfaces, deviceOf, displayNameOf } from './interfaces';

const readText = (name: string) => fs.readFileSync(new URL(`../../../../../fixtures/macos/${name}`, import.meta.url), 'utf8');

describe('mediaSpeedMbps / mediaDuplex', () => {
  it.each([
    ['autoselect (1000baseT <full-duplex>)', 1000],
    ['autoselect (100baseTX <full-duplex,flow-control>)', 100],
    ['autoselect (10baseT/UTP <half-duplex>)', 10],
    ['autoselect (2500Base-T <full-duplex>)', 2500],
    ['autoselect (5GBase-T <full-duplex>)', 5000],
    ['autoselect (10GbaseT <full-duplex>)', 10000],
    ['10Gbase-T <full-duplex>', 10000],
    ['1000baseT <full-duplex>', 1000],
    ['autoselect (none)', null],
    ['autoselect', null],
    ['none', null],
    ['<unknown type>', null],
  ])('%s → %s', (media, mbps) => {
    expect(mediaSpeedMbps(media)).toBe(mbps);
  });

  it('duplex', () => {
    expect(mediaDuplex('autoselect (100baseTX <half-duplex>)')).toBe('half');
    expect(mediaDuplex('autoselect (1000baseT <full-duplex,flow-control>)')).toBe('full');
    expect(mediaDuplex('autoselect')).toBeNull();
  });
});

describe('parseIfconfig', () => {
  const list = parseIfconfig(readText('ifconfig_a.txt'));
  const byDev = new Map(list.map((i) => [i.device, i]));

  it('finds every interface block', () => {
    expect(list.map((i) => i.device)).toEqual(['lo0', 'gif0', 'stf0', 'anpi0', 'en0', 'en1', 'bridge0', 'awdl0', 'en7', 'utun0', 'utun4']);
  });

  it('wired adapter with link speed and addresses', () => {
    const en7 = byDev.get('en7');
    expect(en7).toMatchObject({ up: true, running: true, mtu: 1500, mac: '00:e0:4c:aa:bb:03', status: 'active', mediaMbps: 1000, duplex: 'full' });
    expect(en7?.inet).toEqual([{ ip: '192.168.0.43', netmask: '0xffffff00' }]);
    expect(en7?.inet6[0]).toEqual({ ip: 'fe80::14a3:9d1e:3b1a:7f02', prefixLength: 64, zone: 'en7', flags: ['secured'] });
    expect(en7?.inet6[1].flags).toEqual(['autoconf', 'secured']);
    expect(ifconfigAddresses(en7!)).toEqual(['192.168.0.43', 'fe80::14a3:9d1e:3b1a:7f02', '2001:db8:aa00:1234:14a3:9d1e:3b1a:7f02']);
    expect(ifconfigLinkUp(en7!)).toBe(true);
  });

  it('Wi-Fi has no speed, temporary addresses are flagged', () => {
    const en0 = byDev.get('en0');
    expect(en0?.mediaMbps).toBeNull();
    expect(en0?.status).toBe('active');
    expect(en0?.inet6.find((a) => a.flags.includes('temporary'))?.ip).toBe('2001:db8:aa00:1234:8d1:22ff:3a4b:5c6d');
  });

  it('point-to-point tunnel address and interfaces without status', () => {
    const utun4 = byDev.get('utun4');
    expect(utun4?.inet).toEqual([{ ip: '172.16.0.2', netmask: '0xffffffff' }]);
    expect(utun4?.status).toBeNull();
    expect(ifconfigLinkUp(utun4!)).toBeNull();
    expect(byDev.get('stf0')).toMatchObject({ flags: [], up: false, mtu: 1280 });
    expect(ifconfigLinkUp(byDev.get('gif0')!)).toBe(false);
  });

  it('bridge member lines do not create interfaces', () => {
    expect(byDev.get('bridge0')?.status).toBe('inactive');
    expect(list.filter((i) => i.device === 'en1')).toHaveLength(1);
  });

  it('unplugged cable', () => {
    const [en7] = parseIfconfig(readText('ifconfig_en7_unplugged.txt'));
    expect(en7).toMatchObject({ device: 'en7', status: 'inactive', mediaMbps: null, up: true });
    expect(ifconfigLinkUp(en7)).toBe(false);
  });
});

describe('parseNetstatInterfaces', () => {
  const rows = parseNetstatInterfaces(readText('netstat_ibn.txt'));
  const by = new Map(rows.map((r) => [r.device, r]));

  it('one row per interface (link rows only)', () => {
    expect(rows.map((r) => r.device)).toEqual(['lo0', 'gif0', 'stf0', 'anpi0', 'en0', 'en1', 'bridge0', 'awdl0', 'en7', 'utun0', 'utun4']);
  });

  it('counters, index and MAC (short octets padded)', () => {
    expect(by.get('en7')).toEqual({
      device: 'en7',
      down: false,
      ifIndex: 16,
      mtu: 1500,
      mac: '00:e0:4c:aa:bb:03',
      ipkts: 45678901,
      ierrs: 12,
      ibytes: 61234567890,
      opkts: 23456789,
      oerrs: 0,
      obytes: 2345678901,
      coll: 0,
      drops: null,
    });
  });

  it('interfaces without MAC and down markers', () => {
    expect(by.get('utun4')).toMatchObject({ mac: null, ifIndex: 21, ibytes: 123456 });
    expect(by.get('gif0')).toMatchObject({ down: true, ifIndex: 2 });
  });

  it('optional Drop column', () => {
    const text = [
      'Name       Mtu   Network       Address            Ipkts Ierrs     Ibytes    Opkts Oerrs     Obytes  Coll Drop',
      'en7        1500  <Link#16>   0:e0:4c:aa:bb:3   45678901    12 61234567890 23456789     0 2345678901     0    7',
    ].join('\n');
    expect(parseNetstatInterfaces(text)[0]).toMatchObject({ obytes: 2345678901, coll: 0, drops: 7 });
  });
});

describe('parseNetstatTcp', () => {
  it('sent and retransmitted data packets', () => {
    expect(parseNetstatTcp(readText('netstat_s_tcp.txt'))).toEqual({ sent: 1234567, retransmitted: 2345 });
  });

  it('null when the lines are missing', () => {
    expect(parseNetstatTcp('tcp:\n\t12 packets received\n')).toBeNull();
  });
});

describe('parseHardwarePorts', () => {
  it('ports with devices and MACs', () => {
    const ports = parseHardwarePorts(readText('networksetup_listallhardwareports.txt'));
    expect(ports).toEqual([
      { port: 'Ethernet', device: 'en7', mac: '00:e0:4c:aa:bb:03' },
      { port: 'Wi-Fi', device: 'en0', mac: '3c:22:fb:aa:bb:02' },
      { port: 'Thunderbolt Bridge', device: 'bridge0', mac: '36:a1:7e:aa:bb:00' },
      { port: 'Thunderbolt 1', device: 'en1', mac: '36:a1:7e:aa:bb:04' },
      { port: 'iPhone USB', device: 'en8', mac: null },
    ]);
  });

  it('Wi-Fi and bridge ports', () => {
    expect(isWifiPort('Wi-Fi')).toBe(true);
    expect(isWifiPort('WLAN')).toBe(true);
    expect(isWifiPort('AirPort')).toBe(true);
    expect(isWifiPort('USB 10/100/1000 LAN')).toBe(false);
    expect(isBridgePort('Thunderbolt Bridge', 'bridge0')).toBe(true);
    expect(isBridgePort('Ethernet', 'en7')).toBe(false);
  });
});

describe('parseRouteGet', () => {
  it('IPv4 default route', () => {
    expect(parseRouteGet(readText('route_get_v4.txt'))).toEqual({
      routeTo: '1.1.1.1',
      destination: 'default',
      gateway: '192.168.0.1',
      gatewayMac: null,
      interface: 'en7',
      flags: ['UP', 'GATEWAY', 'DONE', 'STATIC', 'PRCLONING', 'GLOBAL'],
      mtu: 1500,
    });
  });

  it('IPv6 default route keeps the zone id of the link-local next hop', () => {
    expect(parseRouteGet(readText('route_get_v6.txt'))).toMatchObject({ routeTo: '2606:4700:4700::1111', gateway: 'fe80::de73:6ff:fe12:34df%en7', interface: 'en7' });
  });

  it('learned path MTU of a cloned host route', () => {
    expect(parseRouteGet(readText('route_get_v4_pmtu.txt'))).toMatchObject({ destination: '1.1.1.1', mtu: 1460 });
  });

  it('on-link host route shows the neighbour MAC as gateway', () => {
    expect(parseRouteGet(readText('route_get_gateway_onlink.txt'))).toMatchObject({ gateway: null, gatewayMac: 'dc:73:6:12:34:df', interface: 'en7' });
  });

  it('no route', () => {
    expect(parseRouteGet(readText('route_get_noroute.txt'))).toBeNull();
    expect(parseRouteGet('')).toBeNull();
  });
});

describe('padMac', () => {
  it('pads short octets', () => {
    expect(padMac('dc:73:6:12:34:df')).toBe('dc:73:06:12:34:df');
    expect(padMac('0:E0:4C:AA:BB:3')).toBe('00:e0:4c:aa:bb:03');
    expect(padMac('(incomplete)')).toBeNull();
    expect(padMac(null)).toBeNull();
  });
});

describe('buildMacInterfaces', () => {
  const ports = parseHardwarePorts(readText('networksetup_listallhardwareports.txt'));
  const ifc = parseIfconfig(readText('ifconfig_a.txt'));
  const ns = parseNetstatInterfaces(readText('netstat_ibn.txt'));
  const list = buildMacInterfaces(ports, ifc, ns);
  const by = new Map(list.map((i) => [i.device, i]));

  it('hardware ports + routable tunnels only', () => {
    expect(list.map((i) => `${i.device}=${i.name}`)).toEqual(['en0=Wi-Fi', 'en1=Thunderbolt 1', 'bridge0=Thunderbolt Bridge', 'en7=Ethernet', 'utun4=utun4']);
  });

  it('wired adapter', () => {
    expect(by.get('en7')).toMatchObject({ port: 'Ethernet', ifIndex: 16, isWifi: false, isVirtual: false, status: 'Up', linkUp: true, mediaMbps: 1000, duplex: 'full' });
    expect(by.get('en7')?.counters?.ibytes).toBe(61234567890);
  });

  it('Wi-Fi, bridge, tunnel, inactive port', () => {
    expect(by.get('en0')).toMatchObject({ isWifi: true, isVirtual: false, status: 'Up', mediaMbps: null });
    expect(by.get('bridge0')).toMatchObject({ isVirtual: true, status: 'Disconnected' });
    expect(by.get('utun4')).toMatchObject({ isVirtual: true, status: 'Up', linkUp: null, addresses: ['172.16.0.2', '2606:4700:110:8a1b:aaaa:bbbb:cccc:dddd'] });
    expect(by.get('en1')).toMatchObject({ status: 'Disconnected', linkUp: false });
  });

  it('name mapping', () => {
    expect(displayNameOf(list, 'en7')).toBe('Ethernet');
    expect(displayNameOf(list, 'en9')).toBe('en9');
    expect(deviceOf(list, 'wi-fi')).toBe('en0');
    expect(deviceOf(list, 'en7')).toBe('en7');
    expect(deviceOf(list, 'WLAN')).toBeNull();
  });

  it('without networksetup every en* interface counts as physical', () => {
    const fallback = buildMacInterfaces([], ifc, ns);
    expect(fallback.map((i) => i.device)).toEqual(['en0', 'en1', 'en7', 'utun4']);
    expect(fallback.find((i) => i.device === 'en0')?.isWifi).toBe(false);
  });
});
