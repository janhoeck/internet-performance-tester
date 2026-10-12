import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../src/lib/shared/config';
import { type ClientState, type Sample, SampleStatus, type SampleStatusCode, type SecondsRollup } from '../../src/lib/shared/types';
import { BaselineTracker } from './baseline';
import type { SecondResult } from './classify';
import { SecondClassifier, createClassifierModule } from './classifier';
import { GapWindows } from './common';
import { MemoryDb, type RoundOverride, T0, clientState, fakeContext, lost, ok, round, testConfig } from './test-helpers';

const s = (sec: number) => T0 + sec * 1000;
type Override = RoundOverride;

interface SetupOptions {
  cfg?: AppConfig;
  client?: (ts: number) => ClientState | null;
  recovery?: (ts: number) => boolean;
}

function setup(opts: SetupOptions = {}) {
  const cfg = opts.cfg ?? testConfig();
  const tracker = new BaselineTracker({ config: () => cfg });
  const gaps = new GapWindows();
  const written: SecondsRollup[] = [];
  const cl = new SecondClassifier({
    config: () => cfg,
    verdict: (smp) => tracker.verdict(smp),
    clientAt: (ts) => (opts.client ? opts.client(ts) : clientState(ts)),
    inRecovery: (ts) => opts.recovery?.(ts) ?? false,
    isGap: (ts) => gaps.contains(ts),
    write: (rows) => written.push(...rows),
  });
  const results = new Map<number, SecondResult>();
  const run = (
    from: number,
    to: number,
    override: (sec: number) => Override = () => ({}),
    extra: (sec: number) => Sample[] = () => [],
    load: (sec: number) => boolean = () => false,
  ) => {
    for (let sec = from; sec < to; sec++) {
      for (const smp of [...round(s(sec), override(sec)), ...extra(sec)]) cl.add(smp, load(sec));
      for (const r of cl.process(s(sec) + 3000)) results.set(r.ts, r);
    }
  };
  const cls = (sec: number) => results.get(s(sec))?.cls;
  /** the row of a minute as it ends up in seconds_1m (INSERT OR REPLACE) */
  const finalRow = (minuteTs: number) => written.filter((r) => r.ts === minuteTs).at(-1);
  return { cfg, tracker, gaps, written, cl, results, run, cls, finalRow };
}

/**
 * TCP sample of a game target every 10 s (aws-fra is a TCP target in the default config). Node
 * probes are staggered away from the whole second (runner.ts staggerOffset), so a result sent at
 * 100.3 s describes the ticks from 101 s on.
 */
const gameTcp = (status: (sec: number) => number | null) => (sec: number): Sample[] => {
  if (sec % 10 !== 0) return [];
  const v = status(sec);
  return [v === null ? lost('aws-fra', s(sec) + 300) : ok('aws-fra', s(sec) + 300, v)];
};

describe('SecondClassifier – classes (first match wins)', () => {
  it('classifies every segment class from the samples of each tick', () => {
    const failoverAt = 100;
    const { run, cls, results } = setup({
      client: (ts) =>
        ts === s(failoverAt) ? clientState(ts, { linkUp: false, onExpected: false, egressV4If: 'WLAN', linkMbps: null }) : clientState(ts),
      recovery: (ts) => ts === s(101),
    });
    run(0, 90); // warm-up: baselines need 60 samples per target
    const plan: Record<number, Override> = {
      90: {},
      100: { gw: null, cf4: null, g4: null }, // failover dominates everything
      101: {}, // relink window
      102: { gw: null }, // lan (lost)
      103: { gw6: 30 }, // lan (spike above median + 10 ms)
      104: { isp6: 60, cf4: 60, cf6: 60 }, // access: CMTS + both families
      105: { cf4: null, g4: null }, // aftr: IPv4 only
      106: { cf4: null, cf6: 70 }, // backbone: CMTS fine, both families errored
      107: { cf6: null }, // unknown: IPv6 only
      108: { isp6: 70 }, // unknown: CMTS alone
    };
    run(90, 112, (sec) => plan[sec] ?? {});
    expect(cls(90)).toBe('good');
    expect(cls(100)).toBe('link');
    expect(cls(101)).toBe('link');
    expect(cls(102)).toBe('lan');
    expect(cls(103)).toBe('lan');
    expect(cls(104)).toBe('access');
    expect(cls(105)).toBe('aftr');
    expect(cls(106)).toBe('backbone');
    expect(cls(107)).toBe('unknown');
    expect(cls(108)).toBe('unknown');
    expect(cls(109)).toBe('good');
    expect(results.get(s(105))).toMatchObject({ es: true, ses: true }); // 2 of 4 internet probes lost
    expect(results.get(s(107))).toMatchObject({ es: true, ses: false });
    expect(results.get(s(108))).toMatchObject({ es: false, ses: false });
  });

  it('remote: only the game target (latest TCP sample ≤ 10 s old) is bad', () => {
    const { run, cls } = setup();
    run(0, 90, () => ({}), gameTcp(() => 25));
    run(90, 130, () => ({}), gameTcp((sec) => (sec === 100 ? null : 25)));
    expect(cls(100)).toBe('good'); // the lost probe was sent after this tick
    for (let sec = 101; sec <= 110; sec++) expect(cls(sec)).toBe('remote');
    expect(cls(111)).toBe('good'); // the next TCP sample (sent at 110.3 s) answered
    // no TCP sample for > 10 s → game group unknown, not bad
    run(130, 150, () => ({}), (sec) => (sec === 130 ? [lost('aws-fra', s(130) + 300)] : []));
    expect(cls(131)).toBe('remote');
    expect(cls(140)).toBe('remote');
    expect(cls(141)).toBe('good');
  });

  it('does not hold a bad game result measured while closer segments were errored (no remote smear)', () => {
    const access = { isp6: 300, cf4: 300, cf6: 300, g4: 300, g6: 300 };
    const { run, cls, cl } = setup();
    run(0, 90, () => ({}), gameTcp(() => 25));
    // CMTS spike at 100 s; the TCP connect sent at 100.3 s is slow (350 ms) because of it
    run(90, 125, (sec) => (sec === 100 ? access : {}), gameTcp((sec) => (sec === 100 ? 350 : 25)));
    expect(cls(100)).toBe('access');
    for (let sec = 101; sec <= 112; sec++) expect(cls(sec)).toBe('good');
    expect(cl.explainedGame).toBe(1);
    // the errored tick may also follow the probe (101 s brackets a probe sent at 100.3 s)
    run(125, 150, (sec) => (sec === 131 ? access : {}), gameTcp((sec) => (sec === 130 ? 280 : 25)));
    expect(cls(131)).toBe('access');
    for (let sec = 132; sec <= 140; sec++) expect(cls(sec)).toBe('good');
    // a lost probe (3 s timeout) is held until the errored tick inside its window explains it
    run(150, 175, (sec) => (sec === 153 ? access : {}), gameTcp((sec) => (sec === 150 ? null : 25)));
    expect(cls(151)).toBe('remote');
    expect(cls(152)).toBe('remote');
    expect(cls(153)).toBe('access');
    for (let sec = 154; sec <= 160; sec++) expect(cls(sec)).toBe('good');
    expect(cl.explainedGame).toBe(3);
  });

  it('ses: any internet RTT ≥ 200 ms; selfLoad: own traffic ≥ 80 % of the link speed', () => {
    const { run, results } = setup({
      client: (ts) => (ts === s(95) ? clientState(ts, { linkMbps: 100, rxMbps: 92 }) : clientState(ts)),
    });
    run(0, 90);
    run(90, 100, (sec) => (sec === 92 ? { g6: 210 } : sec === 93 ? { cf4: 150 } : {}));
    expect(results.get(s(92))).toMatchObject({ cls: 'unknown', es: true, ses: true });
    expect(results.get(s(93))).toMatchObject({ cls: 'aftr', es: true, ses: false });
    expect(results.get(s(95))).toMatchObject({ cls: 'good', selfLoad: true });
  });
});

describe('SecondClassifier – exclusions and minute rows', () => {
  it('writes each minute when complete; gap, speed-test and heartbeat-less ticks are not counted', () => {
    const { run, gaps, finalRow } = setup();
    run(0, 120);
    gaps.add(s(129), s(139)); // engine_gap: ts = last tick before the gap → 130…139 excluded
    for (let sec = 120; sec < 180; sec++) {
      if (sec >= 150 && sec < 155) continue; // no pinger heartbeat: no ICMP sample at all
      run(sec, sec + 1, (x) => (x === 160 || x === 161 ? { cf4: null, g4: null } : x === 170 ? { gw: null } : {}), () => [], (x) => x >= 175);
    }
    run(180, 183); // frontier passes the minute's last tick (179 + 3 s)
    // 60 − 10 (gap) − 5 (no heartbeat) − 5 (speed test) = 40 covered seconds
    expect(finalRow(s(120))).toEqual({ ts: s(120), covered: 40, good: 37, link: 0, lan: 1, access: 0, aftr: 2, backbone: 0, remote: 0, unknown: 0, es: 2, ses: 2, selfLoad: 0 });
    expect(finalRow(s(60))).toMatchObject({ covered: 60, good: 60 });
  });

  it('writes the running minute as a partial row every 10 s (crash safety)', () => {
    const { run, written } = setup();
    run(0, 25);
    expect(written.filter((r) => r.ts === s(0)).map((r) => r.covered)).toEqual([1, 11, 21]);
  });

  it('finish(now) drops incomplete ticks and writes the partial minute', () => {
    const { run, cl, finalRow } = setup();
    run(0, 70);
    for (let sec = 70; sec < 75; sec++) for (const smp of round(s(sec))) cl.add(smp, false);
    const res = cl.finish(s(74) + 1000); // ticks ≤ 72.5 s are complete
    expect(res.map((r) => (r.ts - T0) / 1000)).toEqual([70, 71, 72]);
    expect(cl.droppedIncomplete).toBe(2 * 9);
    expect(finalRow(s(60))).toMatchObject({ covered: 13, good: 13 });
  });

  it('a tick processed after a later one is counted once at most (late tick)', () => {
    const { cl, finalRow } = setup();
    for (const smp of round(s(10))) cl.add(smp, false);
    cl.process(s(10) + 3000);
    for (const smp of round(s(11))) cl.add(smp, false);
    cl.add(ok('gw', s(9), 1), false); // straggler of an already processed target → sequencer drops it
    cl.add(ok('q4', s(9), 20), false); // ICMP target without a sample in tick 10 → a stale round
    cl.process(s(11) + 3000);
    expect(cl.lateTicks).toBe(1);
    cl.finish(s(30));
    expect(finalRow(s(0))).toMatchObject({ covered: 2, good: 2 });
  });

  it('merges ticks of a minute across a session stop/start instead of overwriting the row', () => {
    const { run, cl, written } = setup();
    run(0, 20);
    cl.finish(s(19) + 3000);
    cl.resetStream();
    run(40, 50);
    cl.finish(s(49) + 3000);
    const rows = written.filter((r) => r.ts === s(0));
    expect(rows.at(-1)).toMatchObject({ covered: 30, good: 30 });
  });

  it('seeds a minute from the persisted row after an engine restart (new process) instead of overwriting it', () => {
    const first = setup();
    first.run(0, 20);
    first.cl.finish(s(19) + 3000);
    const persisted = first.finalRow(s(0));
    expect(persisted).toMatchObject({ covered: 20 });

    // a new classifier instance = new engine process; the DB still holds the row of the first one
    const cfg = testConfig();
    const tracker = new BaselineTracker({ config: () => cfg });
    const written: SecondsRollup[] = [];
    const restarted = new SecondClassifier({
      config: () => cfg,
      verdict: (smp) => tracker.verdict(smp),
      clientAt: (ts) => clientState(ts),
      inRecovery: () => false,
      isGap: () => false,
      write: (rows) => written.push(...rows),
      read: (m) => (m === s(0) && persisted ? { ...persisted } : null),
    });
    for (let sec = 40; sec < 50; sec++) {
      for (const smp of round(s(sec), {})) restarted.add(smp, false);
      restarted.process(s(sec) + 3000);
    }
    restarted.finish(s(49) + 3000);
    expect(written.filter((r) => r.ts === s(0)).at(-1)).toMatchObject({ covered: 30, good: 30 });
  });
});

describe('SecondClassifier – real pinger stream (fixtures/windows/dotnet_pinger_stream.json)', () => {
  it('classifies each tick from replies and early .NET timeouts arriving out of order', () => {
    interface Rec { type: string; arrive: number; target?: string; seq?: number; status?: string; rtt?: number | null }
    const fixture = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'fixtures/windows/dotnet_pinger_stream.json'), 'utf8')) as { recs: Rec[] };
    // 192.0.2.1 (TEST-NET, never answers) stands in for Google IPv4 → IPv4 errored, IPv6 clean
    const idOf: Record<string, string> = { '192.168.0.1': 'gw', '1.1.1.1': 'cf4', '2606:4700:4700::1111': 'cf6', '192.0.2.1': 'g4', '192.168.0.2': 'x-arp' };
    const statusOf: Record<string, SampleStatusCode> = { Success: SampleStatus.OK, TimedOut: SampleStatus.TIMEOUT, DestinationHostUnreachable: SampleStatus.UNREACHABLE };
    const { cl } = setup();
    const results: SecondResult[] = [];
    for (const r of fixture.recs) {
      if (r.type !== 'echo' || !r.target || !r.seq || !r.status) continue;
      const arrive = T0 + r.arrive;
      results.push(...cl.process(arrive));
      const ts = T0 + (r.seq - 1) * 1000;
      cl.add({ targetId: idOf[r.target], ts, rtt: r.status === 'Success' ? (r.rtt ?? 0) : null, status: statusOf[r.status] ?? SampleStatus.ERROR }, false);
    }
    results.push(...cl.finish(Number.MAX_SAFE_INTEGER));
    expect(results).toHaveLength(9);
    for (const r of results) expect(r).toMatchObject({ cls: 'aftr', es: true, ses: false, selfLoad: false });
    expect(cl.lateTicks).toBe(0);
  });
});

describe('createClassifierModule', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('classifies the session stream, honours engine gaps and writes seconds_1m rows', () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const db = new MemoryDb();
    const { ctx, bus } = fakeContext({ db, clientState: () => clientState(Date.now()) });
    const mod = createClassifierModule();
    mod.init?.(ctx);
    mod.start?.();
    for (let sec = 0; sec < 125; sec++) {
      const ov: Override = sec >= 80 && sec < 90 ? { cf4: null, g4: null } : {};
      if (sec < 100 || sec >= 110) for (const smp of round(s(sec), ov)) ctx.recordSample(smp);
      if (sec === 112) ctx.recordEvent({ ts: s(99), endTs: s(111), type: 'engine_gap', severity: 'info', title: 'Messlücke', source: 'engine' });
      vi.advanceTimersByTime(1000);
    }
    expect(db.seconds.get(s(0))).toMatchObject({ covered: 60, good: 60 });
    // 100…109 without pinger samples, 110/111 inside the reported gap (99, 111]
    expect(db.seconds.get(s(60))).toMatchObject({ covered: 48, good: 38, aftr: 10, es: 10, ses: 10 });
    // session stop writes the running minute (complete ticks only)
    mod.stop?.();
    const last = db.seconds.get(s(120));
    expect(last?.covered).toBeGreaterThanOrEqual(1);
    expect(last?.good).toBe(last?.covered);
    expect(mod.state().running).toBe(false);
    expect(bus.listeners('client')).toBe(0);
    mod.dispose?.();
  });
});
