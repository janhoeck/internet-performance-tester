import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, mergeConfig } from '../../src/lib/shared/config';
import { rowToEvent } from '../../src/lib/shared/db/rows';
import type { ClientState, ModuleState, NetEvent } from '../../src/lib/shared/types';
import { openEngineDb } from '../db/engine-db';
import type { LoadedModule } from '../modules';
import { createBus } from './bus';
import { createEngineContext } from './context';
import { createHostRegistry } from './hosts';
import { createLogger } from './logger';
import {
  changedSections,
  EngineRuntime,
  HEARTBEAT_SETTING,
  loadConfig,
  moduleStateOf,
  pingerSleepInfoOf,
  probeStatesOf,
} from './runtime';
import { createSessionManager } from './session';
import type { EngineContext, EngineDb, EngineModule } from './types';
import { createMemorySecretStore, createUnavailablePowerShellHost } from './windows';

const dirs: string[] = [];
const dbs: EngineDb[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const d of dirs.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* locked */
    }
  }
});

function readEvents(dbPath: string): NetEvent[] {
  const db = new DatabaseSync(dbPath);
  try {
    return (db.prepare('SELECT * FROM events ORDER BY id').all() as Record<string, unknown>[]).map(rowToEvent);
  } finally {
    db.close();
  }
}

const idle = (name: string): ModuleState => ({ name, enabled: true, running: false, busy: false, lastRunTs: null, nextRunTs: null, lastError: null });

function fake(name: string, log: string[], extra: Partial<EngineModule> = {}): EngineModule {
  let ctx: EngineContext | null = null;
  return {
    name,
    init: (c) => {
      ctx = c;
      log.push(`init:${name}`);
    },
    start: () => {
      log.push(`start:${name}`);
    },
    stop: () => {
      log.push(`stop:${name}`);
    },
    dispose: () => {
      log.push(`dispose:${name}`);
    },
    reconfigure: () => {
      log.push(`reconfigure:${name}:${ctx ? 'ctx' : 'noctx'}`);
    },
    state: () => idle(name),
    ...extra,
  };
}

function setup(modules: EngineModule[], extraLoaded: LoadedModule[] = [], expectedIf: string | null = 'Ethernet') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'netdiag-runtime-'));
  dirs.push(dir);
  const db = openEngineDb(path.join(dir, 't.db'), { flushIntervalMs: 60_000 });
  dbs.push(db);
  const lines: string[] = [];
  const log = createLogger({ level: 'debug', sink: (_l, line) => lines.push(line) });
  const bus = createBus(log);
  const hosts = createHostRegistry({ bus, log, gateway: DEFAULT_CONFIG.router.ip });
  const handle = createEngineContext({
    version: '0.1.0', log, bus, db, ps: createUnavailablePowerShellHost(), hosts, secrets: createMemorySecretStore(), config: DEFAULT_CONFIG,
  });
  let rt: EngineRuntime | null = null;
  const sessions = createSessionManager({
    db, bus, log,
    recordEvent: (e) => handle.ctx.recordEvent(e),
    connection: async () => ({
      expectedIf,
      expectedIfSource: expectedIf ? 'egress' : null,
      primaryAdapter: expectedIf,
      isWifi: expectedIf ? false : null,
      linkMbps: expectedIf ? 1000 : null,
      ssid: null,
      band: null,
      channel: null,
      signalPct: null,
    }),
    onStart: () => rt?.startModules(),
    onStop: () => rt?.stopModules(),
  });
  handle.attachSessions(sessions);
  const loaded: LoadedModule[] = [
    ...modules.map((m) => ({ entry: { name: m.name, factory: 'x', file: `engine/${m.name}.ts` }, module: m, error: null })),
    ...extraLoaded,
  ];
  rt = new EngineRuntime({ handle, modules: loaded, sessions, log, timeouts: { initMs: 200, startMs: 200, stopMs: 200, disposeMs: 200 } });
  return { db, bus, handle, sessions, rt, lines };
}

describe('EngineRuntime', () => {
  it('runs lifecycle hooks in registry order (stop/dispose reversed) with scoped loggers', async () => {
    const calls: string[] = [];
    const scopes: string[] = [];
    const a = fake('system', calls, {
      init: (c) => {
        calls.push('init:system');
        c.log.info('hallo');
      },
    });
    const { rt, sessions, lines } = setup([a, fake('probes', calls), fake('rollup', calls)]);
    await rt.initModules();
    await sessions.start(null, null);
    await sessions.stop('user');
    await rt.shutdown();
    scopes.push(...lines.filter((l) => l.includes('hallo')));
    expect(calls).toEqual([
      'init:system', 'init:probes', 'init:rollup',
      'start:system', 'start:probes', 'start:rollup',
      'stop:rollup', 'stop:probes', 'stop:system',
      'dispose:rollup', 'dispose:probes', 'dispose:system',
    ]);
    expect(scopes[0]).toContain('INFO  system: hallo');
  });

  it('isolates failing and hanging modules', async () => {
    const calls: string[] = [];
    const broken = fake('adapter', calls, {
      init: () => {
        throw new Error('PowerShell fehlt');
      },
    });
    const hanging = fake('router', calls, { init: () => new Promise<void>(() => undefined) });
    const { rt, lines } = setup([broken, hanging, fake('rollup', calls)]);
    const t0 = Date.now();
    await rt.initModules();
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(calls).toEqual(['init:rollup']);
    expect(lines.some((l) => l.includes('Modul adapter konnte nicht initialisiert werden: PowerShell fehlt'))).toBe(true);
    expect(lines.some((l) => l.includes('Modul router: init() dauert länger'))).toBe(true);
    const states = rt.moduleStates();
    expect(states.find((s) => s.name === 'adapter')?.lastError).toBe('Initialisierung fehlgeschlagen: PowerShell fehlt');
  });

  it('reports EngineStatus incl. missing modules and probe states', async () => {
    const probes = fake('probes', [], {
      state: () => idle('probes'),
    }) as EngineModule & { probeStates: () => unknown[] };
    probes.probeStates = () => [{ targetId: 'cf4', resolvedHost: '1.1.1.1', running: true, lastTs: 1, lastRtt: 18, lastStatus: 0, error: null }, { bogus: true }];
    const missing: LoadedModule = { entry: { name: 'speedtest', factory: 'createSpeedtestModule', file: 'engine/tasks/speedtest.ts' }, module: null, error: 'Datei engine/tasks/speedtest.ts fehlt' };
    const { rt, bus } = setup([probes], [missing]);
    bus.emit('speedtest', { running: true, phase: 'idle', progress: 0.1, currentMbps: null, currentRtt: 20 });
    const st = rt.status();
    expect(st).toMatchObject({ version: '0.1.0', pid: process.pid, session: null, client: null, dynamicHosts: { gateway: '192.168.0.1' } });
    expect(st.probes).toHaveLength(1);
    expect(st.speedtest?.phase).toBe('idle');
    expect(st.modules.map((m) => [m.name, m.enabled])).toEqual([['probes', true], ['speedtest', false]]);
    expect(st.modules[1].lastError).toBe('Modul nicht verfügbar: Datei engine/tasks/speedtest.ts fehlt');
    expect(st.dbSizeBytes).toBeGreaterThan(0);
  });

  it('reloads the config: hosts, bus, reconfigure, config_change only on change', async () => {
    const calls: string[] = [];
    const { rt, db, bus, handle } = setup([fake('probes', calls)]);
    await rt.initModules();
    const seen: string[] = [];
    bus.on('config', (c) => seen.push(c.router.ip));
    rt.reloadConfig(); // unchanged
    db.setSetting('config', JSON.stringify({ router: { ip: '192.168.178.1' } }));
    const cfg = rt.reloadConfig();
    expect(cfg.router.ip).toBe('192.168.178.1');
    expect(handle.ctx.config().router.ip).toBe('192.168.178.1');
    expect(handle.ctx.hosts.resolve('$gateway')).toBe('192.168.178.1');
    expect(seen).toEqual(['192.168.0.1', '192.168.178.1']);
    expect(calls.filter((c) => c.startsWith('reconfigure'))).toEqual(['reconfigure:probes:ctx', 'reconfigure:probes:ctx']);
    const changes = readEvents(db.path).filter((e) => e.type === 'config_change');
    expect(changes).toHaveLength(1);
    expect(changes[0].details).toEqual({ sections: ['router'] });
  });

  it('ticks: engine_gap during a session, client state from bus ticks, heartbeat', async () => {
    const probes = fake('probes', []) as EngineModule & { pingerInfo: () => unknown };
    probes.pingerInfo = () => ({ mode: 'agent', pid: 4711, startedAt: 1, lastHeartbeatTs: 1, restarts: 0, failedStarts: 0, preventSleepActive: true, lastError: null });
    const { rt, db, bus, sessions, handle } = setup([probes]);
    const clients: ClientState[] = [];
    bus.on('client', (c) => clients.push(c));
    const t0 = Date.now();
    rt.tick(t0 - 60_000, 0); // before the session: no event
    rt.tick(t0 - 40_000, 1000);
    await sessions.start(null, null);
    bus.emit('nic', { ts: t0, name: 'Ethernet', up: true, mbps: 1000, rxBytes: 0, txBytes: 0, rxErrors: 0, rxDiscards: 0, isWifi: false });
    bus.emit('egress', { ts: t0, v4Address: '192.168.0.35', v6Address: null, v4If: 'WLAN', v6If: null });
    rt.tick(t0, 2000); // 40 s after the previous tick → gap
    rt.tick(t0 + 1000, 3000);
    rt.tick(t0 + 2000, 4000);
    rt.tick(t0 + 3000, 5000);
    const events = readEvents(db.path);
    const gaps = events.filter((e) => e.type === 'engine_gap');
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ ts: t0 - 40_000, endTs: t0 });
    expect(clients.at(-1)).toMatchObject({ expectedIf: 'Ethernet', egressV4If: 'WLAN', onExpected: false, linkUp: true, preventSleep: true });
    expect(handle.ctx.clientState()?.onExpected).toBe(false);
    db.flush();
    const m = new DatabaseSync(db.path);
    const points = m.prepare("SELECT value FROM metrics WHERE key = 'net.on_expected_if'").all() as { value: number }[];
    m.close();
    expect(points.map((p) => p.value)).toEqual([0]); // written once (on change)
    expect(Number(db.getSetting(HEARTBEAT_SETTING))).toBeGreaterThan(0);
  });

  it('reports preventSleep only while the pinger agent can keep Windows awake', async () => {
    const info: { mode: string; preventSleepActive: boolean | null } = { mode: 'agent', preventSleepActive: true };
    const probes = fake('probes', []) as EngineModule & { pingerInfo: () => unknown };
    probes.pingerInfo = () => ({ ...info });
    const { rt, bus, sessions } = setup([probes]);
    const seen: boolean[] = [];
    bus.on('client', (c) => seen.push(c.preventSleep));
    await sessions.start(null, null);
    const t = Date.now();
    rt.tick(t, 0);
    info.mode = 'fallback'; // ping.exe fallback: no SetThreadExecutionState
    rt.tick(t + 1000, 1000);
    info.mode = 'agent';
    info.preventSleepActive = false; // agent reported that the call failed
    rt.tick(t + 2000, 2000);
    await sessions.stop('user');
    expect(seen).toEqual([true, false, false]);
  });

  it('adopts the egress interface for a session that started without network', async () => {
    const { rt, bus, sessions } = setup([], [], null);
    const clients: ClientState[] = [];
    bus.on('client', (c) => clients.push(c));
    await sessions.start(null, null);
    const t = Date.now();
    rt.tick(t, 0); // nothing known yet
    bus.emit('egress', { ts: t + 500, v4Address: '192.168.0.192', v6Address: null, v4If: 'Ethernet', v6If: null });
    rt.tick(t + 1000, 1000); // egress seen → adopted
    rt.tick(t + 2000, 2000);
    expect(sessions.expectedInterface()).toBe('Ethernet');
    expect(clients.map((c) => [c.expectedIf, c.onExpected])).toEqual([[null, null], [null, null], ['Ethernet', true]]);
    await sessions.stop('user');
  });

  it('serializes module lifecycle hooks: a quick stop never overtakes a slow start', async () => {
    const calls: string[] = [];
    let release: () => void = () => undefined;
    const slow = fake('probes', calls, {
      start: () =>
        new Promise<void>((resolve) => {
          calls.push('start:probes:begin');
          release = () => {
            calls.push('start:probes:end');
            resolve();
          };
        }),
    });
    const { rt } = setup([slow]);
    const started = rt.startModules();
    const stopped = rt.stopModules();
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toEqual(['start:probes:begin']);
    release();
    await Promise.all([started, stopped]);
    expect(calls).toEqual(['start:probes:begin', 'start:probes:end', 'stop:probes']);
    await rt.stopModules(); // not started any more → no second stop()
    await rt.startModules();
    await rt.startModules(); // already started → no second start()
    expect(calls.filter((c) => c.startsWith('stop'))).toHaveLength(1);
    expect(calls.filter((c) => c === 'start:probes:begin')).toHaveLength(2);
  });
});

describe('runtime helpers', () => {
  it('loads config from settings and falls back to defaults', () => {
    expect(loadConfig(() => null).router.ip).toBe('192.168.0.1');
    expect(loadConfig(() => '{kaputt').router.ip).toBe('192.168.0.1');
    expect(loadConfig(() => JSON.stringify({ tariff: { name: 'GigaZuhause 1000', downMbps: 1000, upMbps: 50 } })).tariff.downMbps).toBe(1000);
  });

  it('lists changed config sections', () => {
    const b = mergeConfig({ schedules: { speedtestEveryMin: 240 } });
    expect(changedSections(DEFAULT_CONFIG, b)).toEqual(['schedules']);
    expect(changedSections(DEFAULT_CONFIG, mergeConfig({}))).toEqual([]);
  });

  it('never throws when reading module or probe states', () => {
    const throwing = { name: 'x', state: () => { throw new Error('nope'); } } as EngineModule;
    expect(moduleStateOf({ entry: { name: 'x', factory: 'f', file: 'x.ts' }, module: throwing, error: null }).lastError).toBe('Status nicht abrufbar: nope');
    expect(probeStatesOf(null)).toEqual([]);
    expect(probeStatesOf({ name: 'probes', state: () => idle('probes'), probeStates: () => { throw new Error('x'); } } as unknown as EngineModule)).toEqual([]);
  });

  it('reads the optional pingerInfo() of the probes module', () => {
    const mod = (pingerInfo?: () => unknown) => ({ name: 'probes', state: () => idle('probes'), ...(pingerInfo ? { pingerInfo } : {}) }) as unknown as EngineModule;
    expect(pingerSleepInfoOf(null)).toBeNull(); // probes module missing
    expect(pingerSleepInfoOf(mod())).toBeUndefined(); // module cannot tell
    expect(pingerSleepInfoOf(mod(() => null))).toBeNull(); // no agent outside a session
    expect(pingerSleepInfoOf(mod(() => ({ mode: 'agent', preventSleepActive: true, pid: 1 })))).toEqual({ mode: 'agent', preventSleepActive: true });
    expect(pingerSleepInfoOf(mod(() => ({ mode: 'starting', preventSleepActive: 'ja' })))).toEqual({ mode: 'starting', preventSleepActive: null });
    expect(pingerSleepInfoOf(mod(() => { throw new Error('kaputt'); }))).toBeUndefined();
  });
});
