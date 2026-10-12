// Row ⇄ domain mappers for the SQLite schema (schema.ts). Used by the engine writer and the
// Next server reader so that encodings (JSON, histograms, booleans) stay identical.
import { decodeHistogram, encodeHistogram } from '../stats';
import type {
  EventSource,
  EventType,
  IpFamily,
  NetEvent,
  Rollup,
  SecondsRollup,
  Segment,
  Severity,
  SessionStatus,
  Snapshot,
  SnapshotKind,
  SpeedtestResult,
  TestSession,
  TraceHop,
  TracerouteResult,
} from '../types';

export type SqlValue = string | number | null;

export function parseJson<T>(s: unknown, fallback: T): T {
  if (typeof s !== 'string' || s === '') return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : v == null ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const str = (v: unknown): string | null => (v == null ? null : String(v));

// ─── rollup_1m ─────────────────────────────────────────────────────────────

export const ROLLUP_COLUMNS = 'target_id, ts, sent, lost, min, avg, max, p50, p95, p99, jitter, stddev, spikes, hist';

export function rollupToParams(r: Rollup): SqlValue[] {
  return [r.targetId, r.ts, r.sent, r.lost, r.min, r.avg, r.max, r.p50, r.p95, r.p99, r.jitter, r.stddev, r.spikes, encodeHistogram(r.hist)];
}

export function rowToRollup(row: Record<string, unknown>): Rollup {
  return {
    targetId: String(row.target_id),
    ts: Number(row.ts),
    sent: Number(row.sent),
    lost: Number(row.lost),
    min: num(row.min),
    avg: num(row.avg),
    max: num(row.max),
    p50: num(row.p50),
    p95: num(row.p95),
    p99: num(row.p99),
    jitter: num(row.jitter),
    stddev: num(row.stddev),
    spikes: Number(row.spikes ?? 0),
    hist: decodeHistogram(str(row.hist)),
  };
}

// ─── seconds_1m ────────────────────────────────────────────────────────────

export const SECONDS_COLUMNS = 'ts, covered, good, link, lan, access, aftr, backbone, remote, unknown, es, ses, self_load';

export function secondsToParams(s: SecondsRollup): SqlValue[] {
  return [s.ts, s.covered, s.good, s.link, s.lan, s.access, s.aftr, s.backbone, s.remote, s.unknown, s.es, s.ses, s.selfLoad];
}

export function rowToSeconds(row: Record<string, unknown>): SecondsRollup {
  const n = (k: string) => Number(row[k] ?? 0);
  return {
    ts: n('ts'), covered: n('covered'), good: n('good'), link: n('link'), lan: n('lan'), access: n('access'),
    aftr: n('aftr'), backbone: n('backbone'), remote: n('remote'), unknown: n('unknown'), es: n('es'), ses: n('ses'),
    selfLoad: n('self_load'),
  };
}

// ─── events ────────────────────────────────────────────────────────────────

export const EVENT_COLUMNS = 'ts, end_ts, type, severity, segment, title, details, source, dedupe_key';

export function eventToParams(e: NetEvent): SqlValue[] {
  return [
    e.ts,
    e.endTs ?? null,
    e.type,
    e.severity,
    e.segment ?? null,
    e.title,
    e.details ? JSON.stringify(e.details) : null,
    e.source,
    e.dedupeKey ?? null,
  ];
}

export function rowToEvent(row: Record<string, unknown>): NetEvent {
  return {
    id: Number(row.id),
    ts: Number(row.ts),
    endTs: num(row.end_ts),
    type: String(row.type) as EventType,
    severity: String(row.severity) as Severity,
    segment: (str(row.segment) as Segment | null) ?? null,
    title: String(row.title),
    details: parseJson<Record<string, unknown> | null>(row.details, null),
    source: String(row.source) as EventSource,
    dedupeKey: str(row.dedupe_key),
  };
}

// ─── sessions ──────────────────────────────────────────────────────────────

export function rowToSession(row: Record<string, unknown>): TestSession {
  return {
    id: Number(row.id),
    startedAt: Number(row.started_at),
    endedAt: num(row.ended_at),
    plannedEndAt: num(row.planned_end_at),
    label: str(row.label),
    status: String(row.status) as SessionStatus,
    note: str(row.note),
  };
}

// ─── snapshots ─────────────────────────────────────────────────────────────

export function rowToSnapshot<T = unknown>(row: Record<string, unknown>): Snapshot<T> {
  return {
    id: Number(row.id),
    ts: Number(row.ts),
    kind: String(row.kind) as SnapshotKind,
    data: parseJson<T>(row.data, null as T),
  };
}

// ─── speedtests ────────────────────────────────────────────────────────────

export const SPEEDTEST_COLUMNS =
  'ts, end_ts, trigger, server, down_mbps, up_mbps, idle_latency_ms, idle_jitter_ms, loaded_down_latency_ms, loaded_down_p95_ms, loaded_up_latency_ms, loaded_up_p95_ms, bloat_down_ms, bloat_up_ms, grade, bytes_down, bytes_up, streams, nic_link_mbps, error, series';

export function speedtestToParams(s: SpeedtestResult): SqlValue[] {
  return [
    s.ts, s.endTs, s.trigger, s.server, s.downMbps, s.upMbps, s.idleLatencyMs, s.idleJitterMs,
    s.loadedDownLatencyMs, s.loadedDownP95Ms, s.loadedUpLatencyMs, s.loadedUpP95Ms,
    s.bloatDownMs, s.bloatUpMs, s.grade, s.bytesDown, s.bytesUp, s.streams, s.nicLinkMbps,
    s.error, JSON.stringify(s.series ?? []),
  ];
}

export function rowToSpeedtest(row: Record<string, unknown>, withSeries = true): SpeedtestResult {
  return {
    id: Number(row.id),
    ts: Number(row.ts),
    endTs: Number(row.end_ts),
    trigger: String(row.trigger) as SpeedtestResult['trigger'],
    server: str(row.server),
    downMbps: num(row.down_mbps),
    upMbps: num(row.up_mbps),
    idleLatencyMs: num(row.idle_latency_ms),
    idleJitterMs: num(row.idle_jitter_ms),
    loadedDownLatencyMs: num(row.loaded_down_latency_ms),
    loadedDownP95Ms: num(row.loaded_down_p95_ms),
    loadedUpLatencyMs: num(row.loaded_up_latency_ms),
    loadedUpP95Ms: num(row.loaded_up_p95_ms),
    bloatDownMs: num(row.bloat_down_ms),
    bloatUpMs: num(row.bloat_up_ms),
    grade: (str(row.grade) as SpeedtestResult['grade']) ?? null,
    bytesDown: Number(row.bytes_down ?? 0),
    bytesUp: Number(row.bytes_up ?? 0),
    streams: Number(row.streams ?? 0),
    nicLinkMbps: num(row.nic_link_mbps),
    error: str(row.error),
    series: withSeries ? parseJson(row.series, []) : [],
  };
}

// ─── traceroutes ───────────────────────────────────────────────────────────

export const TRACEROUTE_COLUMNS = 'ts, target, family, hops, reached, path_hash, changed, trigger, duration_ms';

export function tracerouteToParams(t: TracerouteResult): SqlValue[] {
  return [t.ts, t.target, t.family, JSON.stringify(t.hops), t.reached ? 1 : 0, t.pathHash, t.changed ? 1 : 0, t.trigger, t.durationMs];
}

export function rowToTraceroute(row: Record<string, unknown>): TracerouteResult {
  return {
    id: Number(row.id),
    ts: Number(row.ts),
    target: String(row.target),
    family: Number(row.family) as IpFamily,
    hops: parseJson<TraceHop[]>(row.hops, []),
    reached: Number(row.reached) === 1,
    pathHash: String(row.path_hash),
    changed: Number(row.changed) === 1,
    trigger: String(row.trigger) as TracerouteResult['trigger'],
    durationMs: Number(row.duration_ms),
  };
}
