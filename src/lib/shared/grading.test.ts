import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, rateBand } from './config';
import {
  BOTTLENECK_LABELS,
  type ByteSample,
  GRADE_INFO,
  type LatencyPoint,
  bottleneckLabel,
  bufferbloatGrade,
  gradeAtLeastAsBadAs,
  gradeFromLatency,
  gradeHealth,
  gradeLabel,
  gradeRank,
  increaseMs,
  isLimitedByLink,
  latencyStats,
  linkLimitText,
  loadedIncreaseMs,
  localizeBottleneck,
  okCount,
  pickBottleneck,
  speedtestTitle,
  stableThroughputMbps,
  stableWindow,
  throughputBins,
  throughputMbps,
  windowRtts,
} from './grading';

/** Real idle RTTs captured on this machine by the .NET pinger (fixtures/windows/dotnet_pinger_stream.json). */
function fixtureRtts(target: string): (number | null)[] {
  const url = new URL('../../../fixtures/windows/dotnet_pinger_stream.json', import.meta.url);
  const raw: unknown = JSON.parse(readFileSync(url, 'utf8'));
  const recs = typeof raw === 'object' && raw !== null && 'recs' in raw && Array.isArray(raw.recs) ? (raw.recs as unknown[]) : [];
  const out: (number | null)[] = [];
  for (const r of recs) {
    if (typeof r !== 'object' || r === null) continue;
    const rec = r as Record<string, unknown>;
    if (rec.type !== 'echo' || rec.target !== target) continue;
    out.push(rec.status === 'Success' && typeof rec.rtt === 'number' ? rec.rtt : null);
  }
  return out;
}

const CF4_IDLE = fixtureRtts('1.1.1.1'); // [18, 24, 14, 15, 31, 17, 17, 19, 20]
const GW_IDLE = fixtureRtts('192.168.0.1'); // [1, 1, 2, 1, 1, 1, 1, 1, 0]

describe('fixture sanity', () => {
  it('loads the real idle series', () => {
    expect(CF4_IDLE).toEqual([18, 24, 14, 15, 31, 17, 17, 19, 20]);
    expect(GW_IDLE).toHaveLength(9);
  });
});

describe('bufferbloatGrade (Waveform scale)', () => {
  it.each([
    [0, 'A+'],
    [4.99, 'A+'],
    [5, 'A'],
    [29.9, 'A'],
    [30, 'B'],
    [59.99, 'B'],
    [60, 'C'],
    [199, 'C'],
    [200, 'D'],
    [399.9, 'D'],
    [400, 'F'],
    [2500, 'F'],
  ])('%s ms → %s', (ms, grade) => {
    expect(bufferbloatGrade(ms)).toBe(grade);
  });

  it('treats a negative increase (noise) as A+ and missing values as null', () => {
    expect(bufferbloatGrade(-3)).toBe('A+');
    expect(bufferbloatGrade(null)).toBeNull();
    expect(bufferbloatGrade(undefined)).toBeNull();
    expect(bufferbloatGrade(Number.NaN)).toBeNull();
  });

  it('health agrees with the configured bufferbloat band (away from the exact bounds)', () => {
    const band = DEFAULT_CONFIG.thresholds.bufferbloat;
    for (const ms of [0, 3, 12, 29, 31, 45, 59, 61, 150, 250, 800]) {
      expect(gradeHealth(bufferbloatGrade(ms))).toBe(rateBand(ms, band));
    }
  });

  it('labels, ranks and comparisons', () => {
    expect(gradeLabel('A+')).toBe('Hervorragend');
    expect(gradeLabel('C')).toBe('Mäßig');
    expect(gradeLabel(null)).toBe('unbekannt');
    expect(gradeHealth(null)).toBe('unknown');
    expect(gradeRank('A+')).toBe(0);
    expect(gradeRank('F')).toBe(5);
    expect(gradeRank(null)).toBe(-1);
    expect(gradeAtLeastAsBadAs('D', 'C')).toBe(true);
    expect(gradeAtLeastAsBadAs('C', 'C')).toBe(true);
    expect(gradeAtLeastAsBadAs('B', 'C')).toBe(false);
    expect(gradeAtLeastAsBadAs(null, 'C')).toBe(false);
    for (const info of Object.values(GRADE_INFO)) expect(info.text.length).toBeGreaterThan(20);
  });
});

/** Byte samples at 50 ms bin centres with a constant rate per interval. */
function bytesAt(fromMs: number, toMs: number, mbps: number, binMs = 50): ByteSample[] {
  const out: ByteSample[] = [];
  const perBin = (mbps * 1e6 * binMs) / 8000;
  for (let t = fromMs; t < toMs; t += binMs) out.push({ t: t + binMs / 2, bytes: perBin });
  return out;
}

describe('throughput', () => {
  it('computes Mbit/s of the samples in [from, to)', () => {
    // 1.25 MB in one second = 10 Mbit/s
    const s: ByteSample[] = [
      { t: 0, bytes: 625_000 },
      { t: 999, bytes: 625_000 },
      { t: 1000, bytes: 9_999_999 },
    ];
    expect(throughputMbps(s, 0, 1000)).toBeCloseTo(10, 9);
    expect(throughputMbps(s, 2000, 3000)).toBe(0);
    expect(throughputMbps(s, 1000, 1000)).toBeNull();
    expect(throughputMbps(s, 1000, 0)).toBeNull();
  });

  it('uses the stable window after the 3 s ramp-up', () => {
    expect(stableWindow(0, 6000)).toEqual({ from: 3000, to: 6000 });
    expect(stableWindow(10_000, 25_000)).toEqual({ from: 13_000, to: 25_000 });
    expect(stableWindow(0, 4000)).toEqual({ from: 3000, to: 4000 });
    // phase ended early (byte cap): fall back to its second half
    expect(stableWindow(0, 3500)).toEqual({ from: 1750, to: 3500 });
    expect(stableWindow(5, 5)).toBeNull();
    expect(stableWindow(0, 6000, 1000)).toEqual({ from: 1000, to: 6000 });
  });

  it('ignores the slow-start ramp: ≈ 85 Mbit/s like the 100-Mbit/s link of this PC', () => {
    // 6 s download: TCP slow start (20 → 60 Mbit/s) in the first 3 s, then a steady 85 Mbit/s
    const samples = [...bytesAt(0, 1500, 20), ...bytesAt(1500, 3000, 60), ...bytesAt(3000, 6000, 85)];
    expect(stableThroughputMbps(samples, 0, 6000)).toBeCloseTo(85, 6);
    expect(throughputMbps(samples, 0, 6000)).toBeLessThan(70); // the naive mean would under-report
  });

  it('bins throughput for charts (last partial bin uses its real length)', () => {
    const bins = throughputBins(bytesAt(0, 1200, 40), 0, 1200, 500);
    expect(bins.map((b) => b.t)).toEqual([500, 1000, 1200]);
    for (const b of bins) expect(b.mbps).toBeCloseTo(40, 6);
    expect(throughputBins([], 0, 0)).toEqual([]);
  });
});

describe('latency under load', () => {
  it('summarizes a probe series incl. loss and chain jitter', () => {
    const s = latencyStats([...CF4_IDLE, null]);
    expect(s.sent).toBe(10);
    expect(s.lost).toBe(1);
    expect(s.lossPct).toBeCloseTo(10, 9);
    expect(s.mean).toBeCloseTo(175 / 9, 9);
    expect(s.median).toBe(18);
    expect(s.jitter).toBeCloseTo((6 + 10 + 1 + 16 + 14 + 0 + 2 + 1) / 8, 9);
    expect(okCount(s)).toBe(9);
    expect(okCount(null)).toBe(0);
    expect(latencyStats([]).lossPct).toBeNull();
  });

  it('selects the RTTs of a window in send order (inclusive bounds)', () => {
    const pts: LatencyPoint[] = [
      { t: 400, rtt: 30 },
      { t: 0, rtt: 10 },
      { t: 200, rtt: null },
      { t: 600, rtt: 99 },
    ];
    expect(windowRtts(pts, { from: 0, to: 400 })).toEqual([10, null, 30]);
    expect(windowRtts(pts, null)).toEqual([]);
  });

  it('grades by the larger mean increase of download and upload (Waveform)', () => {
    const idle = latencyStats(CF4_IDLE); // mean ≈ 19.4 ms
    const down = latencyStats(CF4_IDLE.map((r) => (r === null ? null : r + 25)));
    const up = latencyStats(CF4_IDLE.map((r) => (r === null ? null : r + 120)));
    const g = gradeFromLatency(idle, down, up);
    expect(g.phase).toBe('upload');
    expect(g.increaseMs).toBeCloseTo(120, 9);
    expect(g.grade).toBe('C');
    const onlyDown = gradeFromLatency(idle, down, null);
    expect(onlyDown).toMatchObject({ phase: 'download', grade: 'A' });
    expect(onlyDown.increaseMs).toBeCloseTo(25, 9);
    expect(gradeFromLatency(idle, null, null)).toEqual({ grade: null, increaseMs: null, phase: null });
    expect(gradeFromLatency(null, down, up).grade).toBeNull();
  });

  it('counts a loaded phase that lost most probes as at least grade F', () => {
    const idle = latencyStats(CF4_IDLE);
    const drowned = latencyStats([45, null, null, null, 60, null, null, null]);
    expect(loadedIncreaseMs(idle, drowned)).toBe(400);
    expect(gradeFromLatency(idle, drowned, null).grade).toBe('F');
    // a single lost probe does not trigger it
    const fine = latencyStats([30, 31, null, 29, 30, 32]);
    expect(loadedIncreaseMs(idle, fine)).toBeCloseTo(30.4 - 175 / 9, 9);
    expect(increaseMs(10, null)).toBeNull();
  });
});

describe('bottleneck localization', () => {
  const gwIdle = 1;
  it('router ping rising under download → LAN link (100 Mbit/s)', () => {
    const b = localizeBottleneck(
      [
        { layer: 'gw', idleMs: gwIdle, loadedMs: 38 },
        { layer: 'isp6', idleMs: 9, loadedMs: 47 },
        { layer: 'beyond', idleMs: 18, loadedMs: 57 },
      ],
      'download',
    );
    expect(b).toMatchObject({ layer: 'gw', label: 'LAN-Link (z. B. 100 Mbit/s)', segment: 'lan', phase: 'download' });
    expect(b?.riseMs).toBe(37);
    expect(b?.text).toContain('Router');
  });

  it('CMTS hop rising under upload → cable modem upstream buffer', () => {
    const b = localizeBottleneck(
      [
        { layer: 'gw', idleMs: gwIdle, loadedMs: 1.5 },
        { layer: 'isp6', idleMs: 9, loadedMs: 160 },
        { layer: 'beyond', idleMs: 18, loadedMs: 172 },
      ],
      'upload',
    );
    expect(b).toMatchObject({ layer: 'isp6', label: 'Kabelmodem/DOCSIS-Upstream', segment: 'docsis' });
    expect(b?.text).toContain('Upload');
  });

  it('CMTS hop rising under download → downstream queue at the head end', () => {
    const b = localizeBottleneck(
      [
        { layer: 'gw', idleMs: gwIdle, loadedMs: 2 },
        { layer: 'isp6', idleMs: 9, loadedMs: 70 },
        { layer: 'beyond', idleMs: 18, loadedMs: 80 },
      ],
      'download',
    );
    expect(b?.layer).toBe('isp6');
    expect(b?.label).toBe(bottleneckLabel('isp6', 'download'));
    expect(b?.label).not.toBe(BOTTLENECK_LABELS.isp6);
  });

  it('only the targets behind the CMTS rise → provider', () => {
    const b = localizeBottleneck(
      [
        { layer: 'gw', idleMs: gwIdle, loadedMs: 1 },
        { layer: 'isp6', idleMs: 9, loadedMs: 12 },
        { layer: 'beyond', idleMs: 18, loadedMs: 75 },
      ],
      'download',
    );
    expect(b).toMatchObject({ layer: 'beyond', label: 'Provider', segment: 'isp' });
    // download: the head-end downstream shaper is part of "beyond" (CMTS pings may skip that queue)
    expect(b?.text).toContain('Downstream der Kopfstation');
    const up = localizeBottleneck(
      [
        { layer: 'gw', idleMs: gwIdle, loadedMs: 1 },
        { layer: 'isp6', idleMs: 9, loadedMs: 9 },
        { layer: 'beyond', idleMs: 18, loadedMs: 60 },
      ],
      'upload',
    );
    expect(up?.text).toContain('AFTR/Backbone');
  });

  it('picks the first layer carrying at least half of the total rise', () => {
    // small LAN queue (+12 ms) but the real queue sits in the modem (+150 ms)
    const b = localizeBottleneck(
      [
        { layer: 'gw', idleMs: gwIdle, loadedMs: 13 },
        { layer: 'isp6', idleMs: 9, loadedMs: 150 },
        { layer: 'beyond', idleMs: 18, loadedMs: 165 },
      ],
      'upload',
    );
    expect(b?.layer).toBe('isp6');
  });

  it('returns null without a significant rise or when an earlier layer is unknown', () => {
    const flat = localizeBottleneck(
      [
        { layer: 'gw', idleMs: 1, loadedMs: 2 },
        { layer: 'isp6', idleMs: 9, loadedMs: 15 },
        { layer: 'beyond', idleMs: 18, loadedMs: 30 },
      ],
      'download',
    );
    expect(flat).toBeNull();
    // manual run without a session: no pinger samples, only the UDP probe
    expect(localizeBottleneck([{ layer: 'beyond', idleMs: 18, loadedMs: 200 }], 'upload')).toBeNull();
    // gw fine, isp6 unknown (not discovered yet): DOCSIS vs. provider cannot be told apart
    expect(
      localizeBottleneck(
        [
          { layer: 'gw', idleMs: 1, loadedMs: 1 },
          { layer: 'isp6', idleMs: null, loadedMs: null },
          { layer: 'beyond', idleMs: 18, loadedMs: 200 },
        ],
        'upload',
      ),
    ).toBeNull();
  });

  it('pickBottleneck prefers the phase with the larger rise', () => {
    const down = localizeBottleneck([{ layer: 'gw', idleMs: 1, loadedMs: 40 }], 'download');
    const up = localizeBottleneck(
      [
        { layer: 'gw', idleMs: 1, loadedMs: 1 },
        { layer: 'isp6', idleMs: 9, loadedMs: 140 },
      ],
      'upload',
    );
    expect(down?.layer).toBe('gw');
    expect(pickBottleneck(down, up)?.phase).toBe('upload');
    expect(pickBottleneck(down, null)).toBe(down);
    expect(pickBottleneck(null, null)).toBeNull();
  });
});

describe('link limit', () => {
  it('flags downloads ≥ 85 % of the NIC link speed', () => {
    // research: 5 MB in 471 ms ≈ 85 Mbit/s on this PC = ceiling of a 100-Mbit/s Ethernet link
    expect(isLimitedByLink(85, 100)).toBe(true);
    expect(isLimitedByLink(94.1, 100)).toBe(true);
    expect(isLimitedByLink(84.9, 100)).toBe(false);
    expect(isLimitedByLink(940, 1000)).toBe(true);
    expect(isLimitedByLink(500, 1000)).toBe(false);
    expect(isLimitedByLink(null, 100)).toBe(false);
    expect(isLimitedByLink(90, null)).toBe(false);
    expect(isLimitedByLink(90, 0)).toBe(false);
  });

  it('German link-limit text', () => {
    expect(linkLimitText(100)).toBe('durch 100-Mbit/s-Link begrenzt');
    expect(linkLimitText(1000)).toBe('durch 1.000-Mbit/s-Link begrenzt');
    expect(linkLimitText(null)).toBe('durch den LAN-Link begrenzt');
  });
});

describe('speedtestTitle', () => {
  const base = { downMbps: 87.4, upMbps: 41.2, grade: 'B' as const, error: null, nicLinkMbps: 1000 };
  it('summarizes the result in German', () => {
    expect(speedtestTitle(base)).toBe('Speedtest: ↓ 87 Mbit/s · ↑ 41 Mbit/s · Bufferbloat B');
    expect(speedtestTitle({ ...base, downMbps: 94.3, nicLinkMbps: 100 }, { limitedByLink: true })).toBe(
      'Speedtest: ↓ 94 Mbit/s · ↑ 41 Mbit/s · Bufferbloat B (durch 100-Mbit/s-Link begrenzt)',
    );
    expect(speedtestTitle({ ...base, upMbps: null, grade: null }, { aborted: true })).toBe(
      'Speedtest (abgebrochen): ↓ 87 Mbit/s · ↑ –',
    );
  });

  it('describes failures', () => {
    const failed = { downMbps: null, upMbps: null, grade: null, nicLinkMbps: null };
    expect(speedtestTitle({ ...failed, error: 'Cloudflare-Speedtest nicht erreichbar (ENOTFOUND)' })).toBe(
      'Speedtest fehlgeschlagen: Cloudflare-Speedtest nicht erreichbar (ENOTFOUND)',
    );
    expect(speedtestTitle({ ...failed, error: null })).toBe('Speedtest fehlgeschlagen');
    expect(speedtestTitle({ ...failed, error: 'Abgebrochen' }, { aborted: true })).toBe('Speedtest abgebrochen');
  });
});
