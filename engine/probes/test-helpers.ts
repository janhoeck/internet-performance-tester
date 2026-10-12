// Test utilities for the probe modules (only imported by *.test.ts files): a fake child process,
// a synchronous bus, recording loggers and a minimal EngineContext.
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { type AppConfig, DEFAULT_CONFIG } from '../../src/lib/shared/config';
import type { AdapterSnapshot, ClientState, DynamicHosts, MetricPoint, Sample, SnapshotKind } from '../../src/lib/shared/types';
import type { Bus, BusEvents, DynamicHostRegistry, EngineContext, EngineDb, Logger, PowerShellHost, SecretStore } from '../core/types';

// ─── child processes ───────────────────────────────────────────────────────

/** Minimal stand-in for a spawned ChildProcess (stdout/stderr emit 'data' synchronously). */
export class FakeChild extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  killed = false;
  closed = false;

  constructor(
    readonly command: string,
    readonly args: readonly string[],
    readonly options: SpawnOptions,
    readonly pid: number,
  ) {
    super();
  }

  /** write raw bytes to stdout */
  out(chunk: Uint8Array | string): void {
    this.stdout.emit('data', typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk));
  }

  /** write one JSON line (agent protocol) */
  json(obj: unknown): void {
    this.out(`${JSON.stringify(obj)}\n`);
  }

  err(text: string): void {
    this.stderr.emit('data', Buffer.from(text, 'utf8'));
  }

  /** the process ends on its own */
  exit(code: number | null = 1, signal: string | null = null): void {
    if (this.closed) return;
    this.closed = true;
    this.emit('exit', code, signal);
    this.emit('close', code, signal);
  }

  /** like ChildProcess.kill(): TerminateProcess → close(null, 'SIGTERM') */
  kill(): boolean {
    if (this.killed || this.closed) return false;
    this.killed = true;
    this.exit(null, 'SIGTERM');
    return true;
  }

  asChild(): ChildProcess {
    return this as unknown as ChildProcess;
  }
}

/** spawn() replacement that records every FakeChild it creates. */
export class FakeSpawner {
  readonly children: FakeChild[] = [];
  private nextPid = 1000;
  failNext: Error | null = null;

  readonly spawn = (command: string, args: readonly string[], options: SpawnOptions): ChildProcess => {
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = null;
      throw e;
    }
    const child = new FakeChild(command, args, options, this.nextPid++);
    this.children.push(child);
    return child.asChild();
  };

  get last(): FakeChild {
    const c = this.children[this.children.length - 1];
    if (!c) throw new Error('no child spawned');
    return c;
  }

  alive(): FakeChild[] {
    return this.children.filter((c) => !c.closed);
  }
}

// ─── logging ───────────────────────────────────────────────────────────────

export interface LogLine {
  level: 'debug' | 'info' | 'warn' | 'error';
  scope: string;
  msg: string;
}

/** Logger that records every line (children share the same list). */
export function recordingLogger(lines: LogLine[] = [], scope = 'test'): Logger & { lines: LogLine[] } {
  const add = (level: LogLine['level']) => (msg: string) => {
    lines.push({ level, scope, msg });
  };
  return {
    lines,
    debug: add('debug'),
    info: add('info'),
    warn: add('warn'),
    error: add('error'),
    child: (s: string) => recordingLogger(lines, `${scope}/${s}`),
  };
}

// ─── bus ───────────────────────────────────────────────────────────────────

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

// ─── engine context ────────────────────────────────────────────────────────

export function testConfig(patch?: (cfg: AppConfig) => void): AppConfig {
  const cfg = structuredClone(DEFAULT_CONFIG);
  patch?.(cfg);
  return cfg;
}

/** Hosts registry with the semantics of engine/core/hosts.ts (placeholders, emits 'dynamicHosts'). */
export function fakeHosts(bus: Bus, initial: Partial<DynamicHosts> = {}): DynamicHostRegistry {
  const hosts: DynamicHosts = { gateway: '192.168.0.1', isp4: null, isp6: null, aftr: null, router6: null, ...initial };
  const keys: Record<string, keyof DynamicHosts> = {
    $gateway: 'gateway', $isp4: 'isp4', $isp6: 'isp6', $aftr: 'aftr', $router6: 'router6',
  };
  return {
    get: () => ({ ...hosts }),
    set(patch) {
      let changed = false;
      for (const [k, v] of Object.entries(patch) as [keyof DynamicHosts, string | null | undefined][]) {
        if (v === undefined || hosts[k] === v) continue;
        hosts[k] = v;
        changed = true;
      }
      if (changed) bus.emit('dynamicHosts', { ...hosts });
    },
    resolve(host) {
      const h = host.trim();
      if (h.startsWith('$')) {
        const key = keys[h];
        return key ? hosts[key] : null;
      }
      return h === '' ? null : h;
    },
  };
}

export interface FakeProbeContext {
  ctx: EngineContext;
  bus: TestBus;
  log: Logger & { lines: LogLine[] };
  samples: Sample[];
  metrics: MetricPoint[];
  children: ChildProcess[];
  setConfig(cfg: AppConfig): void;
  setSpeedtest(active: boolean): void;
  setClient(state: ClientState | null): void;
  setExpectedIf(name: string | null): void;
  /** value returned by db.latestSnapshot('adapters') */
  setAdaptersSnapshot(snap: AdapterSnapshot | null): void;
}

export function fakeProbeContext(opts: { config?: AppConfig; hosts?: Partial<DynamicHosts> } = {}): FakeProbeContext {
  const bus = new TestBus();
  const log = recordingLogger([], 'probes');
  let cfg = opts.config ?? testConfig();
  let speedtest = false;
  let client: ClientState | null = null;
  let expectedIf: string | null = null;
  let adapters: AdapterSnapshot | null = null;
  const samples: Sample[] = [];
  const metrics: MetricPoint[] = [];
  const children: ChildProcess[] = [];
  const db = {
    path: ':memory:',
    latestSnapshot: (kind: SnapshotKind) => (kind === 'adapters' && adapters ? { ts: adapters.ts, kind, data: adapters } : null),
  } as unknown as EngineDb;
  const notAvailable = () => {
    throw new Error('not available in tests');
  };
  const ctx: EngineContext = {
    version: 'test',
    startedAt: 0,
    log,
    bus,
    db,
    ps: { available: false, json: notAvailable, text: notAvailable, dispose: () => undefined } as unknown as PowerShellHost,
    hosts: fakeHosts(bus, opts.hosts),
    secrets: {} as SecretStore,
    config: () => cfg,
    session: () => null,
    isMeasuring: () => true,
    speedtestActive: () => speedtest,
    setSpeedtestActive: (a) => {
      speedtest = a;
    },
    gamingActive: () => false,
    clientState: () => client,
    expectedInterface: () => expectedIf,
    recordSample: (s) => {
      samples.push(s);
      bus.emit('sample', s);
    },
    recordMetrics: (points) => {
      metrics.push(...points);
      bus.emit('metrics', points);
    },
    recordEvent: () => null,
    updateEvent: () => undefined,
    recordSnapshot: () => undefined,
    trackChild: (c) => {
      children.push(c);
    },
  };
  return {
    ctx,
    bus,
    log,
    samples,
    metrics,
    children,
    setConfig: (c) => {
      cfg = c;
    },
    setSpeedtest: (a) => {
      speedtest = a;
    },
    setClient: (s) => {
      client = s;
    },
    setExpectedIf: (n) => {
      expectedIf = n;
    },
    setAdaptersSnapshot: (s) => {
      adapters = s;
    },
  };
}

/** Flush pending promise callbacks (several microtask turns). */
export async function flushPromises(turns = 10): Promise<void> {
  for (let i = 0; i < turns; i++) await Promise.resolve();
}
