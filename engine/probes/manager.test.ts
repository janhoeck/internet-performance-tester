import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdapterInfo, AdapterSnapshot, ClientState, TargetConfig } from '../../src/lib/shared/types';
import { SampleFlag, SampleStatus } from '../../src/lib/shared/types';
import type { EgressTick, NicTick } from '../core/types';
import type { AgentConfig } from './agent-protocol';
import type { ProbeOutcome } from './common';
import type { EgressHooks } from './egress';
import { type DnsClientLike, type EgressLike, type PingerLike, createProbesModule, nicNamesFor, runnerSignature } from './manager';
import type { PingerHooks, PingerInfo } from './pinger';
import { pendingText } from './resolve';
import { staggerOffset } from './runner';
import { type FakeProbeContext, fakeProbeContext, flushPromises, testConfig } from './test-helpers';
import type { DnsProbeResult, DnsQuestionSpec } from './udp-dns';

const T0 = 1_791_550_560_000;

function adapter(name: string, patch: Partial<AdapterInfo> = {}): AdapterInfo {
  return {
    name, description: name, ifIndex: 1, status: 'Up', linkMbps: 1000, mediaType: null, mac: null, driverVersion: null,
    driverDate: null, serviceName: null, isWifi: false, isVirtual: false, mediaConnected: true, addresses: [],
    rxBytes: null, txBytes: null, rxErrors: null, rxDiscards: null, txErrors: null, txDiscards: null, ...patch,
  };
}

const SNAPSHOT: AdapterSnapshot = {
  ts: T0,
  adapters: [
    adapter('Ethernet', { addresses: ['192.168.0.192', 'fe80::374c:2a6a:2786:ee2e%4'] }),
    adapter('WLAN', { isWifi: true, addresses: ['192.168.0.35'] }),
    adapter('CloudflareWARP', { isVirtual: true, addresses: ['172.16.0.2'] }),
  ],
  routes: [],
  advanced: [],
};

describe('nicNamesFor', () => {
  it('reports all physical adapters of the snapshot plus the expected interface', () => {
    expect(nicNamesFor(SNAPSHOT, null)).toEqual(['Ethernet', 'WLAN']);
    expect(nicNamesFor(SNAPSHOT, 'Ethernet 2')).toEqual(['Ethernet', 'Ethernet 2', 'WLAN']);
    expect(nicNamesFor(SNAPSHOT, 'ethernet')).toEqual(['ethernet', 'WLAN']);
  });

  it("defaults to ['Ethernet', 'WLAN'] without snapshot and caps the list", () => {
    expect(nicNamesFor(null, null)).toEqual(['Ethernet', 'WLAN']);
    const many: AdapterSnapshot = { ...SNAPSHOT, adapters: Array.from({ length: 12 }, (_, i) => adapter(`LAN ${String(i).padStart(2, '0')}`)) };
    expect(nicNamesFor(many, null)).toHaveLength(8);
  });
});

describe('runnerSignature', () => {
  const t: TargetConfig = {
    id: 'cf4-udp', name: 'x', host: '1.1.1.1', family: 4, kind: 'udp-dns', port: 53, query: 'id.server', segment: 'internet',
    intervalMs: 5000, timeoutMs: 2000, enabled: true, builtin: true,
  };
  it('changes with probe parameters, not with display fields', () => {
    expect(runnerSignature({ ...t, name: 'y', color: '#fff', description: 'z' })).toBe(runnerSignature(t));
    for (const patch of [{ host: '1.0.0.1' }, { port: 5353 }, { query: 'cloudflare.com' }, { intervalMs: 10_000 }, { timeoutMs: 1000 }, { family: 6 as const }]) {
      expect(runnerSignature({ ...t, ...patch })).not.toBe(runnerSignature(t));
    }
  });
});

// ─── module with fake dependencies ─────────────────────────────────────────

class FakePinger implements PingerLike {
  started: AgentConfig | null = null;
  updates: AgentConfig[] = [];
  stopped = false;
  active: string[] = [];
  lastError: string | null = null;
  constructor(readonly hooks: PingerHooks) {}
  start(cfg: AgentConfig): void {
    this.started = cfg;
  }
  update(cfg: AgentConfig): void {
    this.updates.push(cfg);
  }
  stop(): void {
    this.stopped = true;
  }
  info(): PingerInfo {
    return { mode: 'agent', pid: 1, startedAt: T0, lastHeartbeatTs: T0, restarts: 0, failedStarts: 0, preventSleepActive: true, lastError: this.lastError };
  }
  activeTargetIds(): string[] {
    return this.active;
  }
  current(): AgentConfig | null {
    return this.updates[this.updates.length - 1] ?? this.started;
  }
}

class FakeDns implements DnsClientLike {
  closed = false;
  queries = 0;
  constructor(readonly server: string, readonly q: DnsQuestionSpec, private readonly results: () => DnsProbeResult) {}
  async query(): Promise<DnsProbeResult> {
    this.queries++;
    return this.results();
  }
  close(): void {
    this.closed = true;
  }
}

function targets(): TargetConfig[] {
  const base = { segment: 'internet' as const, enabled: true, builtin: false, intervalMs: 1000, timeoutMs: 2000 };
  return [
    { ...base, id: 'gw', name: 'Router', host: '$gateway', family: 4, kind: 'icmp', segment: 'lan' },
    { ...base, id: 'gw6', name: 'Router v6', host: '$router6', family: 6, kind: 'icmp', segment: 'lan' },
    { ...base, id: 'isp6', name: 'CMTS', host: '$isp6', family: 6, kind: 'icmp', segment: 'docsis' },
    { ...base, id: 'cf4', name: 'CF', host: '1.1.1.1', family: 4, kind: 'icmp' },
    { ...base, id: 'slow', name: 'Slow', host: '9.9.9.9', family: 4, kind: 'icmp', intervalMs: 5000, timeoutMs: 3000 },
    { ...base, id: 'game', name: 'Game', host: 'game.example', family: 4, kind: 'icmp', segment: 'game' },
    { ...base, id: 'off', name: 'Off', host: '8.8.8.8', family: 4, kind: 'icmp', enabled: false },
    { ...base, id: 'gw-tcp', name: 'Router TCP', host: '$gateway', family: 4, kind: 'tcp', port: 80, intervalMs: 10_000, segment: 'router' },
    { ...base, id: 'cf4-udp', name: 'CF UDP', host: '1.1.1.1', family: 4, kind: 'udp-dns', port: 53, query: 'id.server', intervalMs: 5000 },
    { ...base, id: 'web', name: 'Web', host: 'example.com', family: 4, kind: 'http', port: 443, path: '/x', intervalMs: 10_000 },
  ];
}

interface Harness {
  fake: FakeProbeContext;
  mod: ReturnType<typeof createProbesModule>;
  pingers: FakePinger[];
  egress: { hooks: EgressHooks; started: number; stopped: number }[];
  dns: FakeDns[];
  tcp: ReturnType<typeof vi.fn<(ip: string, port: number, timeoutMs: number) => Promise<ProbeOutcome>>>;
  http: ReturnType<typeof vi.fn<(url: string, timeoutMs: number) => Promise<ProbeOutcome>>>;
  resolveAll: ReturnType<typeof vi.fn<(host: string, family: 4 | 6) => Promise<string[]>>>;
  dnsResults: DnsProbeResult[];
}

function harness(): Harness {
  const fake = fakeProbeContext({ config: testConfig((c) => (c.targets = targets())) });
  fake.setAdaptersSnapshot(SNAPSHOT);
  const pingers: FakePinger[] = [];
  const egress: Harness['egress'] = [];
  const dns: FakeDns[] = [];
  const dnsResults: DnsProbeResult[] = [];
  const tcp = vi.fn(async (): Promise<ProbeOutcome> => ({ status: SampleStatus.OK, rtt: 1.5 }));
  const http = vi.fn(async (): Promise<ProbeOutcome> => ({ status: SampleStatus.OK, rtt: 40 }));
  const resolveAll = vi.fn(async (host: string, family: 4 | 6): Promise<string[]> =>
    host === 'game.example' && family === 4 ? ['203.0.113.7'] : ['93.184.216.34'],
  );
  const mod = createProbesModule({
    createPinger: (hooks) => {
      const p = new FakePinger(hooks);
      pingers.push(p);
      return p;
    },
    createEgress: (hooks): EgressLike => {
      const e = { hooks, started: 0, stopped: 0 };
      egress.push(e);
      return { start: () => void e.started++, stop: () => void e.stopped++ };
    },
    tcpProbe: tcp,
    httpProbe: http,
    createDnsClient: (server, _port, _family, q) => {
      const d = new FakeDns(server, q, () => dnsResults.shift() ?? { status: SampleStatus.TIMEOUT, rtt: null, rcode: null, txt: [], first: false });
      dns.push(d);
      return d;
    },
    hostCache: {
      resolveAll,
      resolve: async (host: string, family: 4 | 6) => (await resolveAll(host, family))[0],
      peek: () => null,
    },
    liveInterfaces: () => ({}),
  });
  mod.init?.(fake.ctx);
  return { fake, mod, pingers, egress, dns, tcp, http, resolveAll, dnsResults };
}

function client(onExpected: boolean | null): ClientState {
  return {
    ts: T0, expectedIf: 'Ethernet', egressV4If: onExpected === false ? 'WLAN' : 'Ethernet', egressV6If: null, egressV4Address: null,
    egressV6Address: null, onExpected, linkUp: true, linkMbps: 1000, rxMbps: null, txMbps: null, gaming: false, preventSleep: true,
  };
}

describe('probes module (manager)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: T0 + 400 });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts ONE pinger for all resolvable icmp targets with NICs, preventSleep and per-target interval/timeout', async () => {
    const h = harness();
    h.fake.setExpectedIf('Ethernet');
    h.mod.start?.();
    expect(h.pingers).toHaveLength(1);
    const cfg = h.pingers[0].started;
    expect(cfg?.targets).toEqual([
      { id: 'gw', ip: '192.168.0.1' },
      { id: 'cf4', ip: '1.1.1.1' },
      { id: 'slow', ip: '9.9.9.9', every: 5, to: 3000 },
    ]);
    expect(cfg).toMatchObject({ intervalMs: 1000, timeoutMs: 2000, size: 32, nics: ['Ethernet', 'WLAN'], preventSleep: true, ppid: process.pid });
    expect(h.egress[0].started).toBe(1);
    // the hostname target joins once DNS answered
    await flushPromises();
    expect(h.resolveAll).toHaveBeenCalledWith('game.example', 4);
    expect(h.pingers[0].current()?.targets.map((t) => t.id)).toEqual(['gw', 'cf4', 'slow', 'game']);
    expect(h.pingers[0].current()?.targets[3]).toEqual({ id: 'game', ip: '203.0.113.7' });
    h.mod.stop?.();
  });

  it('keeps targets with unknown dynamic hosts idle until the host registry learns them', () => {
    const h = harness();
    h.mod.start?.();
    h.pingers[0].active = ['gw', 'cf4', 'slow'];
    const st = () => Object.fromEntries((h.mod.probeStates() ?? []).map((s) => [s.targetId, s]));
    expect(st().gw6).toMatchObject({ resolvedHost: null, running: false, error: pendingText('$router6') });
    expect(st().isp6).toMatchObject({ resolvedHost: null, running: false, error: pendingText('$isp6') });
    expect(st().gw).toMatchObject({ resolvedHost: '192.168.0.1', running: true, error: null });
    expect(st().off).toBeUndefined();
    h.fake.ctx.hosts.set({ router6: 'fe80::de73:6ff:fe12:34df%4', isp6: '2a02:8101:3ff:ff89::3' }, 'test');
    const cfg = h.pingers[0].current();
    expect(cfg?.targets.find((t) => t.id === 'gw6')).toEqual({ id: 'gw6', ip: 'fe80::de73:6ff:fe12:34df%4' });
    expect(cfg?.targets.find((t) => t.id === 'isp6')).toEqual({ id: 'isp6', ip: '2a02:8101:3ff:ff89::3' });
    expect(st().gw6).toMatchObject({ resolvedHost: 'fe80::de73:6ff:fe12:34df%4', error: null });
    h.mod.stop?.();
  });

  it('records echoes with LOAD / FAILOVER / LATE flags and drops duplicates', () => {
    const h = harness();
    h.mod.start?.();
    const hooks = h.pingers[0].hooks;
    hooks.onEcho({ targetId: 'cf4', ts: T0, status: SampleStatus.OK, rtt: 18 });
    hooks.onEcho({ targetId: 'cf4', ts: T0, status: SampleStatus.OK, rtt: 18 }); // duplicate (fallback ⇄ agent)
    hooks.onEcho({ targetId: 'cf4', ts: T0 + 1000, status: SampleStatus.OK, rtt: 1234 });
    h.fake.setSpeedtest(true);
    hooks.onEcho({ targetId: 'gw', ts: T0, status: SampleStatus.OK, rtt: 0.5 });
    h.fake.setSpeedtest(false);
    h.fake.setClient(client(false));
    hooks.onEcho({ targetId: 'gw', ts: T0 + 1000, status: SampleStatus.TIMEOUT, rtt: null });
    h.fake.setClient(client(true));
    hooks.onEcho({ targetId: 'gw', ts: T0 + 2000, status: SampleStatus.UNREACHABLE, rtt: null });
    hooks.onEcho({ targetId: 'off', ts: T0, status: SampleStatus.OK, rtt: 5 }); // disabled target
    hooks.onEcho({ targetId: 'nope', ts: T0, status: SampleStatus.OK, rtt: 5 }); // unknown target
    hooks.onEcho({ targetId: 'gw-tcp', ts: T0, status: SampleStatus.OK, rtt: 5 }); // not an icmp target
    expect(h.fake.samples).toEqual([
      { ts: T0, targetId: 'cf4', rtt: 18, status: SampleStatus.OK, flags: 0 },
      { ts: T0 + 1000, targetId: 'cf4', rtt: 1234, status: SampleStatus.OK, flags: SampleFlag.LATE },
      { ts: T0, targetId: 'gw', rtt: 0.5, status: SampleStatus.OK, flags: SampleFlag.LOAD },
      { ts: T0 + 1000, targetId: 'gw', rtt: null, status: SampleStatus.TIMEOUT, flags: SampleFlag.FAILOVER },
      { ts: T0 + 2000, targetId: 'gw', rtt: null, status: SampleStatus.UNREACHABLE, flags: 0 },
    ]);
    const gw = h.mod.probeStates().find((s) => s.targetId === 'gw');
    expect(gw).toMatchObject({ lastTs: T0 + 2000, lastRtt: null, lastStatus: SampleStatus.UNREACHABLE });
    expect(h.mod.state()).toMatchObject({ name: 'probes', running: true, lastRunTs: T0 + 2000 });
    h.mod.stop?.();
  });

  it('marks local ARP failures via own addresses (snapshot + live interfaces)', () => {
    const h = harness();
    h.mod.start?.();
    const hooks = h.pingers[0].hooks;
    expect(hooks.isOwnAddress('192.168.0.192')).toBe(true);
    expect(hooks.isOwnAddress('fe80:0000:0000:0000:374c:2a6a:2786:ee2e')).toBe(true);
    expect(hooks.isOwnAddress('192.168.0.1')).toBe(false);
    expect(hooks.ownAddresses()).toContain('192.168.0.35');
    h.mod.stop?.();
  });

  it("publishes the agent's NIC ticks and the egress ticks on the bus while running", () => {
    const h = harness();
    h.mod.start?.();
    const nic: NicTick = { ts: T0, name: 'Ethernet', up: true, mbps: 1000, rxBytes: 1, txBytes: 2, rxErrors: 0, rxDiscards: 0, isWifi: false };
    const eg: EgressTick = { ts: T0, v4Address: '192.168.0.35', v6Address: null, v4If: 'WLAN', v6If: null };
    h.pingers[0].hooks.onNic(nic);
    h.egress[0].hooks.onTick(eg);
    expect(h.fake.bus.payloads('nic')).toEqual([nic]);
    expect(h.fake.bus.payloads('egress')).toEqual([eg]);
    expect(h.egress[0].hooks.adapters()?.map((a) => a.name)).toEqual(['Ethernet', 'WLAN', 'CloudflareWARP']);
    h.mod.stop?.();
    h.pingers[0].hooks.onNic(nic);
    h.egress[0].hooks.onTick(eg);
    expect(h.fake.bus.payloads('nic')).toHaveLength(1);
    expect(h.fake.bus.payloads('egress')).toHaveLength(1);
    expect(h.egress[0].stopped).toBe(1);
    expect(h.pingers[0].stopped).toBe(true);
  });

  it('runs TCP / HTTP probes on their grid and records the scheduled timestamp', async () => {
    const h = harness();
    h.mod.start?.();
    await vi.advanceTimersByTimeAsync(10_000);
    await flushPromises();
    expect(h.tcp).toHaveBeenCalledWith('192.168.0.1', 80, 2000);
    expect(h.http).toHaveBeenCalledWith('https://example.com/x', 2000);
    const tcpSample = h.fake.samples.find((s) => s.targetId === 'gw-tcp');
    expect(tcpSample).toMatchObject({ rtt: 1.5, status: SampleStatus.OK, flags: 0 });
    expect(((tcpSample?.ts ?? 0) - staggerOffset('gw-tcp', 10_000)) % 10_000).toBe(0);
    expect(h.mod.probeStates().find((s) => s.targetId === 'gw-tcp')).toMatchObject({ running: true, resolvedHost: '192.168.0.1' });
    h.mod.stop?.();
  });

  it('does not record a discarded probe (late TCP refusal) but shows the hint', async () => {
    const h = harness();
    h.tcp.mockResolvedValue({ status: SampleStatus.ERROR, rtt: null, discard: true, error: 'Port geschlossen' });
    h.mod.start?.();
    await vi.advanceTimersByTimeAsync(10_000);
    await flushPromises();
    expect(h.tcp).toHaveBeenCalled();
    expect(h.fake.samples.filter((s) => s.targetId === 'gw-tcp')).toHaveLength(0);
    expect(h.mod.probeStates().find((s) => s.targetId === 'gw-tcp')?.error).toBe('Port geschlossen');
    h.mod.stop?.();
  });

  it('UDP-DNS: drops the first answer, keeps the PoP name, records the rest', async () => {
    const h = harness();
    h.dnsResults.push(
      { status: SampleStatus.OK, rtt: 30, rcode: 0, txt: ['dus01'], first: true, error: null },
      { status: SampleStatus.OK, rtt: 21.5, rcode: 0, txt: ['dus01'], first: false, error: null },
      { status: SampleStatus.TIMEOUT, rtt: null, rcode: null, txt: [], first: false },
    );
    h.mod.start?.();
    await vi.advanceTimersByTimeAsync(15_000);
    await flushPromises();
    expect(h.dns).toHaveLength(1);
    expect(h.dns[0].server).toBe('1.1.1.1');
    expect(h.dns[0].q).toEqual({ name: 'id.server', type: 16, cls: 3 });
    const udp = h.fake.samples.filter((s) => s.targetId === 'cf4-udp');
    expect(udp.map((s) => [s.status, s.rtt])).toEqual([[SampleStatus.OK, 21.5], [SampleStatus.TIMEOUT, null]]);
    expect(h.mod.popNames()).toEqual({ 'cf4-udp': 'dus01' });
    h.mod.stop?.();
    expect(h.dns[0].closed).toBe(true);
  });

  it('reconfigure: stops removed runners, restarts changed ones, updates the pinger', async () => {
    const h = harness();
    h.mod.start?.();
    await vi.advanceTimersByTimeAsync(10_000);
    await flushPromises();
    const callsBefore = h.tcp.mock.calls.length;
    const cfg = testConfig((c) => {
      c.targets = targets().map((t) => {
        if (t.id === 'gw-tcp') return { ...t, enabled: false };
        if (t.id === 'cf4-udp') return { ...t, timeoutMs: 1500 };
        if (t.id === 'cf4') return { ...t, host: '1.0.0.1' };
        return t;
      });
    });
    h.fake.setConfig(cfg);
    h.mod.reconfigure?.(cfg);
    expect(h.dns[0].closed).toBe(true);
    expect(h.pingers[0].current()?.targets.find((t) => t.id === 'cf4')?.ip).toBe('1.0.0.1');
    await vi.advanceTimersByTimeAsync(20_000);
    await flushPromises();
    expect(h.tcp.mock.calls.length).toBe(callsBefore);
    expect(h.dns.length).toBe(2);
    expect(h.mod.probeStates().some((s) => s.targetId === 'gw-tcp')).toBe(false);
    h.mod.stop?.();
  });

  it('follows adapter snapshots (NIC list) and reports the pinger error as module error', () => {
    const h = harness();
    h.mod.start?.();
    h.fake.bus.emit('adapters', { ...SNAPSHOT, adapters: [...SNAPSHOT.adapters, adapter('Ethernet 2')] });
    expect(h.pingers[0].current()?.nics).toEqual(['Ethernet', 'Ethernet 2', 'WLAN']);
    h.pingers[0].lastError = 'Ping-Agent reagiert nicht';
    expect(h.mod.state().lastError).toBe('Ping-Agent reagiert nicht');
    expect(h.mod.pingerInfo()?.mode).toBe('agent');
    h.mod.stop?.();
    expect(h.mod.pingerInfo()).toBeNull();
    expect(h.mod.probeStates().every((s) => !s.running)).toBe(true);
    expect(h.mod.state().running).toBe(false);
  });

  it('stop() ends all activity; dispose() unsubscribes from the bus', async () => {
    const h = harness();
    h.mod.start?.();
    h.mod.stop?.();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.tcp).not.toHaveBeenCalled();
    expect(h.http).not.toHaveBeenCalled();
    h.mod.dispose?.();
    expect(h.fake.bus.listeners('dynamicHosts')).toBe(0);
    expect(h.fake.bus.listeners('adapters')).toBe(0);
    // a second session creates a fresh pinger
    h.mod.init?.(h.fake.ctx);
    h.mod.start?.();
    expect(h.pingers).toHaveLength(2);
    h.mod.stop?.();
  });
});
