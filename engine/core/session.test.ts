import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { rowToEvent } from '../../src/lib/shared/db/rows';
import type { NetEvent, TestSession } from '../../src/lib/shared/types';
import { openEngineDb } from '../db/engine-db';
import { createBus } from './bus';
import type { ConnectionContext } from './connection';
import { silentLogger } from './logger';
import {
  createSessionManager,
  EXPECTED_IF_SETTING,
  parseDurationMin,
  parseLabel,
  SessionError,
  statusForStop,
} from './session';
import type { EngineDb } from './types';

const dirs: string[] = [];
const dbs: EngineDb[] = [];

function tmpDb(): EngineDb {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'netdiag-session-'));
  dirs.push(dir);
  const db = openEngineDb(path.join(dir, 'test.db'), { flushIntervalMs: 60_000 });
  dbs.push(db);
  return db;
}

afterEach(() => {
  for (const db of dbs.splice(0)) {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  }
  for (const d of dirs.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* windows may keep the file locked briefly */
    }
  }
});

/** read all events back through the shared row mapper (no extra API on EngineDb needed) */
function readEvents(dbPath: string): NetEvent[] {
  const db = new DatabaseSync(dbPath);
  try {
    return (db.prepare('SELECT * FROM events ORDER BY id').all() as Record<string, unknown>[]).map(rowToEvent);
  } finally {
    db.close();
  }
}

const wired: ConnectionContext = {
  expectedIf: 'Ethernet',
  expectedIfSource: 'egress',
  primaryAdapter: 'Ethernet',
  isWifi: false,
  linkMbps: 1000,
  ssid: null,
  band: null,
  channel: null,
  signalPct: null,
};

function setup(opts: { now?: () => number; connection?: (stored: string | null) => ConnectionContext } = {}) {
  const db = tmpDb();
  const log = silentLogger();
  const bus = createBus(log);
  const published: (TestSession | null)[] = [];
  bus.on('session', (s) => published.push(s));
  const calls: string[] = [];
  const storedArgs: (string | null)[] = [];
  const mgr = createSessionManager({
    db,
    bus,
    log,
    now: opts.now,
    recordEvent: (e) => db.insertEvent(e),
    connection: async (stored) => {
      storedArgs.push(stored);
      return opts.connection ? opts.connection(stored) : { ...wired, expectedIf: stored ?? wired.expectedIf };
    },
    onStart: (s, resumed) => {
      calls.push(`start:${s.id}:${resumed}`);
    },
    onStop: (s) => {
      calls.push(`stop:${s.id}:${s.status}`);
    },
  });
  return { db, mgr, published, calls, storedArgs };
}

describe('session manager', () => {
  it('starts a session with expected interface + connection context and stops it', async () => {
    let t = 1_791_550_000_000;
    const { db, mgr, published, calls } = setup({ now: () => t });
    const s = await mgr.start(60, '  Neues Kabel  ');
    expect(s).toMatchObject({ status: 'running', startedAt: t, plannedEndAt: t + 3_600_000, label: 'Neues Kabel', endedAt: null });
    expect(mgr.current()?.id).toBe(s.id);
    expect(mgr.expectedInterface()).toBe('Ethernet');
    expect(db.getSetting(EXPECTED_IF_SETTING)).toBe('Ethernet');
    expect(db.runningSession()?.id).toBe(s.id);
    expect(calls).toEqual([`start:${s.id}:false`]);
    expect(published[0]?.id).toBe(s.id);

    await expect(mgr.start(null, null)).rejects.toBeInstanceOf(SessionError);

    t += 600_000;
    const ended = await mgr.stop('user');
    expect(ended).toMatchObject({ id: s.id, status: 'aborted', endedAt: t }); // stopped before the planned end
    expect(mgr.current()).toBeNull();
    expect(mgr.expectedInterface()).toBeNull();
    expect(db.getSetting(EXPECTED_IF_SETTING)).toBeNull();
    expect(db.runningSession()).toBeNull();
    expect(calls).toEqual([`start:${s.id}:false`, `stop:${s.id}:aborted`]);
    expect(published.at(-1)).toBeNull();
    expect(await mgr.stop('user')).toBeNull();

    const events = readEvents(db.path);
    expect(events.map((e) => e.type)).toEqual(['session_start', 'session_end']);
    expect(events[0].title).toBe('Langzeittest „Neues Kabel“ gestartet');
    expect(events[0].details).toMatchObject({
      sessionId: s.id, resumed: false, durationMin: 60, expectedIf: 'Ethernet', primaryAdapter: 'Ethernet', isWifi: false,
      linkMbps: 1000, ssid: null, band: null, channel: null, signalPct: null,
    });
    expect(events[1]).toMatchObject({ ts: t, title: 'Langzeittest „Neues Kabel“ vorzeitig beendet' });
    expect(events[1].details).toMatchObject({ reason: 'user', status: 'aborted', durationMs: 600_000 });
  });

  it('auto-stops at the planned end via tick()', async () => {
    let t = 1_791_550_000_000;
    const { db, mgr, calls } = setup({ now: () => t });
    const s = await mgr.start(1, null);
    mgr.tick(t + 59_000);
    expect(mgr.current()).not.toBeNull();
    t += 61_000;
    mgr.tick(t);
    mgr.tick(t); // must not queue a second stop
    await new Promise((r) => setTimeout(r, 10));
    expect(mgr.current()).toBeNull();
    expect(calls).toEqual([`start:${s.id}:false`, `stop:${s.id}:completed`]);
    const ev = readEvents(db.path).at(-1);
    expect(ev).toMatchObject({ type: 'session_end', ts: s.startedAt + 60_000, title: 'Langzeittest beendet (geplantes Ende erreicht)' });
  });

  it('marks unlimited sessions completed when the user stops them', () => {
    const s: TestSession = { id: 1, startedAt: 0, endedAt: null, plannedEndAt: null, label: null, status: 'running', note: null };
    expect(statusForStop(s, 'user', 1000)).toBe('completed');
    expect(statusForStop({ ...s, plannedEndAt: 500 }, 'user', 1000)).toBe('completed');
    expect(statusForStop({ ...s, plannedEndAt: 5000 }, 'user', 1000)).toBe('aborted');
  });

  it('resumes a running session on boot with the stored expected interface and a restart gap', async () => {
    let t = 1_791_550_000_000;
    const first = setup({ now: () => t });
    const s = await first.mgr.start(null, 'Langzeit');
    first.db.setSetting(EXPECTED_IF_SETTING, 'Ethernet');
    const dbPath = first.db.path;
    first.db.close(); // engine killed – session stays 'running'

    t += 120_000;
    const db = openEngineDb(dbPath, { flushIntervalMs: 60_000 });
    dbs.push(db);
    const log = silentLogger();
    const bus = createBus(log);
    const storedArgs: (string | null)[] = [];
    const calls: string[] = [];
    const mgr = createSessionManager({
      db,
      bus,
      log,
      now: () => t,
      recordEvent: (e) => db.insertEvent(e),
      connection: async (stored) => {
        storedArgs.push(stored);
        return { ...wired, expectedIf: stored, expectedIfSource: 'stored' };
      },
      onStart: (x, resumed) => {
        calls.push(`start:${x.id}:${resumed}`);
      },
    });
    const resumed = await mgr.resumeOnBoot({ lastAliveTs: t - 100_000 });
    expect(resumed?.id).toBe(s.id);
    expect(storedArgs).toEqual(['Ethernet']);
    expect(calls).toEqual([`start:${s.id}:true`]);
    expect(mgr.expectedInterface()).toBe('Ethernet');
    const events = readEvents(db.path);
    const gap = events.find((e) => e.type === 'engine_gap');
    expect(gap).toMatchObject({ ts: t - 100_000, endTs: t });
    expect(gap?.details).toMatchObject({ cause: 'restart', gapMs: 100_000 });
    const resumeEv = events.filter((e) => e.type === 'session_start').at(-1);
    expect(resumeEv?.title).toBe('Langzeittest „Langzeit“ fortgesetzt (Engine neu gestartet)');
    expect(resumeEv?.details).toMatchObject({ resumed: true, expectedIf: 'Ethernet', expectedIfSource: 'stored' });
  });

  it('completes a session whose planned end passed while the engine was off', async () => {
    let t = 1_791_550_000_000;
    const first = setup({ now: () => t });
    const s = await first.mgr.start(30, null);
    t += 2 * 3_600_000;
    const db = first.db;
    const mgr = createSessionManager({
      db,
      bus: createBus(silentLogger()),
      log: silentLogger(),
      now: () => t,
      recordEvent: (e) => db.insertEvent(e),
      connection: async () => wired,
      onStart: () => {
        throw new Error('must not start');
      },
    });
    expect(await mgr.resumeOnBoot({ lastAliveTs: t - 1000 })).toBeNull();
    expect(mgr.current()).toBeNull();
    expect(db.runningSession()).toBeNull();
    expect(db.getSetting(EXPECTED_IF_SETTING)).toBeNull();
    const end = readEvents(db.path).at(-1);
    expect(end).toMatchObject({ type: 'session_end', ts: s.startedAt + 30 * 60_000 });
    expect(end?.details).toMatchObject({ status: 'completed', reason: 'planned', completedAtStartup: true });
  });

  it('serializes concurrent starts', async () => {
    const { mgr } = setup();
    const results = await Promise.allSettled([mgr.start(null, null), mgr.start(null, null)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
  });

  it('validates duration and label', () => {
    expect(parseDurationMin(null)).toBeNull();
    expect(parseDurationMin(undefined)).toBeNull();
    expect(parseDurationMin(4320)).toBe(4320);
    expect(parseDurationMin('90')).toBe(90);
    expect(() => parseDurationMin(0)).toThrow(SessionError);
    expect(() => parseDurationMin(-5)).toThrow('Ungültige Testdauer');
    expect(() => parseDurationMin('abc')).toThrow(SessionError);
    expect(() => parseDurationMin(50_000)).toThrow(SessionError);
    expect(parseLabel('  ')).toBeNull();
    expect(parseLabel('A\n  B')).toBe('A B');
    expect(parseLabel('x'.repeat(200))).toHaveLength(80);
    expect(() => parseLabel(5)).toThrow(SessionError);
  });

  it('adopts the first egress interface when the session started without one', async () => {
    const { db, mgr } = setup({ connection: () => ({ ...wired, expectedIf: null, expectedIfSource: null, primaryAdapter: null }) });
    expect(mgr.adoptExpectedInterface('Ethernet')).toBe(false); // no session
    await mgr.start(null, null);
    expect(mgr.expectedInterface()).toBeNull();
    expect(db.getSetting(EXPECTED_IF_SETTING)).toBeNull();
    expect(mgr.adoptExpectedInterface('  ')).toBe(false);
    expect(mgr.adoptExpectedInterface('Ethernet')).toBe(true);
    expect(mgr.expectedInterface()).toBe('Ethernet');
    expect(db.getSetting(EXPECTED_IF_SETTING)).toBe('Ethernet'); // survives a restart (resume)
    expect(mgr.adoptExpectedInterface('WLAN')).toBe(false); // known now – a later failover must not overwrite it
    expect(mgr.expectedInterface()).toBe('Ethernet');
  });

  it('does not hold start()/stop() hostage to slow module hooks', async () => {
    const db = tmpDb();
    const log = silentLogger();
    let stopped = false;
    const mgr = createSessionManager({
      db,
      bus: createBus(log),
      log,
      lifecycleWaitMs: 50,
      recordEvent: (e) => db.insertEvent(e),
      connection: async () => wired,
      onStart: () => new Promise<void>(() => undefined), // hanging module start
      onStop: () =>
        new Promise<void>((resolve) =>
          setTimeout(() => {
            stopped = true;
            resolve();
          }, 120),
        ),
    });
    const t0 = Date.now();
    const s = await mgr.start(null, null);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(mgr.current()?.id).toBe(s.id);
    const ended = await mgr.stop('user');
    expect(ended?.status).toBe('completed');
    expect(stopped).toBe(false); // still running in the background
    await new Promise((r) => setTimeout(r, 150));
    expect(stopped).toBe(true);
  });

  it('records events through the provided recorder (no direct DB writes for events)', async () => {
    const { mgr, db } = setup();
    await mgr.start(null, null);
    expect(readEvents(db.path)).toHaveLength(1);
  });
});
