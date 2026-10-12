import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { rowToEvent, rowToSession } from '../../src/lib/shared/db/rows';
import type { ControlResponse, EngineStatus, ModuleState, NetEvent, TestSession } from '../../src/lib/shared/types';
import { openEngineDb } from '../db/engine-db';
import type { ModuleEntry } from '../modules';
import { PortInUseError } from '../server';
import { type EngineHandle, startEngine } from './bootstrap';
import { createLogger } from './logger';
import type { EngineContext, EngineModule } from './types';

const dirs: string[] = [];
const engines: EngineHandle[] = [];

afterEach(async () => {
  for (const e of engines.splice(0)) await e.shutdown('test');
  for (const d of dirs.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* windows may keep the file locked briefly */
    }
  }
});

function tmpDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'netdiag-boot-'));
  dirs.push(dir);
  return path.join(dir, 'engine.db');
}

function readTable<T>(dbPath: string, sql: string, map: (row: Record<string, unknown>) => T): T[] {
  const db = new DatabaseSync(dbPath);
  try {
    return (db.prepare(sql).all() as Record<string, unknown>[]).map(map);
  } finally {
    db.close();
  }
}

const idle = (name: string): ModuleState => ({ name, enabled: true, running: false, busy: false, lastRunTs: null, nextRunTs: null, lastError: null });

/** a fake probes module: records lifecycle calls, offers probeStates() and runNow() */
function fakeProbes(calls: string[]): EngineModule & { probeStates(): unknown[] } {
  let ctx: EngineContext | null = null;
  return {
    name: 'probes',
    init: (c) => {
      ctx = c;
      calls.push('init');
    },
    start: () => {
      calls.push(`start:${ctx?.session()?.id ?? 'none'}`);
    },
    stop: () => {
      calls.push('stop');
    },
    dispose: () => {
      calls.push('dispose');
    },
    state: () => idle('probes'),
    probeStates: () => [{ targetId: 'cf4', resolvedHost: '1.1.1.1', running: true, lastTs: null, lastRtt: null, lastStatus: null, error: null }],
  };
}

async function boot(dbPath: string, calls: string[], port = 0) {
  const lines: string[] = [];
  const log = createLogger({ level: 'debug', sink: (_l, line) => lines.push(line) });
  const engine = await startEngine({
    version: '9.9.9',
    log,
    dbPath,
    port,
    host: '127.0.0.1',
    openDb: (p, o) => openEngineDb(p, { ...o, flushIntervalMs: 200 }),
    importer: async (entry: ModuleEntry) => {
      if (entry.name === 'probes') return { createProbesModule: () => fakeProbes(calls) };
      throw Object.assign(new Error(`Cannot find module '${entry.file}'`), { code: 'ERR_MODULE_NOT_FOUND' });
    },
    windowsImporter: async (url) => {
      throw Object.assign(new Error(`Cannot find module '${url}'`), { code: 'ERR_MODULE_NOT_FOUND' });
    },
  });
  engines.push(engine);
  const base = `http://127.0.0.1:${engine.port}`;
  const control = async (action: string, params?: Record<string, unknown>): Promise<ControlResponse> => {
    const res = await fetch(`${base}/control`, { method: 'POST', body: JSON.stringify({ action, params }) });
    expect(res.status).toBe(200);
    return (await res.json()) as ControlResponse;
  };
  return { engine, base, control, lines };
}

describe('startEngine', () => {
  it('serves the API, runs sessions and skips missing modules', async () => {
    const dbPath = tmpDbPath();
    const calls: string[] = [];
    const { engine, base, control, lines } = await boot(dbPath, calls);

    expect(await (await fetch(`${base}/health`)).json()).toEqual({ ok: true, version: '9.9.9', pid: process.pid });
    const status = (await (await fetch(`${base}/status`)).json()) as EngineStatus;
    expect(status.modules).toHaveLength(17);
    expect(status.modules.filter((m) => m.enabled).map((m) => m.name)).toEqual(['probes']);
    expect(status.modules.find((m) => m.name === 'router')?.lastError).toBe('Modul nicht verfügbar: Datei engine/router/index.ts fehlt');
    expect(status.probes.map((p) => p.targetId)).toEqual(['cf4']);
    expect(status.dynamicHosts.gateway).toBe('192.168.0.1');
    expect(status.dbPath).toBe(dbPath);
    expect(lines.some((l) => l.includes('Modul router nicht verfügbar: Datei engine/router/index.ts fehlt'))).toBe(true);
    expect(lines.some((l) => l.includes('PowerShell-Host nicht verfügbar'))).toBe(true);

    const started = await control('session.start', { durationMin: 1, label: 'Testlauf' });
    expect(started.ok).toBe(true);
    const session = started.result as TestSession;
    expect(session).toMatchObject({ status: 'running', label: 'Testlauf', endedAt: null });
    expect(session.plannedEndAt).toBe(session.startedAt + 60_000);
    expect(calls).toEqual(['init', `start:${session.id}`]);
    expect(((await (await fetch(`${base}/status`)).json()) as EngineStatus).session?.id).toBe(session.id);

    expect(await control('session.start', { durationMin: null })).toEqual({ ok: false, error: 'Es läuft bereits ein Langzeittest.' });
    expect(await control('mtu.run')).toEqual({ ok: false, error: 'Modul „mtu“ ist nicht verfügbar.' });
    const pw = await control('router.setPassword', { password: 'geheim' });
    expect(pw).toEqual({ ok: true, result: { hasPassword: true } });
    expect(lines.join('\n')).not.toContain('geheim');

    const stopped = await control('session.stop');
    expect(stopped.ok).toBe(true);
    expect(stopped.result).toMatchObject({ id: session.id, status: 'aborted' });
    expect(calls).toEqual(['init', `start:${session.id}`, 'stop']);

    await engine.shutdown('test');
    expect(calls.at(-1)).toBe('dispose');
    const sessions = readTable(dbPath, 'SELECT * FROM sessions', rowToSession);
    expect(sessions).toMatchObject([{ id: session.id, status: 'aborted' }]);
    const events = readTable(dbPath, 'SELECT * FROM events ORDER BY id', rowToEvent);
    expect(events.map((e) => e.type)).toEqual(['session_start', 'session_end']);
    expect(events[0].details).toMatchObject({ resumed: false, sessionId: session.id });
  });

  it('keeps a running session across a restart and resumes it', async () => {
    const dbPath = tmpDbPath();
    const first = await boot(dbPath, []);
    const started = await first.control('session.start', { durationMin: null });
    const session = started.result as TestSession;
    await first.engine.shutdown('Neustart');
    expect(readTable(dbPath, 'SELECT * FROM sessions', rowToSession)[0].status).toBe('running');

    const calls: string[] = [];
    const second = await boot(dbPath, calls);
    const status = (await (await fetch(`${second.base}/status`)).json()) as EngineStatus;
    expect(status.session?.id).toBe(session.id);
    expect(calls).toEqual(['init', `start:${session.id}`]);
    await second.engine.shutdown('test');
    const events: NetEvent[] = readTable(dbPath, 'SELECT * FROM events ORDER BY id', rowToEvent);
    const starts = events.filter((e) => e.type === 'session_start');
    expect(starts.map((e) => e.details?.resumed)).toEqual([false, true]);
  });

  it('refuses to start when the port is taken and closes its database', async () => {
    const dbPath = tmpDbPath();
    const first = await boot(dbPath, []);
    const err = await boot(tmpDbPath(), [], first.engine.port).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PortInUseError);
    expect((err as Error).message).toBe(`Engine läuft bereits (Port ${first.engine.port} belegt)`);
  });
});
