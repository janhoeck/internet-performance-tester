import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/lib/shared/config';
import type { AdapterInfo, VpnInfo } from '../../src/lib/shared/types';
import type { EngineContext } from '../core/types';
import { silentLogger } from './util';
import {
  buildVpnInfo,
  createVpnModule,
  diffVpn,
  extractJson,
  findMacWarpCli,
  isWarpTunnel,
  macOtherTunnels,
  otherTunnels,
  parseWarpSettings,
  parseWarpStatus,
  vpnSignature,
} from './vpn';

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

describe('macOS tunnels and warp-cli', () => {
  const utun = (name: string, addresses: string[], patch: Partial<AdapterInfo> = {}) => adapter(name, name, { addresses, ...patch });

  it('lists routable utun/ipsec/ppp tunnels, never WARP or the link-local system utuns', () => {
    const list = [
      utun('utun0', ['fe80::d2c1:5e4f:a0b1:c2d3']),
      utun('utun4', ['172.16.0.2', '2606:4700:110:8a1b:aaaa:bbbb:cccc:dddd']),
      utun('utun5', ['10.8.0.6']),
      utun('ipsec0', ['192.0.2.10']),
      utun('ppp0', ['198.51.100.7'], { status: 'Disconnected' }),
      utun('bridge0', ['192.0.2.1']),
      adapter('Ethernet', 'en7 · Ethernet', { isVirtual: false, addresses: ['192.168.0.43'] }),
    ];
    expect(macOtherTunnels(list, { warpInstalled: true })).toEqual(['ipsec0', 'utun5']);
    expect(macOtherTunnels(list, { warpInstalled: false })).toEqual(['ipsec0', 'utun4', 'utun5']);
    expect(isWarpTunnel({ addresses: ['2606:4700:110:1::2'] })).toBe(true);
    expect(isWarpTunnel({ addresses: ['100.96.0.7'] })).toBe(true);
    expect(isWarpTunnel({ addresses: ['100.64.0.7'] })).toBe(false);
    expect(isWarpTunnel({ addresses: ['10.8.0.6'] })).toBe(false);
  });

  it('finds warp-cli at the first existing path', async () => {
    expect(await findMacWarpCli(['/nicht/vorhanden/warp-cli', process.execPath])).toBe(process.execPath);
    expect(await findMacWarpCli(['/nicht/vorhanden/warp-cli'])).toBeNull();
  });

  it('module on macOS: not installed without warp-cli, tunnels from the adapters snapshot', async () => {
    const snapshots: VpnInfo[] = [];
    const runs: string[] = [];
    const ctx = {
      log: silentLogger,
      db: { latestSnapshot: (k: string) => (k === 'adapters' ? { ts: 1, data: { adapters: [utun('utun5', ['10.8.0.6']), utun('utun4', ['172.16.0.2'])] } } : null) },
      bus: { on: () => () => undefined },
      config: () => DEFAULT_CONFIG,
      recordEvent: () => 1,
      recordSnapshot: (_k: string, d: VpnInfo) => snapshots.push(d),
      trackChild: () => undefined,
    } as unknown as EngineContext;
    const runner = {
      run: (file: string, args: string[]) => {
        runs.push(`${file} ${args.join(' ')}`);
        const json = args.includes('status') ? '{"status":"Connected","reason":"NetworkHealthy"}' : '{"settings":{"operation_mode":"warp","split_tunnel_mode":"exclude"}}';
        return Promise.resolve({ code: 0, stdout: Buffer.from(json), stderr: Buffer.alloc(0), timedOut: false, error: null, durationMs: 1 });
      },
      killAll: () => undefined,
    };
    const missing = createVpnModule({ mac: true, runner, warpCli: () => Promise.resolve(null) });
    missing.init?.(ctx);
    await missing.runNow?.();
    expect(runs).toEqual([]);
    expect(snapshots[0]).toMatchObject({ warp: { installed: false }, otherTunnels: ['utun4', 'utun5'] });
    missing.dispose?.();

    const installed = createVpnModule({ mac: true, runner, warpCli: () => Promise.resolve('/usr/local/bin/warp-cli') });
    installed.init?.(ctx);
    await installed.runNow?.();
    expect(runs).toEqual(['/usr/local/bin/warp-cli -j status', '/usr/local/bin/warp-cli -j settings list']);
    expect(snapshots.at(-1)).toMatchObject({ warp: { installed: true, connected: true, mode: 'warp', splitTunnel: 'exclude' }, otherTunnels: ['utun5'] });
    installed.dispose?.();
  });
});
