// Read queries of the Next API over SQLite (db.ts). All queries are bounded: raw samples only
// for short ranges, minute rollups otherwise; chart data is columnar.
import type {
  ClientResponse,
  EventsResponse,
  HeatmapResponse,
  MetricsResponse,
  PathResponse,
  RouterResponse,
  SamplesResponse,
  SecondsResponse,
  SeriesData,
  SeriesResponse,
  SessionsResponse,
  SpeedtestsResponse,
  StatsResponse,
  StatusResponse,
  TraceroutesResponse,
} from '../shared/api-types';
import { type AppConfig, spikeRuleFor, targetById } from '../shared/config';
import {
  EVENT_COLUMNS,
  SECONDS_COLUMNS,
  eventToParams,
  parseJson,
  rowToEvent,
  rowToSeconds,
  rowToSession,
  rowToSnapshot,
  rowToSpeedtest,
  rowToTraceroute,
} from '../shared/db/rows';
import { metricDef } from '../shared/metrics';
import { type MergeableRollup, mergeRollups, summarize } from '../shared/stats';
import type {
  IpFamily,
  MtuResult,
  NetEvent,
  RouterLogEntry,
  Snapshot,
  SnapshotKind,
  SpeedtestResult,
  TargetStats,
  TestSession,
  TracerouteResult,
} from '../shared/types';
import {
  type HeatmapMetric,
  type MetricAgg,
  type RollupLite,
  bucketMetric,
  bucketRawSamples,
  bucketRollups,
  bucketSeconds,
  buildHeatmap,
  buildHourProfile,
  emptySeriesData,
  fastDecodeHistogram,
  round3,
  type HourProfileEntry,
} from './bucketing';
import { getConfig } from './config-store';
import { dbPath, dbSizeBytes, getDb } from './db';
import { type LinkEventLite, computeLinkSummary, linkEventDays } from './link-events';
import { routerLogFromEvent, routerLogFromSnapshot } from './router-log';
import {
  latestPerFamily,
  mtuResults,
  natResults,
  normalizeAdapterSnapshot,
  normalizeDocsis,
  normalizeRouterStatus,
  normalizeVpn,
  normalizeWlan,
} from './snapshots';
import { type SqlParam, placeholders, queryArrays, queryOne, queryRows, toNum, toNum0, toStr } from './sql';
import {
  DAY,
  HOUR,
  METRIC_STEPS,
  MINUTE,
  MINUTE_STEPS,
  RAW_STEPS,
  SECOND,
  addLocalDays,
  chooseStep,
  localDayKey,
  localOffsetMs,
  minuteStart,
  startOfLocalDay,
} from './time';

/** Ranges up to this span are served from raw samples, longer ones from minute rollups. */
export const RAW_MAX_SPAN_MS = 3 * HOUR;
const TARGET_POINTS = 1500;
const MAX_POINTS = 10_000;
/** episodes (outages, link down …) starting this long before `from` still count as overlapping */
const EPISODE_LOOKBACK_MS = 7 * DAY;
/** stats: minutes after the newest rollup (rollups lag ~65 s) are summarized from raw samples */
const STATS_RAW_TAIL_MAX_MS = 3 * HOUR;
/** a speed test window longer than this is treated as corrupt and capped */
const MAX_SPEEDTEST_WINDOW_MS = 2 * HOUR;
/** NIC link events read for the per-day history / KPIs (newest first) */
const MAX_LINK_HISTORY = 100_000;

const ROLLUP_LITE_COLUMNS = 'ts, sent, lost, min, avg, max, spikes, hist';

function toRollupLite(r: unknown[]): RollupLite {
  return {
    ts: toNum0(r[0]),
    sent: toNum0(r[1]),
    lost: toNum0(r[2]),
    min: toNum(r[3]),
    avg: toNum(r[4]),
    max: toNum(r[5]),
    spikes: toNum0(r[6]),
    hist: toStr(r[7]),
  };
}

function rollupLiteRows(targetId: string, from: number, to: number): RollupLite[] {
  return queryArrays(
    `SELECT ${ROLLUP_LITE_COLUMNS} FROM rollup_1m WHERE target_id = ? AND ts >= ? AND ts < ? ORDER BY ts`,
    targetId,
    from,
    to,
  ).map(toRollupLite);
}

// ─── series / samples ───────────────────────────────────────────────────────

export interface SeriesQuery {
  targets: readonly string[];
  from: number;
  to: number;
  step?: number | null;
}

export function seriesStep(spanMs: number, source: 'raw' | 'rollup', requested?: number | null): number {
  return source === 'raw'
    ? chooseStep(spanMs, { requested, unit: SECOND, nice: RAW_STEPS, targetPoints: TARGET_POINTS, maxPoints: MAX_POINTS })
    : chooseStep(spanMs, { requested, unit: MINUTE, nice: MINUTE_STEPS, targetPoints: TARGET_POINTS, maxPoints: MAX_POINTS });
}

export function getSeries(q: SeriesQuery, cfg: AppConfig = getConfig()): SeriesResponse {
  const span = q.to - q.from;
  const source: SeriesResponse['source'] = span <= RAW_MAX_SPAN_MS ? 'raw' : 'rollup';
  const stepMs = seriesStep(span, source, q.step);
  const offsetMs = localOffsetMs(q.to);
  const series: Record<string, SeriesData> = {};
  for (const id of q.targets) {
    const intervalMs = targetById(cfg, id)?.intervalMs ?? 1000;
    if (source === 'raw') {
      const rows = queryArrays('SELECT ts, rtt FROM samples WHERE target_id = ? AND ts >= ? AND ts < ? ORDER BY ts', id, q.from, q.to);
      const ts = new Array<number>(rows.length);
      const rtt = new Array<number | null>(rows.length);
      for (let i = 0; i < rows.length; i++) {
        ts[i] = toNum0(rows[i][0]);
        rtt[i] = toNum(rows[i][1]);
      }
      series[id] = bucketRawSamples(ts, rtt, { stepMs, offsetMs, gapMs: Math.max(2 * stepMs, 2.5 * intervalMs) });
    } else {
      const rows = rollupLiteRows(id, minuteStart(q.from), q.to);
      series[id] = rows.length
        ? bucketRollups(rows, { stepMs, offsetMs, gapMs: Math.max(2 * stepMs, 2.5 * Math.max(intervalMs, MINUTE)) })
        : emptySeriesData();
    }
  }
  return { from: q.from, to: q.to, stepMs, source, series };
}

export function getSamples(targetId: string, from: number, to: number, limit: number): SamplesResponse {
  const rows = queryArrays(
    'SELECT ts, rtt, status FROM samples WHERE target_id = ? AND ts >= ? AND ts < ? ORDER BY ts LIMIT ?',
    targetId,
    from,
    to,
    limit + 1,
  );
  const truncated = rows.length > limit;
  const n = Math.min(rows.length, limit);
  const out: SamplesResponse = { targetId, ts: new Array<number>(n), rtt: new Array<number | null>(n), status: new Array<number>(n), truncated };
  for (let i = 0; i < n; i++) {
    out.ts[i] = toNum0(rows[i][0]);
    out.rtt[i] = toNum(rows[i][1]);
    out.status[i] = toNum0(rows[i][2]);
  }
  return out;
}

// ─── speed test exclusion ───────────────────────────────────────────────────

/** [start, end] windows of speed tests overlapping [from, to) (events + speedtests table). */
export function speedtestWindows(from: number, to: number): [number, number][] {
  const out: [number, number][] = [];
  const add = (a: number, b: number) => out.push([a, Math.min(Math.max(a, b), a + MAX_SPEEDTEST_WINDOW_MS)]);
  for (const r of queryArrays(
    "SELECT ts, COALESCE(end_ts, ts) FROM events WHERE type = 'speedtest' AND ts >= ? AND ts < ? AND COALESCE(end_ts, ts) >= ?",
    from - DAY,
    to,
    from,
  )) {
    add(toNum0(r[0]), toNum0(r[1]));
  }
  for (const r of queryArrays('SELECT ts, end_ts FROM speedtests WHERE ts >= ? AND ts < ? AND end_ts >= ?', from - DAY, to, from)) {
    add(toNum0(r[0]), toNum0(r[1]));
  }
  return out;
}

/** Minute starts overlapping the given windows. */
export function windowMinutes(windows: readonly [number, number][], into = new Set<number>()): Set<number> {
  for (const [a, b] of windows) {
    for (let m = minuteStart(a); m <= minuteStart(b); m += MINUTE) into.add(m);
  }
  return into;
}

/** Minutes that contain LOAD-flagged samples (checked on one 1 Hz reference target – the flag is global). */
function loadFlaggedMinutes(from: number, to: number, cfg: AppConfig): number[] {
  const ref = cfg.targets.find((t) => t.enabled && t.kind === 'icmp');
  if (!ref) return [];
  return queryArrays(
    'SELECT DISTINCT (ts / 60000) * 60000 FROM samples WHERE target_id = ? AND ts >= ? AND ts < ? AND (flags & 1) != 0',
    ref.id,
    minuteStart(from),
    to,
  ).map((r) => toNum0(r[0]));
}

/** Minutes excluded from statistics by default: speed test windows + LOAD-flagged minutes. */
export function speedtestMinutes(from: number, to: number, cfg: AppConfig): Set<number> {
  const set = windowMinutes(speedtestWindows(from, to));
  for (const m of loadFlaggedMinutes(from, to, cfg)) set.add(m);
  return set;
}

// ─── stats ──────────────────────────────────────────────────────────────────

export interface StatsQuery {
  from: number;
  to: number;
  targets: readonly string[];
  excludeSpeedtests: boolean;
}

interface RawMinute {
  ts: number;
  rtts: (number | null)[];
  load: boolean;
}

function rawMinutes(targetId: string, from: number, to: number): RawMinute[] {
  const out: RawMinute[] = [];
  let cur: RawMinute | null = null;
  for (const r of queryArrays('SELECT ts, rtt, flags FROM samples WHERE target_id = ? AND ts >= ? AND ts < ? ORDER BY ts', targetId, from, to)) {
    const m = minuteStart(toNum0(r[0]));
    if (!cur || cur.ts !== m) {
      cur = { ts: m, rtts: [], load: false };
      out.push(cur);
    }
    cur.rtts.push(toNum(r[1]));
    if ((toNum0(r[2]) & 1) !== 0) cur.load = true;
  }
  return out;
}

function targetStats(id: string, q: StatsQuery, excluded: ReadonlySet<number>, totalMinutes: number, cfg: AppConfig): TargetStats {
  const included: MergeableRollup[] = [];
  let covered = 0;
  let lastTs: number | null = null;
  for (const r of queryArrays(
    'SELECT ts, sent, lost, min, avg, max, jitter, stddev, spikes, hist FROM rollup_1m WHERE target_id = ? AND ts > ? AND ts < ? ORDER BY ts',
    id,
    q.from - MINUTE,
    q.to,
  )) {
    const ts = toNum0(r[0]);
    const sent = toNum0(r[1]);
    lastTs = ts;
    if (sent > 0) covered++;
    if (excluded.has(ts)) continue;
    included.push({
      sent,
      lost: toNum0(r[2]),
      min: toNum(r[3]),
      avg: toNum(r[4]),
      max: toNum(r[5]),
      jitter: toNum(r[6]),
      stddev: toNum(r[7]),
      spikes: toNum0(r[8]),
      hist: fastDecodeHistogram(toStr(r[9])),
    });
  }
  // newest minutes are not rolled up yet → summarize them from raw samples
  const tailStart = Math.max(q.from, q.to - STATS_RAW_TAIL_MAX_MS, lastTs === null ? Number.NEGATIVE_INFINITY : lastTs + MINUTE);
  if (tailStart < q.to) {
    const lagMs = spikeRuleFor(cfg, targetById(cfg, id)?.segment ?? 'internet').lagMs;
    for (const m of rawMinutes(id, tailStart, q.to)) {
      covered++;
      if (excluded.has(m.ts) || (q.excludeSpeedtests && m.load)) continue;
      const s = summarize(m.rtts);
      let spikes = 0;
      for (const v of m.rtts) if (v !== null && v >= lagMs) spikes++;
      included.push({ ...s, spikes });
    }
  }
  const merged = mergeRollups(included);
  const hours = merged.minutes / 60;
  return {
    targetId: id,
    from: q.from,
    to: q.to,
    sent: merged.sent,
    lost: merged.lost,
    lossPct: round3(merged.lossPct),
    min: round3(merged.min),
    avg: round3(merged.avg),
    p50: round3(merged.p50),
    p95: round3(merged.p95),
    p99: round3(merged.p99),
    max: round3(merged.max),
    jitter: round3(merged.jitter),
    spikes: merged.spikes,
    spikesPerHour: hours > 0 ? round3(merged.spikes / hours) : null,
    coveragePct: round3(Math.min(100, (covered / totalMinutes) * 100)) ?? 0,
  };
}

export function getStats(q: StatsQuery, cfg: AppConfig = getConfig()): StatsResponse {
  const excluded = q.excludeSpeedtests ? speedtestMinutes(q.from, q.to, cfg) : new Set<number>();
  const totalMinutes = Math.max(1, Math.ceil((q.to - q.from) / MINUTE));
  return {
    from: q.from,
    to: q.to,
    excludeSpeedtests: q.excludeSpeedtests,
    stats: q.targets.map((id) => targetStats(id, q, excluded, totalMinutes, cfg)),
  };
}

// ─── classified seconds ─────────────────────────────────────────────────────

export function getSeconds(from: number, to: number, step?: number | null): SecondsResponse {
  const stepMs = chooseStep(to - from, { requested: step, unit: MINUTE, nice: MINUTE_STEPS, targetPoints: TARGET_POINTS, maxPoints: MAX_POINTS });
  const rows = queryRows(`SELECT ${SECONDS_COLUMNS} FROM seconds_1m WHERE ts > ? AND ts < ? ORDER BY ts`, from - MINUTE, to).map(rowToSeconds);
  const { buckets, total } = bucketSeconds(rows, stepMs, localOffsetMs(to), from);
  return { from, to, stepMs, buckets, total };
}

// ─── heatmap ────────────────────────────────────────────────────────────────

/** HeatmapResponse plus per-cell measurement coverage (%), see final report "contract requests". */
export type HeatmapWithCoverage = HeatmapResponse & { coverage: number[][] };

export function getHeatmap(
  targetId: string,
  metric: HeatmapMetric,
  days: number,
  opts: { now?: number; excludeSpeedtests?: boolean } = {},
): HeatmapWithCoverage {
  const now = opts.now ?? Date.now();
  const today = startOfLocalDay(now);
  const dayStarts: number[] = [];
  for (let i = days - 1; i >= 0; i--) dayStarts.push(addLocalDays(today, -i));
  const end = addLocalDays(today, 1);
  const rows = rollupLiteRows(targetId, dayStarts[0], end);
  const excluded = opts.excludeSpeedtests !== false ? windowMinutes(speedtestWindows(dayStarts[0], end)) : undefined;
  const grid = buildHeatmap(rows, dayStarts, metric, end, excluded);
  return { targetId, metric, days: dayStarts.map(localDayKey), values: grid.values, coverage: grid.coverage };
}

/** Hour-of-day profile (local time) of one target over a range (report "Zeitprofil"). */
export function getHourProfile(targetId: string, from: number, to: number): HourProfileEntry[] {
  return buildHourProfile(rollupLiteRows(targetId, minuteStart(from), to));
}

// ─── events ─────────────────────────────────────────────────────────────────

export interface EventsQuery {
  from: number;
  to: number;
  types?: readonly string[];
  severities?: readonly string[];
  segments?: readonly string[];
  sources?: readonly string[];
  limit: number;
  offset: number;
}

const EVENT_SELECT = `SELECT id, ${EVENT_COLUMNS} FROM events`;

/** Events overlapping [from, to) (episodes count when they end after `from`), newest first. */
export function getEvents(q: EventsQuery): EventsResponse {
  const where = ['ts >= ?', 'ts < ?', 'COALESCE(end_ts, ts) >= ?'];
  const params: SqlParam[] = [q.from - EPISODE_LOOKBACK_MS, q.to, q.from];
  const addIn = (col: string, values: readonly string[] | undefined) => {
    if (!values || values.length === 0) return;
    where.push(`${col} IN (${placeholders(values.length)})`);
    params.push(...values);
  };
  addIn('type', q.types);
  addIn('severity', q.severities);
  addIn('segment', q.segments);
  addIn('source', q.sources);
  const whereSql = where.join(' AND ');
  const total = toNum0(queryOne(`SELECT COUNT(*) AS n FROM events WHERE ${whereSql}`, ...params)?.n);
  const rows = queryRows(`${EVENT_SELECT} WHERE ${whereSql} ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?`, ...params, q.limit, q.offset);
  return { events: rows.map(rowToEvent), total };
}

export interface NoteInput {
  title: string;
  ts?: number;
  details?: Record<string, unknown> | null;
}

/** "Lag jetzt markieren": user note event (written by Next directly, WAL allows a second writer). */
export function insertNote(input: NoteInput, now: number = Date.now()): NetEvent {
  const e: NetEvent = {
    ts: Math.round(input.ts ?? now),
    endTs: null,
    type: 'note',
    severity: 'info',
    segment: null,
    title: input.title,
    details: input.details ?? null,
    source: 'user',
    dedupeKey: null,
  };
  const res = getDb()
    .prepare(`INSERT INTO events(${EVENT_COLUMNS}) VALUES (${placeholders(EVENT_COLUMNS.split(',').length)})`)
    .run(...eventToParams(e));
  return { ...e, id: Number(res.lastInsertRowid) };
}

// ─── metrics ────────────────────────────────────────────────────────────────

export function metricAgg(key: string): MetricAgg {
  return metricDef(key)?.agg ?? 'avg';
}

function metricRows(key: string, from: number, to: number): { ts: number[]; value: number[] } {
  const rows = queryArrays('SELECT ts, value FROM metrics WHERE key = ? AND ts >= ? AND ts < ? ORDER BY ts', key, from, to);
  const ts = new Array<number>(rows.length);
  const value = new Array<number>(rows.length);
  for (let i = 0; i < rows.length; i++) {
    ts[i] = toNum0(rows[i][0]);
    value[i] = toNum(rows[i][1]) ?? Number.NaN;
  }
  return { ts, value };
}

/**
 * Metric series bucketed with the registry's aggregation. Only non-empty buckets are returned
 * (metrics have irregular intervals). 'last' metrics (states) get a carry-in point at `from`
 * with the last value before the range.
 */
export function getMetrics(keys: readonly string[], from: number, to: number, step?: number | null): MetricsResponse {
  const stepMs = chooseStep(to - from, { requested: step, unit: SECOND, nice: METRIC_STEPS, targetPoints: TARGET_POINTS, maxPoints: MAX_POINTS * 2 });
  const offsetMs = localOffsetMs(to);
  const series: MetricsResponse['series'] = {};
  for (const key of keys) {
    const agg = metricAgg(key);
    const raw = metricRows(key, from, to);
    const b = bucketMetric(raw.ts, raw.value, agg, stepMs, offsetMs);
    if (agg === 'last' && (b.ts.length === 0 || b.ts[0] > from)) {
      const prev = queryArrays('SELECT ts, value FROM metrics WHERE key = ? AND ts < ? ORDER BY ts DESC LIMIT 1', key, from)[0];
      const v = prev ? toNum(prev[1]) : null;
      if (v !== null) {
        b.ts.unshift(from);
        b.value.unshift(v);
      }
    }
    series[key] = b;
  }
  return { from, to, stepMs, series };
}

/**
 * Several metrics joined on their (second-rounded) timestamps – used for the DOCSIS/HTTP history
 * of the router page. Above `maxPoints` timestamps the data is bucketed per key aggregation.
 */
export function joinedMetrics(keys: readonly string[], from: number, to: number, maxPoints = 2000): { ts: number[]; cols: (number | null)[][] } {
  const byTs = new Map<number, (number | null)[]>();
  keys.forEach((key, i) => {
    const raw = metricRows(key, from, to);
    for (let k = 0; k < raw.ts.length; k++) {
      const v = raw.value[k];
      if (!Number.isFinite(v)) continue;
      const t = Math.round(raw.ts[k] / SECOND) * SECOND;
      let row = byTs.get(t);
      if (!row) {
        row = new Array<number | null>(keys.length).fill(null);
        byTs.set(t, row);
      }
      row[i] = v;
    }
  });
  let ts = [...byTs.keys()].sort((a, b) => a - b);
  let cols = keys.map((_, i) => ts.map((t) => byTs.get(t)?.[i] ?? null));
  if (ts.length > maxPoints) {
    const stepMs = chooseStep(to - from, { unit: MINUTE, nice: MINUTE_STEPS, targetPoints: maxPoints, maxPoints });
    const offsetMs = localOffsetMs(to);
    const bucketed = keys.map((key, i) => {
      const pts = ts.map((t, k) => [t, cols[i][k]] as const).filter((p): p is readonly [number, number] => p[1] !== null);
      return bucketMetric(pts.map((p) => p[0]), pts.map((p) => p[1]), metricAgg(key), stepMs, offsetMs);
    });
    const all = new Set<number>();
    for (const b of bucketed) for (const t of b.ts) all.add(t);
    ts = [...all].sort((a, b) => a - b);
    cols = bucketed.map((b) => {
      const m = new Map<number, number | null>();
      b.ts.forEach((t, k) => m.set(t, b.value[k]));
      return ts.map((t) => m.get(t) ?? null);
    });
  }
  return { ts, cols };
}

// ─── speed tests, traceroutes, sessions ─────────────────────────────────────

const SPEEDTEST_LIST_COLUMNS =
  'id, ts, end_ts, trigger, server, down_mbps, up_mbps, idle_latency_ms, idle_jitter_ms, loaded_down_latency_ms, loaded_down_p95_ms, loaded_up_latency_ms, loaded_up_p95_ms, bloat_down_ms, bloat_up_ms, grade, bytes_down, bytes_up, streams, nic_link_mbps, error';

export function listSpeedtests(from: number, to: number, limit: number): SpeedtestsResponse {
  const rows = queryRows(`SELECT ${SPEEDTEST_LIST_COLUMNS} FROM speedtests WHERE ts >= ? AND ts < ? ORDER BY ts DESC, id DESC LIMIT ?`, from, to, limit);
  return { items: rows.map((r) => rowToSpeedtest(r, false)) };
}

export function getSpeedtest(id: number): SpeedtestResult | null {
  const row = queryOne('SELECT * FROM speedtests WHERE id = ?', id);
  return row ? rowToSpeedtest(row, true) : null;
}

export interface TracerouteQuery {
  family?: IpFamily;
  from?: number;
  to?: number;
  limit: number;
}

export function listTraceroutes(q: TracerouteQuery): TraceroutesResponse {
  const where: string[] = [];
  const params: SqlParam[] = [];
  if (q.family !== undefined) {
    where.push('family = ?');
    params.push(q.family);
  }
  if (q.from !== undefined) {
    where.push('ts >= ?');
    params.push(q.from);
  }
  if (q.to !== undefined) {
    where.push('ts < ?');
    params.push(q.to);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = queryRows(`SELECT * FROM traceroutes ${whereSql} ORDER BY ts DESC, id DESC LIMIT ?`, ...params, q.limit);
  return { items: rows.map((r): TracerouteResult => rowToTraceroute(r)) };
}

export function getSessions(limit = 200): SessionsResponse {
  const items = queryRows('SELECT * FROM sessions ORDER BY started_at DESC, id DESC LIMIT ?', limit).map((r): TestSession => rowToSession(r));
  const activeRow = queryOne("SELECT * FROM sessions WHERE status = 'running' ORDER BY started_at DESC, id DESC LIMIT 1");
  return { items, active: activeRow ? rowToSession(activeRow) : null };
}

// ─── snapshots: path, router, client ────────────────────────────────────────

export function latestSnapshot<T = unknown>(kind: SnapshotKind): Snapshot<T> | null {
  const row = queryOne('SELECT id, ts, kind, data FROM snapshots WHERE kind = ? ORDER BY ts DESC, id DESC LIMIT 1', kind);
  return row ? rowToSnapshot<T>(row) : null;
}

/** Newest snapshot of a kind taken at or before `at` (state at that time). */
export function snapshotAt<T = unknown>(kind: SnapshotKind, at: number): Snapshot<T> | null {
  const row = queryOne('SELECT id, ts, kind, data FROM snapshots WHERE kind = ? AND ts <= ? ORDER BY ts DESC, id DESC LIMIT 1', kind, at);
  return row ? rowToSnapshot<T>(row) : null;
}

function recentSnapshots(kind: SnapshotKind, limit: number): Snapshot<unknown>[] {
  return queryRows('SELECT id, ts, kind, data FROM snapshots WHERE kind = ? ORDER BY ts DESC, id DESC LIMIT ?', kind, limit).map((r) =>
    rowToSnapshot<unknown>(r),
  );
}

const MTU_TARGETS: Record<IpFamily, string> = { 4: '1.1.1.1', 6: '2606:4700:4700::1111' };

export function getPath(): PathResponse {
  const mtu = latestPerFamily(recentSnapshots('mtu', 20).flatMap((s) => mtuResults(s.data, s.ts)));
  // fall back to the mtu.v4 / mtu.v6 metrics for families without a snapshot
  for (const fam of [4, 6] as const) {
    if (mtu.some((m) => m.family === fam)) continue;
    const row = queryArrays('SELECT ts, value FROM metrics WHERE key = ? ORDER BY ts DESC LIMIT 1', fam === 4 ? 'mtu.v4' : 'mtu.v6')[0];
    const value = row ? toNum(row[1]) : null;
    if (row && value !== null) {
      const fallback: MtuResult = {
        ts: toNum0(row[0]),
        family: fam,
        target: MTU_TARGETS[fam],
        mtu: value,
        maxPayload: value - (fam === 4 ? 28 : 48),
        note: null,
      };
      mtu.push(fallback);
    }
  }
  mtu.sort((a, b) => a.family - b.family);
  const nat = latestPerFamily(recentSnapshots('nat', 20).flatMap((s) => natResults(s.data, s.ts)));
  return { mtu, nat };
}

const DOCSIS_KEYS = [
  'docsis.ds.power_min',
  'docsis.ds.power_max',
  'docsis.ds.snr_min',
  'docsis.us.power_min',
  'docsis.us.power_max',
  'docsis.ds.corrected_delta',
  'docsis.ds.uncorrectable_delta',
] as const;

export function getRouterLog(from: number, to: number, limit = 500): RouterLogEntry[] {
  const events = queryRows(`${EVENT_SELECT} WHERE type = 'router_log' AND ts >= ? AND ts < ? ORDER BY ts DESC, id DESC LIMIT ?`, from, to, limit).map(
    rowToEvent,
  );
  if (events.length > 0) return events.map(routerLogFromEvent);
  const snap = latestSnapshot('router_log');
  return snap ? routerLogFromSnapshot(snap.data).slice(0, limit) : [];
}

/** `at`: router status as it was at that time (e.g. the end of a past test) instead of the latest one. */
export function getRouter(from: number, to: number, cfg: AppConfig = getConfig(), at?: number): RouterResponse {
  const snapOf = (kind: SnapshotKind) => (at === undefined ? latestSnapshot(kind) : snapshotAt(kind, at));
  const snap = snapOf('router');
  let status = snap ? normalizeRouterStatus(snap.data, snap.ts, cfg.router.ip) : null;
  if (status && status.docsis === null) {
    const docsis = snapOf('docsis');
    const normalized = docsis ? normalizeDocsis(docsis.data) : null;
    if (normalized) status = { ...status, docsis: normalized };
  }
  const d = joinedMetrics(DOCSIS_KEYS, from, to);
  const http = joinedMetrics(['router.http_ms', 'router.reachable'], from, to);
  return {
    status,
    docsisHistory: {
      ts: d.ts,
      dsPowerMin: d.cols[0],
      dsPowerMax: d.cols[1],
      dsSnrMin: d.cols[2],
      usPowerMin: d.cols[3],
      usPowerMax: d.cols[4],
      corrDelta: d.cols[5],
      uncorrDelta: d.cols[6],
    },
    log: getRouterLog(from, to),
    httpHistory: { ts: http.ts, ms: http.ts.map((_, i) => (http.cols[1][i] === 0 ? null : http.cols[0][i])) },
  };
}

function parseDetails(v: unknown): Record<string, unknown> | null {
  const d = parseJson<unknown>(v, null);
  return d !== null && typeof d === 'object' && !Array.isArray(d) ? (d as Record<string, unknown>) : null;
}

export function getClient(from: number, to: number): ClientResponse {
  const a = latestSnapshot('adapters');
  const w = latestSnapshot('wlan');
  const v = latestSnapshot('vpn');
  // whole imported history (a few thousand rows in practice), capped to stay bounded; order is irrelevant
  const history: LinkEventLite[] = queryRows(
    `SELECT ts, type, details FROM events WHERE type IN ('nic_link_down', 'nic_link_up') ORDER BY ts DESC LIMIT ${MAX_LINK_HISTORY}`,
  ).map((r) => ({ ts: toNum0(r.ts), type: String(r.type), details: parseDetails(r.details) }));
  const linkEvents = queryRows(
    `${EVENT_SELECT} WHERE type IN ('nic_link_down', 'nic_link_up') AND ts >= ? AND ts < ? ORDER BY ts DESC, id DESC LIMIT 500`,
    from,
    to,
  ).map(rowToEvent);
  return {
    adapters: a ? normalizeAdapterSnapshot(a.data, a.ts) : null,
    wlan: w ? normalizeWlan(w.data, w.ts) : null,
    vpn: v ? normalizeVpn(v.data, v.ts) : null,
    linkDays: linkEventDays(history, to),
    linkEvents,
    linkSummary: computeLinkSummary(
      history.filter((e) => e.type === 'nic_link_down'),
      from,
      to,
    ),
  };
}

// ─── status ─────────────────────────────────────────────────────────────────

/** DB location/size and first/last raw sample (per-target PK seeks – no full scan). */
export function getDbInfo(cfg: AppConfig = getConfig()): StatusResponse['db'] {
  let first: number | null = null;
  let last: number | null = null;
  for (const t of cfg.targets) {
    const a = toNum(queryOne('SELECT MIN(ts) AS v FROM samples WHERE target_id = ?', t.id)?.v);
    const b = toNum(queryOne('SELECT MAX(ts) AS v FROM samples WHERE target_id = ?', t.id)?.v);
    if (a !== null) first = first === null ? a : Math.min(first, a);
    if (b !== null) last = last === null ? b : Math.max(last, b);
  }
  return { path: dbPath(), sizeBytes: dbSizeBytes(), firstSampleTs: first, lastSampleTs: last };
}
