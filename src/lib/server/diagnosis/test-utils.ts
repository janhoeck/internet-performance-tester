// Builders for synthetic DiagnosisInput fixtures (unit tests only – not used at runtime).
import { type AppConfig, DEFAULT_CONFIG } from '../../shared/config';
import type { EventType, NetEvent, Severity } from '../../shared/types';
import { EMPTY_SUMMARY } from './aggregate';
import { DAY, HOUR } from './time';
import type { DayPeriods, DiagnosisInput, LinkDrop, SecondsTotals, StatsSummary, TargetMeta } from './types';

/** Fri 09.10.2026 12:00 local time */
export const T_END = new Date(2026, 9, 9, 12, 0, 0).getTime();

export function targetsFromConfig(cfg: AppConfig): TargetMeta[] {
  return cfg.targets.map((t) => ({
    id: t.id, name: t.name, host: t.host, segment: t.segment, family: t.family, kind: t.kind,
    pairId: t.pairId ?? null, enabled: t.enabled,
  }));
}

/** StatsSummary with sensible defaults (1 h at 1 Hz, no loss). lossPct is derived from sent/lost. */
export function stats(p: Partial<StatsSummary> = {}): StatsSummary {
  const sent = p.sent ?? 3600;
  const lost = p.lost ?? 0;
  const p50 = p.p50 ?? 20;
  return {
    ...EMPTY_SUMMARY,
    sent,
    lost,
    lossPct: p.lossPct ?? (sent > 0 ? (lost / sent) * 100 : null),
    min: p.min ?? p50 * 0.8,
    avg: p.avg ?? p50 * 1.05,
    max: p.max ?? (p.p99 ?? p50 * 1.6) * 1.5,
    p50,
    p95: p.p95 ?? p50 * 1.3,
    p99: p.p99 ?? p50 * 1.6,
    jitter: p.jitter ?? 2,
    spikes: p.spikes ?? 0,
    over200: p.over200 ?? 0,
    minutes: p.minutes ?? Math.max(1, Math.round(sent / 60)),
  };
}

export function secondsTotals(p: Partial<SecondsTotals> = {}): SecondsTotals {
  const covered = p.covered ?? 3 * 86_400;
  const bad = (p.link ?? 0) + (p.lan ?? 0) + (p.access ?? 0) + (p.aftr ?? 0) + (p.backbone ?? 0) + (p.remote ?? 0) + (p.unknown ?? 0);
  return {
    covered,
    good: p.good ?? covered - bad,
    link: p.link ?? 0,
    lan: p.lan ?? 0,
    access: p.access ?? 0,
    aftr: p.aftr ?? 0,
    backbone: p.backbone ?? 0,
    remote: p.remote ?? 0,
    unknown: p.unknown ?? 0,
    es: p.es ?? bad,
    ses: p.ses ?? 0,
    selfLoad: p.selfLoad ?? 0,
    minutes: p.minutes ?? Math.round(covered / 60),
    bad: p.bad ?? bad,
  };
}

/** spreads totals evenly over the 24 hours of the day (optionally overriding single hours) */
export function hourlySeconds(total: SecondsTotals, overrides: Record<number, Partial<SecondsTotals>> = {}): SecondsTotals[] {
  return Array.from({ length: 24 }, (_, h) => {
    const share = (v: number) => Math.round(v / 24);
    return secondsTotals({
      covered: share(total.covered),
      link: share(total.link),
      lan: share(total.lan),
      access: share(total.access),
      aftr: share(total.aftr),
      backbone: share(total.backbone),
      remote: share(total.remote),
      unknown: share(total.unknown),
      es: share(total.es),
      ses: share(total.ses),
      selfLoad: share(total.selfLoad),
      ...overrides[h],
    });
  });
}

const HEALTHY_P50: Record<string, number> = {
  gw: 1, gw6: 1, 'gw-tcp': 4, 'gw-dns': 3, isp6: 12, aftr: 15, isp4: 14,
  cf4: 18, cf6: 17, g4: 17, g6: 18, q4: 22, q6: 22,
  'cf4-udp': 20, 'cf6-udp': 19, 'cf4-tcp': 20, 'cf6-tcp': 19, 'aws-fra': 22, 'aws-irl': 40,
};

/** A healthy 3-day input with all default targets and a clean seconds classification. */
export function healthyInput(overrides: Partial<DiagnosisInput> = {}): DiagnosisInput {
  const config = structuredClone(DEFAULT_CONFIG);
  const targets = targetsFromConfig(config);
  const from = T_END - 3 * DAY;
  const statsMap: Record<string, StatsSummary> = {};
  for (const t of targets) {
    if (!t.enabled) continue;
    const p50 = HEALTHY_P50[t.id] ?? 20;
    statsMap[t.id] = stats({ p50, p99: p50 + (t.segment === 'lan' ? 2 : 12), sent: 3 * 86_400, minutes: 3 * 1440 });
  }
  statsMap['@internet'] = stats({ p50: 18, p99: 30, sent: 4 * 3 * 86_400, minutes: 3 * 1440 });
  statsMap['@internet4'] = stats({ p50: 18, p99: 30, sent: 2 * 3 * 86_400, minutes: 3 * 1440 });
  statsMap['@internet6'] = stats({ p50: 18, p99: 30, sent: 2 * 3 * 86_400, minutes: 3 * 1440 });
  statsMap['@game'] = stats({ p50: 30, p99: 50, sent: 2 * 3 * 8640, minutes: 3 * 1440 });
  const seconds = secondsTotals({ covered: Math.round(3 * 86_400 * 0.9), unknown: 20 });
  const base: DiagnosisInput = {
    from,
    to: T_END,
    now: T_END,
    config,
    targets,
    stats: statsMap,
    statsStable: { ...statsMap },
    loadStats: {},
    hourly: {},
    daily: {},
    periods: {},
    windows: {},
    lanHours: [],
    seconds,
    secondsHourly: hourlySeconds(seconds),
    secondsDaily: [0, 1, 2].map((i) => ({
      day: `2026-10-0${6 + i}`,
      dayStart: new Date(2026, 9, 6 + i).getTime(),
      covered: Math.round(86_400 * 0.9),
      bad: 7,
      es: 7,
    })),
    secondsWindows: [],
    esPerMinute: [],
    loadCorrelation: { loadMinutes: 0, esLoad: 0, coveredLoad: 0, esIdle: 20, coveredIdle: seconds.covered },
    events: { counts: {}, byType: {}, truncated: [] },
    spikeTimes: [],
    linkDrops: [],
    linkFrom: T_END - 30 * DAY,
    linkDays: [],
    linkSpeed: { currentMbps: 1000, currentTs: T_END - HOUR, msBelow1g: 0, msObserved: 3 * DAY, minMbps: 1000 },
    speedtests: [],
    traceroutes: { latest4: null, latest6: null, count: 0, changed: 0 },
    router: null,
    routerTs: null,
    docsis: null,
    docsisTs: null,
    adapters: null,
    wlan: null,
    vpn: null,
    nat: [],
    mtu: [],
    metrics: {},
    changes: [],
    vpnTimeline: [],
    vpnCompare: null,
    sessions: [],
    coverage: {
      rangeMs: 3 * DAY,
      coveredSeconds: seconds.covered,
      coveragePct: 90,
      hasSeconds: true,
      firstTs: from,
      lastTs: T_END,
      daysCovered: 3,
      samples: 3 * 86_400 * 12,
      gaps: { count: 0, totalMs: 0, longestMs: 0 },
      analysisFrom: from,
    },
  };
  return { ...base, ...overrides };
}

let nextId = 1;

export function ev(type: EventType, ts: number, extra: Partial<NetEvent> = {}): NetEvent {
  const severity: Severity = extra.severity ?? 'warn';
  return { id: nextId++, ts, type, severity, title: extra.title ?? type, source: extra.source ?? 'engine', ...extra };
}

/** Adds events to byType/counts (keeps them sorted ascending). */
export function withEvents(input: DiagnosisInput, events: readonly NetEvent[]): DiagnosisInput {
  const byType: Partial<Record<EventType, NetEvent[]>> = {};
  for (const [k, list] of Object.entries(input.events.byType) as [EventType, NetEvent[]][]) byType[k] = [...list];
  const counts: Partial<Record<EventType, number>> = { ...input.events.counts };
  for (const e of events) {
    (byType[e.type] ??= []).push(e);
    counts[e.type] = (counts[e.type] ?? 0) + 1;
  }
  for (const list of Object.values(byType)) list?.sort((a, b) => a.ts - b.ts);
  return { ...input, events: { counts, byType, truncated: input.events.truncated } };
}

export function drop(ts: number, cause: LinkDrop['cause'] = 'runtime', extra: Partial<LinkDrop> = {}): LinkDrop {
  return { id: nextId++, ts, endTs: ts + 6000, cause, relinkMbps: 1000, downtimeMs: 6000, wlanFailover: null, ...extra };
}

export function dayPeriods(day: string, dayStart: number, evening: Partial<StatsSummary>, base: Partial<StatsSummary>): DayPeriods {
  return { day, dayStart, evening: stats(evening), base: stats(base), all: stats(base) };
}
