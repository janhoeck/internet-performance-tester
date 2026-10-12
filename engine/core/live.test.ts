import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientState, EngineStatus, LiveMessage, Sample } from '../../src/lib/shared/types';
import { createBus } from './bus';
import { LiveBatcher, LiveHub, SSE_HEARTBEAT, SSE_RETRY, sseData, type LiveClient } from './live';
import { silentLogger } from './logger';

const status: EngineStatus = {
  version: '0.1.0', pid: 1, startedAt: 0, now: 0, session: null, probes: [], modules: [],
  dynamicHosts: { gateway: '192.168.0.1', isp4: null, isp6: null, aftr: null, router6: null },
  client: null, speedtest: null, dbPath: 'x.db', dbSizeBytes: null,
};

const sample = (ts: number, targetId = 'cf4'): Sample => ({ ts, targetId, rtt: 18.5, status: 0 });

function client(ts: number): ClientState {
  return {
    ts, expectedIf: 'Ethernet', egressV4If: 'Ethernet', egressV6If: 'Ethernet', egressV4Address: '192.168.0.192', egressV6Address: null,
    onExpected: true, linkUp: true, linkMbps: 1000, rxMbps: 0.1, txMbps: 0.05, gaming: false, preventSleep: true,
  };
}

/** collects the raw stream and parses the data messages */
function recorder() {
  const chunks: string[] = [];
  let closed = false;
  const c: LiveClient = {
    write: (s) => {
      if (closed) throw new Error('closed');
      chunks.push(s);
    },
    close: () => {
      closed = true;
    },
  };
  const messages = (): LiveMessage[] =>
    chunks.filter((s) => s.startsWith('data: ')).map((s) => JSON.parse(s.slice(6)) as LiveMessage);
  return { c, chunks, messages, isClosed: () => closed };
}

describe('SSE framing', () => {
  it('formats one data line per message terminated by a blank line', () => {
    const s = sseData({ type: 'session', data: null });
    expect(s).toBe('data: {"type":"session","data":null}\n\n');
    const multi = sseData({ type: 'event', data: { ts: 1, type: 'note', severity: 'info', title: 'Zeile 1\nZeile 2', source: 'user' } });
    expect(multi.split('\n')).toHaveLength(3); // newline inside JSON is escaped
    expect(SSE_RETRY).toBe('retry: 3000\n\n');
    expect(SSE_HEARTBEAT).toBe(': hb\n\n');
  });
});

describe('LiveBatcher', () => {
  it('collects samples/metrics and keeps only the latest client state', () => {
    const b = new LiveBatcher();
    expect(b.takeSamples()).toBeNull();
    b.addSample(sample(1));
    b.addSample(sample(2));
    b.addMetrics([{ ts: 1, key: 'sys.cpu_pct', value: 5 }]);
    b.setClient(client(1));
    b.setClient(client(2));
    expect(b.takeSamples()).toEqual({ type: 'samples', data: [sample(1), sample(2)] });
    expect(b.takeSamples()).toBeNull();
    expect(b.takeMetrics()).toEqual({ type: 'metrics', data: [{ ts: 1, key: 'sys.cpu_pct', value: 5 }] });
    expect(b.takeClient()).toEqual({ type: 'client', data: client(2) });
    expect(b.takeClient()).toBeNull();
  });

  it('caps the sample buffer', () => {
    const b = new LiveBatcher();
    for (let i = 0; i < 20_010; i++) b.addSample(sample(i));
    const msg = b.takeSamples();
    expect(msg?.type === 'samples' && msg.data.length).toBe(20_000);
    expect(msg?.type === 'samples' && msg.data[0].ts).toBe(10);
    expect(b.dropped).toBe(10);
  });
});

describe('LiveHub', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup() {
    const log = silentLogger();
    const bus = createBus(log);
    let statusCalls = 0;
    const hub = new LiveHub({ bus, log, status: () => ({ ...status, now: ++statusCalls }) });
    return { bus, hub };
  }

  it('sends retry + hello on connect and batches per message type', () => {
    const { bus, hub } = setup();
    const r = recorder();
    hub.add(r.c);
    expect(r.chunks[0]).toBe(SSE_RETRY);
    expect(r.messages()[0]).toMatchObject({ type: 'hello', data: { version: '0.1.0' } });

    bus.emit('sample', sample(1000));
    bus.emit('sample', sample(1000, 'gw'));
    bus.emit('metrics', [{ ts: 1000, key: 'engine.loop_lag_ms', value: 1.2 }]);
    bus.emit('client', client(1000));
    bus.emit('client', client(1001));
    expect(r.messages()).toHaveLength(1);

    vi.advanceTimersByTime(500);
    let msgs = r.messages();
    expect(msgs.at(-1)).toEqual({ type: 'samples', data: [sample(1000), sample(1000, 'gw')] });

    vi.advanceTimersByTime(500); // t = 1 s → client
    msgs = r.messages();
    expect(msgs.filter((m) => m.type === 'client')).toEqual([{ type: 'client', data: client(1001) }]);

    vi.advanceTimersByTime(1000); // t = 2 s → metrics
    expect(r.messages().filter((m) => m.type === 'metrics')).toHaveLength(1);
    expect(r.messages().filter((m) => m.type === 'samples')).toHaveLength(1); // empty batches are not sent

    vi.advanceTimersByTime(3000); // t = 5 s → status
    expect(r.messages().filter((m) => m.type === 'status')).toHaveLength(1);

    vi.advanceTimersByTime(10_000); // t = 15 s → heartbeat
    expect(r.chunks.filter((c) => c === SSE_HEARTBEAT)).toHaveLength(1);
  });

  it('forwards events, speed test progress, traceroutes, router status and sessions immediately', () => {
    const { bus, hub } = setup();
    const r = recorder();
    hub.add(r.c);
    bus.emit('event', { id: 1, ts: 1, type: 'note', severity: 'info', title: 'Lag jetzt', source: 'user' });
    bus.emit('speedtest', { running: true, phase: 'download', progress: 0.3, currentMbps: 94, currentRtt: 40 });
    bus.emit('session', null);
    bus.emit('traceroute', { ts: 1, target: '1.1.1.1', family: 4, hops: [], reached: true, pathHash: 'x', changed: false, trigger: 'manual', durationMs: 5 });
    expect(r.messages().map((m) => m.type)).toEqual(['hello', 'event', 'speedtest', 'session', 'traceroute']);
  });

  it('broadcasts to all clients, removes failing ones and cleans up when the last leaves', () => {
    const { bus, hub } = setup();
    const a = recorder();
    const b = recorder();
    const removeA = hub.add(a.c);
    hub.add(b.c);
    expect(hub.size).toBe(2);
    expect(bus.listenerCount('sample')).toBe(1); // one subscription for all clients

    b.c.close(); // b's next write throws
    bus.emit('session', null);
    expect(hub.size).toBe(1);
    expect(a.messages().at(-1)).toEqual({ type: 'session', data: null });

    removeA();
    removeA(); // idempotent
    expect(hub.size).toBe(0);
    expect(bus.listenerCount('sample')).toBe(0);
    expect(bus.listenerCount('event')).toBe(0);
    bus.emit('sample', sample(1)); // no buffering without clients
    const c = recorder();
    hub.add(c.c);
    vi.advanceTimersByTime(500);
    expect(c.messages().filter((m) => m.type === 'samples')).toHaveLength(0);
  });

  it('close() ends all streams and rejects new clients', () => {
    const { hub } = setup();
    const a = recorder();
    hub.add(a.c);
    hub.close();
    expect(a.isClosed()).toBe(true);
    const b = recorder();
    hub.add(b.c);
    expect(b.isClosed()).toBe(true);
    expect(hub.size).toBe(0);
  });
});
