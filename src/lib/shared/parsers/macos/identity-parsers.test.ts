import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { arpMacFor, parseArp } from './arp';
import { parseIpconfigPacket } from './ipconfig';
import { parsePsComm } from './ps';
import { defaultNameservers, parseScutilDns } from './scutil';

const readText = (name: string) => fs.readFileSync(new URL(`../../../../../fixtures/macos/${name}`, import.meta.url), 'utf8');

describe('parseArp', () => {
  it('resolved gateway (short octets padded)', () => {
    const entries = parseArp(readText('arp_n_gateway.txt'));
    expect(entries).toEqual([{ ip: '192.168.0.1', mac: 'dc:73:06:12:34:df', device: 'en7', permanent: false }]);
    expect(arpMacFor(entries, '192.168.0.1')).toBe('dc:73:06:12:34:df');
  });

  it('incomplete and missing entries', () => {
    const inc = parseArp(readText('arp_n_incomplete.txt'));
    expect(inc).toEqual([{ ip: '192.168.0.1', mac: null, device: 'en7', permanent: false }]);
    expect(arpMacFor(inc, '192.168.0.1')).toBeNull();
    expect(parseArp(readText('arp_n_noentry.txt'))).toEqual([]);
    expect(arpMacFor([], '192.168.0.1')).toBeNull();
  });

  it('full table with permanent multicast entries', () => {
    const all = parseArp(readText('arp_an.txt'));
    expect(all).toHaveLength(5);
    expect(all.filter((e) => e.ip === '192.168.0.1').map((e) => e.device)).toEqual(['en7', 'en0']);
    expect(all.find((e) => e.ip === '224.0.0.251')).toMatchObject({ mac: '01:00:5e:00:00:fb', permanent: true });
  });
});

describe('parseScutilDns', () => {
  const resolvers = parseScutilDns(readText('scutil_dns.txt'));

  it('reads only the first section', () => {
    expect(resolvers.map((r) => r.index)).toEqual([1, 2, 3, 4]);
    expect(resolvers[0]).toEqual({
      index: 1,
      domain: null,
      nameservers: ['192.168.0.1', '2001:db8:aa00:1234::1'],
      searchDomains: ['fritz.box'],
      ifIndex: 16,
      device: 'en7',
      options: null,
    });
    expect(resolvers[1]).toMatchObject({ domain: 'local', options: 'mdns', nameservers: [] });
  });

  it('default name servers skip domain resolvers and duplicates', () => {
    expect(defaultNameservers(resolvers)).toEqual(['192.168.0.1', '2001:db8:aa00:1234::1']);
    const dup = parseScutilDns('DNS configuration\n\nresolver #1\n  nameserver[0] : 1.1.1.1\n\nresolver #2\n  nameserver[0] : 1.1.1.1\n  nameserver[1] : 8.8.8.8\n');
    expect(defaultNameservers(dup)).toEqual(['1.1.1.1', '8.8.8.8']);
    expect(defaultNameservers(parseScutilDns('No DNS configuration available\n'))).toEqual([]);
  });
});

describe('parseIpconfigPacket', () => {
  it('DHCP server, routers, DNS servers, lease', () => {
    expect(parseIpconfigPacket(readText('ipconfig_getpacket_en7.txt'))).toEqual({
      yiaddr: '192.168.0.43',
      serverIdentifier: '192.168.0.1',
      routers: ['192.168.0.1'],
      dnsServers: ['192.168.0.1', '192.0.2.53'],
      domainName: 'fritz.box',
      leaseTimeSec: 604800,
    });
  });

  it('no packet', () => {
    expect(parseIpconfigPacket('')).toBeNull();
    expect(parseIpconfigPacket('ipconfig: no packet on en7\n')).toBeNull();
  });
});

describe('parsePsComm', () => {
  it('basenames of the executable paths, spaces kept', () => {
    const names = parsePsComm(readText('ps_comm.txt'));
    expect(names).toEqual(['launchd', 'logd', 'Finder', 'steam_osx', 'LeagueofLegends', 'World of Warcraft', 'kernel_task', 'netstat']);
  });
});
