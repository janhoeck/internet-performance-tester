// Module-local types of the diagnosis (N-diagnosis). DiagnosisInput is everything the pure rules
// need; it is built from SQLite by input.ts (bounded queries) or synthetically in unit tests.
import type { HostOs } from '../../shared/platform';
import type { AppConfig } from '../../shared/config';
import type {
  AdapterSnapshot,
  DocsisSnapshot,
  EventType,
  Finding,
  IpFamily,
  LinkEventDay,
  MtuResult,
  NatResult,
  NetEvent,
  ProbeKind,
  RouterStatus,
  SecondsRollup,
  Segment,
  SpeedtestResult,
  TestSession,
  TracerouteResult,
  VpnInfo,
  WlanInfo,
} from '../../shared/types';

/** Merged latency statistics of one target (or target group) over a set of minutes. */
export interface StatsSummary {
  sent: number;
  lost: number;
  lossPct: number | null;
  min: number | null;
  avg: number | null;
  max: number | null;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  /** MASD jitter (ms) */
  jitter: number | null;
  spikes: number;
  /** samples above 200 ms (histogram-exact at the 200 ms bucket bound) */
  over200: number;
  /** minutes with at least one sample */
  minutes: number;
}

export interface TargetMeta {
  id: string;
  name: string;
  host: string;
  segment: Segment;
  family: IpFamily;
  kind: ProbeKind;
  pairId: string | null;
  enabled: boolean;
}

/** Pseudo target ids for merged groups (enabled targets of the current config). */
export type GroupId = '@internet' | '@internet4' | '@internet6' | '@game';
export const GROUP_IDS: readonly GroupId[] = ['@internet', '@internet4', '@internet6', '@game'];

/** Per local day: evening (19–23 h), baseline (03–17 h) and whole-day stats. */
export interface DayPeriods {
  /** YYYY-MM-DD (local) */
  day: string;
  /** local midnight, epoch ms */
  dayStart: number;
  evening: StatsSummary;
  base: StatsSummary;
  all: StatsSummary;
}

/** Evening/baseline stats merged over all days in range. */
export interface PeriodTotals {
  evening: StatsSummary;
  base: StatsSummary;
}

/** 15-minute window of one target (IPv4/IPv6 pair comparison). */
export interface WindowStat {
  /** window start, epoch ms (multiple of 15 min) */
  ts: number;
  sent: number;
  lost: number;
  lossPct: number | null;
  p50: number | null;
  p95: number | null;
}

/** One clock hour of the gateway target (stable minutes only). */
export interface HourStat {
  ts: number;
  sent: number;
  lost: number;
  lossPct: number | null;
  p99: number | null;
}

/** Sums of classified seconds (seconds_1m) over a period. `bad` = covered − good. */
export interface SecondsTotals extends Omit<SecondsRollup, 'ts'> {
  minutes: number;
  bad: number;
}

export interface SecondsDay {
  /** YYYY-MM-DD (local) */
  day: string;
  /** local midnight, epoch ms */
  dayStart: number;
  covered: number;
  bad: number;
  es: number;
}

/** Per 15-minute window: covered seconds and seconds in which the link/LAN was the problem. */
export interface SecondsWindow {
  ts: number;
  covered: number;
  link: number;
  lan: number;
}

/** Errored seconds in minutes with own high load (self-load ≥ threshold) vs. other minutes. */
export interface LoadCorrelation {
  /** minutes counted as "under own load" */
  loadMinutes: number;
  esLoad: number;
  coveredLoad: number;
  esIdle: number;
  coveredIdle: number;
}

export type LinkCause = 'boot' | 'pre_sleep' | 'router_reboot' | 'runtime' | 'unknown';

/** A NIC link-down from the Windows event log (incl. imported history). */
export interface LinkDrop {
  id: number | null;
  ts: number;
  /** matching link-up (if known) */
  endTs: number | null;
  cause: LinkCause;
  /** speed after the relink (Mbit/s) */
  relinkMbps: number | null;
  downtimeMs: number | null;
  /** WLAN connected within 5 s after the drop (null = unknown) */
  wlanFailover: boolean | null;
}

export interface LinkSpeedInfo {
  /** latest known link speed of the primary adapter (Mbit/s) */
  currentMbps: number | null;
  currentTs: number | null;
  /** time in range with a link below 1 Gbit/s (from metric nic.link_mbps) */
  msBelow1g: number;
  /** time in range covered by nic.link_mbps points */
  msObserved: number;
  minMbps: number | null;
}

export interface MetricSummary {
  key: string;
  count: number;
  avg: number | null;
  min: number | null;
  max: number | null;
  /** only computed for a few keys */
  p95: number | null;
  /** latest value before `to` (may be older than `from`) */
  last: number | null;
  lastTs: number | null;
}

export type ChangeKind = 'driver' | 'firmware' | 'note' | 'vpn' | 'config' | 'session';

/** A configuration change / journal entry that may explain a before/after difference. */
export interface ChangeMarker {
  ts: number;
  kind: ChangeKind;
  /** German description, e.g. 'Treiber Ethernet: 1.1.4.43 → 2.1.5.12' */
  label: string;
}

export interface VpnState {
  ts: number;
  connected: boolean | null;
  splitTunnel: 'include' | 'exclude' | null;
}

/** Internet reference latency with the VPN (WARP) connected vs. disconnected (stable minutes). */
export interface VpnCompare {
  on: StatsSummary;
  off: StatsSummary;
  /** wall-clock time covered by each side (15-min buckets without a state change) */
  onMs: number;
  offMs: number;
}

export interface CoverageInfo {
  rangeMs: number;
  /** seconds with a heartbeat (seconds_1m) or minutes with ICMP data × 60 when no classification exists */
  coveredSeconds: number;
  /** 0..100 */
  coveragePct: number;
  hasSeconds: boolean;
  firstTs: number | null;
  lastTs: number | null;
  /** local days with ≥ 1 h of coverage */
  daysCovered: number;
  /** total latency samples (all targets) */
  samples: number;
  gaps: { count: number; totalMs: number; longestMs: number };
  /** start of the detailed (minute/rollup based) analysis – later than `from` for very long ranges */
  analysisFrom: number;
}

export interface DiagnosisEvents {
  /** exact counts per type in [from, to) */
  counts: Partial<Record<EventType, number>>;
  /** events per type in [from, to), ascending, limited per type (see truncated) */
  byType: Partial<Record<EventType, NetEvent[]>>;
  /** types whose list hit the limit */
  truncated: EventType[];
}

export interface DiagnosisInput {
  from: number;
  to: number;
  /** generation time */
  now: number;
  /** OS of the measuring PC – wording of explanations/recommendations (undefined = Windows) */
  os?: HostOs;
  config: AppConfig;
  /** all configured targets (enabled + disabled) */
  targets: TargetMeta[];
  /** per target id and group id: stats over the range, speed-test minutes excluded */
  stats: Record<string, StatsSummary>;
  /** same, but also without minutes with link problems or own high load ("bei stehendem Link") */
  statsStable: Record<string, StatsSummary>;
  /** only minutes overlapping speed tests (loaded latency per segment) */
  loadStats: Record<string, StatsSummary>;
  // hourly / daily / periods / windows / lanHours use the "stable" minutes (statsStable), so the
  // PC's own downloads and link drops do not masquerade as evening congestion or IPv4 problems.
  /** per target/group: 24 entries, local hour of day */
  hourly: Record<string, StatsSummary[]>;
  /** per target/group: per local day evening/baseline (ascending) */
  daily: Record<string, DayPeriods[]>;
  /** per target/group: evening/baseline merged over all days */
  periods: Record<string, PeriodTotals>;
  /** 15-min windows (ascending) for ICMP dual-stack pair targets and the gateway */
  windows: Record<string, WindowStat[]>;
  /** gateway per clock hour (stable minutes) */
  lanHours: HourStat[];
  seconds: SecondsTotals | null;
  /** 24 entries (local hour of day) */
  secondsHourly: SecondsTotals[];
  secondsDaily: SecondsDay[];
  secondsWindows: SecondsWindow[];
  /** errored seconds per covered minute, ascending (periodicity analysis) */
  esPerMinute: { ts: number; es: number; covered: number }[];
  loadCorrelation: LoadCorrelation | null;
  events: DiagnosisEvents;
  /** start times of latency spike episodes (bounded) */
  spikeTimes: { ts: number; targetId: string | null }[];
  /** NIC link-downs in [linkFrom, to), ascending */
  linkDrops: LinkDrop[];
  linkFrom: number;
  /** per-day link event counts (imported history) */
  linkDays: LinkEventDay[];
  linkSpeed: LinkSpeedInfo;
  /** speed tests in range, ascending, without series */
  speedtests: SpeedtestResult[];
  traceroutes: {
    latest4: TracerouteResult | null;
    latest6: TracerouteResult | null;
    count: number;
    changed: number;
  };
  router: RouterStatus | null;
  routerTs: number | null;
  docsis: DocsisSnapshot | null;
  docsisTs: number | null;
  adapters: AdapterSnapshot | null;
  wlan: WlanInfo | null;
  vpn: VpnInfo | null;
  nat: NatResult[];
  mtu: MtuResult[];
  metrics: Record<string, MetricSummary>;
  changes: ChangeMarker[];
  vpnTimeline: VpnState[];
  /** null when there are not enough buckets with a known VPN state on both sides */
  vpnCompare: VpnCompare | null;
  sessions: TestSession[];
  coverage: CoverageInfo;
}

/** Rule signature: pure, never throws for well-formed input. */
export type Rule = (input: DiagnosisInput) => Finding | null;

export interface RuleDef {
  /** 'R01' … 'R20' */
  code: string;
  /** Finding.id */
  id: string;
  run: Rule;
}
