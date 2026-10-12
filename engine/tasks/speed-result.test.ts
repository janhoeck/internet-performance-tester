import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ByteSample } from '../../src/lib/shared/grading';
import { SampleStatus } from '../../src/lib/shared/types';
import {
  ByteBins,
  type LayerPoint,
  type LoadPhaseData,
  type ProbePoint,
  type SpeedRunData,
  layerPointFromSample,
  summarizeSpeedRun,
} from './speed-result';

/** Real idle RTTs of this machine (.NET pinger capture): 1.1.1.1, gateway, Cloudflare IPv6. */
function fixtureRtts(target: string): number[] {
  const url = new URL('../../fixtures/windows/dotnet_pinger_stream.json', import.meta.url);
  const raw: unknown = JSON.parse(readFileSync(url, 'utf8'));
  const recs = typeof raw === 'object' && raw !== null && 'recs' in raw && Array.isArray(raw.recs) ? (raw.recs as unknown[]) : [];
  const out: number[] = [];
  for (const r of recs) {
    if (typeof r !== 'object' || r === null) continue;
    const rec = r as Record<string, unknown>;
    if (rec.type === 'echo' && rec.target === target && rec.status === 'Success' && typeof rec.rtt === 'number') out.push(rec.rtt);
  }
  return out;
}

const CF4 = fixtureRtts('1.1.1.1'); // 18, 24, 14, 15, 31, 17, 17, 19, 20
const GW = fixtureRtts('192.168.0.1'); // 1, 1, 2, 1, 1, 1, 1, 1, 0
const CF6 = fixtureRtts('2606:4700:4700::1111');
const cycle = (arr: number[], i: number) => arr[i % arr.length];

// live-check timing: idle 3 s, download 6 s, upload 6 s (ms since test start)
const IDLE = { start: 0, end: 3000, complete: true };
const DOWN = { start: 3000, end: 9000, complete: true };
const UP = { start: 9100, end: 15_100, complete: true };

function bytes(from: number, to: number, mbps: number, binMs = 50): ByteSample[] {
  const out: ByteSample[] = [];
  for (let t = from; t < to; t += binMs) out.push({ t: t + binMs / 2, bytes: (mbps * 1e6 * binMs) / 8000 });
  return out;
}

function phase(window: LoadPhaseData['window'], rampMbps: number, mbps: number, extra: Partial<LoadPhaseData> = {}): LoadPhaseData {
  const b = [...bytes(window.start, window.start + 3000, rampMbps), ...bytes(window.start + 3000, window.end, mbps)];
  return {
    window,
    bytes: b,
    totalBytes: b.reduce((s, x) => s + x.bytes, 0),
    ok: true,
    error: null,
    rateLimited: false,
    capReached: false,
    ...extra,
  };
}

/** UDP id.server probes every 200 ms: real idle RTTs, then constant loaded values. */
function probes(downRtt: number, upRtt: number): ProbePoint[] {
  const out: ProbePoint[] = [];
  let i = 0;
  for (let t = 0; t <= 15_000; t += 200, i++) {
    const p = t <= IDLE.end ? 'idle' : t < UP.start ? 'download' : 'upload';
    const rtt = p === 'idle' ? cycle(CF4, i) : p === 'download' ? downRtt : upRtt;
    out.push({ t, phase: p, rtt, done: true });
  }
  return out;
}

/** 1 Hz pinger samples per layer target; `rise(target, phase)` is added to the real idle value. */
function layers(rise: (target: string, phase: 'idle' | 'download' | 'upload') => number): LayerPoint[] {
  const out: LayerPoint[] = [];
  const idle: Record<string, number[]> = { gw: GW, isp6: [9, 10, 9, 8, 11], aftr: CF6.map((v) => v - 6), cf4: CF4 };
  let k = 0;
  for (let t = 0; t <= 15_000; t += 1000, k++) {
    const p = t <= IDLE.end ? 'idle' : t < UP.start ? 'download' : 'upload';
    for (const target of ['gw', 'isp6', 'aftr', 'cf4']) {
      out.push({ target, t, rtt: cycle(idle[target], k) + rise(target, p) });
    }
  }
  return out;
}

function run(p: Partial<SpeedRunData> = {}): SpeedRunData {
  return {
    ts: 1_791_550_573_000,
    endTs: 1_791_550_591_000,
    trigger: 'manual',
    server: 'Cloudflare DUS',
    colo: 'DUS',
    family: 6,
    pop: 'dus01',
    idle: IDLE,
    download: phase(DOWN, 40, 94),
    upload: phase(UP, 20, 48),
    probes: probes(60, 170),
    layerSamples: layers((target, ph) => {
      if (ph === 'download') return target === 'gw' ? 0.5 : 30; // CMTS downstream queue
      if (ph === 'upload') return target === 'gw' ? 0 : 140; // modem upstream buffer
      return 0;
    }),
    downloadStreams: 3,
    uploadStreams: 3,
    nicLinkMbps: 100,
    error: null,
    aborted: false,
    rampMs: 3000,
    ...p,
  };
}

describe('ByteBins', () => {
  it('bins bytes, reports the current rate and samples at bin centres', () => {
    const b = new ByteBins(50);
    b.add(10, 1000);
    b.add(40, 1000);
    b.add(60, 500);
    b.add(Number.NaN, 99);
    b.add(70, 0);
    expect(b.total).toBe(2500);
    expect(b.samples()).toEqual([
      { t: 25, bytes: 2000 },
      { t: 75, bytes: 500 },
    ]);
    expect(b.bytesSince(50)).toBe(500);
    // 125 kB within the last second = 1 Mbit/s
    const r = new ByteBins();
    for (let t = 0; t < 1000; t += 10) r.add(t, 1250);
    expect(r.rateMbps(1000)).toBeCloseTo(1, 9);
  });
});

describe('layerPointFromSample', () => {
  it('maps a pinger sample onto the test timeline', () => {
    const ts = 1_791_550_573_000;
    expect(layerPointFromSample({ ts: ts + 2000, targetId: 'gw', rtt: 1, status: SampleStatus.OK }, ts)).toEqual({ target: 'gw', t: 2000, rtt: 1 });
    expect(layerPointFromSample({ ts: ts + 3000, targetId: 'isp6', rtt: null, status: SampleStatus.TIMEOUT }, ts).rtt).toBeNull();
    expect(layerPointFromSample({ ts, targetId: 'cf4', rtt: 25, status: SampleStatus.ERROR }, ts).rtt).toBeNull();
  });
});

describe('summarizeSpeedRun', () => {
  it('computes throughput, loaded latency, grade, bottleneck and link limit', () => {
    const s = summarizeSpeedRun(run());
    const r = s.result;
    expect(r.downMbps).toBeCloseTo(94, 6);
    expect(r.upMbps).toBeCloseTo(48, 6);
    expect(r.server).toBe('Cloudflare DUS');
    expect(r.trigger).toBe('manual');
    expect(r.streams).toBe(3);
    expect(r.nicLinkMbps).toBe(100);
    // idle = 16 real probes (0…3000 ms): median 17.5, mean 19.4375
    expect(r.idleLatencyMs).toBe(17.5);
    expect(r.loadedDownLatencyMs).toBe(60);
    expect(r.loadedUpLatencyMs).toBe(170);
    expect(r.loadedUpP95Ms).toBe(170);
    expect(r.bloatDownMs).toBe(42.5);
    expect(r.bloatUpMs).toBe(152.5);
    // grade from the larger MEAN increase: 170 − 19.4375 = 150.6 ms → C
    expect(r.grade).toBe('C');
    expect(r.error).toBeNull();
    expect(r.bytesDown).toBe(run().download?.totalBytes);
    expect(s.details.gradeIncreaseMs).toBe(150.6);
    expect(s.details.gradePhase).toBe('upload');
    expect(s.details.latencySource).toBe('udp');

    // queue: modem upstream (CMTS rises, router does not) dominates; downstream queue at the CMTS
    expect(s.bottleneck).toMatchObject({ layer: 'isp6', phase: 'upload', label: 'Kabelmodem/DOCSIS-Upstream', segment: 'docsis' });
    expect(s.details.bottleneckDown).toMatchObject({ layer: 'isp6', phase: 'download' });
    expect(s.segment).toBe('docsis');

    // 94 Mbit/s on a 100-Mbit/s link
    expect(s.limitedByLink).toBe(true);
    expect(s.details.limitedByLink).toBe(true);
    expect(s.severity).toBe('warn');
    expect(s.title).toBe('Speedtest: ↓ 94 Mbit/s · ↑ 48 Mbit/s · Bufferbloat C (durch 100-Mbit/s-Link begrenzt)');
    expect(s.details).toMatchObject({ grade: 'C', gradeLabel: 'Mäßig', colo: 'DUS', pop: 'dus01', ipFamily: 6, aborted: false });
  });

  it('builds a chart series sorted by time with rtt and mbps points', () => {
    const { series } = summarizeSpeedRun(run()).result;
    for (let i = 1; i < series.length; i++) expect(series[i].t).toBeGreaterThanOrEqual(series[i - 1].t);
    const rtt = series.filter((p) => p.rtt !== undefined);
    const mbps = series.filter((p) => p.mbps !== undefined);
    expect(rtt).toHaveLength(76);
    expect(mbps).toHaveLength(24); // 2 × 6 s in 500 ms bins
    expect(mbps.filter((p) => p.phase === 'download').at(-1)?.mbps).toBeCloseTo(94, 6);
    expect(series.find((p) => p.phase === 'idle')?.rtt).toBe(18);
  });

  it('LAN queue: the router ping rises under download → LAN link', () => {
    const s = summarizeSpeedRun(
      run({
        upload: phase(UP, 20, 48),
        probes: probes(55, 25),
        layerSamples: layers((target, ph) => (ph === 'download' ? 36 : 0)),
      }),
    );
    expect(s.bottleneck).toMatchObject({ layer: 'gw', label: 'LAN-Link (z. B. 100 Mbit/s)', segment: 'lan' });
    expect(s.result.grade).toBe('B');
  });

  it('manual run without a session: grade from UDP, no localization', () => {
    const s = summarizeSpeedRun(run({ layerSamples: [], nicLinkMbps: 1000 }));
    expect(s.result.grade).toBe('C');
    expect(s.bottleneck).toBeNull();
    expect(s.segment).toBeNull();
    expect(s.limitedByLink).toBe(false);
    expect(s.severity).toBe('warn'); // grade C
    expect(s.title).toBe('Speedtest: ↓ 94 Mbit/s · ↑ 48 Mbit/s · Bufferbloat C');
  });

  it('falls back to the pinger cf4 samples when the UDP probe is unavailable', () => {
    const s = summarizeSpeedRun(run({ probes: [] }));
    expect(s.details.latencySource).toBe('icmp');
    expect(s.result.idleLatencyMs).toBe(16.5); // cf4 at 0/1/2/3 s: 18, 24, 14, 15 → median 16.5
    expect(s.result.grade).toBe('C');
  });

  it('no latency data at all → no grade, but throughput is kept', () => {
    const s = summarizeSpeedRun(run({ probes: [], layerSamples: [] }));
    expect(s.result.grade).toBeNull();
    expect(s.result.downMbps).toBeCloseTo(94, 6);
    expect(s.details.latencySource).toBeNull();
    expect(s.severity).toBe('warn'); // still limited by the 100-Mbit/s link
  });

  it('ignores unanswered probes (socket closed) instead of counting them as loss', () => {
    const p = probes(60, 170).map((x, i) => (i % 2 === 0 && x.phase === 'upload' ? { ...x, rtt: null, done: false } : x));
    const s = summarizeSpeedRun(run({ probes: p }));
    expect((s.details.lossPct as Record<string, unknown>).upload).toBe(0);
    expect(s.result.loadedUpLatencyMs).toBe(170);
  });

  it('reports a failed upload phase', () => {
    const s = summarizeSpeedRun(
      run({ upload: phase(UP, 0, 0, { ok: false, error: 'HTTP 429 – zu viele Anfragen', rateLimited: true, totalBytes: 0, bytes: [] }) }),
    );
    expect(s.result.upMbps).toBeNull();
    expect(s.result.loadedUpLatencyMs).toBeNull();
    expect(s.result.error).toBe('Upload fehlgeschlagen (HTTP 429 – zu viele Anfragen)');
    expect(s.result.downMbps).toBeCloseTo(94, 6);
    expect(s.details.rateLimited).toBe(true);
  });

  it('an aborted run keeps completed phases and is not a warning by itself', () => {
    const s = summarizeSpeedRun(
      run({ upload: phase({ start: 9100, end: 11_000, complete: false }, 20, 48), aborted: true, nicLinkMbps: 1000, probes: probes(30, 30) }),
    );
    expect(s.result.error).toBe('Abgebrochen');
    expect(s.result.upMbps).toBeNull();
    expect(s.result.downMbps).toBeCloseTo(94, 6);
    expect(s.severity).toBe('info');
    expect(s.title).toBe('Speedtest (abgebrochen): ↓ 94 Mbit/s · ↑ – · Bufferbloat A');
  });

  it('fatal error before the phases', () => {
    const s = summarizeSpeedRun(
      run({ idle: null, download: null, upload: null, probes: [], layerSamples: [], error: 'Cloudflare-Speedtest nicht erreichbar (ENOTFOUND)' }),
    );
    expect(s.result).toMatchObject({ downMbps: null, upMbps: null, grade: null, bytesDown: 0, bytesUp: 0, series: [] });
    expect(s.result.error).toBe('Cloudflare-Speedtest nicht erreichbar (ENOTFOUND)');
    expect(s.severity).toBe('warn');
    expect(s.title).toBe('Speedtest fehlgeschlagen: Cloudflare-Speedtest nicht erreichbar (ENOTFOUND)');
  });

  it('a phase that ended early at the byte cap uses its second half', () => {
    const capped = phase({ start: 3000, end: 6200, complete: true }, 900, 900, { capReached: true });
    const s = summarizeSpeedRun(run({ download: capped, nicLinkMbps: 1000 }));
    expect(s.result.downMbps).toBeCloseTo(900, 6);
    expect((s.details.capReached as Record<string, unknown>).download).toBe(true);
    expect(s.limitedByLink).toBe(true);
    expect(s.severity).toBe('warn'); // grade C, not because of the gigabit link
  });
});
