// Router module tests: unauthenticated status polling, offline detection, authenticated DOCSIS
// cycle, docsis_change debounce, reboot detection, isThisPc matching and the login safety policy
// (wrong password stops, lockout waits, no automatic retry). Driven via runNow (no real timers).
import { afterEach, describe, expect, it } from 'vitest';
import { createRouterModule, IDLE_STATUS_SEC } from './index';
import { createFakeRouter, type FakeRouterOptions } from './fake-router';
import { mergeConfig, type AppConfig } from '../../src/lib/shared/config';
import type {
  AdapterSnapshot,
  MetricPoint,
  NetEvent,
  RouterStatus,
  Snapshot,
  SnapshotKind,
} from '../../src/lib/shared/types';
import type { EngineContext, EngineModule } from '../core/types';

const PW = 'test-password';

interface Harness {
  module: EngineModule;
  events: (NetEvent & { id: number })[];
  metrics: MetricPoint[];
  snapshots: { kind: SnapshotKind; data: unknown; ts: number }[];
  routerStatuses: RouterStatus[];
  hostPatches: Record<string, unknown>[];
  setPassword(pw: string | null): void;
  setConfig(patch: Partial<AppConfig['router']>): void;
  getConfig(): AppConfig;
  setAdapters(snap: AdapterSnapshot | null): void;
  setNow(ms: number): void;
}

function makeHarness(routerOpts: FakeRouterOptions, routerCfg: Partial<AppConfig['router']> = {}): Harness & { router: ReturnType<typeof createFakeRouter> } {
  const router = createFakeRouter(routerOpts);
  const base = mergeConfig({});
  let config: AppConfig = { ...base, router: { ...base.router, ip: '192.168.0.1', adapter: 'auto', loginEnabled: true, ...routerCfg } };
  let password: string | null = PW;
  let adapters: AdapterSnapshot | null = null;
  let now = 1_000_000;

  const events: (NetEvent & { id: number })[] = [];
  const metrics: MetricPoint[] = [];
  const snapshots: { kind: SnapshotKind; data: unknown; ts: number }[] = [];
  const routerStatuses: RouterStatus[] = [];
  const hostPatches: Record<string, unknown>[] = [];
  const dedupe = new Set<string>();
  let eventId = 1;

  const ctx: EngineContext = {
    version: 'test',
    startedAt: 0,
    log: { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } },
    bus: {
      emit(type, payload) {
        if (type === 'router') routerStatuses.push(payload as RouterStatus);
      },
      on() {
        return () => undefined;
      },
    },
    db: {
      hasEvent: (key: string) => dedupe.has(key),
      latestSnapshot: <T>(kind: SnapshotKind): Snapshot<T> | null =>
        kind === 'adapters' && adapters ? ({ ts: adapters.ts, kind, data: adapters as unknown as T }) : null,
    } as unknown as EngineContext['db'],
    ps: {} as EngineContext['ps'],
    hosts: {
      get: () => ({ gateway: '192.168.0.1', isp4: null, isp6: null, aftr: null, router6: null }),
      set: (patch) => hostPatches.push(patch as Record<string, unknown>),
      resolve: (h) => h,
    },
    secrets: {
      hasRouterPassword: () => password !== null,
      getRouterPassword: () => Promise.resolve(password),
      setRouterPassword: () => Promise.resolve(),
    },
    config: () => config,
    session: () => null,
    isMeasuring: () => false,
    speedtestActive: () => false,
    setSpeedtestActive: () => undefined,
    gamingActive: () => false,
    clientState: () => null,
    expectedInterface: () => null,
    recordSample: () => undefined,
    recordMetrics: (points) => metrics.push(...points),
    recordEvent: (e) => {
      if (e.dedupeKey && dedupe.has(e.dedupeKey)) return null;
      if (e.dedupeKey) dedupe.add(e.dedupeKey);
      const id = eventId++;
      events.push({ ...e, id });
      return id;
    },
    updateEvent: (id, patch) => {
      const ev = events.find((e) => e.id === id);
      if (ev) Object.assign(ev, patch);
    },
    recordSnapshot: (kind, data, ts) => snapshots.push({ kind, data, ts: ts ?? now }),
    trackChild: () => undefined,
  };

  const routerModule = createRouterModule({ makeSession: router.makeSession, now: () => now, firstStatusDelayMs: 10 ** 9, firstAuthDelayMs: 10 ** 9 });
  routerModule.init?.(ctx);

  return {
    module: routerModule,
    router,
    events,
    metrics,
    snapshots,
    routerStatuses,
    hostPatches,
    setPassword: (pw) => {
      password = pw;
    },
    setConfig: (patch) => {
      config = { ...config, router: { ...config.router, ...patch } };
    },
    getConfig: () => config,
    setAdapters: (snap) => {
      adapters = snap;
    },
    setNow: (ms) => {
      now = ms;
    },
  };
}

const adapterSnapshotWith = (mac: string): AdapterSnapshot => ({
  ts: 0,
  adapters: [{
    name: 'Ethernet', description: 'Intel I225-V', ifIndex: 1, status: 'Up', linkMbps: 1000, mediaType: '802.3',
    mac, driverVersion: null, driverDate: null, serviceName: 'e2fexpress', isWifi: false, isVirtual: false,
    mediaConnected: null, addresses: ['192.168.0.23'], rxBytes: null, txBytes: null, rxErrors: null, rxDiscards: null, txErrors: null, txDiscards: null,
  }],
  routes: [],
  advanced: [],
});

let active: { module: EngineModule } | null = null;
afterEach(async () => {
  await active?.module.dispose?.();
  active = null;
});

describe('unauthenticated status poll', () => {
  it('reads the start page, sets $aftr, records reachability and emits a router status', async () => {
    const h = makeHarness({ password: PW }, { loginEnabled: false });
    active = h;
    await h.module.runNow?.({ action: 'poll' });
    const status = h.routerStatuses.at(-1);
    expect(status?.reachable).toBe(true);
    expect(status?.adapter).toBe('arris-vodafone-station');
    expect(status?.connectionStatus).toBe('DOCSIS Online');
    expect(status?.dsLite).toBe(true);
    expect(h.hostPatches.some((p) => p.aftr === '2a00:0:cff:84a0::3')).toBe(true);
    expect(h.metrics.some((m) => m.key === 'router.reachable' && m.value === 1)).toBe(true);
    expect(h.metrics.some((m) => m.key === 'router.http_ms')).toBe(true);
    expect(h.snapshots.some((s) => s.kind === 'router')).toBe(true);
    expect(h.router.calls['ajaxSet_Password.php']).toBeUndefined(); // no login while loginEnabled is off
  });

  it('emits router_offline after two consecutive failures and clears it on recovery', async () => {
    const opts: FakeRouterOptions = { password: PW, unreachable: true };
    const h = makeHarness(opts, { loginEnabled: false });
    active = h;
    await h.module.runNow?.({ action: 'poll' });
    expect(h.events.filter((e) => e.type === 'router_offline')).toHaveLength(0); // one failure only
    await h.module.runNow?.({ action: 'poll' });
    const offline = h.events.filter((e) => e.type === 'router_offline');
    expect(offline).toHaveLength(1);
    expect(h.routerStatuses.at(-1)?.reachable).toBe(false);
    // recover
    opts.unreachable = false;
    await h.module.runNow?.({ action: 'poll' });
    expect(offline[0].endTs).toBeTypeOf('number');
  });

  it('idle status interval is at least 300 s', async () => {
    const h = makeHarness({ password: PW }, { loginEnabled: false, pollStatusSec: 60 });
    active = h;
    // IDLE_STATUS_SEC is the floor while no session runs
    expect(IDLE_STATUS_SEC).toBe(300);
  });

  it('refuses a non-private router address (no requests, module disabled)', async () => {
    const h = makeHarness({ password: PW }, { loginEnabled: false });
    active = h;
    h.setConfig({ ip: '8.8.8.8' });
    h.module.reconfigure?.(h.getConfig());
    await h.module.runNow?.({ action: 'poll' });
    expect(h.module.state().enabled).toBe(false);
    expect(Object.keys(h.router.calls)).toHaveLength(0); // no HTTP at all
  });
});

describe('authenticated DOCSIS cycle', () => {
  it('logs in, rates DOCSIS, records metrics + snapshots and marks the PC in the device list', async () => {
    const h = makeHarness({ password: PW });
    active = h;
    h.setAdapters(adapterSnapshotWith('AA-BB-CC-DD-EE-FF'));
    await h.module.runNow?.({ action: 'login' });

    expect(h.snapshots.some((s) => s.kind === 'docsis')).toBe(true);
    expect(h.metrics.some((m) => m.key === 'docsis.ds.snr_min')).toBe(true);
    expect(h.metrics.some((m) => m.key.startsWith('docsis.ds.corrected'))).toBe(false); // no counters
    const status = h.routerStatuses.at(-1);
    const pc = status?.attachedDevices?.find((d) => d.hostName === 'Jan-PC');
    expect(pc?.isThisPc).toBe(true);
    expect(status?.uptimeSec).toBe(86400 + 2 * 3600 + 3 * 60);
    // logoutAfterPoll default → session freed
    expect(h.router.calls['logout.php']).toBeGreaterThanOrEqual(1);
    // a router_log event was imported from the event log
    expect(h.events.some((e) => e.type === 'router_log')).toBe(true);
  });

  it('debounces docsis_change over two polls and detects a reboot', async () => {
    const opts: FakeRouterOptions = { password: PW };
    const h = makeHarness(opts);
    active = h;
    await h.module.runNow?.({ action: 'login' }); // baseline
    expect(h.events.filter((e) => e.type === 'docsis_change')).toHaveLength(0);

    // a channel drops to a critical power level → changed signature
    opts.docsisBody = `
      json_dsData = [
        {"ChannelType":"OFDM","Modulation":"4096QAM","Frequency":"151~324","ChannelID":"33","PowerLevel":"-1/59","SNRLevel":"44","LockStatus":"Locked"},
        {"ChannelType":"SC-QAM","Frequency":602,"PowerLevel":"-9/51","SNRLevel":38,"Modulation":"256QAM","ChannelID":"5","LockStatus":"Locked"}
      ];
      json_usData = [ {"Frequency":31,"PowerLevel":"44/104","ChannelType":"SC-QAM","ChannelID":"4","Modulation":"64QAM","LockStatus":"ACTIVE"} ];`;
    await h.module.runNow?.({ action: 'login' }); // changed once → still debounced
    expect(h.events.filter((e) => e.type === 'docsis_change')).toHaveLength(0);
    await h.module.runNow?.({ action: 'login' }); // held 2 polls → emit
    expect(h.events.filter((e) => e.type === 'docsis_change')).toHaveLength(1);

    // uptime drops → reboot
    opts.statusBody = `var js_FWVersion = '01.05.069.14'; var js_HWTypeVersion = '6442'; var js_UptimeSinceReboot = '0,00,05';`;
    await h.module.runNow?.({ action: 'login' });
    expect(h.events.some((e) => e.type === 'router_reboot')).toBe(true);
  });
});

describe('login safety policy', () => {
  it('stops after a wrong password and does not retry automatically', async () => {
    const h = makeHarness({ password: PW });
    active = h;
    h.setPassword('wrong');
    await h.module.runNow?.({ action: 'poll' }); // detects + attempts login once
    expect(h.router.calls['ajaxSet_Password.php']).toBe(1);
    expect(h.events.some((e) => e.type === 'router_login' && e.severity === 'warn')).toBe(true);
    // a second scheduled poll must NOT attempt the login again
    await h.module.runNow?.({ action: 'poll' });
    expect(h.router.calls['ajaxSet_Password.php']).toBe(1);
    expect(h.routerStatuses.at(-1)?.loginError).toContain('Passwort');
  });

  it('a password change re-enables login (reconfigure)', async () => {
    const h = makeHarness({ password: PW });
    active = h;
    h.setPassword('wrong');
    await h.module.runNow?.({ action: 'poll' });
    expect(h.router.calls['ajaxSet_Password.php']).toBe(1);
    // fix the password + reconfigure → the gate reopens
    h.setPassword(PW);
    h.module.reconfigure?.(h.getConfig());
    await h.module.runNow?.({ action: 'poll' });
    expect(h.router.calls['ajaxSet_Password.php']).toBe(2);
    expect(h.events.some((e) => e.type === 'router_login' && e.severity === 'info')).toBe(true);
  });

  it('waits out a lockout without hammering the login', async () => {
    const h = makeHarness({ password: PW, forceStatus: 'lockout', waitSec: 60 });
    active = h;
    await h.module.runNow?.({ action: 'login' });
    expect(h.events.some((e) => e.type === 'router_login' && e.title.includes('gesperrt'))).toBe(true);
    const posts = h.router.calls['ajaxSet_Password.php'] ?? 0;
    // a scheduled poll during the lockout window must not attempt another login
    await h.module.runNow?.({ action: 'poll' });
    expect(h.router.calls['ajaxSet_Password.php'] ?? 0).toBe(posts);
  });
});
