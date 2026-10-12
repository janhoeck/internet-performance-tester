// Langzeittests: overview, deletion (entry / data) and the routes, against a seeded temp DB
// (two tests: a completed one and a running one).
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as deleteRoute from '../../app/api/sessions/[id]/route';
import * as overviewRoute from '../../app/api/sessions/overview/route';
import { rowToSession } from '../shared/db/rows';
import type { SessionOverviewResponse } from '../shared/sessions';
import type { TestSession } from '../shared/types';
import { HttpError } from './http';
import { getRouter } from './queries';
import { dataWindow, deleteSession, getSessionOverview } from './sessions';
import { queryOne, queryRows } from './sql';
import { TEST_END, type SeededDb, seedTempDb } from './test-seed';

vi.mock('next/server', async (importOriginal) => {
  const mod = await importOriginal<typeof import('next/server')>();
  return { ...mod, connection: async () => undefined };
});

let seeded: SeededDb;
beforeEach(() => {
  seeded = seedTempDb();
});
afterEach(() => seeded.cleanup());

const sessions = (): TestSession[] => queryRows('SELECT * FROM sessions ORDER BY started_at').map(rowToSession);
const count = (sql: string, ...params: number[]) => Number(queryOne(sql, ...params)?.n ?? 0);
const FAST = { budgetMs: 5, pauseMs: 0 };

describe('getSessionOverview', () => {
  it('lists all tests newest first with key figures', () => {
    const res = getSessionOverview(TEST_END);
    expect(res.items).toHaveLength(2);
    const [running, done] = res.items;
    expect(running.running).toBe(true);
    expect(running.to).toBe(TEST_END);
    expect(done.running).toBe(false);
    expect(done.session.label).toBe('Ausgangslage (Ethernet)');
    expect(done.to).toBe(done.session.endedAt);
    expect(done.seconds?.covered).toBeGreaterThan(0);
    expect(running.seconds?.covered).toBeGreaterThan(0);
    expect(done.context?.primaryAdapter).toBe('Ethernet');
    expect(res.items.every((it) => it.outages >= 0 && it.notes >= 0 && it.speedtests >= 0)).toBe(true);
  });
});

describe('dataWindow', () => {
  const s = (id: number, startedAt: number, endedAt: number | null, status: TestSession['status'] = 'completed'): TestSession => ({
    id,
    startedAt,
    endedAt,
    plannedEndAt: null,
    label: null,
    status,
    note: null,
  });
  const M = 60_000;

  it('includes the partial first and last minute', () => {
    expect(dataWindow(s(1, 10 * M + 20_000, 20 * M + 5_000), [])).toEqual({ from: 10 * M + 20_000, to: 20 * M + 5_000, minFrom: 10 * M, minTo: 20 * M + 5_000 });
  });

  it('leaves shared minutes to back-to-back neighbours', () => {
    const prev = s(1, 0, 10 * M + 10_000);
    const next = s(3, 20 * M + 40_000, null, 'running');
    expect(dataWindow(s(2, 10 * M + 20_000, 20 * M + 30_000), [prev, next])).toMatchObject({ minFrom: 11 * M, minTo: 20 * M });
  });
});

describe('deleteSession', () => {
  it('refuses unknown and running tests', async () => {
    await expect(deleteSession(999, 'entry')).rejects.toMatchObject({ status: 404 });
    const running = sessions().find((x) => x.status === 'running');
    expect(running).toBeDefined();
    const err = await deleteSession(running!.id, 'data', FAST).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(409);
    expect(sessions()).toHaveLength(2);
  });

  it('entry: removes only the list entry', async () => {
    const [done] = sessions();
    const samples = count('SELECT COUNT(*) AS n FROM samples');
    const res = await deleteSession(done.id, 'entry');
    expect(res.deleted).toEqual({ sessions: 1 });
    expect(sessions().map((x) => x.id)).not.toContain(done.id);
    expect(count('SELECT COUNT(*) AS n FROM samples')).toBe(samples);
  });

  it('data: removes everything measured during the test and nothing of the running one', async () => {
    const [done, running] = sessions();
    const from = done.startedAt;
    const to = done.endedAt!;
    const inDone = (table: string) => count(`SELECT COUNT(*) AS n FROM ${table} WHERE ts >= ? AND ts <= ?`, from, to);
    const runningSamples = count('SELECT COUNT(*) AS n FROM samples WHERE ts >= ?', running.startedAt);
    const runningSeconds = count('SELECT COUNT(*) AS n FROM seconds_1m WHERE ts >= ?', running.startedAt);
    const eventlogKept = count("SELECT COUNT(*) AS n FROM events WHERE ts >= ? AND ts <= ? AND source = 'eventlog'", from, to);
    const newestSnapshots = queryRows('SELECT kind, MAX(id) AS id FROM snapshots GROUP BY kind');
    expect(inDone('samples')).toBeGreaterThan(0);
    expect(inDone('seconds_1m')).toBeGreaterThan(0);

    const res = await deleteSession(done.id, 'data', FAST);

    expect(res.deleted.samples).toBeGreaterThan(0);
    expect(res.deleted.rollup_1m).toBeGreaterThan(0);
    expect(res.deleted.seconds_1m).toBeGreaterThan(0);
    expect(res.deleted.sessions).toBe(1);
    for (const table of ['samples', 'rollup_1m', 'seconds_1m', 'metrics', 'speedtests', 'traceroutes']) expect(inDone(table)).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM events WHERE ts >= ? AND ts <= ? AND source <> 'eventlog' AND type <> 'router_log'", from, to)).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM events WHERE ts >= ? AND ts <= ? AND source = 'eventlog'", from, to)).toBe(eventlogKept);
    for (const r of newestSnapshots) expect(queryOne('SELECT id FROM snapshots WHERE id = ?', Number(r.id))).toBeDefined();
    expect(count('SELECT COUNT(*) AS n FROM samples WHERE ts >= ?', running.startedAt)).toBe(runningSamples);
    expect(count('SELECT COUNT(*) AS n FROM seconds_1m WHERE ts >= ?', running.startedAt)).toBe(runningSeconds);
    expect(sessions().map((x) => x.id)).toEqual([running.id]);
    expect(getSessionOverview(TEST_END).items).toHaveLength(1);
  });
});

describe('routes', () => {
  const del = (id: string, scope?: string) =>
    deleteRoute.DELETE(new NextRequest(`http://127.0.0.1:3000/api/sessions/${id}${scope ? `?scope=${scope}` : ''}`, { method: 'DELETE' }), {
      params: Promise.resolve({ id }),
    });

  it('GET /api/sessions/overview', async () => {
    const res = await overviewRoute.GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as SessionOverviewResponse;
    expect(body.items).toHaveLength(2);
  });

  it('DELETE /api/sessions/[id] validates and protects the running test', async () => {
    const [done, running] = sessions();
    expect((await del('abc')).status).toBe(400);
    expect((await del(String(done.id), 'alles')).status).toBe(400);
    expect((await del('999')).status).toBe(404);
    const busy = await del(String(running.id), 'data');
    expect(busy.status).toBe(409);
    expect(((await busy.json()) as { error: string }).error).toContain('läuft noch');
    const ok = await del(String(done.id));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ id: done.id, scope: 'entry', deleted: { sessions: 1 } });
  });
});

describe('getRouter at a point in time', () => {
  it('uses the newest snapshot taken before `at`', () => {
    const latest = getRouter(0, TEST_END);
    expect(getRouter(0, TEST_END, undefined, TEST_END + 60_000).status?.ts).toBe(latest.status?.ts);
    expect(getRouter(0, TEST_END, undefined, 0).status).toBeNull();
    const firstTs = Number(queryOne("SELECT MIN(ts) AS t FROM snapshots WHERE kind = 'router'")?.t);
    if (Number.isFinite(firstTs) && latest.status) {
      expect(getRouter(0, TEST_END, undefined, firstTs).status?.ts).toBe(firstTs);
    }
  });
});
