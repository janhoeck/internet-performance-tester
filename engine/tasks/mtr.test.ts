import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/lib/shared/config';
import { buildTraceHops, interpretPath, type HopProbe } from '../../src/lib/shared/path-analysis';
import type { IpFamily, TraceHop, TracerouteResult } from '../../src/lib/shared/types';
import type { Bus, BusEvents, EngineContext, EngineDb, Logger } from '../core/types';
import {
  BASE_MAX_AGE_MS,
  MTR_ROUNDS,
  baseHops,
  createMtrModule,
  describeMtr,
  isMtrRow,
  mtrPlan,
  mtrReached,
  mtrTtls,
  pickBase,
} from './mtr';
import { pathHash, type TtlPlan, type TtlRunResult } from './traceroute';

const V4_PATH = ['192.168.0.1', null, '92.79.214.92', '145.254.2.199', '198.41.240.18', '198.41.240.9', '1.1.1.1'];
const V6_PATH = ['3fff:8071:7ca0:c980:de73:6ff:fe12:34df', '2a02:8101:3ff:ff89::3', '2a02:908:0:4d4::1', null, '2400:cb00:48:2::c629:f012', '2400:cb00:48:3::', '2606:4700:4700::1111'];

function hopsOf(path: readonly (string | null)[]): TraceHop[] {
  return path.map((ip, i) => ({ hop: i + 1, ip, rtts: ip ? [10 + i, 11 + i, 12 + i] : [null, null, null], lossPct: ip ? 0 : 100, avgMs: ip ? 11 + i : null }));
}

function row(family: IpFamily, path: readonly (string | null)[], extra: Partial<TracerouteResult> = {}): TracerouteResult {
  const hops = hopsOf(path);
  return {
    ts: Date.now(),
    target: family === 4 ? '1.1.1.1' : '2606:4700:4700::1111',
    family,
    hops,
    reached: path[path.length - 1] !== null,
    pathHash: pathHash(hops),
    changed: false,
    trigger: 'schedule',
    durationMs: 3000,
    ...extra,
  };
}

/** Fake ttl-probe run over a path: hop 5 drops every second probe (ICMP rate limiting). */
function fakeRun(plan: TtlPlan, path: readonly (string | null)[]): TtlRunResult {
  const probes: HopProbe[] = [];
  for (let round = 1; round <= plan.rounds; round++) {
    for (const ttl of plan.ttls) {
      const ip = path[ttl - 1] ?? null;
      const last = ttl === path.length;
      if (ip === null || (ttl === 5 && round % 2 === 0)) probes.push({ ttl, round, from: null, rttMs: null, kind: 'lost' });
      else probes.push({ ttl, round, from: ip, rttMs: 10 + ttl + (round % 3), kind: last ? 'reply' : 'ttl-expired' });
    }
  }
  return { ok: true, probes, complete: true, error: null, durationMs: plan.rounds * 1000 };
}

describe('MTR helpers', () => {
  it('probes only responding hops, 20 rounds, ≤ 8 in flight', () => {
    expect(mtrTtls(hopsOf(V4_PATH))).toEqual([1, 3, 4, 5, 6, 7]);
    expect(mtrTtls(hopsOf(V6_PATH))).toEqual([1, 2, 3, 5, 6, 7]);
    expect(mtrPlan('1.1.1.1', [1, 3])).toEqual({
      dst: '1.1.1.1', ttls: [1, 3], rounds: 20, timeoutMs: 1000, maxConc: 8, intervalMs: 1000, stopAtDest: true, trimSilent: 0, size: 32,
    });
  });

  it('prefers the latest reached path (≤ 24 h) as base, e.g. during an outage', () => {
    const now = Date.now();
    const reached = row(4, V4_PATH, { ts: now - 3_600_000 });
    const broken = row(4, ['192.168.0.1', null, null], { ts: now - 60_000, reached: false });
    expect(pickBase(broken, reached, now)).toBe(reached);
    expect(pickBase(broken, { ...reached, ts: now - BASE_MAX_AGE_MS - 1 }, now)).toBe(broken);
    expect(pickBase(null, null, now)).toBeNull();
  });

  it('strips old MTR stats from a base row and judges reachability by the MTR pass', () => {
    const r = row(4, V4_PATH);
    const withMtr: TracerouteResult = { ...r, hops: r.hops.map((h) => ({ ...h, mtr: { sent: 20, lost: 20, lossPct: 100, avgMs: null, minMs: null, maxMs: null, jitterMs: null } })) };
    expect(isMtrRow(withMtr)).toBe(true);
    expect(isMtrRow(r)).toBe(false);
    expect(baseHops(withMtr).some((h) => 'mtr' in h)).toBe(false);
    expect(mtrReached(withMtr.hops, '1.1.1.1')).toBe(false); // all 20 probes to the destination lost
    expect(mtrReached(r.hops, '1.1.1.1')).toBe(true);
  });
});

function fakeCtx(): { ctx: EngineContext; rows: TracerouteResult[]; bus: Bus } {
  const rows: TracerouteResult[] = [];
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
  const log: Logger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined, child: () => log };
  const db = {
    insertTraceroute: (r: TracerouteResult) => {
      rows.push(r);
      return rows.length;
    },
    latestTraceroute: () => null,
  } as Partial<EngineDb> as EngineDb;
  const ctx = {
    log,
    bus,
    db,
    config: () => DEFAULT_CONFIG,
    speedtestActive: () => false,
    trackChild: () => undefined,
  } as Partial<EngineContext> as EngineContext;
  return { ctx, rows, bus };
}

describe('mtr module', () => {
  it('runs 20 probes per responding hop of the latest discovery and stores MTR rows', async () => {
    const f = fakeCtx();
    const plans: TtlPlan[] = [];
    const mod = createMtrModule({
      runTtl: (plan) => {
        plans.push(plan);
        return Promise.resolve(fakeRun(plan, plan.dst === '1.1.1.1' ? V4_PATH : V6_PATH));
      },
    });
    mod.init?.(f.ctx);
    f.bus.emit('traceroute', row(4, V4_PATH));
    f.bus.emit('traceroute', row(6, V6_PATH));
    const res = await mod.runNow?.();
    expect(res).toMatchObject({ ok: true });
    expect(plans.map((p) => [p.dst, p.ttls.join(','), p.rounds])).toEqual([
      ['1.1.1.1', '1,3,4,5,6,7', MTR_ROUNDS],
      ['2606:4700:4700::1111', '1,2,3,5,6,7', MTR_ROUNDS],
    ]);
    expect(f.rows).toHaveLength(2);
    const v4 = f.rows[0];
    expect(v4).toMatchObject({ family: 4, trigger: 'manual', reached: true, changed: false });
    expect(v4.hops[0].mtr).toMatchObject({ sent: 20, lost: 0, lossPct: 0 });
    expect(v4.hops[1]).toMatchObject({ ip: null, mtr: null }); // silent AFTR hop not probed
    expect(v4.hops[4].mtr).toMatchObject({ sent: 20, lost: 10, lossPct: 50 });
    expect(v4.hops[0].rtts).toHaveLength(20); // round-aligned
    // hop 5 loses 50 %, later hops do not → cosmetic, no persistent loss
    const interp = interpretPath(v4.hops, v4.reached);
    expect(interp.lossStartsAt).toBeNull();
    expect(interp.findings.map((x) => `${x.kind}@${x.hop}`)).toContain('node-loss@5');
    expect(describeMtr(v4)).toContain('Kein durchgehender Verlust bis zum Ziel');
    expect(mod.state()).toMatchObject({ name: 'mtr', busy: false, lastError: null });
  });

  it('keeps the base path when its own MTR rows or broken discoveries are published', async () => {
    const f = fakeCtx();
    const plans: TtlPlan[] = [];
    const mod = createMtrModule({ runTtl: (plan) => (plans.push(plan), Promise.resolve(fakeRun(plan, V4_PATH))) });
    mod.init?.(f.ctx);
    f.bus.emit('traceroute', row(4, V4_PATH));
    // an outage trace (only the router answers) is not usable as base
    f.bus.emit('traceroute', row(4, ['192.168.0.1', null, null], { reached: false }));
    await mod.runNow?.();
    expect(plans[0].ttls).toEqual([1, 3, 4, 5, 6, 7]);
  });

  it('discovers the path first when none is known', async () => {
    const f = fakeCtx();
    const plans: TtlPlan[] = [];
    const mod = createMtrModule({
      runTtl: (plan) => {
        plans.push(plan);
        return Promise.resolve(fakeRun(plan, plan.dst === '1.1.1.1' ? V4_PATH : V6_PATH));
      },
    });
    mod.init?.(f.ctx);
    await mod.runNow?.();
    expect(plans.map((p) => `${p.rounds}x${p.ttls.length}`)).toEqual(['3x30', '20x6', '3x30', '20x6']);
    expect(plans[1].ttls).toEqual([1, 3, 4, 5, 6, 7]);
    expect(f.rows).toHaveLength(2);
    expect(buildTraceHops(fakeRun(plans[0], V4_PATH).probes).hops).toHaveLength(7);
  });

  it('rejects a parallel manual run and reports failures in German', async () => {
    const f = fakeCtx();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const mod = createMtrModule({
      runTtl: async () => (await gate, { ok: false, probes: [], complete: false, error: 'spawn ENOENT', durationMs: 1 }),
    });
    mod.init?.(f.ctx);
    f.bus.emit('traceroute', row(4, V4_PATH));
    f.bus.emit('traceroute', row(6, V6_PATH));
    const first = mod.runNow?.();
    await expect(mod.runNow?.()).rejects.toThrow('Eine MTR-Messung läuft bereits');
    release();
    expect(await first).toEqual({ ok: false, error: 'MTR IPv4 fehlgeschlagen (spawn ENOENT) · MTR IPv6 fehlgeschlagen (spawn ENOENT)' });
    expect(f.rows).toHaveLength(0);
  });

  it('runs an incident pass on outage start during a session (at most every 10 min)', async () => {
    const f = fakeCtx();
    let runs = 0;
    const mod = createMtrModule({ runTtl: (plan) => (runs++, Promise.resolve(fakeRun(plan, V4_PATH))) });
    mod.init?.(f.ctx);
    f.bus.emit('traceroute', row(4, V4_PATH));
    f.bus.emit('traceroute', row(6, V4_PATH.map((ip) => (ip === '1.1.1.1' ? '2606:4700:4700::1111' : ip))));
    f.bus.emit('incident', { kind: 'outage-start', ts: Date.now(), classification: 'docsis' });
    expect(runs).toBe(0); // no session
    await mod.start?.();
    expect((mod.state().nextRunTs ?? 0) - Date.now()).toBeGreaterThan(170_000);
    f.bus.emit('incident', { kind: 'outage-start', ts: Date.now(), classification: 'docsis' });
    await new Promise((r) => setTimeout(r, 30));
    f.bus.emit('incident', { kind: 'outage-start', ts: Date.now(), classification: 'docsis' });
    await new Promise((r) => setTimeout(r, 30));
    expect(runs).toBe(2); // one pass = both families
    expect(f.rows.map((r) => r.trigger)).toEqual(['incident', 'incident']);
    await mod.dispose?.();
  });
});
