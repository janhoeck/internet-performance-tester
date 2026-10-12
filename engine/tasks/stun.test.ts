import dgram from 'node:dgram';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/lib/shared/config';
import type { StunProbeOutcome } from '../../src/lib/shared/stun';
import type { DynamicHosts, NatResult, NetEvent, Snapshot, SnapshotKind } from '../../src/lib/shared/types';
import type { Bus, BusEvents, DynamicHostRegistry, EngineContext, EngineDb, Logger } from '../core/types';
import {
  buildDnsExit,
  buildNatResult,
  createStunModule,
  emptyNatMemory,
  natEvents,
  natResultsFromSnapshot,
  queryMyAddr,
  routerHintsFrom,
  stunRound,
  updateNatMemory,
  type MyAddrAnswer,
  type NatSnapshot,
  type StunRound,
} from './stun';

const ep4 = (address: string, port: number) => ({ family: 4 as const, address, port });
const ep6 = (address: string, port: number) => ({ family: 6 as const, address, port });
const outcome = (server: string, serverIp: string | null, mapped: StunProbeOutcome['mapped'], error: string | null = null): StunProbeOutcome => ({
  server, serverIp, mapped, rttMs: mapped ? 30 : null, error,
});

// values observed live on this machine (2026-10-09)
const LIVE_V4: StunRound = {
  family: 4,
  local: ep4('192.168.0.192', 62266),
  outcomes: [
    outcome('stun.l.google.com:19302', '74.125.250.129', ep4('92.208.29.229', 19708)),
    outcome('stun.cloudflare.com:3478', '162.159.207.0', ep4('92.208.29.229', 19708)),
  ],
};
const V6_ADDR = '3fff:8071:7ca0:c980:7df5:ffbf:6014:ea67';
const LIVE_V6: StunRound = {
  family: 6,
  local: ep6(V6_ADDR, 62268),
  outcomes: [
    outcome('stun.l.google.com:19302', '2001:4860:4864:5:8000::1', ep6(V6_ADDR, 62268)),
    outcome('stun.cloudflare.com:3478', '2606:4700:49::', ep6(V6_ADDR, 62268)),
  ],
};

describe('NAT results', () => {
  it('builds the IPv4 result: EIM behind DS-Lite CGNAT', () => {
    const r = buildNatResult(LIVE_V4, 1, { dsLite: true, wanIpv4: '0.0.0.0' });
    expect(r).toEqual({
      ts: 1,
      family: 4,
      localAddress: '192.168.0.192:62266',
      publicIp: '92.208.29.229',
      mappings: [
        { server: 'stun.l.google.com:19302', mapped: '92.208.29.229:19708', rttMs: 30, error: null },
        { server: 'stun.cloudflare.com:3478', mapped: '92.208.29.229:19708', rttMs: 30, error: null },
      ],
      mapping: 'endpoint-independent',
      cgnat: true,
    });
    expect(buildNatResult(LIVE_V4, 1, null).cgnat).toBeNull(); // router state unknown
    expect(buildNatResult(LIVE_V4, 1, { dsLite: false, wanIpv4: '92.208.29.229' }).cgnat).toBe(false);
  });

  it('builds the IPv6 result: mapped = local → no NAT66', () => {
    const r = buildNatResult(LIVE_V6, 2, null);
    expect(r).toMatchObject({ family: 6, localAddress: `[${V6_ADDR}]:62268`, publicIp: V6_ADDR, mapping: 'endpoint-independent', cgnat: false });
    expect(r.mappings[0].mapped).toBe(`[${V6_ADDR}]:62268`);
  });

  it('marks blocked / failed rounds without inventing values', () => {
    const blocked = buildNatResult({ family: 4, local: null, outcomes: [outcome('a', '1.2.3.4', null, 'timeout'), outcome('b', '5.6.7.8', null, 'timeout')] }, 3, null);
    expect(blocked).toMatchObject({ publicIp: null, mapping: 'blocked', cgnat: null, localAddress: null });
    const dns = buildNatResult({ family: 6, local: null, outcomes: [outcome('a', null, null, 'dns')] }, 3, null);
    expect(dns).toMatchObject({ mapping: 'unknown', cgnat: null });
  });

  it('reads router hints tolerantly', () => {
    expect(routerHintsFrom({ ts: 1, dsLite: true, wanIpv4: '0.0.0.0', model: 'TG6442' })).toEqual({ dsLite: true, wanIpv4: '0.0.0.0' });
    expect(routerHintsFrom({ dsLite: null, wanIpv4: ' ' })).toBeNull();
    expect(routerHintsFrom('nope')).toBeNull();
  });

  it('cross-checks the STUN address with the ECS subnet of o-o.myaddr.l.google.com', () => {
    const answer: MyAddrAnswer = { txt: ['172.217.34.28', 'edns0-client-subnet 92.208.29.0/24'], rttMs: 48, error: null };
    expect(buildDnsExit(answer, '92.208.29.229')).toEqual({
      server: '8.8.8.8', name: 'o-o.myaddr.l.google.com', clientSubnet: '92.208.29.0/24', resolverIp: '172.217.34.28', rttMs: 48, error: null, consistent: true,
    });
    expect(buildDnsExit(answer, '92.208.30.1').consistent).toBe(false);
    expect(buildDnsExit(answer, null).consistent).toBeNull();
    expect(buildDnsExit({ txt: null, rttMs: null, error: 'timeout' }, '92.208.29.229')).toMatchObject({ clientSubnet: null, consistent: null, error: 'timeout' });
  });
});

describe('NAT events', () => {
  const v4 = (publicIp: string | null, mapping: NatResult['mapping'] = 'endpoint-independent', cgnat: boolean | null = true): NatResult => ({
    ts: 10, family: 4, localAddress: '192.168.0.192:1', publicIp, mappings: [], mapping, cgnat,
  });

  it('reports a changed public IPv4 (new AFTR binding)', () => {
    const mem = updateNatMemory(emptyNatMemory(), v4('92.208.29.229'));
    const evs = natEvents(mem, v4('92.208.30.17'), 'schedule');
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({
      type: 'ip_change', severity: 'warn', segment: 'aftr', source: 'stun',
      title: 'Öffentliche IPv4-Adresse geändert: 92.208.29.229 → 92.208.30.17', dedupeKey: 'ip_change:stun4:10',
    });
    expect(natEvents(mem, v4('92.208.30.17', 'endpoint-independent', false), 'egress')[0]).toMatchObject({ segment: 'isp' });
    // failed round: no event, memory keeps the last known address
    expect(natEvents(mem, v4(null, 'blocked', null), 'schedule')).toEqual([]);
    expect(updateNatMemory(mem, v4(null, 'blocked', null))).toEqual(mem);
    expect(natEvents(emptyNatMemory(), v4('92.208.29.229'), 'schedule')).toEqual([]);
  });

  it('reports mapping changes between definitive classifications and CGNAT / NAT66 flips', () => {
    const mem = updateNatMemory(emptyNatMemory(), v4('92.208.29.229'));
    const edm = natEvents(mem, v4('92.208.29.229', 'endpoint-dependent'), 'manual');
    expect(edm).toEqual([
      expect.objectContaining({
        type: 'nat_change', severity: 'warn',
        title: 'NAT-Verhalten IPv4 geändert: endpunktunabhängig (günstig für Spiele) → endpunktabhängig (strikter NAT)',
      }),
    ]);
    expect(natEvents(mem, v4('92.208.29.229', 'unknown'), 'manual')).toEqual([]);
    expect(natEvents(mem, v4('92.208.29.229', 'endpoint-independent', false), 'manual')[0]).toMatchObject({
      type: 'nat_change', severity: 'info', title: 'IPv4 nicht mehr hinter Carrier-NAT (öffentliche IPv4-Adresse)',
    });
    const v6mem = updateNatMemory(emptyNatMemory(), buildNatResult(LIVE_V6, 1, null));
    const nat66: NatResult = { ...buildNatResult(LIVE_V6, 2, null), cgnat: true };
    expect(natEvents(v6mem, nat66, 'schedule').map((e) => e.title)).toEqual(['IPv6 wird jetzt übersetzt (NAT66)']);
  });

  it('reads NAT snapshots tolerantly', () => {
    expect(natResultsFromSnapshot({ results: [v4('1.2.3.4')], dns: null, trigger: 'manual' })).toHaveLength(1);
    expect(natResultsFromSnapshot([v4('1.2.3.4'), { family: 6 }])).toHaveLength(1);
    expect(natResultsFromSnapshot(null)).toEqual([]);
  });
});

// ─── real sockets against local fake servers ───────────────────────────────

function xorMappedResponse(req: Buffer, address: string, port: number): Buffer {
  const res = Buffer.alloc(32);
  res.writeUInt16BE(0x0101, 0);
  res.writeUInt16BE(12, 2);
  res.writeUInt32BE(0x2112a442, 4);
  req.copy(res, 8, 8, 20);
  res.writeUInt16BE(0x0020, 20);
  res.writeUInt16BE(8, 22);
  res[25] = 0x01;
  res.writeUInt16BE(port ^ 0x2112, 26);
  const cookie = [0x21, 0x12, 0xa4, 0x42];
  address.split('.').forEach((p, i) => (res[28 + i] = Number(p) ^ cookie[i]));
  return res;
}

interface FakeServer {
  port: number;
  requests: number;
  close(): void;
}

function fakeStunServer(ip: string, opts: { silent?: boolean; portShift?: number } = {}): Promise<FakeServer> {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    const server: FakeServer = { port: 0, requests: 0, close: () => sock.close() };
    sock.on('message', (msg, rinfo) => {
      if (msg.length < 20 || msg.readUInt16BE(0) !== 0x0001) return;
      server.requests++;
      if (!opts.silent) sock.send(xorMappedResponse(msg, rinfo.address, rinfo.port + (opts.portShift ?? 0)), rinfo.port, rinfo.address);
    });
    sock.bind(0, ip, () => {
      server.port = sock.address().port;
      resolve(server);
    });
  });
}

describe('stunRound (local fake servers)', () => {
  it('sends from ONE socket to two server IPs and classifies endpoint-independent mapping', async () => {
    const a = await fakeStunServer('127.0.0.1');
    const b = await fakeStunServer('127.0.0.2');
    try {
      const round = await stunRound(4, {
        servers: [{ label: 'a', host: '127.0.0.1', port: a.port }, { label: 'b', host: '127.0.0.2', port: b.port }],
        deadlineMs: 1500,
      });
      expect(round.local).toMatchObject({ family: 4, address: '127.0.0.1' });
      const port = round.local?.port;
      expect(round.outcomes.map((o) => [o.server, o.mapped?.port, o.error])).toEqual([['a', port, null], ['b', port, null]]);
      expect(a.requests).toBe(1);
      const nat = buildNatResult(round, 1, null);
      expect(nat).toMatchObject({ mapping: 'endpoint-independent', publicIp: '127.0.0.1', localAddress: `127.0.0.1:${port}` });
    } finally {
      a.close();
      b.close();
    }
  });

  it('detects endpoint-dependent mapping, timeouts with retransmissions and DNS failures', async () => {
    const a = await fakeStunServer('127.0.0.1');
    const shifted = await fakeStunServer('127.0.0.2', { portShift: 1 });
    const silent = await fakeStunServer('127.0.0.2', { silent: true });
    try {
      const edm = await stunRound(4, {
        servers: [{ label: 'a', host: '127.0.0.1', port: a.port }, { label: 'b', host: '127.0.0.2', port: shifted.port }],
        deadlineMs: 1500,
      });
      expect(buildNatResult(edm, 1, null).mapping).toBe('endpoint-dependent');
      const t0 = performance.now();
      const lost = await stunRound(4, {
        servers: [{ label: 'a', host: '127.0.0.1', port: a.port }, { label: 'quiet', host: '127.0.0.2', port: silent.port }],
        deadlineMs: 300,
        sendAtMs: [0, 100, 200],
      });
      expect(performance.now() - t0).toBeLessThan(1500);
      expect(lost.outcomes.map((o) => o.error)).toEqual([null, 'timeout']);
      expect(silent.requests).toBe(3); // retransmitted
      expect(buildNatResult(lost, 1, null).mapping).toBe('unknown');
      const noDns = await stunRound(4, { servers: [{ label: 'x', host: 'stun.invalid', port: 3478 }], resolve: () => Promise.resolve(null) });
      expect(noDns).toEqual({ family: 4, local: null, outcomes: [{ server: 'x', serverIp: null, mapped: null, rttMs: null, error: 'dns' }] });
    } finally {
      a.close();
      shifted.close();
      silent.close();
    }
  });
});

describe('queryMyAddr (local fake resolver)', () => {
  // real answer of 8.8.8.8 captured on this machine (id 0x1234)
  const RESPONSE = Buffer.from(
    '123481800001000200000000036f2d6f066d7961646472016c06676f6f676c6503636f6d0000100001c00c001000010000003c00232265646e73302d636c69656e742d7375626e65742039322e3230382e32392e302f3234c00c001000010000003c00100f3137322e3235332e3233372e313531',
    'hex',
  );

  it('sends a TXT query and validates id + question of the answer', async () => {
    const sock = dgram.createSocket('udp4');
    let queries = 0;
    sock.on('message', (msg, rinfo) => {
      queries++;
      const foreign = Buffer.from(RESPONSE);
      foreign.writeUInt16BE((msg.readUInt16BE(0) + 1) & 0xffff, 0); // wrong id → ignored
      sock.send(foreign, rinfo.port, rinfo.address);
      const answer = Buffer.from(RESPONSE);
      msg.copy(answer, 0, 0, 2);
      sock.send(answer, rinfo.port, rinfo.address);
    });
    await new Promise<void>((r) => sock.bind(0, '127.0.0.1', () => r()));
    try {
      const res = await queryMyAddr({ resolver: '127.0.0.1', port: sock.address().port, timeoutMs: 1500 });
      expect(res.error).toBeNull();
      expect(res.txt).toEqual(['edns0-client-subnet 92.208.29.0/24', '172.253.237.151']);
      expect(queries).toBe(1);
      expect(buildDnsExit(res, '92.208.29.229')).toMatchObject({ clientSubnet: '92.208.29.0/24', resolverIp: '172.253.237.151', consistent: true });
    } finally {
      sock.close();
    }
  });

  it('times out after two tries when nobody answers', async () => {
    const sock = dgram.createSocket('udp4');
    let queries = 0;
    sock.on('message', () => queries++);
    await new Promise<void>((r) => sock.bind(0, '127.0.0.1', () => r()));
    try {
      expect(await queryMyAddr({ resolver: '127.0.0.1', port: sock.address().port, timeoutMs: 200 })).toEqual({ txt: null, rttMs: null, error: 'timeout' });
      expect(queries).toBe(2);
    } finally {
      sock.close();
    }
  });
});

// ─── module ────────────────────────────────────────────────────────────────

function fakeCtx(previous: NatSnapshot | null = null) {
  const snapshots: { kind: SnapshotKind; data: unknown }[] = [];
  const events: NetEvent[] = [];
  const handlers = new Map<keyof BusEvents, Set<(p: unknown) => void>>();
  const bus: Bus = {
    on(type, fn) {
      const set = handlers.get(type) ?? new Set();
      handlers.set(type, set);
      const h = fn as unknown as (p: unknown) => void;
      set.add(h);
      return () => set.delete(h);
    },
    emit(type, payload) {
      for (const h of handlers.get(type) ?? []) h(payload);
    },
  };
  const hosts: DynamicHosts = { gateway: '192.168.0.1', isp4: null, isp6: null, aftr: null, router6: null };
  const registry: DynamicHostRegistry = { get: () => ({ ...hosts }), set: () => undefined, resolve: (h) => h };
  const log: Logger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined, child: () => log };
  const db = {
    latestSnapshot: <T>(kind: SnapshotKind): Snapshot<T> | null =>
      kind === 'nat' && previous ? ({ ts: 5, kind, data: previous } as Snapshot<unknown> as Snapshot<T>) : null,
  } as Partial<EngineDb> as EngineDb;
  const ctx = {
    log,
    bus,
    db,
    hosts: registry,
    config: () => DEFAULT_CONFIG,
    recordSnapshot: (kind: SnapshotKind, data: unknown) => {
      snapshots.push({ kind, data });
    },
    recordEvent: (e: NetEvent) => {
      events.push(e);
      return events.length;
    },
  } as Partial<EngineContext> as EngineContext;
  return { ctx, snapshots, events, bus, hosts };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('stun module', () => {
  const myAddr = (): Promise<MyAddrAnswer> => Promise.resolve({ txt: ['172.217.34.28', 'edns0-client-subnet 92.208.29.0/24'], rttMs: 40, error: null });

  it('stores one snapshot per check and raises ip_change when the CGNAT exit changes', async () => {
    const f = fakeCtx({ results: [buildNatResult(LIVE_V4, 1, null)], dns: null, trigger: 'schedule' });
    let publicIp = '92.208.29.229';
    const mod = createStunModule({
      round: (family) =>
        Promise.resolve(family === 4
          ? { ...LIVE_V4, outcomes: LIVE_V4.outcomes.map((o) => ({ ...o, mapped: ep4(publicIp, 19708) })) }
          : LIVE_V6),
      myAddr,
    });
    mod.init?.(f.ctx);
    expect(mod.state().lastRunTs).toBe(5);
    f.bus.emit('router', { dsLite: true, wanIpv4: '0.0.0.0' } as BusEvents['router']);
    const first = await mod.runNow?.();
    expect(first).toMatchObject({ ok: true });
    expect(f.snapshots).toHaveLength(1);
    const snap = f.snapshots[0].data as NatSnapshot;
    expect(snap.trigger).toBe('manual');
    expect(snap.results.map((r) => [r.family, r.publicIp, r.mapping, r.cgnat])).toEqual([
      [4, '92.208.29.229', 'endpoint-independent', true],
      [6, V6_ADDR, 'endpoint-independent', false],
    ]);
    expect(snap.dns).toMatchObject({ clientSubnet: '92.208.29.0/24', consistent: true });
    expect(f.events).toEqual([]);
    publicIp = '92.208.31.4';
    await mod.runNow?.();
    expect(f.events.map((e) => e.title)).toEqual(['Öffentliche IPv4-Adresse geändert: 92.208.29.229 → 92.208.31.4']);
    expect((f.snapshots[1].data as NatSnapshot).dns?.consistent).toBe(false);
  });

  it('infers DS-Lite from a known AFTR when the router reports nothing', async () => {
    const f = fakeCtx();
    f.hosts.aftr = '2a00:0:cff:84a0::3';
    const mod = createStunModule({ round: (family) => Promise.resolve(family === 4 ? LIVE_V4 : LIVE_V6), myAddr });
    mod.init?.(f.ctx);
    const res = await mod.runNow?.();
    expect((res as { result: NatSnapshot }).result.results[0].cgnat).toBe(true);
  });

  it('runs once 30 s (here: 40 ms) after the egress interface settled', async () => {
    const f = fakeCtx();
    const triggers: string[] = [];
    const mod = createStunModule({
      round: (family) => Promise.resolve(family === 4 ? LIVE_V4 : LIVE_V6),
      myAddr,
      egressDebounceMs: 40,
      firstRunDelayMs: 60_000,
    });
    mod.init?.(f.ctx);
    const tick = (v4If: string | null, v4Address: string | null) =>
      f.bus.emit('egress', { ts: Date.now(), v4Address, v6Address: null, v4If, v6If: v4If });
    tick('Ethernet', '192.168.0.192'); // ignored: no session
    await mod.start?.();
    tick('Ethernet', '192.168.0.192'); // baseline
    tick('Ethernet', '192.168.0.192');
    await sleep(60);
    expect(f.snapshots).toHaveLength(0);
    tick('WLAN', '192.168.0.35'); // failover …
    await sleep(20);
    tick('Ethernet', '192.168.0.192'); // … and back within the debounce window
    await sleep(20);
    expect(f.snapshots).toHaveLength(0);
    await sleep(60);
    for (const s of f.snapshots) triggers.push((s.data as NatSnapshot).trigger);
    expect(triggers).toEqual(['egress']);
    tick(null, null); // link down: no check without any egress
    await sleep(80);
    expect(f.snapshots).toHaveLength(1);
    await mod.stop?.();
    await mod.dispose?.();
  });

  it('answers a manual request with a running check and reports total failure', async () => {
    const f = fakeCtx();
    const failed: StunRound = { family: 4, local: null, outcomes: [outcome('a', '1.2.3.4', null, 'timeout'), outcome('b', '5.6.7.8', null, 'timeout')] };
    const mod = createStunModule({
      round: async (family) => (await sleep(30), { ...failed, family }),
      myAddr: () => Promise.resolve({ txt: null, rttMs: null, error: 'timeout' }),
    });
    mod.init?.(f.ctx);
    const [a, b] = await Promise.all([mod.runNow?.(), mod.runNow?.()]);
    expect(f.snapshots).toHaveLength(1);
    expect(a).toMatchObject({ ok: false, error: 'Keine STUN-Antwort erhalten' });
    expect(b).toEqual(a);
    expect(mod.state().lastError).toBe('STUN ohne Antwort (IPv4, IPv6)');
  });
});
