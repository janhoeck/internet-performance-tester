import { describe, expect, it } from 'vitest';
import {
  ClientTracker,
  deriveClientState,
  effectivePreventSleep,
  nicRate,
  OnExpectedTracker,
  pickPrimaryNic,
} from './client-state';
import type { EgressTick, NicTick } from './types';

const T0 = 1_791_550_574_000; // 09.10.2026 – same era as the fixtures

function nic(name: string, ts: number, rx: number, tx: number, extra: Partial<NicTick> = {}): NicTick {
  return { ts, name, up: true, mbps: name === 'WLAN' ? 961 : 1000, rxBytes: rx, txBytes: tx, rxErrors: 0, rxDiscards: 0, isWifi: name === 'WLAN', ...extra };
}

// addresses as seen on this machine (fixtures/windows/pscol_route_v4_1.1.1.1.json, live check)
const egressEthernet = (ts: number): EgressTick => ({
  ts,
  v4Address: '192.168.0.192',
  v6Address: '3fff:8071:7ca0:c980:b219:6c3e:eadc:4c15',
  v4If: 'Ethernet',
  v6If: 'Ethernet',
});
const egressWlan = (ts: number): EgressTick => ({ ts, v4Address: '192.168.0.35', v6Address: '3fff:8071:7ca0:c980::bf0c', v4If: 'WLAN', v6If: 'WLAN' });

describe('nicRate', () => {
  it('computes Mbit/s from byte deltas', () => {
    const r = nicRate(nic('Ethernet', T0, 1_000_000, 500_000), nic('Ethernet', T0 + 1000, 3_500_000, 625_000));
    expect(r.rxMbps).toBeCloseTo(20, 6); // 2.5 MB/s
    expect(r.txMbps).toBeCloseTo(1, 6);
  });

  it('returns null on counter reset, first tick or too long intervals', () => {
    expect(nicRate(undefined, nic('Ethernet', T0, 1, 1)).rxMbps).toBeNull();
    const reset = nicRate(nic('Ethernet', T0, 5_000_000, 100), nic('Ethernet', T0 + 1000, 1000, 200));
    expect(reset.rxMbps).toBeNull();
    expect(reset.txMbps).toBeCloseTo(0.0008, 6);
    expect(nicRate(nic('Ethernet', T0, 0, 0), nic('Ethernet', T0 + 30_000, 1e9, 1e9)).rxMbps).toBeNull();
  });
});

describe('deriveClientState', () => {
  it('is on the expected interface when IPv4 egress matches (case-insensitive)', () => {
    const s = deriveClientState({
      now: T0 + 500,
      expectedIf: 'ethernet',
      gaming: false,
      preventSleep: true,
      nics: [nic('Ethernet', T0, 0, 0), nic('WLAN', T0, 0, 0, { up: false, mbps: null })],
      rates: [],
      egress: egressEthernet(T0 + 100),
    });
    expect(s).toMatchObject({ expectedIf: 'ethernet', egressV4If: 'Ethernet', onExpected: true, linkUp: true, linkMbps: 1000, preventSleep: true });
  });

  it('detects the WLAN failover while the Ethernet link is down', () => {
    const s = deriveClientState({
      now: T0 + 500,
      expectedIf: 'Ethernet',
      gaming: true,
      preventSleep: true,
      nics: [nic('Ethernet', T0, 0, 0, { up: false, mbps: null }), nic('WLAN', T0, 0, 0)],
      rates: [],
      egress: egressWlan(T0 + 200),
    });
    expect(s.onExpected).toBe(false);
    expect(s.linkUp).toBe(false);
    expect(s.linkMbps).toBeNull();
    expect(s.egressV4Address).toBe('192.168.0.35');
    expect(s.gaming).toBe(true);
  });

  it('is unknown (null) without expected interface, egress or fresh ticks', () => {
    const base = { gaming: false, preventSleep: false, rates: [] };
    expect(deriveClientState({ ...base, now: T0, expectedIf: null, nics: [], egress: egressEthernet(T0) }).onExpected).toBeNull();
    const stale = deriveClientState({ ...base, now: T0 + 10_000, expectedIf: 'Ethernet', nics: [nic('Ethernet', T0, 0, 0)], egress: egressEthernet(T0) });
    expect(stale).toMatchObject({ onExpected: null, egressV4If: null, linkUp: null, linkMbps: null, rxMbps: null });
    const noV4 = deriveClientState({ ...base, now: T0, expectedIf: 'Ethernet', nics: [], egress: { ts: T0, v4Address: null, v6Address: null, v4If: null, v6If: null } });
    expect(noV4.onExpected).toBeNull();
  });

  it('picks the primary NIC: expected → egress → first wired up', () => {
    const eth = nic('Ethernet', T0, 0, 0, { up: false });
    const wlan = nic('WLAN', T0, 0, 0);
    expect(pickPrimaryNic([eth, wlan], 'Ethernet', 'WLAN')?.name).toBe('Ethernet');
    expect(pickPrimaryNic([eth, wlan], null, 'WLAN')?.name).toBe('WLAN');
    expect(pickPrimaryNic([wlan, nic('Ethernet', T0, 0, 0)], null, null)?.name).toBe('Ethernet');
    expect(pickPrimaryNic([eth, wlan], 'LAN-Kabel 2', null)).toBeNull();
  });
});

describe('ClientTracker', () => {
  it('sums own throughput over adapters and ignores stale rates', () => {
    const tr = new ClientTracker();
    tr.onNic(nic('Ethernet', T0, 0, 0));
    tr.onNic(nic('Ethernet', T0 + 1000, 1_250_000, 125_000)); // 10 / 1 Mbit/s
    tr.onNic(nic('WLAN', T0, 0, 0));
    tr.onNic(nic('WLAN', T0 + 1000, 250_000, 0)); // 2 Mbit/s
    tr.onEgress(egressEthernet(T0 + 1000));
    const s = tr.derive({ now: T0 + 1200, expectedIf: 'Ethernet', gaming: false, preventSleep: true });
    expect(s.rxMbps).toBeCloseTo(12, 6);
    expect(s.txMbps).toBeCloseTo(1, 6);
    expect(tr.hasFreshData(T0 + 1200)).toBe(true);
    const later = tr.derive({ now: T0 + 4500, expectedIf: 'Ethernet', gaming: false, preventSleep: true });
    expect(later.rxMbps).toBeNull(); // rates older than 3 s
    expect(later.linkUp).toBe(true); // link tick still fresh (≤ 5 s)
    expect(tr.hasFreshData(T0 + 7000)).toBe(false);
  });

  it('ignores out-of-order ticks', () => {
    const tr = new ClientTracker();
    tr.onNic(nic('Ethernet', T0 + 1000, 100, 100));
    tr.onNic(nic('Ethernet', T0, 0, 0));
    expect(tr.nic('ethernet')?.ts).toBe(T0 + 1000);
    tr.onEgress(egressEthernet(T0 + 1000));
    tr.onEgress(egressWlan(T0));
    expect(tr.latestEgress()?.v4If).toBe('Ethernet');
  });
});

describe('effectivePreventSleep', () => {
  it('is true only while a session runs, it is configured and the pinger agent can do it', () => {
    const agent = { mode: 'agent', preventSleepActive: true };
    expect(effectivePreventSleep(false, true, agent)).toBe(false); // no session
    expect(effectivePreventSleep(true, false, agent)).toBe(false); // disabled in the settings
    expect(effectivePreventSleep(true, true, agent)).toBe(true);
    expect(effectivePreventSleep(true, true, { mode: 'starting', preventSleepActive: null })).toBe(true); // requested, agent starting
    expect(effectivePreventSleep(true, true, { mode: 'agent', preventSleepActive: false })).toBe(false); // SetThreadExecutionState failed
    expect(effectivePreventSleep(true, true, { mode: 'fallback', preventSleepActive: true })).toBe(false); // stale flag, ping.exe runs
    expect(effectivePreventSleep(true, true, null)).toBe(false); // no probes module / no agent
    expect(effectivePreventSleep(true, true, undefined)).toBe(true); // unknown → trust the config
  });
});

describe('OnExpectedTracker', () => {
  it('emits metric values only on change of a known value', () => {
    const t = new OnExpectedTracker();
    expect(t.update(null)).toBeNull();
    expect(t.update(true)).toBe(1);
    expect(t.update(true)).toBeNull();
    expect(t.update(null)).toBeNull();
    expect(t.update(true)).toBeNull();
    expect(t.update(false)).toBe(0);
    t.reset();
    expect(t.update(false)).toBe(0);
  });
});
