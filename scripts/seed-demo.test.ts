import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { openEngineDb } from '../engine/db/engine-db';
import { DEMO_MARKER_KEY, Rng, buildPlan, eveningFactor, prepareDemoTarget, seedDemo } from './seed-demo';

const dirs: string[] = [];
function tmpPath(name = 'demo.db'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'netdiag-seed-'));
  dirs.push(dir);
  return path.join(dir, name);
}
afterAll(() => {
  for (const d of dirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* locked on Windows */
    }
  }
});

const END = new Date(2026, 9, 8, 23, 0, 0).getTime();
const HOUR = 3_600_000;

function query<T>(dbPath: string, sql: string, ...params: (string | number)[]): T[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare(sql).all(...params) as T[];
  } finally {
    db.close();
  }
}

describe('Rng / plan', () => {
  it('is deterministic', () => {
    const a = new Rng(42);
    const b = new Rng(42);
    const xs = Array.from({ length: 5 }, () => a.next());
    expect(Array.from({ length: 5 }, () => b.next())).toEqual(xs);
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
  });

  it('places incidents inside the range without overlaps', () => {
    const from = END - 2 * 24 * HOUR;
    const plan = buildPlan(from, END, new Rng(1));
    const windows = [
      ...plan.drops.map((d) => [d.ts, d.ts + d.downMs + d.backMs + 60_000]),
      [plan.reboot.ts, plan.reboot.wanUpAt],
      [plan.standby.from, plan.standby.to + 63_000],
      ...plan.speedtests.map((s) => [s.ts, s.endTs]),
      [plan.download.from, plan.download.to],
    ].sort((x, y) => x[0] - y[0]);
    for (let i = 1; i < windows.length; i++) expect(windows[i][0]).toBeGreaterThan(windows[i - 1][1]);
    expect(windows[0][0]).toBeGreaterThan(from);
    expect(windows.at(-1)?.[1]).toBeLessThan(END);
    expect(plan.speedtests.filter((s) => s.linkMbps === 100)).toHaveLength(2);
    expect(plan.drops.filter((d) => !d.failover)).toHaveLength(1);
    expect(plan.sessions.map((s) => s.status)).toEqual(['completed', 'running']);
  });

  it('evening factor peaks between 19 and 23 h', () => {
    expect(eveningFactor(new Date(2026, 9, 8, 21, 0).getTime())).toBe(1);
    expect(eveningFactor(new Date(2026, 9, 8, 14, 0).getTime())).toBe(0);
    expect(eveningFactor(new Date(2026, 9, 8, 18, 45).getTime())).toBeCloseTo(0.5, 5);
  });
});

describe('seedDemo', () => {
  const dbPath = tmpPath();
  const summary = seedDemo({ dbPath, end: END, spanMs: 6 * HOUR, seed: 3, historyDays: 5 });

  it('writes consistent minute rollups (computed from the generated samples)', () => {
    const rows = query<{ target_id: string; ts: number; sent: number; lost: number; n: number; nlost: number }>(
      dbPath,
      `SELECT r.target_id, r.ts, r.sent, r.lost,
              (SELECT COUNT(*) FROM samples s WHERE s.target_id = r.target_id AND s.ts >= r.ts AND s.ts < r.ts + 60000) AS n,
              (SELECT COUNT(*) FROM samples s WHERE s.target_id = r.target_id AND s.ts >= r.ts AND s.ts < r.ts + 60000 AND s.rtt IS NULL) AS nlost
       FROM rollup_1m r WHERE r.target_id IN ('gw', 'isp6', 'cf6-udp') ORDER BY r.ts LIMIT 600`,
    );
    expect(rows.length).toBe(600);
    for (const r of rows) {
      expect(r.sent).toBe(r.n);
      expect(r.lost).toBe(r.nlost);
    }
    const [{ total }] = query<{ total: number }>(dbPath, 'SELECT COUNT(*) AS total FROM samples');
    expect(total).toBe(summary.samples);
  });

  it('writes classified seconds that add up', () => {
    const rows = query<Record<string, number>>(dbPath, 'SELECT * FROM seconds_1m');
    expect(rows.length).toBe(summary.secondsRows);
    for (const r of rows) {
      expect(r.covered).toBeLessThanOrEqual(60);
      expect(r.good + r.link + r.lan + r.access + r.aftr + r.backbone + r.remote + r.unknown).toBe(r.covered);
      expect(r.ses).toBeLessThanOrEqual(r.covered);
    }
  });

  it('has CMTS-correlated evening spikes', () => {
    const spikes = (target: string, fromH: number, toH: number) =>
      query<{ n: number; m: number }>(
        dbPath,
        'SELECT SUM(spikes) AS n, COUNT(*) AS m FROM rollup_1m WHERE target_id = ? AND ts >= ? AND ts < ?',
        target,
        new Date(2026, 9, 8, fromH).getTime(),
        new Date(2026, 9, 8, toH).getTime(),
      )[0];
    const afternoon = spikes('isp6', 17, 18);
    const evening = spikes('isp6', 20, 23);
    expect(evening.n / evening.m).toBeGreaterThan(5 * Math.max(afternoon.n / afternoon.m, 0.01));
    // internet spikes happen in the same minutes as CMTS spikes
    const both = query<{ n: number }>(
      dbPath,
      `SELECT COUNT(*) AS n FROM rollup_1m a JOIN rollup_1m b ON b.ts = a.ts AND b.target_id = 'isp6'
       WHERE a.target_id = 'cf4' AND a.spikes > 0 AND b.spikes > 0`,
    )[0].n;
    const cf4 = query<{ n: number }>(dbPath, "SELECT COUNT(*) AS n FROM rollup_1m WHERE target_id = 'cf4' AND spikes > 0")[0].n;
    expect(both / cf4).toBeGreaterThan(0.7);
    const gwLate = query<{ n: number }>(dbPath, "SELECT COUNT(*) AS n FROM samples WHERE target_id = 'gw' AND rtt > 100")[0].n;
    expect(gwLate).toBe(0); // the LAN stays clean
  });

  it('is reproducible and replaces an earlier demo database', () => {
    const again = seedDemo({ dbPath, end: END, spanMs: 6 * HOUR, seed: 3, historyDays: 5 });
    expect({ ...again, durationMs: 0 }).toEqual({ ...summary, durationMs: 0 });
    const marker = query<{ value: string }>(dbPath, 'SELECT value FROM settings WHERE key = ?', DEMO_MARKER_KEY);
    expect(marker).toHaveLength(1);
  });

  it('never overwrites a real database', () => {
    const real = tmpPath('netdiag.db');
    const db = openEngineDb(real);
    db.setSetting('config', '{}');
    db.close();
    const before = fs.statSync(real).size;
    expect(() => prepareDemoTarget(real)).toThrow(/keine Demo-Datenbank/);
    expect(() => seedDemo({ dbPath: real, end: END, spanMs: HOUR })).toThrow(/keine Demo-Datenbank/);
    expect(fs.statSync(real).size).toBe(before);
    const notSqlite = tmpPath('notes.txt');
    fs.writeFileSync(notSqlite, 'hallo');
    expect(() => prepareDemoTarget(notSqlite)).toThrow(/keine Demo-Datenbank/);
    expect(fs.readFileSync(notSqlite, 'utf8')).toBe('hallo');
  });
});
