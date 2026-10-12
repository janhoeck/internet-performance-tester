import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { summarize } from '../../src/lib/shared/stats';
import { type Rollup, SampleFlag } from '../../src/lib/shared/types';
import { openEngineDb } from '../db/engine-db';
import type { EngineDb } from '../core/types';
import { BaselineTracker, getBaselineTracker } from './baseline';
import { T0, fakeContext, lost, ok, testConfig } from './test-helpers';

const dirs: string[] = [];
const dbs: EngineDb[] = [];
function tmpDb(): EngineDb {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'netdiag-baseline-'));
  dirs.push(dir);
  const db = openEngineDb(path.join(dir, 'test.db'), { flushIntervalMs: 60_000 });
  dbs.push(db);
  return db;
}
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const d of dirs.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* windows may keep the file locked briefly */
    }
  }
});

function tracker(now = () => T0) {
  return new BaselineTracker({ config: () => testConfig(), now });
}

/** feed n OK samples with RTTs alternating base, base+1 */
function feed(t: BaselineTracker, id: string, n: number, base: number, start = T0): void {
  for (let i = 0; i < n; i++) t.verdict(ok(id, start + i * 1000, base + (i % 2)));
}

function minuteRollup(targetId: string, ts: number, p50: number | null): Rollup {
  const s = summarize(p50 === null ? [null] : [p50]);
  return { ts, targetId, spikes: 0, ...s, p50 };
}

describe('BaselineTracker', () => {
  it('needs 60 OK samples before a baseline exists (only ≥ lagMs counts before)', () => {
    const t = tracker();
    feed(t, 'cf4', 59, 18);
    expect(t.baseline('cf4')).toBeNull();
    expect(t.verdict(ok('cf4', T0 + 100_000, 150)).spike).toBe(false);
    expect(t.verdict(ok('cf4', T0 + 101_000, 200)).spike).toBe(true);
    expect(t.baseline('cf4')?.median).toBeCloseTo(18.5, 0);
  });

  it('memoizes verdicts per (target, ts) and feeds every OK sample exactly once', () => {
    const t = tracker();
    const s = ok('cf4', T0, 20);
    const v1 = t.verdict(s);
    const v2 = t.verdict({ ...s });
    const v3 = t.verdict(s);
    expect(v2).toBe(v1);
    expect(v3).toBe(v1);
    expect(t.count('cf4')).toBe(1);
    t.verdict(ok('cf4', T0 + 1000, 21));
    expect(t.count('cf4')).toBe(2);
  });

  it('does not feed lost samples or samples taken under load', () => {
    const t = tracker();
    const v = t.verdict(lost('cf4', T0));
    expect(v.ok).toBe(false);
    expect(v.spike).toBe(false);
    t.verdict(ok('cf4', T0 + 1000, 80, SampleFlag.LOAD));
    expect(t.count('cf4')).toBe(0);
    t.verdict(ok('cf4', T0 + 2000, 18, SampleFlag.FAILOVER));
    expect(t.count('cf4')).toBe(1);
  });

  it('judges against the baseline before the sample is added (WAN: median + 25 ms)', () => {
    const t = tracker();
    feed(t, 'cf4', 100, 20); // median 20.5, MAD 0.5 → threshold 20.5 + max(5·1, 25) = 45.5
    expect(t.verdict(ok('cf4', T0 + 200_000, 45)).spike).toBe(false);
    const v = t.verdict(ok('cf4', T0 + 201_000, 46));
    expect(v.spike).toBe(true);
    expect(v.severity).toBe('minor');
    expect(v.baseline?.median).toBeCloseTo(20.5, 5);
    expect(t.verdict(ok('cf4', T0 + 202_000, 75)).severity).toBe('major');
    expect(t.verdict(ok('cf4', T0 + 203_000, 175)).severity).toBe('severe');
    expect(t.verdict(ok('cf4', T0 + 204_000, 200)).severity).toBe('severe');
  });

  it('uses the tighter LAN rule for the gateway (median + 10 ms)', () => {
    const t = tracker();
    feed(t, 'gw', 100, 1); // median 1.5 → threshold 1.5 + max(5, 10) = 11.5
    expect(t.verdict(ok('gw', T0 + 200_000, 11)).spike).toBe(false);
    expect(t.verdict(ok('gw', T0 + 201_000, 12)).spike).toBe(true);
    expect(t.ruleFor('gw').minDeltaMs).toBe(10);
    expect(t.ruleFor('isp6').minDeltaMs).toBe(25);
    expect(t.ruleFor('unknown-target').minDeltaMs).toBe(25);
  });

  it('warms from minute rollups (one p50 per minute) and can re-warm only empty targets', () => {
    const t = tracker();
    const rollups: Rollup[] = [];
    for (let i = 0; i < 60; i++) {
      rollups.push(minuteRollup('cf4', T0 + i * 60_000, 18 + (i % 3)));
      rollups.push(minuteRollup('g4', T0 + i * 60_000, i % 10 === 0 ? null : 20));
    }
    expect(t.warm(rollups)).toBe(60 + 54);
    expect(t.baseline('cf4')?.median).toBe(19);
    expect(t.baseline('g4')).toBeNull(); // only 54 values
    expect(t.verdict(ok('cf4', T0 + 3_600_000, 50)).spike).toBe(true);
    const more = [minuteRollup('cf4', T0, 99), minuteRollup('cf6', T0, 15)];
    expect(t.warm(more, { onlyEmpty: true })).toBe(1);
    expect(t.count('cf6')).toBe(1);
  });

  it('isSpikeNow judges without feeding (backfill)', () => {
    const t = tracker();
    feed(t, 'cf4', 60, 20);
    const before = t.count('cf4');
    expect(t.isSpikeNow('cf4', 60)).toBe(true);
    expect(t.isSpikeNow('cf4', 30)).toBe(false);
    expect(t.isSpikeNow('nobody', 250)).toBe(true);
    expect(t.count('cf4')).toBe(before);
  });

  it('resets baselines when a dynamic host or a target definition changes', () => {
    let cfg = testConfig();
    const t = new BaselineTracker({ config: () => cfg, now: () => T0 });
    feed(t, 'isp6', 60, 12);
    feed(t, 'cf4', 60, 18);
    const hosts = { gateway: '192.168.0.1', isp4: null, isp6: '2a02:8101:3ff:ff89::3', aftr: null, router6: null };
    expect(t.onHostsChanged(null, hosts)).toEqual([]);
    expect(t.onHostsChanged(hosts, { ...hosts, aftr: '2a00:0:cff:84a0::3' })).toEqual([]); // null → value
    expect(t.onHostsChanged(hosts, { ...hosts, isp6: '2a02:8101:3ff:ff89::5' })).toEqual(['isp6']);
    expect(t.baseline('isp6')).toBeNull();
    expect(t.baseline('cf4')).not.toBeNull();

    cfg = testConfig((c) => {
      const cf4 = c.targets.find((x) => x.id === 'cf4');
      if (cf4) cf4.host = '1.0.0.1';
    });
    expect(t.onConfigChanged(cfg)).toEqual(['cf4']);
    expect(t.baseline('cf4')).toBeNull();
  });

  it('expires memoized verdicts after the TTL (bounded memory)', () => {
    let now = T0;
    const t = new BaselineTracker({ config: () => testConfig(), now: () => now, memoTtlMs: 10_000 });
    const s = ok('cf4', T0, 20);
    const v1 = t.verdict(s);
    now += 5_000;
    expect(t.verdict(s)).toBe(v1);
    now += 20_000;
    t.verdict(ok('cf4', T0 + 1000, 20)); // triggers pruning
    expect(t.verdict(s)).not.toBe(v1);
  });
});

describe('BaselineTracker – warm-up limits and engine stalls', () => {
  it('warms each target with the p50 of its last N minutes with data', () => {
    const t = tracker();
    const rollups: Rollup[] = [];
    for (let i = 0; i < 100; i++) rollups.push(minuteRollup('cf4', T0 + i * 60_000, i < 40 ? 90 : 18));
    expect(t.warm(rollups, { perTarget: 60 })).toBe(60);
    expect(t.baseline('cf4')?.median).toBe(18); // the 40 old 90-ms minutes are not used
  });

  it('judges TCP/UDP samples measured across a stall as unreliable (never spikes, not fed)', () => {
    const t = tracker();
    t.noteStall(T0 + 1000, T0 + 1800);
    const tcp = t.verdict(ok('cf4-tcp', T0 + 500, 1250));
    expect(tcp).toMatchObject({ ok: true, spike: false, severity: null, unreliable: true });
    expect(t.count('cf4-tcp')).toBe(0);
    expect(t.unreliableCount).toBe(1);
    // ICMP is timed by the pinger agent in its own process → not affected
    expect(t.verdict(ok('cf4', T0 + 500, 1250))).toMatchObject({ spike: true, unreliable: false });
    // probes outside the stall window are judged normally (also lost ones)
    expect(t.verdict(ok('cf4-tcp', T0 + 2000, 300))).toMatchObject({ spike: true, unreliable: false });
    expect(t.verdict(lost('cf6-tcp', T0 + 1200))).toMatchObject({ ok: false, unreliable: false });
  });

  it('forgets stall windows after stallKeepMs', () => {
    const t = new BaselineTracker({ config: () => testConfig(), stallKeepMs: 60_000 });
    t.noteStall(T0, T0 + 500);
    t.noteStall(T0 + 120_000, T0 + 120_100);
    t.noteStall(T0 + 5, T0 + 1); // invalid → ignored
    expect(t.verdict(ok('aws-fra', T0 + 100, 250)).unreliable).toBe(false);
    expect(t.verdict(ok('aws-fra', T0 + 120_050, 250)).unreliable).toBe(true);
  });
});

describe('getBaselineTracker', () => {
  it('returns one tracker per engine, warmed from rollups and fed by the bus', () => {
    const db = tmpDb();
    const now = Date.now();
    const m0 = Math.floor(now / 60_000) * 60_000;
    const rollups: Rollup[] = [];
    // the PC slept: the newest rollups are 5 h old – they still warm the baseline (24 h lookback)
    for (let i = 0; i < 60; i++) rollups.push(minuteRollup('cf4', m0 - 5 * 3_600_000 - i * 60_000, 18));
    rollups.push(minuteRollup('g4', m0 - 25 * 3_600_000, 19)); // older than 24 h → ignored
    db.upsertRollups(rollups);
    const { ctx } = fakeContext({ db });
    const a = getBaselineTracker(ctx);
    const b = getBaselineTracker(ctx);
    expect(a).toBe(b);
    expect(a.baseline('cf4')?.median).toBe(18);
    expect(a.count('g4')).toBe(0);
    ctx.recordSample(ok('cf4', now, 19));
    ctx.recordSample(ok('cf4', now, 19)); // duplicate ts → fed once
    expect(a.count('cf4')).toBe(61);
    const other = fakeContext({ db });
    expect(getBaselineTracker(other.ctx)).not.toBe(a);
  });

  it('is shared by all modules although each gets its own context copy (E-core forModule)', () => {
    const db = tmpDb();
    const { ctx, bus } = fakeContext({ db });
    const incidentsCtx = { ...ctx, log: ctx.log.child('incidents') };
    const rollupCtx = { ...ctx, log: ctx.log.child('rollup') };
    const a = getBaselineTracker(incidentsCtx);
    expect(getBaselineTracker(rollupCtx)).toBe(a);
    expect(bus.listeners('sample')).toBe(1);
    ctx.recordSample(ok('cf4', T0, 18));
    expect(a.count('cf4')).toBe(1);
  });
});
