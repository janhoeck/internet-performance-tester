import { afterEach, describe, expect, it } from 'vitest';
import { type AppConfig, DEFAULT_CONFIG } from '../../src/lib/shared/config';
import {
  type ClientState,
  type NetEvent,
  SampleStatus,
  type SpeedtestProgress,
  type SpeedtestResult,
} from '../../src/lib/shared/types';
import type { Bus, BusEvents, EngineContext, EngineDb, EngineModule, Logger } from '../core/types';
import type { LatencyProber } from './speed-dns';
import type { LoadTransport, PreflightInfo, StreamOutcome } from './speed-http';
import { createSpeedtestModule } from './speedtest';

// ─── fakes ─────────────────────────────────────────────────────────────────

/** Object that throws on members the test did not provide (unexpected calls fail loudly). */
function stub<T extends object>(name: string, impl: Partial<T>): T {
  return new Proxy(impl, {
    get(target, prop, receiver) {
      if (prop in target) return Reflect.get(target, prop, receiver) as unknown;
      if (prop === 'then') return undefined;
      throw new Error(`${name}.${String(prop)} ist im Test nicht implementiert`);
    },
  }) as T;
}

type Handler = (payload: unknown) => void;

function createBus(): Bus & { count(type: keyof BusEvents): number } {
  const handlers = new Map<keyof BusEvents, Set<Handler>>();
  return {
    on(type, fn) {
      const set = handlers.get(type) ?? new Set<Handler>();
      set.add(fn as Handler);
      handlers.set(type, set);
      return () => {
        set.delete(fn as Handler);
      };
    },
    emit(type, payload) {
      for (const fn of [...(handlers.get(type) ?? [])]) fn(payload);
    },
    count(type) {
      return handlers.get(type)?.size ?? 0;
    },
  };
}

function createLog(lines: string[], scope = 'test'): Logger {
  const line = (level: string) => (msg: string, data?: unknown) => {
    lines.push(`${level} ${scope}: ${msg}${data === undefined ? '' : ` ${JSON.stringify(data)}`}`);
  };
  return { debug: line('debug'), info: line('info'), warn: line('warn'), error: line('error'), child: (s) => createLog(lines, `${scope}.${s}`) };
}

/** Simulated access line: streams share the down/up rate, latency depends on the active load. */
class FakeLine {
  downMbps = 80;
  upMbps = 40;
  idleRtt = 20;
  downRtt = 45;
  upRtt = 180;
  activeDown = 0;
  activeUp = 0;
  preflight: PreflightInfo[] = [];
  /** statuses of the next download requests (default 200) */
  downStatuses: number[] = [];
  down429Forever = false;
  udpBroken = false;
  calls = { preflight: 0, download: 0, upload: 0, disposed: 0 };
  /** ctx.speedtestActive() seen when load requests started */
  activeAtLoad: boolean[] = [];
  rtt(): number {
    if (this.activeUp > 0) return this.upRtt;
    return this.activeDown > 0 ? this.downRtt : this.idleRtt;
  }
}

function abortError(): Error {
  return Object.assign(new Error('Abgebrochen'), { name: 'AbortError' });
}

function fakeTransport(line: FakeLine, ctx: () => EngineContext): LoadTransport {
  const stream = (
    kind: 'down' | 'up',
    bytes: number,
    signal: AbortSignal,
    onBytes: (n: number) => void,
    onResponse?: (o: StreamOutcome) => void,
  ): Promise<StreamOutcome> =>
    new Promise<StreamOutcome>((resolve, reject) => {
      if (signal.aborted) {
        reject(abortError());
        return;
      }
      line.activeAtLoad.push(ctx().speedtestActive());
      const status = kind === 'down' ? (line.down429Forever ? 429 : (line.downStatuses.shift() ?? 200)) : 200;
      const outcome: StreamOutcome = { status, colo: status === 200 ? 'DUS' : null, retryAfterMs: status === 429 ? 20 : null };
      if (status !== 200) {
        setTimeout(() => resolve(outcome), 5);
        return;
      }
      onResponse?.(outcome);
      if (kind === 'down') line.activeDown += 1;
      else line.activeUp += 1;
      let left = bytes;
      let last = performance.now();
      const cleanup = () => {
        clearInterval(timer);
        if (kind === 'down') line.activeDown -= 1;
        else line.activeUp -= 1;
        signal.removeEventListener('abort', onAbort);
      };
      const onAbort = () => {
        cleanup();
        reject(abortError());
      };
      const timer = setInterval(() => {
        const now = performance.now();
        const active = kind === 'down' ? line.activeDown : line.activeUp;
        const perStream = (kind === 'down' ? line.downMbps : line.upMbps) / Math.max(1, active);
        const n = Math.min(left, Math.round((perStream * 1e6 * (now - last)) / 8000));
        last = now;
        if (n > 0) {
          left -= n;
          onBytes(n);
        }
        if (left <= 0) {
          cleanup();
          resolve(outcome);
        }
      }, 5);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  return {
    async preflight() {
      line.calls.preflight += 1;
      return line.preflight.shift() ?? { status: 200, colo: 'DUS', family: 6, retryAfterMs: null };
    },
    download(bytes, signal, onBytes, onResponse) {
      line.calls.download += 1;
      return stream('down', bytes, signal, onBytes, onResponse);
    },
    upload(bytes, signal, onBytes) {
      line.calls.upload += 1;
      return stream('up', bytes, signal, onBytes);
    },
    dispose() {
      line.calls.disposed += 1;
    },
  };
}

function fakeProber(line: FakeLine): LatencyProber {
  let open = false;
  let pending = 0;
  return {
    async open() {
      if (line.udpBroken) throw Object.assign(new Error('send EACCES'), { code: 'EACCES' });
      open = true;
    },
    probe(done) {
      if (!open) {
        done(null, null);
        return;
      }
      const rtt = line.rtt();
      pending += 1;
      setTimeout(() => {
        if (!open) return;
        pending -= 1;
        done(rtt, 'dus01');
      }, Math.min(rtt, 30));
    },
    get pending() {
      return pending;
    },
    close() {
      open = false;
      pending = 0;
    },
  };
}

interface Fake {
  ctx: EngineContext;
  bus: ReturnType<typeof createBus>;
  line: FakeLine;
  inserted: SpeedtestResult[];
  events: NetEvent[];
  activeCalls: boolean[];
  logs: string[];
  progress: { at: number; p: SpeedtestProgress }[];
  cfg: AppConfig;
  gaming: { value: boolean };
  client: { value: Omit<ClientState, 'ts'> | null };
  latest: { value: SpeedtestResult | null };
}

function fakeContext(): Fake {
  const bus = createBus();
  const logs: string[] = [];
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.speedtest = { downloadStreams: 3, uploadStreams: 2, idleSec: 0.3, downloadSec: 0.8, uploadSec: 0.8 };
  const f: Fake = {
    ctx: null as unknown as EngineContext,
    bus,
    line: new FakeLine(),
    inserted: [],
    events: [],
    activeCalls: [],
    logs,
    progress: [],
    cfg,
    gaming: { value: false },
    client: {
      value: {
        expectedIf: 'Ethernet',
        egressV4If: 'Ethernet',
        egressV6If: 'Ethernet',
        egressV4Address: '192.168.0.192',
        egressV6Address: null,
        onExpected: true,
        linkUp: true,
        linkMbps: 1000,
        rxMbps: 0.1,
        txMbps: 0.1,
        gaming: false,
        preventSleep: true,
      },
    },
    latest: { value: null },
  };
  let active = false;
  const db = stub<EngineDb>('db', {
    insertSpeedtest: (r) => {
      f.inserted.push(structuredClone(r));
      return f.inserted.length;
    },
    latestSpeedtest: () => f.latest.value,
    latestSnapshot: () => null,
  });
  f.ctx = stub<EngineContext>('ctx', {
    version: 'test',
    startedAt: Date.now(),
    log: createLog(logs),
    bus,
    db,
    config: () => cfg,
    session: () => null,
    isMeasuring: () => false,
    speedtestActive: () => active,
    setSpeedtestActive: (v) => {
      active = v;
      f.activeCalls.push(v);
    },
    gamingActive: () => f.gaming.value,
    clientState: () => (f.client.value ? { ...f.client.value, ts: Date.now() } : null),
    expectedInterface: () => 'Ethernet',
    recordEvent: (e) => {
      f.events.push(structuredClone(e));
      return f.events.length;
    },
  });
  bus.on('speedtest', (p) => f.progress.push({ at: performance.now(), p }));
  return f;
}

function moduleFor(f: Fake, extra: Parameters<typeof createSpeedtestModule>[0] = {}): EngineModule {
  return createSpeedtestModule({
    transport: () => fakeTransport(f.line, () => f.ctx),
    prober: () => fakeProber(f.line),
    rampMs: 150,
    probeIntervalMs: 20,
    drainMs: 80,
    scheduleCheckMs: 60_000,
    ...extra,
  });
}

/** 10 Hz stand-in for the pinger agent: gw flat, CMTS (isp6) rises under upload, cf4 follows the line. */
function startPinger(f: Fake): () => void {
  const timer = setInterval(() => {
    const ts = Date.now();
    const isp6 = f.line.activeUp > 0 ? 150 : f.line.activeDown > 0 ? 12 : 9;
    for (const [targetId, rtt] of [
      ['gw', 1],
      ['isp6', isp6],
      ['cf4', f.line.rtt() - 2],
      ['g4', 999], // not a layer target – ignored
    ] as const) {
      f.bus.emit('sample', { ts, targetId, rtt, status: SampleStatus.OK });
    }
  }, 100);
  return () => clearInterval(timer);
}

async function waitFor(cond: () => boolean, timeoutMs = 10_000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error('Zeitüberschreitung beim Warten');
    await new Promise((r) => setTimeout(r, 15));
  }
}

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

function setup(extra: Parameters<typeof createSpeedtestModule>[0] = {}): { f: Fake; mod: EngineModule } {
  const f = fakeContext();
  const mod = moduleFor(f, extra);
  void mod.init?.(f.ctx);
  cleanup.push(() => mod.dispose?.());
  return { f, mod };
}

// ─── tests ─────────────────────────────────────────────────────────────────

describe('speedtest module: manual run', () => {
  it('runs idle → download → upload and stores result, event and progress', async () => {
    const { f, mod } = setup();
    cleanup.push(startPinger(f));
    // manual runs ignore the skip rules (gaming, quiet hours) – only "already running" blocks
    f.gaming.value = true;
    f.cfg.schedules.speedtestQuietHours = { from: 0, to: 24 };

    await expect(mod.runNow?.()).resolves.toEqual({ started: true });
    await expect(mod.runNow?.()).rejects.toThrow('Ein Speedtest läuft bereits');
    expect(mod.state().busy).toBe(true);
    await waitFor(() => f.inserted.length === 1 && mod.state().busy === false);

    const r = f.inserted[0];
    expect(r.trigger).toBe('manual');
    expect(r.server).toBe('Cloudflare DUS');
    expect(r.streams).toBe(3);
    expect(r.nicLinkMbps).toBe(1000);
    expect(r.error).toBeNull();
    // 25 MB downloads / 10 MB uploads never complete within 0.8 s – in-flight bytes still count
    expect(f.line.calls.download).toBe(3);
    expect(f.line.calls.upload).toBe(2);
    expect(r.downMbps ?? 0).toBeGreaterThan(80 * 0.7);
    expect(r.downMbps ?? 0).toBeLessThan(80 * 1.3);
    expect(r.upMbps ?? 0).toBeGreaterThan(40 * 0.7);
    expect(r.upMbps ?? 0).toBeLessThan(40 * 1.3);
    expect(r.bytesDown).toBeGreaterThan(0);
    expect(r.bytesUp).toBeGreaterThan(0);
    expect(r.idleLatencyMs).toBe(20);
    expect(r.loadedDownLatencyMs).toBe(45);
    expect(r.loadedUpLatencyMs).toBe(180);
    expect(r.grade).toBe('C');
    expect(r.series.some((p) => p.phase === 'download' && typeof p.mbps === 'number')).toBe(true);
    expect(r.series.some((p) => p.phase === 'idle' && p.rtt === 20)).toBe(true);

    // event
    expect(f.events).toHaveLength(1);
    const e = f.events[0];
    expect(e).toMatchObject({ type: 'speedtest', source: 'speedtest', ts: r.ts, endTs: r.endTs, severity: 'warn', segment: 'docsis' });
    expect(e.title).toMatch(/^Speedtest: ↓ \d+ Mbit\/s · ↑ \d+ Mbit\/s · Bufferbloat C$/);
    expect(e.details).toMatchObject({ grade: 'C', limitedByLink: false, speedtestId: 1, gradePhase: 'upload', latencySource: 'udp', pop: 'dus01' });
    expect(e.details?.bottleneck).toMatchObject({ layer: 'isp6', label: 'Kabelmodem/DOCSIS-Upstream', phase: 'upload' });

    // load flag only around the load phases
    expect(f.activeCalls).toEqual([true, false]);
    expect(f.line.activeAtLoad.every(Boolean)).toBe(true);
    expect(f.line.calls.disposed).toBe(1);
    expect(f.line.activeDown + f.line.activeUp).toBe(0);

    // progress: ≤ 4 messages/s, phases in order, final message carries the result
    const msgs = f.progress;
    for (let i = 1; i < msgs.length; i++) expect(msgs[i].at - msgs[i - 1].at).toBeGreaterThanOrEqual(235);
    const phases = msgs.map((m) => m.p.phase).filter((p, i, a) => i === 0 || a[i - 1] !== p);
    expect(phases).toEqual(['idle', 'download', 'upload', 'done']);
    const last = msgs.at(-1)?.p;
    expect(last).toMatchObject({ running: false, phase: 'done', progress: 1 });
    expect(last?.result?.id).toBe(1);
    const running = msgs.filter((m) => m.p.running).map((m) => m.p.progress);
    for (let i = 1; i < running.length; i++) expect(running[i]).toBeGreaterThanOrEqual(running[i - 1]);
    expect(msgs.some((m) => m.p.phase === 'download' && (m.p.currentMbps ?? 0) > 10)).toBe(true);

    expect(mod.state()).toMatchObject({ name: 'speedtest', busy: false, lastRunTs: r.ts, lastError: null, running: false, nextRunTs: null });
  }, 20_000);

  it('retries HTTP 429 on the preflight honouring Retry-After and flags a 100-Mbit/s link', async () => {
    const { f, mod } = setup();
    f.line.downMbps = 92;
    f.client.value = { ...(f.client.value as Omit<ClientState, 'ts'>), linkMbps: 100 };
    const rl: PreflightInfo = { status: 429, colo: null, family: null, retryAfterMs: 10 };
    f.line.preflight = [rl, rl];
    await mod.runNow?.();
    await waitFor(() => f.inserted.length === 1);
    expect(f.line.calls.preflight).toBe(3);
    const r = f.inserted[0];
    expect(r.error).toBeNull();
    expect(r.nicLinkMbps).toBe(100);
    // timing-based fake: ≈ 92 Mbit/s – the flag must agree with the measured value (the exact
    // threshold logic is covered deterministically in speed-result.test.ts)
    const limited = (r.downMbps ?? 0) >= 85;
    expect(f.events[0].details?.limitedByLink).toBe(limited);
    expect(f.events[0].title.includes('(durch 100-Mbit/s-Link begrenzt)')).toBe(limited);
    expect(f.events[0].severity).toBe('warn'); // grade C (and the 100-Mbit/s link when limited)
    expect(f.logs.some((l) => l.includes('rate limited (HTTP 429)'))).toBe(true);
  }, 20_000);

  it('gives up after 3 retries on 429 without loading the line', async () => {
    const { f, mod } = setup();
    const rl: PreflightInfo = { status: 429, colo: null, family: null, retryAfterMs: 5 };
    f.line.preflight = [rl, rl, rl, rl];
    await mod.runNow?.();
    await waitFor(() => f.inserted.length === 1 && !mod.state().busy);
    const r = f.inserted[0];
    expect(r.error).toBe('Cloudflare-Speedtest vorübergehend gesperrt (HTTP 429 – zu viele Anfragen)');
    expect(r).toMatchObject({ downMbps: null, upMbps: null, grade: null });
    expect(f.line.calls.preflight).toBe(4);
    expect(f.line.calls.download).toBe(0);
    expect(f.activeCalls).toEqual([]);
    expect(f.events[0]).toMatchObject({ severity: 'warn', title: `Speedtest fehlgeschlagen: ${r.error}` });
    expect(f.progress.at(-1)?.p).toMatchObject({ running: false, phase: 'error', error: r.error });
    expect(mod.state().lastError).toBe(r.error);
  }, 20_000);

  it('retries rate-limited load requests and reports a phase that stays rate limited', async () => {
    const { f, mod } = setup();
    f.line.downStatuses = [429, 429, 429];
    await mod.runNow?.();
    await waitFor(() => f.inserted.length === 1);
    expect(f.inserted[0].downMbps ?? 0).toBeGreaterThan(30);
    expect(f.line.calls.download).toBe(6);

    const second = setup();
    second.f.line.down429Forever = true;
    await second.mod.runNow?.();
    await waitFor(() => second.f.inserted.length === 1);
    const r = second.f.inserted[0];
    expect(r.downMbps).toBeNull();
    expect(r.upMbps ?? 0).toBeGreaterThan(20);
    expect(r.error).toBe('Download fehlgeschlagen (HTTP 429 – zu viele Anfragen)');
    // 3 streams × (1 + 3 retries)
    expect(second.f.line.calls.download).toBe(12);
  }, 30_000);

  it('falls back to the pinger cf4 samples when UDP probing is unavailable', async () => {
    const { f, mod } = setup();
    cleanup.push(startPinger(f));
    f.line.udpBroken = true;
    await mod.runNow?.();
    await waitFor(() => f.inserted.length === 1);
    const r = f.inserted[0];
    expect(f.events[0].details?.latencySource).toBe('icmp');
    expect(r.idleLatencyMs).toBe(18);
    expect(r.loadedUpLatencyMs).toBe(178);
    expect(r.grade).toBe('C');
    expect(f.logs.some((l) => l.includes('UDP latency probe unavailable'))).toBe(true);
  }, 20_000);
});

describe('speedtest module: abort', () => {
  it('stop() aborts a running test, releases the load flag and stores the aborted run', async () => {
    const { f, mod } = setup();
    f.cfg.speedtest.downloadSec = 5;
    await mod.runNow?.();
    await waitFor(() => f.line.activeDown > 0);
    const t0 = performance.now();
    await mod.stop?.();
    expect(performance.now() - t0).toBeLessThan(4500);
    expect(mod.state().busy).toBe(false);
    expect(f.line.activeDown + f.line.activeUp).toBe(0);
    expect(f.activeCalls).toEqual([true, false]);
    expect(f.inserted).toHaveLength(1);
    expect(f.inserted[0]).toMatchObject({ error: 'Abgebrochen', downMbps: null, upMbps: null });
    expect(f.events[0]).toMatchObject({ title: 'Speedtest abgebrochen', severity: 'info' });
    expect(f.progress.at(-1)?.p).toMatchObject({ running: false, phase: 'error' });
    // a new manual run is possible afterwards
    f.cfg.speedtest.downloadSec = 0.5;
    await expect(mod.runNow?.()).resolves.toEqual({ started: true });
    await waitFor(() => f.inserted.length === 2);
  }, 20_000);

  it('dispose() aborts and unsubscribes from the bus', async () => {
    const f = fakeContext();
    const mod = moduleFor(f);
    await mod.init?.(f.ctx);
    expect(f.bus.count('sample')).toBe(1);
    expect(f.bus.count('incident')).toBe(1);
    f.cfg.speedtest.idleSec = 5;
    await mod.runNow?.();
    await mod.dispose?.();
    expect(f.bus.count('sample')).toBe(0);
    expect(f.bus.count('client')).toBe(0);
    expect(f.bus.count('adapters')).toBe(0);
    expect(f.inserted[0]?.error).toBe('Abgebrochen');
    expect(f.activeCalls).toEqual([]);
  }, 20_000);
});

describe('speedtest module: schedule', () => {
  const hoursAgo = (h: number): SpeedtestResult => ({
    ts: Date.now() - h * 3600_000,
    endTs: Date.now() - h * 3600_000 + 40_000,
    trigger: 'schedule',
    server: 'Cloudflare DUS',
    downMbps: 90,
    upMbps: 45,
    idleLatencyMs: 18,
    idleJitterMs: 2,
    loadedDownLatencyMs: 40,
    loadedDownP95Ms: 50,
    loadedUpLatencyMs: 120,
    loadedUpP95Ms: 150,
    bloatDownMs: 22,
    bloatUpMs: 102,
    grade: 'C',
    bytesDown: 1,
    bytesUp: 1,
    streams: 6,
    nicLinkMbps: 1000,
    error: null,
    series: [],
  });

  function scheduled(prepare: (f: Fake) => void): { f: Fake; mod: EngineModule } {
    const f = fakeContext();
    f.latest.value = hoursAgo(4);
    f.cfg.schedules.speedtestQuietHours = null; // the default 18–23 Uhr depends on the wall clock
    prepare(f);
    const mod = moduleFor(f, { scheduleCheckMs: 25, firstRunDelayMs: 0 });
    void mod.init?.(f.ctx);
    cleanup.push(() => mod.dispose?.());
    void mod.start?.();
    return { f, mod };
  }

  it('starts a scheduled run when due and plans the next one', async () => {
    const { f, mod } = scheduled(() => undefined);
    expect(mod.state().running).toBe(true);
    await waitFor(() => f.inserted.length === 1 && !mod.state().busy);
    expect(f.inserted[0].trigger).toBe('schedule');
    const next = mod.state().nextRunTs ?? 0;
    expect(next - f.inserted[0].ts).toBeGreaterThanOrEqual(180 * 60_000 - 5000);
    await mod.stop?.();
    expect(mod.state()).toMatchObject({ running: false, nextRunTs: null });
  }, 20_000);

  it.each<[string, (f: Fake) => void, string]>([
    ['gaming', (f) => (f.gaming.value = true), 'Spiel läuft'],
    ['quiet hours', (f) => (f.cfg.schedules.speedtestQuietHours = { from: 0, to: 24 }), 'Ruhezeit (0–24 Uhr)'],
    ['link down', (f) => (f.client.value = { ...(f.client.value as Omit<ClientState, 'ts'>), linkUp: false }), 'Netzwerkverbindung getrennt'],
  ])('skips a due run while %s', async (_name, prepare, reason) => {
    const { f, mod } = scheduled(prepare);
    await waitFor(() => f.logs.some((l) => l.includes('scheduled speed test skipped')));
    expect(f.logs.find((l) => l.includes('skipped'))).toContain(reason);
    await new Promise((r) => setTimeout(r, 100));
    expect(f.inserted).toHaveLength(0);
    expect(mod.state().nextRunTs ?? 0).toBeGreaterThan(Date.now() + 9 * 60_000);
  });

  it('skips during an outage and runs after it ended', async () => {
    const f = fakeContext();
    f.latest.value = hoursAgo(4);
    f.cfg.schedules.speedtestQuietHours = null;
    const mod = moduleFor(f, { scheduleCheckMs: 25, firstRunDelayMs: 0 });
    await mod.init?.(f.ctx);
    cleanup.push(() => mod.dispose?.());
    f.bus.emit('incident', { kind: 'outage-start', ts: Date.now(), classification: 'docsis' });
    await mod.start?.();
    await waitFor(() => f.logs.some((l) => l.includes('Ausfall läuft')));
    f.bus.emit('incident', { kind: 'outage-end', ts: Date.now(), classification: 'docsis' });
    await mod.stop?.(); // retry is 10 min away – restart the session to re-plan
    await mod.start?.();
    await waitFor(() => f.inserted.length === 1);
    expect(f.inserted[0].trigger).toBe('schedule');
  }, 20_000);

  it('respects the interval since the last run and the enable switch', async () => {
    const recent = scheduled((f) => (f.latest.value = hoursAgo(0.5)));
    const st = recent.mod.state();
    expect(st.lastRunTs).toBe(recent.f.latest.value?.ts);
    expect((st.nextRunTs ?? 0) - (recent.f.latest.value?.ts ?? 0)).toBe(180 * 60_000);

    const off = scheduled((f) => (f.cfg.schedules.speedtestEnabled = false));
    await new Promise((r) => setTimeout(r, 150));
    expect(off.f.inserted).toHaveLength(0);
    expect(off.mod.state()).toMatchObject({ enabled: false, nextRunTs: null });
    expect(recent.f.inserted).toHaveLength(0);
  });
});
