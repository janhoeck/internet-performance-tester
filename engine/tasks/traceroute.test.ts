import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/lib/shared/config';
import { buildTraceHops, type HopProbe } from '../../src/lib/shared/path-analysis';
import { parseTracert } from '../../src/lib/shared/parsers/tracert';
import type { DynamicHosts, IpFamily, NetEvent, TracerouteResult } from '../../src/lib/shared/types';
import type { Bus, BusEvents, DynamicHostRegistry, EngineContext, EngineDb, Logger } from '../core/types';
import {
  PLAN_PLACEHOLDER,
  createTracerouteModule,
  discoveryPlan,
  estimateRunMs,
  hopProbeKind,
  interpretTtlOutput,
  isUsableTrace,
  nextIspHost,
  normalizeResponder,
  parseTtlScriptLine,
  pathHash,
  routeChangeEvent,
  routeChangeSegment,
  stripPsComments,
  toHopProbe,
  trimSilentTail,
  ttlScriptArgs,
  type TracertRunResult,
  type TtlPlan,
  type TtlRunResult,
} from './traceroute';

// stdout of engine/tasks/ttl-probe.ps1, captured on this machine (2026-10-09, IPv4, hops 1–8 × 3)
const LIVE_V4 = `{"k":"hello","pid":13524}
{"k":"r","round":1,"ttl":1,"st":"TtlExpired","from":"192.168.0.1","ms":3.81,"rtt":null,"err":null}
{"k":"r","round":1,"ttl":4,"st":"TtlExpired","from":"145.254.2.199","ms":22.39,"rtt":null,"err":null}
{"k":"r","round":1,"ttl":3,"st":"TtlExpired","from":"92.79.214.92","ms":22.96,"rtt":null,"err":null}
{"k":"r","round":1,"ttl":5,"st":"TtlExpired","from":"198.41.240.18","ms":23.55,"rtt":null,"err":null}
{"k":"r","round":1,"ttl":8,"st":"Success","from":"1.1.1.1","ms":23.99,"rtt":23,"err":null}
{"k":"r","round":1,"ttl":7,"st":"Success","from":"1.1.1.1","ms":26.38,"rtt":23,"err":null}
{"k":"r","round":1,"ttl":6,"st":"TtlExpired","from":"198.41.240.9","ms":26.97,"rtt":null,"err":null}
{"k":"r","round":1,"ttl":2,"st":"TimedOut","from":"0.0.0.0","ms":643.2,"rtt":null,"err":null}
{"k":"r","round":2,"ttl":1,"st":"TtlExpired","from":"192.168.0.1","ms":2.39,"rtt":null,"err":null}
{"k":"r","round":2,"ttl":4,"st":"TtlExpired","from":"145.254.2.199","ms":67.54,"rtt":null,"err":null}
{"k":"r","round":2,"ttl":3,"st":"TtlExpired","from":"92.79.214.92","ms":68.99,"rtt":null,"err":null}
{"k":"r","round":2,"ttl":5,"st":"TtlExpired","from":"198.41.240.18","ms":69.88,"rtt":null,"err":null}
{"k":"r","round":2,"ttl":6,"st":"TtlExpired","from":"198.41.240.9","ms":76.85,"rtt":null,"err":null}
{"k":"r","round":2,"ttl":7,"st":"Success","from":"1.1.1.1","ms":84.74,"rtt":84,"err":null}
{"k":"r","round":2,"ttl":2,"st":"TimedOut","from":"0.0.0.0","ms":621.75,"rtt":null,"err":null}
{"k":"r","round":3,"ttl":1,"st":"TtlExpired","from":"192.168.0.1","ms":2.41,"rtt":null,"err":null}
{"k":"r","round":3,"ttl":4,"st":"TtlExpired","from":"145.254.2.199","ms":26.4,"rtt":null,"err":null}
{"k":"r","round":3,"ttl":3,"st":"TtlExpired","from":"92.79.214.92","ms":28.03,"rtt":null,"err":null}
{"k":"r","round":3,"ttl":7,"st":"Success","from":"1.1.1.1","ms":46.7,"rtt":46,"err":null}
{"k":"r","round":3,"ttl":6,"st":"TtlExpired","from":"198.41.240.9","ms":47.36,"rtt":null,"err":null}
{"k":"r","round":3,"ttl":5,"st":"TimedOut","from":"0.0.0.0","ms":605.8,"rtt":null,"err":null}
{"k":"r","round":3,"ttl":2,"st":"TimedOut","from":"0.0.0.0","ms":606.73,"rtt":null,"err":null}
{"k":"done","ms":2688.08}`;

const okProc = { code: 0, timedOut: false, aborted: false, error: null, stderr: Buffer.alloc(0), durationMs: 3090 };

describe('ttl-probe.ps1 output', () => {
  it('parses script lines and maps .NET statuses to probe outcomes', () => {
    expect(parseTtlScriptLine('{"k":"hello","pid":42}')).toEqual({ k: 'hello', pid: 42 });
    expect(parseTtlScriptLine('{"k":"fatal","err":"bad plan"}')).toEqual({ k: 'fatal', err: 'bad plan' });
    expect(parseTtlScriptLine('Ausnahme beim Aufrufen von "Send"')).toBeNull();
    expect(parseTtlScriptLine('{"k":"r","ttl":1}')).toBeNull();
    const isLocal = (ip: string) => ip === '192.168.0.192';
    expect(hopProbeKind('TtlExpired', '192.168.0.1', isLocal)).toBe('ttl-expired');
    expect(hopProbeKind('Success', '1.1.1.1', isLocal)).toBe('reply');
    expect(hopProbeKind('TimedOut', null, isLocal)).toBe('lost');
    expect(hopProbeKind('DestinationNetworkUnreachable', '10.0.0.1', isLocal)).toBe('unreachable');
    // ARP failure: Windows answers "unreachable" from our own address → local error, not a hop
    expect(hopProbeKind('DestinationHostUnreachable', '192.168.0.192', isLocal)).toBe('error');
    expect(hopProbeKind('PacketTooBig', null, isLocal)).toBe('error');
    expect(hopProbeKind('Error', null, isLocal)).toBe('error');
  });

  it('treats 0.0.0.0 / :: responders (timeouts) as no responder and strips zone ids', () => {
    expect(normalizeResponder('0.0.0.0')).toBeNull();
    expect(normalizeResponder('::')).toBeNull();
    expect(normalizeResponder('{}')).toBeNull();
    expect(normalizeResponder('fe80::1%4')).toBe('fe80::1');
    const lost = parseTtlScriptLine('{"k":"r","round":1,"ttl":4,"st":"TimedOut","from":"::","ms":802.39,"rtt":null,"err":null}');
    if (!lost || lost.k !== 'r') throw new Error('expected probe line');
    expect(toHopProbe(lost)).toEqual({ ttl: 4, round: 1, from: null, rttMs: null, kind: 'lost' });
  });

  it('turns the captured IPv4 run into the known path (Stopwatch RTTs, AFTR silent)', () => {
    const run = interpretTtlOutput(LIVE_V4, okProc);
    expect(run).toMatchObject({ ok: true, complete: true, error: null });
    expect(run.probes).toHaveLength(22);
    const built = buildTraceHops(run.probes, { silentTail: 2 });
    expect(built.reached).toBe(true);
    expect(built.hops.map((h) => h.ip)).toEqual(['192.168.0.1', null, '92.79.214.92', '145.254.2.199', '198.41.240.18', '198.41.240.9', '1.1.1.1']);
    expect(built.hops[0].rtts).toEqual([3.81, 2.39, 2.41]);
    expect(built.hops[4]).toMatchObject({ rtts: [23.55, 69.88, null] });
    expect(built.hops[6].rtts).toEqual([26.38, 84.74, 46.7]);
    expect(nextIspHost(4, null, [traceOf(built.hops, 4, built.reached)], ['192.168.0.1'])).toBe('92.79.214.92');
  });

  it('reports runner failures so the caller can fall back to tracert', () => {
    const noHello = interpretTtlOutput('', { ...okProc, code: 1, stderr: Buffer.from('Das System kann die Datei nicht finden.\r\n') });
    expect(noHello.ok).toBe(false);
    expect(noHello.error).toBe('powershell.exe exited (code 1): Das System kann die Datei nicht finden.');
    expect(interpretTtlOutput('{"k":"hello","pid":1}\n{"k":"fatal","err":"bad plan"}', okProc)).toMatchObject({ ok: false, error: 'ttl-probe.ps1: bad plan' });
    const partial = interpretTtlOutput(LIVE_V4.split('\n').slice(0, 9).join('\n'), { ...okProc, code: null, timedOut: true });
    expect(partial).toMatchObject({ ok: true, complete: false, error: 'timeout' });
    expect(partial.probes).toHaveLength(8);
    expect(interpretTtlOutput('', { ...okProc, code: null, error: 'spawn ENOENT' })).toMatchObject({ ok: false, error: 'spawn ENOENT' });
  });
});

describe('ttl-probe.ps1 invocation', () => {
  const script = readFileSync(new URL('./ttl-probe.ps1', import.meta.url), 'utf8');

  it('substitutes the plan into the real script and stays below the command-line limit', () => {
    const plan = discoveryPlan('2606:4700:4700::1111', 30);
    const args = ttlScriptArgs(script, plan);
    expect(args.slice(0, 6)).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand']);
    const body = Buffer.from(args[6], 'base64').toString('utf16le');
    expect(body).not.toContain(PLAN_PLACEHOLDER);
    expect(body.split('\n').some((l) => l.trim().startsWith('#'))).toBe(false);
    const b64 = /FromBase64String\('([^']+)'\)/.exec(body)?.[1] ?? '';
    expect(JSON.parse(Buffer.from(b64, 'base64').toString('utf8'))).toEqual(plan);
    const cmdLine = ['powershell.exe', ...args].join(' ');
    expect(cmdLine.length).toBeLessThan(32_767);
    expect(() => ttlScriptArgs(script, { ...plan, dst: '1.1.1.1; Remove-Item' })).toThrow();
    expect(() => ttlScriptArgs('no placeholder', plan)).toThrow();
  });

  it('strips comments and computes a hard timeout from the plan', () => {
    expect(stripPsComments('# a\n  # b\n$x = 1 # keep\n\n')).toBe('$x = 1 # keep');
    expect(discoveryPlan('1.1.1.1', 8)).toMatchObject({ ttls: [1, 2, 3, 4, 5, 6, 7, 8], rounds: 3, timeoutMs: 1000, maxConc: 8, stopAtDest: true });
    expect(estimateRunMs(discoveryPlan('1.1.1.1', 30))).toBe(15_000 + 3 * 4 * 1250);
    const mtr: TtlPlan = { ...discoveryPlan('1.1.1.1', 7), ttls: [1, 3, 4, 5, 6, 7], rounds: 20 };
    expect(estimateRunMs(mtr)).toBe(15_000 + 20 * 1250);
  });
});

function traceOf(hops: TracerouteResult['hops'], family: IpFamily, reached: boolean, extra: Partial<TracerouteResult> = {}): TracerouteResult {
  return {
    ts: 1_791_500_000_000,
    target: family === 4 ? '1.1.1.1' : '2606:4700:4700::1111',
    family,
    hops,
    reached,
    pathHash: pathHash(hops),
    changed: false,
    trigger: 'schedule',
    durationMs: 3000,
    ...extra,
  };
}

describe('tracert fallback and path helpers', () => {
  it('trims the silent tail of an unreached tracert run', () => {
    const lines = ['Routenverfolgung zu 203.0.113.9 über maximal 30 Hops', '', '  1    <1 ms    <1 ms     1 ms  192.168.0.1 '];
    for (let i = 2; i <= 30; i++) lines.push(`${String(i).padStart(3)}     *        *        *     Zeitüberschreitung der Anforderung.`);
    lines.push('', 'Ablaufverfolgung beendet.');
    const parsed = parseTracert(lines.join('\r\n'));
    expect(parsed.hops).toHaveLength(30);
    expect(trimSilentTail(parsed.hops, parsed.reached).map((h) => h.hop)).toEqual([1, 2, 3]);
    expect(trimSilentTail(parsed.hops, true)).toHaveLength(30);
  });

  it('hashes the responding hops and recognizes usable traces', () => {
    const a = buildTraceHops(interpretTtlOutput(LIVE_V4, okProc).probes).hops;
    expect(pathHash(a)).toMatch(/^[0-9a-f]{40}$/);
    expect(pathHash(a)).toBe(pathHash(a.map((h) => ({ ...h, rtts: [1] }))));
    expect(pathHash(a)).not.toBe(pathHash(a.map((h) => (h.hop === 3 ? { ...h, ip: '92.79.214.88' } : h))));
    expect(isUsableTrace({ reached: false, hops: [{ hop: 1, ip: '192.168.0.1', rtts: [1], lossPct: 0, avgMs: 1 }] })).toBe(false);
    expect(isUsableTrace({ reached: false, hops: a.slice(0, 3) })).toBe(true);
  });

  it('describes route changes in German with a segment', () => {
    const prev = traceOf([{ hop: 1, ip: '192.168.0.1', rtts: [1], lossPct: 0, avgMs: 1 }, { hop: 3, ip: '92.79.214.92', rtts: [15], lossPct: 0, avgMs: 15 }], 4, false);
    const cur = traceOf(prev.hops.map((h) => (h.hop === 3 ? { ...h, ip: '92.79.214.88' } : h)), 4, false, { ts: prev.ts + 900_000, id: 7 });
    const ev = routeChangeEvent(cur, prev, { changed: true, diffs: [{ hop: 3, before: '92.79.214.92', after: '92.79.214.88' }], lengthChanged: false, prevLength: null, curLength: null });
    expect(ev).toMatchObject({
      type: 'route_change', severity: 'info', segment: 'isp', source: 'traceroute',
      title: 'Routenwechsel IPv4 ab Hop 3 (92.79.214.92 → 92.79.214.88)',
      dedupeKey: `route_change:4:${cur.ts}`,
    });
    expect(ev.details).toMatchObject({ tracerouteId: 7, prevPathHash: prev.pathHash });
    const len = routeChangeEvent(cur, prev, { changed: true, diffs: [], lengthChanged: true, prevLength: 7, curLength: 8 });
    expect(len.title).toBe('Routenwechsel IPv4: Ziel nach 8 statt 7 Hops');
    expect([routeChangeSegment(4, 1), routeChangeSegment(6, 2), routeChangeSegment(4, 2), routeChangeSegment(6, 5)]).toEqual(['lan', 'docsis', 'aftr', 'isp']);
  });
});

// ─── module with a fake engine context ─────────────────────────────────────

const V4_PATH = ['192.168.0.1', null, '92.79.214.92', '145.254.2.199', '198.41.240.18', '198.41.240.9', '1.1.1.1'];
const V6_PATH = ['3fff:8071:7ca0:c980:de73:6ff:fe12:34df', '2a02:8101:3ff:ff89::3', '2a02:908:0:4d4::1', null, '2400:cb00:48:2::c629:f012', '2400:cb00:48:3::', '2606:4700:4700::1111'];

/** 3 rounds over a path; the last address is the destination */
function probesFor(path: readonly (string | null)[]): HopProbe[] {
  const out: HopProbe[] = [];
  for (let round = 1; round <= 3; round++) {
    path.forEach((ip, i) => {
      const last = i === path.length - 1;
      out.push(ip === null
        ? { ttl: i + 1, round, from: null, rttMs: null, kind: 'lost' }
        : { ttl: i + 1, round, from: ip, rttMs: 10 + i, kind: last ? 'reply' : 'ttl-expired' });
    });
  }
  return out;
}

const okRun = (path: readonly (string | null)[]): TtlRunResult => ({ ok: true, probes: probesFor(path), complete: true, error: null, durationMs: 3000 });

interface FakeCtx {
  ctx: EngineContext;
  rows: TracerouteResult[];
  events: NetEvent[];
  emitted: TracerouteResult[];
  hosts: DynamicHosts;
  bus: Bus;
  speedtest: { active: boolean };
}

function fakeCtx(): FakeCtx {
  const rows: TracerouteResult[] = [];
  const events: NetEvent[] = [];
  const emitted: TracerouteResult[] = [];
  const hosts: DynamicHosts = { gateway: '192.168.0.1', isp4: null, isp6: null, aftr: null, router6: 'fe80::de73:6ff:fe12:34df%4' };
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
      if (type === 'traceroute') emitted.push(payload as TracerouteResult);
      for (const h of handlers.get(type) ?? []) h(payload);
    },
  };
  const log: Logger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined, child: () => log };
  const db: EngineDb = {
    path: ':memory:',
    addSample: () => undefined,
    addMetrics: () => undefined,
    insertEvent: () => 1,
    updateEvent: () => undefined,
    hasEvent: () => false,
    eventIdByDedupeKey: () => null,
    secondsRollupAt: () => null,
    insertSnapshot: () => 1,
    latestSnapshot: () => null,
    insertSpeedtest: () => 1,
    insertTraceroute: (r) => {
      rows.push(r);
      return rows.length;
    },
    latestTraceroute: (f) => [...rows].reverse().find((r) => r.family === f) ?? null,
    upsertRollups: () => undefined,
    rollupsSince: () => [],
    upsertSecondsRollups: () => undefined,
    samplesBetween: () => [],
    minutesMissingRollup: () => [],
    latestSpeedtest: () => null,
    createSession: (s) => ({ ...s, id: 1 }),
    updateSession: () => undefined,
    runningSession: () => null,
    getSetting: () => null,
    setSetting: () => undefined,
    purge: () => undefined,
    sizeBytes: () => null,
    flush: () => undefined,
    close: () => undefined,
  };
  const registry: DynamicHostRegistry = {
    get: () => ({ ...hosts }),
    set: (patch) => {
      for (const [k, v] of Object.entries(patch) as [keyof DynamicHosts, string | null | undefined][]) if (v !== undefined) hosts[k] = v;
    },
    resolve: (h) => h,
  };
  const speedtest = { active: false };
  const ctx: EngineContext = {
    version: 'test',
    startedAt: 0,
    log,
    bus,
    db,
    ps: { available: false, json: () => Promise.reject(new Error('n/a')), text: () => Promise.reject(new Error('n/a')), dispose: () => undefined },
    hosts: registry,
    secrets: { getRouterPassword: () => Promise.resolve(null), setRouterPassword: () => Promise.resolve(), hasRouterPassword: () => false },
    config: () => DEFAULT_CONFIG,
    session: () => null,
    isMeasuring: () => true,
    speedtestActive: () => speedtest.active,
    setSpeedtestActive: () => undefined,
    gamingActive: () => false,
    clientState: () => null,
    expectedInterface: () => null,
    recordSample: () => undefined,
    recordMetrics: () => undefined,
    recordEvent: (e) => {
      events.push(e);
      return events.length;
    },
    updateEvent: () => undefined,
    recordSnapshot: () => undefined,
    trackChild: () => undefined,
  };
  return { ctx, rows, events, emitted, hosts, bus, speedtest };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('traceroute module', () => {
  it('stores discoveries, sets $isp4/$isp6 and reports route changes', async () => {
    const f = fakeCtx();
    let v4 = V4_PATH;
    const plans: TtlPlan[] = [];
    const mod = createTracerouteModule({
      runTtl: (plan) => {
        plans.push(plan);
        return Promise.resolve(okRun(plan.dst === '1.1.1.1' ? v4 : V6_PATH));
      },
    });
    mod.init?.(f.ctx);
    const first = await mod.runNow?.({});
    expect(first).toMatchObject({ ok: true });
    expect(f.rows.map((r) => [r.family, r.trigger, r.reached, r.changed])).toEqual([[4, 'manual', true, false], [6, 'manual', true, false]]);
    expect(f.emitted).toHaveLength(2);
    expect(plans.every((p) => p.ttls.length === 30 && p.rounds === 3)).toBe(true);
    expect(f.hosts).toMatchObject({ isp4: '92.79.214.92', isp6: '2a02:8101:3ff:ff89::3' });
    expect(f.events).toHaveLength(0);

    v4 = V4_PATH.map((ip) => (ip === '92.79.214.92' ? '92.79.214.88' : ip));
    await mod.runNow?.({ family: 4 });
    const last = f.rows[f.rows.length - 1];
    expect(last).toMatchObject({ family: 4, changed: true });
    expect(f.events).toHaveLength(1);
    expect(f.events[0]).toMatchObject({ type: 'route_change', title: 'Routenwechsel IPv4 ab Hop 3 (92.79.214.92 → 92.79.214.88)' });
    expect(f.hosts.isp4).toBe('92.79.214.88');
    expect(mod.state()).toMatchObject({ name: 'traceroute', busy: false, lastError: null });
    await mod.dispose?.();
  });

  it('rejects a second manual run while one is in progress', async () => {
    const f = fakeCtx();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const mod = createTracerouteModule({ runTtl: async (plan) => (await gate, okRun(plan.dst === '1.1.1.1' ? V4_PATH : V6_PATH)) });
    mod.init?.(f.ctx);
    const running = mod.runNow?.({ family: 6 });
    expect(mod.state().busy).toBe(true);
    await expect(mod.runNow?.({})).rejects.toThrow('Pfaderkennung läuft bereits');
    release();
    await running;
    expect(mod.state().busy).toBe(false);
  });

  it('falls back to tracert when the TTL runner fails and prefers tracert after repeated failures', async () => {
    const f = fakeCtx();
    let ttlCalls = 0;
    const tracertCalls: [string, IpFamily, number][] = [];
    const mod = createTracerouteModule({
      runTtl: () => {
        ttlCalls++;
        return Promise.resolve({ ok: false, probes: [], complete: false, error: 'powershell.exe exited (code 1)', durationMs: 50 });
      },
      runTracert: (dst, family, maxHops): Promise<TracertRunResult> => {
        tracertCalls.push([dst, family, maxHops]);
        return Promise.resolve({ ok: true, hops: buildTraceHops(probesFor(V4_PATH)).hops, reached: true, error: null, durationMs: 9000 });
      },
    });
    mod.init?.(f.ctx);
    for (let i = 0; i < 4; i++) await mod.runNow?.({ family: 4 });
    expect(ttlCalls).toBe(3);
    expect(tracertCalls).toHaveLength(4);
    expect(tracertCalls[0]).toEqual(['1.1.1.1', 4, 30]);
    expect(f.rows).toHaveLength(4);
    expect(f.hosts.isp4).toBe('92.79.214.92');
  });

  it('records a German error when both methods fail', async () => {
    const f = fakeCtx();
    const mod = createTracerouteModule({
      runTtl: () => Promise.resolve({ ok: false, probes: [], complete: false, error: 'spawn ENOENT', durationMs: 1 }),
      runTracert: () => Promise.resolve({ ok: false, hops: [], reached: false, error: 'spawn ENOENT', durationMs: 1 }),
    });
    mod.init?.(f.ctx);
    const res = await mod.runNow?.({ family: 4 });
    expect(res).toEqual({ ok: false, error: 'Pfaderkennung IPv4 fehlgeschlagen (spawn ENOENT)' });
    expect(mod.state().lastError).toBe('Pfaderkennung IPv4 fehlgeschlagen (spawn ENOENT)');
    expect(f.rows).toHaveLength(0);
  });

  it('runs a startup discovery on session start and incident runs at most every 3 minutes', async () => {
    const f = fakeCtx();
    const triggers: string[] = [];
    const mod = createTracerouteModule({
      startupDelayMs: 5,
      checkIntervalMs: 60_000,
      runTtl: (plan) => Promise.resolve(okRun(plan.dst === '1.1.1.1' ? V4_PATH : V6_PATH)),
    });
    mod.init?.(f.ctx);
    f.bus.on('traceroute', (r) => triggers.push(`${r.trigger}${r.family}`));
    f.bus.emit('incident', { kind: 'outage-start', ts: Date.now(), classification: 'isp' }); // no session yet → ignored
    await mod.start?.();
    await sleep(60);
    expect(triggers.sort()).toEqual(['startup4', 'startup6']);
    expect(mod.state()).toMatchObject({ running: true });
    expect(mod.state().nextRunTs).toBeGreaterThan(Date.now() + 14 * 60_000);
    f.bus.emit('incident', { kind: 'outage-start', ts: Date.now(), classification: 'isp' });
    await sleep(20);
    f.bus.emit('incident', { kind: 'outage-start', ts: Date.now(), classification: 'isp' });
    await sleep(20);
    expect(triggers.filter((t) => t.startsWith('incident'))).toHaveLength(2); // one run, both families
    await mod.stop?.();
    expect(mod.state()).toMatchObject({ running: false, nextRunTs: null });
    await mod.dispose?.();
  });

  it('stop() aborts a scheduled run', async () => {
    const f = fakeCtx();
    const mod = createTracerouteModule({
      startupDelayMs: 1,
      runTtl: (_plan, opts) =>
        new Promise((resolve) => {
          opts.signal?.addEventListener('abort', () => resolve({ ok: false, probes: [], complete: false, error: 'aborted', durationMs: 1 }));
        }),
    });
    mod.init?.(f.ctx);
    await mod.start?.();
    await sleep(120);
    expect(mod.state().busy).toBe(true);
    await mod.stop?.();
    expect(mod.state().busy).toBe(false);
    expect(f.rows).toHaveLength(0);
    await mod.dispose?.();
  });
});
