// Synthetic demo database for UI development – no engine, no network traffic.
//
//   npx tsx scripts/seed-demo.ts [dbPath]          (default: data/demo.db)
//   then start the UI on it, e.g. PowerShell:  $env:NETDIAG_DB='data/demo.db'; npm run dev:web
//
// Generates two days of measurements ending now: 1 Hz ICMP samples for the reference targets
// (gw, gw6, isp6, aftr, isp4, cf4, cf6, g4, g6) plus the UDP/TCP targets at their intervals, with
// evening (19–23 h) congestion spikes that start at the CMTS hop (isp6) and propagate to every
// target behind it, runtime NIC link drops with WLAN failover, a standby gap followed by a
// 100 Mbit/s relink, one router reboot, speed tests, traceroutes, DOCSIS polls, snapshots, NIC
// link history and two sessions. Minute rollups and classified seconds are computed from the
// generated samples with the shared helpers the engine uses (stats.ts summarize / isSpike).
// An existing file is only replaced when it carries the demo marker (never a real database).
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import type { EngineDb } from '../engine/core/types';
import { openEngineDb } from '../engine/db/engine-db';
import { type AppConfig, mergeConfig, spikeRuleFor } from '../src/lib/shared/config';
import { type DocsisChannelInput, type RatedDocsisSnapshot, classifyLogMessage, rateDocsis } from '../src/lib/shared/docsis';
import { fmtDuration, fmtNumber } from '../src/lib/shared/format';
import { udpBurstKey } from '../src/lib/shared/metrics';
import { type Baseline, type SpikeRule, isSpike, spikeSeverity, summarize } from '../src/lib/shared/stats';
import {
  type AdapterInfo,
  type AdapterSnapshot,
  type BufferbloatGrade,
  type MetricPoint,
  type MtuResult,
  type NatResult,
  type NetEvent,
  type RouterAttachedDevice,
  type RouterStatus,
  type Rollup,
  SampleFlag,
  SampleStatus,
  type SampleStatusCode,
  type SecondsRollup,
  type Segment,
  type SnapshotKind,
  type SpeedSeriesPoint,
  type SpeedtestResult,
  type TraceHop,
  type TracerouteResult,
  type VpnInfo,
  type WlanInfo,
} from '../src/lib/shared/types';

const SEC = 1000;
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

export const DEMO_MARKER_KEY = 'demo.seed';
export const DEFAULT_DEMO_DB = path.join('data', 'demo.db');

export interface SeedOptions {
  dbPath: string;
  /** end of the generated range (default: now), rounded down to the minute */
  end?: number;
  /** length of the generated range (default: 2 days) */
  spanMs?: number;
  /** PRNG seed – same seed + same range = same data */
  seed?: number;
  /** days of imported NIC link history (Windows event log) before the range (default 45) */
  historyDays?: number;
  /** print progress */
  verbose?: boolean;
}

export interface SeedSummary {
  dbPath: string;
  from: number;
  to: number;
  samples: number;
  rollups: number;
  secondsRows: number;
  events: number;
  metrics: number;
  snapshots: number;
  speedtests: number;
  traceroutes: number;
  sessions: number;
  durationMs: number;
}

// ─── random numbers ─────────────────────────────────────────────────────────

export class Rng {
  private state: number;
  private spare: number | null = null;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** mulberry32, uniform in [0, 1) */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  range(a: number, b: number): number {
    return a + (b - a) * this.next();
  }

  int(a: number, b: number): number {
    return Math.floor(this.range(a, b + 1));
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  /** standard normal (Box–Muller) */
  gauss(): number {
    if (this.spare !== null) {
      const s = this.spare;
      this.spare = null;
      return s;
    }
    const u = Math.max(1e-12, this.next());
    const v = this.next();
    const r = Math.sqrt(-2 * Math.log(u));
    this.spare = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  }

  /** exponential with mean 1 */
  expo(): number {
    return -Math.log(Math.max(1e-12, 1 - this.next()));
  }
}

// ─── local time helpers ─────────────────────────────────────────────────────

const pad2 = (n: number) => String(n).padStart(2, '0');

function localHour(ts: number): number {
  const d = new Date(ts);
  return d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600;
}

function localDayStart(ts: number): number {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function localTime(dayStart: number, hours: number, minutes = 0, seconds = 0): number {
  const d = new Date(dayStart);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), hours, minutes, seconds).getTime();
}

function addDays(dayStart: number, n: number): number {
  const d = new Date(dayStart);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n).getTime();
}

/** "09.10.2026 18:29:13" (router log style) */
function routerTimeText(ts: number): string {
  const d = new Date(ts);
  return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.${d.getFullYear()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** 0..1 bump for the evening peak (19–23 h with 30-min ramps). */
export function eveningFactor(ts: number): number {
  const h = localHour(ts);
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  return clamp((h - 18.5) / 0.5) * clamp((23.5 - h) / 0.5);
}

const alignSec = (ts: number) => Math.round(ts / SEC) * SEC;

// ─── target models ──────────────────────────────────────────────────────────

interface TargetModel {
  id: string;
  kind: 'icmp' | 'tcp' | 'udp-dns';
  segment: Segment;
  /** median RTT (ms) outside the evening */
  base: number;
  sd: number;
  /** random loss probability per sample */
  lossP: number;
  /** behind the router's WAN side (affected by DOCSIS congestion, router reboot WAN phase) */
  wan: boolean;
  /** sampling period (s) and phase within it */
  every: number;
  phase: number;
  /** send offset within the second (TCP/UDP probes are not on the 1 Hz ICMP grid) */
  offsetMs: number;
}

const icmp = (id: string, segment: Segment, base: number, sd: number, lossP: number, wan: boolean): TargetModel => ({
  id, kind: 'icmp', segment, base, sd, lossP, wan, every: 1, phase: 0, offsetMs: 0,
});
const slow = (
  id: string, kind: 'tcp' | 'udp-dns', segment: Segment, base: number, sd: number, wan: boolean, every: number, phase: number, offsetMs: number,
): TargetModel => ({ id, kind, segment, base, sd, lossP: 0.0004, wan, every, phase, offsetMs });

export const DEMO_TARGETS: readonly TargetModel[] = [
  icmp('gw', 'lan', 0.7, 0.3, 0.0001, false),
  icmp('gw6', 'lan', 0.9, 0.3, 0.0001, false),
  icmp('isp6', 'docsis', 9.5, 2.2, 0.0015, true),
  icmp('aftr', 'aftr', 13, 1.6, 0.0006, true),
  icmp('isp4', 'isp', 13.5, 2.5, 0.004, true),
  icmp('cf4', 'internet', 14.2, 1.3, 0.0003, true),
  icmp('cf6', 'internet', 12.4, 1.2, 0.0003, true),
  icmp('g4', 'internet', 15.1, 1.4, 0.0003, true),
  icmp('g6', 'internet', 13.6, 1.3, 0.0003, true),
  slow('gw-tcp', 'tcp', 'router', 1.4, 0.5, false, 10, 3, 310),
  slow('gw-dns', 'udp-dns', 'router', 2.3, 0.9, false, 10, 6, 620),
  slow('cf4-udp', 'udp-dns', 'internet', 13.6, 1.2, true, 5, 1, 140),
  slow('cf6-udp', 'udp-dns', 'internet', 12.1, 1.1, true, 5, 2, 160),
  slow('cf4-tcp', 'tcp', 'internet', 14.8, 1.4, true, 10, 4, 450),
  slow('cf6-tcp', 'tcp', 'internet', 12.9, 1.3, true, 10, 5, 470),
  slow('aws-fra', 'tcp', 'game', 16.5, 1.5, true, 10, 7, 520),
  slow('aws-irl', 'tcp', 'game', 38.5, 2, true, 10, 8, 540),
];

/** extra median latency (ms) behind the CMTS at the evening peak */
const EVENING_ELEVATION_MS = 3.5;
const GAME_TARGETS = new Set(['aws-fra', 'aws-irl']);
const SPIKE_EVENT_TARGETS = new Set(['gw', 'isp6', 'cf4']);
const BURST_EVENT_TARGETS = new Set(['gw', 'isp6', 'cf4', 'cf6']);

// ─── plan (what happens when) ───────────────────────────────────────────────

interface Interval {
  from: number;
  to: number;
}

interface DropPlan {
  ts: number;
  downMs: number;
  relinkMbps: number;
  /** Windows switched to WLAN within 1 s */
  failover: boolean;
  /** WLAN → Ethernet switch back this long after the relink */
  backMs: number;
}

interface RebootPlan {
  ts: number;
  /** Ethernet flaps while the router's switch restarts */
  flaps: Interval[];
  lanUpAt: number;
  wanUpAt: number;
}

interface SpeedPlan {
  ts: number;
  endTs: number;
  trigger: 'schedule' | 'manual';
  linkMbps: number;
  result: SpeedtestResult;
}

interface SessionPlan {
  from: number;
  to: number;
  label: string;
  status: 'completed' | 'running';
  plannedEndAt: number | null;
}

export interface Plan {
  from: number;
  to: number;
  sessions: SessionPlan[];
  /** PC asleep (no samples, no metrics) */
  standby: Interval;
  drops: DropPlan[];
  reboot: RebootPlan;
  speedtests: SpeedPlan[];
  /** large download on the PC itself (own traffic ≥ 80 % of the link → self-load seconds) */
  download: Interval;
  gaming: Interval[];
  notes: number[];
  routeChangeAt: number;
  routerBootAt: number;
  /** link speed change points, ascending, first at `from` */
  linkSpeed: { ts: number; mbps: number }[];
  noSamples: Interval[];
  linkDown: Interval[];
  failover: Interval[];
  lossAll: Interval[];
  afterRelink: Interval[];
  lanDown: Interval[];
  wanDown: Interval[];
}

const SPEED_PHASES = { idleMs: 10_000, downMs: 15_000, upMs: 15_000, totalMs: 42_000 } as const;

function gradeFor(ms: number): BufferbloatGrade {
  if (ms < 5) return 'A+';
  if (ms < 30) return 'A';
  if (ms < 60) return 'B';
  if (ms < 200) return 'C';
  if (ms < 400) return 'D';
  return 'F';
}

function makeSpeedtest(ts: number, linkMbps: number, trigger: 'schedule' | 'manual', rng: Rng): SpeedtestResult {
  const ef = eveningFactor(ts);
  const limited = linkMbps < 1000;
  const down = limited ? rng.range(92.5, 94.2) : rng.range(455, 545) * (1 - ef * 0.25);
  const up = rng.range(45.5, 51.5);
  const idle = rng.range(13.2, 15.1) + ef * EVENING_ELEVATION_MS;
  const idleJitter = rng.range(0.7, 1.9);
  const loadedDown = idle + (limited ? rng.range(12, 18) : rng.range(19, 28)) * (1 + ef * 0.6);
  const loadedUp = idle + rng.range(33, 46) * (1 + ef * 0.5);
  const bloatDown = loadedDown - idle;
  const bloatUp = loadedUp - idle;
  const series: SpeedSeriesPoint[] = [];
  for (let t = 0; t < SPEED_PHASES.idleMs + SPEED_PHASES.downMs + SPEED_PHASES.upMs; t += 250) {
    if (t < SPEED_PHASES.idleMs) {
      series.push({ t, phase: 'idle', mbps: null, rtt: Math.round((idle + rng.gauss() * idleJitter) * 10) / 10 });
      continue;
    }
    const isDown = t < SPEED_PHASES.idleMs + SPEED_PHASES.downMs;
    const phaseT = t - (isDown ? SPEED_PHASES.idleMs : SPEED_PHASES.idleMs + SPEED_PHASES.downMs);
    const ramp = Math.min(1, phaseT / 2500);
    const mbps = (isDown ? down : up) * ramp * rng.range(0.94, 1.04);
    const rtt = (isDown ? loadedDown : loadedUp) * (0.55 + 0.45 * ramp) + rng.gauss() * 6;
    series.push({ t, phase: isDown ? 'download' : 'upload', mbps: Math.round(mbps * 10) / 10, rtt: Math.round(Math.max(idle, rtt) * 10) / 10 });
  }
  series.push({ t: SPEED_PHASES.idleMs + SPEED_PHASES.downMs + SPEED_PHASES.upMs, phase: 'done', mbps: null, rtt: null });
  const r1 = (v: number) => Math.round(v * 10) / 10;
  return {
    ts,
    endTs: ts + SPEED_PHASES.totalMs,
    trigger,
    server: 'Cloudflare FRA',
    downMbps: r1(down),
    upMbps: r1(up),
    idleLatencyMs: r1(idle),
    idleJitterMs: r1(idleJitter),
    loadedDownLatencyMs: r1(loadedDown),
    loadedDownP95Ms: r1(loadedDown + rng.range(14, 26)),
    loadedUpLatencyMs: r1(loadedUp),
    loadedUpP95Ms: r1(loadedUp + rng.range(18, 32)),
    bloatDownMs: r1(bloatDown),
    bloatUpMs: r1(bloatUp),
    grade: gradeFor(Math.max(bloatDown, bloatUp)),
    bytesDown: Math.round(((down * 1e6) / 8) * 12),
    bytesUp: Math.round(((up * 1e6) / 8) * 12),
    streams: 6,
    nicLinkMbps: linkMbps,
    error: null,
    series,
  };
}

function linkSpeedAt(plan: Pick<Plan, 'linkSpeed'>, ts: number): number {
  let mbps = plan.linkSpeed[0]?.mbps ?? 1000;
  for (const p of plan.linkSpeed) {
    if (p.ts > ts) break;
    mbps = p.mbps;
  }
  return mbps;
}

export function buildPlan(from: number, to: number, rng: Rng): Plan {
  const span = to - from;
  const at = (f: number) => alignSec(from + span * f);
  const scaled = (ms: number, frac: number) => Math.max(30 * SEC, Math.min(ms, alignSec(span * frac)));

  const breakFrom = at(0.45);
  const breakTo = breakFrom + scaled(10 * MIN, 0.01);
  const sessions: SessionPlan[] = [
    { from, to: breakFrom, label: 'Ausgangslage (Ethernet)', status: 'completed', plannedEndAt: breakFrom },
    { from: breakTo, to, label: 'Langzeittest 72 h', status: 'running', plannedEndAt: breakTo + 72 * HOUR },
  ];
  const g0 = at(0.3);
  const standby: Interval = { from: g0, to: g0 + scaled(25 * MIN, 0.02) };
  const resumeAt = standby.to;
  const drops: DropPlan[] = [
    { ts: at(0.12), downMs: 6 * SEC, relinkMbps: 1000, failover: true, backMs: 42 * SEC },
    { ts: at(0.5), downMs: 14 * SEC, relinkMbps: 1000, failover: true, backMs: 55 * SEC },
    { ts: at(0.71), downMs: 12 * SEC, relinkMbps: 100, failover: false, backMs: 0 },
    { ts: at(0.88), downMs: 3 * SEC, relinkMbps: 1000, failover: true, backMs: 36 * SEC },
  ];
  const r = at(0.6);
  const reboot: RebootPlan = {
    ts: r,
    flaps: [
      { from: r, to: r + 4 * SEC },
      { from: r + 70 * SEC, to: r + 73 * SEC },
    ],
    lanUpAt: r + 95 * SEC,
    wanUpAt: r + 247 * SEC,
  };
  const linkSpeed = [
    { ts: from, mbps: 1000 },
    { ts: resumeAt + 3 * SEC, mbps: 100 },
    ...drops.map((d) => ({ ts: d.ts + d.downMs, mbps: d.relinkMbps })),
    ...reboot.flaps.map((f) => ({ ts: f.to, mbps: 1000 })),
  ].sort((a, b) => a.ts - b.ts);
  const speedFractions = [0.05, 0.22, 0.38, 0.55, 0.78, 0.95];
  const plan: Plan = {
    from,
    to,
    sessions,
    standby,
    drops,
    reboot,
    speedtests: [],
    download: { from: at(0.83), to: at(0.83) + scaled(5 * MIN, 0.01) },
    gaming: [],
    notes: [],
    routeChangeAt: at(0.52),
    routerBootAt: from - 12 * DAY - 7 * HOUR,
    linkSpeed,
    noSamples: [standby, { from: breakFrom, to: breakTo }],
    linkDown: [
      ...drops.map((d) => ({ from: d.ts, to: d.ts + d.downMs })),
      ...reboot.flaps,
      { from: resumeAt, to: resumeAt + 3 * SEC },
    ],
    failover: drops.filter((d) => d.failover).map((d) => ({ from: d.ts + SEC, to: d.ts + d.downMs + d.backMs })),
    lossAll: [
      ...drops.map((d) => ({ from: d.ts, to: d.failover ? d.ts + SEC : d.ts + d.downMs + 2 * SEC })),
      ...reboot.flaps,
      { from: resumeAt, to: resumeAt + 3 * SEC },
    ],
    afterRelink: [
      ...drops.map((d) => ({ from: d.ts + d.downMs, to: d.ts + d.downMs + 60 * SEC })),
      ...reboot.flaps.map((f) => ({ from: f.to, to: f.to + 60 * SEC })),
      { from: resumeAt + 3 * SEC, to: resumeAt + 63 * SEC },
    ],
    lanDown: [{ from: r, to: reboot.lanUpAt }],
    wanDown: [{ from: r, to: reboot.wanUpAt }],
  };
  for (const f of speedFractions) {
    const ts = at(f);
    const h = localHour(ts);
    const trigger = h >= 18 && h < 23 ? 'manual' : 'schedule';
    const linkMbps = linkSpeedAt(plan, ts);
    plan.speedtests.push({ ts, endTs: ts + SPEED_PHASES.totalMs, trigger, linkMbps, result: makeSpeedtest(ts, linkMbps, trigger, rng) });
  }
  for (let day = localDayStart(from); day < to; day = addDays(day, 1)) {
    const g = { from: Math.max(from, localTime(day, 20)), to: Math.min(to, localTime(day, 22, 30)) };
    if (g.to - g.from >= 10 * MIN) plan.gaming.push(g);
    const note = localTime(day, 21, 12, 30);
    if (note >= from && note < to) plan.notes.push(note);
  }
  return plan;
}

const inAny = (list: readonly Interval[], ts: number): boolean => {
  for (const i of list) if (ts >= i.from && ts < i.to) return true;
  return false;
};

function speedAt(plan: Plan, ts: number): { st: SpeedPlan; phase: 'idle' | 'download' | 'upload' } | null {
  for (const st of plan.speedtests) {
    if (ts < st.ts || ts >= st.endTs) continue;
    const off = ts - st.ts;
    const phase = off < SPEED_PHASES.idleMs ? 'idle' : off < SPEED_PHASES.idleMs + SPEED_PHASES.downMs ? 'download' : 'upload';
    return { st, phase };
  }
  return null;
}

// ─── per-second generation ──────────────────────────────────────────────────

interface Outcome {
  rtt: number | null;
  spike: boolean;
}

interface MinuteAcc {
  ts: number;
  rtts: (number | null)[];
  spikes: number;
}

interface Episode {
  start: number;
  end: number;
  peak: number;
  count: number;
  baseline: Baseline;
}

interface Burst {
  start: number;
  end: number;
  lost: number;
}

interface Congestion {
  /** seconds left including the current one */
  left: number;
  magnitude: number;
}

function emptySeconds(ts: number): SecondsRollup {
  return { ts, covered: 0, good: 0, link: 0, lan: 0, access: 0, aftr: 0, backbone: 0, remote: 0, unknown: 0, es: 0, ses: 0, selfLoad: 0 };
}

function congestionStartP(ts: number, ef: number): number {
  const h = localHour(ts);
  const peak = Math.max(0, 1 - Math.abs(h - 21) / 1.5);
  if (ef > 0) return 0.00015 + ef * 0.004 * (1 + 0.4 * peak);
  return h < 6 ? 0.00008 : 0.00015;
}

function congestionMagnitude(rng: Rng, ef: number): number {
  const r = rng.next();
  const m = r < 0.62 ? rng.range(28, 78) : r < 0.93 ? rng.range(80, 170) : rng.range(175, 325);
  return ef > 0 ? m : m * 0.7;
}

interface GenContext {
  db: EngineDb;
  cfg: AppConfig;
  plan: Plan;
  rng: Rng;
  events: NetEvent[];
  counters: { samples: number; rollups: number; secondsRows: number };
}

function generateSamples(g: GenContext): void {
  const { db, cfg, plan, rng } = g;
  const rules = new Map<string, SpikeRule>(DEMO_TARGETS.map((m) => [m.id, spikeRuleFor(cfg, m.segment)]));
  const minutes = new Map<string, MinuteAcc>();
  const episodes = new Map<string, Episode>();
  const bursts = new Map<string, Burst>();
  const lastLoss = new Map<string, number>();
  let rollupBuf: Rollup[] = [];
  const secondsBuf: SecondsRollup[] = [];
  let secMinute: SecondsRollup | null = null;
  let cong: Congestion = { left: 0, magnitude: 0 };

  const flushMinute = (m: TargetModel, acc: MinuteAcc) => {
    if (acc.rtts.length === 0) return;
    const s = summarize(acc.rtts);
    rollupBuf.push({ ts: acc.ts, targetId: m.id, ...s, spikes: acc.spikes });
    g.counters.rollups++;
    if (rollupBuf.length >= 2000) {
      db.upsertRollups(rollupBuf);
      rollupBuf = [];
    }
  };

  const closeEpisode = (id: string, ep: Episode) => {
    const model = DEMO_TARGETS.find((m) => m.id === id);
    if (!model) return;
    const rule = rules.get(id) ?? cfg.thresholds.spikeWan;
    const sev = spikeSeverity(ep.peak, ep.baseline, rule);
    if (ep.count < 2 && sev === 'minor') return;
    const name = cfg.targets.find((t) => t.id === id)?.name ?? id;
    const normal = ` statt ${fmtNumber(ep.baseline.median, ep.baseline.median < 10 ? 1 : 0)} ms`;
    g.events.push({
      ts: ep.start,
      endTs: ep.end,
      type: 'latency_spike',
      severity: sev === 'severe' ? 'warn' : 'info',
      segment: model.segment,
      title:
        ep.count === 1
          ? `Latenzspitze bei ${name}: ${fmtNumber(ep.peak)} ms${normal}`
          : `Latenzspitzen bei ${name}: bis ${fmtNumber(ep.peak)} ms${normal} (${ep.count}×)`,
      details: {
        targetId: id,
        peakMs: Math.round(ep.peak * 10) / 10,
        baselineMs: Math.round(ep.baseline.median * 10) / 10,
        spikeSamples: ep.count,
        severity: sev,
        durationMs: ep.end - ep.start + SEC,
      },
      source: 'icmp',
      dedupeKey: `incident:spike:${id}:${ep.start}`,
    });
  };

  const closeBurst = (id: string, b: Burst) => {
    const model = DEMO_TARGETS.find((m) => m.id === id);
    if (!model) return;
    const name = cfg.targets.find((t) => t.id === id)?.name ?? id;
    const sent = Math.round((b.end - b.start) / SEC) + 1;
    g.events.push({
      ts: b.start,
      endTs: b.end,
      type: 'loss_burst',
      severity: 'warn',
      segment: model.segment,
      title: `Paketverlust bei ${name}: ${b.lost} von ${sent} Pings verloren`,
      details: { targetId: id, lost: b.lost, sent, maxRun: Math.min(b.lost, 3), windowSec: cfg.thresholds.burstWindowSec, durationMs: b.end - b.start + SEC },
      source: 'icmp',
      dedupeKey: `incident:burst:${id}:${b.start}`,
    });
  };

  for (let ts = plan.from; ts < plan.to; ts += SEC) {
    if (ts % MIN === 0) {
      for (const m of DEMO_TARGETS) {
        const acc = minutes.get(m.id);
        if (acc) flushMinute(m, acc);
        minutes.set(m.id, { ts, rtts: [], spikes: 0 });
      }
      if (secMinute && secMinute.covered > 0) secondsBuf.push(secMinute);
      secMinute = emptySeconds(ts);
    }
    if (inAny(plan.noSamples, ts)) continue;

    const ef = eveningFactor(ts);
    const linkDown = inAny(plan.linkDown, ts);
    const failover = inAny(plan.failover, ts);
    const lossAll = inAny(plan.lossAll, ts);
    const afterRelink = inAny(plan.afterRelink, ts);
    const lanDown = inAny(plan.lanDown, ts);
    const wanDown = inAny(plan.wanDown, ts);
    const speed = speedAt(plan, ts);
    const download = inAny([plan.download], ts);
    const quiet = !!speed || linkDown || failover || lossAll || afterRelink || lanDown || wanDown;
    const linkMbps = linkSpeedAt(plan, ts);

    // DOCSIS congestion episodes (1–4 s) start at the CMTS and hit every target behind it
    if (cong.left === 0 && !wanDown && rng.chance(congestionStartP(ts, ef))) cong = { left: rng.int(1, 4), magnitude: congestionMagnitude(rng, ef) };
    const congMag = cong.left > 0 ? cong.magnitude : 0;
    if (cong.left > 0) cong.left--;
    const cmtsExtra = congMag > 0 ? congMag * rng.range(0.75, 1.1) : 0;
    const lanSpike = rng.chance(0.00025) ? rng.range(12, 45) : 0;
    const flags = (failover ? SampleFlag.FAILOVER : 0) | (speed ? SampleFlag.LOAD : 0);

    const outcomes = new Map<string, Outcome>();
    for (const m of DEMO_TARGETS) {
      const sec = Math.round(ts / SEC);
      if (m.every > 1 && sec % m.every !== m.phase) continue;
      const sampleTs = ts + m.offsetMs;
      const median = m.base + (m.wan ? ef * EVENING_ELEVATION_MS : 0);
      const sd = m.sd * (m.wan ? 1 + ef * 0.8 : 1);
      const baseline: Baseline = { median, mad: sd * 0.6745 };
      let status: SampleStatusCode = SampleStatus.OK;
      let rtt: number | null = null;
      if (lossAll) status = linkDown && !failover ? SampleStatus.ERROR : SampleStatus.TIMEOUT;
      else if (!m.wan && lanDown && m.id !== 'gw-tcp' && m.id !== 'gw-dns') status = SampleStatus.UNREACHABLE;
      else if (lanDown && !m.wan) status = SampleStatus.TIMEOUT;
      else if ((m.wan || m.id === 'gw-dns') && wanDown) status = SampleStatus.TIMEOUT;
      else {
        let lossP = m.lossP;
        let extra = 0;
        if (m.wan && cmtsExtra > 0) {
          extra += m.id === 'isp6' ? cmtsExtra : cmtsExtra * rng.range(0.85, 1.12);
          lossP += congMag >= 150 ? 0.2 : congMag >= 80 ? 0.04 : 0.01;
        }
        if ((m.id === 'gw' || (m.id === 'gw6' && rng.chance(0.5))) && lanSpike > 0) extra += lanSpike;
        if (speed && speed.phase !== 'idle') {
          const st = speed.st.result;
          const isDown = speed.phase === 'download';
          if (!m.wan) extra += isDown && linkMbps < 1000 ? rng.range(9, 16) : rng.range(0, 1.2);
          else if (m.id === 'isp6') extra += isDown ? rng.range(4, 8) : (st.bloatUpMs ?? 35) * rng.range(0.85, 1.1);
          else extra += (isDown ? (st.bloatDownMs ?? 22) : (st.bloatUpMs ?? 35)) * rng.range(0.85, 1.15);
        }
        if (download) {
          // own download fills the queue: at 100 Mbit/s the LAN link is the bottleneck (router ping rises too)
          if (!m.wan) extra += linkMbps < 1000 ? rng.range(8, 15) : rng.range(0, 1);
          else extra += rng.range(26, 42);
        }
        let base = median;
        let spread = sd;
        if (failover) {
          base += m.wan ? 4 : 2;
          spread += m.wan ? 1.5 : 1.2;
        }
        if (rng.chance(lossP)) status = SampleStatus.TIMEOUT;
        else {
          const v = Math.max(base * 0.6, 0.2, base + spread * (0.55 * rng.gauss() + 0.9 * (rng.expo() - 1)) + extra);
          rtt = m.kind === 'icmp' ? Math.round(v) || 0.5 : Math.round(v * 1000) / 1000;
        }
      }
      const rule = rules.get(m.id) ?? cfg.thresholds.spikeWan;
      const spike = rtt !== null && isSpike(rtt, baseline, rule);
      const sampleFlags = flags | (rtt !== null && rtt > 1000 ? SampleFlag.LATE : 0);
      db.addSample({ targetId: m.id, ts: sampleTs, rtt, status, flags: sampleFlags });
      g.counters.samples++;
      const acc = minutes.get(m.id);
      if (acc) {
        acc.rtts.push(rtt);
        if (spike) acc.spikes++;
      }
      outcomes.set(m.id, { rtt, spike });

      // incident events (the engine suppresses them during speed tests; link/outage periods have their own events)
      if (!quiet && SPIKE_EVENT_TARGETS.has(m.id) && spike && rtt !== null) {
        const ep = episodes.get(m.id);
        if (ep && ts - ep.end <= 2 * SEC) {
          ep.end = ts;
          ep.count++;
          ep.peak = Math.max(ep.peak, rtt);
        } else {
          if (ep) closeEpisode(m.id, ep);
          episodes.set(m.id, { start: ts, end: ts, peak: rtt, count: 1, baseline });
        }
      }
      if (!quiet && BURST_EVENT_TARGETS.has(m.id) && rtt === null) {
        const prev = lastLoss.get(m.id);
        const open = bursts.get(m.id);
        if (open && ts - open.end <= cfg.thresholds.burstWindowSec * SEC) {
          open.end = ts;
          open.lost++;
        } else {
          if (open) closeBurst(m.id, open);
          bursts.delete(m.id);
          if (prev !== undefined && ts - prev <= cfg.thresholds.burstWindowSec * SEC) bursts.set(m.id, { start: prev, end: ts, lost: 2 });
        }
        lastLoss.set(m.id, ts);
      }
    }

    // per-second classification (ARCHITECTURE §4.6, first match wins; seconds of a running speed
    // test are excluded like in the engine classifier). Game targets (TCP every 10 s) only count in
    // the second they were measured – see the N-api report for the engine's 10-s carry-over.
    if (!secMinute || speed) continue;
    const bad = (id: string) => {
      const o = outcomes.get(id);
      return !!o && (o.rtt === null || o.spike);
    };
    const gwBad = bad('gw') || bad('gw6');
    const isp6Bad = bad('isp6');
    const v4 = bad('cf4') || bad('g4');
    const v6 = bad('cf6') || bad('g6');
    let gameBad = false;
    for (const id of GAME_TARGETS) if (bad(id)) gameBad = true;
    const internet = ['cf4', 'cf6', 'g4', 'g6'].map((id) => outcomes.get(id));
    const lostInternet = internet.filter((o) => o !== undefined && o.rtt === null).length;
    const lagInternet = internet.some((o) => o !== undefined && o.rtt !== null && o.rtt >= 200);
    const s = secMinute;
    s.covered++;
    if (linkDown || failover || afterRelink) s.link++;
    else if (gwBad) s.lan++;
    else if (!isp6Bad && !v4 && !v6 && !gameBad) s.good++;
    else if (isp6Bad && v4 && v6) s.access++;
    else if (v4 && !v6) s.aftr++;
    else if (!isp6Bad && v4 && v6) s.backbone++;
    else if (gameBad && !isp6Bad && !v4 && !v6) s.remote++;
    else s.unknown++;
    if (v4 || v6) s.es++;
    if (lostInternet >= 2 || lagInternet) s.ses++;
    if (download) s.selfLoad++;
  }
  for (const m of DEMO_TARGETS) {
    const acc = minutes.get(m.id);
    if (acc) flushMinute(m, acc);
  }
  if (secMinute && secMinute.covered > 0) secondsBuf.push(secMinute);
  for (const [id, ep] of episodes) closeEpisode(id, ep);
  for (const [id, b] of bursts) closeBurst(id, b);
  db.upsertRollups(rollupBuf);
  db.upsertSecondsRollups(secondsBuf);
  g.counters.secondsRows += secondsBuf.length;
  db.flush();
}

// ─── events from the plan ───────────────────────────────────────────────────

interface EventIds {
  record: number;
}

function linkDownEvent(
  ts: number,
  downMs: number,
  cause: 'boot' | 'runtime' | 'router_reboot' | 'pre_sleep',
  relinkMbps: number,
  wlanFailover: boolean,
  ids: EventIds,
): NetEvent[] {
  const upTs = ts + downMs;
  const runtime = cause === 'runtime';
  const titles: Record<typeof cause, string> = {
    runtime: 'Netzwerkkabel-Verbindung unterbrochen (Link down)',
    boot: 'Link-Neuaufbau beim Start/Aufwachen (normal)',
    router_reboot: 'Link down durch Router-Neustart',
    pre_sleep: 'Link down vor dem Standby (normal)',
  };
  return [
    {
      ts,
      endTs: upTs,
      type: 'nic_link_down',
      severity: runtime ? 'warn' : 'info',
      segment: 'client',
      title: titles[cause],
      details: { cause, relinkMbps, downtimeMs: downMs, wlanFailover, provider: 'e2fexpress', eventId: 27, adapter: 'Ethernet' },
      source: 'eventlog',
      dedupeKey: `evtlog:System:${ids.record++}`,
    },
    {
      ts: upTs,
      endTs: null,
      type: 'nic_link_up',
      severity: relinkMbps < 1000 ? 'warn' : 'info',
      segment: 'client',
      title: relinkMbps < 1000 ? `Link wieder aufgebaut – nur ${relinkMbps} Mbit/s` : 'Link wieder aufgebaut (1 Gbit/s)',
      details: { speedMbps: relinkMbps, provider: 'e2fexpress', eventId: relinkMbps >= 1000 ? 32 : 33, adapter: 'Ethernet', cause },
      source: 'eventlog',
      dedupeKey: `evtlog:System:${ids.record++}`,
    },
  ];
}

/** Imported Windows event log history: daily boot relinks (often 100 Mbit/s) and runtime drops. */
function historyEvents(from: number, days: number, rng: Rng, ids: EventIds): NetEvent[] {
  const out: NetEvent[] = [];
  const firstDay = addDays(localDayStart(from), -days);
  for (let i = 0; i < days; i++) {
    const day = addDays(firstDay, i);
    const daysAgo = days - i;
    const all100 = daysAgo <= 37 && daysAgo >= 26;
    const boot = localTime(day, 8) + rng.int(0, 90) * MIN + rng.int(0, 59) * SEC;
    if (boot >= from) break;
    out.push(...linkDownEvent(boot, rng.int(2500, 4000), 'boot', all100 || rng.chance(0.35) ? 100 : 1000, false, ids));
    if (rng.chance(0.3)) {
      const resume = localTime(day, 17) + rng.int(0, 120) * MIN;
      if (resume < from) {
        out.push({
          ts: resume - 2 * SEC,
          endTs: null,
          type: 'resume',
          severity: 'info',
          segment: 'client',
          title: 'PC aus dem Energiesparmodus aufgewacht',
          details: { provider: 'Microsoft-Windows-Kernel-Power', eventId: 107 },
          source: 'eventlog',
          dedupeKey: `evtlog:System:${ids.record++}`,
        });
        out.push(...linkDownEvent(resume, rng.int(2500, 4000), 'boot', all100 || rng.chance(0.3) ? 100 : 1000, false, ids));
      }
    }
    if (daysAgo <= 14) {
      const n = daysAgo <= 3 ? rng.int(1, 3) : rng.int(0, 1);
      for (let k = 0; k < n; k++) {
        const ts = localTime(day, 10) + rng.int(0, 12 * 60) * MIN + rng.int(0, 59) * SEC;
        if (ts >= from) continue;
        out.push(...linkDownEvent(ts, rng.int(3, 22) * SEC, 'runtime', rng.chance(0.4) ? 100 : 1000, true, ids));
      }
    }
  }
  return out;
}

/** Events of the planned incidents (speed test events follow once their rows exist – they carry the row id). */
function planEvents(plan: Plan, ids: EventIds): NetEvent[] {
  const out: NetEvent[] = [];
  const ssid = 'Vodafone-5A1C';
  for (const d of plan.drops) {
    out.push(...linkDownEvent(d.ts, d.downMs, 'runtime', d.relinkMbps, d.failover, ids));
    if (d.relinkMbps < 1000) out.push(adapterSpeedEvent(d.ts + d.downMs, d.relinkMbps));
    if (d.failover) {
      const back = d.ts + d.downMs + d.backMs;
      out.push(
        { ts: d.ts + 400, endTs: null, type: 'wlan_connect', severity: 'info', segment: 'client', title: `WLAN verbunden mit „${ssid}“ (automatisch)`, details: { ssid, eventId: 8001 }, source: 'wlan', dedupeKey: `evtlog:WLAN:${ids.record++}` },
        { ts: d.ts + SEC, endTs: back, type: 'route_switch', severity: 'warn', segment: 'client', title: 'Internetverkehr läuft über WLAN statt Ethernet (Ausweichen)', details: { family: 4, from: 'Ethernet', to: 'WLAN' }, source: 'route', dedupeKey: null },
        { ts: back, endTs: null, type: 'route_switch', severity: 'info', segment: 'client', title: 'Internetverkehr wieder über Ethernet', details: { family: 4, from: 'WLAN', to: 'Ethernet' }, source: 'route', dedupeKey: null },
        { ts: back + 2 * SEC, endTs: null, type: 'wlan_disconnect', severity: 'info', segment: 'client', title: 'WLAN getrennt (Richtlinie: Ethernet wieder verfügbar)', details: { ssid, eventId: 8003, reasonCode: 5 }, source: 'wlan', dedupeKey: `evtlog:WLAN:${ids.record++}` },
      );
    } else {
      const end = d.ts + d.downMs + 2 * SEC;
      out.push(outageEvent(d.ts, end, 'client', 'PC & Netzwerkadapter'));
    }
  }
  // standby + resume with a boot-type relink at 100 Mbit/s
  const { standby } = plan;
  out.push(
    { ts: standby.from, endTs: null, type: 'standby', severity: 'info', segment: 'client', title: 'PC in den Energiesparmodus gewechselt', details: { provider: 'Microsoft-Windows-Kernel-Power', eventId: 42 }, source: 'eventlog', dedupeKey: `evtlog:System:${ids.record++}` },
    { ts: standby.to, endTs: null, type: 'resume', severity: 'info', segment: 'client', title: 'PC aus dem Energiesparmodus aufgewacht', details: { provider: 'Microsoft-Windows-Kernel-Power', eventId: 107 }, source: 'eventlog', dedupeKey: `evtlog:System:${ids.record++}` },
    {
      ts: standby.from - SEC,
      endTs: standby.to + SEC,
      type: 'engine_gap',
      severity: 'info',
      segment: null,
      title: `Messlücke: ${fmtDuration(standby.to - standby.from + 2 * SEC)} ohne Messung (Standby oder Engine hing)`,
      details: { cause: 'timer', gapMs: standby.to - standby.from + 2 * SEC, thresholdMs: 5000 },
      source: 'engine',
      dedupeKey: `engine_gap:${standby.from - SEC}`,
    },
    ...linkDownEvent(standby.to, 3 * SEC, 'boot', 100, false, ids),
    adapterSpeedEvent(standby.to + 3 * SEC, 100),
  );
  // router reboot
  const rb = plan.reboot;
  for (const f of rb.flaps) out.push(...linkDownEvent(f.from, f.to - f.from, 'router_reboot', 1000, false, ids));
  out.push(
    outageEvent(rb.ts, rb.wanUpAt, 'lan', 'Heimnetz/Router'),
    {
      ts: rb.ts + 5 * SEC,
      endTs: rb.lanUpAt,
      type: 'router_offline',
      severity: 'critical',
      segment: 'router',
      title: 'Router antwortet nicht (Weboberfläche und Ping)',
      details: { failedPolls: 2, durationMs: rb.lanUpAt - rb.ts - 5 * SEC },
      source: 'router',
      dedupeKey: `router:offline:${rb.ts + 5 * SEC}`,
    },
    {
      ts: rb.ts,
      endTs: null,
      type: 'router_reboot',
      severity: 'warn',
      segment: 'router',
      title: 'Router wurde neu gestartet (Laufzeit zurückgesetzt)',
      details: { uptimeBeforeSec: Math.round((rb.ts - plan.routerBootAt) / SEC), uptimeAfterSec: 180, lastRebootReason: 'Power On Reset' },
      source: 'router',
      dedupeKey: `router:reboot:${rb.ts}`,
    },
    {
      ts: rb.wanUpAt + 60 * SEC,
      endTs: rb.wanUpAt + 6 * MIN,
      type: 'docsis_change',
      severity: 'warn',
      segment: 'docsis',
      title: 'DOCSIS: 2 Downstream-Kanäle nicht gelockt (Teilbetrieb nach Neustart)',
      details: { dsCount: 33, dsLocked: 31, usCount: 5 },
      source: 'router',
      dedupeKey: `router:docsis:${rb.wanUpAt + 60 * SEC}`,
    },
    {
      ts: rb.wanUpAt + 30 * SEC,
      endTs: null,
      type: 'ip_change',
      severity: 'info',
      segment: 'aftr',
      title: 'Öffentliche IPv4-Adresse geändert (DS-Lite, neue AFTR-Zuordnung)',
      details: { family: 4, before: PUBLIC_V4[0], after: PUBLIC_V4[1] },
      source: 'stun',
      dedupeKey: `stun:ip:${rb.wanUpAt + 30 * SEC}`,
    },
  );
  for (const gm of plan.gaming) {
    out.push({ ts: gm.from, endTs: gm.to, type: 'gaming', severity: 'info', segment: 'client', title: 'Spiel aktiv: cs2.exe', details: { process: 'cs2.exe' }, source: 'system', dedupeKey: `gaming:${gm.from}` });
  }
  for (const n of plan.notes) {
    out.push({ ts: n, endTs: null, type: 'note', severity: 'info', segment: null, title: 'Lag im Spiel bemerkt', details: { origin: 'Lag jetzt markieren' }, source: 'user', dedupeKey: null });
  }
  out.push({
    ts: plan.routeChangeAt,
    endTs: null,
    type: 'route_change',
    severity: 'info',
    segment: 'isp',
    title: 'Route nach 1.1.1.1 geändert (Hop 4: 145.254.2.199 → 145.254.2.203)',
    details: { family: 4, hop: 4, before: '145.254.2.199', after: '145.254.2.203' },
    source: 'traceroute',
    dedupeKey: `route_change:4:${plan.routeChangeAt}`,
  });
  return out;
}

function adapterSpeedEvent(ts: number, mbps: number): NetEvent {
  return {
    ts,
    endTs: null,
    type: 'adapter_change',
    severity: 'warn',
    segment: 'client',
    title: `Ethernet: Link-Geschwindigkeit ${mbps} Mbit/s statt 1 Gbit/s`,
    details: { adapter: 'Ethernet', linkMbps: mbps, previousMbps: 1000 },
    source: 'adapter',
    dedupeKey: null,
  };
}

function outageEvent(ts: number, endTs: number, classification: 'client' | 'lan', label: string): NetEvent {
  return {
    ts,
    endTs,
    type: 'outage',
    severity: 'critical',
    segment: classification,
    title: `Ausfall (${fmtDuration(endTs - ts)}): ${label}`,
    details: {
      classification,
      initialClassification: 'client',
      lostTargets: ['cf4', 'cf6', 'g4', 'g6'],
      rounds: Math.round((endTs - ts) / SEC),
      durationMs: endTs - ts,
      ongoing: false,
    },
    source: 'icmp',
    dedupeKey: `incident:outage:${ts}`,
  };
}

function speedtestEvent(st: SpeedPlan, id: number): NetEvent {
  const r = st.result;
  const limited = st.linkMbps < 1000 && (r.downMbps ?? 0) >= st.linkMbps * 0.85;
  return {
    ts: st.ts,
    endTs: st.endTs,
    type: 'speedtest',
    severity: limited || r.grade === 'C' || r.grade === 'D' || r.grade === 'F' ? 'warn' : 'info',
    segment: limited ? 'client' : null,
    title: `Speedtest: ${fmtNumber(r.downMbps)} Mbit/s ↓ · ${fmtNumber(r.upMbps, 1)} Mbit/s ↑ · Bufferbloat ${r.grade ?? '–'}${limited ? ' – begrenzt durch 100-Mbit/s-Link' : ''}`,
    details: {
      speedtestId: id,
      trigger: st.trigger,
      server: r.server,
      downMbps: r.downMbps,
      upMbps: r.upMbps,
      grade: r.grade,
      bloatDownMs: r.bloatDownMs,
      bloatUpMs: r.bloatUpMs,
      nicLinkMbps: st.linkMbps,
      limitedByLink: limited,
    },
    source: 'speedtest',
    dedupeKey: `speedtest:${id}`,
  };
}

function sessionEvents(s: SessionPlan, id: number): NetEvent[] {
  const label = ` „${s.label}“`;
  const out: NetEvent[] = [
    {
      ts: s.from,
      endTs: null,
      type: 'session_start',
      severity: 'info',
      segment: null,
      title: `Langzeittest${label} gestartet`,
      details: {
        sessionId: id, label: s.label, startedAt: s.from, plannedEndAt: s.plannedEndAt, resumed: false, expectedIf: 'Ethernet',
        primaryAdapter: 'Ethernet', isWifi: false, linkMbps: 1000, ssid: null, band: null, channel: null, signalPct: null,
      },
      source: 'engine',
      dedupeKey: `session_start:${id}`,
    },
  ];
  if (s.status === 'completed') {
    out.push({
      ts: s.to,
      endTs: null,
      type: 'session_end',
      severity: 'info',
      segment: null,
      title: `Langzeittest${label} beendet (geplantes Ende erreicht)`,
      details: { sessionId: id, label: s.label, reason: 'planned', status: s.status, startedAt: s.from, endedAt: s.to, durationMs: s.to - s.from },
      source: 'engine',
      dedupeKey: `session_end:${id}`,
    });
  }
  return out;
}

// ─── snapshots ──────────────────────────────────────────────────────────────

const PC_MAC = 'A4-BB-6D-12-34-56';
const WLAN_MAC = '7C-21-4A-9B-CD-EF';
const PUBLIC_V4 = ['92.208.31.17', '92.208.40.112'] as const;
const PC_V6 = '2a02:8071:1234:5600:9c4e:1a2b:3c4d:5e6f';
const ROUTER_V6 = '2a02:8071:1234:5600::1';
const ROUTER_LL = 'fe80::2a0:57ff:fe12:3456';

function adapterSnapshot(ts: number, ethMbps: number | null, wlanConnected: boolean): AdapterSnapshot {
  const eth: AdapterInfo = {
    name: 'Ethernet',
    description: 'Intel(R) Ethernet Controller (3) I225-V',
    ifIndex: 4,
    status: ethMbps === null ? 'Disconnected' : 'Up',
    linkMbps: ethMbps,
    mediaType: '802.3',
    mac: PC_MAC,
    driverVersion: '1.1.4.43',
    driverDate: '2024-02-15',
    serviceName: 'e2fexpress',
    isWifi: false,
    isVirtual: false,
    mediaConnected: ethMbps !== null,
    addresses: ethMbps === null ? [] : ['192.168.0.192', PC_V6, 'fe80::5d2c:8e1f:a0b3:4c71%4'],
    rxBytes: Math.round((ts / 1000) % 1e12) * 1800,
    txBytes: Math.round((ts / 1000) % 1e12) * 240,
    rxErrors: 0,
    rxDiscards: 0,
    txErrors: 0,
    txDiscards: 0,
  };
  const wlan: AdapterInfo = {
    name: 'WLAN',
    description: 'Intel(R) Wi-Fi 6E AX211 160MHz',
    ifIndex: 12,
    status: wlanConnected ? 'Up' : 'Disconnected',
    linkMbps: wlanConnected ? 866 : null,
    mediaType: 'Native 802.11',
    mac: WLAN_MAC,
    driverVersion: '23.110.0.5',
    driverDate: '2025-11-03',
    serviceName: 'Netwtw14',
    isWifi: true,
    isVirtual: false,
    mediaConnected: wlanConnected,
    addresses: wlanConnected ? ['192.168.0.35'] : [],
    rxBytes: null,
    txBytes: null,
    rxErrors: null,
    rxDiscards: null,
    txErrors: null,
    txDiscards: null,
  };
  const warp: AdapterInfo = {
    name: 'CloudflareWARP',
    description: 'Cloudflare WARP Interface Tunnel',
    ifIndex: 35,
    status: 'Up',
    linkMbps: 100_000,
    mediaType: null,
    mac: null,
    driverVersion: null,
    driverDate: null,
    serviceName: 'wintun',
    isWifi: false,
    isVirtual: true,
    mediaConnected: true,
    addresses: ['100.96.0.7'],
    rxBytes: null,
    txBytes: null,
    rxErrors: null,
    rxDiscards: null,
    txErrors: null,
    txDiscards: null,
  };
  const viaWlan = ethMbps === null || wlanConnected;
  return {
    ts,
    adapters: [eth, wlan, warp],
    routes: [
      { family: 4, destination: '1.1.1.1', ifAlias: viaWlan ? 'WLAN' : 'Ethernet', ifIndex: viaWlan ? 12 : 4, sourceAddress: viaWlan ? '192.168.0.35' : '192.168.0.192', nextHop: '192.168.0.1' },
      { family: 6, destination: '2606:4700:4700::1111', ifAlias: viaWlan ? 'WLAN' : 'Ethernet', ifIndex: viaWlan ? 12 : 4, sourceAddress: PC_V6, nextHop: `${ROUTER_LL}%${viaWlan ? 12 : 4}` },
    ],
    advanced: [
      { name: 'Geschwindigkeit und Duplexmodus', value: 'Automatische Aushandlung' },
      { name: 'Energieeffizientes Ethernet', value: 'Aus' },
      { name: 'Selective Suspend', value: 'Aktiviert' },
      { name: 'Green Ethernet', value: 'Aktiviert' },
      { name: 'Wake on Magic Packet', value: 'Aktiviert' },
    ],
  };
}

function wlanSnapshot(ts: number, connected: boolean, rng: Rng): WlanInfo {
  return {
    ts,
    present: true,
    connected,
    ssid: connected ? 'Vodafone-5A1C' : null,
    bssid: connected ? '2a:a0:57:12:34:5c' : null,
    radioType: connected ? '802.11ax' : null,
    band: connected ? '5 GHz' : null,
    channel: connected ? 36 : null,
    signalPct: connected ? rng.int(70, 82) : null,
    rssiDbm: connected ? rng.int(-62, -56) : null,
    rxMbps: connected ? 866 : null,
    txMbps: connected ? 866 : null,
    raw: connected ? { Name: 'WLAN', SSID: 'Vodafone-5A1C', Status: 'Verbunden' } : { Name: 'WLAN', Status: 'Getrennt' },
  };
}

function vpnSnapshot(ts: number): VpnInfo {
  return { ts, warp: { installed: true, connected: true, status: 'Connected', mode: 'TunnelOnly', splitTunnel: 'include' }, otherTunnels: [] };
}

function natSnapshot(ts: number, publicV4: string): NatResult[] {
  return [
    {
      ts,
      family: 4,
      localAddress: '192.168.0.192:51234',
      publicIp: publicV4,
      mappings: [
        { server: 'stun.l.google.com:19302', mapped: `${publicV4}:19744`, rttMs: 15.8, error: null },
        { server: 'stun.cloudflare.com:3478', mapped: `${publicV4}:19744`, rttMs: 14.1, error: null },
      ],
      mapping: 'endpoint-independent',
      cgnat: true,
    },
    {
      ts,
      family: 6,
      localAddress: `[${PC_V6}]:51235`,
      publicIp: PC_V6,
      mappings: [
        { server: 'stun.l.google.com:19302', mapped: `[${PC_V6}]:51235`, rttMs: 13.2, error: null },
        { server: 'stun.cloudflare.com:3478', mapped: `[${PC_V6}]:51235`, rttMs: 12.5, error: null },
      ],
      mapping: 'endpoint-independent',
      cgnat: false,
    },
  ];
}

function mtuSnapshot(ts: number): MtuResult[] {
  return [
    { ts, family: 4, target: '1.1.1.1', mtu: 1460, maxPayload: 1432, note: 'DS-Lite: 1500 − 40 Byte IPv6-Tunnel' },
    { ts, family: 6, target: '2606:4700:4700::1111', mtu: 1500, maxPayload: 1452, note: null },
  ];
}

function docsisPoll(ts: number, rng: Rng, partial: boolean): RatedDocsisSnapshot {
  const ef = eveningFactor(ts);
  const ds: DocsisChannelInput[] = [];
  for (let i = 0; i < 32; i++) {
    const freq = i < 24 ? 114 + 8 * i : 602 + 8 * (i - 24);
    const unlocked = partial && (i === 27 || i === 28);
    const outlier = freq === 618;
    ds.push({
      dir: 'ds',
      channelId: i + 1,
      type: 'SC-QAM',
      frequencyMHz: freq,
      frequencyText: String(freq),
      powerDbmv: unlocked ? null : Math.round((2.4 + freq * 0.006 + rng.gauss() * 0.15) * 10) / 10,
      snrDb: unlocked ? null : Math.round(((outlier ? 35.4 : 39.2 - freq * 0.0012) - ef * 0.4 + rng.gauss() * 0.15) * 10) / 10,
      modulation: '256QAM',
      locked: !unlocked,
      lockText: unlocked ? 'Not Locked' : 'Locked',
      corrected: null,
      uncorrectable: null,
    });
  }
  ds.push({
    dir: 'ds', channelId: 33, type: 'OFDM', frequencyMHz: 751, frequencyText: '751~861',
    powerDbmv: Math.round((5.8 + rng.gauss() * 0.15) * 10) / 10, snrDb: Math.round((42.1 - ef * 0.6 + rng.gauss() * 0.2) * 10) / 10,
    modulation: '4096QAM', locked: true, lockText: 'Locked', corrected: null, uncorrectable: null,
  });
  const us: DocsisChannelInput[] = [51, 44.2, 37.4, 30.6].map((freq, i) => ({
    dir: 'us', channelId: i + 1, type: 'SC-QAM', frequencyMHz: freq, frequencyText: String(freq),
    powerDbmv: Math.round((45.5 - i * 0.4 + ef * 0.3 + rng.gauss() * 0.1) * 4) / 4, snrDb: null,
    modulation: '64QAM', locked: true, lockText: 'SUCCESS', corrected: null, uncorrectable: null,
  }));
  us.push({
    dir: 'us', channelId: 5, type: 'OFDMA', frequencyMHz: 29.8, frequencyText: '29.8~64.8',
    powerDbmv: Math.round((39.8 + rng.gauss() * 0.1) * 10) / 10, snrDb: null, modulation: '1024QAM', locked: true, lockText: 'SUCCESS',
    corrected: null, uncorrectable: null,
  });
  return rateDocsis(ts, ds, us);
}

function routerSnapshot(ts: number, plan: Plan, docsis: RatedDocsisSnapshot | null, pcMbps: number, rng: Rng): RouterStatus {
  const bootAt = ts >= plan.reboot.ts ? plan.reboot.ts + 60 * SEC : plan.routerBootAt;
  const devices: RouterAttachedDevice[] = [
    { kind: 'lan', hostName: 'Jan-PC', mac: PC_MAC.replace(/-/g, ':'), ipv4: '192.168.0.192', ipv6: PC_V6, speed: `${pcMbps} Mbps`, isThisPc: true },
    { kind: 'lan', hostName: 'Fernseher-Wohnzimmer', mac: '5C:49:7D:AA:BB:01', ipv4: '192.168.0.23', ipv6: null, speed: '100 Mbps', isThisPc: false },
    { kind: 'wlan', hostName: 'iPhone-Lisa', mac: '7E:12:9A:AB:CD:02', ipv4: '192.168.0.41', ipv6: null, speed: '866 Mbps', isThisPc: false },
    { kind: 'wlan', hostName: 'Galaxy-Tab', mac: 'B0:72:BF:12:34:03', ipv4: '192.168.0.52', ipv6: null, speed: '573 Mbps', isThisPc: false },
  ];
  return {
    ts,
    ip: '192.168.0.1',
    reachable: true,
    httpMs: Math.round(rng.range(130, 230) + eveningFactor(ts) * 40),
    adapter: 'arris-vodafone-station',
    vendor: 'ARRIS',
    model: 'Vodafone Station Wi-Fi 6 (TG6442)',
    firmware: '01.05.069.14',
    loginConfigured: true,
    loginEnabled: true,
    loggedIn: false,
    loginError: null,
    lockoutUntil: null,
    connectionStatus: 'DOCSIS Online',
    wanIpv4: null,
    wanIpv6: '2a02:8070:1f00:12::3a5c',
    aftrAddress: '2a00:0:cff:84a0::3',
    dsLite: true,
    gwMode: 'Ipv6',
    uptimeSec: Math.round((ts - bootAt) / SEC),
    lastRebootReason: ts >= plan.reboot.ts ? 'Power On Reset' : 'Software Update',
    docsis,
    attachedDevices: devices,
    extra: {
      '_ga.modemConnectionStatus': 'DOCSIS Online',
      '_ga.dsLitePlusIpv6Mode': 'true',
      '_ga.gwMode': 'Ipv6',
      '_ga.isDFSEnabled': 'true',
      '_ga.isBandSteeringEnabled': 'false',
      '_ga.lockoutTimeLeft': 0,
    },
  };
}

function writeSnapshots(db: EngineDb, plan: Plan, rng: Rng): number {
  let n = 0;
  const snap = <T>(kind: SnapshotKind, ts: number, data: T) => {
    db.insertSnapshot(kind, ts, data);
    n++;
  };
  const sampleTimes = new Set<number>();
  for (let ts = plan.from; ts < plan.to; ts += HOUR) sampleTimes.add(ts);
  for (const d of plan.drops) for (const t of [d.ts + 500, d.ts + d.downMs + 500, d.ts + d.downMs + d.backMs + 500]) sampleTimes.add(t);
  for (const f of plan.reboot.flaps) sampleTimes.add(f.to + 500);
  sampleTimes.add(plan.standby.to + 4 * SEC);
  sampleTimes.add(plan.to - 30 * SEC);
  for (const ts of [...sampleTimes].sort((a, b) => a - b)) {
    if (ts >= plan.to || inAny(plan.noSamples, ts)) continue;
    const down = inAny(plan.linkDown, ts);
    const wlan = inAny(plan.failover, ts);
    snap('adapters', ts, adapterSnapshot(ts, down ? null : linkSpeedAt(plan, ts), wlan));
    snap('wlan', ts, wlanSnapshot(ts, wlan, rng));
  }
  for (let ts = plan.from; ts < plan.to; ts += 6 * HOUR) snap('vpn', ts + 20 * SEC, vpnSnapshot(ts + 20 * SEC));
  // router status (+ DOCSIS tables) every 30 min, not while the router reboots
  for (let ts = plan.from + 90 * SEC; ts < plan.to; ts += 30 * MIN) {
    if (ts >= plan.reboot.ts && ts < plan.reboot.wanUpAt) continue;
    const partial = ts >= plan.reboot.wanUpAt && ts < plan.reboot.wanUpAt + 6 * MIN;
    snap('router', ts, routerSnapshot(ts, plan, docsisPoll(ts, rng, partial), linkSpeedAt(plan, ts), rng));
  }
  const afterReboot = plan.reboot.wanUpAt + 90 * SEC;
  snap('router', afterReboot, routerSnapshot(afterReboot, plan, docsisPoll(afterReboot, rng, true), linkSpeedAt(plan, afterReboot), rng));
  // NAT + MTU at session starts, after the reboot (new public IPv4) and daily
  for (const s of plan.sessions) {
    const ip = s.from >= plan.reboot.wanUpAt ? PUBLIC_V4[1] : PUBLIC_V4[0];
    snap('nat', s.from + 40 * SEC, natSnapshot(s.from + 40 * SEC, ip));
    snap('mtu', s.from + 50 * SEC, mtuSnapshot(s.from + 50 * SEC));
  }
  snap('nat', plan.reboot.wanUpAt + 30 * SEC, natSnapshot(plan.reboot.wanUpAt + 30 * SEC, PUBLIC_V4[1]));
  for (let ts = plan.from + DAY; ts < plan.to; ts += DAY) snap('mtu', ts, mtuSnapshot(ts));
  return n;
}

// ─── metrics ────────────────────────────────────────────────────────────────

function writeMetrics(db: EngineDb, plan: Plan, rng: Rng): number {
  let n = 0;
  let buf: MetricPoint[] = [];
  const push = (key: string, ts: number, value: number) => {
    if (!Number.isFinite(value)) return;
    buf.push({ key, ts, value: Math.round(value * 1000) / 1000 });
    n++;
    if (buf.length >= 4000) {
      db.addMetrics(buf);
      buf = [];
    }
  };
  const gamingAt = (ts: number) => inAny(plan.gaming, ts);
  for (let ts = plan.from; ts < plan.to; ts += MIN) {
    if (inAny([plan.standby], ts)) continue; // PC asleep → nothing measured
    const ef = eveningFactor(ts);
    const t = ts + 5 * SEC;
    const up = !inAny(plan.linkDown, t);
    push('nic.up', t, up ? 1 : 0);
    if (up) push('nic.link_mbps', t, linkSpeedAt(plan, t));
    const gaming = gamingAt(t);
    push('nic.rx_mbps', t, rng.range(0.2, 2.5) + (gaming ? rng.range(1, 3) : 0));
    push('nic.tx_mbps', t, rng.range(0.05, 0.6) + (gaming ? rng.range(0.3, 0.8) : 0));
    push('nic.rx_errors', t, 0);
    push('nic.rx_discards', t, 0);
    push('sys.cpu_pct', t, gaming ? rng.range(45, 70) : rng.range(6, 18));
    push('sys.mem_pct', t, rng.range(55, 61) + (gaming ? 8 : 0));
    push('engine.loop_lag_ms', t, rng.chance(0.01) ? rng.range(15, 40) : rng.range(1.2, 3.5));
    const reachable = !inAny(plan.lanDown, t);
    push('router.reachable', t, reachable ? 1 : 0);
    if (reachable) push('router.http_ms', t, rng.chance(0.005) ? rng.range(500, 900) : rng.range(130, 230) + ef * 40);
    push('tcp.retrans_pct', t, 0.08 + Math.abs(rng.gauss()) * 0.08 + ef * rng.range(0, 0.9));
    push('tcp6.retrans_pct', t, 0.04 + Math.abs(rng.gauss()) * 0.05 + ef * rng.range(0, 0.5));
    push('pc.gaming', t, gaming ? 1 : 0);
    if (ts % (5 * MIN) === 0) {
      const p = ts + 30 * SEC;
      const bootAt = p >= plan.reboot.ts ? plan.reboot.ts + 60 * SEC : plan.routerBootAt;
      if (!inAny(plan.lanDown, p)) push('router.uptime_s', p, Math.round((p - bootAt) / SEC));
      if (!inAny(plan.wanDown, p)) {
        const partial = p >= plan.reboot.wanUpAt && p < plan.reboot.wanUpAt + 6 * MIN;
        const s = docsisPoll(p, rng, partial).summary;
        push('docsis.ds.count', p, s.families.ds.count + s.families.ofdm.count);
        push('docsis.ds.locked', p, s.families.ds.locked + s.families.ofdm.locked);
        push('docsis.us.count', p, s.families.us.count + s.families.ofdma.count);
        if (s.dsPower) {
          push('docsis.ds.power_min', p, s.dsPower.min);
          push('docsis.ds.power_max', p, s.dsPower.max);
          push('docsis.ds.power_avg', p, s.dsPower.avg);
        }
        if (s.dsSnr) {
          push('docsis.ds.snr_min', p, s.dsSnr.min);
          push('docsis.ds.snr_avg', p, s.dsSnr.avg);
        }
        if (s.ofdmPowerAvg !== null) push('docsis.ofdm.power_avg', p, s.ofdmPowerAvg);
        if (s.ofdmMerMin !== null) push('docsis.ofdm.snr_min', p, s.ofdmMerMin);
        if (s.usPower) {
          push('docsis.us.power_min', p, s.usPower.min);
          push('docsis.us.power_max', p, s.usPower.max);
          push('docsis.us.power_avg', p, s.usPower.avg);
        }
        if (s.ofdmaPowerAvg !== null) push('docsis.ofdma.power_avg', p, s.ofdmaPowerAvg);
      }
      const inSession = !inAny(plan.noSamples, p) && !inAny(plan.wanDown, p);
      if (inSession) {
        for (const [id, base] of [['cf4-udp', 13.6], ['cf6-udp', 12.1]] as const) {
          const loss = ef > 0 && rng.chance(0.3) ? rng.range(0.5, 5) : 0;
          const avg = base + ef * EVENING_ELEVATION_MS + rng.range(-0.5, 1.5);
          push(udpBurstKey(id, 'loss_pct'), p + 10 * SEC, loss);
          push(udpBurstKey(id, 'avg_ms'), p + 10 * SEC, avg);
          push(udpBurstKey(id, 'p99_ms'), p + 10 * SEC, avg + rng.range(4, 10) + ef * rng.range(0, 60));
          push(udpBurstKey(id, 'jitter_ms'), p + 10 * SEC, rng.range(0.6, 2.2) + ef * rng.range(0, 4));
        }
      }
    }
  }
  // change points: link state, egress interface, WLAN while failed over
  for (const i of plan.linkDown) {
    push('nic.up', i.from, 0);
    push('nic.up', i.to, 1);
    push('nic.link_mbps', i.to, linkSpeedAt(plan, i.to));
    push('nic.rx_errors', i.from + 30 * SEC, rng.int(2, 18));
  }
  for (const f of plan.failover) {
    push('net.on_expected_if', f.from, 0);
    push('net.on_expected_if', f.to, 1);
    for (let t = f.from; t < f.to; t += 15 * SEC) {
      push('wlan.signal_pct', t, rng.int(70, 82));
      push('wlan.rssi_dbm', t, rng.int(-62, -56));
      push('wlan.rx_mbps', t, 866);
      push('wlan.tx_mbps', t, 866);
      push('wlan.channel', t, 36);
    }
  }
  for (const st of plan.speedtests) {
    const r = st.result;
    for (let t = st.ts + 11 * SEC; t < st.ts + 25 * SEC; t += 5 * SEC) push('nic.rx_mbps', t, (r.downMbps ?? 0) * rng.range(0.92, 1.03));
    for (let t = st.ts + 26 * SEC; t < st.ts + 40 * SEC; t += 5 * SEC) push('nic.tx_mbps', t, (r.upMbps ?? 0) * rng.range(0.92, 1.03));
  }
  for (let t = plan.download.from; t < plan.download.to; t += 15 * SEC) {
    push('nic.rx_mbps', t, Math.min(linkSpeedAt(plan, t), 500) * rng.range(0.9, 0.97));
  }
  for (const s of plan.sessions) {
    push('mtu.v4', s.from + 50 * SEC, 1460);
    push('mtu.v6', s.from + 50 * SEC, 1500);
  }
  db.addMetrics(buf);
  db.flush();
  return n;
}

// ─── traceroutes ────────────────────────────────────────────────────────────

interface HopModel {
  ip: string | null;
  base: number;
  /** answers TTL-exceeded only sometimes (ICMP rate limiting) */
  answerP?: number;
}

function pathFor(family: 4 | 6, variant: boolean): HopModel[] {
  if (family === 4) {
    return [
      { ip: '192.168.0.1', base: 1 },
      { ip: null, base: 0 },
      { ip: '92.79.214.92', base: 14 },
      { ip: variant ? '145.254.2.203' : '145.254.2.199', base: 16, answerP: 0.8 },
      { ip: '198.41.240.18', base: 17, answerP: 0.7 },
      { ip: '198.41.240.9', base: 38 },
      { ip: '1.1.1.1', base: 14.5 },
    ];
  }
  return [
    { ip: ROUTER_V6, base: 1.2 },
    { ip: '2a02:8101:3ff:ff89::3', base: 12 },
    { ip: '2a02:908:0:4d4::1', base: 14 },
    { ip: null, base: 0 },
    { ip: '2400:cb00:48:2::c629:f012', base: 15 },
    { ip: '2400:cb00:48:3::', base: 22 },
    { ip: '2606:4700:4700::1111', base: 13 },
  ];
}

function traceroute(ts: number, family: 4 | 6, trigger: TracerouteResult['trigger'], variant: boolean, withMtr: boolean, rng: Rng): TracerouteResult {
  const ef = eveningFactor(ts);
  const hops: TraceHop[] = pathFor(family, variant).map((h, i) => {
    const rtts: (number | null)[] = [];
    for (let k = 0; k < 3; k++) {
      if (h.ip === null || !rng.chance(h.answerP ?? 0.99)) rtts.push(null);
      else rtts.push(Math.max(1, Math.round(h.base + (i > 0 ? ef * EVENING_ELEVATION_MS : 0) + rng.gauss() * 1.5 + rng.expo() * 1.2)));
    }
    const ok = rtts.filter((r): r is number => r !== null);
    const hop: TraceHop = {
      hop: i + 1,
      ip: h.ip,
      rtts,
      lossPct: Math.round(((rtts.length - ok.length) / rtts.length) * 1000) / 10,
      avgMs: ok.length ? Math.round((ok.reduce((a, b) => a + b, 0) / ok.length) * 10) / 10 : null,
    };
    if (withMtr) {
      const lost = h.ip === null ? 20 : h.answerP !== undefined ? rng.int(3, 7) : rng.int(0, 1);
      const avg = h.ip === null ? null : Math.round((h.base + ef * EVENING_ELEVATION_MS + rng.range(0.5, 2.5)) * 10) / 10;
      hop.mtr = {
        sent: 20,
        lost,
        lossPct: (lost / 20) * 100,
        avgMs: avg,
        minMs: avg === null ? null : Math.round((avg - rng.range(1, 3)) * 10) / 10,
        maxMs: avg === null ? null : Math.round((avg + rng.range(4, 25)) * 10) / 10,
        jitterMs: avg === null ? null : Math.round(rng.range(0.5, 3.5) * 10) / 10,
      };
    }
    return hop;
  });
  const ips = hops.map((h) => h.ip).filter((ip): ip is string => ip !== null);
  return {
    ts,
    target: family === 4 ? '1.1.1.1' : '2606:4700:4700::1111',
    family,
    hops,
    reached: true,
    pathHash: createHash('sha1').update(ips.join('>')).digest('hex').slice(0, 16),
    changed: false,
    trigger,
    durationMs: withMtr ? rng.int(18_000, 26_000) : rng.int(2600, 4200),
  };
}

function writeTraceroutes(db: EngineDb, plan: Plan, rng: Rng): number {
  const runs: { ts: number; trigger: TracerouteResult['trigger']; mtr: boolean }[] = [];
  for (const s of plan.sessions) runs.push({ ts: s.from + 20 * SEC, trigger: 'startup', mtr: false });
  for (let ts = plan.from + 15 * MIN; ts < plan.to; ts += 15 * MIN) runs.push({ ts, trigger: 'schedule', mtr: false });
  runs.push({ ts: plan.reboot.wanUpAt + 15 * SEC, trigger: 'incident', mtr: true });
  runs.push({ ts: plan.to - 4 * MIN, trigger: 'manual', mtr: true });
  runs.sort((a, b) => a.ts - b.ts);
  const lastHash: Record<4 | 6, string | null> = { 4: null, 6: null };
  let n = 0;
  for (const r of runs) {
    if (inAny(plan.noSamples, r.ts) || inAny(plan.wanDown, r.ts) || r.ts >= plan.to) continue;
    for (const family of [4, 6] as const) {
      const t = traceroute(r.ts + (family === 6 ? 5 * SEC : 0), family, r.trigger, family === 4 && r.ts >= plan.routeChangeAt, r.mtr, rng);
      t.changed = lastHash[family] !== null && lastHash[family] !== t.pathHash;
      lastHash[family] = t.pathHash;
      db.insertTraceroute(t);
      n++;
    }
  }
  return n;
}

// ─── router event log ───────────────────────────────────────────────────────

const LOG_TAIL = ';CM-MAC=a4:bb:6d:12:34:56;CMTS-MAC=00:01:5c:7a:bc:de;CM-QOS=1.1;CM-VER=3.1;';

function routerLog(plan: Plan, rng: Rng): { entries: Record<string, unknown>[]; events: NetEvent[] } {
  const raw: { ts: number; text: string; level: string }[] = [];
  for (let day = localDayStart(plan.from); day < plan.to; day = addDays(day, 1)) {
    const n = rng.int(2, 4);
    for (let i = 0; i < n; i++) {
      const ts = localTime(day, 19) + rng.int(0, 239) * MIN + rng.int(0, 59) * SEC;
      if (ts >= plan.from && ts < plan.to) raw.push({ ts, text: `No Ranging Response received - T3 time-out${LOG_TAIL}`, level: '3' });
    }
    const cm = localTime(day, 21, 37, 12);
    if (cm >= plan.from && cm < plan.to) {
      raw.push({ ts: cm, text: `CM-STATUS message sent. Event Type Code: 16; Chan ID: 33; DSID: N/A; MAC Addr: N/A; OFDM/OFDMA Profile ID: 3.${LOG_TAIL}`, level: '5' });
    }
  }
  const r = plan.reboot.ts;
  raw.push(
    { ts: r + 62 * SEC, text: `Cable Modem Reboot because of - Power On Reset${LOG_TAIL}`, level: '3' },
    { ts: r + 110 * SEC, text: `SYNC Timing Synchronization failure - Failed to acquire QAM/QPSK symbol timing;${LOG_TAIL}`, level: '3' },
    { ts: r + 150 * SEC, text: `No Ranging Response received - T3 time-out${LOG_TAIL}`, level: '3' },
    { ts: r + 175 * SEC, text: `Received Response to Broadcast Maintenance Request, But no Unicast Maintenance opportunities received - T4 time out${LOG_TAIL}`, level: '3' },
    { ts: r + 230 * SEC, text: `Honoring MDD; IP provisioning mode = IPv6${LOG_TAIL}`, level: '6' },
  );
  raw.sort((a, b) => a.ts - b.ts);
  const entries: Record<string, unknown>[] = [];
  const events: NetEvent[] = [];
  raw.forEach((e, i) => {
    const cls = classifyLogMessage(e.text, e.level);
    const timeText = routerTimeText(e.ts);
    const index = String(1000 + i);
    const entry = {
      ts: e.ts,
      timeText,
      level: e.level,
      message: e.text.replace(/;?\s*(?:cm|cmts)-mac\s*=.*$/i, '').trim(),
      category: cls.category,
      severity: cls.severity,
      index,
      dedupeKey: `router:${timeText}-${index}`,
      key: cls.key,
      cmStatusCode: cls.cmStatusCode,
      dir: cls.dir,
      title: cls.title,
      burst: null,
      baseSeverity: cls.severity,
      rawMessage: e.text,
    };
    entries.push(entry);
    events.push({
      ts: e.ts,
      endTs: null,
      type: 'router_log',
      severity: cls.severity,
      segment: 'docsis',
      title: `Router-Protokoll: ${cls.title}`,
      details: entry,
      source: 'router',
      dedupeKey: entry.dedupeKey,
    });
  });
  return { entries: entries.reverse(), events };
}

// ─── database file handling ─────────────────────────────────────────────────

/** Removes an earlier demo database at `dbPath`; refuses to touch any other existing file. */
export function prepareDemoTarget(dbPath: string): void {
  if (!fs.existsSync(dbPath)) return;
  let isDemo = false;
  try {
    const probe = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const row = probe.prepare('SELECT value FROM settings WHERE key = ?').get(DEMO_MARKER_KEY);
      isDemo = row !== undefined;
    } finally {
      probe.close();
    }
  } catch {
    isDemo = false;
  }
  if (!isDemo) {
    throw new Error(`${dbPath} existiert bereits und ist keine Demo-Datenbank – bitte einen anderen Pfad angeben (echte Messdaten werden nie überschrieben).`);
  }
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbPath + suffix, { force: true });
}

// ─── entry point ────────────────────────────────────────────────────────────

export function seedDemo(opts: SeedOptions): SeedSummary {
  const t0 = performance.now();
  const dbPath = path.resolve(opts.dbPath);
  const to = Math.floor((opts.end ?? Date.now()) / MIN) * MIN;
  const from = to - Math.max(30 * MIN, Math.floor((opts.spanMs ?? 2 * DAY) / MIN) * MIN);
  const rng = new Rng(opts.seed ?? 20261009);
  const log = (msg: string) => {
    if (opts.verbose) console.log(`[seed-demo] ${msg}`);
  };
  prepareDemoTarget(dbPath);
  const db = openEngineDb(dbPath, {
    flushIntervalMs: 3_600_000,
    onError: (err) => {
      throw err;
    },
  });
  try {
    const cfg = mergeConfig({
      tariff: { name: 'Vodafone GigaZuhause 500 Kabel', downMbps: 500, upMbps: 50 },
      router: { loginEnabled: true },
    });
    db.setSetting(DEMO_MARKER_KEY, JSON.stringify({ version: 1, createdAt: Date.now(), from, to, seed: opts.seed ?? 20261009 }));
    db.setSetting('config', JSON.stringify(cfg));
    db.setSetting('session.expectedIf', 'Ethernet');

    const plan = buildPlan(from, to, rng);
    const ids: EventIds = { record: 7000 };
    const events: NetEvent[] = [...historyEvents(from, opts.historyDays ?? 45, rng, ids)];

    let sessions = 0;
    for (const s of plan.sessions) {
      const created = db.createSession({ startedAt: s.from, endedAt: s.status === 'completed' ? s.to : null, plannedEndAt: s.plannedEndAt, label: s.label, status: s.status, note: null });
      events.push(...sessionEvents(s, created.id));
      sessions++;
    }
    events.push(...planEvents(plan, ids));

    log(`erzeuge Messwerte ${new Date(from).toLocaleString('de-DE')} – ${new Date(to).toLocaleString('de-DE')} …`);
    const counters = { samples: 0, rollups: 0, secondsRows: 0 };
    generateSamples({ db, cfg, plan, rng, events, counters });
    log(`${counters.samples} Messwerte, ${counters.rollups} Minutenwerte, ${counters.secondsRows} Sekunden-Minuten`);

    let speedtests = 0;
    for (const st of plan.speedtests) {
      const id = db.insertSpeedtest(st.result);
      events.push(speedtestEvent(st, id));
      speedtests++;
    }
    const log2 = routerLog(plan, rng);
    events.push(...log2.events);
    events.sort((a, b) => a.ts - b.ts);
    let eventCount = 0;
    for (const e of events) if (db.insertEvent(e) !== null) eventCount++;

    const metrics = writeMetrics(db, plan, rng);
    let snapshots = writeSnapshots(db, plan, rng);
    db.insertSnapshot('router_log', plan.to - 2 * MIN, { entries: log2.entries });
    snapshots++;
    const traceroutes = writeTraceroutes(db, plan, rng);
    db.flush();
    const summary: SeedSummary = {
      dbPath,
      from,
      to,
      samples: counters.samples,
      rollups: counters.rollups,
      secondsRows: counters.secondsRows,
      events: eventCount,
      metrics,
      snapshots,
      speedtests,
      traceroutes,
      sessions,
      durationMs: Math.round(performance.now() - t0),
    };
    log(`${eventCount} Ereignisse, ${metrics} Kennzahlen, ${snapshots} Schnappschüsse, ${speedtests} Speedtests, ${traceroutes} Traceroutes, ${sessions} Sitzungen`);
    return summary;
  } finally {
    db.close();
  }
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return path.resolve(fileURLToPath(import.meta.url)).toLowerCase() === path.resolve(entry).toLowerCase();
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const target = process.argv[2] && process.argv[2].trim() !== '' ? process.argv[2] : DEFAULT_DEMO_DB;
  try {
    const s = seedDemo({ dbPath: target, verbose: true });
    console.log(`[seed-demo] fertig in ${(s.durationMs / 1000).toFixed(1)} s → ${s.dbPath}`);
    const rel = path.relative(process.cwd(), s.dbPath);
    const shown = rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : s.dbPath;
    console.log(`[seed-demo] UI starten mit (PowerShell): $env:NETDIAG_DB='${shown}'; npm run dev:web`);
  } catch (err) {
    console.error(`[seed-demo] Fehler: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}
