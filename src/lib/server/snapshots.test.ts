import { describe, expect, it } from 'vitest';
import {
  latestPerFamily,
  mtuResults,
  natResults,
  normalizeAdapterSnapshot,
  normalizeDocsis,
  normalizeRouterStatus,
  normalizeVpn,
  normalizeWlan,
} from './snapshots';

describe('snapshot normalizers', () => {
  it('fills router status defaults and never trusts nested shapes', () => {
    const s = normalizeRouterStatus({ model: 'TG6442', reachable: true, extra: 'x', attachedDevices: 'none', docsis: { ds: 'bad', rating: 'great' } }, 123, '192.168.0.1');
    expect(s).not.toBeNull();
    expect(s?.ts).toBe(123);
    expect(s?.ip).toBe('192.168.0.1');
    expect(s?.model).toBe('TG6442');
    expect(s?.reachable).toBe(true);
    expect(s?.extra).toEqual({});
    expect(s?.attachedDevices).toBeNull();
    expect(s?.docsis).toMatchObject({ ds: [], us: [], rating: 'unknown', notes: [] });
    expect(normalizeRouterStatus('garbage', 1, 'x')).toBeNull();
  });

  it('keeps valid DOCSIS data', () => {
    const d = normalizeDocsis({ ts: 5, ds: [{ dir: 'ds' }], us: [], rating: 'warn', notes: ['SNR-Ausreißer', 3] });
    expect(d).toMatchObject({ ts: 5, rating: 'warn', notes: ['SNR-Ausreißer'] });
    expect(d?.ds).toHaveLength(1);
    expect(normalizeDocsis(null)).toBeNull();
  });

  it('normalizes adapters, WLAN and VPN snapshots', () => {
    expect(normalizeAdapterSnapshot({ adapters: [{ name: 'Ethernet' }], routes: null }, 9)).toMatchObject({ ts: 9, adapters: [{ name: 'Ethernet' }], routes: [], advanced: [] });
    expect(normalizeWlan({ connected: true, ssid: 'X', raw: 5 }, 7)).toMatchObject({ ts: 7, present: false, connected: true, ssid: 'X', raw: {} });
    expect(normalizeVpn({ warp: { installed: true }, otherTunnels: ['A', 1] }, 3)).toEqual({ ts: 3, warp: { installed: true }, otherTunnels: ['A'] });
    expect(normalizeVpn(1, 3)).toBeNull();
  });
});

describe('MTU / NAT results', () => {
  it('flattens arrays and wrapper objects and drops records without family', () => {
    const data = { results: [{ family: 4, target: '1.1.1.1', mtu: 1460, maxPayload: 1432 }, { family: '6', mtu: 1500 }, { mtu: 1 }] };
    const mtu = mtuResults(data, 100);
    expect(mtu).toEqual([
      { ts: 100, family: 4, target: '1.1.1.1', mtu: 1460, maxPayload: 1432, note: null },
      { ts: 100, family: 6, target: '', mtu: 1500, maxPayload: null, note: null },
    ]);
    const nat = natResults([{ family: 4, publicIp: '92.208.31.17', mapping: 'endpoint-independent', cgnat: true, mappings: [{ server: 's', mapped: 'm', rttMs: 1 }, 5] }, { family: 6, mapping: '???' }], 50);
    expect(nat[0]).toMatchObject({ family: 4, publicIp: '92.208.31.17', mapping: 'endpoint-independent', cgnat: true, mappings: [{ server: 's', mapped: 'm', rttMs: 1, error: null }] });
    expect(nat[1]).toMatchObject({ family: 6, mapping: 'unknown', cgnat: null, mappings: [] });
  });

  it('picks the newest result per family, IPv4 first', () => {
    const items = [
      { ts: 1, family: 6 as const, v: 'a' },
      { ts: 3, family: 4 as const, v: 'b' },
      { ts: 2, family: 6 as const, v: 'c' },
      { ts: 1, family: 4 as const, v: 'd' },
    ];
    expect(latestPerFamily(items).map((i) => i.v)).toEqual(['b', 'c']);
  });
});
