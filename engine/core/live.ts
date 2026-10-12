// Live stream (GET /live, ARCHITECTURE §4.4): SSE framing + batching. One hub subscribes to the
// bus while at least one client is connected and broadcasts LiveMessages to all clients:
// samples every 500 ms, metrics every 2 s, client 1 Hz, status every 5 s, events / speed test /
// traceroute / router / session immediately, heartbeat comment every 15 s.
import type { ClientState, EngineStatus, LiveMessage, MetricPoint, Sample } from '../../src/lib/shared/types';
import type { Bus, Logger } from './types';
import { errorMessage } from './util';

export const SSE_HEADERS: Readonly<Record<string, string>> = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
};
export const SSE_RETRY = 'retry: 3000\n\n';
export const SSE_HEARTBEAT = ': hb\n\n';

/** One SSE message: `data: <JSON>\n\n` (JSON.stringify never emits raw newlines). */
export function sseData(msg: LiveMessage): string {
  return `data: ${JSON.stringify(msg)}\n\n`;
}

export interface LiveTimings {
  samplesMs: number;
  metricsMs: number;
  clientMs: number;
  statusMs: number;
  heartbeatMs: number;
}

export const DEFAULT_LIVE_TIMINGS: LiveTimings = {
  samplesMs: 500,
  metricsMs: 2000,
  clientMs: 1000,
  statusMs: 5000,
  heartbeatMs: 15_000,
};

/** buffer caps (a stalled flush must never grow memory without bound) */
const MAX_SAMPLES = 20_000;
const MAX_METRICS = 10_000;

/**
 * Pure batching state: collects samples/metrics/client states and turns them into messages
 * when the respective timer fires.
 */
export class LiveBatcher {
  private samples: Sample[] = [];
  private metrics: MetricPoint[] = [];
  private client: ClientState | null = null;
  dropped = 0;

  addSample(s: Sample): void {
    this.samples.push(s);
    if (this.samples.length > MAX_SAMPLES) {
      const n = this.samples.length - MAX_SAMPLES;
      this.samples.splice(0, n);
      this.dropped += n;
    }
  }

  addMetrics(points: readonly MetricPoint[]): void {
    for (const p of points) this.metrics.push(p);
    if (this.metrics.length > MAX_METRICS) {
      const n = this.metrics.length - MAX_METRICS;
      this.metrics.splice(0, n);
      this.dropped += n;
    }
  }

  setClient(c: ClientState): void {
    this.client = c;
  }

  takeSamples(): LiveMessage | null {
    if (this.samples.length === 0) return null;
    const data = this.samples;
    this.samples = [];
    return { type: 'samples', data };
  }

  takeMetrics(): LiveMessage | null {
    if (this.metrics.length === 0) return null;
    const data = this.metrics;
    this.metrics = [];
    return { type: 'metrics', data };
  }

  takeClient(): LiveMessage | null {
    if (!this.client) return null;
    const data = this.client;
    this.client = null;
    return { type: 'client', data };
  }

  clear(): void {
    this.samples = [];
    this.metrics = [];
    this.client = null;
  }
}

/** Transport-independent client (the HTTP layer adapts a ServerResponse). */
export interface LiveClient {
  write(chunk: string): void;
  close(): void;
}

export interface LiveHubOptions {
  bus: Bus;
  log: Logger;
  status: () => EngineStatus;
  timings?: Partial<LiveTimings>;
}

export class LiveHub {
  private readonly clients = new Set<LiveClient>();
  private readonly batcher = new LiveBatcher();
  private readonly timings: LiveTimings;
  private timers: NodeJS.Timeout[] = [];
  private unsubscribe: (() => void)[] = [];
  private closed = false;

  constructor(private readonly opts: LiveHubOptions) {
    this.timings = { ...DEFAULT_LIVE_TIMINGS, ...opts.timings };
  }

  get size(): number {
    return this.clients.size;
  }

  /** Registers a client: writes `retry` + `hello`. Returns the removal function (idempotent). */
  add(client: LiveClient): () => void {
    if (this.closed) {
      client.close();
      return () => undefined;
    }
    let status: EngineStatus | null = null;
    try {
      status = this.opts.status();
    } catch (err) {
      this.opts.log.warn(`Status für Live-Stream nicht verfügbar: ${errorMessage(err)}`);
    }
    try {
      client.write(SSE_RETRY);
      if (status) client.write(sseData({ type: 'hello', data: status }));
    } catch {
      client.close();
      return () => undefined;
    }
    this.clients.add(client);
    if (this.clients.size === 1) this.activate();
    this.opts.log.debug(`Live-Client verbunden (${this.clients.size} aktiv)`);
    return () => this.remove(client);
  }

  /** Ends all client streams and stops the hub. */
  close(): void {
    this.closed = true;
    for (const c of [...this.clients]) {
      this.clients.delete(c);
      try {
        c.close();
      } catch {
        /* ignore */
      }
    }
    this.deactivate();
  }

  private remove(client: LiveClient): void {
    if (!this.clients.delete(client)) return;
    this.opts.log.debug(`Live-Client getrennt (${this.clients.size} aktiv)`);
    if (this.clients.size === 0) this.deactivate();
  }

  private broadcast(chunk: string): void {
    for (const c of [...this.clients]) {
      try {
        c.write(chunk);
      } catch {
        this.remove(c);
        try {
          c.close();
        } catch {
          /* ignore */
        }
      }
    }
  }

  private send(msg: LiveMessage | null): void {
    if (msg) this.broadcast(sseData(msg));
  }

  private activate(): void {
    const { bus } = this.opts;
    const b = this.batcher;
    this.unsubscribe = [
      bus.on('sample', (s) => b.addSample(s)),
      bus.on('metrics', (m) => b.addMetrics(m)),
      bus.on('client', (c) => b.setClient(c)),
      bus.on('event', (e) => this.send({ type: 'event', data: e })),
      bus.on('speedtest', (p) => this.send({ type: 'speedtest', data: p })),
      bus.on('traceroute', (t) => this.send({ type: 'traceroute', data: t })),
      bus.on('router', (r) => this.send({ type: 'router', data: r })),
      bus.on('session', (s) => this.send({ type: 'session', data: s })),
    ];
    const t = this.timings;
    const every = (ms: number, fn: () => void) => {
      const timer = setInterval(fn, ms);
      timer.unref();
      this.timers.push(timer);
    };
    every(t.samplesMs, () => this.send(b.takeSamples()));
    every(t.metricsMs, () => this.send(b.takeMetrics()));
    every(t.clientMs, () => this.send(b.takeClient()));
    every(t.statusMs, () => {
      try {
        this.send({ type: 'status', data: this.opts.status() });
      } catch (err) {
        this.opts.log.warn(`Status für Live-Stream nicht verfügbar: ${errorMessage(err)}`);
      }
    });
    every(t.heartbeatMs, () => this.broadcast(SSE_HEARTBEAT));
  }

  private deactivate(): void {
    for (const off of this.unsubscribe) off();
    this.unsubscribe = [];
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    this.batcher.clear();
  }
}
