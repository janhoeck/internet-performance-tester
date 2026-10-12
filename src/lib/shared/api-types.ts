// Response shapes of the Next.js API routes (src/app/api/**). UI code imports these types;
// route handlers must return exactly these shapes (JSON). Errors: HTTP 4xx/5xx + ApiError.
import type { AppConfig } from './config';
import type {
  AdapterSnapshot,
  ControlResponse,
  DiagnosisReport,
  EngineStatus,
  LinkEventDay,
  MtuResult,
  NatResult,
  NetEvent,
  RouterLogEntry,
  RouterStatus,
  SecondsRollup,
  SpeedtestResult,
  TargetStats,
  TestSession,
  TracerouteResult,
  VpnInfo,
  WlanInfo,
} from './types';

export interface ApiError {
  error: string;
}

/** Config as exposed to the browser: the router password is never included. */
export type PublicConfig = Omit<AppConfig, 'router'> & {
  router: AppConfig['router'] & { hasPassword: boolean };
};

/** GET /api/status */
export interface StatusResponse {
  now: number;
  engineOnline: boolean;
  engine: EngineStatus | null;
  engineError: string | null;
  db: {
    path: string;
    sizeBytes: number | null;
    firstSampleTs: number | null;
    lastSampleTs: number | null;
  };
  config: PublicConfig;
}

/** GET /api/config → ConfigResponse; PUT /api/config (body: DeepPartial<AppConfig> & { routerPassword?: string | null }) → ConfigResponse */
export interface ConfigResponse {
  config: PublicConfig;
  /** set when the engine could not be notified (config is still saved) */
  warning?: string | null;
}

/** POST /api/control (body: ControlRequest) */
export type ControlApiResponse = ControlResponse;

/**
 * GET /api/series?targets=gw,cf4&from=<ms>&to=<ms>[&step=<ms>]
 * Raw samples are bucketed when to-from ≤ 3 h (step default: auto ≥ 1 s), rollups otherwise
 * (step multiple of 60 s, auto so that ≤ ~1500 points per series).
 */
export interface SeriesResponse {
  from: number;
  to: number;
  stepMs: number;
  source: 'raw' | 'rollup';
  series: Record<string, SeriesData>;
}

export interface SeriesData {
  ts: number[];
  avg: (number | null)[];
  min: (number | null)[];
  max: (number | null)[];
  p95: (number | null)[];
  /** loss % in bucket (null when no samples) */
  lossPct: (number | null)[];
  sent: number[];
}

/** GET /api/samples?target=cf4&from&to[&limit=20000] – raw samples, ascending */
export interface SamplesResponse {
  targetId: string;
  ts: number[];
  rtt: (number | null)[];
  status: number[];
  truncated: boolean;
}

/** GET /api/stats?from&to[&targets=a,b][&excludeSpeedtests=1] */
export interface StatsResponse {
  from: number;
  to: number;
  excludeSpeedtests: boolean;
  stats: TargetStats[];
}

/** GET /api/heatmap?target=cf4&metric=p95|avg|loss|spikes&days=14 (local time, hour of day 0..23) */
export interface HeatmapResponse {
  targetId: string;
  metric: 'p95' | 'avg' | 'loss' | 'spikes';
  /** YYYY-MM-DD, oldest first */
  days: string[];
  /** values[dayIndex][hour] */
  values: (number | null)[][];
  /** measured minutes per cell in % (cells with low coverage should be hatched) */
  coverage?: number[][];
}

/** GET /api/events?from&to[&types=a,b][&severity=warn,critical][&limit=500][&offset=0] – newest first */
export interface EventsResponse {
  events: NetEvent[];
  total: number;
}

/** POST /api/events → 201 with the created note event */
export interface NoteResponse {
  ok: true;
  id: number;
  event: NetEvent;
}

/** GET /api/metrics?keys=a,b&from&to[&step] – bucketed with the metric's aggregation */
export interface MetricsResponse {
  from: number;
  to: number;
  stepMs: number;
  series: Record<string, { ts: number[]; value: (number | null)[] }>;
}

/** GET /api/speedtests?from&to[&limit=200] – newest first, `series` omitted (empty array) */
export interface SpeedtestsResponse {
  items: SpeedtestResult[];
}
/** GET /api/speedtests/[id] – full result incl. series */
export type SpeedtestDetailResponse = SpeedtestResult;

/** GET /api/traceroutes?[family=4|6][&limit=50] – newest first */
export interface TraceroutesResponse {
  items: TracerouteResult[];
}

/** GET /api/path – latest MTU + NAT results per family */
export interface PathResponse {
  mtu: MtuResult[];
  nat: NatResult[];
}

/** GET /api/router?from&to */
export interface RouterResponse {
  status: RouterStatus | null;
  /** DOCSIS summary history from metrics (columnar) */
  docsisHistory: {
    ts: number[];
    dsPowerMin: (number | null)[];
    dsPowerMax: (number | null)[];
    dsSnrMin: (number | null)[];
    usPowerMin: (number | null)[];
    usPowerMax: (number | null)[];
    corrDelta: (number | null)[];
    uncorrDelta: (number | null)[];
  };
  /** router event log entries (newest first, from snapshots/events) */
  log: RouterLogEntry[];
  /** router HTTP response time + reachability history */
  httpHistory: { ts: number[]; ms: (number | null)[] };
}

/** GET /api/client?from&to */
export interface ClientResponse {
  adapters: AdapterSnapshot | null;
  wlan: WlanInfo | null;
  vpn: VpnInfo | null;
  /** per-day NIC link event counts (all imported history, local days) */
  linkDays: LinkEventDay[];
  /** latest NIC link events in range (newest first, max 500) */
  linkEvents: NetEvent[];
  /** link-drop KPIs (only `details.cause = 'runtime'` drops count as faults) */
  linkSummary: {
    runtimeDrops24h: number;
    runtimeDrops7d: number;
    bootRelinks: number;
    /** share of relinks (boot + runtime) that came up below 1 Gbit/s, in % (null if none) */
    relinkBelow1gPct: number | null;
    wlanFailovers24h: number;
    lastDropTs: number | null;
  };
}

/** GET /api/seconds?from&to[&step] – classified seconds bucketed (step ≥ 60 s), plus totals */
export interface SecondsResponse {
  from: number;
  to: number;
  stepMs: number;
  buckets: SecondsRollup[];
  total: SecondsRollup;
}

/** GET /api/sessions */
export interface SessionsResponse {
  items: TestSession[];
  active: TestSession | null;
}

/** GET /api/diagnosis?from&to */
export type DiagnosisResponse = DiagnosisReport;

/**
 * GET /api/export?kind=samples|rollups|events|speedtests|traceroutes|metrics|report&format=csv|json&from&to[&targets]
 * → file download (Content-Disposition attachment).
 */
export type ExportKind = 'samples' | 'rollups' | 'events' | 'speedtests' | 'traceroutes' | 'metrics' | 'report';
