// Pure aggregation of pre-aggregated SQL rows (15-min buckets) into the DiagnosisInput structures.
// Rollup rows are split by bucket, "speed test minute" (st) and "stable minute" (no link problem,
// no own high load). Seconds rows are 15-min sums of seconds_1m.
import type { SecondsRollup } from '../../shared/types';
import { type AccParts, type StatsAcc, accFromParts, addAcc, newAcc, summarizeAcc } from './aggregate';
import { emptySecondsTotals, addSeconds } from './seconds';
import { HOUR, WINDOW_MS, alignDown, isBaseHour, isEveningHour, localDayKey, localDayStart, localHour } from './time';
import type {
  DayPeriods,
  GroupId,
  HourStat,
  LoadCorrelation,
  PeriodTotals,
  SecondsDay,
  SecondsTotals,
  SecondsWindow,
  StatsSummary,
  VpnCompare,
  VpnState,
  WindowStat,
} from './types';

export interface RollupBucketRow {
  targetId: string;
  /** bucket start (multiple of 15 min) */
  b: number;
  /** 1 = minutes overlapping a speed test */
  st: boolean;
  /** 0 = minutes with link problems or own high load */
  stable: boolean;
  parts: AccParts;
}

export interface RollupAggregation {
  stats: Record<string, StatsSummary>;
  statsStable: Record<string, StatsSummary>;
  loadStats: Record<string, StatsSummary>;
  hourly: Record<string, StatsSummary[]>;
  daily: Record<string, DayPeriods[]>;
  periods: Record<string, PeriodTotals>;
  windows: Record<string, WindowStat[]>;
  lanHours: HourStat[];
  vpnCompare: VpnCompare | null;
  /** latency samples of all targets (speed-test minutes included) */
  samples: number;
  /** minutes with data of the coverage reference target per local day */
  refMinutesByDay: Record<string, number>;
  /** minutes with data of the coverage reference target */
  refMinutes: number;
  firstTs: number | null;
  lastTs: number | null;
}

export interface RollupAggregationOptions {
  groups: Readonly<Partial<Record<GroupId, readonly string[]>>>;
  /** targets that get 15-min windows (dual-stack pairs + gateway) */
  windowTargets: ReadonlySet<string>;
  gatewayId: string | null;
  /** target used for the coverage fallback (minutes per day) */
  coverageRefId: string | null;
  /** VPN state changes, ascending (for the WARP on/off comparison of '@internet') */
  vpnTimeline: readonly VpnState[];
}

interface BucketInfo {
  hour: number;
  day: string;
  dayStart: number;
  evening: boolean;
  base: boolean;
  hourTs: number;
}

interface DayAcc {
  dayStart: number;
  evening: StatsAcc;
  base: StatsAcc;
  all: StatsAcc;
}

function getAcc<K>(m: Map<K, StatsAcc>, k: K): StatsAcc {
  let a = m.get(k);
  if (!a) {
    a = newAcc();
    m.set(k, a);
  }
  return a;
}

/** VPN state for the whole bucket [b, b + 15 min): null when unknown or changing inside */
export function vpnStateForBucket(timeline: readonly VpnState[], b: number): boolean | null {
  let lo = 0;
  let hi = timeline.length - 1;
  let idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (timeline[mid].ts <= b) {
      idx = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (idx < 0) return null;
  const next = timeline[idx + 1];
  if (next && next.ts < b + WINDOW_MS && next.connected !== timeline[idx].connected) return null;
  return timeline[idx].connected;
}

export function aggregateRollupBuckets(rows: readonly RollupBucketRow[], opts: RollupAggregationOptions): RollupAggregation {
  const memberOf = new Map<string, string[]>();
  for (const [g, members] of Object.entries(opts.groups) as [GroupId, readonly string[]][]) {
    for (const m of members) {
      const list = memberOf.get(m) ?? [];
      list.push(g);
      memberOf.set(m, list);
    }
  }
  const info = new Map<number, BucketInfo>();
  const bucketInfo = (b: number): BucketInfo => {
    let i = info.get(b);
    if (!i) {
      const hour = localHour(b);
      i = { hour, day: localDayKey(b), dayStart: localDayStart(b), evening: isEveningHour(hour), base: isBaseHour(hour), hourTs: alignDown(b, HOUR) };
      info.set(b, i);
    }
    return i;
  };

  const all = new Map<string, StatsAcc>();
  const stable = new Map<string, StatsAcc>();
  const load = new Map<string, StatsAcc>();
  const hourly = new Map<string, StatsAcc[]>();
  const daily = new Map<string, Map<string, DayAcc>>();
  const windows = new Map<string, Map<number, StatsAcc>>();
  const lanHours = new Map<number, StatsAcc>();
  const vpnOn = newAcc();
  const vpnOff = newAcc();
  const vpnBuckets = { on: new Set<number>(), off: new Set<number>() };
  const refMinutesByDay: Record<string, number> = {};
  let refMinutes = 0;
  let samples = 0;
  let firstTs: number | null = null;
  let lastTs: number | null = null;

  for (const row of rows) {
    const acc = accFromParts(row.parts);
    samples += acc.sent;
    if (acc.minutes === 0) continue;
    firstTs = firstTs === null ? row.b : Math.min(firstTs, row.b);
    lastTs = lastTs === null ? row.b + WINDOW_MS : Math.max(lastTs, row.b + WINDOW_MS);
    const bi = bucketInfo(row.b);
    if (row.targetId === opts.coverageRefId) {
      refMinutes += acc.minutes;
      refMinutesByDay[bi.day] = (refMinutesByDay[bi.day] ?? 0) + acc.minutes;
    }
    const ids = [row.targetId, ...(memberOf.get(row.targetId) ?? [])];
    for (const id of ids) {
      if (row.st) {
        addAcc(getAcc(load, id), acc);
        continue;
      }
      addAcc(getAcc(all, id), acc);
      if (!row.stable) continue;
      addAcc(getAcc(stable, id), acc);
      let h = hourly.get(id);
      if (!h) {
        h = Array.from({ length: 24 }, () => newAcc());
        hourly.set(id, h);
      }
      addAcc(h[bi.hour], acc);
      let days = daily.get(id);
      if (!days) {
        days = new Map();
        daily.set(id, days);
      }
      let d = days.get(bi.day);
      if (!d) {
        d = { dayStart: bi.dayStart, evening: newAcc(), base: newAcc(), all: newAcc() };
        days.set(bi.day, d);
      }
      addAcc(d.all, acc);
      if (bi.evening) addAcc(d.evening, acc);
      if (bi.base) addAcc(d.base, acc);
      if (opts.windowTargets.has(id)) {
        let w = windows.get(id);
        if (!w) {
          w = new Map();
          windows.set(id, w);
        }
        addAcc(getAcc(w, row.b), acc);
      }
      if (id === opts.gatewayId) addAcc(getAcc(lanHours, bi.hourTs), acc);
      if (id === '@internet' && opts.vpnTimeline.length > 0) {
        const state = vpnStateForBucket(opts.vpnTimeline, row.b);
        if (state === true) {
          addAcc(vpnOn, acc);
          vpnBuckets.on.add(row.b);
        } else if (state === false) {
          addAcc(vpnOff, acc);
          vpnBuckets.off.add(row.b);
        }
      }
    }
  }

  const toRecord = (m: Map<string, StatsAcc>): Record<string, StatsSummary> => {
    const out: Record<string, StatsSummary> = {};
    for (const [k, a] of m) out[k] = summarizeAcc(a);
    return out;
  };
  const hourlyOut: Record<string, StatsSummary[]> = {};
  for (const [k, list] of hourly) hourlyOut[k] = list.map(summarizeAcc);
  const dailyOut: Record<string, DayPeriods[]> = {};
  const periodsOut: Record<string, PeriodTotals> = {};
  for (const [k, days] of daily) {
    const evening = newAcc();
    const base = newAcc();
    const list: DayPeriods[] = [];
    for (const [day, d] of days) {
      addAcc(evening, d.evening);
      addAcc(base, d.base);
      list.push({ day, dayStart: d.dayStart, evening: summarizeAcc(d.evening), base: summarizeAcc(d.base), all: summarizeAcc(d.all) });
    }
    list.sort((a, b) => a.dayStart - b.dayStart);
    dailyOut[k] = list;
    periodsOut[k] = { evening: summarizeAcc(evening), base: summarizeAcc(base) };
  }
  const windowsOut: Record<string, WindowStat[]> = {};
  for (const [k, w] of windows) {
    windowsOut[k] = [...w.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([ts, a]) => {
        const s = summarizeAcc(a);
        return { ts, sent: s.sent, lost: s.lost, lossPct: s.lossPct, p50: s.p50, p95: s.p95 };
      });
  }
  const lanOut: HourStat[] = [...lanHours.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([ts, a]) => {
      const s = summarizeAcc(a);
      return { ts, sent: s.sent, lost: s.lost, lossPct: s.lossPct, p99: s.p99 };
    });
  const vpnCompare: VpnCompare | null =
    vpnBuckets.on.size > 0 && vpnBuckets.off.size > 0
      ? { on: summarizeAcc(vpnOn), off: summarizeAcc(vpnOff), onMs: vpnBuckets.on.size * WINDOW_MS, offMs: vpnBuckets.off.size * WINDOW_MS }
      : null;

  return {
    stats: toRecord(all),
    statsStable: toRecord(stable),
    loadStats: toRecord(load),
    hourly: hourlyOut,
    daily: dailyOut,
    periods: periodsOut,
    windows: windowsOut,
    lanHours: lanOut,
    vpnCompare,
    samples,
    refMinutesByDay,
    refMinutes,
    firstTs,
    lastTs,
  };
}

// ─── seconds ───────────────────────────────────────────────────────────────

export interface SecondsBucketRow extends Omit<SecondsRollup, 'ts'> {
  b: number;
  minutes: number;
  /** minutes with own high load (self_load ≥ threshold) and their errored/covered seconds */
  loadMinutes: number;
  esLoad: number;
  coveredLoad: number;
  firstTs: number;
  lastTs: number;
}

export interface SecondsAggregation {
  totals: SecondsTotals | null;
  hourly: SecondsTotals[];
  daily: SecondsDay[];
  windows: SecondsWindow[];
  loadCorrelation: LoadCorrelation | null;
  firstTs: number | null;
  lastTs: number | null;
}

/** @param windowsFrom 15-min windows are only produced from this time on (bounded output) */
export function aggregateSecondsBuckets(rows: readonly SecondsBucketRow[], windowsFrom: number): SecondsAggregation {
  const totals = emptySecondsTotals();
  const hourly = Array.from({ length: 24 }, () => emptySecondsTotals());
  const daily = new Map<string, SecondsDay>();
  const windows: SecondsWindow[] = [];
  let loadMinutes = 0;
  let esLoad = 0;
  let coveredLoad = 0;
  let firstTs: number | null = null;
  let lastTs: number | null = null;
  for (const r of [...rows].sort((a, b) => a.b - b.b)) {
    if (r.minutes <= 0) continue;
    addSeconds(totals, r, r.minutes);
    addSeconds(hourly[localHour(r.b)], r, r.minutes);
    const key = localDayKey(r.b);
    let d = daily.get(key);
    if (!d) {
      d = { day: key, dayStart: localDayStart(r.b), covered: 0, bad: 0, es: 0 };
      daily.set(key, d);
    }
    d.covered += r.covered;
    d.bad += Math.max(0, r.covered - r.good);
    d.es += r.es;
    if (r.b >= windowsFrom) windows.push({ ts: r.b, covered: r.covered, link: r.link, lan: r.lan });
    loadMinutes += r.loadMinutes;
    esLoad += r.esLoad;
    coveredLoad += r.coveredLoad;
    firstTs = firstTs === null ? r.firstTs : Math.min(firstTs, r.firstTs);
    lastTs = lastTs === null ? r.lastTs : Math.max(lastTs, r.lastTs);
  }
  if (totals.minutes === 0) {
    return { totals: null, hourly, daily: [], windows: [], loadCorrelation: null, firstTs: null, lastTs: null };
  }
  return {
    totals,
    hourly,
    daily: [...daily.values()].sort((a, b) => a.dayStart - b.dayStart),
    windows,
    loadCorrelation: {
      loadMinutes,
      esLoad,
      coveredLoad,
      esIdle: Math.max(0, totals.es - esLoad),
      coveredIdle: Math.max(0, totals.covered - coveredLoad),
    },
    firstTs,
    lastTs,
  };
}
