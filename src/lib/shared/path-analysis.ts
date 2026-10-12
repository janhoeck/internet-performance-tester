// Path discovery / MTR interpretation helpers (pure, shared by engine and UI).
// Background: docs/research/methodology.md §7 (Steenbergen rules, pathping attribution, time-correlated
// propagation test). A hop's own loss/latency is often cosmetic (ICMP generation on the router's slow
// path, rate limiting); only what persists up to the destination is real.
import { fmtNumber } from './format';
import { expandIPv6, isGlobalV6, isIPv6, isPublicV4, normalizeIp, sameIp } from './net';
import { median, summarize } from './stats';
import type { IpFamily, MtrStats, TraceHop } from './types';

// ─── Probe results → hops ──────────────────────────────────────────────────

/**
 * Normalized outcome of one TTL-limited echo probe.
 *  ttl-expired – an intermediate router answered (ICMP time exceeded)
 *  reply       – the destination answered (echo reply)
 *  unreachable – a router answered "destination unreachable" (path ends there)
 *  lost        – no answer within the timeout
 *  error       – local failure (no route, send error, answer from our own address …)
 */
export type HopProbeKind = 'ttl-expired' | 'reply' | 'unreachable' | 'lost' | 'error';

export interface HopProbe {
  ttl: number;
  /** 1-based round index (all TTLs of a round are probed together) */
  round: number;
  from: string | null;
  /** round-trip time in ms (Stopwatch), null when lost */
  rttMs: number | null;
  kind: HopProbeKind;
}

export function probeAnswered(p: HopProbe): boolean {
  return (p.kind === 'ttl-expired' || p.kind === 'reply' || p.kind === 'unreachable') && p.from !== null;
}

function mostCommon(values: readonly string[]): string | null {
  const counts = new Map<string, { ip: string; n: number; first: number }>();
  values.forEach((v, i) => {
    const key = normalizeIp(v);
    const c = counts.get(key);
    if (c) c.n++;
    else counts.set(key, { ip: v, n: 1, first: i });
  });
  let best: { ip: string; n: number; first: number } | null = null;
  for (const c of counts.values()) {
    if (!best || c.n > best.n || (c.n === best.n && c.first < best.first)) best = c;
  }
  return best ? best.ip : null;
}

function mean(values: readonly number[]): number | null {
  return values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

function groupByTtl(probes: readonly HopProbe[]): Map<number, HopProbe[]> {
  const byTtl = new Map<number, HopProbe[]>();
  for (const p of probes) {
    const list = byTtl.get(p.ttl);
    if (list) list.push(p);
    else byTtl.set(p.ttl, [p]);
  }
  for (const list of byTtl.values()) list.sort((a, b) => a.round - b.round);
  return byTtl;
}

export interface BuiltPath {
  hops: TraceHop[];
  /** destination answered */
  reached: boolean;
  /** smallest TTL with a terminal answer (destination reply or router "unreachable") */
  terminalTtl: number | null;
  terminal: 'reply' | 'unreachable' | null;
}

/**
 * Build TraceHop rows from TTL probe results (path discovery). Hops end at the first terminal TTL;
 * when the destination was not reached, trailing silent hops are trimmed to `silentTail` rows after
 * the last responding hop (they carry no information besides "nothing answers beyond hop X").
 */
export function buildTraceHops(
  probes: readonly HopProbe[],
  opts: { silentTail?: number } = {},
): BuiltPath {
  const byTtl = groupByTtl(probes);
  let terminalTtl: number | null = null;
  let terminal: BuiltPath['terminal'] = null;
  for (const [ttl, list] of byTtl) {
    const hasReply = list.some((p) => p.kind === 'reply' && p.from !== null);
    const hasUnreach = list.some((p) => p.kind === 'unreachable' && p.from !== null);
    if (!hasReply && !hasUnreach) continue;
    if (terminalTtl === null || ttl < terminalTtl) {
      terminalTtl = ttl;
      terminal = hasReply ? 'reply' : 'unreachable';
    }
  }
  const probed = [...byTtl.keys()];
  const maxProbed = probed.length > 0 ? Math.max(...probed) : 0;
  let last = terminalTtl ?? maxProbed;
  if (terminalTtl === null) {
    let lastResp = 0;
    for (const [ttl, list] of byTtl) if (list.some(probeAnswered)) lastResp = Math.max(lastResp, ttl);
    last = Math.min(maxProbed, lastResp + (opts.silentTail ?? 2));
  }
  const hops: TraceHop[] = [];
  for (let ttl = 1; ttl <= last; ttl++) {
    const list = byTtl.get(ttl) ?? [];
    const rtts = list.map((p) => (probeAnswered(p) ? p.rttMs : null));
    const answered = list.filter(probeAnswered);
    const ok = rtts.filter((r): r is number => r !== null);
    hops.push({
      hop: ttl,
      ip: mostCommon(answered.map((p) => p.from as string)),
      rtts,
      lossPct: rtts.length > 0 ? ((rtts.length - ok.length) / rtts.length) * 100 : 100,
      avgMs: mean(ok),
    });
  }
  return { hops, reached: terminal === 'reply', terminalTtl, terminal };
}

/** Per-hop MTR statistics from round-aligned RTTs (null = lost). */
export function mtrStatsFromRtts(rtts: readonly (number | null)[]): MtrStats {
  const s = summarize(rtts);
  return {
    sent: s.sent,
    lost: s.lost,
    lossPct: s.sent > 0 ? (s.lost / s.sent) * 100 : 0,
    avgMs: s.avg,
    minMs: s.min,
    maxMs: s.max,
    jitterMs: s.jitter,
  };
}

/**
 * Merge MTR probe results (TTL-limited probes, `rounds` rounds) into the hops of the base path.
 * `rtts` of probed hops are round-aligned (index r-1 = round r) so per-round correlation can be
 * recomputed later from the stored row. Hops that were not probed keep the base data (`mtr` null).
 */
export function buildMtrHops(base: readonly TraceHop[], probes: readonly HopProbe[], rounds: number): TraceHop[] {
  const byTtl = groupByTtl(probes);
  return base.map((h) => {
    const list = (byTtl.get(h.hop) ?? []).filter((p) => p.round >= 1 && p.round <= rounds);
    if (list.length === 0) return { ...h, rtts: [...h.rtts], mtr: null };
    // rounds that were actually executed for this TTL (a killed run may end early)
    const executed = Math.max(...list.map((p) => p.round));
    const rtts: (number | null)[] = new Array<number | null>(executed).fill(null);
    for (const p of list) rtts[p.round - 1] = probeAnswered(p) ? p.rttMs : null;
    const stats = mtrStatsFromRtts(rtts);
    const responder = mostCommon(list.filter(probeAnswered).map((p) => p.from as string));
    return { hop: h.hop, ip: responder ?? h.ip, rtts, lossPct: stats.lossPct, avgMs: stats.avgMs, mtr: stats };
  });
}

// ─── Path identity & route changes ─────────────────────────────────────────

export function respondingHops(hops: readonly TraceHop[]): { hop: number; ip: string }[] {
  return hops.filter((h): h is TraceHop & { ip: string } => h.ip !== null).map((h) => ({ hop: h.hop, ip: h.ip }));
}

/** Canonical string of the responding hops ("1=192.168.0.1|3=92.79.214.92|…"), input of pathHash. */
export function pathSignature(hops: readonly TraceHop[]): string {
  return respondingHops(hops)
    .map((h) => `${h.hop}=${normalizeIp(h.ip)}`)
    .join('|');
}

export interface PathLike {
  hops: readonly TraceHop[];
  reached: boolean;
}

export interface PathDiff {
  hop: number;
  before: string | null;
  after: string | null;
}

export interface PathComparison {
  changed: boolean;
  diffs: PathDiff[];
  /** hop count to the destination changed (both traces reached it) */
  lengthChanged: boolean;
  prevLength: number | null;
  curLength: number | null;
}

function seenAt(paths: readonly PathLike[], hop: number, ip: string): boolean {
  return paths.some((p) => p.hops.some((h) => h.hop === hop && h.ip !== null && sameIp(h.ip, ip)));
}

/**
 * Tolerant route-change detection. Silent hops (ICMP rate limiting) never count as a change; a hop
 * counts only when both traces have a responder at the same TTL and the addresses differ. Addresses
 * already seen at that TTL in `history` (recent traces) are treated as known alternates (ECMP), as
 * are destination distances seen before.
 */
export function comparePaths(prev: PathLike, cur: PathLike, history: readonly PathLike[] = []): PathComparison {
  const diffs: PathDiff[] = [];
  for (const h of cur.hops) {
    if (h.ip === null) continue;
    const before = prev.hops.find((p) => p.hop === h.hop);
    if (!before || before.ip === null || sameIp(before.ip, h.ip)) continue;
    if (seenAt(history, h.hop, h.ip)) continue;
    diffs.push({ hop: h.hop, before: before.ip, after: h.ip });
  }
  const prevLength = prev.reached && prev.hops.length > 0 ? prev.hops[prev.hops.length - 1].hop : null;
  const curLength = cur.reached && cur.hops.length > 0 ? cur.hops[cur.hops.length - 1].hop : null;
  let lengthChanged = prevLength !== null && curLength !== null && prevLength !== curLength;
  if (lengthChanged) {
    const known = history.some((p) => p.reached && p.hops.length > 0 && p.hops[p.hops.length - 1].hop === curLength);
    if (known) lengthChanged = false;
  }
  return { changed: diffs.length > 0 || lengthChanged, diffs, lengthChanged, prevLength, curLength };
}

// ─── Dynamic hosts ($isp4 / $isp6) ─────────────────────────────────────────

function interfaceId(ip: string): string | null {
  const g = expandIPv6(ip);
  return g ? g.slice(4).join(':') : null;
}

/**
 * True if `ip` belongs to the home router: equal to one of the known router addresses or – for
 * IPv6 – sharing the 64-bit interface identifier with one of them (the router's GUA on the LAN and
 * its link-local address are both derived from the same MAC, e.g. …:de73:6ff:fe12:34df).
 */
export function isRouterAddress(ip: string, routerIps: readonly (string | null | undefined)[]): boolean {
  for (const r of routerIps) {
    if (!r) continue;
    if (sameIp(ip, r)) return true;
    if (isIPv6(ip) && isIPv6(r)) {
      const a = interfaceId(ip);
      const b = interfaceId(r);
      if (a && b && a === b && a !== '0000:0000:0000:0000' && a !== '0000:0000:0000:0001') return true;
    }
  }
  return false;
}

/**
 * First responding hop ≥ 2 with a public IPv4 / global IPv6 that is neither the router nor the
 * destination: `$isp4` (IPv4 hop 2 = DS-Lite AFTR never answers → today hop 3) and `$isp6`
 * (≈ CMTS, today IPv6 hop 2).
 */
export function pickIspHop(
  hops: readonly TraceHop[],
  family: IpFamily,
  target: string,
  routerIps: readonly (string | null | undefined)[],
): { hop: number; ip: string } | null {
  const hop1 = hops.find((h) => h.hop === 1)?.ip ?? null;
  const routers = [...routerIps, hop1];
  for (const h of respondingHops(hops)) {
    if (h.hop < 2) continue;
    if (sameIp(h.ip, target)) continue;
    const ok = family === 4 ? isPublicV4(h.ip) : isGlobalV6(h.ip);
    if (!ok || isRouterAddress(h.ip, routers)) continue;
    return h;
  }
  return null;
}

/**
 * Stable choice of a dynamic ISP host. Keeps the current host while it is still on the path (or
 * only silent in the latest trace but seen in recent ones) so the probe series does not flip when
 * a rate-limited hop misses one discovery; switches when the route really changed.
 * `recent` = recent discovery hop lists, oldest first, latest last.
 */
export function chooseIspHost(
  current: string | null,
  recent: readonly (readonly TraceHop[])[],
  family: IpFamily,
  target: string,
  routerIps: readonly (string | null | undefined)[],
): string | null {
  if (recent.length === 0) return current;
  const latest = recent[recent.length - 1];
  const candidate = pickIspHop(latest, family, target, routerIps);
  if (!current) return candidate ? candidate.ip : null;
  const curHop = latest.find((h) => h.ip !== null && h.hop >= 2 && sameIp(h.ip, current));
  if (curHop) {
    // a closer qualifying hop replaces the current one only if it answered in ≥ 2 recent traces
    if (candidate && candidate.hop < curHop.hop) {
      const seen = recent.filter((p) => p.some((h) => h.hop === candidate.hop && h.ip !== null && sameIp(h.ip, candidate.ip)));
      if (seen.length >= 2) return candidate.ip;
    }
    return current;
  }
  // current host silent in the latest trace: keep it if seen recently at a TTL that is silent now
  for (let i = recent.length - 2; i >= 0; i--) {
    const at = recent[i].find((h) => h.ip !== null && sameIp(h.ip, current));
    if (!at) continue;
    const now = latest.find((h) => h.hop === at.hop);
    if (!now || now.ip === null) return current;
    break; // another address answers at that TTL → route changed
  }
  return candidate ? candidate.ip : current;
}

// ─── pathping-style attribution (methodology.md §7.2) ──────────────────────

export interface HopMeasure {
  hop: number;
  /** source → hop loss in %, null when the hop never answered (unknown, not 100 %) */
  lossPct: number | null;
  /** median RTT in ms, null when unknown */
  rttMs: number | null;
}

export interface HopAttribution extends HopMeasure {
  /** min loss of this and all later hops = loss that really reaches this point */
  persistentLoss: number | null;
  /** loss introduced on the link(s) into this hop */
  linkLoss: number | null;
  /** cosmetic loss of the router itself (ICMP rate limiting / control plane) */
  nodeLoss: number | null;
  persistentRtt: number | null;
  /** latency added on the link(s) into this hop (persists to later hops) */
  addedRtt: number | null;
  /** cosmetic extra latency of the router itself (slow ICMP generation) */
  nodeRtt: number | null;
}

function minFrom(values: readonly (number | null)[], i: number): number | null {
  let m: number | null = null;
  for (let j = i; j < values.length; j++) {
    const v = values[j];
    if (v !== null && (m === null || v < m)) m = v;
  }
  return m;
}

function prevKnown(values: readonly (number | null)[], i: number): number {
  for (let j = i - 1; j >= 0; j--) if (values[j] !== null) return j;
  return -1;
}

/** min_{j ≥ i} L_j over hops with known loss (array index, hops ordered by TTL). */
export function persistentLoss(hops: readonly HopMeasure[], i: number): number | null {
  if (hops[i]?.lossPct == null) return null;
  return minFrom(hops.map((h) => h.lossPct), i);
}

/** persistentLoss(i) − persistentLoss(previous known hop); the first known hop compares to 0. */
export function linkLoss(hops: readonly HopMeasure[], i: number): number | null {
  const pl = persistentLoss(hops, i);
  if (pl === null) return null;
  const p = prevKnown(hops.map((h) => h.lossPct), i);
  const before = p >= 0 ? (persistentLoss(hops, p) ?? 0) : 0;
  return Math.max(0, pl - before);
}

/** L_i − persistentLoss(i): loss that does not continue to later hops. */
export function nodeLoss(hops: readonly HopMeasure[], i: number): number | null {
  const l = hops[i]?.lossPct;
  const pl = persistentLoss(hops, i);
  return l == null || pl === null ? null : Math.max(0, l - pl);
}

/** min_{j ≥ i} R_j over hops with a known median RTT. */
export function persistentRtt(hops: readonly HopMeasure[], i: number): number | null {
  if (hops[i]?.rttMs == null) return null;
  return minFrom(hops.map((h) => h.rttMs), i);
}

/** persistentRtt(i) − persistentRtt(previous known hop); the first known hop compares to 0. */
export function addedRtt(hops: readonly HopMeasure[], i: number): number | null {
  const pr = persistentRtt(hops, i);
  if (pr === null) return null;
  const p = prevKnown(hops.map((h) => h.rttMs), i);
  const before = p >= 0 ? (persistentRtt(hops, p) ?? 0) : 0;
  return Math.max(0, pr - before);
}

/** R_i − persistentRtt(i): latency that does not continue to later hops. */
export function nodeRtt(hops: readonly HopMeasure[], i: number): number | null {
  const r = hops[i]?.rttMs;
  const pr = persistentRtt(hops, i);
  return r == null || pr === null ? null : Math.max(0, r - pr);
}

export function attributeHops(hops: readonly HopMeasure[]): HopAttribution[] {
  return hops.map((h, i) => ({
    ...h,
    persistentLoss: persistentLoss(hops, i),
    linkLoss: linkLoss(hops, i),
    nodeLoss: nodeLoss(hops, i),
    persistentRtt: persistentRtt(hops, i),
    addedRtt: addedRtt(hops, i),
    nodeRtt: nodeRtt(hops, i),
  }));
}

/**
 * Loss and median RTT per hop. Hops probed by an MTR pass (`mtr` set) always have a known loss
 * (also 100 % – e.g. a broken path); hops that never answered a discovery are unknown (null),
 * as their silence is usually ICMP filtering (e.g. the DS-Lite AFTR), not loss.
 * Note: discovery rows carry only 3 probes per hop – their loss figures are coarse.
 */
export function hopMeasures(hops: readonly TraceHop[]): HopMeasure[] {
  return [...hops]
    .sort((a, b) => a.hop - b.hop)
    .map((h) => {
      const ok = h.rtts.filter((r): r is number => r !== null && Number.isFinite(r));
      const mtr = h.mtr && h.mtr.sent > 0 ? h.mtr : null;
      const known = mtr !== null || (h.ip !== null && ok.length > 0);
      return {
        hop: h.hop,
        lossPct: known ? (mtr ? mtr.lossPct : h.lossPct) : null,
        rttMs: ok.length > 0 ? median(ok) : null,
      };
    });
}

// ─── Time-correlated propagation test (methodology.md §7.2) ───────────────

/** Per-round event flags: lost, or RTT ≥ median + spikeDeltaMs. */
export function roundEvents(rtts: readonly (number | null)[], spikeDeltaMs = 25): boolean[] {
  const ok = rtts.filter((r): r is number => r !== null);
  const med = median(ok);
  return rtts.map((r) => r === null || (med !== null && r >= med + spikeDeltaMs));
}

/** Share of hop events that co-occur with a destination event in the same round (± tolerance). */
export function propagationShare(
  hopEvents: readonly boolean[],
  destEvents: readonly boolean[],
  toleranceRounds = 1,
): { events: number; propagated: number; share: number | null } {
  let events = 0;
  let propagated = 0;
  for (let i = 0; i < hopEvents.length; i++) {
    if (!hopEvents[i]) continue;
    events++;
    for (let k = Math.max(0, i - toleranceRounds); k <= Math.min(destEvents.length - 1, i + toleranceRounds); k++) {
      if (destEvents[k]) {
        propagated++;
        break;
      }
    }
  }
  return { events, propagated, share: events > 0 ? propagated / events : null };
}

export type Propagation = 'real' | 'cosmetic' | 'inconclusive';

/** ≥ 70 % co-occurrence at the destination = real (data plane), ≤ 20 % = cosmetic (control plane). */
export function classifyPropagation(share: number | null, realMin = 0.7, cosmeticMax = 0.2): Propagation | null {
  if (share === null) return null;
  if (share >= realMin) return 'real';
  if (share <= cosmeticMax) return 'cosmetic';
  return 'inconclusive';
}

/**
 * Share of rounds whose ±tolerance window contains a destination event = the co-occurrence a hop
 * with randomly placed events would reach by chance (high when the destination itself is noisy).
 */
export function chanceShare(destEvents: readonly boolean[], toleranceRounds = 1): number | null {
  if (destEvents.length === 0) return null;
  let covered = 0;
  for (let i = 0; i < destEvents.length; i++) {
    for (let k = Math.max(0, i - toleranceRounds); k <= Math.min(destEvents.length - 1, i + toleranceRounds); k++) {
      if (destEvents[k]) {
        covered++;
        break;
      }
    }
  }
  return covered / destEvents.length;
}

/** a 'real' verdict needs this much co-occurrence above the chance level */
export const PROPAGATION_MIN_LIFT = 0.15;
/** fewer hop events than this never yield a verdict (one event proves nothing) */
export const PROPAGATION_MIN_EVENTS = 2;

export interface HopPropagation {
  hop: number;
  ip: string | null;
  events: number;
  propagated: number;
  share: number | null;
  /** co-occurrence expected by chance (destination event coverage), see chanceShare() */
  chance: number | null;
  verdict: Propagation | null;
}

/**
 * Propagation verdict per intermediate hop of an MTR row (round-aligned `rtts`), using the
 * destination (last hop, must have answered) as reference. Empty when there is no reference.
 * Thresholds per classifyPropagation(); additionally a hop needs ≥ 2 events for any verdict, and
 * 'real' becomes 'inconclusive' when the share is not clearly above chance (a jittery destination
 * co-occurs with almost everything – seen live: 45 % ICMP rate limiting at a Cloudflare hop).
 */
export function hopPropagation(hops: readonly TraceHop[], spikeDeltaMs = 25, toleranceRounds = 1): HopPropagation[] {
  const sorted = [...hops].sort((a, b) => a.hop - b.hop);
  const dest = sorted[sorted.length - 1];
  if (!dest || dest.ip === null || dest.rtts.length === 0) return [];
  const destEvents = roundEvents(dest.rtts, spikeDeltaMs);
  const chance = chanceShare(destEvents, toleranceRounds);
  return sorted.slice(0, -1).filter((h) => h.ip !== null && h.rtts.length > 0).map((h) => {
    const p = propagationShare(roundEvents(h.rtts, spikeDeltaMs), destEvents, toleranceRounds);
    let verdict = p.events >= PROPAGATION_MIN_EVENTS ? classifyPropagation(p.share) : p.events > 0 ? 'inconclusive' : null;
    if (verdict === 'real' && p.share !== null && chance !== null && p.share - chance < PROPAGATION_MIN_LIFT) verdict = 'inconclusive';
    return { hop: h.hop, ip: h.ip, ...p, chance, verdict };
  });
}

// ─── Interpretation (German texts for UI/report) ──────────────────────────

export type PathFindingKind = 'link-loss' | 'node-loss' | 'added-latency' | 'node-latency';

export interface PathFinding {
  hop: number;
  ip: string | null;
  kind: PathFindingKind;
  /** % for loss findings, ms for latency findings */
  value: number;
  text: string;
}

export interface PathInterpretation {
  attribution: HopAttribution[];
  findings: PathFinding[];
  /** hop at which loss that persists to the destination begins (null = none) */
  lossStartsAt: number | null;
  destinationLossPct: number | null;
  summary: string;
}

export interface InterpretOptions {
  /** loss below this is ignored (default 10 % = two lost probes of 20; one probe would be noise) */
  minLossPct?: number;
  /** persistent latency step worth mentioning */
  minAddedRttMs?: number;
  /** cosmetic router latency worth mentioning */
  minNodeRttMs?: number;
}

const pct = (v: number) => `${fmtNumber(v, v < 10 && v % 1 !== 0 ? 1 : 0)} %`;
const ms = (v: number) => `${fmtNumber(v, v < 10 ? 1 : 0)} ms`;
const hopLabel = (hop: number, ip: string | null) => (ip ? `Hop ${hop} (${ip})` : `Hop ${hop}`);

/** Steenbergen/pathping interpretation of a trace or MTR row with German findings. */
export function interpretPath(hops: readonly TraceHop[], reached: boolean, opts: InterpretOptions = {}): PathInterpretation {
  const minLoss = opts.minLossPct ?? 10;
  const minAdded = opts.minAddedRttMs ?? 20;
  const minNode = opts.minNodeRttMs ?? 30;
  const sorted = [...hops].sort((a, b) => a.hop - b.hop);
  const measures = hopMeasures(sorted);
  const attribution = attributeHops(measures);
  const ipOf = (hop: number) => sorted.find((h) => h.hop === hop)?.ip ?? null;
  const findings: PathFinding[] = [];
  let lossStartsAt: number | null = null;

  for (let i = 0; i < attribution.length; i++) {
    const a = attribution[i];
    const ip = ipOf(a.hop);
    if (a.linkLoss !== null && a.linkLoss >= minLoss) {
      if (lossStartsAt === null) lossStartsAt = a.hop;
      const prev = prevKnown(attribution.map((x) => x.lossPct), i);
      const from = prev >= 0 ? `Hop ${attribution[prev].hop}` : 'deinem PC';
      findings.push({
        hop: a.hop, ip, kind: 'link-loss', value: a.linkLoss,
        text: `Echter Verlust zwischen ${from} und ${hopLabel(a.hop, ip)}: ${pct(a.linkLoss)} – bleibt bis zum Ziel bestehen.`,
      });
    }
    if (a.nodeLoss !== null && a.nodeLoss >= minLoss) {
      findings.push({
        hop: a.hop, ip, kind: 'node-loss', value: a.nodeLoss,
        text: `${hopLabel(a.hop, ip)} beantwortet ${pct(a.nodeLoss)} der Pakete nicht, spätere Hops schon – ICMP-Ratenbegrenzung des Routers, kein echter Verlust.`,
      });
    }
    if (a.addedRtt !== null && a.addedRtt >= minAdded && i > 0) {
      findings.push({
        hop: a.hop, ip, kind: 'added-latency', value: a.addedRtt,
        text: `Ab ${hopLabel(a.hop, ip)} kommen ${ms(a.addedRtt)} Laufzeit hinzu, die bis zum Ziel bestehen bleiben.`,
      });
    }
    if (a.nodeRtt !== null && a.nodeRtt >= minNode) {
      findings.push({
        hop: a.hop, ip, kind: 'node-latency', value: a.nodeRtt,
        text: `${hopLabel(a.hop, ip)} antwortet ${ms(a.nodeRtt)} langsamer als spätere Hops – kosmetisch (langsame ICMP-Antwort des Routers).`,
      });
    }
  }

  const known = attribution.filter((a) => a.lossPct !== null);
  const destinationLossPct = reached && known.length > 0 ? known[known.length - 1].lossPct : null;
  let summary: string;
  if (known.length === 0) {
    summary = 'Keine Hop-Antworten – der Pfad ist nicht auswertbar.';
  } else if (lossStartsAt !== null) {
    summary = `Echter Paketverlust beginnt bei ${hopLabel(lossStartsAt, ipOf(lossStartsAt))} und bleibt bis zum Ziel bestehen${
      destinationLossPct !== null ? ` (Ziel: ${pct(destinationLossPct)})` : ''
    }.`;
  } else if (reached) {
    const cosmetic = findings.filter((f) => f.kind === 'node-loss' || f.kind === 'node-latency').length;
    summary = cosmetic > 0
      ? 'Kein durchgehender Verlust bis zum Ziel – Auffälligkeiten einzelner Hops sind kosmetisch.'
      : 'Kein durchgehender Verlust bis zum Ziel.';
  } else {
    const lastResp = [...sorted].reverse().find((h) => h.ip !== null);
    summary = lastResp
      ? `Ziel nicht erreicht – letzter antwortender Knoten: ${hopLabel(lastResp.hop, lastResp.ip)}.`
      : 'Ziel nicht erreicht.';
  }
  return { attribution, findings, lossStartsAt, destinationLossPct, summary };
}
