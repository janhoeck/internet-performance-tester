import { describe, expect, it } from 'vitest';
import { type AppConfig, DEFAULT_CONFIG } from '../../src/lib/shared/config';
import type { ModuleState, TestSession } from '../../src/lib/shared/types';
import { ControlRequestError, type ControlDeps, dispatchControl, normalizeTaskResult, parseControlRequest } from './control';
import { silentLogger } from './logger';
import { createMemorySecretStore } from './windows';
import { SessionError } from './session';
import type { EngineModule } from './types';

const idle: ModuleState = { name: 'x', enabled: true, running: false, busy: false, lastRunTs: null, nextRunTs: null, lastError: null };

function fakeModule(name: string, runNow?: (p?: Record<string, unknown>) => Promise<unknown>, extra: Partial<EngineModule> = {}): EngineModule & { calls: unknown[]; reconfigured: number } {
  const m = {
    name,
    calls: [] as unknown[],
    reconfigured: 0,
    state: () => ({ ...idle, name }),
    ...extra,
  } as EngineModule & { calls: unknown[]; reconfigured: number };
  if (runNow) {
    m.runNow = (p) => {
      m.calls.push(p);
      return runNow(p);
    };
  }
  if (!m.reconfigure) m.reconfigure = () => void m.reconfigured++;
  return m;
}

const session: TestSession = { id: 7, startedAt: 1, endedAt: null, plannedEndAt: null, label: null, status: 'running', note: null };

function deps(modules: EngineModule[], over: Partial<ControlDeps> = {}): ControlDeps & { sessionCalls: unknown[] } {
  const sessionCalls: unknown[] = [];
  return {
    sessionCalls,
    sessions: {
      start: async (durationMin, label) => {
        sessionCalls.push(['start', durationMin, label]);
        return session;
      },
      stop: async (reason) => {
        sessionCalls.push(['stop', reason]);
        return { ...session, status: 'completed', endedAt: 2 };
      },
    },
    module: (name) => modules.find((m) => m.name === name) ?? null,
    secrets: createMemorySecretStore(),
    config: () => DEFAULT_CONFIG,
    reloadConfig: () => DEFAULT_CONFIG,
    log: silentLogger(),
    shortTaskWaitMs: 100,
    longTaskWaitMs: 20,
    ...over,
  };
}

const never = () => new Promise<unknown>(() => undefined);

describe('parseControlRequest', () => {
  it('accepts known actions with optional params', () => {
    expect(parseControlRequest({ action: 'session.stop' })).toEqual({ action: 'session.stop', params: undefined });
    expect(parseControlRequest({ action: 'traceroute.run', params: { family: 6 } })).toEqual({ action: 'traceroute.run', params: { family: 6 } });
  });

  it('rejects malformed requests with German messages', () => {
    expect(() => parseControlRequest(null)).toThrow(ControlRequestError);
    expect(() => parseControlRequest([1])).toThrow('JSON-Objekt erwartet');
    expect(() => parseControlRequest({ action: 'rm -rf' })).toThrow('Unbekannte Aktion: rm -rf');
    expect(() => parseControlRequest({ action: 'mtu.run', params: 'x' })).toThrow('Ungültige Parameter');
  });
});

describe('dispatchControl', () => {
  it('routes session.start / session.stop to the session manager', async () => {
    const d = deps([]);
    expect(await dispatchControl({ action: 'session.start', params: { durationMin: 4320, label: 'Kabel B' } }, d)).toEqual({ ok: true, result: session });
    expect(await dispatchControl({ action: 'session.stop' }, d)).toMatchObject({ ok: true, result: { status: 'completed' } });
    expect(d.sessionCalls).toEqual([['start', 4320, 'Kabel B'], ['stop', 'user']]);
  });

  it('turns session errors into ok:false', async () => {
    const d = deps([], {
      sessions: {
        start: async () => {
          throw new SessionError('Es läuft bereits ein Langzeittest.');
        },
        stop: async () => null,
      },
    });
    expect(await dispatchControl({ action: 'session.start', params: { durationMin: null } }, d)).toEqual({ ok: false, error: 'Es läuft bereits ein Langzeittest.' });
  });

  it('answers long tasks immediately with { started: true }', async () => {
    const speed = fakeModule('speedtest', never);
    const trace = fakeModule('traceroute', never);
    const d = deps([speed, trace]);
    const t0 = Date.now();
    expect(await dispatchControl({ action: 'speedtest.run' }, d)).toEqual({ ok: true, result: { started: true } });
    expect(await dispatchControl({ action: 'traceroute.run', params: { family: '6' } }, d)).toEqual({ ok: true, result: { started: true } });
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(trace.calls).toEqual([{ family: 6 }]);
  });

  it('reports immediate failures of long tasks (e.g. already running)', async () => {
    const speed = fakeModule('speedtest', async () => {
      throw new Error('Speedtest läuft bereits');
    });
    expect(await dispatchControl({ action: 'speedtest.run' }, deps([speed]))).toEqual({ ok: false, error: 'Speedtest läuft bereits' });
  });

  it('returns results of short tasks and passes TaskResult through', async () => {
    const stun = fakeModule('stun', async () => ({ ok: true, result: { mapping: 'endpoint-independent' } }));
    const router = fakeModule('router', async (p) => ({ ok: false, error: `Login gesperrt (${String(p?.action)})` }));
    const d = deps([stun, router]);
    expect(await dispatchControl({ action: 'stun.run' }, d)).toEqual({ ok: true, result: { mapping: 'endpoint-independent' } });
    expect(await dispatchControl({ action: 'router.login' }, d)).toEqual({ ok: false, error: 'Login gesperrt (login)' });
    expect(await dispatchControl({ action: 'router.poll' }, d)).toEqual({ ok: false, error: 'Login gesperrt (poll)' });
    expect(router.calls).toEqual([{ action: 'login' }, { action: 'poll' }]);
  });

  it('answers { started: true } when a short task takes too long', async () => {
    const stun = fakeModule('stun', never);
    expect(await dispatchControl({ action: 'stun.run' }, deps([stun]))).toEqual({ ok: true, result: { started: true } });
  });

  it('reports missing modules and modules without runNow', async () => {
    const mtr = fakeModule('mtr');
    const d = deps([mtr]);
    expect(await dispatchControl({ action: 'mtu.run' }, d)).toEqual({ ok: false, error: 'Modul „mtu“ ist nicht verfügbar.' });
    expect(await dispatchControl({ action: 'mtr.run' }, d)).toEqual({ ok: false, error: 'Modul „mtr“ unterstützt keine manuelle Ausführung.' });
  });

  it('validates traceroute family and event log days', async () => {
    const trace = fakeModule('traceroute', never);
    const evt = fakeModule('eventlog', never);
    const cfg: AppConfig = { ...DEFAULT_CONFIG, eventLog: { importDays: 0 } };
    const d = deps([trace, evt], { config: () => cfg });
    expect(await dispatchControl({ action: 'traceroute.run', params: { family: 5 } }, d)).toMatchObject({ ok: false, error: expect.stringContaining('4 oder 6') });
    expect(await dispatchControl({ action: 'eventlog.import', params: { days: 0 } }, d)).toMatchObject({ ok: false });
    await dispatchControl({ action: 'eventlog.import', params: { days: 30 } }, d);
    await dispatchControl({ action: 'eventlog.import' }, d);
    expect(evt.calls).toEqual([{ days: 30 }, { days: 365 }]);
    expect(trace.calls).toEqual([]);
  });

  it('stores the router password via the secret store and reconfigures the router', async () => {
    const router = fakeModule('router', async () => null);
    const d = deps([router]);
    expect(await dispatchControl({ action: 'router.setPassword', params: { password: 'geheim' } }, d)).toEqual({ ok: true, result: { hasPassword: true } });
    expect(await d.secrets.getRouterPassword()).toBe('geheim');
    expect(router.reconfigured).toBe(1);
    expect(await dispatchControl({ action: 'router.setPassword', params: { password: null } }, d)).toEqual({ ok: true, result: { hasPassword: false } });
    expect(await dispatchControl({ action: 'router.setPassword', params: { password: 42 } }, d)).toEqual({ ok: false, error: 'Ungültiges Passwort.' });
  });

  it('reloads the config', async () => {
    let reloads = 0;
    const d = deps([], {
      reloadConfig: () => {
        reloads++;
        return DEFAULT_CONFIG;
      },
    });
    expect(await dispatchControl({ action: 'config.reload' }, d)).toEqual({ ok: true, result: { reloaded: true, targets: DEFAULT_CONFIG.targets.length } });
    expect(reloads).toBe(1);
  });

  it('normalizes arbitrary task results', () => {
    expect(normalizeTaskResult(undefined)).toEqual({ ok: true, result: null });
    expect(normalizeTaskResult({ hops: 3 })).toEqual({ ok: true, result: { hops: 3 } });
    expect(normalizeTaskResult({ ok: false, result: undefined })).toEqual({ ok: false, error: 'Aufgabe fehlgeschlagen' });
  });
});
