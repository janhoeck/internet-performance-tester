// Outage detection and localisation (docs/ARCHITECTURE.md §4.6, methodology.md §4.1/§4.3).
// Outage = ≥ 2 internet ICMP targets lost in ≥ outageMinSec consecutive pinger rounds.
// Localisation by which layers fail in the same rounds (the first failing layer wins); every
// round votes, the outage gets the majority class.
import type { OutageClass, Segment } from '../../src/lib/shared/types';

/** Condensed view of one pinger round for the outage detector (counts = members with a sample). */
export interface OutageRound {
  ts: number;
  /** expected link down, egress on another interface, or inside the relink window */
  linkIssue: boolean;
  /** internet ICMP targets that were lost / answered in this round */
  internetLost: string[];
  internetOk: string[];
  /** LAN reference targets (gw, gw6) lost / answered */
  lanLost: number;
  lanOk: number;
  /** CMTS / first IPv6 hop lost / answered */
  isp6Lost: number;
  isp6Ok: number;
  /** IPv4 / IPv6 internet reference members lost / answered */
  v4Lost: number;
  v4Ok: number;
  v6Lost: number;
  v6Ok: number;
  /** provider hops behind the CMTS (AFTR, first IPv4 backbone hop) lost / answered */
  providerLost: number;
  providerOk: number;
  /** ids of every target lost in this round (for loss-burst suppression) */
  lostTargets: string[];
  /** taken while a speed test saturated the line – such rounds cannot start an outage */
  load: boolean;
}

/** layer order, also used as tie-breaker (the layer closest to the PC wins) */
export const OUTAGE_CLASS_ORDER: readonly OutageClass[] = ['client', 'lan', 'docsis', 'aftr', 'isp', 'internet', 'unknown'];

export const OUTAGE_SEGMENT: Record<OutageClass, Segment | null> = {
  client: 'client',
  lan: 'lan',
  docsis: 'docsis',
  aftr: 'aftr',
  isp: 'isp',
  internet: 'internet',
  unknown: null,
};

/** German labels (MESSPLAN §3.8: PC / Heimnetz / Kabel / AFTR (nur IPv4) / Backbone / Internet) */
export const OUTAGE_LABEL: Record<OutageClass, string> = {
  client: 'PC & Netzwerkadapter',
  lan: 'Heimnetz/Router',
  docsis: 'Kabelnetz (DOCSIS)',
  aftr: 'DS-Lite-Gateway (nur IPv4)',
  isp: 'Vodafone-Backbone',
  internet: 'Internet',
  unknown: 'Ursache unklar',
};

export function isOutageRound(r: OutageRound): boolean {
  return r.internetLost.length >= 2;
}

/** a round with internet data that does not satisfy the outage condition */
export function isSuccessRound(r: OutageRound): boolean {
  return r.internetLost.length + r.internetOk.length > 0 && r.internetLost.length < 2;
}

/** every measured member lost (a layer without any sample is unknown, never down) */
const down = (lost: number, ok: number): boolean => lost > 0 && ok === 0;

/**
 * Layer that explains one outage round (methodology.md §4.3):
 *  client   – expected link down / failover / relink window
 *  lan      – every LAN reference target (gw, gw6) lost
 *  docsis   – router fine, CMTS lost and nothing behind it answers
 *  aftr     – all IPv4 internet targets lost while IPv6 internet answers (DS-Lite)
 *  internet – both families down although Vodafone's own hops (AFTR / backbone) answer, or only
 *             individual targets of both families lost (target specific)
 *  isp      – CMTS fine but both families down and no provider hop answers, or native IPv6 down
 *             while IPv4 (tunnelled to the AFTR) works
 *  unknown  – the deciding layer was not measured (e.g. CMTS address not discovered yet)
 * Single lost replies of a layer with several members never decide (ICMP deprioritisation).
 */
export function classifyOutageRound(r: OutageRound): OutageClass {
  if (r.linkIssue) return 'client';
  if (down(r.lanLost, r.lanOk)) return 'lan';
  const beyondCmtsOk = r.internetOk.length > 0 || r.providerOk > 0;
  if (down(r.isp6Lost, r.isp6Ok) && !beyondCmtsOk) return 'docsis';
  const v4Down = down(r.v4Lost, r.v4Ok);
  const v6Down = down(r.v6Lost, r.v6Ok);
  if (v4Down && r.v6Ok > 0) return 'aftr';
  if (v4Down && v6Down) {
    if (r.providerOk > 0) return 'internet';
    if (r.isp6Ok > 0) return 'isp';
    return 'unknown';
  }
  if (v6Down && r.v4Ok > 0) return 'isp';
  // one family down while the other one has no data → cannot localise
  if (v4Down || v6Down) return 'unknown';
  return 'internet';
}

export type OutageVotes = Partial<Record<OutageClass, number>>;

/** Majority of the known classes ('unknown' only when no round could be localised); ties → closest layer. */
export function majorityClass(votes: OutageVotes): OutageClass {
  let best: OutageClass = 'unknown';
  let n = 0;
  for (const c of OUTAGE_CLASS_ORDER) {
    if (c === 'unknown') continue;
    const v = votes[c] ?? 0;
    if (v > n) {
      best = c;
      n = v;
    }
  }
  return best;
}

export interface OutageInfo {
  /** first lost round */
  startTs: number;
  classification: OutageClass;
  /** classification at detection time (from the first outageMinSec rounds) */
  initialClassification: OutageClass;
  /** lost rounds so far */
  rounds: number;
  votes: OutageVotes;
  /** targets lost in at least one outage round */
  lostTargets: string[];
  /** last successful round before the outage (estimated as startTs − interval after a data gap) */
  lastSuccessTs: number;
}

export interface FinishedOutage extends OutageInfo {
  /** next successful round, or lastLostTs + interval when interrupted */
  endTs: number;
  /** next success − last success − interval (interrupted: lower bound from the observed rounds) */
  durationMs: number;
  nextSuccessTs: number | null;
  /** ended by an engine gap / session stop instead of a successful round */
  interrupted: boolean;
}

export interface OutageSinks {
  onStart(o: OutageInfo): void;
  onEnd(o: FinishedOutage): void;
}

export interface OutageDetectorOptions {
  /** consecutive lost rounds needed (config thresholds.outageMinSec, read fresh) */
  minRounds: () => number;
  intervalMs?: number;
  /** larger tick gaps break the "consecutive rounds" requirement, default 2500 ms */
  maxRoundGapMs?: number;
  /** how long finished outage spans are kept for loss-burst suppression, default 10 min */
  keepSpansMs?: number;
}

interface ActiveOutage {
  startTs: number;
  lastLostTs: number;
  lastSuccessTs: number;
  rounds: number;
  votes: OutageVotes;
  initial: OutageClass;
  lost: Set<string>;
}

export class OutageDetector {
  private lastSuccessTs: number | null = null;
  private pending: OutageRound[] = [];
  private active: ActiveOutage | null = null;
  private spans: { from: number; to: number; targets: Set<string> }[] = [];
  private readonly intervalMs: number;
  private readonly maxRoundGapMs: number;
  private readonly keepSpansMs: number;

  constructor(private readonly sinks: OutageSinks, private readonly opts: OutageDetectorOptions) {
    this.intervalMs = opts.intervalMs ?? 1000;
    this.maxRoundGapMs = opts.maxRoundGapMs ?? 2500;
    this.keepSpansMs = opts.keepSpansMs ?? 10 * 60_000;
  }

  get isActive(): boolean {
    return this.active !== null;
  }

  /** current outage (null when none is active) */
  get current(): OutageInfo | null {
    return this.active ? this.info(this.active) : null;
  }

  /** feed rounds in ascending ts order */
  process(r: OutageRound): void {
    if (isOutageRound(r)) {
      if (this.active) {
        this.addToActive(this.active, r);
        return;
      }
      if (r.load) {
        // saturated line (speed test): ICMP drops are self-inflicted, never start an outage here
        this.pending = [];
        return;
      }
      const last = this.pending[this.pending.length - 1];
      if (last && r.ts - last.ts > this.maxRoundGapMs) this.pending = [];
      this.pending.push(r);
      if (this.pending.length >= Math.max(1, Math.round(this.opts.minRounds()))) this.activate();
      return;
    }
    if (!isSuccessRound(r)) return; // no internet data in this round → neutral
    if (this.active) this.finish(r.ts, false);
    this.pending = [];
    this.lastSuccessTs = r.ts;
  }

  /** engine gap / session stop: close an active outage as interrupted, forget partial state */
  interrupt(): void {
    if (this.active) this.finish(null, true);
    this.pending = [];
    this.lastSuccessTs = null;
  }

  /** true if the target was lost during an outage that overlaps [from, to] (incl. an active one) */
  overlaps(targetId: string, from: number, to: number): boolean {
    const a = this.active;
    if (a && a.lost.has(targetId) && from <= a.lastLostTs + this.intervalMs && to >= a.startTs) return true;
    return this.spans.some((s) => s.targets.has(targetId) && from <= s.to && to >= s.from);
  }

  private addToActive(a: ActiveOutage, r: OutageRound): void {
    a.rounds++;
    a.lastLostTs = r.ts;
    const cls = classifyOutageRound(r);
    a.votes[cls] = (a.votes[cls] ?? 0) + 1;
    for (const id of r.lostTargets) a.lost.add(id);
  }

  private activate(): void {
    const rounds = this.pending;
    this.pending = [];
    const first = rounds[0];
    const votes: OutageVotes = {};
    const lost = new Set<string>();
    for (const r of rounds) {
      const cls = classifyOutageRound(r);
      votes[cls] = (votes[cls] ?? 0) + 1;
      for (const id of r.lostTargets) lost.add(id);
    }
    // a success long before the outage (data gap in between) is no meaningful bound
    const bound = first.ts - this.intervalMs;
    const lastSuccessTs =
      this.lastSuccessTs !== null && this.lastSuccessTs >= bound - this.maxRoundGapMs ? Math.min(this.lastSuccessTs, bound) : bound;
    const initial = majorityClass(votes);
    this.active = {
      startTs: first.ts,
      lastLostTs: rounds[rounds.length - 1].ts,
      lastSuccessTs,
      rounds: rounds.length,
      votes,
      initial,
      lost,
    };
    this.sinks.onStart(this.info(this.active));
  }

  private info(a: ActiveOutage): OutageInfo {
    return {
      startTs: a.startTs,
      classification: majorityClass(a.votes),
      initialClassification: a.initial,
      rounds: a.rounds,
      votes: { ...a.votes },
      lostTargets: [...a.lost].sort(),
      lastSuccessTs: a.lastSuccessTs,
    };
  }

  private finish(nextSuccessTs: number | null, interrupted: boolean): void {
    const a = this.active;
    if (!a) return;
    this.active = null;
    // interrupted: the outage lasted at least until the end of its last observed round
    const endTs = nextSuccessTs ?? a.lastLostTs + this.intervalMs;
    const durationMs = Math.max(0, endTs - a.lastSuccessTs - this.intervalMs);
    this.spans.push({ from: a.startTs, to: endTs, targets: new Set(a.lost) });
    this.spans = this.spans.filter((s) => endTs - s.to <= this.keepSpansMs);
    this.sinks.onEnd({ ...this.info(a), endTs, durationMs, nextSuccessTs, interrupted });
  }
}
