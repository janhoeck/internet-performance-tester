// Measurement-gap detection (1 s timer, gap > 5 s → engine_gap event) and event-loop lag
// (perf_hooks.monitorEventLoopDelay → metric engine.loop_lag_ms, p99 every 10 s). ARCHITECTURE §4.2.
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { fmtDuration } from '../../src/lib/shared/format';
import type { NetEvent } from '../../src/lib/shared/types';
import { round } from './util';

export const GAP_THRESHOLD_MS = 5000;

export interface Gap {
  /** wall clock of the last tick before the gap */
  from: number;
  /** wall clock of the first tick after the gap */
  to: number;
  gapMs: number;
  /** monotonic time between the two ticks (may stop during standby on Windows) */
  monotonicMs: number | null;
}

/** Feed it one tick per second; returns the gap when the previous tick is more than `thresholdMs` ago. */
export class GapDetector {
  private lastWall: number | null = null;
  private lastMono: number | null = null;

  constructor(private readonly thresholdMs = GAP_THRESHOLD_MS) {}

  tick(wall: number, mono: number | null = null): Gap | null {
    const prevWall = this.lastWall;
    const prevMono = this.lastMono;
    this.lastWall = wall;
    this.lastMono = mono;
    if (prevWall === null) return null;
    const gapMs = wall - prevWall;
    if (gapMs <= this.thresholdMs) return null;
    const monotonicMs = mono !== null && prevMono !== null ? Math.round(mono - prevMono) : null;
    return { from: prevWall, to: wall, gapMs, monotonicMs };
  }

  reset(): void {
    this.lastWall = null;
    this.lastMono = null;
  }
}

/** engine_gap event: ts = last tick before the gap, endTs = first tick after it. */
export function gapEvent(gap: Gap, cause: 'timer' | 'restart' = 'timer'): NetEvent {
  const dur = fmtDuration(gap.gapMs);
  return {
    ts: gap.from,
    endTs: gap.to,
    type: 'engine_gap',
    severity: 'info',
    segment: null,
    title:
      cause === 'restart'
        ? `Messlücke: Engine war ${dur} nicht aktiv (Neustart)`
        : `Messlücke: ${dur} ohne Messung (Standby oder Engine hing)`,
    details: {
      cause,
      gapMs: gap.gapMs,
      monotonicMs: gap.monotonicMs,
      thresholdMs: GAP_THRESHOLD_MS,
    },
    source: 'engine',
    dedupeKey: `engine_gap:${gap.from}`,
  };
}

/**
 * Lag estimate from an event-loop-delay histogram (values in ns). The histogram records the
 * intervals between ticks of a `resolution` ms timer, and Windows quantizes timers: a 10 ms timer
 * fires every ~15.6 ms, and right after a blocked tick the next one fires at once (so `min` drops
 * to ~0 as soon as anything blocks). The typical interval (p50) is the no-delay baseline:
 * lag = p99 − p50, clamped at 0. Measured on this PC: idle ≈ 0.6 ms, 20 ms blocks → ≈ 5 ms.
 */
export function loopLagFromHistogram(h: { percentile(p: number): number; count?: number }): number | null {
  if (h.count !== undefined && h.count < 2) return null;
  const p99 = h.percentile(99);
  const p50 = h.percentile(50);
  if (!Number.isFinite(p99) || !Number.isFinite(p50) || p99 <= 0 || p50 <= 0) return null;
  return round(Math.max(0, p99 - p50) / 1e6, 1);
}

export interface LoopLagMonitor {
  /** discard the current window (e.g. after a sleep gap) */
  reset(): void;
  stop(): void;
}

export function startLoopLagMonitor(opts: {
  intervalMs?: number;
  resolutionMs?: number;
  onSample: (lagMs: number, ts: number) => void;
}): LoopLagMonitor {
  const h = monitorEventLoopDelay({ resolution: opts.resolutionMs ?? 10 });
  h.enable();
  const timer = setInterval(() => {
    const lag = loopLagFromHistogram(h);
    h.reset();
    if (lag !== null) opts.onSample(lag, Date.now());
  }, opts.intervalMs ?? 10_000);
  timer.unref();
  return {
    reset: () => h.reset(),
    stop: () => {
      clearInterval(timer);
      h.disable();
    },
  };
}
