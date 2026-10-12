// Small shared helpers for the analysis modules (baselines, classifier, incidents, rollups).
// Pure code without engine dependencies so everything stays unit-testable.
import type { AppConfig } from '../../src/lib/shared/config';
import { SampleStatus, type Sample, type TargetConfig } from '../../src/lib/shared/types';

export const SECOND_MS = 1000;
export const MINUTE_MS = 60_000;

/** A sample counts as lost unless it is an OK reply with a finite RTT. */
export function isLost(s: Pick<Sample, 'rtt' | 'status'>): boolean {
  return s.status !== SampleStatus.OK || s.rtt === null || !Number.isFinite(s.rtt);
}

export function hasFlag(s: Pick<Sample, 'flags'>, flag: number): boolean {
  return ((s.flags ?? 0) & flag) !== 0;
}

/** Start of the minute containing ts (epoch ms). */
export function minuteOf(ts: number): number {
  return Math.floor(ts / MINUTE_MS) * MINUTE_MS;
}

/**
 * Pinger round ("tick") of a sample. Pinger samples already carry the scheduled tick (whole
 * seconds); fallback ping.exe samples are not aligned and are mapped to the nearest second.
 */
export function tickOf(ts: number): number {
  return Math.floor((ts + 500) / SECOND_MS) * SECOND_MS;
}

/** id → target lookup that is rebuilt whenever the config object changes (config is read fresh). */
export class TargetIndex {
  private cfg: AppConfig | null = null;
  private byId = new Map<string, TargetConfig>();

  constructor(private readonly config: () => AppConfig) {}

  current(): AppConfig {
    const cfg = this.config();
    if (cfg !== this.cfg) {
      this.cfg = cfg;
      this.byId = new Map(cfg.targets.map((t) => [t.id, t]));
    }
    return cfg;
  }

  get(id: string): TargetConfig | undefined {
    this.current();
    return this.byId.get(id);
  }
}

/** Time windows reported by `engine_gap` events (engine stalled / PC asleep). */
export class GapWindows {
  private windows: { from: number; to: number }[] = [];

  constructor(private readonly keepMs = 15 * MINUTE_MS) {}

  add(from: number, to: number): void {
    if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return;
    this.windows.push({ from, to });
    const newest = Math.max(...this.windows.map((w) => w.to));
    this.windows = this.windows.filter((w) => newest - w.to <= this.keepMs);
  }

  /** true when ts lies inside a gap: from < ts ≤ to (the tick at `from` was still measured). */
  contains(ts: number): boolean {
    for (const w of this.windows) if (ts > w.from && ts <= w.to) return true;
    return false;
  }

  clear(): void {
    this.windows = [];
  }
}

/** Swallow and report errors of bus handlers / timers – analysis must never crash the engine. */
export function guard(onError: (err: unknown) => void, fn: () => void): void {
  try {
    fn();
  } catch (err) {
    onError(err);
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === 'string' ? err : JSON.stringify(err);
}
