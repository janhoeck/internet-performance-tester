import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Sample } from '../../src/lib/shared/types';
import { openEngineDb } from '../db/engine-db';
import type { EngineDb } from '../core/types';
import { BaselineTracker, getBaselineTracker } from '../analysis/baseline';
import { MemoryDb, T0, fakeContext, lost, ok, testConfig } from '../analysis/test-helpers';
import { RollupAggregator, buildRollup, createRollupModule } from './rollup';

const s = (sec: number) => T0 + sec * 1000;
const MIN = 60_000;

function setup(startedAt = T0) {
  const cfg = testConfig();
  const tracker = new BaselineTracker({ config: () => cfg });
  const db = new MemoryDb();
  const agg = new RollupAggregator(
    { verdict: (smp) => tracker.verdict(smp), isSpikeNow: (id, rtt) => tracker.isSpikeNow(id, rtt), db },
    { startedAt },
  );
  return { cfg, tracker, db, agg };
}

/** cf4 samples for one minute: 18/19 ms alternating, `lostAt` lost, `spikeAt` 250 ms */
function minuteOfSamples(minuteStart: number, opts: { lostAt?: number[]; spikeAt?: number[]; from?: number; to?: number } = {}): Sample[] {
  const out: Sample[] = [];
  for (let sec = opts.from ?? 0; sec < (opts.to ?? 60); sec++) {
    const ts = minuteStart + sec * 1000;
    if (opts.lostAt?.includes(sec)) out.push(lost('cf4', ts));
    else out.push(ok('cf4', ts, opts.spikeAt?.includes(sec) ? 250 : 18 + (sec % 2)));
  }
  return out;
}

describe('buildRollup', () => {
  it('sorts by send time, drops duplicate ts and counts spikes of answered samples only', () => {
    const r = buildRollup('cf4', T0, [
      { ts: s(2), rtt: 20, spike: false },
      { ts: s(0), rtt: 18, spike: false },
      { ts: s(1), rtt: null, spike: true },
      { ts: s(3), rtt: 260, spike: true },
      { ts: s(3), rtt: 999, spike: true },
    ]);
    expect(r).toMatchObject({ ts: T0, targetId: 'cf4', sent: 4, lost: 1, min: 18, max: 260, spikes: 1 });
    expect(r.jitter).toBeCloseTo(240, 5); // chain broken by the loss: |260 − 20|
    expect(r.hist.reduce((a, b) => a + b, 0)).toBe(3);
  });
});

describe('RollupAggregator', () => {
  it('finalizes a minute 65 s after it started with summarize() + spike count', () => {
    const { agg, db } = setup();
    for (const smp of minuteOfSamples(T0, { lostAt: [10], spikeAt: [30] })) agg.add(smp, smp.ts + 50);
    expect(agg.finalizeDue(s(64))).toEqual([]);
    const [r] = agg.finalizeDue(s(65));
    expect(r).toMatchObject({ ts: T0, targetId: 'cf4', sent: 60, lost: 1, min: 18, max: 250, spikes: 1 });
    expect(r.p50).toBe(19); // 28 × 18 ms, 30 × 19 ms, 1 × 250 ms
    expect(db.rollups.get(`cf4|${T0}`)?.sent).toBe(60);
    expect(agg.finalizeDue(s(70))).toEqual([]); // nothing new
  });

  it('re-writes a finalized minute when a late sample arrives, drops samples after the retention', () => {
    const { agg, db } = setup();
    for (const smp of minuteOfSamples(T0, { to: 59 })) agg.add(smp, smp.ts + 50);
    agg.finalizeDue(s(65));
    expect(db.rollups.get(`cf4|${T0}`)?.sent).toBe(59);
    agg.add(lost('cf4', s(59)), s(67)); // timeout reported late
    const [again] = agg.finalizeDue(s(70));
    expect(again).toMatchObject({ sent: 60, lost: 1 });
    expect(db.upsertRollupCalls).toBe(2);
    agg.finalizeDue(T0 + MIN + 10 * MIN + 1); // bucket evicted
    expect(agg.hasBucket('cf4', T0)).toBe(false);
    agg.add(ok('cf4', s(58) + 500, 30), T0 + MIN + 10 * MIN + 2);
    expect(agg.droppedLate).toBe(1);
    expect(db.rollups.get(`cf4|${T0}`)?.sent).toBe(60);
  });

  it('skips TCP/UDP samples measured across an engine stall', () => {
    const { agg, db, tracker } = setup();
    tracker.noteStall(s(20) + 200, s(21));
    agg.add(ok('cf4-tcp', s(10) + 300, 25), s(11));
    agg.add(ok('cf4-tcp', s(20) + 300, 780), s(21));
    agg.add(ok('cf4-tcp', s(30) + 300, 24), s(31));
    agg.add(ok('cf4', s(20), 18), s(21)); // ICMP is timed by the pinger agent → kept
    agg.finalizeDue(s(65));
    expect(db.rollups.get(`cf4-tcp|${T0}`)).toMatchObject({ sent: 2, max: 25 });
    expect(db.rollups.get(`cf4|${T0}`)).toMatchObject({ sent: 1 });
    expect(agg.droppedUnreliable).toBe(1);
  });

  it('merges the database samples of the previous run into the minute the engine (re)started in', () => {
    const { agg, db } = setup(s(30) + 400);
    for (const smp of minuteOfSamples(T0, { to: 30 })) db.addSample(smp); // written by the previous run
    for (const smp of minuteOfSamples(T0, { from: 31, lostAt: [40] })) agg.add(smp, smp.ts + 50);
    const [r] = agg.finalizeDue(s(65));
    expect(r).toMatchObject({ sent: 59, lost: 1 });
  });

  it('flushAll() writes the running minute (shutdown)', () => {
    const { agg, db } = setup();
    for (const smp of minuteOfSamples(T0, { to: 20 })) agg.add(smp, smp.ts);
    expect(agg.finalizeDue(s(21))).toEqual([]);
    expect(agg.flushAll()).toHaveLength(1);
    expect(db.rollups.get(`cf4|${T0}`)?.sent).toBe(20);
    expect(agg.flushAll()).toEqual([]);
  });

  it('backfills minutes without rollup from raw samples, judging spikes against the current baseline', async () => {
    const { agg, db, tracker } = setup(s(600));
    for (let i = 0; i < 70; i++) tracker.verdict(ok('cf4', s(1000) + i * 1000, 18)); // warm baseline (median 18)
    for (const smp of minuteOfSamples(T0, { spikeAt: [5] })) db.addSample(smp);
    for (const smp of minuteOfSamples(T0 + MIN, { lostAt: [1, 2] })) db.addSample({ ...smp, rtt: smp.rtt === null ? null : 60 });
    for (const smp of minuteOfSamples(T0 + 2 * MIN, { to: 10 })) db.addSample(smp);
    db.upsertRollups([buildRollup('cf4', T0 + 2 * MIN, [])]); // already rolled up
    agg.add(ok('cf4', T0 + MIN + 59_500, 18), s(600)); // live bucket owns minute 1
    const missing = agg.findMissing(T0 - MIN, s(600), 100);
    expect(missing).toEqual([
      { targetId: 'cf4', ts: T0 },
      { targetId: 'cf4', ts: T0 + MIN },
    ]);
    let yields = 0;
    const written = await agg.backfill(missing, { chunk: 1, yieldFn: async () => void yields++ });
    expect(written).toBe(1);
    expect(yields).toBe(1);
    expect(db.rollups.get(`cf4|${T0}`)).toMatchObject({ sent: 60, lost: 0, spikes: 1 });
    expect(db.rollups.has(`cf4|${T0 + MIN}`)).toBe(false); // skipped: live aggregation owns it
  });

  it('stop() aborts a running backfill', async () => {
    const { agg, db } = setup(s(6000));
    for (let m = 0; m < 5; m++) for (const smp of minuteOfSamples(T0 + m * MIN, { to: 5 })) db.addSample(smp);
    const missing = agg.findMissing(T0, s(6000), 100);
    expect(missing).toHaveLength(5);
    const written = await agg.backfill(missing, { chunk: 2, yieldFn: async () => agg.stop() });
    expect(written).toBe(2);
  });
});

describe('createRollupModule', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('backfills crash leftovers at init, finalizes live minutes, purges hourly and flushes on dispose', async () => {
    vi.useFakeTimers();
    const now0 = T0 + 30 * MIN + 30_000; // engine (re)start at hh:30:30
    vi.setSystemTime(now0);
    const db = new MemoryDb();
    // the previous run was killed without shutdown: minutes 27…30 have raw samples but no rollup
    for (let m = 27; m <= 30; m++) {
      for (const smp of minuteOfSamples(T0 + m * MIN, { to: m === 30 ? 25 : 60 })) db.addSample(smp);
    }
    const { ctx } = fakeContext({ db });
    const mod = createRollupModule();
    mod.init?.(ctx);
    expect(db.missingQueries).toBe(1);
    await vi.advanceTimersByTimeAsync(10);
    for (let m = 27; m <= 29; m++) expect(db.rollups.get(`cf4|${T0 + m * MIN}`)?.sent).toBe(60);
    expect(db.rollups.get(`cf4|${T0 + 30 * MIN}`)?.sent).toBe(25); // incl. the minute of the restart
    expect(getBaselineTracker(ctx).count('cf4')).toBe(4); // re-warmed with the backfilled minutes

    // live samples of the running minute (30) and the next one
    for (let sec = 31; sec < 120; sec++) {
      ctx.recordSample(ok('cf4', T0 + 30 * MIN + sec * 1000, 18));
      await vi.advanceTimersByTimeAsync(1000);
    }
    // minute 30 = 25 samples of the previous run (DB) + 29 live ones, finalized at :31:05
    expect(db.rollups.get(`cf4|${T0 + 30 * MIN}`)?.sent).toBe(54);
    expect(db.rollups.has(`cf4|${T0 + 31 * MIN}`)).toBe(false); // now :31:59 – due at :32:05
    await vi.advanceTimersByTimeAsync(10_000);
    expect(db.rollups.get(`cf4|${T0 + 31 * MIN}`)?.sent).toBe(60);
    expect(mod.state()).toMatchObject({ running: true, lastError: null });

    // retention: first purge 5 min after start, then hourly; a slow purge is reported as stall
    db.onPurge = () => vi.setSystemTime(Date.now() + 800);
    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(db.purges).toHaveLength(1);
    expect(db.purges[0].cfg).toEqual(testConfig().retention);
    const purgeAt = db.purges[0].now;
    const v = getBaselineTracker(ctx).verdict(ok('cf4-tcp', purgeAt - 100, 900));
    expect(v).toMatchObject({ unreliable: true, spike: false });
    await vi.advanceTimersByTimeAsync(60 * MIN);
    expect(db.purges).toHaveLength(2);

    ctx.recordSample(ok('cf4', Date.now(), 18));
    mod.dispose?.();
    const runningMinute = Math.floor(Date.now() / MIN) * MIN;
    expect(db.rollups.get(`cf4|${runningMinute}`)?.sent).toBe(1);
    await vi.advanceTimersByTimeAsync(2 * 60 * MIN);
    expect(db.purges).toHaveLength(2); // timers cleared
    expect(mod.state().running).toBe(false);
  });
});

describe('createRollupModule with SQLite (engine-db)', () => {
  const dirs: string[] = [];
  const dbs: EngineDb[] = [];
  afterEach(() => {
    for (const d of dbs.splice(0)) d.close();
    for (const d of dirs.splice(0)) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {
        /* Windows may keep the file locked briefly */
      }
    }
  });

  it('recovers the rollups of minutes an ungraceful stop left behind', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'netdiag-rollup-'));
    dirs.push(dir);
    const db = openEngineDb(path.join(dir, 'test.db'), { flushIntervalMs: 60_000 });
    dbs.push(db);
    const m0 = Math.floor(Date.now() / MIN) * MIN - 5 * MIN;
    for (let m = 0; m < 5; m++) {
      for (const smp of minuteOfSamples(m0 + m * MIN, { lostAt: m === 2 ? [7, 8] : [] })) db.addSample(smp);
    }
    db.addSample(ok('gw', m0 + 30_000, 1.2));
    db.flush();
    const { ctx } = fakeContext({ db });
    const mod = createRollupModule();
    mod.init?.(ctx);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const rollups = db.rollupsSince(m0);
    expect(rollups.filter((r) => r.targetId === 'cf4').map((r) => [r.ts - m0, r.sent, r.lost])).toEqual([
      [0, 60, 0],
      [MIN, 60, 0],
      [2 * MIN, 60, 2],
      [3 * MIN, 60, 0],
      [4 * MIN, 60, 0],
    ]);
    expect(rollups.find((r) => r.targetId === 'gw')).toMatchObject({ ts: m0, sent: 1, min: 1.2 });
    mod.dispose?.();
  });
});
