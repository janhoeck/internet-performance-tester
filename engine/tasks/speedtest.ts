// Speed test module (ARCHITECTURE §4.8, methodology §9): idle → download → upload against
// speed.cloudflare.com with loaded-latency probes (UDP id.server every 200 ms + the pinger's 1 Hz
// samples of gw/isp6/aftr/cf4), bufferbloat grade and bottleneck localization.
// Scheduled every `speedtestEveryMin` while a session runs (skip rules see speed-schedule.ts),
// manual via runNow() at any time.
import { setTimeout as sleep } from 'node:timers/promises';
import type { AppConfig } from '../../src/lib/shared/config';
import { LOAD_RAMP_MS, type LoadPhase } from '../../src/lib/shared/grading';
import type { AdapterSnapshot, ModuleState, Sample, SpeedPhase, SpeedtestProgress } from '../../src/lib/shared/types';
import type { EngineContext, EngineModule, Logger } from '../core/types';
import { createIdServerProber, type LatencyProber } from './speed-dns';
import {
  DEFAULT_RETRY_AFTER_MS,
  DOWNLOAD_REQUEST_BYTES,
  type LoadTransport,
  type PreflightInfo,
  type StreamOutcome,
  UPLOAD_REQUEST_BYTES,
  createCloudflareTransport,
  errorText,
  serverLabel,
} from './speed-http';
import { ProgressThrottle } from './speed-progress';
import {
  ByteBins,
  LAYER_TARGETS,
  type LayerPoint,
  type LoadPhaseData,
  type PhaseWindow,
  type ProbePoint,
  layerPointFromSample,
  summarizeSpeedRun,
} from './speed-result';
import {
  FIRST_RUN_DELAY_MS,
  MIN_GAP_MS,
  SKIP_RETRY_MS,
  TrafficWindow,
  adapterTrafficMbps,
  clientTrafficMbps,
  computeNextRun,
  linkState,
  pickLinkMbps,
  skipReason,
} from './speed-schedule';

export interface SpeedtestModuleOptions {
  /** load generator, created per run (default: speed.cloudflare.com) */
  transport?: () => LoadTransport;
  /** latency prober, created per run (default: UDP id.server CH/TXT to 1.1.1.1:53) */
  prober?: () => LatencyProber;
  /** ignored ramp-up at the start of each load phase (ms, default 3000) */
  rampMs?: number;
  /** latency probe interval (ms, default 200) */
  probeIntervalMs?: number;
  /** wait after the load for late probe answers and pinger samples (ms, default 2500) */
  drainMs?: number;
  /** safety cap per run and direction (bytes); the phase ends early when reached */
  maxBytesDown?: number;
  maxBytesUp?: number;
  /** schedule check interval (ms, default 30 s) */
  scheduleCheckMs?: number;
  /** earliest scheduled run after a session (re)start (ms, default 10 min) */
  firstRunDelayMs?: number;
}

const MAX_429_RETRIES = 3;
const MAX_STREAM_ERRORS = 5;
const STREAM_ERROR_PAUSE_MS = 500;
const PHASE_STOP_GRACE_MS = 3000;
/** stays below the runtime's 5 s budget for stop()/dispose() */
const STOP_TIMEOUT_MS = 4500;
const WARMUP_TIMEOUT_MS = 2200;
const OUTAGE_STALE_MS = 30 * 60_000;
const ADAPTER_TRAFFIC_FRESH_MS = 3 * 60_000;
/**
 * Data volume cap per test (research: ~400 MB). 500 MB = 15.7 s at 255 Mbit/s (measured on this
 * line, a 15 s test is not cut short) and still 4.3 s at 940 Mbit/s (≥ 1 s stable window).
 */
const DEFAULT_MAX_BYTES_DOWN = 500_000_000;
/** DOCSIS upstream ≤ 100 Mbit/s → ≤ 190 MB in 15 s */
const DEFAULT_MAX_BYTES_UP = 200_000_000;

/** Failure with a German message for the UI. */
class SpeedtestError extends Error {}

function abortError(): Error {
  const e = new Error('Abgebrochen');
  e.name = 'AbortError';
  return e;
}

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);
const round1 = (v: number) => Math.round(v * 10) / 10;

type StreamEnd = 'stopped' | 'failed' | 'rate-limited';

/** Re-issues requests until the phase signal aborts; 429 → wait Retry-After, ≤ 3 retries per request. */
async function streamLoop(
  request: (signal: AbortSignal) => Promise<StreamOutcome>,
  signal: AbortSignal,
  onOutcome: (o: StreamOutcome) => void,
  onError: (reason: string) => void,
): Promise<StreamEnd> {
  let retries = 0;
  let errors = 0;
  while (!signal.aborted) {
    try {
      const out = await request(signal);
      onOutcome(out);
      if (out.status === 200) {
        retries = 0;
        errors = 0;
        continue;
      }
      if (out.status === 429) {
        retries += 1;
        if (retries > MAX_429_RETRIES) return 'rate-limited';
        await sleep(out.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS, undefined, { signal });
        continue;
      }
      onError(`HTTP ${out.status}`);
    } catch (err) {
      if (signal.aborted) break;
      onError(errorText(err));
    }
    errors += 1;
    if (errors >= MAX_STREAM_ERRORS) return 'failed';
    try {
      await sleep(STREAM_ERROR_PAUSE_MS, undefined, { signal });
    } catch {
      break;
    }
  }
  return 'stopped';
}

interface LoadPhaseParams {
  kind: LoadPhase;
  transport: LoadTransport;
  streams: number;
  durationMs: number;
  capBytes: number;
  /** ms since test start */
  rel: () => number;
  signal: AbortSignal;
  onBins: (bins: ByteBins) => void;
  onColo: (colo: string) => void;
}

/** One load phase: N parallel streams for `durationMs` (or until the byte cap / all streams gave up). */
async function runLoadPhase(p: LoadPhaseParams): Promise<LoadPhaseData> {
  const phaseAbort = new AbortController();
  const bins = new ByteBins();
  p.onBins(bins);
  let total = 0;
  /** an HTTP 200 was seen (download: response headers, upload: response) */
  let accepted = false;
  /** requests answered with another status than 200 */
  let rejected = 0;
  let rateLimited = false;
  let capReached = false;
  let lastError: string | null = null;
  let endPhase: () => void = () => undefined;
  const ended = new Promise<void>((resolve) => {
    endPhase = resolve;
  });
  const relay = () => {
    phaseAbort.abort();
    endPhase();
  };
  if (p.signal.aborted) relay();
  else p.signal.addEventListener('abort', relay, { once: true });

  const start = p.rel();
  const onBytes = (n: number) => {
    bins.add(p.rel(), n);
    total += n;
    if (!capReached && total >= p.capBytes) {
      capReached = true;
      endPhase();
    }
  };
  const onResponse = (o: StreamOutcome) => {
    if (o.status === 200) accepted = true;
    if (o.colo) p.onColo(o.colo);
  };
  const request =
    p.kind === 'download'
      ? (s: AbortSignal) => p.transport.download(DOWNLOAD_REQUEST_BYTES, s, onBytes, onResponse)
      : (s: AbortSignal) => p.transport.upload(UPLOAD_REQUEST_BYTES, s, onBytes);
  const onOutcome = (o: StreamOutcome) => {
    onResponse(o);
    if (o.status !== 200) rejected += 1;
  };
  const onError = (reason: string) => {
    lastError = reason;
  };
  const loops = Array.from({ length: Math.max(1, p.streams) }, () =>
    streamLoop(request, phaseAbort.signal, onOutcome, onError).then((end) => {
      if (end === 'rate-limited') rateLimited = true;
      return end;
    }),
  );
  const timer = setTimeout(endPhase, p.durationMs);
  void Promise.allSettled(loops).then(() => endPhase()); // every stream gave up

  await ended;
  clearTimeout(timer);
  const end = p.rel();
  phaseAbort.abort();
  p.signal.removeEventListener('abort', relay);
  await Promise.race([Promise.allSettled(loops), sleep(PHASE_STOP_GRACE_MS, undefined, { ref: false })]);

  // Requests still in flight at the phase end never report a status (10 MB uploads / 25 MB
  // downloads can outlast a whole phase on slow lines) – bytes without any rejected request count.
  const ok = accepted || (total > 0 && rejected === 0);
  let error: string | null = null;
  if (!ok) error = rateLimited ? 'HTTP 429 – zu viele Anfragen' : (lastError ?? 'keine Antwort');
  return {
    window: { start, end, complete: !p.signal.aborted },
    bytes: bins.samples(),
    totalBytes: total,
    ok,
    error,
    rateLimited,
    capReached,
  };
}

/** Sends one probe every `intervalMs` on a drift-free grid until stopped. */
function startProbeLoop(
  prober: LatencyProber,
  intervalMs: number,
  rel: () => number,
  phase: () => SpeedPhase,
  onSent: (point: ProbePoint) => void,
  onAnswer: (rtt: number | null, pop: string | null) => void,
): { stop(): void } {
  let stopped = false;
  let k = 0;
  let timer: NodeJS.Timeout | null = null;
  const start = rel();
  const tick = () => {
    if (stopped) return;
    const point: ProbePoint = { t: rel(), phase: phase(), rtt: null, done: false };
    onSent(point);
    prober.probe((rtt, pop) => {
      point.rtt = rtt;
      point.done = true;
      onAnswer(rtt, pop);
    });
    k += 1;
    timer = setTimeout(tick, Math.max(0, start + k * intervalMs - rel()));
  };
  tick();
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

/** One discarded probe (creates the CGNAT/AFTR mapping); resolves with the PoP name. */
function warmup(prober: LatencyProber, signal: AbortSignal): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    let done = false;
    const finish = (pop: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve(pop);
    };
    const onAbort = () => finish(null);
    const timer = setTimeout(() => finish(null), WARMUP_TIMEOUT_MS);
    signal.addEventListener('abort', onAbort, { once: true });
    prober.probe((_rtt, pop) => finish(pop));
  });
}

export function createSpeedtestModule(opts: SpeedtestModuleOptions = {}): EngineModule {
  const rampMs = opts.rampMs ?? LOAD_RAMP_MS;
  const probeIntervalMs = opts.probeIntervalMs ?? 200;
  const drainMs = opts.drainMs ?? 2500;
  const maxBytesDown = opts.maxBytesDown ?? DEFAULT_MAX_BYTES_DOWN;
  const maxBytesUp = opts.maxBytesUp ?? DEFAULT_MAX_BYTES_UP;
  const scheduleCheckMs = opts.scheduleCheckMs ?? 30_000;
  const firstRunDelayMs = opts.firstRunDelayMs ?? FIRST_RUN_DELAY_MS;
  const makeTransport = opts.transport ?? (() => createCloudflareTransport());
  const makeProber = opts.prober ?? (() => createIdServerProber());

  let ctx: EngineContext | null = null;
  let log: Logger | null = null;
  const unsubscribe: (() => void)[] = [];
  let scheduleTimer: NodeJS.Timeout | null = null;
  let scheduled = false;
  let nextRunTs: number | null = null;
  let lastRunTs: number | null = null;
  let lastError: string | null = null;
  let lastSkip: string | null = null;
  let current: { abort: AbortController; done: Promise<void> } | null = null;
  let outageSince: number | null = null;
  let adapters: AdapterSnapshot | null = null;
  let prevAdapters: AdapterSnapshot | null = null;
  const traffic = new TrafficWindow();
  let sampleSink: ((s: Sample) => void) | null = null;

  function ownTrafficMbps(now: number): number | null {
    const fromClient = traffic.meanMbps(now);
    if (fromClient !== null) return fromClient;
    if (adapters && now - adapters.ts <= ADAPTER_TRAFFIC_FRESH_MS) return adapterTrafficMbps(prevAdapters, adapters);
    return null;
  }

  function outageActive(now: number): boolean {
    if (outageSince !== null && now - outageSince > OUTAGE_STALE_MS) outageSince = null; // missed outage-end
    return outageSince !== null;
  }

  async function preflight(transport: LoadTransport, signal: AbortSignal): Promise<PreflightInfo> {
    for (let attempt = 0; ; attempt++) {
      let info: PreflightInfo;
      try {
        info = await transport.preflight(signal);
      } catch (err) {
        if (signal.aborted) throw abortError();
        throw new SpeedtestError(`Cloudflare-Speedtest nicht erreichbar (${errorText(err)})`);
      }
      if (info.status === 200) return info;
      if (info.status === 429 && attempt < MAX_429_RETRIES) {
        const wait = info.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS;
        log?.warn('speed test rate limited (HTTP 429), retrying', { attempt: attempt + 1, waitMs: wait });
        await sleep(wait, undefined, { signal });
        continue;
      }
      throw new SpeedtestError(
        info.status === 429
          ? 'Cloudflare-Speedtest vorübergehend gesperrt (HTTP 429 – zu viele Anfragen)'
          : `Cloudflare-Speedtest antwortet mit HTTP ${info.status}`,
      );
    }
  }

  async function runTest(c: EngineContext, trigger: 'schedule' | 'manual', signal: AbortSignal): Promise<void> {
    const cfg = c.config().speedtest;
    const idleMs = cfg.idleSec * 1000;
    const downMs = cfg.downloadSec * 1000;
    const upMs = cfg.uploadSec * 1000;
    const plannedMs = Math.max(1, idleMs + downMs + upMs);
    const ts = Date.now();
    const t0 = performance.now();
    const rel = () => performance.now() - t0;

    let phase: SpeedPhase = 'idle';
    let phaseStart = 0;
    let phaseOffset = 0;
    let phaseLen = 0; // preparation (preflight, warm-up probe): progress stays at 0
    let activeBins: ByteBins | null = null;
    let lastRtt: number | null = null;
    let pop: string | null = null;
    let colo: string | null = null;
    let family: 4 | 6 | null = null;
    const probes: ProbePoint[] = [];
    const layerSamples: LayerPoint[] = [];
    const throttle = new ProgressThrottle((p) => c.bus.emit('speedtest', p));
    const progressNow = (): SpeedtestProgress => ({
      running: true,
      phase,
      progress: clamp01((phaseOffset + Math.min(Math.max(rel() - phaseStart, 0), phaseLen)) / plannedMs),
      currentMbps: activeBins ? round1(activeBins.rateMbps(rel())) : null,
      currentRtt: lastRtt === null ? null : round1(lastRtt),
    });
    const setPhase = (next: SpeedPhase, offset: number, len: number) => {
      phase = next;
      phaseStart = rel();
      phaseOffset = offset;
      phaseLen = len;
      throttle.push(progressNow());
    };
    const ticker = setInterval(() => throttle.push(progressNow()), 250);

    sampleSink = (s) => {
      if (LAYER_TARGETS.includes(s.targetId)) layerSamples.push(layerPointFromSample(s, ts));
    };
    const nicLinkMbps = pickLinkMbps(c.clientState(), adapters, Date.now());
    const transport = makeTransport();
    const prober = makeProber();
    let probeLoop: { stop(): void } | null = null;
    let active = false;
    let idle: PhaseWindow | null = null;
    let download: LoadPhaseData | null = null;
    let upload: LoadPhaseData | null = null;
    let fatal: string | null = null;
    let aborted = false;
    log?.info('speed test started', { trigger, streams: [cfg.downloadStreams, cfg.uploadStreams], nicLinkMbps });
    throttle.push(progressNow());

    try {
      const pf = await preflight(transport, signal);
      colo = pf.colo;
      family = pf.family;

      let probing = false;
      try {
        await prober.open();
        probing = true;
      } catch (err) {
        log?.warn('UDP latency probe unavailable – falling back to pinger samples', { error: errorText(err) });
      }
      if (probing) {
        pop = await warmup(prober, signal);
        if (signal.aborted) throw abortError();
        probeLoop = startProbeLoop(
          prober,
          probeIntervalMs,
          rel,
          () => phase,
          (point) => probes.push(point),
          (rtt, answeredPop) => {
            lastRtt = rtt;
            if (answeredPop) pop = answeredPop;
          },
        );
      }

      setPhase('idle', 0, idleMs);
      const idleStart = rel();
      await sleep(idleMs, undefined, { signal });
      idle = { start: idleStart, end: rel(), complete: true };

      c.setSpeedtestActive(true);
      active = true;
      const common = {
        transport,
        rel,
        signal,
        onBins: (bins: ByteBins) => {
          activeBins = bins;
        },
        onColo: (value: string) => {
          colo ??= value;
        },
      };
      setPhase('download', idleMs, downMs);
      download = await runLoadPhase({
        ...common,
        kind: 'download',
        streams: cfg.downloadStreams,
        durationMs: downMs,
        capBytes: maxBytesDown,
      });
      if (signal.aborted) throw abortError();
      setPhase('upload', idleMs + downMs, upMs);
      upload = await runLoadPhase({
        ...common,
        kind: 'upload',
        streams: cfg.uploadStreams,
        durationMs: upMs,
        capBytes: maxBytesUp,
      });
      if (signal.aborted) throw abortError();
      probeLoop?.stop();
      probeLoop = null;
      activeBins = null;
      // late UDP answers + pinger samples of the last seconds (an abort here keeps the complete result)
      await sleep(drainMs, undefined, { signal }).catch(() => undefined);
    } catch (err) {
      if (signal.aborted) aborted = true;
      else fatal = err instanceof SpeedtestError ? err.message : `Unerwarteter Fehler (${errorText(err)})`;
    } finally {
      clearInterval(ticker);
      probeLoop?.stop();
      sampleSink = null;
      if (active) c.setSpeedtestActive(false);
      prober.close();
      transport.dispose();
    }

    const endTs = Date.now();
    const summary = summarizeSpeedRun({
      ts,
      endTs,
      trigger,
      server: serverLabel(colo),
      colo,
      family,
      pop,
      idle,
      download,
      upload,
      probes,
      layerSamples,
      downloadStreams: cfg.downloadStreams,
      uploadStreams: cfg.uploadStreams,
      nicLinkMbps,
      error: fatal,
      aborted,
      rampMs,
    });
    let id: number | null = null;
    try {
      id = c.db.insertSpeedtest(summary.result);
      summary.result.id = id;
    } catch (err) {
      log?.error('could not store speed test result', { error: errorText(err) });
    }
    try {
      c.recordEvent({
        ts,
        endTs,
        type: 'speedtest',
        severity: summary.severity,
        segment: summary.segment,
        title: summary.title,
        details: { ...summary.details, speedtestId: id },
        source: 'speedtest',
        dedupeKey: `speedtest:${ts}`,
      });
    } catch (err) {
      log?.error('could not record speed test event', { error: errorText(err) });
    }
    lastRunTs = ts;
    lastError = summary.result.error;
    const r = summary.result;
    log?.info('speed test finished', {
      downMbps: r.downMbps,
      upMbps: r.upMbps,
      idleMs: r.idleLatencyMs,
      loadedDownMs: r.loadedDownLatencyMs,
      loadedUpMs: r.loadedUpLatencyMs,
      grade: r.grade,
      server: r.server,
      bottleneck: summary.bottleneck?.label ?? null,
      error: r.error,
    });
    const failed = r.downMbps === null && r.upMbps === null;
    await throttle.final({
      running: false,
      phase: failed ? 'error' : 'done',
      progress: 1,
      currentMbps: null,
      currentRtt: null,
      result: r,
      error: r.error,
    });
  }

  function launch(trigger: 'schedule' | 'manual'): void {
    const c = ctx;
    if (!c) return;
    const abort = new AbortController();
    const done = runTest(c, trigger, abort.signal)
      .catch((err: unknown) => {
        lastError = errorText(err);
        log?.error('speed test crashed', { error: lastError });
      })
      .finally(() => {
        if (current?.abort === abort) current = null;
        if (scheduled) {
          nextRunTs = computeNextRun(lastRunTs, c.config().schedules.speedtestEveryMin, Date.now() + 60_000);
        }
      });
    current = { abort, done };
  }

  function scheduleCheck(): void {
    const c = ctx;
    if (!c || !scheduled || current) return;
    const cfg = c.config();
    if (!cfg.schedules.speedtestEnabled) return;
    const now = Date.now();
    if (nextRunTs === null) {
      nextRunTs = computeNextRun(lastRunTs, cfg.schedules.speedtestEveryMin, now + firstRunDelayMs);
    }
    if (now < nextRunTs) return;
    const reason = skipReason({
      now,
      hour: new Date(now).getHours(),
      quietHours: cfg.schedules.speedtestQuietHours,
      gaming: c.gamingActive(),
      ownTrafficMbps: ownTrafficMbps(now),
      outageActive: outageActive(now),
      link: linkState(c.clientState(), adapters, now),
      lastRunTs,
    });
    if (reason) {
      if (reason !== lastSkip) log?.info('scheduled speed test skipped', { reason });
      lastSkip = reason;
      nextRunTs = lastRunTs !== null && now - lastRunTs < MIN_GAP_MS ? lastRunTs + MIN_GAP_MS : now + SKIP_RETRY_MS;
      return;
    }
    lastSkip = null;
    launch('schedule');
  }

  async function abortCurrent(): Promise<void> {
    const cur = current;
    if (!cur) return;
    cur.abort.abort();
    await Promise.race([cur.done, sleep(STOP_TIMEOUT_MS, undefined, { ref: false })]);
  }

  async function stop(): Promise<void> {
    scheduled = false;
    if (scheduleTimer) clearInterval(scheduleTimer);
    scheduleTimer = null;
    nextRunTs = null;
    outageSince = null;
    lastSkip = null;
    traffic.clear();
    await abortCurrent();
  }

  return {
    name: 'speedtest',

    init(c: EngineContext) {
      ctx = c;
      log = c.log.child('speedtest');
      try {
        lastRunTs = c.db.latestSpeedtest()?.ts ?? null;
        adapters = c.db.latestSnapshot<AdapterSnapshot>('adapters')?.data ?? null;
      } catch (err) {
        log.warn('could not read previous speed test / adapters snapshot', { error: errorText(err) });
      }
      unsubscribe.push(
        c.bus.on('sample', (s) => sampleSink?.(s)),
        c.bus.on('incident', (i) => {
          if (i.kind === 'outage-start') outageSince = i.ts;
          else if (i.kind === 'outage-end') outageSince = null;
        }),
        c.bus.on('client', (state) => {
          const mbps = clientTrafficMbps(state);
          if (mbps !== null) traffic.push(state.ts, mbps);
        }),
        c.bus.on('adapters', (snap) => {
          prevAdapters = adapters;
          adapters = snap;
        }),
      );
    },

    start() {
      if (!ctx) return;
      scheduled = true;
      nextRunTs = computeNextRun(lastRunTs, ctx.config().schedules.speedtestEveryMin, Date.now() + firstRunDelayMs);
      if (!scheduleTimer) {
        scheduleTimer = setInterval(scheduleCheck, scheduleCheckMs);
        scheduleTimer.unref();
      }
    },

    stop,

    async dispose() {
      await stop();
      for (const off of unsubscribe.splice(0)) off();
    },

    reconfigure(cfg: AppConfig) {
      if (!scheduled || lastRunTs === null) return;
      nextRunTs = computeNextRun(lastRunTs, cfg.schedules.speedtestEveryMin, Date.now() + 60_000);
    },

    async runNow() {
      if (!ctx) throw new Error('Speedtest-Modul ist nicht initialisiert');
      if (current) throw new Error('Ein Speedtest läuft bereits');
      launch('manual');
      return { started: true };
    },

    state(): ModuleState {
      const enabled = ctx ? ctx.config().schedules.speedtestEnabled : true;
      return {
        name: 'speedtest',
        enabled,
        running: scheduled,
        busy: current !== null,
        lastRunTs,
        nextRunTs: scheduled && enabled ? nextRunTs : null,
        lastError,
      };
    },
  };
}
