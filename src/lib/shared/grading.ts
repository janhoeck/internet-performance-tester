// Speed test evaluation: bufferbloat grade (Waveform scale), throughput from byte samples,
// loaded-latency statistics, bottleneck (queue) localization and the "limited by link" check.
// docs/research/methodology.md §9, docs/ARCHITECTURE.md §4.8.
// Pure functions without Node built-ins – usable by the engine, API routes and client components.
import { fmtMbps, fmtNumber, isNum } from './format';
import { summarize } from './stats';
import type { BufferbloatGrade, Health, Segment, SpeedtestResult } from './types';

// ─── Bufferbloat grade ─────────────────────────────────────────────────────

/** Waveform scale: a latency increase under load strictly below `belowMs` earns `grade`. */
export const BUFFERBLOAT_SCALE: readonly { grade: BufferbloatGrade; belowMs: number }[] = [
  { grade: 'A+', belowMs: 5 },
  { grade: 'A', belowMs: 30 },
  { grade: 'B', belowMs: 60 },
  { grade: 'C', belowMs: 200 },
  { grade: 'D', belowMs: 400 },
  { grade: 'F', belowMs: Number.POSITIVE_INFINITY },
];

/** Best to worst. */
export const GRADES: readonly BufferbloatGrade[] = ['A+', 'A', 'B', 'C', 'D', 'F'];

/**
 * Grade for a latency increase under load (ms): A+ < 5, A < 30, B < 60, C < 200, D < 400, F ≥ 400.
 * Negative increases (loaded faster than idle – noise) count as A+. null/NaN → null.
 */
export function bufferbloatGrade(increaseMs: number | null | undefined): BufferbloatGrade | null {
  if (!isNum(increaseMs)) return null;
  for (const step of BUFFERBLOAT_SCALE) {
    if (increaseMs < step.belowMs) return step.grade;
  }
  return 'F';
}

export interface GradeInfo {
  /** short German label, e.g. 'Sehr gut' */
  label: string;
  health: Health;
  /** German one-liner for the UI */
  text: string;
}

/** Health follows config.thresholds.bufferbloat (good < 30 ms, warn < 60 ms). */
export const GRADE_INFO: Record<BufferbloatGrade, GradeInfo> = {
  'A+': {
    label: 'Hervorragend',
    health: 'good',
    text: 'Kaum zusätzliche Verzögerung unter Last – ideal für Online-Spiele.',
  },
  A: {
    label: 'Sehr gut',
    health: 'good',
    text: 'Geringe zusätzliche Verzögerung unter Last – Spiele bleiben flüssig.',
  },
  B: {
    label: 'Gut',
    health: 'warn',
    text: 'Spürbare Verzögerung unter Last – meist noch spielbar.',
  },
  C: {
    label: 'Mäßig',
    health: 'bad',
    text: 'Deutliche Verzögerung unter Last – Lags, sobald die Leitung ausgelastet ist.',
  },
  D: {
    label: 'Schlecht',
    health: 'bad',
    text: 'Starke Verzögerung unter Last – Spielen neben Downloads/Uploads kaum möglich.',
  },
  F: {
    label: 'Sehr schlecht',
    health: 'bad',
    text: 'Extreme Verzögerung unter Last – bei Auslastung ist die Leitung praktisch unbenutzbar.',
  },
};

export function gradeLabel(grade: BufferbloatGrade | null | undefined): string {
  return grade ? GRADE_INFO[grade].label : 'unbekannt';
}

export function gradeHealth(grade: BufferbloatGrade | null | undefined): Health {
  return grade ? GRADE_INFO[grade].health : 'unknown';
}

/** 0 (A+) … 5 (F); -1 for null. */
export function gradeRank(grade: BufferbloatGrade | null | undefined): number {
  return grade ? GRADES.indexOf(grade) : -1;
}

/** true if `grade` is `ref` or worse (e.g. R04: "Note ≤ C" → gradeAtLeastAsBadAs(g, 'C')). */
export function gradeAtLeastAsBadAs(grade: BufferbloatGrade | null | undefined, ref: BufferbloatGrade): boolean {
  return grade ? gradeRank(grade) >= gradeRank(ref) : false;
}

// ─── Throughput ────────────────────────────────────────────────────────────

/** Bytes transferred at time `t` (ms, any common monotonic base – e.g. ms since test start). */
export interface ByteSample {
  t: number;
  bytes: number;
}

/** Ramp-up at the start of each load phase that is ignored (TCP slow start, queue build-up). */
export const LOAD_RAMP_MS = 3000;
/** Minimum stable window; shorter phases fall back to their second half. */
export const MIN_STABLE_WINDOW_MS = 1000;

/** Mbit/s of all samples with fromMs ≤ t < toMs. null for an empty/invalid window. */
export function throughputMbps(samples: readonly ByteSample[], fromMs: number, toMs: number): number | null {
  const durationMs = toMs - fromMs;
  if (!(durationMs > 0) || !Number.isFinite(durationMs)) return null;
  let bytes = 0;
  for (const s of samples) {
    if (s.t >= fromMs && s.t < toMs) bytes += s.bytes;
  }
  return (bytes * 8) / (durationMs * 1000);
}

/**
 * Stable measurement window of a load phase: [start + ramp, end]. When the phase ended early
 * (byte cap, errors) and less than MIN_STABLE_WINDOW_MS would remain, the second half is used.
 */
export function stableWindow(
  phaseStartMs: number,
  phaseEndMs: number,
  rampMs: number = LOAD_RAMP_MS,
): { from: number; to: number } | null {
  const duration = phaseEndMs - phaseStartMs;
  if (!(duration > 0) || !Number.isFinite(duration)) return null;
  if (duration - rampMs >= MIN_STABLE_WINDOW_MS) return { from: phaseStartMs + rampMs, to: phaseEndMs };
  return { from: phaseStartMs + duration / 2, to: phaseEndMs };
}

/** Throughput in the stable window after the ramp-up (the headline download/upload value). */
export function stableThroughputMbps(
  samples: readonly ByteSample[],
  phaseStartMs: number,
  phaseEndMs: number,
  rampMs: number = LOAD_RAMP_MS,
): number | null {
  const w = stableWindow(phaseStartMs, phaseEndMs, rampMs);
  return w ? throughputMbps(samples, w.from, w.to) : null;
}

/** Per-bin throughput for charts; `t` = bin end. The last partial bin uses its real length. */
export function throughputBins(
  samples: readonly ByteSample[],
  fromMs: number,
  toMs: number,
  binMs = 500,
): { t: number; mbps: number }[] {
  const out: { t: number; mbps: number }[] = [];
  if (!(toMs > fromMs) || !(binMs > 0)) return out;
  const count = Math.ceil((toMs - fromMs) / binMs);
  const bytes = new Array<number>(count).fill(0);
  for (const s of samples) {
    if (s.t < fromMs || s.t >= toMs) continue;
    const i = Math.min(count - 1, Math.floor((s.t - fromMs) / binMs));
    bytes[i] += s.bytes;
  }
  for (let i = 0; i < count; i++) {
    const start = fromMs + i * binMs;
    const end = Math.min(toMs, start + binMs);
    out.push({ t: end, mbps: (bytes[i] * 8) / ((end - start) * 1000) });
  }
  return out;
}

// ─── Latency under load ────────────────────────────────────────────────────

/** One latency probe: `t` = send time (ms, same base as the phase windows), rtt null = lost. */
export interface LatencyPoint {
  t: number;
  rtt: number | null;
}

export interface LatencyStats {
  sent: number;
  lost: number;
  lossPct: number | null;
  mean: number | null;
  median: number | null;
  p95: number | null;
  /** MASD of consecutive successful probes (loss breaks the chain) */
  jitter: number | null;
}

export function latencyStats(rtts: readonly (number | null)[]): LatencyStats {
  const s = summarize(rtts);
  return {
    sent: s.sent,
    lost: s.lost,
    lossPct: s.sent > 0 ? (s.lost / s.sent) * 100 : null,
    mean: s.avg,
    median: s.p50,
    p95: s.p95,
    jitter: s.jitter,
  };
}

/** RTTs (send order) of the points with from ≤ t ≤ to. */
export function windowRtts(
  points: readonly LatencyPoint[],
  window: { from: number; to: number } | null,
): (number | null)[] {
  if (!window) return [];
  return [...points]
    .filter((p) => p.t >= window.from && p.t <= window.to)
    .sort((a, b) => a.t - b.t)
    .map((p) => (isNum(p.rtt) ? p.rtt : null));
}

/** Successful probes in a stats block. */
export function okCount(s: LatencyStats | null | undefined): number {
  return s ? s.sent - s.lost : 0;
}

export function increaseMs(idle: number | null | undefined, loaded: number | null | undefined): number | null {
  return isNum(idle) && isNum(loaded) ? loaded - idle : null;
}

export type LoadPhase = 'download' | 'upload';

/** A loaded phase that lost at least this share of its probes … */
export const HEAVY_LOSS_PCT = 50;
/** … (with at least this many probes) counts as an increase of at least F_GRADE_MS. */
export const HEAVY_LOSS_MIN_PROBES = 5;
/** lower bound of grade F (ms) */
export const F_GRADE_MS = 400;

/**
 * Latency increase of one loaded phase: mean loaded − mean idle. When ≥ 50 % of ≥ 5 probes were
 * lost under load the queue is so full that probes are dropped or exceed the timeout – such a
 * phase counts as at least 400 ms (grade F) instead of silently grading the few survivors.
 */
export function loadedIncreaseMs(idle: LatencyStats | null, loaded: LatencyStats | null): number | null {
  if (!idle || !loaded) return null;
  const inc = increaseMs(idle.mean, loaded.mean);
  const heavyLoss = loaded.sent >= HEAVY_LOSS_MIN_PROBES && (loaded.lossPct ?? 0) >= HEAVY_LOSS_PCT;
  if (heavyLoss && isNum(idle.mean)) return Math.max(inc ?? 0, F_GRADE_MS);
  return inc;
}

/**
 * Bufferbloat grade as Waveform computes it: the larger of (mean loaded − mean idle) over the
 * download and the upload phase decides. Phases without data are ignored.
 */
export function gradeFromLatency(
  idle: LatencyStats | null,
  download: LatencyStats | null,
  upload: LatencyStats | null,
): { grade: BufferbloatGrade | null; increaseMs: number | null; phase: LoadPhase | null } {
  const down = loadedIncreaseMs(idle, download);
  const up = loadedIncreaseMs(idle, upload);
  if (down === null && up === null) return { grade: null, increaseMs: null, phase: null };
  const phase: LoadPhase = up !== null && (down === null || up > down) ? 'upload' : 'download';
  const worst = phase === 'upload' ? (up as number) : (down as number);
  return { grade: bufferbloatGrade(worst), increaseMs: worst, phase };
}

// ─── Bottleneck localization ───────────────────────────────────────────────

/**
 * Probe layers along the path: gw = router (gateway ping), isp6 = first provider hop (CMTS),
 * beyond = targets behind it (AFTR, 1.1.1.1 ICMP/UDP).
 */
export type BottleneckLayer = 'gw' | 'isp6' | 'beyond';

/** Path order (PC → Internet). */
export const BOTTLENECK_LAYERS: readonly BottleneckLayer[] = ['gw', 'isp6', 'beyond'];

export const BOTTLENECK_LABELS: Record<BottleneckLayer, string> = {
  gw: 'LAN-Link (z. B. 100 Mbit/s)',
  isp6: 'Kabelmodem/DOCSIS-Upstream',
  beyond: 'Provider',
};

export const BOTTLENECK_SEGMENT: Record<BottleneckLayer, Segment> = {
  gw: 'lan',
  isp6: 'docsis',
  beyond: 'isp',
};

/**
 * German label of the queue location. Under download a rising CMTS hop means the queue sits in
 * the CMTS downstream, so that case gets its own label.
 */
export function bottleneckLabel(layer: BottleneckLayer, phase?: LoadPhase | null): string {
  if (layer === 'isp6' && phase === 'download') return 'Kabelnetz/DOCSIS-Downstream (Kopfstation)';
  return BOTTLENECK_LABELS[layer];
}

function bottleneckText(layer: BottleneckLayer, phase: LoadPhase): string {
  const load = phase === 'download' ? 'beim Download' : 'beim Upload';
  if (layer === 'gw') {
    return `Schon der Ping zum Router steigt ${load} – die Warteschlange liegt im Heimnetz (z. B. Netzwerkkabel nur mit 100 Mbit/s verbunden).`;
  }
  if (layer === 'isp6') {
    return phase === 'upload'
      ? 'Der Router-Ping bleibt stabil, aber die Kopfstation (1. Provider-Hop) steigt beim Upload – der Sendepuffer im Kabelmodem (DOCSIS-Upstream) läuft voll.'
      : 'Der Router-Ping bleibt stabil, aber die Kopfstation (1. Provider-Hop) steigt beim Download – die Warteschlange liegt im Kabelnetz (Downstream der Kopfstation).';
  }
  if (phase === 'download') {
    // The CMTS answers pings itself (slow path) and may skip its own downstream queue, so a queue
    // in the head end's downstream (tariff shaper) cannot be told apart from one further inside.
    return 'Router und Kopfstation-Ping bleiben stabil, erst die Ziele dahinter steigen beim Download – die Warteschlange liegt beim Provider (meist im Downstream der Kopfstation, wo der Tarif gedrosselt wird, oder im Netz dahinter).';
  }
  return `Router und Kopfstation bleiben stabil, erst die Ziele dahinter steigen ${load} – die Verzögerung entsteht beim Provider (AFTR/Backbone).`;
}

/** Median latency of one layer while idle and while loaded (ms, null = no data). */
export interface LayerLatency {
  layer: BottleneckLayer;
  idleMs: number | null;
  loadedMs: number | null;
}

export interface Bottleneck {
  layer: BottleneckLayer;
  label: string;
  phase: LoadPhase;
  /** latency increase of the identified layer (ms) */
  riseMs: number;
  segment: Segment;
  /** German explanation */
  text: string;
}

/** A layer must rise at least this much to count as "loaded" (ms). */
export const BOTTLENECK_MIN_RISE_MS = 15;
/** …and carry at least this share of the largest rise along the path. */
export const BOTTLENECK_MIN_SHARE = 0.5;

/**
 * Where does the queue build up? Queueing delay accumulates along the path, so the bottleneck is
 * the FIRST layer (PC → Internet) whose loaded latency rose significantly: by ≥ minRiseMs and by
 * ≥ minShare of the largest rise seen on any layer. Returns null when nothing rose significantly
 * or when a layer before the candidate has no data (cannot tell LAN from DOCSIS then).
 */
export function localizeBottleneck(
  layers: readonly LayerLatency[],
  phase: LoadPhase,
  opts: { minRiseMs?: number; minShare?: number } = {},
): Bottleneck | null {
  const minRise = opts.minRiseMs ?? BOTTLENECK_MIN_RISE_MS;
  const minShare = opts.minShare ?? BOTTLENECK_MIN_SHARE;
  const rises = new Map<BottleneckLayer, number | null>();
  for (const layer of BOTTLENECK_LAYERS) {
    const l = layers.find((x) => x.layer === layer);
    rises.set(layer, l ? increaseMs(l.idleMs, l.loadedMs) : null);
  }
  let total: number | null = null;
  for (const r of rises.values()) {
    if (r !== null && (total === null || r > total)) total = r;
  }
  if (total === null || total < minRise) return null;
  const needed = Math.max(minRise, minShare * total);
  for (const layer of BOTTLENECK_LAYERS) {
    const r = rises.get(layer) ?? null;
    if (r === null) return null; // unknown layer before the queue – cannot localize
    if (r >= needed) {
      return {
        layer,
        label: bottleneckLabel(layer, phase),
        phase,
        riseMs: r,
        segment: BOTTLENECK_SEGMENT[layer],
        text: bottleneckText(layer, phase),
      };
    }
  }
  return null;
}

/** The bottleneck of the phase with the larger rise (the one that dominates the grade). */
export function pickBottleneck(download: Bottleneck | null, upload: Bottleneck | null): Bottleneck | null {
  if (download && upload) return upload.riseMs > download.riseMs ? upload : download;
  return download ?? upload;
}

// ─── Link limit ────────────────────────────────────────────────────────────

/** Download at ≥ 85 % of the NIC link speed → the LAN link (e.g. 100 Mbit/s) caps the result. */
export const LINK_LIMIT_RATIO = 0.85;

export function isLimitedByLink(
  downMbps: number | null | undefined,
  nicLinkMbps: number | null | undefined,
  ratio: number = LINK_LIMIT_RATIO,
): boolean {
  return isNum(downMbps) && isNum(nicLinkMbps) && nicLinkMbps > 0 && downMbps >= ratio * nicLinkMbps;
}

/** e.g. "durch 100-Mbit/s-Link begrenzt" */
export function linkLimitText(nicLinkMbps: number | null | undefined): string {
  return isNum(nicLinkMbps) ? `durch ${fmtNumber(nicLinkMbps)}-Mbit/s-Link begrenzt` : 'durch den LAN-Link begrenzt';
}

// ─── Summary text ──────────────────────────────────────────────────────────

/** German event title, e.g. "Speedtest: ↓ 87 Mbit/s · ↑ 41 Mbit/s · Bufferbloat B". */
export function speedtestTitle(
  r: Pick<SpeedtestResult, 'downMbps' | 'upMbps' | 'grade' | 'error' | 'nicLinkMbps'>,
  opts: { limitedByLink?: boolean; aborted?: boolean } = {},
): string {
  if (r.downMbps === null && r.upMbps === null) {
    if (opts.aborted) return 'Speedtest abgebrochen';
    return r.error ? `Speedtest fehlgeschlagen: ${r.error}` : 'Speedtest fehlgeschlagen';
  }
  const parts = [`↓ ${fmtMbps(r.downMbps)}`, `↑ ${fmtMbps(r.upMbps)}`];
  if (r.grade) parts.push(`Bufferbloat ${r.grade}`);
  let title = `Speedtest${opts.aborted ? ' (abgebrochen)' : ''}: ${parts.join(' · ')}`;
  if (opts.limitedByLink) title += ` (${linkLimitText(r.nicLinkMbps)})`;
  return title;
}
