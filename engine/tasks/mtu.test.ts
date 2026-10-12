import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/lib/shared/config';
import { decodeConsole } from '../../src/lib/shared/cp850';
import type { IpFamily, MetricPoint, MtuResult, NetEvent, Snapshot, SnapshotKind } from '../../src/lib/shared/types';
import type { Bus, EngineContext, EngineDb, Logger } from '../core/types';
import {
  MTU_RANGES,
  classifyDfPingOutput,
  createMtuModule,
  measureFamilyMtu,
  mtuChangeEvent,
  mtuMetrics,
  mtuResultsFromSnapshot,
  outcomeFromStatus,
  parseDestinationCache,
  pickPmtu,
  pingArgs,
  psDfPingScript,
  searchMaxPayload,
  type MtuProbe,
  type MtuProbeOutcome,
} from './mtu';

const FIX = new URL('../../fixtures/windows/', import.meta.url);
const fixture = (name: string) => readFileSync(new URL(name, FIX));

/** path with a given MTU: payloads above the limit are "too big" (DF) */
const pathProbe = (maxPayload: number, log: number[] = []): MtuProbe => (n) => {
  log.push(n);
  return Promise.resolve(n <= maxPayload ? 'ok' : 'too-big');
};

describe('searchMaxPayload', () => {
  it('reproduces the DS-Lite search from the research log (1432 → MTU 1460)', async () => {
    const r = await searchMaxPayload(pathProbe(1432), 1200, 1472);
    expect(r.maxPayload).toBe(1432);
    expect(r.failure).toBeNull();
    // identical to fixtures/windows/mtu_probe_results.json v4_DF_search (+ the two bounds)
    expect(r.steps.map((s) => `${s.payload}:${s.outcome}`)).toEqual([
      '1200:ok', '1472:too-big', '1336:ok', '1404:ok', '1438:too-big', '1421:ok', '1429:ok', '1433:too-big', '1431:ok', '1432:ok',
    ]);
  });

  it('ends after two probes on a clean 1500-byte path and finds every limit in range', async () => {
    const r = await searchMaxPayload(pathProbe(1472), 1200, 1472);
    expect(r).toMatchObject({ maxPayload: 1472, failure: null });
    expect(r.steps).toHaveLength(2);
    for (const limit of [1200, 1201, 1300, 1471]) {
      expect((await searchMaxPayload(pathProbe(limit), 1200, 1472)).maxPayload).toBe(limit);
    }
  });

  it('retries timeouts, counts persistent ones as too big (black hole) and detects unreachable targets', async () => {
    const blackHole: MtuProbe = (n) => Promise.resolve(n <= 1432 ? 'ok' : 'timeout');
    const r = await searchMaxPayload(blackHole, 1200, 1472);
    expect(r.maxPayload).toBe(1432);
    expect(r.timeoutsAsTooBig).toBeGreaterThan(0);
    expect(r.steps.filter((s) => s.payload === 1472)).toHaveLength(2); // retried once
    const down = await searchMaxPayload(() => Promise.resolve('timeout'), 1200, 1472);
    expect(down).toMatchObject({ maxPayload: null, failure: 'unreachable' });
    expect(down.steps).toHaveLength(2);
    // one lost probe is retried, not taken as "too big"
    let first = true;
    const flaky: MtuProbe = (n) => {
      if (n === 1336 && first) {
        first = false;
        return Promise.resolve('timeout');
      }
      return Promise.resolve(n <= 1432 ? 'ok' : 'too-big');
    };
    expect(await searchMaxPayload(flaky, 1200, 1472)).toMatchObject({ maxPayload: 1432, timeoutsAsTooBig: 0 });
  });

  it('reports errors and paths below the range', async () => {
    expect(await searchMaxPayload(() => Promise.resolve('too-big'), 1200, 1472)).toMatchObject({ maxPayload: null, failure: 'below-range' });
    expect(await searchMaxPayload(() => Promise.resolve('error'), 1200, 1472)).toMatchObject({ maxPayload: null, failure: 'error' });
    const midError: MtuProbe = (n) => Promise.resolve<MtuProbeOutcome>(n === 1200 ? 'ok' : n === 1472 ? 'too-big' : 'error');
    expect(await searchMaxPayload(midError, 1200, 1472)).toMatchObject({ maxPayload: null, failure: 'error' });
  });
});

describe('probe outcomes', () => {
  it('maps .NET statuses (PacketTooBig = router ICMP or local PMTU cache)', () => {
    expect(['Success', 'PacketTooBig', 'TimedOut', 'DestinationHostUnreachable', 'Exception'].map(outcomeFromStatus)).toEqual([
      'ok', 'too-big', 'timeout', 'error', 'error',
    ]);
  });

  it('builds the DF ping script and ping.exe arguments safely', () => {
    const s = psDfPingScript('1.1.1.1', 1432, 1000);
    expect(s).toContain('PingOptions(64, $true)');
    expect(s).toContain("$p.Send('1.1.1.1', 1000, (New-Object byte[] 1432), $o)");
    expect(s).toContain('ConvertTo-Json -Compress');
    expect(() => psDfPingScript("1.1.1.1'); Remove-Item x; ('", 1432, 1000)).toThrow();
    expect(() => psDfPingScript('1.1.1.1', 1.5, 1000)).toThrow();
    expect(pingArgs(4, '1.1.1.1', 1432, 1000)).toEqual(['-4', '-f', '-n', '1', '-w', '1000', '-l', '1432', '1.1.1.1']);
    expect(pingArgs(6, '2606:4700:4700::1111', 1452, 1000)).toEqual(['-6', '-n', '1', '-w', '1000', '-l', '1452', '2606:4700:4700::1111']);
  });

  it('classifies real ping.exe DF outputs (de-DE fixtures)', () => {
    expect(classifyDfPingOutput(fixture('ping_DF_1472_v4.txt').toString('utf8'))).toBe('too-big');
    expect(classifyDfPingOutput(fixture('ping_DF_1473_v4.txt').toString('utf8'))).toBe('too-big');
    // first probe: the router answers "fragmentation needed" ("Antwort von 192.168.0.1: Paket müsste …")
    expect(classifyDfPingOutput(fixture('ping_DF_1472_v4_8.8.8.8.txt').toString('utf8'))).toBe('too-big');
    // IPv6 replies have no "Bytes=" and the address contains colons
    expect(classifyDfPingOutput(fixture('ping_v6_1452.txt').toString('utf8'))).toBe('ok');
    expect(classifyDfPingOutput(fixture('ping_v6_1453.txt').toString('utf8'))).toBe('ok');
    expect(classifyDfPingOutput(fixture('ping_n1_success_1.1.1.1.cp850.txt').toString('utf8'))).toBe('ok');
    expect(classifyDfPingOutput(fixture('ping_n_timeout_w1000.cp850.txt').toString('utf8'))).toBe('timeout');
    // raw CP850 bytes as delivered by the pipe
    expect(classifyDfPingOutput(decodeConsole(fixture('ping_t_ipv6_cloudflare.fromBash.raw.bin')))).toBe('ok');
    expect(classifyDfPingOutput(decodeConsole(fixture('ping_t_unresponsive_192.0.2.1.fromBash.raw.bin')))).toBe('timeout');
    expect(classifyDfPingOutput('Antwort von 192.168.0.192: Zielhost nicht erreichbar.')).toBe('error');
    expect(classifyDfPingOutput('PING: Fehler bei der Übertragung. Allgemeiner Fehler.')).toBe('error');
    expect(classifyDfPingOutput('')).toBe('error');
  });

  it('classifies en-US outputs', () => {
    expect(classifyDfPingOutput('Pinging 1.1.1.1 with 1472 bytes of data:\r\nPacket needs to be fragmented but DF set.\r\n')).toBe('too-big');
    expect(classifyDfPingOutput('Reply from 192.168.0.1: Packet needs to be fragmented but DF set.')).toBe('too-big');
    expect(classifyDfPingOutput('Reply from 1.1.1.1: bytes=1432 time=23ms TTL=57')).toBe('ok');
    expect(classifyDfPingOutput('Reply from 2606:4700:4700::1111: time<1ms ')).toBe('ok');
    expect(classifyDfPingOutput('Request timed out.')).toBe('timeout');
    expect(classifyDfPingOutput('General failure.')).toBe('error');
  });
});

describe('Windows destination cache', () => {
  it('parses the IPv4 table and picks the PMTU per egress interface', () => {
    const entries = parseDestinationCache(fixture('netsh_ipv4_destinationcache.txt').toString('utf8'));
    expect(entries.length).toBeGreaterThan(200);
    expect(entries.find((e) => e.destination === '1.1.1.1')).toEqual({ ifIndex: 4, ifName: 'Ethernet', pmtu: 1460, destination: '1.1.1.1', nextHop: '192.168.0.1' });
    expect(entries.find((e) => e.ifName === 'CloudflareWARP')).toMatchObject({ ifIndex: 35, pmtu: 1280, destination: '100.96.0.1' });
    expect(pickPmtu(entries, '1.1.1.1')).toBe(1460);
    // 8.8.8.8 is cached on WLAN (1500) and on Ethernet (1460, DS-Lite)
    expect(pickPmtu(entries, '8.8.8.8', 'Ethernet')).toBe(1460);
    expect(pickPmtu(entries, '8.8.8.8', 'WLAN')).toBe(1500);
    expect(pickPmtu(entries, '8.8.8.8')).toBe(1460);
    expect(pickPmtu(entries, '8.8.8.8', 'unbekannt')).toBe(1460);
    // stale entries with next hop 0.0.0.0 are ignored when a routed one exists
    expect(pickPmtu(entries, '2.19.11.114')).toBe(1500);
    expect(pickPmtu(entries, '203.0.113.1')).toBeNull();
  });

  it('parses the IPv6 table (data rows contain colons, headers are localized)', () => {
    const entries = parseDestinationCache(fixture('netsh_ipv6_destinationcache_if4.txt').toString('utf8'));
    expect(entries).toHaveLength(16);
    expect(entries[0]).toEqual({ ifIndex: 4, ifName: 'Ethernet', pmtu: 1500, destination: '2001:4860:4860::8888', nextHop: 'fe80::de73:6ff:fe12:34df' });
    expect(pickPmtu(entries, '2001:4860:4860:0:0:0:0:8888')).toBe(1500);
    const en = parseDestinationCache('Interface 4: Ethernet\r\n\r\nPMTU Destination Address  Next Hop Address\r\n---- ---- ----\r\n1480 2606:4700:4700::1111  fe80::1\r\n');
    expect(en).toEqual([{ ifIndex: 4, ifName: 'Ethernet', pmtu: 1480, destination: '2606:4700:4700::1111', nextHop: 'fe80::1' }]);
  });
});

describe('measureFamilyMtu', () => {
  it('IPv4: binary search, destination cache cross-check', async () => {
    const m = await measureFamilyMtu(4, pathProbe(1432), () => Promise.resolve(1460), { ts: 1 });
    expect(m.result).toEqual({ ts: 1, family: 4, target: '1.1.1.1', mtu: 1460, maxPayload: 1432, note: null });
    const odd = await measureFamilyMtu(4, pathProbe(1432), () => Promise.resolve(1500), { ts: 1 });
    expect(odd.result.note).toBe('Windows-Zielcache meldet 1500 Byte');
    const down = await measureFamilyMtu(4, () => Promise.resolve('timeout'), () => Promise.resolve(null), { ts: 1 });
    expect(down.result).toMatchObject({ mtu: null, maxPayload: null, note: 'Ziel 1.1.1.1 nicht erreichbar' });
  });

  it('IPv6: host fragmentation makes every size succeed – the learned path MTU caps the result', async () => {
    const always: MtuProbe = () => Promise.resolve('ok'); // Windows fragments IPv6 itself
    const asked: number[] = [];
    const capped = await measureFamilyMtu(6, (n) => (asked.push(n), always(n)), () => Promise.resolve(1480), { ts: 1 });
    expect(capped.result).toMatchObject({ family: 6, target: '2606:4700:4700::1111', mtu: 1480, maxPayload: 1432, note: null });
    expect(asked[0]).toBe(MTU_RANGES[6].hi); // largest size first so a Packet Too Big gets learned
    expect(asked.filter((n) => n === 1452)).toHaveLength(1); // memoized
    const native = await measureFamilyMtu(6, always, () => Promise.resolve(1500), { ts: 1 });
    expect(native.result).toMatchObject({ mtu: 1500, maxPayload: 1452, note: null });
    expect(native.search.steps.map((s) => s.payload)).toEqual([1200, 1452]); // 1452 answered from the memo
    const unknown = await measureFamilyMtu(6, always, () => Promise.resolve(null), { ts: 1 });
    expect(unknown.result.mtu).toBe(1500);
    expect(unknown.result.note).toMatch(/nicht überprüfbar/);
  });
});

describe('events, metrics, snapshots', () => {
  const r = (family: IpFamily, mtu: number | null): MtuResult => ({ ts: 5, family, target: family === 4 ? '1.1.1.1' : '2606:4700:4700::1111', mtu, maxPayload: mtu === null ? null : mtu - (family === 4 ? 28 : 48), note: null });

  it('emits mtu_change only between two determined, different values', () => {
    expect(mtuChangeEvent(r(4, 1460), r(4, 1500))).toMatchObject({
      type: 'mtu_change', severity: 'info', segment: 'aftr', source: 'mtu', title: 'Pfad-MTU IPv4 geändert: 1460 → 1500 Byte', dedupeKey: 'mtu_change:4:5',
    });
    expect(mtuChangeEvent(r(4, 1460), r(4, 1400))?.severity).toBe('warn');
    expect(mtuChangeEvent(r(6, 1500), r(6, 1480))).toMatchObject({ severity: 'warn', segment: 'isp' });
    expect(mtuChangeEvent(null, r(4, 1460))).toBeNull();
    expect(mtuChangeEvent(r(4, 1460), r(4, 1460))).toBeNull();
    expect(mtuChangeEvent(r(4, 1460), r(4, null))).toBeNull();
  });

  it('writes metrics for determined values and reads snapshots tolerantly', () => {
    expect(mtuMetrics([r(4, 1460), r(6, null)])).toEqual([{ ts: 5, key: 'mtu.v4', value: 1460 }]);
    expect(mtuResultsFromSnapshot([r(4, 1460), r(6, 1500)])).toHaveLength(2);
    expect(mtuResultsFromSnapshot({ results: [r(6, 1500)] })).toHaveLength(1);
    expect(mtuResultsFromSnapshot({ nonsense: true })).toEqual([]);
    expect(mtuResultsFromSnapshot([{ family: 5, mtu: 1, ts: 1 }])).toEqual([]);
  });
});

// ─── module ────────────────────────────────────────────────────────────────

function fakeCtx(previous: MtuResult[] | null = null) {
  const snapshots: { kind: SnapshotKind; data: unknown }[] = [];
  const metrics: MetricPoint[] = [];
  const events: NetEvent[] = [];
  const log: Logger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined, child: () => log };
  const bus: Bus = { on: () => () => undefined, emit: () => undefined };
  const db = {
    latestSnapshot: <T>(kind: SnapshotKind): Snapshot<T> | null =>
      kind === 'mtu' && previous ? ({ ts: 1, kind, data: previous } as Snapshot<unknown> as Snapshot<T>) : null,
  } as Partial<EngineDb> as EngineDb;
  const ctx = {
    version: 'test',
    startedAt: 0,
    log,
    bus,
    db,
    ps: { available: false, json: () => Promise.reject(new Error('n/a')), text: () => Promise.reject(new Error('n/a')), dispose: () => undefined },
    config: () => DEFAULT_CONFIG,
    speedtestActive: () => false,
    clientState: () => null,
    recordSnapshot: (kind: SnapshotKind, data: unknown) => {
      snapshots.push({ kind, data });
    },
    recordMetrics: (p: MetricPoint[]) => {
      metrics.push(...p);
    },
    recordEvent: (e: NetEvent) => {
      events.push(e);
      return events.length;
    },
    trackChild: () => undefined,
  } as Partial<EngineContext> as EngineContext;
  return { ctx, snapshots, metrics, events };
}

describe('mtu module', () => {
  it('measures both families, stores snapshot + metrics and reports changes against the last snapshot', async () => {
    const f = fakeCtx([{ ts: 1, family: 4, target: '1.1.1.1', mtu: 1500, maxPayload: 1472, note: null }]);
    const mod = createMtuModule({
      probe: (family, _target, payload) => Promise.resolve(payload <= (family === 4 ? 1432 : 1452) ? 'ok' : 'too-big'),
      readCache: (family) => Promise.resolve([{ ifIndex: 4, ifName: 'Ethernet', pmtu: family === 4 ? 1460 : 1500, destination: family === 4 ? '1.1.1.1' : '2606:4700:4700::1111', nextHop: '192.168.0.1' }]),
    });
    mod.init?.(f.ctx);
    expect(mod.state().lastRunTs).toBe(1);
    const res = await mod.runNow?.();
    expect(res).toMatchObject({ ok: true });
    expect(f.snapshots).toHaveLength(1);
    expect(f.snapshots[0].kind).toBe('mtu');
    expect((f.snapshots[0].data as MtuResult[]).map((x) => [x.family, x.mtu])).toEqual([[4, 1460], [6, 1500]]);
    expect(f.metrics.map((m) => [m.key, m.value])).toEqual([['mtu.v4', 1460], ['mtu.v6', 1500]]);
    expect(f.events.map((e) => e.title)).toEqual(['Pfad-MTU IPv4 geändert: 1500 → 1460 Byte']);
    await mod.runNow?.();
    expect(f.events).toHaveLength(1); // unchanged → no new event
    expect(mod.state()).toMatchObject({ name: 'mtu', busy: false, lastError: null, running: false });
  });

  it('schedules the first run after the session start when the last result is old', async () => {
    const f = fakeCtx(null);
    const mod = createMtuModule({ probe: () => Promise.resolve('ok'), readCache: () => Promise.resolve(null), firstRunDelayMs: 120_000 });
    mod.init?.(f.ctx);
    await mod.start?.();
    const next = mod.state().nextRunTs ?? 0;
    expect(next - Date.now()).toBeGreaterThan(110_000);
    expect(next - Date.now()).toBeLessThanOrEqual(120_000);
    await mod.stop?.();
    expect(mod.state().nextRunTs).toBeNull();
    await mod.dispose?.();
  });
});
