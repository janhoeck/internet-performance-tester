// Incident detection (docs/ARCHITECTURE.md §4.6): latency spike episodes and loss bursts per
// target, outages across targets. Runs during measurement sessions on the delayed, time-ordered
// sample stream; persists `latency_spike`, `loss_burst` and `outage` events and emits the
// internal bus 'incident' signal (speed test scheduler, incident traceroute).
import type { AppConfig } from '../../src/lib/shared/config';
import { fmtDuration, fmtMs } from '../../src/lib/shared/format';
import {
  type ClientState,
  type EventSource,
  type ModuleState,
  type NetEvent,
  type Sample,
  SampleFlag,
  type TargetConfig,
} from '../../src/lib/shared/types';
import type { BusEvents, EngineContext, EngineModule } from '../core/types';
import { type SpikeVerdict, getBaselineTracker } from './baseline';
import { isLinkSecond } from './classify';
import { ClientHistory } from './client-history';
import { TargetIndex, errorMessage, guard, hasFlag, isLost, tickOf } from './common';
import { type LossBurst, LossBurstTracker, type SpikeEpisode, SpikeEpisodeTracker, type SpikeUpdate } from './episodes';
import { GroupCache, type ReferenceGroups } from './groups';
import { type FinishedOutage, OUTAGE_LABEL, OUTAGE_SEGMENT, type OutageInfo, type OutageRound, OutageDetector } from './outage';
import { type Round, SampleSequencer, type SequencedSample, splitRounds } from './sequencer';

export type EventPatch = Partial<Pick<NetEvent, 'endTs' | 'severity' | 'title' | 'details' | 'segment'>>;

export interface IncidentDeps {
  config(): AppConfig;
  verdict(s: Sample): SpikeVerdict;
  clientAt(ts: number): ClientState | null;
  inRecovery(ts: number): boolean;
  recordEvent(e: NetEvent): number | null;
  updateEvent(id: number, patch: EventPatch): void;
  emitIncident(p: BusEvents['incident']): void;
}

export interface IncidentOptions {
  /** wait this long after a tick before processing it (pinger timeout 2 s), default 3000 ms */
  delayMs?: number;
  /** on stop(now): younger ticks may still miss their timeouts and are dropped, default 2500 ms */
  completeAfterMs?: number;
  /** interim updates of an open spike episode at most this often, default 15 s */
  updateEveryMs?: number;
}

const LEVEL_SHIFT_NOTE =
  'Anhaltend erhöhte Latenz: mehr als die Hälfte der letzten 60 s lag über der Spike-Schwelle – eher Überlastung als einzelne Spitzen.';
const LAN_SPIKE_HINT =
  'Nur der Router antwortet verzögert? Pings an den Router selbst werden nachrangig behandelt (Control-Plane) – entscheidend ist, ob die Ziele dahinter gleichzeitig Spitzen zeigen.';

function sourceOf(t: TargetConfig): EventSource {
  if (t.kind === 'icmp') return 'icmp';
  if (t.kind === 'udp-dns') return 'udp';
  if (t.kind === 'tcp') return 'tcp';
  return 'engine';
}

const round1 = (v: number | null): number | null => (v === null ? null : Math.round(v * 10) / 10);

function spikeTitle(ep: SpikeEpisode, t: TargetConfig): string {
  const normal = ep.baselineMs !== null ? ` statt ${fmtMs(ep.baselineMs)}` : '';
  if (ep.levelShift) return `Anhaltend erhöhte Latenz bei ${t.name}: bis ${fmtMs(ep.peakMs)}${normal}`;
  if (ep.spikeSamples === 1) return `Latenzspitze bei ${t.name}: ${fmtMs(ep.peakMs)}${normal}`;
  return `Latenzspitzen bei ${t.name}: bis ${fmtMs(ep.peakMs)}${normal} (${ep.spikeSamples}×)`;
}

function spikeDetails(ep: SpikeEpisode, t: TargetConfig): Record<string, unknown> {
  const d: Record<string, unknown> = {
    targetId: t.id,
    peakMs: round1(ep.peakMs),
    baselineMs: round1(ep.baselineMs),
    spikeSamples: ep.spikeSamples,
    severity: ep.severity,
    durationMs: ep.endTs - ep.startTs + t.intervalMs,
  };
  if (ep.levelShift) {
    d.levelShift = true;
    d.note = LEVEL_SHIFT_NOTE;
  }
  if (t.segment === 'lan') d.hint = LAN_SPIKE_HINT;
  return d;
}

/**
 * latency_spike event. Episodes cover [first spike, last spike + interval), so that
 * endTs − ts = details.durationMs (same convention as outages: end = first good sample).
 */
export function spikeEvent(ep: SpikeEpisode, t: TargetConfig, open: boolean): NetEvent {
  return {
    ts: ep.startTs,
    endTs: open ? null : ep.endTs + t.intervalMs,
    type: 'latency_spike',
    severity: ep.severity === 'severe' ? 'warn' : 'info',
    segment: t.segment,
    title: spikeTitle(ep, t),
    details: spikeDetails(ep, t),
    source: sourceOf(t),
    dedupeKey: `incident:spike:${t.id}:${ep.startTs}`,
  };
}

/** loss_burst event covering [first loss, last loss + interval) */
export function burstEvent(b: LossBurst, t: TargetConfig, windowSec: number): NetEvent {
  const noun = t.kind === 'icmp' ? 'Pings' : 'Messungen';
  return {
    ts: b.startTs,
    endTs: b.endTs + t.intervalMs,
    type: 'loss_burst',
    severity: 'warn',
    segment: t.segment,
    title: `Paketverlust bei ${t.name}: ${b.lost} von ${b.sent} ${noun} verloren`,
    details: {
      targetId: t.id,
      lost: b.lost,
      sent: b.sent,
      maxRun: b.maxRun,
      windowSec,
      durationMs: b.endTs - b.startTs + t.intervalMs,
    },
    source: sourceOf(t),
    dedupeKey: `incident:burst:${t.id}:${b.startTs}`,
  };
}

function outageDetails(o: OutageInfo): Record<string, unknown> {
  return {
    classification: o.classification,
    initialClassification: o.initialClassification,
    lostTargets: o.lostTargets,
    rounds: o.rounds,
    votes: o.votes,
    lastSuccessTs: o.lastSuccessTs,
  };
}

export function outageStartEvent(o: OutageInfo): NetEvent {
  return {
    ts: o.startTs,
    endTs: null,
    type: 'outage',
    severity: 'critical',
    segment: OUTAGE_SEGMENT[o.classification],
    title: `Ausfall läuft: ${OUTAGE_LABEL[o.classification]}`,
    details: { ...outageDetails(o), ongoing: true },
    source: 'icmp',
    dedupeKey: `incident:outage:${o.startTs}`,
  };
}

export function outageEndPatch(o: FinishedOutage): EventPatch {
  const dur = `${o.interrupted ? 'mind. ' : ''}${fmtDuration(o.durationMs)}`;
  return {
    endTs: o.endTs,
    segment: OUTAGE_SEGMENT[o.classification],
    title: `Ausfall (${dur}): ${OUTAGE_LABEL[o.classification]}`,
    details: {
      ...outageDetails(o),
      durationMs: o.durationMs,
      nextSuccessTs: o.nextSuccessTs,
      ongoing: false,
      ...(o.interrupted ? { interrupted: true } : {}),
    },
  };
}

interface OpenSpikeEvent {
  id: number | null;
  lastUpdateTs: number;
}

/** Stateful detector; feed samples with add(), call process(now) about once per second. */
export class IncidentDetector {
  private readonly seq: SampleSequencer;
  private readonly index: TargetIndex;
  private readonly groups = new GroupCache();
  private readonly spikes = new Map<string, SpikeEpisodeTracker>();
  private readonly bursts = new Map<string, LossBurstTracker>();
  private readonly openSpikes = new Map<string, OpenSpikeEvent>();
  private readonly outage: OutageDetector;
  private outageEventId: number | null = null;
  private lastRoundTs = Number.NEGATIVE_INFINITY;
  private readonly completeAfterMs: number;
  private readonly updateEveryMs: number;
  /** loss bursts not persisted because an outage covered them */
  suppressedBursts = 0;
  /** samples skipped because their RTT was distorted by an engine stall */
  unreliableSamples = 0;

  constructor(private readonly deps: IncidentDeps, opts: IncidentOptions = {}) {
    this.seq = new SampleSequencer(opts.delayMs ?? 3000);
    this.completeAfterMs = opts.completeAfterMs ?? 2500;
    this.updateEveryMs = opts.updateEveryMs ?? 15_000;
    this.index = new TargetIndex(() => deps.config());
    this.outage = new OutageDetector(
      {
        onStart: (o) => this.onOutageStart(o),
        onEnd: (o) => this.onOutageEnd(o),
      },
      { minRounds: () => deps.config().thresholds.outageMinSec },
    );
  }

  get outageActive(): boolean {
    return this.outage.isActive;
  }

  get lateSamples(): number {
    return this.seq.late;
  }

  /** queue a sample; `load` = a speed test was running when it arrived */
  add(sample: Sample, load: boolean): void {
    this.seq.add({ sample, load: load || hasFlag(sample, SampleFlag.LOAD) });
  }

  /** process everything that is at least `delayMs` old */
  process(now: number): void {
    const frontier = now - this.seq.delayMs;
    this.handle(this.seq.drainUntil(frontier));
    this.expire(frontier);
  }

  /** engine gap (ts = last tick before it): finish everything measured before and start from scratch */
  onEngineGap(from: number): void {
    this.handle(this.seq.drainUntil(from));
    this.finishAll();
  }

  /** session stop: process the complete ticks, drop the younger ones and close all open episodes */
  stop(now: number): void {
    this.handle(this.seq.drainUntil(now - this.completeAfterMs));
    this.finishAll();
    this.seq.clear();
    this.lastRoundTs = Number.NEGATIVE_INFINITY;
  }

  /**
   * Process an ordered batch tick by tick: the outage detector sees each pinger round before the
   * per-target trackers handle that tick, so a loss burst is always checked against the outage
   * state of its own time (bursts inside an outage are suppressed).
   */
  private handle(entries: SequencedSample[]): void {
    if (entries.length === 0) return;
    const cfg = this.deps.config();
    const g = this.groups.get(cfg);
    const { rounds } = splitRounds(entries, (id) => g.icmp.has(id));
    let ri = 0;
    const feedRoundsUntil = (tick: number): void => {
      while (ri < rounds.length && rounds[ri].ts <= tick) {
        const r = rounds[ri++];
        if (r.ts <= this.lastRoundTs) continue;
        this.lastRoundTs = r.ts;
        this.outage.process(this.toOutageRound(r, g));
      }
    };
    for (const e of entries) {
      feedRoundsUntil(tickOf(e.sample.ts));
      this.perTarget(e, cfg);
    }
    feedRoundsUntil(Number.POSITIVE_INFINITY);
  }

  private perTarget(e: SequencedSample, cfg: AppConfig): void {
    if (e.load) return; // no spike/burst events while a speed test saturates the line
    const t = this.index.get(e.sample.targetId);
    if (!t) return;
    const v = this.deps.verdict(e.sample);
    if (v.unreliable) {
      this.unreliableSamples++;
      return;
    }
    this.applySpikes(this.spikeTracker(t).push(e.sample.ts, v, v.ok ? e.sample.rtt : null), t);
    const finished = this.burstTracker(t).push(e.sample.ts, !v.ok);
    if (finished) this.applyBurst(finished, t, cfg);
  }

  private toOutageRound(r: Round, g: ReferenceGroups): OutageRound {
    const lostOf = (id: string): boolean | null => {
      const e = r.samples.get(id);
      return e ? isLost(e.sample) : null;
    };
    const count = (ids: readonly string[], lost: boolean) => ids.filter((id) => lostOf(id) === lost).length;
    const lostTargets: string[] = [];
    for (const [id, e] of r.samples) if (isLost(e.sample)) lostTargets.push(id);
    return {
      ts: r.ts,
      linkIssue: isLinkSecond(this.deps.clientAt(r.ts), this.deps.inRecovery(r.ts)),
      internetLost: g.internet.filter((id) => lostOf(id) === true),
      internetOk: g.internet.filter((id) => lostOf(id) === false),
      lanLost: count(g.gw, true),
      lanOk: count(g.gw, false),
      isp6Lost: count(g.isp6, true),
      isp6Ok: count(g.isp6, false),
      v4Lost: count(g.v4, true),
      v4Ok: count(g.v4, false),
      v6Lost: count(g.v6, true),
      v6Ok: count(g.v6, false),
      providerLost: count(g.provider, true),
      providerOk: count(g.provider, false),
      lostTargets,
      load: r.load,
    };
  }

  private spikeTracker(t: TargetConfig): SpikeEpisodeTracker {
    let tr = this.spikes.get(t.id);
    if (!tr) {
      // "merge if gap ≤ 2 s" – for slower probes (5–10 s interval) two intervals
      tr = new SpikeEpisodeTracker(t.id, { mergeGapMs: Math.max(2000, 2 * t.intervalMs) });
      this.spikes.set(t.id, tr);
    }
    return tr;
  }

  private burstTracker(t: TargetConfig): LossBurstTracker {
    let tr = this.bursts.get(t.id);
    if (!tr) {
      tr = new LossBurstTracker(t.id, {
        windowMs: () => this.deps.config().thresholds.burstWindowSec * 1000,
        minLosses: () => this.deps.config().thresholds.burstMinLosses,
      });
      this.bursts.set(t.id, tr);
    }
    return tr;
  }

  private applySpikes(updates: SpikeUpdate[], t: TargetConfig): void {
    for (const u of updates) {
      if (u.kind === 'qualified') {
        const id = this.deps.recordEvent(spikeEvent(u.episode, t, true));
        this.openSpikes.set(t.id, { id, lastUpdateTs: u.episode.endTs });
      } else if (u.kind === 'grown') {
        const open = this.openSpikes.get(t.id);
        if (open && open.id !== null && (u.severityRaised || u.episode.endTs - open.lastUpdateTs >= this.updateEveryMs)) {
          const ev = spikeEvent(u.episode, t, true);
          this.deps.updateEvent(open.id, { severity: ev.severity, title: ev.title, details: ev.details });
          open.lastUpdateTs = u.episode.endTs;
        }
      } else {
        const open = this.openSpikes.get(t.id);
        this.openSpikes.delete(t.id);
        if (u.persisted && open && open.id !== null) {
          const ev = spikeEvent(u.episode, t, false);
          this.deps.updateEvent(open.id, { endTs: ev.endTs, severity: ev.severity, title: ev.title, details: ev.details });
        }
      }
    }
  }

  private applyBurst(b: LossBurst, t: TargetConfig, cfg: AppConfig): void {
    if (this.outage.overlaps(t.id, b.startTs, b.endTs)) {
      this.suppressedBursts++;
      return;
    }
    this.deps.recordEvent(burstEvent(b, t, cfg.thresholds.burstWindowSec));
  }

  private expire(frontier: number): void {
    const cfg = this.deps.config();
    for (const [id, tr] of this.spikes) {
      const t = this.index.get(id);
      if (t) this.applySpikes(tr.expire(frontier), t);
      else tr.reset();
    }
    for (const [id, tr] of this.bursts) {
      const t = this.index.get(id);
      const b = tr.expire(frontier);
      if (b && t) this.applyBurst(b, t, cfg);
    }
  }

  private finishAll(): void {
    const cfg = this.deps.config();
    // close the outage first so that bursts inside it are suppressed
    this.outage.interrupt();
    for (const [id, tr] of this.spikes) {
      const t = this.index.get(id);
      if (t) this.applySpikes(tr.finish(), t);
    }
    for (const [id, tr] of this.bursts) {
      const t = this.index.get(id);
      const b = tr.finish();
      if (b && t) this.applyBurst(b, t, cfg);
    }
    this.spikes.clear();
    this.bursts.clear();
    this.openSpikes.clear();
  }

  private onOutageStart(o: OutageInfo): void {
    this.outageEventId = this.deps.recordEvent(outageStartEvent(o));
    this.deps.emitIncident({ kind: 'outage-start', ts: o.startTs, classification: o.classification });
  }

  private onOutageEnd(o: FinishedOutage): void {
    if (this.outageEventId !== null) this.deps.updateEvent(this.outageEventId, outageEndPatch(o));
    this.outageEventId = null;
    this.deps.emitIncident({ kind: 'outage-end', ts: o.endTs, classification: o.classification });
  }
}

// ─── engine module ─────────────────────────────────────────────────────────

export function createIncidentsModule(): EngineModule {
  let ctx: EngineContext | null = null;
  let detector: IncidentDetector | null = null;
  const history = new ClientHistory();
  let timer: ReturnType<typeof setInterval> | null = null;
  let unsubs: (() => void)[] = [];
  const st: ModuleState = {
    name: 'incidents',
    enabled: true,
    running: false,
    busy: false,
    lastRunTs: null,
    nextRunTs: null,
    lastError: null,
  };

  const onError = (err: unknown): void => {
    st.lastError = errorMessage(err);
    ctx?.log.warn(`Ereigniserkennung: ${st.lastError}`);
  };

  const tick = (): void =>
    guard(onError, () => {
      if (!ctx || !detector) return;
      history.push(ctx.clientState());
      const now = Date.now();
      detector.process(now);
      st.lastRunTs = now;
      st.nextRunTs = now + 1000;
    });

  const stop = (): void => {
    if (timer) clearInterval(timer);
    timer = null;
    for (const u of unsubs) u();
    unsubs = [];
    if (st.running) guard(onError, () => detector?.stop(Date.now()));
    st.running = false;
    st.nextRunTs = null;
  };

  return {
    name: 'incidents',
    init(c: EngineContext): void {
      ctx = c;
      const tracker = getBaselineTracker(c);
      detector = new IncidentDetector({
        config: () => c.config(),
        verdict: (s) => tracker.verdict(s),
        clientAt: (ts) => history.at(ts),
        inRecovery: (ts) => history.inRecovery(ts),
        recordEvent: (e) => c.recordEvent(e),
        updateEvent: (id, patch) => c.updateEvent(id, patch),
        emitIncident: (p) => c.bus.emit('incident', p),
      });
    },
    start(): void {
      const c = ctx;
      const d = detector;
      if (!c || !d || st.running) return;
      history.clear();
      history.push(c.clientState());
      unsubs = [
        c.bus.on('sample', (s) => guard(onError, () => d.add(s, c.speedtestActive()))),
        c.bus.on('client', (cs) => guard(onError, () => history.push(cs))),
        c.bus.on('event', (e) =>
          guard(onError, () => {
            if (e.type === 'engine_gap') d.onEngineGap(e.ts);
          }),
        ),
      ];
      timer = setInterval(tick, 1000);
      timer.unref?.();
      st.running = true;
      st.lastError = null;
    },
    stop,
    dispose: stop,
    state: (): ModuleState => ({ ...st }),
  };
}
