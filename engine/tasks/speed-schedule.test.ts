import { describe, expect, it } from 'vitest';
import type { AdapterInfo, AdapterSnapshot, ClientState } from '../../src/lib/shared/types';
import {
  MIN_GAP_MS,
  type SkipContext,
  TrafficWindow,
  adapterTrafficMbps,
  clientTrafficMbps,
  computeNextRun,
  inQuietHours,
  linkState,
  pickLinkMbps,
  primaryAdapter,
  skipReason,
} from './speed-schedule';

const NOW = Date.UTC(2026, 9, 9, 12, 0, 0);

function adapter(p: Partial<AdapterInfo> & Pick<AdapterInfo, 'name' | 'ifIndex'>): AdapterInfo {
  return {
    description: '',
    status: 'Up',
    linkMbps: 1000,
    mediaType: '802.3',
    mac: null,
    driverVersion: null,
    driverDate: null,
    serviceName: null,
    isWifi: false,
    isVirtual: false,
    mediaConnected: true,
    addresses: [],
    rxBytes: 0,
    txBytes: 0,
    rxErrors: 0,
    rxDiscards: 0,
    txErrors: 0,
    txDiscards: 0,
    ...p,
  };
}

/** Like this PC: Intel I225-V "Ethernet" (ifIndex 4), "WLAN", Cloudflare WARP tunnel. */
function snapshot(p: { ts?: number; ethMbps?: number | null; ethStatus?: string; rx?: number; tx?: number; v4If?: number } = {}): AdapterSnapshot {
  return {
    ts: p.ts ?? NOW,
    adapters: [
      adapter({ name: 'CloudflareWARP', ifIndex: 21, isVirtual: true, linkMbps: 100 }),
      adapter({ name: 'WLAN', ifIndex: 12, isWifi: true, linkMbps: 866.7, mediaConnected: false, status: 'Disconnected' }),
      adapter({
        name: 'Ethernet',
        ifIndex: 4,
        description: 'Intel(R) Ethernet Controller (3) I225-V',
        serviceName: 'e2fexpress',
        linkMbps: p.ethMbps === undefined ? 1000 : p.ethMbps,
        status: p.ethStatus ?? 'Up',
        rxBytes: p.rx ?? 0,
        txBytes: p.tx ?? 0,
      }),
    ],
    routes:
      p.v4If === undefined
        ? [{ family: 4, destination: '1.1.1.1', ifAlias: 'Ethernet', ifIndex: 4, sourceAddress: '192.168.0.192', nextHop: '192.168.0.1' }]
        : [{ family: 4, destination: '1.1.1.1', ifAlias: null, ifIndex: p.v4If, sourceAddress: null, nextHop: null }],
    advanced: [],
  };
}

function client(p: Partial<ClientState> = {}): ClientState {
  return {
    ts: NOW - 500,
    expectedIf: 'Ethernet',
    egressV4If: 'Ethernet',
    egressV6If: 'Ethernet',
    egressV4Address: '192.168.0.192',
    egressV6Address: null,
    onExpected: true,
    linkUp: true,
    linkMbps: 1000,
    rxMbps: 0.2,
    txMbps: 0.1,
    gaming: false,
    preventSleep: true,
    ...p,
  };
}

describe('inQuietHours', () => {
  it('handles a same-day range [from, to)', () => {
    const qh = { from: 18, to: 23 };
    expect(inQuietHours(17, qh)).toBe(false);
    expect(inQuietHours(18, qh)).toBe(true);
    expect(inQuietHours(22, qh)).toBe(true);
    expect(inQuietHours(23, qh)).toBe(false);
  });

  it('wraps over midnight and supports to = 24', () => {
    const night = { from: 22, to: 6 };
    expect(inQuietHours(23, night)).toBe(true);
    expect(inQuietHours(0, night)).toBe(true);
    expect(inQuietHours(5, night)).toBe(true);
    expect(inQuietHours(6, night)).toBe(false);
    expect(inQuietHours(12, night)).toBe(false);
    expect(inQuietHours(23, { from: 22, to: 24 })).toBe(true);
    expect(inQuietHours(0, { from: 22, to: 24 })).toBe(false);
  });

  it('from === to or null means no quiet hours', () => {
    expect(inQuietHours(10, { from: 10, to: 10 })).toBe(false);
    expect(inQuietHours(10, null)).toBe(false);
  });
});

describe('skipReason', () => {
  const ok: SkipContext = {
    now: NOW,
    hour: 12,
    quietHours: { from: 18, to: 23 },
    gaming: false,
    ownTrafficMbps: 0.4,
    outageActive: false,
    link: 'up',
    lastRunTs: NOW - 4 * 3600_000,
  };

  it('lets a scheduled run through when nothing speaks against it', () => {
    expect(skipReason(ok)).toBeNull();
    expect(skipReason({ ...ok, lastRunTs: null, ownTrafficMbps: null, link: 'unknown' })).toBeNull();
  });

  it.each<[string, Partial<SkipContext>, string]>([
    ['outage', { outageActive: true }, 'Ausfall läuft'],
    ['link down', { link: 'down' }, 'Netzwerkverbindung getrennt'],
    ['failover', { link: 'failover' }, 'Ausweichverbindung aktiv (nicht die erwartete Schnittstelle)'],
    ['gaming', { gaming: true }, 'Spiel läuft'],
    ['quiet hours', { hour: 20 }, 'Ruhezeit (18–23 Uhr)'],
    ['recent run', { lastRunTs: NOW - 29 * 60_000 }, 'Letzter Speedtest vor weniger als 30 min'],
    ['own traffic', { ownTrafficMbps: 5.1 }, 'Eigener Datenverkehr 5,1 Mbit/s (> 5 Mbit/s)'],
  ])('skips on %s', (_name, patch, reason) => {
    expect(skipReason({ ...ok, ...patch })).toBe(reason);
  });

  it('applies the thresholds exactly', () => {
    expect(skipReason({ ...ok, ownTrafficMbps: 5 })).toBeNull();
    expect(skipReason({ ...ok, lastRunTs: NOW - MIN_GAP_MS })).toBeNull();
    expect(skipReason({ ...ok, lastRunTs: NOW - 10 * 60_000, minGapMs: 5 * 60_000 })).toBeNull();
  });

  it('reports the most important reason first', () => {
    expect(skipReason({ ...ok, gaming: true, outageActive: true, hour: 20 })).toBe('Ausfall läuft');
    expect(skipReason({ ...ok, gaming: true, hour: 20 })).toBe('Spiel läuft');
  });
});

describe('computeNextRun', () => {
  it('is due every N minutes after the last run, never before `earliest`', () => {
    expect(computeNextRun(null, 180, NOW + 600_000)).toBe(NOW + 600_000);
    expect(computeNextRun(NOW, 180, NOW + 60_000)).toBe(NOW + 180 * 60_000);
    expect(computeNextRun(NOW - 10 * 3600_000, 180, NOW + 60_000)).toBe(NOW + 60_000);
  });
});

describe('TrafficWindow', () => {
  it('averages own traffic over the last minute', () => {
    const w = new TrafficWindow();
    for (let i = 0; i < 60; i++) w.push(NOW - 59_000 + i * 1000, i < 30 ? 2 : 10);
    expect(w.meanMbps(NOW)).toBeCloseTo(6, 9);
    expect(w.meanMbps(NOW, 30_000)).toBeCloseTo(10, 9);
  });

  it('needs enough samples and forgets old ones', () => {
    const w = new TrafficWindow(120_000);
    for (let i = 0; i < 9; i++) w.push(NOW - i * 1000, 50);
    expect(w.meanMbps(NOW)).toBeNull();
    w.push(NOW - 9000, 50);
    expect(w.meanMbps(NOW)).toBe(50);
    expect(w.meanMbps(NOW + 10 * 60_000)).toBeNull();
    w.push(Number.NaN, 1);
    w.clear();
    expect(w.meanMbps(NOW)).toBeNull();
  });

  it('client ticks contribute rx + tx', () => {
    expect(clientTrafficMbps(client({ rxMbps: 3.5, txMbps: 1.5 }))).toBe(5);
    expect(clientTrafficMbps(client({ rxMbps: null }))).toBeNull();
  });
});

describe('adapters', () => {
  it('finds the adapter carrying internet traffic', () => {
    expect(primaryAdapter(snapshot())?.name).toBe('Ethernet');
    expect(primaryAdapter(snapshot(), 'WLAN')?.name).toBe('WLAN');
    expect(primaryAdapter(snapshot({ v4If: 12 }))?.name).toBe('WLAN');
    const noRoutes = { ...snapshot(), routes: [] };
    expect(primaryAdapter(noRoutes)?.name).toBe('Ethernet');
    expect(primaryAdapter(null)).toBeNull();
  });

  it('link speed at test time: fresh client state first, then the snapshot', () => {
    expect(pickLinkMbps(client({ linkMbps: 100 }), snapshot(), NOW)).toBe(100);
    // stale client state → snapshot of the primary adapter
    expect(pickLinkMbps(client({ ts: NOW - 60_000, linkMbps: 100 }), snapshot({ ethMbps: 1000 }), NOW)).toBe(1000);
    // failover to WLAN: the egress interface's adapter from the snapshot
    expect(pickLinkMbps(client({ onExpected: false, egressV4If: 'WLAN', linkMbps: null }), snapshot(), NOW)).toBe(866.7);
    expect(pickLinkMbps(null, snapshot({ ethMbps: 100 }), NOW)).toBe(100);
    expect(pickLinkMbps(null, null, NOW)).toBeNull();
  });

  it('link state for the skip rules', () => {
    expect(linkState(client(), null, NOW)).toBe('up');
    expect(linkState(client({ linkUp: false }), snapshot(), NOW)).toBe('down');
    expect(linkState(client({ onExpected: false }), snapshot(), NOW)).toBe('failover');
    expect(linkState(client({ ts: NOW - 60_000, linkUp: false }), snapshot(), NOW)).toBe('up');
    expect(linkState(null, snapshot({ ethStatus: 'Disconnected' }), NOW)).toBe('down');
    expect(linkState(null, snapshot({ ts: NOW - 3600_000 }), NOW)).toBe('unknown');
    expect(linkState(null, null, NOW)).toBe('unknown');
  });

  it('own traffic from two adapter snapshots (fallback without client ticks)', () => {
    const prev = snapshot({ ts: NOW - 10_000, rx: 1_000_000, tx: 500_000 });
    const cur = snapshot({ ts: NOW, rx: 13_500_000, tx: 1_750_000 });
    // (12.5 MB + 1.25 MB) in 10 s = 11 Mbit/s
    expect(adapterTrafficMbps(prev, cur)).toBeCloseTo(11, 9);
    expect(adapterTrafficMbps(cur, prev)).toBeNull();
    expect(adapterTrafficMbps(snapshot({ ts: NOW - 3600_000 }), cur)).toBeNull();
    expect(adapterTrafficMbps(snapshot({ ts: NOW - 10_000, rx: 99_000_000 }), cur)).toBeNull(); // counter reset
    expect(adapterTrafficMbps(null, cur)).toBeNull();
  });
});
