// buildDiagnosisInput(from, to): everything the pure rules need, read from SQLite with bounded,
// pre-aggregated queries (own SQL – independent of queries.ts). Minute rollups are aggregated in
// SQL per 15-min bucket (split by speed-test minutes and "stable" minutes); classified seconds per
// 15-min bucket; events per type with limits; latest snapshots; metric summaries.
import type { AppConfig } from '../../shared/config';
import { EVENT_COLUMNS, SPEEDTEST_COLUMNS, parseJson, rowToEvent, rowToSession, rowToSpeedtest, rowToTraceroute } from '../../shared/db/rows';
import { udpBurstKey } from '../../shared/metrics';
import type { EventType, NetEvent, SpeedtestResult, TestSession, TracerouteResult } from '../../shared/types';
import { getConfig } from '../config-store';
import { all, get } from '../db';
import type { AccParts } from './aggregate';
import { type RollupBucketRow, type SecondsBucketRow, aggregateRollupBuckets, aggregateSecondsBuckets } from './buckets';
import { buildLinkDays, buildLinkDrops } from './links';
import {
  normalizeAdapters, normalizeDocsis, normalizeMtu, normalizeNat, normalizeRouterStatus, normalizeVpn, normalizeWlan,
  primaryWiredAdapter,
} from './normalize';
import { DAY, HOUR, MINUTE, WINDOW_MS } from './time';
import type {
  ChangeMarker, CoverageInfo, DiagnosisEvents, DiagnosisInput, GroupId, LinkSpeedInfo, MetricSummary, TargetMeta, VpnState,
} from './types';

/** minute rollups are analysed for at most this long (bounded memory/time) */
export const DETAIL_MAX_MS = 31 * DAY;
const LINK_HISTORY_MS = 30 * DAY;
const EVENT_LIST_LIMIT = 2000;
const SPIKE_LIMIT = 20_000;
const LINK_EVENT_LIMIT = 5000;
/** a minute with ≥ this many self-load seconds counts as "under own load" */
export const LOAD_MINUTE_SEC = 10;
const GAP_MIN_MS = 10 * MINUTE;
const ES_SERIES_MS = 7 * DAY;
const SNAPSHOT_MAX_AGE_MS = 7 * DAY;
/** link speed points further apart than this are not interpolated */
const LINK_POINT_MAX_MS = 5 * MINUTE;

/** event types listed in DiagnosisInput.events.byType (link events and spikes are read separately) */
const LIST_TYPES: readonly EventType[] = [
  'outage', 'loss_burst', 'route_switch', 'adapter_change', 'standby', 'resume', 'engine_gap', 'route_change', 'speedtest',
  'router_reboot', 'router_offline', 'router_log', 'docsis_change', 'router_login', 'wlan_connect', 'wlan_disconnect', 'wlan_roam',
  'ip_change', 'identity_change', 'gaming', 'vpn_change', 'mtu_change', 'nat_change', 'session_start', 'session_end',
  'config_change', 'note',
];

const METRIC_KEYS: readonly string[] = [
  'tcp.retrans_pct', 'tcp6.retrans_pct', 'sys.cpu_pct', 'sys.mem_pct', 'engine.loop_lag_ms', 'nic.rx_mbps', 'nic.tx_mbps',
  'nic.rx_errors', 'nic.rx_discards', 'nic.tx_errors', 'nic.tx_discards', 'nic.link_mbps', 'nic.up', 'net.on_expected_if',
  'router.http_ms', 'router.reachable', 'router.uptime_s', 'docsis.ds.count', 'docsis.ds.locked', 'docsis.ds.snr_min',
  'docsis.ds.power_min', 'docsis.ds.power_max', 'docsis.ofdm.snr_min', 'docsis.us.count', 'docsis.us.power_min',
  'docsis.us.power_max', 'wlan.signal_pct', 'wlan.rssi_dbm', 'mtu.v4', 'mtu.v6', 'pc.gaming',
];
const P95_KEYS: ReadonlySet<string> = new Set(['router.http_ms', 'tcp.retrans_pct']);

type Row = Record<string, unknown>;

const n0 = (v: unknown): number => {
  const x = typeof v === 'bigint' ? Number(v) : Number(v ?? 0);
  return Number.isFinite(x) ? x : 0;
};
const nn = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  const x = typeof v === 'bigint' ? Number(v) : Number(v);
  return Number.isFinite(x) ? x : null;
};
const placeholders = (n: number) => Array.from({ length: n }, () => '?').join(', ');

export function targetsOf(cfg: AppConfig): TargetMeta[] {
  return cfg.targets.map((t) => ({
    id: t.id, name: t.name, host: t.host, segment: t.segment, family: t.family, kind: t.kind, pairId: t.pairId ?? null, enabled: t.enabled,
  }));
}

/** enabled members of the pseudo targets */
export function groupMembers(targets: readonly TargetMeta[]): Record<GroupId, string[]> {
  const inet = targets.filter((t) => t.enabled && t.segment === 'internet' && t.kind === 'icmp');
  return {
    '@internet': inet.map((t) => t.id),
    '@internet4': inet.filter((t) => t.family === 4).map((t) => t.id),
    '@internet6': inet.filter((t) => t.family === 6).map((t) => t.id),
    '@game': targets.filter((t) => t.enabled && t.segment === 'game').map((t) => t.id),
  };
}

// ─── rollups ───────────────────────────────────────────────────────────────

function rollupBucketsSql(nTargets: number, nSpeedMinutes: number): string {
  return `
    SELECT target_id AS t, b, st, stable,
      COUNT(*) AS minutes, SUM(sent) AS sent, SUM(lost) AS lost, SUM(spikes) AS spikes,
      MIN(CASE WHEN okv THEN rmin END) AS mn, MAX(CASE WHEN okv THEN rmax END) AS mx,
      SUM(CASE WHEN okv THEN ok ELSE 0 END) AS okn,
      SUM(CASE WHEN okv THEN ravg * ok ELSE 0 END) AS sm,
      SUM(CASE WHEN okv THEN ok * (COALESCE(rsd, 0) * COALESCE(rsd, 0) + ravg * ravg) ELSE 0 END) AS sq,
      SUM(CASE WHEN okv AND ok > 1 AND rjit IS NOT NULL THEN rjit * (ok - 1) ELSE 0 END) AS jw,
      SUM(CASE WHEN okv AND ok > 1 AND rjit IS NOT NULL THEN ok - 1 ELSE 0 END) AS jp,
      group_concat(hist, ';') AS hists
    FROM (
      SELECT r.target_id AS target_id, CAST(r.ts / ${WINDOW_MS} AS INTEGER) * ${WINDOW_MS} AS b,
        r.sent AS sent, r.lost AS lost, r.spikes AS spikes, r.min AS rmin, r.max AS rmax, r.avg AS ravg,
        r.stddev AS rsd, r.jitter AS rjit, r.hist AS hist, r.sent - r.lost AS ok,
        (r.sent - r.lost > 0 AND r.avg IS NOT NULL) AS okv,
        ${nSpeedMinutes > 0 ? `r.ts IN (${placeholders(nSpeedMinutes)})` : '0'} AS st,
        CASE WHEN sec.ts IS NULL THEN 1 WHEN sec.link > 0 OR sec.self_load >= ${LOAD_MINUTE_SEC} THEN 0 ELSE 1 END AS stable
      FROM rollup_1m r LEFT JOIN seconds_1m sec ON sec.ts = r.ts
      WHERE r.target_id IN (${placeholders(nTargets)}) AND r.ts >= ? AND r.ts < ? AND r.sent > 0
    )
    GROUP BY target_id, b, st, stable`;
}

const MAX_SPEED_MINUTES = 20_000;

/** minute starts overlapping a speed test window (a broken row counts for at most 1 h) */
export function speedtestMinutes(windows: readonly { ts: number; endTs: number }[], from: number, to: number): number[] {
  const set = new Set<number>();
  for (const w of windows) {
    const end = Math.min(Math.max(w.ts, w.endTs), w.ts + HOUR);
    for (let m = Math.floor(w.ts / MINUTE) * MINUTE; m < end && set.size < MAX_SPEED_MINUTES; m += MINUTE) {
      if (m >= from - MINUTE && m < to) set.add(m);
    }
  }
  return [...set].sort((a, b) => a - b);
}

function readSpeedtestWindows(from: number, to: number): { ts: number; endTs: number }[] {
  return all<Row>('SELECT ts, end_ts FROM speedtests WHERE ts > ? AND ts < ? AND end_ts > ? LIMIT 5000', from - HOUR, to, from).map((r) => ({
    ts: n0(r.ts),
    endTs: n0(r.end_ts),
  }));
}

function readRollupBuckets(targetIds: readonly string[], from: number, to: number): RollupBucketRow[] {
  if (targetIds.length === 0 || to <= from) return [];
  const speedMinutes = speedtestMinutes(readSpeedtestWindows(from, to), from, to);
  // positional parameters in SQL text order: IN-list of the select list, then the WHERE clause
  return all<Row>(rollupBucketsSql(targetIds.length, speedMinutes.length), ...speedMinutes, ...targetIds, from, to).map((r) => {
    const parts: AccParts = {
      minutes: n0(r.minutes), sent: n0(r.sent), lost: n0(r.lost), spikes: n0(r.spikes), min: nn(r.mn), max: nn(r.mx),
      ok: n0(r.okn), sum: n0(r.sm), sumSq: n0(r.sq), jitW: n0(r.jw), jitP: n0(r.jp),
      hists: typeof r.hists === 'string' ? r.hists : null,
    };
    return { targetId: String(r.t), b: n0(r.b), st: n0(r.st) === 1, stable: n0(r.stable) === 1, parts };
  });
}

// ─── seconds ───────────────────────────────────────────────────────────────

function readSecondsBuckets(from: number, to: number): SecondsBucketRow[] {
  return all<Row>(
    `SELECT CAST(ts / ${WINDOW_MS} AS INTEGER) * ${WINDOW_MS} AS b, COUNT(*) AS minutes, MIN(ts) AS first_ts, MAX(ts) AS last_ts,
       SUM(covered) AS covered, SUM(good) AS good, SUM(link) AS link, SUM(lan) AS lan, SUM(access) AS access, SUM(aftr) AS aftr,
       SUM(backbone) AS backbone, SUM(remote) AS remote, SUM(unknown) AS unknown, SUM(es) AS es, SUM(ses) AS ses,
       SUM(self_load) AS self_load,
       SUM(CASE WHEN self_load >= ${LOAD_MINUTE_SEC} THEN 1 ELSE 0 END) AS load_minutes,
       SUM(CASE WHEN self_load >= ${LOAD_MINUTE_SEC} THEN es ELSE 0 END) AS es_load,
       SUM(CASE WHEN self_load >= ${LOAD_MINUTE_SEC} THEN covered ELSE 0 END) AS covered_load
     FROM seconds_1m WHERE ts >= ? AND ts < ? GROUP BY b`,
    from,
    to,
  ).map((r) => ({
    b: n0(r.b), minutes: n0(r.minutes), firstTs: n0(r.first_ts), lastTs: n0(r.last_ts) + MINUTE,
    covered: n0(r.covered), good: n0(r.good), link: n0(r.link), lan: n0(r.lan), access: n0(r.access), aftr: n0(r.aftr),
    backbone: n0(r.backbone), remote: n0(r.remote), unknown: n0(r.unknown), es: n0(r.es), ses: n0(r.ses), selfLoad: n0(r.self_load),
    loadMinutes: n0(r.load_minutes), esLoad: n0(r.es_load), coveredLoad: n0(r.covered_load),
  }));
}

function readEsPerMinute(from: number, to: number): DiagnosisInput['esPerMinute'] {
  return all<Row>('SELECT ts, es, covered FROM seconds_1m WHERE ts >= ? AND ts < ? AND covered > 0 ORDER BY ts LIMIT 20000', from, to).map(
    (r) => ({ ts: n0(r.ts), es: n0(r.es), covered: n0(r.covered) }),
  );
}

/** gaps ≥ 10 min between consecutive measured minutes (seconds_1m, else rollups of one target) */
function readGaps(from: number, to: number, useSeconds: boolean, refTargetId: string | null): CoverageInfo['gaps'] {
  const inner = useSeconds
    ? { sql: 'SELECT ts - LAG(ts) OVER (ORDER BY ts) - 60000 AS d FROM seconds_1m WHERE ts >= ? AND ts < ? AND covered > 0', params: [from, to] }
    : refTargetId
      ? { sql: 'SELECT ts - LAG(ts) OVER (ORDER BY ts) - 60000 AS d FROM rollup_1m WHERE target_id = ? AND ts >= ? AND ts < ?', params: [refTargetId, from, to] }
      : null;
  if (!inner) return { count: 0, totalMs: 0, longestMs: 0 };
  const r = get<Row>(
    `SELECT COUNT(*) AS n, COALESCE(SUM(d), 0) AS total, COALESCE(MAX(d), 0) AS longest FROM (${inner.sql}) WHERE d >= ${GAP_MIN_MS}`,
    ...inner.params,
  );
  return { count: n0(r?.n), totalMs: n0(r?.total), longestMs: n0(r?.longest) };
}

// ─── events ────────────────────────────────────────────────────────────────

const EVENT_SELECT = `SELECT id, ${EVENT_COLUMNS} FROM events`;

function readEvents(from: number, to: number): DiagnosisEvents {
  const counts: DiagnosisEvents['counts'] = {};
  for (const r of all<Row>('SELECT type, COUNT(*) AS n FROM events WHERE ts >= ? AND ts < ? GROUP BY type', from, to)) {
    counts[String(r.type) as EventType] = n0(r.n);
  }
  const byType: DiagnosisEvents['byType'] = {};
  const truncated: EventType[] = [];
  for (const type of LIST_TYPES) {
    const n = counts[type] ?? 0;
    if (n === 0) continue;
    const rows = all<Row>(`${EVENT_SELECT} WHERE type = ? AND ts >= ? AND ts < ? ORDER BY ts DESC LIMIT ?`, type, from, to, EVENT_LIST_LIMIT);
    byType[type] = rows.map(rowToEvent).reverse();
    if (n > EVENT_LIST_LIMIT) truncated.push(type);
  }
  return { counts, byType, truncated };
}

function readSpikeTimes(from: number, to: number): DiagnosisInput['spikeTimes'] {
  return all<Row>(
    `SELECT ts, CASE WHEN json_valid(details) THEN json_extract(details, '$.targetId') END AS target
     FROM events WHERE type = 'latency_spike' AND ts >= ? AND ts < ? ORDER BY ts DESC LIMIT ?`,
    from,
    to,
    SPIKE_LIMIT,
  )
    .map((r) => ({ ts: n0(r.ts), targetId: typeof r.target === 'string' ? r.target : null }))
    .reverse();
}

function readLinkEvents(from: number, to: number): { events: NetEvent[]; wlanConnects: number[] } {
  const events = all<Row>(
    `${EVENT_SELECT} WHERE type IN ('nic_link_down', 'nic_link_up') AND ts >= ? AND ts < ? ORDER BY ts DESC LIMIT ?`,
    from,
    to,
    LINK_EVENT_LIMIT,
  )
    .map(rowToEvent)
    .reverse();
  const wlanConnects = all<Row>("SELECT ts FROM events WHERE type = 'wlan_connect' AND ts >= ? AND ts < ? ORDER BY ts LIMIT ?", from, to, LINK_EVENT_LIMIT).map(
    (r) => n0(r.ts),
  );
  return { events, wlanConnects };
}

// ─── metrics ───────────────────────────────────────────────────────────────

function readLinkSpeed(from: number, to: number, end: number): LinkSpeedInfo {
  const agg = get<Row>(
    `SELECT COALESCE(SUM(CASE WHEN value > 0 AND value < 1000 THEN d ELSE 0 END), 0) AS below, COALESCE(SUM(d), 0) AS observed,
       MIN(CASE WHEN value > 0 THEN value END) AS minv
     FROM (SELECT value, MAX(0, MIN(COALESCE(LEAD(ts) OVER (ORDER BY ts), ?) - ts, ${LINK_POINT_MAX_MS})) AS d
           FROM metrics WHERE key = 'nic.link_mbps' AND ts >= ? AND ts < ?)`,
    end,
    from,
    to,
  );
  const last = get<Row>("SELECT ts, value FROM metrics WHERE key = 'nic.link_mbps' AND ts < ? ORDER BY ts DESC LIMIT 1", to);
  return {
    currentMbps: nn(last?.value),
    currentTs: nn(last?.ts),
    msBelow1g: n0(agg?.below),
    msObserved: n0(agg?.observed),
    minMbps: nn(agg?.minv),
  };
}

function readMetrics(keys: readonly string[], from: number, to: number): Record<string, MetricSummary> {
  const out: Record<string, MetricSummary> = {};
  if (keys.length === 0) return out;
  const rows = all<Row>(
    `SELECT key, COUNT(*) AS n, AVG(value) AS a, MIN(value) AS mn, MAX(value) AS mx FROM metrics
     WHERE key IN (${placeholders(keys.length)}) AND ts >= ? AND ts < ? GROUP BY key`,
    ...keys,
    from,
    to,
  );
  const agg = new Map(rows.map((r) => [String(r.key), r]));
  for (const key of keys) {
    const last = get<Row>('SELECT ts, value FROM metrics WHERE key = ? AND ts < ? ORDER BY ts DESC LIMIT 1', key, to);
    const a = agg.get(key);
    if (!a && !last) continue;
    const count = n0(a?.n);
    let p95: number | null = null;
    if (P95_KEYS.has(key) && count > 0) {
      const r = get<Row>('SELECT value FROM metrics WHERE key = ? AND ts >= ? AND ts < ? ORDER BY value LIMIT 1 OFFSET ?', key, from, to, Math.floor(0.95 * (count - 1)));
      p95 = nn(r?.value);
    }
    out[key] = { key, count, avg: nn(a?.a), min: nn(a?.mn), max: nn(a?.mx), p95, last: nn(last?.value), lastTs: nn(last?.ts) };
  }
  return out;
}

// ─── snapshots ─────────────────────────────────────────────────────────────

interface SnapRow {
  id: number;
  ts: number;
  data: unknown;
}

function latestSnapshots(kind: string, minTs: number, to: number, limit = 1): SnapRow[] {
  return all<Row>('SELECT id, ts, data FROM snapshots WHERE kind = ? AND ts >= ? AND ts < ? ORDER BY ts DESC, id DESC LIMIT ?', kind, minTs, to, limit).map(
    (r) => ({ id: n0(r.id), ts: n0(r.ts), data: parseJson<unknown>(r.data, null) }),
  );
}

function snapshotData(id: number): unknown {
  const r = get<Row>('SELECT data FROM snapshots WHERE id = ?', id);
  return parseJson<unknown>(r?.data, null);
}

/**
 * First snapshot (by time) whose extracted value differs from the first one in range. Binary search
 * over the snapshot ids (assumes a single change; ≈ log2(n) row reads).
 */
export function findValueChange(
  kind: string,
  from: number,
  to: number,
  extract: (data: unknown) => string | null,
): { ts: number; before: string; after: string } | null {
  const ids = all<Row>('SELECT id, ts FROM snapshots WHERE kind = ? AND ts >= ? AND ts < ? ORDER BY ts, id LIMIT 100000', kind, from, to).map((r) => ({
    id: n0(r.id),
    ts: n0(r.ts),
  }));
  if (ids.length < 2) return null;
  const first = extract(snapshotData(ids[0].id));
  const lastValue = extract(snapshotData(ids[ids.length - 1].id));
  if (first === null || lastValue === null || first === lastValue) return null;
  let lo = 0;
  let hi = ids.length - 1;
  let hiValue = lastValue;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    const v = extract(snapshotData(ids[mid].id));
    if (v === null || v === first) lo = mid;
    else {
      hi = mid;
      hiValue = v;
    }
  }
  return { ts: ids[hi].ts, before: first, after: hiValue };
}

function driverOf(data: unknown): string | null {
  const a = primaryWiredAdapter(normalizeAdapters(data, 0));
  return a?.driverVersion ? `${a.name}\u0000${a.driverVersion}` : null;
}

function firmwareOf(data: unknown): string | null {
  return typeof data === 'object' && data !== null && typeof (data as Record<string, unknown>).firmware === 'string'
    ? ((data as Record<string, unknown>).firmware as string)
    : null;
}

function readVpnTimeline(from: number, to: number): VpnState[] {
  const rows = all<Row>(
    `SELECT ts, CASE WHEN json_valid(data) THEN json_extract(data, '$.warp.connected') END AS c,
       CASE WHEN json_valid(data) THEN json_extract(data, '$.warp.splitTunnel') END AS st
     FROM snapshots WHERE kind = 'vpn' AND ts >= ? AND ts < ? ORDER BY ts LIMIT 100000`,
    from,
    to,
  );
  const out: VpnState[] = [];
  for (const r of rows) {
    const c = r.c === 1 || r.c === true ? true : r.c === 0 || r.c === false ? false : null;
    const st = r.st === 'include' || r.st === 'exclude' ? r.st : null;
    const prev = out[out.length - 1];
    if (prev && prev.connected === c && prev.splitTunnel === st) continue;
    out.push({ ts: n0(r.ts), connected: c, splitTunnel: st });
  }
  return out;
}

/**
 * User notes are both journal entries of changes ("Kabel getauscht") and "Lag jetzt markieren" marks.
 * Lag marks are no changes: recognized by details (origin/kind mentioning "lag") or the title.
 */
export function isLagMark(e: NetEvent): boolean {
  const d = e.details ?? {};
  for (const key of ['origin', 'kind', 'type', 'source']) {
    const v = d[key];
    if (typeof v === 'string' && /\blag\b/i.test(v)) return true;
  }
  return /\blags?\b|ruckel|hänger|ping|spitze|spike|verzögerung/i.test(e.title);
}

function buildChanges(input: { changeEvents: NetEvent[]; driver: ReturnType<typeof findValueChange>; firmware: ReturnType<typeof findValueChange> }): ChangeMarker[] {
  const out: ChangeMarker[] = [];
  if (input.driver) {
    const [name, before] = input.driver.before.split('\u0000');
    const after = input.driver.after.split('\u0000')[1] ?? input.driver.after;
    out.push({ ts: input.driver.ts, kind: 'driver', label: `Treiber ${name}: ${before} → ${after}` });
  }
  if (input.firmware) out.push({ ts: input.firmware.ts, kind: 'firmware', label: `Router-Firmware: ${input.firmware.before} → ${input.firmware.after}` });
  for (const e of input.changeEvents) {
    if (e.type === 'note') {
      if (!isLagMark(e)) out.push({ ts: e.ts, kind: 'note', label: e.title });
    } else if (e.type === 'vpn_change') out.push({ ts: e.ts, kind: 'vpn', label: e.title });
    else if (e.type === 'config_change') out.push({ ts: e.ts, kind: 'config', label: e.title });
    else if (e.type === 'session_start') {
      const d = e.details ?? {};
      if (d.resumed === true || typeof d.label !== 'string' || d.label.trim() === '') continue;
      out.push({ ts: e.ts, kind: 'session', label: `Langzeittest „${d.label}“` });
    }
  }
  return out.sort((a, b) => a.ts - b.ts).slice(-200);
}

// ─── main ──────────────────────────────────────────────────────────────────

export interface BuildInputOptions {
  /** generation time (default Date.now()) */
  now?: number;
  /** config override (default: settings via getConfig()) */
  config?: AppConfig;
}

export function buildDiagnosisInput(from: number, to: number, opts: BuildInputOptions = {}): DiagnosisInput {
  const now = opts.now ?? Date.now();
  const config = opts.config ?? getConfig();
  const targets = targetsOf(config);
  const groups = groupMembers(targets);
  const end = Math.max(from, Math.min(to, now));
  const analysisFrom = Math.max(from, to - DETAIL_MAX_MS);
  const linkFrom = Math.min(from, to - LINK_HISTORY_MS);

  const gw = targets.find((t) => t.enabled && t.host === '$gateway' && t.kind === 'icmp') ?? null;
  const coverageRef = gw ?? targets.find((t) => t.enabled && t.kind === 'icmp') ?? null;
  const windowTargets = new Set<string>(gw ? [gw.id] : []);
  for (const t of targets) if (t.enabled && t.kind === 'icmp' && t.segment === 'internet' && t.pairId) windowTargets.add(t.id);

  // VPN timeline (needed while aggregating the rollup buckets)
  const vpnTimeline = readVpnTimeline(analysisFrom - DAY, to);

  const rollups = aggregateRollupBuckets(readRollupBuckets(targets.map((t) => t.id), analysisFrom, to), {
    groups,
    windowTargets,
    gatewayId: gw?.id ?? null,
    coverageRefId: coverageRef?.id ?? null,
    vpnTimeline,
  });
  const sec = aggregateSecondsBuckets(readSecondsBuckets(from, to), analysisFrom);
  const hasSeconds = sec.totals !== null;

  const events = readEvents(from, to);
  const link = readLinkEvents(linkFrom, to);
  const haveWlanData = link.wlanConnects.length > 0 || latestSnapshots('wlan', 0, to).length > 0;
  const linkDrops = buildLinkDrops(link.events, haveWlanData ? link.wlanConnects : null);

  const minSnap = from - SNAPSHOT_MAX_AGE_MS;
  const routerSnap = latestSnapshots('router', minSnap, to)[0];
  const router = routerSnap ? normalizeRouterStatus(routerSnap.data, routerSnap.ts, config.router.ip) : null;
  const docsisSnap = latestSnapshots('docsis', minSnap, to)[0];
  const docsisFromSnap = docsisSnap ? normalizeDocsis(docsisSnap.data, docsisSnap.ts) : null;
  const docsisFromRouter = router?.docsis ?? null;
  const docsis =
    docsisFromSnap && docsisFromRouter
      ? docsisFromSnap.ts >= docsisFromRouter.ts ? docsisFromSnap : docsisFromRouter
      : (docsisFromSnap ?? docsisFromRouter);
  const adaptersSnap = latestSnapshots('adapters', minSnap, to)[0];
  const wlanSnap = latestSnapshots('wlan', minSnap, to)[0];
  const vpnSnap = latestSnapshots('vpn', minSnap, to)[0];

  const changeEvents = all<Row>(
    `${EVENT_SELECT} WHERE type IN ('note', 'session_start', 'vpn_change') AND ts >= ? AND ts < ? ORDER BY ts DESC LIMIT 500`,
    linkFrom,
    to,
  ).map(rowToEvent);

  const udpKeys = targets
    .filter((t) => t.enabled && t.kind === 'udp-dns' && t.segment === 'internet')
    .flatMap((t) => (['loss_pct', 'avg_ms', 'p99_ms', 'jitter_ms'] as const).map((s) => udpBurstKey(t.id, s)));
  const metrics = readMetrics([...METRIC_KEYS, ...udpKeys], analysisFrom, to);

  const latestTrace = (family: 4 | 6): TracerouteResult | null => {
    const r = get<Row>('SELECT * FROM traceroutes WHERE family = ? AND ts < ? ORDER BY ts DESC, id DESC LIMIT 1', family, to);
    return r ? rowToTraceroute(r) : null;
  };
  const traceAgg = get<Row>('SELECT COUNT(*) AS n, COALESCE(SUM(changed), 0) AS c FROM traceroutes WHERE ts >= ? AND ts < ?', from, to);
  const speedtests: SpeedtestResult[] = all<Row>(
    `SELECT id, ${SPEEDTEST_COLUMNS.replace(', series', '')} FROM speedtests WHERE ts >= ? AND ts < ? ORDER BY ts LIMIT 1000`,
    from,
    to,
  ).map((r) => rowToSpeedtest(r, false));
  const sessions: TestSession[] = all<Row>(
    'SELECT * FROM sessions WHERE started_at < ? AND (ended_at IS NULL OR ended_at >= ?) ORDER BY started_at LIMIT 200',
    to,
    from,
  ).map(rowToSession);

  // coverage: classified seconds, or ICMP minutes of the reference target when no classification exists
  const secondsCovered = sec.totals?.covered ?? 0;
  const coveredSeconds = Math.max(secondsCovered, rollups.refMinutes * 60);
  const rangeMs = Math.max(0, end - from);
  const daysCovered = hasSeconds
    ? sec.daily.filter((d) => d.covered >= 3600).length
    : Object.values(rollups.refMinutesByDay).filter((m) => m >= 60).length;
  const coverage: CoverageInfo = {
    rangeMs,
    coveredSeconds,
    coveragePct: rangeMs > 0 ? Math.min(100, ((coveredSeconds * 1000) / rangeMs) * 100) : 0,
    hasSeconds,
    firstTs: sec.firstTs ?? rollups.firstTs,
    lastTs: sec.lastTs ?? rollups.lastTs,
    daysCovered,
    samples: rollups.samples,
    gaps: readGaps(hasSeconds ? from : analysisFrom, to, hasSeconds, coverageRef?.id ?? null),
    analysisFrom,
  };

  return {
    from,
    to,
    now,
    config,
    targets,
    stats: rollups.stats,
    statsStable: rollups.statsStable,
    loadStats: rollups.loadStats,
    hourly: rollups.hourly,
    daily: rollups.daily,
    periods: rollups.periods,
    windows: rollups.windows,
    lanHours: rollups.lanHours,
    seconds: sec.totals,
    secondsHourly: sec.hourly,
    secondsDaily: sec.daily,
    secondsWindows: sec.windows,
    esPerMinute: readEsPerMinute(Math.max(from, to - ES_SERIES_MS), to),
    loadCorrelation: sec.loadCorrelation,
    events,
    spikeTimes: readSpikeTimes(from, to),
    linkDrops,
    linkFrom,
    linkDays: buildLinkDays(link.events),
    linkSpeed: readLinkSpeed(analysisFrom, to, end),
    speedtests,
    traceroutes: { latest4: latestTrace(4), latest6: latestTrace(6), count: n0(traceAgg?.n), changed: n0(traceAgg?.c) },
    router,
    routerTs: routerSnap?.ts ?? null,
    docsis,
    docsisTs: docsis?.ts ?? null,
    adapters: adaptersSnap ? normalizeAdapters(adaptersSnap.data, adaptersSnap.ts) : null,
    wlan: wlanSnap ? normalizeWlan(wlanSnap.data, wlanSnap.ts) : null,
    vpn: vpnSnap ? normalizeVpn(vpnSnap.data, vpnSnap.ts) : null,
    nat: normalizeNat(latestSnapshots('nat', minSnap, to, 4)),
    mtu: normalizeMtu(latestSnapshots('mtu', minSnap, to, 4)),
    metrics,
    changes: buildChanges({
      changeEvents,
      driver: findValueChange('adapters', linkFrom, to, driverOf),
      firmware: findValueChange('router', linkFrom, to, firmwareOf),
    }),
    vpnTimeline,
    vpnCompare: rollups.vpnCompare,
    sessions,
    coverage,
  };
}
