import { describe, expect, it } from 'vitest';
import {
  detectGame,
  diffIdentity,
  gamingEvent,
  identitySignature,
  normalizeMac,
  parseEpisode,
  parseIdentity,
  parseIdentityState,
  parseTasklistCsv,
  v6PrefixOf,
  type IdentityValues,
} from './identity';

/** Real `Get-NdIdentity -RouterIp '192.168.0.1'` on Jan-PC (2026-10-09 ~19:04, Ethernet + WLAN up). */
const REAL_IDENTITY = {
  t: 1791565469434,
  found: true,
  ifIndex: 4,
  ifAlias: 'Ethernet',
  neighbors: [
    { ifIndex: 4, mac: 'DC-73-06-12-34-DF', state: 'Reachable' },
    { ifIndex: 6, mac: 'DC-73-06-12-34-DF', state: 'Reachable' },
  ],
  dhcpEnabled: true,
  dhcpServer: '192.168.0.1',
  dns: ['1.1.1.1', '8.8.8.8', '3fff:8071:7ca0:c980:de73:6ff:fe12:34df', '3fff:8071:7ca0:c980:de73:6ff:fe12:34df'],
  v6: [
    { ip: '3fff:8071:7ca0:c980:b219:6c3e:eadc:4c15', prefixLength: 64, suffixOrigin: 'Link' },
    { ip: '3fff:8071:7ca0:c980:7df5:ffbf:6014:ea67', prefixLength: 128, suffixOrigin: 'Random' },
  ],
};

/** German `tasklist /FO CSV /NH` lines (CP850 → decoded). */
const TASKLIST = [
  '"System Idle Process","0","Services","0","8 K"',
  '"System","4","Services","0","2.540 K"',
  '"svchost.exe","1234","Services","0","12.044 K"',
  '"cs2.exe","20400","Console","1","2.104.556 K"',
  '"Steam.exe","9876","Console","1","230.112 K"',
  '',
].join('\r\n');

describe('identity parsing', () => {
  it('normalizes MAC addresses and rejects incomplete entries', () => {
    expect(normalizeMac('dc:73:06:12:34:df')).toBe('DC-73-06-12-34-DF');
    expect(normalizeMac('00-00-00-00-00-00')).toBeNull();
    expect(normalizeMac('ff-ff-ff-ff-ff-ff')).toBeNull();
    expect(normalizeMac('')).toBeNull();
    expect(normalizeMac(null)).toBeNull();
  });
  it('derives the /64 prefix from router-advertised addresses', () => {
    expect(v6PrefixOf(['3fff:8071:7ca0:c980:b219:6c3e:eadc:4c15', '3fff:8071:7ca0:c980:7df5:ffbf:6014:ea67', 'fe80::1'])).toBe('3fff:8071:7ca0:c980::/64');
    expect(v6PrefixOf(['2a02:8071:00a0:0980::1'])).toBe('2a02:8071:a0:980::/64');
    expect(v6PrefixOf([])).toBeNull();
  });
  it('parses the real Get-NdIdentity output', () => {
    expect(parseIdentity(REAL_IDENTITY, 0)).toEqual({
      ts: 1791565469434,
      ifAlias: 'Ethernet',
      ifIndex: 4,
      gatewayMac: 'DC-73-06-12-34-DF',
      dhcpServer: '192.168.0.1',
      dns: ['1.1.1.1', '8.8.8.8', '3fff:8071:7ca0:c980:de73:6ff:fe12:34df'],
      v6Prefix: '3fff:8071:7ca0:c980::/64',
    });
    expect(parseIdentity({ t: 1, found: false }, 0)).toBeNull();
    const incomplete = { ...REAL_IDENTITY, neighbors: { ifIndex: 4, mac: '00-00-00-00-00-00', state: 'Incomplete' }, dhcpServer: '255.255.255.255', dns: '1.1.1.1', v6: null };
    expect(parseIdentity(incomplete, 0)).toMatchObject({ gatewayMac: null, dhcpServer: null, dns: ['1.1.1.1'], v6Prefix: null });
  });
});

describe('diffIdentity', () => {
  const sample = parseIdentity(REAL_IDENTITY, 0);
  if (!sample) throw new Error('parse failed');
  const stored: IdentityValues = { gatewayMac: 'DC-73-06-12-34-DF', dhcpServer: '192.168.0.1', dns: ['8.8.8.8', '1.1.1.1', '3fff:8071:7ca0:c980:de73:6ff:fe12:34df'], v6Prefix: '3fff:8071:7ca0:c980::/64', ts: 1 };

  it('first observation is stored silently; identical values (any order) produce nothing', () => {
    const first = diffIdentity(undefined, sample, '192.168.0.1');
    expect(first.events).toEqual([]);
    expect(first.next).toMatchObject({ gatewayMac: 'DC-73-06-12-34-DF', v6Prefix: '3fff:8071:7ca0:c980::/64' });
    expect(diffIdentity(stored, sample, '192.168.0.1').events).toEqual([]);
  });

  it('reports MAC, DHCP, DNS and prefix changes', () => {
    const changed = { ...sample, gatewayMac: '00-11-22-33-44-55', dhcpServer: '192.168.0.50', dns: ['192.168.0.1'], v6Prefix: '2a02:8071:1111:2222::/64' };
    const { events, next } = diffIdentity(stored, changed, '192.168.0.1');
    expect(events.map((e) => [e.severity, e.title])).toEqual([
      ['critical', 'Router-MAC-Adresse geändert (Ethernet)'],
      ['critical', 'DHCP-Server geändert: 192.168.0.1 → 192.168.0.50 (Ethernet)'],
      ['warn', 'DNS-Server geändert (Ethernet)'],
      ['warn', 'IPv6-Präfix geändert: 3fff:8071:7ca0:c980::/64 → 2a02:8071:1111:2222::/64 (Ethernet)'],
    ]);
    expect(events[0]).toMatchObject({ type: 'identity_change', segment: 'lan', source: 'system', details: { field: 'gatewayMac', from: 'DC-73-06-12-34-DF', to: '00-11-22-33-44-55', interface: 'Ethernet', routerIp: '192.168.0.1' } });
    expect(next.dhcpServer).toBe('192.168.0.50');
  });

  it('missing values are no change and keep the previous value', () => {
    const missing = { ...sample, gatewayMac: null, dhcpServer: null, dns: [], v6Prefix: null };
    const { events, next } = diffIdentity(stored, missing, '192.168.0.1');
    expect(events).toEqual([]);
    expect(identitySignature(next)).toBe(identitySignature(stored));
  });

  it('round-trips the persisted per-interface state', () => {
    const json = JSON.stringify({ Ethernet: stored, WLAN: { ...stored, dns: ['192.168.0.1'] }, junk: 5 });
    const state = parseIdentityState(json);
    expect(Object.keys(state)).toEqual(['Ethernet', 'WLAN']);
    expect(state.WLAN.dns).toEqual(['192.168.0.1']);
    expect(parseIdentityState('{kaputt')).toEqual({});
  });
});

describe('game detection', () => {
  it('parses tasklist CSV and matches configured games case-insensitively', () => {
    const procs = parseTasklistCsv(TASKLIST);
    expect(procs).toEqual(['System Idle Process', 'System', 'svchost.exe', 'cs2.exe', 'Steam.exe']);
    expect(detectGame(procs, ['valorant-win64-shipping.exe', 'CS2.EXE'])).toBe('cs2.exe');
    expect(detectGame(procs, ['steam'])).toBe('steam.exe'); // name without extension
    expect(detectGame(procs, ['dota2.exe'])).toBeNull();
    expect(detectGame(procs, [''])).toBeNull();
    expect(parseTasklistCsv('"Na""me.exe","1"')).toEqual(['Na"me.exe']);
  });
  it('builds and restores gaming episodes', () => {
    expect(gamingEvent('cs2.exe', 5)).toMatchObject({ type: 'gaming', ts: 5, endTs: null, severity: 'info', title: 'Spiel läuft: cs2.exe', details: { process: 'cs2.exe' } });
    expect(parseEpisode(JSON.stringify({ id: 7, process: 'cs2.exe', ts: 1, lastSeen: 9 }))).toEqual({ id: 7, process: 'cs2.exe', ts: 1, lastSeen: 9 });
    expect(parseEpisode(JSON.stringify({ id: null, process: 'cs2.exe', ts: 1 }))).toEqual({ id: null, process: 'cs2.exe', ts: 1, lastSeen: 1 });
    expect(parseEpisode('null')).toBeNull();
    expect(parseEpisode(null)).toBeNull();
  });
});
