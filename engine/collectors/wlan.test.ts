import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseNetshWlan, wlanInfoFromNetsh } from '../../src/lib/shared/parsers/netsh';
import type { AdapterInfo, WlanInfo } from '../../src/lib/shared/types';
import { diffWlan, wifiAdapterOf, wlanMetrics, wlanSignature } from './wlan';

const fixture = (name: string) => fs.readFileSync(new URL(`../../fixtures/windows/${name}`, import.meta.url), 'utf8');

const ts = 1_791_565_000_000;
const connected = wlanInfoFromNetsh(parseNetshWlan(fixture('netsh_wlan_show_interfaces_CONNECTED_synthetic.de-DE.txt')), ts, { adapterName: 'WLAN', mediaConnected: true });
const disconnected = wlanInfoFromNetsh(parseNetshWlan(fixture('netsh_wlan_show_interfaces_disconnected.txt')), ts, { adapterName: 'WLAN' });

const at = (info: WlanInfo, patch: Partial<WlanInfo>): WlanInfo => ({ ...info, ...patch });

describe('wlan metrics', () => {
  it('records signal, RSSI, rates and channel only while connected', () => {
    expect(Object.fromEntries(wlanMetrics(connected).map((p) => [p.key, p.value]))).toEqual({
      'wlan.signal_pct': 96, 'wlan.rssi_dbm': -48, 'wlan.rx_mbps': 1200.9, 'wlan.tx_mbps': 1200.9, 'wlan.channel': 36,
    });
    expect(wlanMetrics(disconnected)).toEqual([]);
    expect(wlanMetrics(at(connected, { rssiDbm: null })).map((p) => p.key)).not.toContain('wlan.rssi_dbm');
  });
});

describe('diffWlan', () => {
  it('first poll is silent; connect/disconnect only as fallback', () => {
    expect(diffWlan(null, connected, { connectEvents: true })).toEqual([]);
    expect(diffWlan(disconnected, connected, { connectEvents: false })).toEqual([]);
    const [c] = diffWlan(disconnected, connected, { connectEvents: true });
    expect(c).toMatchObject({ type: 'wlan_connect', source: 'wlan', title: 'WLAN verbunden (Vodafone-43FE, 5 GHz, Kanal 36)', details: { bssid: 'dc:73:06:12:34:e0', via: 'netsh' } });
    const [d] = diffWlan(connected, at(disconnected, { ts: ts + 1 }), { connectEvents: true });
    expect(d).toMatchObject({ type: 'wlan_disconnect', title: 'WLAN getrennt (Vodafone-43FE)' });
  });

  it('BSSID change = roam (band steering), channel change with same BSSID = DFS/auto channel', () => {
    const roamed = at(connected, { bssid: 'dc:73:06:12:34:de', band: '2,4 GHz', channel: 6, ts: ts + 15_000 });
    const [r] = diffWlan(connected, roamed, { connectEvents: false });
    expect(r).toMatchObject({ type: 'wlan_roam', severity: 'info', title: 'WLAN-Roaming: Zugangspunkt gewechselt, 5 GHz → 2,4 GHz', details: { reason: 'bssid', fromBssid: 'dc:73:06:12:34:e0', toBssid: 'dc:73:06:12:34:de', toChannel: 6 } });
    const [ch] = diffWlan(connected, at(connected, { channel: 100 }), { connectEvents: false });
    expect(ch).toMatchObject({ type: 'wlan_roam', title: 'WLAN-Kanal gewechselt: 36 → 100', details: { reason: 'channel' } });
    expect(diffWlan(connected, at(connected, { signalPct: 40, rxMbps: 200 }), { connectEvents: true })).toEqual([]);
  });

  it('SSID change is reported as disconnect + connect in fallback mode', () => {
    const other = at(connected, { ssid: 'Gast', bssid: 'aa:bb:cc:dd:ee:ff' });
    expect(diffWlan(connected, other, { connectEvents: true }).map((e) => e.type)).toEqual(['wlan_disconnect', 'wlan_connect']);
    expect(diffWlan(connected, other, { connectEvents: false })).toEqual([]);
  });

  it('signature ignores signal and rate fluctuations', () => {
    expect(wlanSignature(connected)).toBe(wlanSignature(at(connected, { signalPct: 50, rxMbps: 1, ts: 0 })));
    expect(wlanSignature(connected)).not.toBe(wlanSignature(at(connected, { channel: 40 })));
  });
});

describe('wifiAdapterOf', () => {
  const a = (name: string, isWifi: boolean, isVirtual = false) => ({ name, isWifi, isVirtual }) as unknown as AdapterInfo;
  it('finds the physical WLAN adapter', () => {
    expect(wifiAdapterOf({ adapters: [a('Ethernet', false), a('WLAN', true)] })?.name).toBe('WLAN');
    expect(wifiAdapterOf({ adapters: [a('Virtual WiFi', true, true)] })).toBeNull();
    expect(wifiAdapterOf(null)).toBeNull();
  });
});
