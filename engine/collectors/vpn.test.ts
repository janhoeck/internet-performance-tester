import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { AdapterInfo, VpnInfo } from '../../src/lib/shared/types';
import { buildVpnInfo, diffVpn, extractJson, otherTunnels, parseWarpSettings, parseWarpStatus, vpnSignature } from './vpn';

const fixture = (name: string): unknown => JSON.parse(fs.readFileSync(new URL(`../../fixtures/windows/${name}`, import.meta.url), 'utf8'));

function adapter(name: string, description: string, patch: Partial<AdapterInfo> = {}): AdapterInfo {
  return {
    name, description, ifIndex: 1, status: 'Up', linkMbps: null, mediaType: null, mac: null, driverVersion: null, driverDate: null,
    serviceName: null, isWifi: false, isVirtual: true, mediaConnected: true, addresses: [], rxBytes: null, txBytes: null,
    rxErrors: null, rxDiscards: null, txErrors: null, txDiscards: null, ...patch,
  };
}

describe('warp-cli parsing (real fixtures)', () => {
  it('parses -j status and -j settings list', () => {
    expect(parseWarpStatus(fixture('warp-cli_json_status.json'))).toEqual({ status: 'Connected', reason: 'NetworkHealthy' });
    expect(parseWarpSettings(fixture('warp-cli_json_settings_list.json'))).toEqual({ mode: 'tunnel_only', splitTunnel: 'include' });
    expect(parseWarpStatus({ foo: 1 })).toBeNull();
    expect(parseWarpSettings({ settings: { split_tunnel_mode: 'network_policy' } })).toEqual({ mode: null, splitTunnel: null });
  });
  it('extracts JSON from noisy output', () => {
    expect(extractJson('Hinweis\r\n{"status":"Disconnected","reason":"Manual"}\r\n')).toEqual({ status: 'Disconnected', reason: 'Manual' });
    expect(extractJson('Error: service not running')).toBeNull();
    expect(extractJson('{kaputt}')).toBeNull();
  });
});

describe('tunnel adapters', () => {
  it('lists other active tunnels, never WARP, Hyper-V or Bluetooth', () => {
    const list = [
      adapter('CloudflareWARP', 'Cloudflare WARP Interface Tunnel'),
      adapter('Bluetooth-Netzwerkverbindung', 'Bluetooth Device (Personal Area Network)'),
      adapter('vEthernet (Default Switch)', 'Hyper-V Virtual Ethernet Adapter'),
      adapter('NordLynx', 'NordLynx Tunnel'),
      adapter('OpenVPN TAP', 'TAP-Windows Adapter V9', { status: 'Disconnected' }),
      adapter('Ethernet', 'Intel(R) Ethernet Controller (3) I225-V', { isVirtual: false }),
    ];
    expect(otherTunnels(list)).toEqual(['NordLynx']);
  });
});

describe('VpnInfo + vpn_change', () => {
  const ts = 1_791_565_000_000;
  const warp = { installed: true, status: { status: 'Connected', reason: 'NetworkHealthy' }, settings: { mode: 'tunnel_only', splitTunnel: 'include' as const } };
  const base = buildVpnInfo(ts, warp, []);

  it('builds the snapshot', () => {
    expect(base).toEqual({
      ts,
      warp: { installed: true, connected: true, status: 'Connected (NetworkHealthy)', mode: 'tunnel_only', splitTunnel: 'include' },
      otherTunnels: [],
    });
    expect(buildVpnInfo(ts, { installed: false, status: null, settings: null }, []).warp).toEqual({ installed: false, connected: null, status: null, mode: null, splitTunnel: null });
  });

  it('reports state, mode, split-tunnel and tunnel changes (first poll silent)', () => {
    expect(diffVpn(null, base)).toEqual([]);
    expect(diffVpn(base, base)).toEqual([]);
    const off = buildVpnInfo(ts + 1, { ...warp, status: { status: 'Disconnected', reason: 'Manual' } }, []);
    expect(diffVpn(base, off)[0]).toMatchObject({ type: 'vpn_change', severity: 'info', title: 'Cloudflare WARP getrennt (Disconnected (Manual))', details: { change: 'connected' } });
    expect(diffVpn(off, base)[0].title).toBe('Cloudflare WARP verbunden');
    const full = buildVpnInfo(ts + 2, { ...warp, settings: { mode: 'warp', splitTunnel: 'exclude' } }, []);
    const ev = diffVpn(base, full);
    expect(ev.map((e) => e.title)).toEqual([
      'WARP-Modus geändert: nur Tunnel (ohne DNS) → Tunnel + DNS',
      'WARP leitet jetzt fast den gesamten Verkehr durch den Tunnel (Split-Tunnel „Ausschließen“)',
    ]);
    expect(ev[1].severity).toBe('warn');
    const tunnel = buildVpnInfo(ts + 3, warp, ['NordLynx']);
    expect(diffVpn(base, tunnel)[0]).toMatchObject({ severity: 'warn', title: 'VPN-Tunnel aktiv: NordLynx' });
    expect(diffVpn(tunnel, base)[0]).toMatchObject({ severity: 'info', title: 'VPN-Tunnel beendet: NordLynx' });
    const unknown = buildVpnInfo(ts + 4, { ...warp, status: null }, []);
    expect(diffVpn(base, unknown)).toEqual([]); // service not answering is not a state change
    const removed: VpnInfo = buildVpnInfo(ts + 5, { installed: false, status: null, settings: null }, []);
    expect(diffVpn(base, removed)[0].title).toBe('Cloudflare WARP nicht mehr installiert');
  });

  it('signature changes only on relevant fields', () => {
    expect(vpnSignature(base)).toBe(vpnSignature({ ...base, ts: ts + 99 }));
    expect(vpnSignature(base)).not.toBe(vpnSignature(buildVpnInfo(ts, warp, ['NordLynx'])));
  });
});
