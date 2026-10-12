import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  addedRtt, attributeHops, buildMtrHops, buildTraceHops, chanceShare, chooseIspHost, classifyPropagation, comparePaths,
  hopMeasures, hopPropagation, interpretPath, isRouterAddress, linkLoss, mtrStatsFromRtts, nodeLoss, nodeRtt,
  pathSignature, persistentLoss, persistentRtt, pickIspHop, propagationShare, roundEvents,
  type HopMeasure, type HopProbe, type HopProbeKind,
} from './path-analysis';
import type { TraceHop } from './types';

const FIX = path.resolve(__dirname, '../../../fixtures/windows');

/** Real .NET TTL trace captured on this machine (sync Ping.Send + Stopwatch). */
function fixtureProbes(key: 'trace' | 'trace6'): HopProbe[] {
  const json = JSON.parse(fs.readFileSync(path.join(FIX, 'dotnet_ping_df_trace.json'), 'utf8')) as Record<
    string,
    { ttl: number; status: string; from: unknown; elapsedMs: number }[]
  >;
  return json[key].map((r) => {
    const kind: HopProbeKind = r.status === 'Success' ? 'reply' : r.status === 'TtlExpired' ? 'ttl-expired' : 'lost';
    const from = typeof r.from === 'string' ? r.from : null;
    return { ttl: r.ttl, round: 1, from, rttMs: kind === 'lost' ? null : r.elapsedMs, kind };
  });
}

const hop = (n: number, ip: string | null, extra: Partial<TraceHop> = {}): TraceHop => ({
  hop: n, ip, rtts: ip ? [10] : [null], lossPct: ip ? 0 : 100, avgMs: ip ? 10 : null, ...extra,
});

describe('pathping attribution (Microsoft example, methodology.md §7.2)', () => {
  // pathping: source→here loss 0/16/13/14/13 %, RTT 35/23/24/21/24 ms
  const ms: HopMeasure[] = [
    { hop: 1, lossPct: 0, rttMs: 35 },
    { hop: 2, lossPct: 16, rttMs: 23 },
    { hop: 3, lossPct: 13, rttMs: 24 },
    { hop: 4, lossPct: 14, rttMs: 21 },
    { hop: 5, lossPct: 13, rttMs: 24 },
  ];

  it('reproduces pathping "This Node/Link": link 1→2 = 13 %, node 2 = 3 %, node 4 = 1 %', () => {
    expect(ms.map((_, i) => persistentLoss(ms, i))).toEqual([0, 13, 13, 13, 13]);
    expect(ms.map((_, i) => linkLoss(ms, i))).toEqual([0, 13, 0, 0, 0]);
    expect(ms.map((_, i) => nodeLoss(ms, i))).toEqual([0, 3, 0, 1, 0]);
  });

  it('computes the RTT-median equivalents', () => {
    expect(ms.map((_, i) => persistentRtt(ms, i))).toEqual([21, 21, 21, 21, 24]);
    expect(ms.map((_, i) => addedRtt(ms, i))).toEqual([21, 0, 0, 0, 3]);
    expect(ms.map((_, i) => nodeRtt(ms, i))).toEqual([14, 2, 3, 0, 0]);
  });

  it('skips silent hops (unknown loss, not 100 %)', () => {
    const withSilent: HopMeasure[] = [
      { hop: 1, lossPct: 0, rttMs: 1 },
      { hop: 2, lossPct: null, rttMs: null }, // DS-Lite AFTR never answers
      { hop: 3, lossPct: 20, rttMs: 15 },
      { hop: 4, lossPct: 5, rttMs: 16 },
    ];
    const a = attributeHops(withSilent);
    expect(a[1]).toMatchObject({ persistentLoss: null, linkLoss: null, nodeLoss: null, addedRtt: null });
    expect(a[2]).toMatchObject({ persistentLoss: 5, linkLoss: 5, nodeLoss: 15, addedRtt: 14 });
    expect(a[3]).toMatchObject({ persistentLoss: 5, linkLoss: 0, nodeLoss: 0, addedRtt: 1 });
  });

  it('interprets an MTR row with German findings', () => {
    const hops: TraceHop[] = ms.map((m) => ({
      hop: m.hop,
      ip: `10.54.${m.hop}.1`,
      rtts: [m.rttMs],
      lossPct: m.lossPct ?? 0,
      avgMs: m.rttMs,
      mtr: { sent: 100, lost: m.lossPct ?? 0, lossPct: m.lossPct ?? 0, avgMs: m.rttMs, minMs: m.rttMs, maxMs: m.rttMs, jitterMs: 0 },
    }));
    const r = interpretPath(hops, true, { minLossPct: 1 });
    expect(r.lossStartsAt).toBe(2);
    expect(r.destinationLossPct).toBe(13);
    const kinds = r.findings.map((f) => `${f.kind}@${f.hop}`);
    expect(kinds).toEqual(expect.arrayContaining(['link-loss@2', 'node-loss@2', 'node-loss@4']));
    expect(r.findings.find((f) => f.kind === 'link-loss')?.text).toBe(
      'Echter Verlust zwischen Hop 1 und Hop 2 (10.54.2.1): 13 % – bleibt bis zum Ziel bestehen.',
    );
    expect(r.summary).toBe('Echter Paketverlust beginnt bei Hop 2 (10.54.2.1) und bleibt bis zum Ziel bestehen (Ziel: 13 %).');
    // default threshold (10 %) hides the small cosmetic node losses
    expect(interpretPath(hops, true).findings.map((f) => f.kind)).toEqual(['link-loss']);
  });
});

describe('buildTraceHops', () => {
  it('builds the IPv4 path from the real .NET TTL trace', () => {
    const r = buildTraceHops(fixtureProbes('trace'));
    expect(r.reached).toBe(true);
    expect(r.terminalTtl).toBe(7);
    expect(r.hops.map((h) => h.ip)).toEqual(['192.168.0.1', null, '92.79.214.92', null, null, '198.41.240.9', '1.1.1.1']);
    expect(r.hops[0]).toMatchObject({ rtts: [3.32], lossPct: 0, avgMs: 3.32 });
    expect(r.hops[1]).toMatchObject({ rtts: [null], lossPct: 100, avgMs: null });
    expect(pathSignature(r.hops)).toBe('1=192.168.0.1|3=92.79.214.92|6=198.41.240.9|7=1.1.1.1');
  });

  it('builds the IPv6 path and picks $isp6 / $isp4 like §4.7', () => {
    const v6 = buildTraceHops(fixtureProbes('trace6'));
    expect(v6.hops[0].ip).toBe('3fff:8071:7ca0:c980:de73:6ff:fe12:34df');
    expect(pickIspHop(v6.hops, 6, '2606:4700:4700::1111', ['fe80::de73:6ff:fe12:34df%4'])).toEqual({
      hop: 2, ip: '2a02:8101:3ff:ff89::3',
    });
    const v4 = buildTraceHops(fixtureProbes('trace'));
    expect(pickIspHop(v4.hops, 4, '1.1.1.1', ['192.168.0.1'])).toEqual({ hop: 3, ip: '92.79.214.92' });
  });

  it('uses rounds, majority responder and drops TTLs beyond the destination', () => {
    const p = (ttl: number, round: number, kind: HopProbeKind, from: string | null, rttMs: number | null): HopProbe => ({ ttl, round, kind, from, rttMs });
    const probes: HopProbe[] = [
      p(1, 1, 'ttl-expired', '192.168.0.1', 2), p(2, 1, 'lost', null, null), p(3, 1, 'reply', '9.9.9.9', 20), p(4, 1, 'reply', '9.9.9.9', 21),
      p(1, 2, 'ttl-expired', '192.168.0.1', 1), p(2, 2, 'ttl-expired', '10.0.0.2', 9), p(3, 2, 'reply', '9.9.9.9', 22),
      p(1, 3, 'error', null, null), p(2, 3, 'ttl-expired', '10.0.0.3', 8), p(3, 3, 'lost', null, null),
    ];
    const r = buildTraceHops(probes);
    expect(r.hops).toHaveLength(3);
    expect(r.hops[0]).toMatchObject({ rtts: [2, 1, null], ip: '192.168.0.1' });
    expect(r.hops[0].lossPct).toBeCloseTo(100 / 3, 6);
    expect(r.hops[1].ip).toBe('10.0.0.2'); // tie → first responder
    expect(r.hops[2]).toMatchObject({ ip: '9.9.9.9', rtts: [20, 22, null] });
  });

  it('trims the silent tail of an unreached path and stops at router "unreachable"', () => {
    const probes: HopProbe[] = [{ ttl: 1, round: 1, kind: 'ttl-expired', from: '192.168.0.1', rttMs: 1 }];
    for (let t = 2; t <= 30; t++) probes.push({ ttl: t, round: 1, kind: 'lost', from: null, rttMs: null });
    const r = buildTraceHops(probes);
    expect(r.reached).toBe(false);
    expect(r.hops.map((h) => h.hop)).toEqual([1, 2, 3]);
    const u = buildTraceHops([
      { ttl: 1, round: 1, kind: 'ttl-expired', from: '192.168.0.1', rttMs: 1 },
      { ttl: 2, round: 1, kind: 'unreachable', from: '10.1.1.1', rttMs: 9 },
      { ttl: 3, round: 1, kind: 'unreachable', from: '10.1.1.1', rttMs: 9 },
    ]);
    expect(u).toMatchObject({ reached: false, terminal: 'unreachable', terminalTtl: 2 });
    expect(u.hops).toHaveLength(2);
  });
});

describe('router detection and $isp hosts', () => {
  it('recognizes the router GUA by its EUI-64 interface id', () => {
    expect(isRouterAddress('3fff:8071:7ca0:c980:de73:6ff:fe12:34df', ['fe80::de73:6ff:fe12:34df%4'])).toBe(true);
    expect(isRouterAddress('2a02:8101:3ff:ff89::3', ['fe80::de73:6ff:fe12:34df%4'])).toBe(false);
    expect(isRouterAddress('192.168.0.1', ['192.168.0.1'])).toBe(true);
    // a second router with the same MAC-derived IID at hop 2 is not the ISP
    const hops = [hop(1, '3fff:8071:7ca0:c980:de73:6ff:fe12:34df'), hop(2, '3fff:8071:7ca0:1:de73:6ff:fe12:34df'), hop(3, '2a02:8101:3ff:ff89::3')];
    expect(pickIspHop(hops, 6, '2606:4700:4700::1111', [])?.ip).toBe('2a02:8101:3ff:ff89::3');
    // never the destination itself, never private hops
    expect(pickIspHop([hop(1, '192.168.0.1'), hop(2, '10.0.0.1'), hop(3, '1.1.1.1')], 4, '1.1.1.1', [])).toBeNull();
  });

  it('keeps the current host stable across rate-limited discoveries', () => {
    const full = [hop(1, '192.168.0.1'), hop(2, null), hop(3, '92.79.214.92'), hop(4, '145.254.2.199')];
    const hop3Silent = [hop(1, '192.168.0.1'), hop(2, null), hop(3, null), hop(4, '145.254.2.199')];
    const rerouted = [hop(1, '192.168.0.1'), hop(2, null), hop(3, '92.79.214.88'), hop(4, '145.254.2.199')];
    expect(chooseIspHost(null, [full], 4, '1.1.1.1', ['192.168.0.1'])).toBe('92.79.214.92');
    expect(chooseIspHost('92.79.214.92', [full, hop3Silent], 4, '1.1.1.1', [])).toBe('92.79.214.92');
    expect(chooseIspHost('92.79.214.92', [full, rerouted], 4, '1.1.1.1', [])).toBe('92.79.214.88');
    // fallback hop 4 is replaced by hop 3 once hop 3 answered in two traces
    expect(chooseIspHost('145.254.2.199', [hop3Silent, full], 4, '1.1.1.1', [])).toBe('145.254.2.199');
    expect(chooseIspHost('145.254.2.199', [full, full], 4, '1.1.1.1', [])).toBe('92.79.214.92');
    // broken path (outage) keeps the host
    expect(chooseIspHost('92.79.214.92', [full, [hop(1, '192.168.0.1'), hop(2, null)]], 4, '1.1.1.1', [])).toBe('92.79.214.92');
  });
});

describe('comparePaths', () => {
  const a = { reached: true, hops: [hop(1, '192.168.0.1'), hop(2, null), hop(3, '92.79.214.92'), hop(4, '145.254.2.199'), hop(5, '1.1.1.1')] };

  it('ignores silent hops but flags different responders', () => {
    const silent = { reached: true, hops: [hop(1, '192.168.0.1'), hop(2, null), hop(3, null), hop(4, '145.254.2.199'), hop(5, '1.1.1.1')] };
    expect(comparePaths(a, silent).changed).toBe(false);
    const other = { reached: true, hops: [hop(1, '192.168.0.1'), hop(2, null), hop(3, '92.79.214.88'), hop(4, '145.254.2.199'), hop(5, '1.1.1.1')] };
    const c = comparePaths(a, other);
    expect(c.changed).toBe(true);
    expect(c.diffs).toEqual([{ hop: 3, before: '92.79.214.92', after: '92.79.214.88' }]);
    // known ECMP alternate from history → no change
    expect(comparePaths(a, other, [other]).changed).toBe(false);
  });

  it('flags a different hop count to the destination', () => {
    const longer = { reached: true, hops: [...a.hops.slice(0, 4), hop(5, '198.41.240.9'), hop(6, '1.1.1.1')] };
    const c = comparePaths(a, longer);
    expect(c).toMatchObject({ changed: true, lengthChanged: true, prevLength: 5, curLength: 6 });
    expect(comparePaths(a, { reached: false, hops: a.hops.slice(0, 2) }).changed).toBe(false);
  });
});

describe('MTR helpers', () => {
  it('computes MTR stats and keeps rtts round-aligned', () => {
    expect(mtrStatsFromRtts([10, null, 14, 12])).toEqual({ sent: 4, lost: 1, lossPct: 25, avgMs: 12, minMs: 10, maxMs: 14, jitterMs: 2 });
    const base = [hop(1, '192.168.0.1'), hop(2, null), hop(3, '92.79.214.92')];
    const probes: HopProbe[] = [
      { ttl: 1, round: 1, kind: 'ttl-expired', from: '192.168.0.1', rttMs: 1 },
      { ttl: 3, round: 1, kind: 'reply', from: '92.79.214.92', rttMs: 15 },
      { ttl: 1, round: 2, kind: 'ttl-expired', from: '192.168.0.1', rttMs: 2 },
      { ttl: 3, round: 2, kind: 'lost', from: null, rttMs: null },
    ];
    const m = buildMtrHops(base, probes, 20);
    expect(m[0]).toMatchObject({ rtts: [1, 2], lossPct: 0, mtr: { sent: 2, lost: 0 } });
    expect(m[1]).toMatchObject({ ip: null, mtr: null });
    expect(m[2]).toMatchObject({ rtts: [15, null], lossPct: 50, ip: '92.79.214.92' });
    // MTR hops with zero answers have a known 100 % loss (broken path), silent discovery hops are unknown
    const broken = buildMtrHops(base, [{ ttl: 3, round: 1, kind: 'lost', from: null, rttMs: null }], 20);
    expect(hopMeasures(broken).map((x) => x.lossPct)).toEqual([0, null, 100]);
  });
});

describe('propagation test (cosmetic vs real)', () => {
  it('computes the co-occurrence share with ±1 round tolerance', () => {
    const hopEv = [true, false, false, true, false, false, true, false, false, false];
    const dest = [false, true, false, false, false, false, false, false, false, false];
    expect(propagationShare(hopEv, dest)).toEqual({ events: 3, propagated: 1, share: 1 / 3 });
    expect(propagationShare(hopEv, dest, 0).propagated).toBe(0);
    expect(classifyPropagation(0.7)).toBe('real');
    expect(classifyPropagation(0.2)).toBe('cosmetic');
    expect(classifyPropagation(0.5)).toBe('inconclusive');
    expect(classifyPropagation(null)).toBeNull();
  });

  it('classifies hops of an MTR row against the destination', () => {
    const n = 20;
    const dest: (number | null)[] = Array.from({ length: n }, (_, i) => (i === 5 || i === 12 ? null : 20));
    const real: (number | null)[] = Array.from({ length: n }, (_, i) => (i === 5 || i === 12 ? null : 15));
    const cosmetic: (number | null)[] = Array.from({ length: n }, (_, i) => (i % 4 === 2 ? 150 : 10));
    expect(roundEvents([10, 10, null, 40, 11], 25)).toEqual([false, false, true, true, false]);
    const res = hopPropagation([
      { hop: 1, ip: '192.168.0.1', rtts: cosmetic, lossPct: 0, avgMs: 10 },
      { hop: 2, ip: '10.0.0.1', rtts: real, lossPct: 10, avgMs: 15 },
      { hop: 3, ip: '1.1.1.1', rtts: dest, lossPct: 10, avgMs: 20 },
    ]);
    expect(res.map((r) => [r.hop, r.verdict])).toEqual([[1, 'cosmetic'], [2, 'real']]);
    expect(res[1].chance).toBeCloseTo(6 / 20, 6); // destination events in rounds 5 and 12, ±1 window
  });

  it('does not call a hop "real" when a noisy destination explains the co-occurrence', () => {
    // live pattern: jittery destination (spike every other round) + ICMP rate limiting at hop 5
    const dest: (number | null)[] = Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? 120 : 20));
    const rateLimited: (number | null)[] = Array.from({ length: 20 }, (_, i) => (i % 3 === 0 ? null : 15));
    expect(chanceShare(roundEvents(dest))).toBe(1);
    const res = hopPropagation([
      { hop: 5, ip: '198.41.240.18', rtts: rateLimited, lossPct: 35, avgMs: 15 },
      { hop: 7, ip: '1.1.1.1', rtts: dest, lossPct: 0, avgMs: 70 },
    ]);
    expect(res[0]).toMatchObject({ events: 7, propagated: 7, share: 1, chance: 1, verdict: 'inconclusive' });
    // a single event never yields a verdict
    const single = hopPropagation([
      { hop: 1, ip: '192.168.0.1', rtts: [null, 1, 1, 1], lossPct: 25, avgMs: 1 },
      { hop: 2, ip: '1.1.1.1', rtts: [null, 20, 20, 20], lossPct: 25, avgMs: 20 },
    ]);
    expect(single[0]).toMatchObject({ events: 1, propagated: 1, verdict: 'inconclusive' });
    expect(chanceShare([])).toBeNull();
  });

  it('summarizes unreached and clean paths in German', () => {
    const unreached = interpretPath([hop(1, '192.168.0.1'), hop(2, null), hop(3, null)], false);
    expect(unreached.summary).toBe('Ziel nicht erreicht – letzter antwortender Knoten: Hop 1 (192.168.0.1).');
    expect(interpretPath([hop(1, '192.168.0.1'), hop(2, '1.1.1.1')], true).summary).toBe('Kein durchgehender Verlust bis zum Ziel.');
    expect(interpretPath([hop(1, null)], false).summary).toBe('Keine Hop-Antworten – der Pfad ist nicht auswertbar.');
  });
});
