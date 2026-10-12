// Test utilities for the analysis/aggregate modules: sample builders, a synchronous test bus,
// an in-memory EngineDb and a minimal EngineContext. Only imported by *.test.ts files.
import { type AppConfig, DEFAULT_CONFIG } from '../../src/lib/shared/config';
import {
  type ClientState,
  type DynamicHosts,
  type NetEvent,
  type Rollup,
  type Sample,
  SampleStatus,
  type SampleStatusCode,
  type SecondsRollup,
  type TestSession,
} from '../../src/lib/shared/types';
import type { Bus, BusEvents, EngineContext, EngineDb, Logger } from '../core/types';

/** 2026-10-09 (a whole minute) */
export const T0 = 1_791_550_560_000;

export function testConfig(patch?: (cfg: AppConfig) => void): AppConfig {
  const cfg = structuredClone(DEFAULT_CONFIG);
  patch?.(cfg);
  return cfg;
}

export function ok(targetId: string, ts: number, rtt: number, flags = 0): Sample {
  return { targetId, ts, rtt, status: SampleStatus.OK, flags };
}

export function lost(targetId: string, ts: number, status: SampleStatusCode = SampleStatus.TIMEOUT, flags = 0): Sample {
  return { targetId, ts, rtt: null, status, flags };
}

export function clientState(ts: number, patch: Partial<ClientState> = {}): ClientState {
  return {
    ts,
    expectedIf: 'Ethernet',
    egressV4If: 'Ethernet',
    egressV6If: 'Ethernet',
    egressV4Address: '192.168.0.192',
    egressV6Address: '3fff:8071:7ca0:c980::192',
    onExpected: true,
    linkUp: true,
    linkMbps: 1000,
    rxMbps: 0.2,
    txMbps: 0.1,
    gaming: false,
    preventSleep: true,
    ...patch,
  };
}

/** default reference targets of one healthy pinger round */
export const ROUND_RTT: Record<string, number> = {
  gw: 1,
  gw6: 1,
  isp6: 12,
  aftr: 15,
  isp4: 16,
  cf4: 18,
  cf6: 17,
  g4: 19,
  g6: 18,
};

/** per-target override of a round: number = RTT, null = lost, undefined = healthy default */
export type RoundOverride = Partial<Record<string, number | null>>;

/** one pinger round: healthy RTTs, overridden per target */
export function round(ts: number, override: RoundOverride = {}): Sample[] {
  const out: Sample[] = [];
  const ids = new Set([...Object.keys(ROUND_RTT), ...Object.keys(override)]);
  for (const id of ids) {
    const o = override[id];
    const v: number | null | undefined = o === undefined ? ROUND_RTT[id] : o;
    if (v === undefined) continue;
    out.push(v === null ? lost(id, ts) : ok(id, ts, v));
  }
  return out;
}

type Handler<K extends keyof BusEvents> = (payload: BusEvents[K]) => void;

export class TestBus implements Bus {
  private readonly handlers = new Map<keyof BusEvents, Set<(payload: unknown) => void>>();
  readonly emitted: { type: keyof BusEvents; payload: unknown }[] = [];

  on<K extends keyof BusEvents>(type: K, fn: Handler<K>): () => void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    const h = fn as (payload: unknown) => void;
    set.add(h);
    return () => {
      set.delete(h);
    };
  }

  emit<K extends keyof BusEvents>(type: K, payload: BusEvents[K]): void {
    this.emitted.push({ type, payload });
    for (const h of [...(this.handlers.get(type) ?? [])]) h(payload);
  }

  listeners(type: keyof BusEvents): number {
    return this.handlers.get(type)?.size ?? 0;
  }

  payloads<K extends keyof BusEvents>(type: K): BusEvents[K][] {
    return this.emitted.filter((e) => e.type === type).map((e) => e.payload as BusEvents[K]);
  }
}

export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
};

const MINUTE = 60_000;

/**
 * In-memory EngineDb with the same semantics as engine/db/engine-db.ts for the parts the
 * analysis modules use (samples, rollups, seconds_1m, events, purge calls).
 */
export class MemoryDb implements EngineDb {
  readonly path = ':memory:';
  readonly samples = new Map<string, Sample>();
  readonly rollups = new Map<string, Rollup>();
  readonly seconds = new Map<number, SecondsRollup>();
  readonly events: (NetEvent & { id: number })[] = [];
  readonly settings = new Map<string, string>();
  readonly purges: { cfg: AppConfig['retention']; now: number }[] = [];
  /** called inside purge() – e.g. to advance a fake clock (simulates a slow purge) */
  onPurge: (() => void) | null = null;
  upsertRollupCalls = 0;
  upsertSecondsCalls = 0;
  missingQueries = 0;

  addSample(s: Sample): void {
    const key = `${s.targetId}|${s.ts}`;
    if (!this.samples.has(key)) this.samples.set(key, { ...s, flags: s.flags ?? 0 });
  }
  addMetrics(): void {}
  insertEvent(e: NetEvent): number | null {
    if (e.dedupeKey && this.events.some((x) => x.dedupeKey === e.dedupeKey)) return null;
    const id = this.events.length + 1;
    this.events.push({ ...e, id });
    return id;
  }
  updateEvent(id: number, patch: Partial<Pick<NetEvent, 'endTs' | 'severity' | 'title' | 'details' | 'segment'>>): void {
    const e = this.events.find((x) => x.id === id);
    if (!e) return;
    if (patch.endTs !== undefined) e.endTs = patch.endTs;
    if (patch.severity !== undefined) e.severity = patch.severity;
    if (patch.title !== undefined) e.title = patch.title;
    if (patch.details !== undefined) e.details = patch.details;
    if (patch.segment !== undefined) e.segment = patch.segment;
  }
  hasEvent(dedupeKey: string): boolean {
    return this.events.some((x) => x.dedupeKey === dedupeKey);
  }
  eventIdByDedupeKey(dedupeKey: string): number | null {
    return this.events.find((x) => x.dedupeKey === dedupeKey)?.id ?? null;
  }
  insertSnapshot(): number {
    return 0;
  }
  latestSnapshot(): null {
    return null;
  }
  insertSpeedtest(): number {
    return 0;
  }
  insertTraceroute(): number {
    return 0;
  }
  latestTraceroute(): null {
    return null;
  }
  upsertRollups(rs: Rollup[]): void {
    if (rs.length > 0) this.upsertRollupCalls++;
    for (const r of rs) this.rollups.set(`${r.targetId}|${r.ts}`, { ...r, hist: [...r.hist] });
  }
  rollupsSince(since: number): Rollup[] {
    return [...this.rollups.values()].filter((r) => r.ts >= since).sort((a, b) => a.ts - b.ts);
  }
  upsertSecondsRollups(rs: SecondsRollup[]): void {
    if (rs.length > 0) this.upsertSecondsCalls++;
    for (const r of rs) this.seconds.set(r.ts, { ...r });
  }
  secondsRollupAt(minuteTs: number): SecondsRollup | null {
    const r = this.seconds.get(minuteTs);
    return r ? { ...r } : null;
  }
  samplesBetween(targetId: string, from: number, to: number): Sample[] {
    return [...this.samples.values()]
      .filter((s) => s.targetId === targetId && s.ts >= from && s.ts < to)
      .sort((a, b) => a.ts - b.ts);
  }
  minutesMissingRollup(since: number, before: number, limit: number): { targetId: string; ts: number }[] {
    this.missingQueries++;
    const out = new Map<string, { targetId: string; ts: number }>();
    for (const s of this.samples.values()) {
      if (s.ts < since || s.ts >= before) continue;
      const ts = Math.floor(s.ts / MINUTE) * MINUTE;
      const key = `${s.targetId}|${ts}`;
      if (!this.rollups.has(key)) out.set(key, { targetId: s.targetId, ts });
    }
    return [...out.values()].slice(0, limit);
  }
  latestSpeedtest(): null {
    return null;
  }
  createSession(s: Omit<TestSession, 'id'>): TestSession {
    return { ...s, id: 1 };
  }
  updateSession(): void {}
  runningSession(): TestSession | null {
    return null;
  }
  getSetting(key: string): string | null {
    return this.settings.get(key) ?? null;
  }
  setSetting(key: string, value: string | null): void {
    if (value === null) this.settings.delete(key);
    else this.settings.set(key, value);
  }
  purge(cfg: AppConfig['retention'], now: number): void {
    this.purges.push({ cfg, now });
    this.onPurge?.();
  }
  sizeBytes(): number | null {
    return null;
  }
  flush(): void {}
  close(): void {}
}

export interface FakeContextOptions {
  db: EngineDb;
  config?: AppConfig;
  clientState?: () => ClientState | null;
  speedtestActive?: () => boolean;
  hosts?: DynamicHosts;
  log?: Logger;
}

export interface FakeContext {
  ctx: EngineContext;
  bus: TestBus;
  /** events passed to recordEvent (with id) */
  events: NetEvent[];
  updates: { id: number; patch: Partial<NetEvent> }[];
  setConfig(cfg: AppConfig): void;
}

/** Minimal EngineContext: recordSample/recordEvent persist to `db` and publish on the bus. */
export function fakeContext(opts: FakeContextOptions): FakeContext {
  const bus = new TestBus();
  let cfg = opts.config ?? testConfig();
  let speedtest = false;
  const events: NetEvent[] = [];
  const updates: { id: number; patch: Partial<NetEvent> }[] = [];
  const hosts: DynamicHosts = opts.hosts ?? { gateway: '192.168.0.1', isp4: null, isp6: null, aftr: null, router6: null };
  const ctx: EngineContext = {
    version: 'test',
    startedAt: Date.now(),
    log: opts.log ?? silentLogger,
    bus,
    db: opts.db,
    ps: {
      available: false,
      json: () => Promise.reject(new Error('no powershell in tests')),
      text: () => Promise.reject(new Error('no powershell in tests')),
      dispose: () => {},
    },
    hosts: { get: () => ({ ...hosts }), set: () => {}, resolve: (h) => h },
    secrets: { getRouterPassword: () => Promise.resolve(null), setRouterPassword: () => Promise.resolve(), hasRouterPassword: () => false },
    config: () => cfg,
    session: () => null,
    isMeasuring: () => true,
    speedtestActive: () => (opts.speedtestActive ? opts.speedtestActive() : speedtest),
    setSpeedtestActive: (a) => {
      speedtest = a;
    },
    gamingActive: () => false,
    clientState: () => (opts.clientState ? opts.clientState() : null),
    expectedInterface: () => 'Ethernet',
    recordSample: (s) => {
      opts.db.addSample(s);
      bus.emit('sample', s);
    },
    recordMetrics: (points) => {
      opts.db.addMetrics(points);
      bus.emit('metrics', points);
    },
    recordEvent: (e) => {
      const id = opts.db.insertEvent(e);
      if (id === null) return null;
      const withId = { ...e, id };
      events.push(withId);
      bus.emit('event', withId);
      return id;
    },
    updateEvent: (id, patch) => {
      opts.db.updateEvent(id, patch);
      updates.push({ id, patch });
    },
    recordSnapshot: (kind, data, ts) => {
      opts.db.insertSnapshot(kind, ts ?? Date.now(), data);
    },
    trackChild: () => {},
  };
  return {
    ctx,
    bus,
    events,
    updates,
    setConfig: (c) => {
      cfg = c;
      bus.emit('config', c);
    },
  };
}
