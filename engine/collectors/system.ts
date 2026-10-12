// PC health during a session (ARCHITECTURE §4.3/§4.9): CPU/memory every systemPollSec (Node os,
// no child process) and system-wide TCP retransmissions every 60 s from the raw perf counters
// Win32_PerfRawData_Tcpip_TCPv4/TCPv6 (Δ SegmentsRetransmittedPersec / Δ SegmentsSentPersec) via the
// PowerShell worker → metrics sys.cpu_pct, sys.mem_pct, tcp.retrans_pct, tcp6.retrans_pct.
// macOS: `netstat -s -p tcp` (one statistic for both families → tcp.retrans_pct only), macos/system.ts.
import os from 'node:os';
import type { MetricPoint, ModuleState } from '../../src/lib/shared/types';
import type { EngineContext, EngineModule, Logger, PowerShellHost } from '../core/types';
import { isMac } from '../platform';
import { readMacTcpCounters } from './macos/system';
import { PollTimer, ProcessRunner, asNumber, childTracker, errorMessage, isRecord, timersState } from './util';

const TCP_EVERY_MS = 60_000;
/** fewer sent segments than this in one interval → no retransmission rate (too noisy) */
export const MIN_TCP_SEGMENTS = 100;

// ─── CPU / memory ──────────────────────────────────────────────────────────

export interface CpuTimes {
  idle: number;
  total: number;
}

export function cpuTimes(cpus: readonly os.CpuInfo[] = os.cpus()): CpuTimes {
  let idle = 0;
  let total = 0;
  for (const c of cpus) {
    const t = c.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.irq + t.idle;
  }
  return { idle, total };
}

/** busy share between two samples in % (null when the counters did not advance) */
export function cpuPct(prev: CpuTimes | null, cur: CpuTimes): number | null {
  if (!prev) return null;
  const dTotal = cur.total - prev.total;
  const dIdle = cur.idle - prev.idle;
  if (dTotal <= 0 || dIdle < 0) return null;
  return Math.round(Math.min(100, Math.max(0, (1 - dIdle / dTotal) * 100)) * 10) / 10;
}

export function memPct(total: number, free: number): number | null {
  if (!(total > 0) || free < 0) return null;
  return Math.round(Math.min(100, Math.max(0, (1 - free / total) * 100)) * 10) / 10;
}

// ─── TCP retransmissions ───────────────────────────────────────────────────

export interface TcpFamilyCounters {
  retrans: number;
  sent: number;
}

export interface TcpCounters {
  ts: number;
  v4: TcpFamilyCounters | null;
  v6: TcpFamilyCounters | null;
}

function family(v: unknown): TcpFamilyCounters | null {
  if (!isRecord(v)) return null;
  const retrans = asNumber(v.retrans);
  const sent = asNumber(v.sent);
  return retrans === null || sent === null ? null : { retrans, sent };
}

/** JSON of Get-NdTcpCounters → counters (ts = PowerShell wall clock, fallback `now`). */
export function parseTcpCounters(v: unknown, now: number): TcpCounters | null {
  if (!isRecord(v)) return null;
  const v4 = family(v.v4);
  const v6 = family(v.v6);
  if (!v4 && !v6) return null;
  return { ts: asNumber(v.t) ?? now, v4, v6 };
}

/** Δretrans / Δsent in % (null on counter reset, too few segments or missing data) */
export function retransPct(prev: TcpFamilyCounters | null, cur: TcpFamilyCounters | null, minSegments = MIN_TCP_SEGMENTS): number | null {
  if (!prev || !cur) return null;
  const dSent = cur.sent - prev.sent;
  const dRetrans = cur.retrans - prev.retrans;
  if (dSent < minSegments || dRetrans < 0) return null;
  return Math.round((dRetrans / dSent) * 100 * 1000) / 1000;
}

export function tcpMetrics(prev: TcpCounters | null, cur: TcpCounters, maxGapMs: number): MetricPoint[] {
  if (!prev || cur.ts - prev.ts <= 0 || cur.ts - prev.ts > maxGapMs) return [];
  const out: MetricPoint[] = [];
  const v4 = retransPct(prev.v4, cur.v4);
  const v6 = retransPct(prev.v6, cur.v6);
  if (v4 !== null) out.push({ ts: cur.ts, key: 'tcp.retrans_pct', value: v4 });
  if (v6 !== null) out.push({ ts: cur.ts, key: 'tcp6.retrans_pct', value: v6 });
  return out;
}

// ─── raw data sources ──────────────────────────────────────────────────────

/** Cumulative TCP counters; null when the OS does not provide them. */
export interface TcpCounterSource {
  read(now: number): Promise<TcpCounters | null>;
  dispose?(): void;
}

/** Windows: Get-NdTcpCounters through the PowerShell RPC worker. */
export function powerShellTcpSource(ps: PowerShellHost): TcpCounterSource {
  return {
    async read(now) {
      if (!ps.available) throw new Error('PowerShell nicht verfügbar');
      return parseTcpCounters(await ps.json<unknown>('Get-NdTcpCounters', { timeoutMs: 20_000 }), now);
    },
  };
}

/** macOS: `netstat -s -p tcp`. */
export function macTcpSource(runner: Pick<ProcessRunner, 'run' | 'killAll'>): TcpCounterSource {
  return {
    read: (now) => readMacTcpCounters(runner, now),
    dispose: () => runner.killAll(),
  };
}

export interface SystemModuleOptions {
  /** TCP counter source (default: by platform) */
  createTcpSource?: (ctx: EngineContext) => TcpCounterSource;
}

// ─── module ────────────────────────────────────────────────────────────────

class SystemModule implements EngineModule {
  readonly name = 'system';
  private ctx: EngineContext | null = null;
  private log: Logger | null = null;
  private tcpSource: TcpCounterSource | null = null;
  private cpuTimer: PollTimer | null = null;
  private tcpTimer: PollTimer | null = null;
  private cpuPrev: CpuTimes | null = null;
  private tcpPrev: TcpCounters | null = null;
  private running = false;
  private lastError: string | null = null;

  constructor(private readonly opts: SystemModuleOptions = {}) {}

  init(ctx: EngineContext): void {
    this.ctx = ctx;
    this.log = ctx.log;
    this.tcpSource = this.opts.createTcpSource
      ? this.opts.createTcpSource(ctx)
      : isMac()
        ? macTcpSource(new ProcessRunner(childTracker(ctx)))
        : powerShellTcpSource(ctx.ps);
    this.cpuTimer = new PollTimer({
      intervalMs: () => ctx.config().schedules.systemPollSec * 1000,
      run: async () => this.pollCpu(),
    });
    this.tcpTimer = new PollTimer({
      intervalMs: () => TCP_EVERY_MS,
      run: () => this.pollTcp(),
      onError: (err) => {
        this.lastError = errorMessage(err);
        this.log?.debug('TCP-Zähler nicht lesbar', { error: this.lastError });
      },
    });
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.cpuPrev = null;
    this.tcpPrev = null;
    this.cpuTimer?.start(0);
    this.tcpTimer?.start(1000);
  }

  stop(): void {
    this.running = false;
    this.cpuTimer?.stop();
    this.tcpTimer?.stop();
  }

  dispose(): void {
    this.stop();
    this.tcpSource?.dispose?.();
  }

  state(): ModuleState {
    const timers = [this.cpuTimer, this.tcpTimer].filter((t): t is PollTimer => t !== null);
    return timersState(this.name, this.running, timers, this.lastError);
  }

  private pollCpu(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const ts = Date.now();
    const cur = cpuTimes();
    const points: MetricPoint[] = [];
    const cpu = cpuPct(this.cpuPrev, cur);
    if (cpu !== null) points.push({ ts, key: 'sys.cpu_pct', value: cpu });
    const mem = memPct(os.totalmem(), os.freemem());
    if (mem !== null) points.push({ ts, key: 'sys.mem_pct', value: mem });
    this.cpuPrev = cur;
    if (points.length) ctx.recordMetrics(points);
  }

  private async pollTcp(): Promise<void> {
    const ctx = this.ctx;
    const source = this.tcpSource;
    if (!ctx || !source) return;
    const now = Date.now();
    const cur = await source.read(now);
    if (!cur) throw new Error('TCP-Leistungszähler nicht verfügbar');
    const points = tcpMetrics(this.tcpPrev, cur, 5 * TCP_EVERY_MS);
    if (points.length) ctx.recordMetrics(points);
    this.tcpPrev = cur;
    this.lastError = null;
  }
}

export function createSystemModule(opts: SystemModuleOptions = {}): EngineModule {
  return new SystemModule(opts);
}
