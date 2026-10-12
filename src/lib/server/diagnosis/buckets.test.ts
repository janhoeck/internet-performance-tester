import { describe, expect, it } from 'vitest';
import { encodeHistogram, summarize } from '../../shared/stats';
import type { AccParts } from './aggregate';
import { type RollupBucketRow, type SecondsBucketRow, aggregateRollupBuckets, aggregateSecondsBuckets, vpnStateForBucket } from './buckets';
import { HOUR, MINUTE, WINDOW_MS } from './time';

/** parts of one 15-min bucket made of identical minutes */
function parts(rtts: (number | null)[], minutes = 15, spikes = 0): AccParts {
  const s = summarize(rtts);
  const ok = s.sent - s.lost;
  return {
    minutes,
    sent: s.sent * minutes,
    lost: s.lost * minutes,
    spikes: spikes * minutes,
    min: s.min,
    max: s.max,
    ok: ok * minutes,
    sum: (s.avg ?? 0) * ok * minutes,
    sumSq: ok * ((s.stddev ?? 0) ** 2 + (s.avg ?? 0) ** 2) * minutes,
    jitW: (s.jitter ?? 0) * (ok - 1) * minutes,
    jitP: (ok - 1) * minutes,
    hists: Array.from({ length: minutes }, () => encodeHistogram(s.hist)).join(';'),
  };
}

const minute60 = (v: number, lost = 0) => [...Array<number | null>(lost).fill(null), ...Array<number>(60 - lost).fill(v)];

/** local 2026-10-08 20:00 (evening) and 10:00 (baseline) */
const EVENING = new Date(2026, 9, 8, 20, 0).getTime();
const MORNING = new Date(2026, 9, 8, 10, 0).getTime();

describe('aggregateRollupBuckets', () => {
  const row = (targetId: string, b: number, p: AccParts, st = false, stable = true): RollupBucketRow => ({ targetId, b, st, stable, parts: p });
  const rows: RollupBucketRow[] = [
    row('gw', MORNING, parts(minute60(1))),
    row('gw', EVENING, parts(minute60(2, 1))),
    row('cf4', MORNING, parts(minute60(18))),
    row('cf4', EVENING, parts(minute60(40))),
    row('cf6', MORNING, parts(minute60(17))),
    row('cf6', EVENING, parts(minute60(19))),
    row('cf4', EVENING + WINDOW_MS, parts(minute60(300)), true), // speed test minutes
    row('cf4', EVENING + 2 * WINDOW_MS, parts(minute60(90)), false, false), // link problem / own load
  ];
  const agg = aggregateRollupBuckets(rows, {
    groups: { '@internet': ['cf4', 'cf6'], '@internet4': ['cf4'], '@internet6': ['cf6'], '@game': [] },
    windowTargets: new Set(['gw', 'cf4', 'cf6']),
    gatewayId: 'gw',
    coverageRefId: 'gw',
    vpnTimeline: [],
  });

  it('separates speed-test minutes and unstable minutes', () => {
    expect(agg.stats.cf4.sent).toBe(3 * 900);
    expect(agg.statsStable.cf4.sent).toBe(2 * 900);
    expect(agg.loadStats.cf4.sent).toBe(900);
    expect(agg.loadStats.cf4.p50).toBeGreaterThan(250);
    expect(agg.stats.gw.lost).toBe(15);
    expect(agg.samples).toBe(8 * 900);
  });

  it('merges groups', () => {
    expect(agg.stats['@internet'].sent).toBe(agg.stats.cf4.sent + agg.stats.cf6.sent);
    expect(agg.stats['@internet4'].sent).toBe(agg.stats.cf4.sent);
    expect(agg.stats['@game']).toBeUndefined();
  });

  it('builds hourly, daily (evening/baseline) and period stats from stable minutes', () => {
    expect(agg.hourly.cf4).toHaveLength(24);
    expect(agg.hourly.cf4[20].sent).toBe(900);
    expect(agg.hourly.cf4[10].p50).toBeLessThan(20);
    const day = agg.daily.cf4[0];
    expect(day.day).toBe('2026-10-08');
    expect(day.evening.p50).toBeGreaterThan(35);
    expect(day.base.p50).toBeLessThan(20);
    expect(day.all.sent).toBe(1800);
    expect(agg.periods['@internet'].evening.sent).toBe(1800);
  });

  it('builds 15-min windows and LAN hours', () => {
    expect(agg.windows.cf4.map((w) => w.ts)).toEqual([MORNING, EVENING]);
    expect(agg.windows.gw[1].lossPct).toBeCloseTo((1 / 60) * 100, 6);
    expect(agg.lanHours.map((h) => h.ts)).toEqual([MORNING, EVENING]);
    expect(agg.refMinutes).toBe(30);
    expect(agg.refMinutesByDay['2026-10-08']).toBe(30);
    expect(agg.firstTs).toBe(MORNING);
    expect(agg.lastTs).toBe(EVENING + 3 * WINDOW_MS);
  });

  it('compares WARP on/off on the internet group', () => {
    const vpn = aggregateRollupBuckets(rows, {
      groups: { '@internet': ['cf4', 'cf6'] },
      windowTargets: new Set(),
      gatewayId: null,
      coverageRefId: null,
      vpnTimeline: [
        { ts: MORNING - HOUR, connected: false, splitTunnel: null },
        { ts: EVENING - HOUR, connected: true, splitTunnel: 'include' },
      ],
    });
    expect(vpn.vpnCompare?.offMs).toBe(WINDOW_MS);
    expect(vpn.vpnCompare?.onMs).toBe(WINDOW_MS);
    expect(vpn.vpnCompare!.on.p50!).toBeGreaterThan(vpn.vpnCompare!.off.p50!);
  });
});

describe('vpnStateForBucket', () => {
  const tl = [
    { ts: 0, connected: true, splitTunnel: null },
    { ts: 20 * MINUTE, connected: false, splitTunnel: null },
  ];
  it('returns the state for the whole bucket or null when it changes inside', () => {
    expect(vpnStateForBucket(tl, 0)).toBe(true);
    expect(vpnStateForBucket(tl, WINDOW_MS)).toBeNull();
    expect(vpnStateForBucket(tl, 2 * WINDOW_MS)).toBe(false);
    expect(vpnStateForBucket(tl, -WINDOW_MS)).toBeNull();
  });
});

describe('aggregateSecondsBuckets', () => {
  const sec = (b: number, p: Partial<SecondsBucketRow>): SecondsBucketRow => ({
    b, minutes: 15, covered: 900, good: 900, link: 0, lan: 0, access: 0, aftr: 0, backbone: 0, remote: 0, unknown: 0, es: 0, ses: 0,
    selfLoad: 0, loadMinutes: 0, esLoad: 0, coveredLoad: 0, firstTs: b, lastTs: b + WINDOW_MS, ...p,
  });

  it('sums totals, local hours, days, windows and the load correlation', () => {
    const res = aggregateSecondsBuckets(
      [
        sec(EVENING, { good: 800, access: 60, link: 40, es: 70, ses: 5, selfLoad: 30, loadMinutes: 3, esLoad: 20, coveredLoad: 180 }),
        sec(MORNING, { good: 890, unknown: 10, es: 10 }),
      ],
      EVENING,
    );
    expect(res.totals).toMatchObject({ covered: 1800, good: 1690, bad: 110, access: 60, link: 40, unknown: 10, es: 80, minutes: 30 });
    expect(res.hourly[20].bad).toBe(100);
    expect(res.hourly[10].bad).toBe(10);
    expect(res.daily).toEqual([{ day: '2026-10-08', dayStart: new Date(2026, 9, 8).getTime(), covered: 1800, bad: 110, es: 80 }]);
    expect(res.windows).toEqual([{ ts: EVENING, covered: 900, link: 40, lan: 0 }]);
    expect(res.loadCorrelation).toEqual({ loadMinutes: 3, esLoad: 20, coveredLoad: 180, esIdle: 60, coveredIdle: 1620 });
    expect(res.firstTs).toBe(MORNING);
  });

  it('returns null totals without rows', () => {
    const res = aggregateSecondsBuckets([], 0);
    expect(res.totals).toBeNull();
    expect(res.hourly).toHaveLength(24);
    expect(res.loadCorrelation).toBeNull();
  });
});
