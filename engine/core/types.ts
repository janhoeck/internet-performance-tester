// Internal engine contracts. Every engine module is written against these interfaces only.
import type { ChildProcess } from 'node:child_process';
import type { AppConfig } from '../../src/lib/shared/config';
import type {
  AdapterSnapshot,
  ClientState,
  DynamicHosts,
  IpFamily,
  MetricPoint,
  ModuleState,
  NetEvent,
  OutageClass,
  Rollup,
  RouterStatus,
  Sample,
  SecondsRollup,
  Snapshot,
  SnapshotKind,
  SpeedtestProgress,
  SpeedtestResult,
  TestSession,
  TracerouteResult,
} from '../../src/lib/shared/types';

// ─── Logging ───────────────────────────────────────────────────────────────

export interface Logger {
  debug(msg: string, data?: unknown): void;
  info(msg: string, data?: unknown): void;
  warn(msg: string, data?: unknown): void;
  error(msg: string, data?: unknown): void;
  child(scope: string): Logger;
}

// ─── Event bus ─────────────────────────────────────────────────────────────

/** 1 Hz link sample of a physical adapter (emitted by the ICMP pinger agent, see §4.5). */
export interface NicTick {
  ts: number;
  name: string;
  up: boolean;
  /** link speed in Mbit/s (null when down/unknown) */
  mbps: number | null;
  rxBytes: number;
  txBytes: number;
  rxErrors: number;
  rxDiscards: number;
  isWifi: boolean;
}

/** 1 Hz egress check (local source address chosen by Windows for internet traffic, no packet sent). */
export interface EgressTick {
  ts: number;
  v4Address: string | null;
  v6Address: string | null;
  /** interface alias owning the address (resolved via the adapters snapshot), null if unknown */
  v4If: string | null;
  v6If: string | null;
}

export interface BusEvents {
  /** every recorded latency sample (after it was queued for persistence) */
  sample: Sample;
  /** physical adapter link state, 1 Hz while a session runs */
  nic: NicTick;
  /** egress interface check, 1 Hz while a session runs */
  egress: EgressTick;
  /** derived connection context, 1 Hz (also streamed to the UI as LiveMessage 'client') */
  client: ClientState;
  /** a configured game process started/stopped */
  gaming: { active: boolean; process: string | null; ts: number };
  /** persisted event (with id) or an updated episode event */
  event: NetEvent;
  metrics: MetricPoint[];
  speedtest: SpeedtestProgress;
  traceroute: TracerouteResult;
  router: RouterStatus;
  adapters: AdapterSnapshot;
  session: TestSession | null;
  /** config after (re)load */
  config: AppConfig;
  dynamicHosts: DynamicHosts;
  /** internal: incident detector signals (used e.g. to trigger an incident traceroute) */
  incident: { kind: 'outage-start' | 'outage-end'; ts: number; classification: OutageClass };
}

export interface Bus {
  on<K extends keyof BusEvents>(type: K, fn: (payload: BusEvents[K]) => void): () => void;
  emit<K extends keyof BusEvents>(type: K, payload: BusEvents[K]): void;
}

// ─── Persistence ───────────────────────────────────────────────────────────

export interface EngineDb {
  readonly path: string;
  /** buffered; flushed in one transaction every ~1 s (and on flush()/close()) */
  addSample(s: Sample): void;
  /** buffered like samples */
  addMetrics(points: MetricPoint[]): void;
  /** immediate. Returns new id, or null when dedupeKey already exists. */
  insertEvent(e: NetEvent): number | null;
  updateEvent(id: number, patch: Partial<Pick<NetEvent, 'endTs' | 'severity' | 'title' | 'details' | 'segment'>>): void;
  /** true if an event with this dedupe key exists */
  hasEvent(dedupeKey: string): boolean;
  insertSnapshot<T>(kind: SnapshotKind, ts: number, data: T): number;
  latestSnapshot<T>(kind: SnapshotKind): Snapshot<T> | null;
  insertSpeedtest(r: SpeedtestResult): number;
  insertTraceroute(r: TracerouteResult): number;
  latestTraceroute(family: IpFamily): TracerouteResult | null;
  upsertRollups(rs: Rollup[]): void;
  /** rollups of all targets since `since` (≤ 24 h – used to warm baselines on start) */
  rollupsSince(since: number): Rollup[];
  upsertSecondsRollups(rs: SecondsRollup[]): void;
  /** persisted classified-seconds row of one minute (seed after an engine restart within that minute) */
  secondsRollupAt(minuteTs: number): SecondsRollup | null;
  /** id of an event by its dedupe key (null if absent) */
  eventIdByDedupeKey(dedupeKey: string): number | null;
  /** raw samples of one target in [from, to) – small ranges only (rollup backfill) */
  samplesBetween(targetId: string, from: number, to: number): Sample[];
  /** minute starts in [since, before) that have samples but no rollup row (backfill after crash) */
  minutesMissingRollup(since: number, before: number, limit: number): { targetId: string; ts: number }[];
  latestSpeedtest(): SpeedtestResult | null;
  createSession(s: Omit<TestSession, 'id'>): TestSession;
  updateSession(id: number, patch: Partial<Omit<TestSession, 'id'>>): void;
  /** latest session with status 'running' (used for auto-resume) */
  runningSession(): TestSession | null;
  getSetting(key: string): string | null;
  setSetting(key: string, value: string | null): void;
  /** retention: delete old rows per config.retention; must run in small chunks */
  purge(cfg: AppConfig['retention'], now: number): void;
  sizeBytes(): number | null;
  flush(): void;
  close(): void;
}

// ─── Windows helpers ───────────────────────────────────────────────────────

/** One long-lived `powershell.exe` process; commands are queued and executed one at a time. */
export interface PowerShellHost {
  readonly available: boolean;
  /** Runs a script that must write exactly one JSON document to the output (use ConvertTo-Json -Compress -Depth 6). */
  json<T = unknown>(script: string, opts?: { timeoutMs?: number }): Promise<T>;
  text(script: string, opts?: { timeoutMs?: number }): Promise<string>;
  dispose(): void;
}

/** Router password storage (DPAPI-encrypted for the current Windows user, setting 'router.password'). */
export interface SecretStore {
  getRouterPassword(): Promise<string | null>;
  setRouterPassword(password: string | null): Promise<void>;
  hasRouterPassword(): boolean;
}

/** Runtime-resolved hosts ($gateway, $isp4, $isp6, $aftr, $router6). */
export interface DynamicHostRegistry {
  get(): DynamicHosts;
  /** update some hosts; emits bus 'dynamicHosts' when something changed */
  set(patch: Partial<DynamicHosts>, source: string): void;
  /**
   * '$gateway' → '192.168.0.1' (or null if unknown); IP literal → itself; hostname → itself
   * (probes resolve hostnames via DNS themselves and cache the IP for ~5 min).
   */
  resolve(host: string): string | null;
}

// ─── Context & modules ─────────────────────────────────────────────────────

export interface EngineContext {
  readonly version: string;
  readonly startedAt: number;
  readonly log: Logger;
  readonly bus: Bus;
  readonly db: EngineDb;
  readonly ps: PowerShellHost;
  readonly hosts: DynamicHostRegistry;
  readonly secrets: SecretStore;
  /** current configuration (always fresh – read it on every tick, don't cache) */
  config(): AppConfig;
  /** running measurement session or null */
  session(): TestSession | null;
  isMeasuring(): boolean;
  /** true while a speed test saturates the line (incident detector ignores this window) */
  speedtestActive(): boolean;
  setSpeedtestActive(active: boolean): void;
  /** true while a configured game process runs (scheduled speed tests are skipped) */
  gamingActive(): boolean;
  /** latest derived connection context (link, egress, own throughput); null before the first tick */
  clientState(): ClientState | null;
  /** interface the running session expects traffic on (from session start), null if unknown */
  expectedInterface(): string | null;

  /** persist (buffered) + publish one latency sample; feeds rollups + incident detection */
  recordSample(s: Sample): void;
  /** persist (buffered) + publish metric points (keys from metrics.ts) */
  recordMetrics(points: MetricPoint[]): void;
  /** persist + publish an event; returns id or null if deduplicated */
  recordEvent(e: NetEvent): number | null;
  /** update an episode event (e.g. set endTs) + publish the updated event */
  updateEvent(id: number, patch: Partial<Pick<NetEvent, 'endTs' | 'severity' | 'title' | 'details' | 'segment'>>): void;
  /** persist a snapshot (JSON) */
  recordSnapshot<T>(kind: SnapshotKind, data: T, ts?: number): void;

  /** register a child process; it is killed (tree) on engine shutdown */
  trackChild(child: ChildProcess): void;
}

/**
 * Lifecycle:
 *  init()  – once at engine start. Always-on collectors (adapter, eventlog, router status, vpn,
 *            route) start their timers here (with relaxed intervals while no session runs).
 *  start() – a measurement session started/resumed: start session timers/probes.
 *  stop()  – session ended or engine shutdown: stop session timers/probes (keep always-on parts).
 *  dispose() – engine shutdown: stop everything, kill children.
 */
export interface EngineModule {
  readonly name: string;
  init?(ctx: EngineContext): Promise<void> | void;
  start?(): Promise<void> | void;
  stop?(): Promise<void> | void;
  dispose?(): Promise<void> | void;
  reconfigure?(cfg: AppConfig): void;
  /** manual trigger from the control API */
  runNow?(params?: Record<string, unknown>): Promise<unknown>;
  state(): ModuleState;
}

/** Helper type for scheduled tasks (traceroute, mtu, stun, speedtest, udp burst, mtr). */
export interface TaskResult<T> {
  ok: boolean;
  result?: T;
  error?: string;
}
