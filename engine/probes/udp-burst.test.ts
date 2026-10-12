import { afterEach, describe, expect, it, vi } from 'vitest';
import { metricDef, udpBurstKey } from '../../src/lib/shared/metrics';
import { SampleStatus } from '../../src/lib/shared/types';
import { type DnsClientLike, burstMetrics, computeBurstStats, createUdpBurstModule, runUdpBurst } from './udp-burst';
import type { DnsProbeResult, DnsQuestionSpec } from './udp-dns';
import { fakeProbeContext, testConfig } from './test-helpers';

describe('computeBurstStats', () => {
  it('computes loss, latency percentiles and chain jitter (a loss breaks the chain)', () => {
    const s = computeBurstStats('cf4-udp', [20, 22, null, 30, 26, 24, null, null, 21, 23], 'dus01');
    expect(s).toMatchObject({ targetId: 'cf4-udp', sent: 10, received: 7, lossPct: 30, pop: 'dus01', maxMs: 30, p50Ms: 23 });
    expect(s.avgMs).toBe(23.71);
    // pairs: 20→22, 30→26, 26→24, 21→23 → (2 + 4 + 2 + 2) / 4
    expect(s.jitterMs).toBe(2.5);
    expect(s.p99Ms).toBeCloseTo(29.76, 2);
  });

  it('handles empty and all-lost bursts', () => {
    expect(computeBurstStats('x', [])).toMatchObject({ sent: 0, lossPct: 0, avgMs: null, p99Ms: null, jitterMs: null });
    expect(computeBurstStats('x', [null, null])).toMatchObject({ sent: 2, received: 0, lossPct: 100, avgMs: null, jitterMs: null });
  });
});

describe('burstMetrics', () => {
  it('writes the registered dynamic keys and omits unknown statistics', () => {
    const pts = burstMetrics(5000, computeBurstStats('cf6-udp', [10, 12, 11]));
    expect(pts.map((p) => p.key)).toEqual([
      udpBurstKey('cf6-udp', 'loss_pct'),
      udpBurstKey('cf6-udp', 'avg_ms'),
      udpBurstKey('cf6-udp', 'p99_ms'),
      udpBurstKey('cf6-udp', 'jitter_ms'),
    ]);
    expect(pts.every((p) => p.ts === 5000 && metricDef(p.key) !== null)).toBe(true);
    expect(burstMetrics(1, computeBurstStats('x', [null])).map((p) => p.key)).toEqual(['udp.burst.x.loss_pct']);
  });
});

/** Fake DNS client: answers after `rtt(k)` ms (null = lost); records send times. */
class FakeClient implements DnsClientLike {
  sends: number[] = [];
  closed = false;
  private n = 0;
  constructor(private readonly rtt: (k: number) => number | null) {}
  query(timeoutMs: number): Promise<DnsProbeResult> {
    const k = this.n++;
    this.sends.push(Date.now());
    const r = this.rtt(k);
    return new Promise((resolve) => {
      if (r === null) {
        setTimeout(() => resolve({ status: SampleStatus.TIMEOUT, rtt: null, rcode: null, txt: [], first: k === 0 }), timeoutMs);
      } else {
        setTimeout(() => resolve({ status: SampleStatus.OK, rtt: r, rcode: 0, txt: ['dus01'], first: k === 0 }), r);
      }
    });
  }
  close(): void {
    this.closed = true;
  }
}

describe('runUdpBurst', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends pps × duration queries after one uncounted warm-up, evenly spaced', async () => {
    vi.useFakeTimers({ now: 1_791_550_560_000 });
    const client = new FakeClient((k) => (k === 0 ? 80 : k % 10 === 0 ? null : 20));
    const q: DnsQuestionSpec = { name: 'id.server', type: 16, cls: 3 };
    const p = runUdpBurst({ server: '1.1.1.1', port: 53, family: 4, question: q, pps: 20, durationSec: 2, timeoutMs: 2000, createClient: () => client, now: () => Date.now() });
    await vi.advanceTimersByTimeAsync(10_000);
    const r = await p;
    expect(client.sends).toHaveLength(41);
    expect(r.rtts).toHaveLength(40);
    expect(r.rtts.filter((x) => x === null)).toHaveLength(4); // k = 10, 20, 30, 40 lost
    expect(r).toMatchObject({ pop: 'dus01', aborted: false });
    const gaps = client.sends.slice(2).map((t, i) => t - client.sends[i + 1]);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(49);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(51);
    expect(client.closed).toBe(true);
  });

  it('stops early when asked to abort', async () => {
    vi.useFakeTimers({ now: 1_791_550_560_000 });
    const client = new FakeClient(() => 5);
    let abort = false;
    setTimeout(() => (abort = true), 300);
    const p = runUdpBurst({
      server: '::1', port: 53, family: 6, question: { name: 'id.server', type: 16, cls: 3 },
      pps: 10, durationSec: 10, timeoutMs: 1000, shouldAbort: () => abort, createClient: () => client, now: () => Date.now(),
    });
    await vi.advanceTimersByTimeAsync(5000);
    const r = await p;
    expect(r.aborted).toBe(true);
    expect(r.rtts.length).toBeLessThan(10);
  });
});

describe('udpburst module', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function setup(patch?: Parameters<typeof testConfig>[0]) {
    const fake = fakeProbeContext({ config: testConfig(patch) });
    const clients: { server: string; family: number; client: FakeClient }[] = [];
    const mod = createUdpBurstModule({
      firstRunDelayMs: 1000,
      now: () => Date.now(),
      createClient: (server, _port, family) => {
        const client = new FakeClient(() => 15);
        clients.push({ server, family, client });
        return client;
      },
    });
    mod.init?.(fake.ctx);
    return { fake, mod, clients };
  }

  it('bursts every enabled udp-dns internet target and records 4 metrics each', async () => {
    vi.useFakeTimers({ now: 1_791_550_560_000 });
    const { fake, mod, clients } = setup((c) => {
      c.udpBurst = { packetsPerSecond: 10, durationSec: 3 };
    });
    const p = mod.runNow?.();
    expect(mod.state().busy).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    const res = (await p) as { ok: boolean; result?: { targets: { targetId: string; sent: number; pop: string | null }[] } };
    expect(res.ok).toBe(true);
    // gw-dns (segment router) is not part of the burst
    expect(clients.map((c) => [c.server, c.family])).toEqual([['1.1.1.1', 4], ['2606:4700:4700::1111', 6]]);
    expect(res.result?.targets.map((t) => [t.targetId, t.sent, t.pop])).toEqual([['cf4-udp', 30, 'dus01'], ['cf6-udp', 30, 'dus01']]);
    expect(fake.metrics.map((m) => m.key).sort()).toEqual(
      ['cf4-udp', 'cf6-udp'].flatMap((id) => (['avg_ms', 'jitter_ms', 'loss_pct', 'p99_ms'] as const).map((s) => udpBurstKey(id, s))).sort(),
    );
    expect(mod.state()).toMatchObject({ busy: false, lastError: null });
  });

  it('is skipped while a speed test runs and discarded when one starts meanwhile', async () => {
    vi.useFakeTimers({ now: 1_791_550_560_000 });
    const { fake, mod } = setup();
    fake.setSpeedtest(true);
    expect(await mod.runNow?.()).toEqual({ ok: false, error: 'Übersprungen: Speedtest läuft' });
    fake.setSpeedtest(false);
    const p = mod.runNow?.();
    setTimeout(() => fake.setSpeedtest(true), 2000);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await p).toEqual({ ok: false, error: 'Abgebrochen: Speedtest gestartet' });
    expect(fake.metrics).toHaveLength(0);
  });

  it('reports targets whose host is unknown and runs the rest', async () => {
    vi.useFakeTimers({ now: 1_791_550_560_000 });
    const { fake, mod } = setup((c) => {
      c.udpBurst = { packetsPerSecond: 5, durationSec: 3 };
      const t = c.targets.find((x) => x.id === 'cf6-udp');
      if (t) t.host = '$isp6';
    });
    const p = mod.runNow?.();
    await vi.advanceTimersByTimeAsync(10_000);
    const res = (await p) as { ok: boolean; result?: { skipped: { targetId: string; reason: string }[] } };
    expect(res.ok).toBe(true);
    expect(res.result?.skipped).toEqual([{ targetId: 'cf6-udp', reason: 'Wird bei der nächsten Pfaderkennung ermittelt (Kopfstation)' }]);
    expect(fake.metrics.every((m) => m.key.startsWith('udp.burst.cf4-udp.'))).toBe(true);
  });

  it('runs on schedule during a session only', async () => {
    vi.useFakeTimers({ now: 1_791_550_560_000 });
    const { fake, mod } = setup((c) => {
      c.udpBurst = { packetsPerSecond: 5, durationSec: 3 };
      c.schedules.udpBurstEveryMin = 1;
    });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fake.metrics).toHaveLength(0);
    mod.start?.();
    expect(mod.state()).toMatchObject({ running: true });
    expect(mod.state().nextRunTs).toBe(Date.now() + 1000);
    await vi.advanceTimersByTimeAsync(6000);
    expect(fake.metrics.length).toBe(8);
    // the next run is due one interval after the previous run ended (≈ 3 s burst)
    await vi.advanceTimersByTimeAsync(64_000);
    expect(fake.metrics.length).toBe(16);
    mod.stop?.();
    expect(mod.state()).toMatchObject({ running: false, nextRunTs: null });
    await vi.advanceTimersByTimeAsync(180_000);
    expect(fake.metrics.length).toBe(16);
  });

  it('without any udp-dns internet target it reports a German error', async () => {
    const { mod } = setup((c) => {
      for (const t of c.targets) if (t.kind === 'udp-dns') t.enabled = false;
    });
    expect(await mod.runNow?.()).toEqual({ ok: false, error: 'Kein aktives UDP-Ziel (Internet) konfiguriert' });
  });
});
