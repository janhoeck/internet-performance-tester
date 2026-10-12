// Turns the raw data of one speed test run into the persisted SpeedtestResult, the details of
// the 'speedtest' event and its German title. Pure (no I/O), unit-tested.
import { isNum } from '../../src/lib/shared/format';
import {
  type Bottleneck,
  type ByteSample,
  type LatencyPoint,
  type LatencyStats,
  type LayerLatency,
  type LoadPhase,
  gradeFromLatency,
  gradeLabel,
  gradeRank,
  increaseMs,
  isLimitedByLink,
  latencyStats,
  localizeBottleneck,
  okCount,
  pickBottleneck,
  speedtestTitle,
  stableWindow,
  throughputBins,
  throughputMbps,
  windowRtts,
} from '../../src/lib/shared/grading';
import {
  type Sample,
  SampleStatus,
  type Segment,
  type Severity,
  type SpeedPhase,
  type SpeedSeriesPoint,
  type SpeedtestResult,
} from '../../src/lib/shared/types';

/** throughput bin width of the stored series (ms) */
export const SERIES_BIN_MS = 500;
/** pinger targets whose 1 Hz samples localize the queue (bus 'sample') */
export const LAYER_TARGETS: readonly string[] = ['gw', 'isp6', 'aftr', 'cf4'];

/** Byte counter in fixed bins; `t` = ms since test start (monotonic). */
export class ByteBins {
  private readonly bins = new Map<number, number>();
  private sum = 0;

  constructor(private readonly binMs = 50) {}

  add(t: number, bytes: number): void {
    if (!Number.isFinite(t) || !(bytes > 0)) return;
    const i = Math.floor(t / this.binMs);
    this.bins.set(i, (this.bins.get(i) ?? 0) + bytes);
    this.sum += bytes;
  }

  get total(): number {
    return this.sum;
  }

  /** bytes in bins starting at or after `fromT` */
  bytesSince(fromT: number): number {
    const first = Math.floor(fromT / this.binMs);
    let n = 0;
    for (const [i, b] of this.bins) if (i >= first) n += b;
    return n;
  }

  /** current rate over the last `windowMs` (Mbit/s) */
  rateMbps(nowT: number, windowMs = 1000): number {
    return (this.bytesSince(nowT - windowMs) * 8) / (windowMs * 1000);
  }

  /** one sample per bin at the bin center, ascending */
  samples(): ByteSample[] {
    return [...this.bins.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([i, bytes]) => ({ t: i * this.binMs + this.binMs / 2, bytes }));
  }
}

/** Phase window in ms since test start. */
export interface PhaseWindow {
  start: number;
  end: number;
  /** ended regularly (duration elapsed or byte cap reached), false when aborted */
  complete: boolean;
}

/** One UDP latency probe; `t` = send time (ms since test start), `done` = answered or timed out. */
export interface ProbePoint {
  t: number;
  phase: SpeedPhase;
  rtt: number | null;
  done: boolean;
}

/** One pinger sample of a layer target; `t` = scheduled tick − test start (ms). */
export interface LayerPoint {
  target: string;
  t: number;
  rtt: number | null;
}

export function layerPointFromSample(s: Sample, testStartTs: number): LayerPoint {
  return {
    target: s.targetId,
    t: s.ts - testStartTs,
    rtt: s.status === SampleStatus.OK && isNum(s.rtt) ? s.rtt : null,
  };
}

export interface LoadPhaseData {
  window: PhaseWindow;
  bytes: ByteSample[];
  totalBytes: number;
  /** data was transferred: an HTTP 200 was seen, or bytes flowed without any rejected request */
  ok: boolean;
  /** German reason when the phase failed */
  error: string | null;
  rateLimited: boolean;
  capReached: boolean;
}

export interface SpeedRunData {
  ts: number;
  endTs: number;
  trigger: SpeedtestResult['trigger'];
  server: string | null;
  colo: string | null;
  family: 4 | 6 | null;
  /** PoP name answered to id.server (e.g. 'dus02') */
  pop: string | null;
  idle: PhaseWindow | null;
  download: LoadPhaseData | null;
  upload: LoadPhaseData | null;
  probes: readonly ProbePoint[];
  layerSamples: readonly LayerPoint[];
  downloadStreams: number;
  uploadStreams: number;
  nicLinkMbps: number | null;
  /** fatal error before/independent of the phases (e.g. Cloudflare unreachable) */
  error: string | null;
  aborted: boolean;
  rampMs: number;
}

export interface SpeedSummary {
  result: SpeedtestResult;
  details: Record<string, unknown>;
  title: string;
  severity: Severity;
  segment: Segment | null;
  limitedByLink: boolean;
  bottleneck: Bottleneck | null;
}

const round = (v: number | null | undefined, digits: number): number | null => {
  if (!isNum(v)) return null;
  const f = 10 ** digits;
  return Math.round(v * f) / f;
};

interface LayerStats {
  idle: LatencyStats;
  download: LatencyStats | null;
  upload: LatencyStats | null;
}

function median(s: LatencyStats | null | undefined): number | null {
  return s && okCount(s) > 0 ? s.median : null;
}

function layerSummary(l: LayerStats): Record<string, number | null> {
  return {
    idleMs: round(median(l.idle), 1),
    downloadMs: round(median(l.download), 1),
    uploadMs: round(median(l.upload), 1),
    idleN: okCount(l.idle),
    downloadN: okCount(l.download),
    uploadN: okCount(l.upload),
  };
}

function compactBottleneck(b: Bottleneck | null): Record<string, unknown> | null {
  return b ? { layer: b.layer, label: b.label, phase: b.phase, riseMs: round(b.riseMs, 1), segment: b.segment } : null;
}

export function summarizeSpeedRun(d: SpeedRunData): SpeedSummary {
  const idleWin = d.idle && d.idle.end > d.idle.start ? { from: d.idle.start, to: d.idle.end } : null;
  const usable = (p: LoadPhaseData | null): LoadPhaseData | null => (p && p.ok && p.window.complete ? p : null);
  const down = usable(d.download);
  const up = usable(d.upload);
  const downWin = down ? stableWindow(down.window.start, down.window.end, d.rampMs) : null;
  const upWin = up ? stableWindow(up.window.start, up.window.end, d.rampMs) : null;
  const downMbps = down && downWin ? throughputMbps(down.bytes, downWin.from, downWin.to) : null;
  const upMbps = up && upWin ? throughputMbps(up.bytes, upWin.from, upWin.to) : null;

  // latency: UDP id.server probes (5 Hz); fallback to the pinger's cf4 ICMP samples (1 Hz)
  const udp: LatencyPoint[] = d.probes.filter((p) => p.done).map((p) => ({ t: p.t, rtt: p.rtt }));
  const byTarget = (id: string): LatencyPoint[] =>
    d.layerSamples.filter((s) => s.target === id).map((s) => ({ t: s.t, rtt: s.rtt }));
  const layerStats = (pts: LatencyPoint[]): LayerStats => ({
    idle: latencyStats(windowRtts(pts, idleWin)),
    download: downWin ? latencyStats(windowRtts(pts, downWin)) : null,
    upload: upWin ? latencyStats(windowRtts(pts, upWin)) : null,
  });
  const layers = {
    gw: layerStats(byTarget('gw')),
    isp6: layerStats(byTarget('isp6')),
    aftr: layerStats(byTarget('aftr')),
    cf4: layerStats(byTarget('cf4')),
    udp: layerStats(udp),
  };
  const source: 'udp' | 'icmp' | null =
    okCount(layers.udp.idle) >= 3 ? 'udp' : okCount(layers.cf4.idle) >= 2 ? 'icmp' : null;
  const main = source === 'udp' ? layers.udp : source === 'icmp' ? layers.cf4 : null;
  const idle = main ? main.idle : null;
  const dl = main ? main.download : null;
  const ul = main ? main.upload : null;
  const g = gradeFromLatency(idle, dl, ul);

  // queue localization: first layer (gw → isp6 → beyond) whose loaded median rose
  const beyond = (phase: LoadPhase): { idleMs: number | null; loadedMs: number | null } => {
    for (const k of ['udp', 'cf4', 'aftr'] as const) {
      const i = median(layers[k].idle);
      const l = median(layers[k][phase]);
      if (i !== null && l !== null) return { idleMs: i, loadedMs: l };
    }
    return { idleMs: null, loadedMs: null };
  };
  const layerInput = (phase: LoadPhase): LayerLatency[] => [
    { layer: 'gw', idleMs: median(layers.gw.idle), loadedMs: median(layers.gw[phase]) },
    { layer: 'isp6', idleMs: median(layers.isp6.idle), loadedMs: median(layers.isp6[phase]) },
    { layer: 'beyond', ...beyond(phase) },
  ];
  const bnDown = downWin ? localizeBottleneck(layerInput('download'), 'download') : null;
  const bnUp = upWin ? localizeBottleneck(layerInput('upload'), 'upload') : null;
  const bottleneck = pickBottleneck(bnDown, bnUp);

  const limitedByLink = isLimitedByLink(downMbps, d.nicLinkMbps);
  const errors: string[] = [];
  if (d.aborted) errors.push('Abgebrochen');
  else if (d.error) errors.push(d.error);
  else {
    if (!down) errors.push(`Download fehlgeschlagen${d.download?.error ? ` (${d.download.error})` : ''}`);
    if (!up) errors.push(`Upload fehlgeschlagen${d.upload?.error ? ` (${d.upload.error})` : ''}`);
  }
  const error = errors.length > 0 ? errors.join('; ') : null;

  const series: SpeedSeriesPoint[] = [];
  for (const p of d.probes) {
    if (p.done) series.push({ t: Math.round(p.t), phase: p.phase, rtt: round(p.rtt, 1) });
  }
  for (const [phase, ph] of [['download', d.download], ['upload', d.upload]] as const) {
    if (!ph || !(ph.window.end > ph.window.start)) continue;
    for (const b of throughputBins(ph.bytes, ph.window.start, ph.window.end, SERIES_BIN_MS)) {
      series.push({ t: Math.round(b.t), phase, mbps: round(b.mbps, 2) });
    }
  }
  series.sort((a, b) => a.t - b.t);

  const result: SpeedtestResult = {
    ts: d.ts,
    endTs: d.endTs,
    trigger: d.trigger,
    server: d.server,
    downMbps: round(downMbps, 2),
    upMbps: round(upMbps, 2),
    idleLatencyMs: round(median(idle), 1),
    idleJitterMs: round(idle?.jitter, 1),
    loadedDownLatencyMs: round(median(dl), 1),
    loadedDownP95Ms: round(okCount(dl) > 0 ? dl?.p95 : null, 1),
    loadedUpLatencyMs: round(median(ul), 1),
    loadedUpP95Ms: round(okCount(ul) > 0 ? ul?.p95 : null, 1),
    bloatDownMs: round(increaseMs(median(idle), median(dl)), 1),
    bloatUpMs: round(increaseMs(median(idle), median(ul)), 1),
    grade: g.grade,
    bytesDown: d.download?.totalBytes ?? 0,
    bytesUp: d.upload?.totalBytes ?? 0,
    streams: d.downloadStreams,
    nicLinkMbps: d.nicLinkMbps,
    error,
    series,
  };

  const failed = result.downMbps === null && result.upMbps === null;
  const severity: Severity =
    (failed && !d.aborted) ||
    gradeRank(result.grade) >= gradeRank('C') ||
    (limitedByLink && isNum(d.nicLinkMbps) && d.nicLinkMbps < 1000)
      ? 'warn'
      : 'info';

  const details: Record<string, unknown> = {
    trigger: d.trigger,
    server: d.server,
    colo: d.colo,
    ipFamily: d.family,
    pop: d.pop,
    downMbps: result.downMbps,
    upMbps: result.upMbps,
    idleLatencyMs: result.idleLatencyMs,
    idleJitterMs: result.idleJitterMs,
    loadedDownLatencyMs: result.loadedDownLatencyMs,
    loadedDownP95Ms: result.loadedDownP95Ms,
    loadedUpLatencyMs: result.loadedUpLatencyMs,
    loadedUpP95Ms: result.loadedUpP95Ms,
    bloatDownMs: result.bloatDownMs,
    bloatUpMs: result.bloatUpMs,
    bloatDownMeanMs: round(increaseMs(idle?.mean, dl?.mean), 1),
    bloatUpMeanMs: round(increaseMs(idle?.mean, ul?.mean), 1),
    grade: result.grade,
    gradeLabel: result.grade ? gradeLabel(result.grade) : null,
    gradeIncreaseMs: round(g.increaseMs, 1),
    gradePhase: g.phase,
    nicLinkMbps: d.nicLinkMbps,
    limitedByLink,
    bottleneck: bottleneck ? { ...compactBottleneck(bottleneck), text: bottleneck.text } : null,
    bottleneckDown: compactBottleneck(bnDown),
    bottleneckUp: compactBottleneck(bnUp),
    latencySource: source,
    lossPct: {
      idle: round(idle?.lossPct, 1),
      download: round(dl?.lossPct, 1),
      upload: round(ul?.lossPct, 1),
    },
    layers: {
      gw: layerSummary(layers.gw),
      isp6: layerSummary(layers.isp6),
      aftr: layerSummary(layers.aftr),
      cf4: layerSummary(layers.cf4),
      udp: layerSummary(layers.udp),
    },
    bytesDown: result.bytesDown,
    bytesUp: result.bytesUp,
    downloadStreams: d.downloadStreams,
    uploadStreams: d.uploadStreams,
    durationMs: {
      idle: idleWin ? Math.round(idleWin.to - idleWin.from) : null,
      download: d.download ? Math.round(d.download.window.end - d.download.window.start) : null,
      upload: d.upload ? Math.round(d.upload.window.end - d.upload.window.start) : null,
    },
    capReached: { download: d.download?.capReached ?? false, upload: d.upload?.capReached ?? false },
    rateLimited: (d.download?.rateLimited ?? false) || (d.upload?.rateLimited ?? false),
    aborted: d.aborted,
    error,
  };

  return {
    result,
    details,
    title: speedtestTitle(result, { limitedByLink, aborted: d.aborted }),
    severity,
    segment: bottleneck ? bottleneck.segment : null,
    limitedByLink,
    bottleneck,
  };
}
