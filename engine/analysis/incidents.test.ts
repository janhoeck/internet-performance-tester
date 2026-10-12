import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../src/lib/shared/config';
import type { ClientState, NetEvent, OutageClass } from '../../src/lib/shared/types';
import type { BusEvents } from '../core/types';
import { BaselineTracker } from './baseline';
import { IncidentDetector, createIncidentsModule } from './incidents';
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
  const db = new MemoryDb();
  const incidents: BusEvents['incident'][] = [];
  const det = new IncidentDetector({
    config: () => cfg,
    verdict: (smp) => tracker.verdict(smp),
    clientAt: (ts) => (opts.client ? opts.client(ts) : clientState(ts)),
    inRecovery: (ts) => opts.recovery?.(ts) ?? false,
    recordEvent: (e) => db.insertEvent(e),
    updateEvent: (id, patch) => db.updateEvent(id, patch),
    emitIncident: (p) => incidents.push(p),
  });
  /** one pinger round per second, processed 3 s later like the 1 Hz module timer */
  const run = (from: number, to: number, override: (sec: number) => Override = () => ({}), load: (sec: number) => boolean = () => false) => {
    for (let sec = from; sec < to; sec++) {
      for (const smp of round(s(sec), override(sec))) det.add(smp, load(sec));
      det.process(s(sec) + 3000);
    }
  };
  const events = (type?: NetEvent['type']) => db.events.filter((e) => type === undefined || e.type === type);
  return { cfg, tracker, db, det, incidents, run, events };
}

describe('IncidentDetector – latency spikes', () => {
  it('stays quiet while everything is healthy (incl. the baseline warm-up)', () => {
    const { run, events } = setup();
    run(0, 120);
    expect(events()).toEqual([]);
  });

  it('persists merged spike episodes (≥ 2 spikes or severity ≥ major) with the contract details', () => {
    const { run, events } = setup();
    run(0, 70);
    run(70, 90, (sec) => (sec === 75 ? { cf4: 60 } : {})); // single minor spike → dropped
    expect(events('latency_spike')).toEqual([]);
    run(90, 100, (sec) => (sec === 90 || sec === 92 ? { cf4: 60 } : {})); // gap 2 s → one episode
    const [ep] = events('latency_spike');
    expect(ep).toMatchObject({
      ts: s(90),
      endTs: s(93), // last spike + interval
      severity: 'info',
      segment: 'internet',
      source: 'icmp',
      title: 'Latenzspitzen bei Cloudflare 1.1.1.1: bis 60 ms statt 18 ms (2×)',
      dedupeKey: `incident:spike:cf4:${s(90)}`,
    });
    expect(ep.details).toEqual({ targetId: 'cf4', peakMs: 60, baselineMs: 18, spikeSamples: 2, severity: 'minor', durationMs: 3000 });
  });

  it('maps severity: severe spike (≥ 200 ms) → warn, major → info; open episodes have endTs null', () => {
    const { run, events, det } = setup();
    run(0, 70);
    run(70, 72, (sec) => (sec === 70 ? { g4: 250 } : {}));
    const open = events('latency_spike')[0];
    expect(open).toMatchObject({ ts: s(70), endTs: null, severity: 'warn' });
    expect(open.title).toBe('Latenzspitze bei Google 8.8.8.8: 250 ms statt 19 ms');
    run(72, 80, (sec) => (sec === 75 ? { cf6: 80 } : {})); // 80 ≥ 17 + 50 → major
    const [severe, major] = events('latency_spike');
    expect(severe.endTs).toBe(s(71));
    expect(major).toMatchObject({ ts: s(75), severity: 'info' });
    expect(major.details).toMatchObject({ severity: 'major', spikeSamples: 1 });
    expect(det.outageActive).toBe(false);
  });

  it('notes a level shift when more than half of the last 60 s were spikes', () => {
    const { run, events } = setup();
    run(0, 80);
    run(80, 170, (sec) => (sec % 3 === 0 ? {} : { isp6: 60 }));
    run(170, 180);
    const [ep] = events('latency_spike');
    expect(ep.title).toContain('Anhaltend erhöhte Latenz bei Vodafone-Kopfstation');
    expect(ep.details).toMatchObject({ targetId: 'isp6', levelShift: true });
    expect(String(ep.details?.note)).toContain('mehr als die Hälfte der letzten 60 s');
    expect(events('latency_spike')).toHaveLength(1);
  });

  it('adds the control-plane hint to gateway spikes', () => {
    const { run, events } = setup();
    run(0, 70);
    run(70, 80, (sec) => (sec === 70 || sec === 71 ? { gw: 30 } : {}));
    const [ep] = events('latency_spike');
    expect(ep.segment).toBe('lan');
    expect(String(ep.details?.hint)).toContain('Control-Plane');
  });
});

describe('IncidentDetector – loss bursts', () => {
  it('records ≥ 2 losses within 10 s on one target as loss_burst (warn)', () => {
    const { run, events } = setup();
    run(0, 20);
    run(20, 40, (sec) => (sec === 20 || sec === 23 ? { cf4: null } : {}));
    const [b] = events('loss_burst');
    expect(b).toMatchObject({
      ts: s(20),
      endTs: s(24),
      severity: 'warn',
      segment: 'internet',
      title: 'Paketverlust bei Cloudflare 1.1.1.1: 2 von 4 Pings verloren',
      dedupeKey: `incident:burst:cf4:${s(20)}`,
    });
    expect(b.details).toEqual({ targetId: 'cf4', lost: 2, sent: 4, maxRun: 1, windowSec: 10, durationMs: 4000 });
    expect(events('outage')).toEqual([]);
  });

  it('isolated losses are no burst', () => {
    const { run, events } = setup();
    run(0, 60, (sec) => (sec % 15 === 0 ? { g6: null } : {}));
    expect(events()).toEqual([]);
  });
});

describe('IncidentDetector – outages', () => {
  const cases: { name: string; cls: OutageClass; lost: string[]; failover?: boolean; segment: string | null }[] = [
    { name: 'internet (provider hops answer)', cls: 'internet', lost: ['cf4', 'cf6', 'g4', 'g6'], segment: 'internet' },
    { name: 'IPv4 only → aftr', cls: 'aftr', lost: ['cf4', 'g4', 'isp4'], segment: 'aftr' },
    { name: 'gateway lost → lan', cls: 'lan', lost: ['gw', 'gw6', 'isp6', 'aftr', 'isp4', 'cf4', 'cf6', 'g4', 'g6'], segment: 'lan' },
    { name: 'CMTS lost → docsis', cls: 'docsis', lost: ['isp6', 'aftr', 'isp4', 'cf4', 'cf6', 'g4', 'g6'], segment: 'docsis' },
    { name: 'provider hops lost → isp', cls: 'isp', lost: ['aftr', 'isp4', 'cf4', 'cf6', 'g4', 'g6'], segment: 'isp' },
    { name: 'link failover → client', cls: 'client', lost: ['cf4', 'cf6', 'g4', 'g6'], failover: true, segment: 'client' },
  ];

  for (const c of cases) {
    it(`classifies ${c.name}, measures the duration and emits bus 'incident'`, () => {
      const inOutage = (ts: number) => ts >= s(200) && ts < s(205);
      const { run, events, incidents } = setup({
        client: (ts) => (c.failover && inOutage(ts) ? clientState(ts, { linkUp: false, onExpected: false, egressV4If: 'WLAN' }) : clientState(ts)),
      });
      run(0, 200);
      run(200, 230, (sec) => (sec < 205 ? Object.fromEntries(c.lost.map((id) => [id, null])) : {}));
      const outages = events('outage');
      expect(outages).toHaveLength(1);
      const o = outages[0];
      expect(o).toMatchObject({ ts: s(200), endTs: s(205), severity: 'critical', segment: c.segment, source: 'icmp' });
      expect(o.details).toMatchObject({ classification: c.cls, durationMs: 5000, rounds: 5, ongoing: false, nextSuccessTs: s(205), lastSuccessTs: s(199) });
      expect(o.title).toMatch(/^Ausfall \(5 s\): /);
      expect(incidents).toEqual([
        { kind: 'outage-start', ts: s(200), classification: c.cls },
        { kind: 'outage-end', ts: s(205), classification: c.cls },
      ]);
      // the losses inside the outage are not reported again as loss bursts
      expect(events('loss_burst')).toEqual([]);
    });
  }

  it('shows an ongoing outage while it lasts', () => {
    const { run, events } = setup();
    run(0, 10);
    run(10, 20, () => ({ cf4: null, cf6: null, g4: null, g6: null }));
    const [o] = events('outage');
    expect(o).toMatchObject({ ts: s(10), endTs: null, title: 'Ausfall läuft: Internet' });
    expect(o.details).toMatchObject({ ongoing: true, classification: 'internet' });
  });

  it('suppresses bursts inside an outage also when a large batch is processed at once', () => {
    const { det, events } = setup();
    for (let sec = 0; sec < 40; sec++) {
      const ov: Override = sec >= 10 && sec < 20 ? { cf4: null, cf6: null, g4: null, g6: null } : {};
      for (const smp of round(s(sec), ov)) det.add(smp, false);
    }
    det.process(s(40) + 3000);
    expect(events('outage')).toHaveLength(1);
    expect(events('loss_burst')).toEqual([]);
  });
});

describe('IncidentDetector – speed test, engine gaps, stop', () => {
  it('raises no spike/burst events and starts no outage while a speed test runs', () => {
    const { run, events } = setup();
    run(0, 70);
    run(
      70,
      100,
      (sec) => (sec < 90 ? { gw: 40, cf4: sec % 2 ? null : 300, cf6: null, g4: null, g6: 250 } : {}),
      (sec) => sec < 90,
    );
    expect(events()).toEqual([]);
  });

  it('engine gap: closes open episodes/outages and starts from scratch', () => {
    const { run, events, det, incidents } = setup();
    run(0, 70);
    run(70, 76, (sec) => (sec === 74 || sec === 75 ? { cf4: 70 } : sec === 72 ? { g4: null } : {}));
    expect(events('latency_spike')[0].endTs).toBeNull();
    det.onEngineGap(s(75));
    expect(events('latency_spike')[0].endTs).toBe(s(76));
    // loss before the gap + loss after it: no burst (state reset)
    run(400, 420, (sec) => (sec === 401 ? { g4: null } : {}));
    expect(events('loss_burst')).toEqual([]);

    run(500, 503, () => ({ cf4: null, cf6: null, g4: null, g6: null }));
    expect(incidents.map((i) => i.kind)).toEqual(['outage-start']);
    det.onEngineGap(s(502)); // last tick before the gap: 502
    const o = events('outage')[0];
    expect(o.endTs).toBe(s(503));
    expect(o.details).toMatchObject({ interrupted: true, durationMs: 3000, nextSuccessTs: null });
    expect(o.title).toBe('Ausfall (mind. 3 s): Internet');
    expect(incidents.map((i) => i.kind)).toEqual(['outage-start', 'outage-end']);
  });

  it('stop(now) processes complete ticks only and closes everything', () => {
    const a = setup();
    a.run(0, 20);
    for (let sec = 20; sec <= 24; sec++) {
      const lostRound = sec >= 22 ? { cf4: null, cf6: null, g4: null, g6: null } : {};
      for (const smp of round(s(sec), lostRound)) a.det.add(smp, false);
    }
    a.det.stop(s(24) + 1000); // ticks 23 and 24 may still miss timeouts → dropped
    expect(a.events('outage')).toEqual([]);

    const b = setup();
    b.run(0, 20);
    for (let sec = 20; sec <= 24; sec++) {
      const lostRound = sec >= 22 ? { cf4: null, cf6: null, g4: null, g6: null } : {};
      for (const smp of round(s(sec), lostRound)) b.det.add(smp, false);
    }
    b.det.stop(s(24) + 2500);
    const [o] = b.events('outage');
    expect(o).toMatchObject({ ts: s(22), endTs: s(25) });
    expect(o.details).toMatchObject({ interrupted: true, durationMs: 3000 });
  });

  it('skips TCP/UDP samples whose RTT was distorted by an engine stall', () => {
    const { det, tracker, events } = setup();
    det.add(ok('cf4-tcp', s(10), 900), false); // ≥ 200 ms → severe spike even without baseline
    det.process(s(40));
    expect(events('latency_spike')).toHaveLength(1);

    tracker.noteStall(s(50) + 100, s(50) + 1000);
    det.add(ok('cf6-tcp', s(50), 950), false);
    det.add(lost('aws-fra', s(50)), false);
    det.process(s(80));
    expect(events('latency_spike')).toHaveLength(1);
    expect(det.unreliableSamples).toBe(1);
  });
});

describe('createIncidentsModule', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs on the bus during a session and persists outage events with duration', () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const db = new MemoryDb();
    const { ctx, bus } = fakeContext({ db, clientState: () => clientState(Date.now()) });
    const mod = createIncidentsModule();
    mod.init?.(ctx);
    expect(mod.state().running).toBe(false);
    mod.start?.();
    expect(mod.state().running).toBe(true);
    for (let sec = 0; sec < 40; sec++) {
      const ov: Override = sec >= 10 && sec < 16 ? { cf4: null, cf6: null, g4: null, g6: null } : {};
      for (const smp of round(s(sec), ov)) ctx.recordSample(smp);
      vi.advanceTimersByTime(1000);
    }
    const o = db.events.find((e) => e.type === 'outage');
    expect(o).toMatchObject({ ts: s(10), endTs: s(16) });
    expect(o?.details).toMatchObject({ durationMs: 6000, classification: 'internet' });
    expect(bus.payloads('incident').map((i) => i.kind)).toEqual(['outage-start', 'outage-end']);
    expect(mod.state().lastRunTs).not.toBeNull();

    // engine gap during an outage closes it as interrupted
    for (let sec = 40; sec < 45; sec++) {
      for (const smp of round(s(sec), { cf4: null, cf6: null, g4: null, g6: null })) ctx.recordSample(smp);
      vi.advanceTimersByTime(1000);
    }
    ctx.recordEvent({ ts: s(43), endTs: s(60), type: 'engine_gap', severity: 'info', title: 'Messlücke', source: 'engine' });
    const second = db.events.filter((e) => e.type === 'outage')[1];
    expect(second.details).toMatchObject({ interrupted: true });

    const listeners = bus.listeners('sample');
    mod.stop?.();
    expect(mod.state().running).toBe(false);
    expect(bus.listeners('sample')).toBe(listeners - 1); // only the shared baseline tracker stays subscribed
    mod.dispose?.();
  });
});
