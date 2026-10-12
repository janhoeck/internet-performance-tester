// Per-target episode state machines for the incident detector (docs/ARCHITECTURE.md §4.6,
// methodology.md §5): latency spike episodes and loss bursts. Samples must be fed in ts order.
import type { SpikeSeverity } from '../../src/lib/shared/stats';
import type { SpikeVerdict } from './baseline';

export const SEVERITY_RANK: Record<SpikeSeverity, number> = { minor: 1, major: 2, severe: 3 };

export interface SpikeEpisode {
  targetId: string;
  /** first / last spike sample */
  startTs: number;
  endTs: number;
  spikeSamples: number;
  peakMs: number;
  /** baseline median when the peak was measured (null while the baseline warmed up) */
  baselineMs: number | null;
  severity: SpikeSeverity;
  /** > 50 % of the last 60 s were spikes – sustained elevated latency rather than single spikes */
  levelShift: boolean;
}

export type SpikeUpdate =
  /** the episode just met the persist rule (≥ 2 spike samples or severity ≥ major) */
  | { kind: 'qualified'; episode: SpikeEpisode }
  /** an already qualified episode got another spike sample */
  | { kind: 'grown'; episode: SpikeEpisode; severityRaised: boolean }
  /** the episode ended; persisted = it had qualified */
  | { kind: 'finished'; episode: SpikeEpisode; persisted: boolean };

export interface SpikeEpisodeOptions {
  /** spikes at most this far apart belong to one episode (default 2000 ms) */
  mergeGapMs: number;
  /** level-shift lookback (default 60 s) */
  levelWindowMs?: number;
  /** level shift needs at least this many successful samples in the lookback (default 10) */
  levelMinSamples?: number;
}

export class SpikeEpisodeTracker {
  private ep: SpikeEpisode | null = null;
  private qualified = false;
  private recent: { ts: number; spike: boolean }[] = [];
  private readonly levelWindowMs: number;
  private readonly levelMinSamples: number;

  constructor(readonly targetId: string, private readonly opts: SpikeEpisodeOptions) {
    this.levelWindowMs = opts.levelWindowMs ?? 60_000;
    this.levelMinSamples = opts.levelMinSamples ?? 10;
  }

  get open(): SpikeEpisode | null {
    return this.ep ? { ...this.ep } : null;
  }

  push(ts: number, v: SpikeVerdict, rtt: number | null): SpikeUpdate[] {
    const out: SpikeUpdate[] = [];
    if (this.ep && ts - this.ep.endTs > this.opts.mergeGapMs) out.push(this.close());
    if (!v.ok || rtt === null) return out;
    this.recent.push({ ts, spike: v.spike });
    while (this.recent.length > 0 && ts - this.recent[0].ts > this.levelWindowMs) this.recent.shift();
    if (!v.spike) return out;

    const severity = v.severity ?? 'minor';
    const median = v.baseline?.median ?? null;
    let raised = false;
    if (!this.ep) {
      this.ep = { targetId: this.targetId, startTs: ts, endTs: ts, spikeSamples: 1, peakMs: rtt, baselineMs: median, severity, levelShift: false };
      this.qualified = false;
    } else {
      const ep = this.ep;
      ep.endTs = ts;
      ep.spikeSamples++;
      if (rtt > ep.peakMs) {
        ep.peakMs = rtt;
        ep.baselineMs = median ?? ep.baselineMs;
      }
      if (SEVERITY_RANK[severity] > SEVERITY_RANK[ep.severity]) {
        ep.severity = severity;
        raised = true;
      }
    }
    const ep = this.ep;
    if (!ep.levelShift && this.levelShare() > 0.5) ep.levelShift = true;
    if (!this.qualified) {
      if (ep.spikeSamples >= 2 || SEVERITY_RANK[ep.severity] >= SEVERITY_RANK.major) {
        this.qualified = true;
        out.push({ kind: 'qualified', episode: { ...ep } });
      }
    } else {
      out.push({ kind: 'grown', episode: { ...ep }, severityRaised: raised });
    }
    return out;
  }

  /** close the episode once no later spike can merge into it (frontier = newest processed ts) */
  expire(frontierTs: number): SpikeUpdate[] {
    return this.ep && frontierTs - this.ep.endTs > this.opts.mergeGapMs ? [this.close()] : [];
  }

  finish(): SpikeUpdate[] {
    return this.ep ? [this.close()] : [];
  }

  /** share of spikes among the successful samples of the lookback window (0 if too few) */
  levelShare(): number {
    if (this.recent.length < this.levelMinSamples) return 0;
    return this.recent.filter((r) => r.spike).length / this.recent.length;
  }

  reset(): void {
    this.ep = null;
    this.qualified = false;
    this.recent = [];
  }

  private close(): SpikeUpdate {
    const episode = this.ep as SpikeEpisode;
    const persisted = this.qualified;
    this.ep = null;
    this.qualified = false;
    return { kind: 'finished', episode: { ...episode }, persisted };
  }
}

export interface LossBurst {
  targetId: string;
  /** first / last lost sample */
  startTs: number;
  endTs: number;
  lost: number;
  /** samples from the first to the last loss */
  sent: number;
  /** longest run of consecutive losses */
  maxRun: number;
}

export interface LossBurstOptions {
  /** config thresholds.burstWindowSec in ms (read fresh) */
  windowMs: () => number;
  /** config thresholds.burstMinLosses (read fresh) */
  minLosses: () => number;
}

interface OpenBurst extends LossBurst {
  run: number;
  samplesSinceStart: number;
}

/** Loss burst: ≥ minLosses losses within windowMs; ends when no loss follows within windowMs. */
export class LossBurstTracker {
  private recent: { ts: number; lost: boolean }[] = [];
  private burst: OpenBurst | null = null;

  constructor(readonly targetId: string, private readonly opts: LossBurstOptions) {}

  get open(): LossBurst | null {
    return this.burst ? this.public(this.burst) : null;
  }

  /** feed one sample; returns a burst that ended before this sample */
  push(ts: number, lost: boolean): LossBurst | null {
    const windowMs = this.opts.windowMs();
    let finished: LossBurst | null = null;
    if (this.burst && ts - this.burst.endTs >= windowMs) finished = this.close();
    this.recent.push({ ts, lost });
    while (this.recent.length > 0 && ts - this.recent[0].ts >= windowMs) this.recent.shift();

    const b = this.burst;
    if (b) {
      b.samplesSinceStart++;
      if (lost) {
        b.lost++;
        b.endTs = ts;
        b.sent = b.samplesSinceStart;
        b.run++;
        b.maxRun = Math.max(b.maxRun, b.run);
      } else {
        b.run = 0;
      }
    } else if (lost) {
      const losses = this.recent.filter((r) => r.lost);
      if (losses.length >= Math.max(2, Math.round(this.opts.minLosses()))) {
        const startTs = losses[0].ts;
        const span = this.recent.filter((r) => r.ts >= startTs);
        let run = 0;
        let maxRun = 0;
        for (const r of span) {
          run = r.lost ? run + 1 : 0;
          maxRun = Math.max(maxRun, run);
        }
        this.burst = { targetId: this.targetId, startTs, endTs: ts, lost: losses.length, sent: span.length, maxRun, run, samplesSinceStart: span.length };
      }
    }
    return finished;
  }

  expire(frontierTs: number): LossBurst | null {
    return this.burst && frontierTs - this.burst.endTs >= this.opts.windowMs() ? this.close() : null;
  }

  finish(): LossBurst | null {
    return this.burst ? this.close() : null;
  }

  reset(): void {
    this.recent = [];
    this.burst = null;
  }

  private public(b: OpenBurst): LossBurst {
    return { targetId: b.targetId, startTs: b.startTs, endTs: b.endTs, lost: b.lost, sent: b.sent, maxRun: b.maxRun };
  }

  private close(): LossBurst {
    const b = this.burst as OpenBurst;
    this.burst = null;
    return this.public(b);
  }
}
