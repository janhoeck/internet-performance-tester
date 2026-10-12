import { describe, expect, it } from 'vitest';
import {
  type FinishedOutage,
  type OutageInfo,
  type OutageRound,
  OutageDetector,
  classifyOutageRound,
  isOutageRound,
  isSuccessRound,
  majorityClass,
} from './outage';
import { T0 } from './test-helpers';

const s = (sec: number) => T0 + sec * 1000;

/** healthy default round (gw, gw6, isp6, aftr, isp4, cf4, cf6, g4, g6 all answered) */
function healthy(ts: number): OutageRound {
  return {
    ts,
    linkIssue: false,
    internetLost: [],
    internetOk: ['cf4', 'cf6', 'g4', 'g6'],
    lanLost: 0,
    lanOk: 2,
    isp6Lost: 0,
    isp6Ok: 1,
    v4Lost: 0,
    v4Ok: 2,
    v6Lost: 0,
    v6Ok: 2,
    providerLost: 0,
    providerOk: 2,
    lostTargets: [],
    load: false,
  };
}

/** round in which the given targets were lost (others answered); `missing` had no sample at all */
function roundWith(ts: number, lost: string[], opts: { missing?: string[]; linkIssue?: boolean; load?: boolean } = {}): OutageRound {
  const missing = new Set(opts.missing ?? []);
  const lostSet = new Set(lost);
  const n = (ids: string[], isLost: boolean) => ids.filter((id) => !missing.has(id) && lostSet.has(id) === isLost).length;
  const internet = ['cf4', 'cf6', 'g4', 'g6'].filter((id) => !missing.has(id));
  return {
    ts,
    linkIssue: opts.linkIssue ?? false,
    internetLost: internet.filter((id) => lostSet.has(id)),
    internetOk: internet.filter((id) => !lostSet.has(id)),
    lanLost: n(['gw', 'gw6'], true),
    lanOk: n(['gw', 'gw6'], false),
    isp6Lost: n(['isp6'], true),
    isp6Ok: n(['isp6'], false),
    v4Lost: n(['cf4', 'g4'], true),
    v4Ok: n(['cf4', 'g4'], false),
    v6Lost: n(['cf6', 'g6'], true),
    v6Ok: n(['cf6', 'g6'], false),
    providerLost: n(['aftr', 'isp4'], true),
    providerOk: n(['aftr', 'isp4'], false),
    lostTargets: lost.filter((id) => !missing.has(id)),
    load: opts.load ?? false,
  };
}

const ALL_INET = ['cf4', 'cf6', 'g4', 'g6'];

describe('classifyOutageRound', () => {
  it('client: expected link down / failover / relink window', () => {
    expect(classifyOutageRound(roundWith(T0, ['gw', 'gw6', 'isp6', ...ALL_INET], { linkIssue: true }))).toBe('client');
    // WLAN failover: the router still answers over WLAN, internet lost during the switch
    expect(classifyOutageRound(roundWith(T0, ALL_INET, { linkIssue: true }))).toBe('client');
  });

  it('lan: every measured LAN target lost – a single lost gw6 reply does not decide', () => {
    expect(classifyOutageRound(roundWith(T0, ['gw', 'gw6', 'isp6', 'aftr', 'isp4', ...ALL_INET]))).toBe('lan');
    expect(classifyOutageRound(roundWith(T0, ['gw', 'isp6', ...ALL_INET], { missing: ['gw6'] }))).toBe('lan');
    expect(classifyOutageRound(roundWith(T0, ['gw6', 'isp6', 'aftr', 'isp4', ...ALL_INET]))).toBe('docsis');
  });

  it('docsis: router fine, CMTS lost and nothing behind it answers', () => {
    expect(classifyOutageRound(roundWith(T0, ['isp6', 'aftr', 'isp4', ...ALL_INET]))).toBe('docsis');
    expect(classifyOutageRound(roundWith(T0, ['isp6', ...ALL_INET], { missing: ['aftr', 'isp4'] }))).toBe('docsis');
    // the CMTS dropping ICMP while IPv6 through it works is no DOCSIS outage
    expect(classifyOutageRound(roundWith(T0, ['isp6', 'cf4', 'g4']))).toBe('aftr');
  });

  it('aftr: all IPv4 internet targets lost while IPv6 answers (DS-Lite)', () => {
    expect(classifyOutageRound(roundWith(T0, ['cf4', 'g4', 'isp4']))).toBe('aftr');
    expect(classifyOutageRound(roundWith(T0, ['cf4', 'g4', 'g6']))).toBe('aftr'); // one IPv6 target still answers
  });

  it('isp / internet: both families down behind a healthy CMTS', () => {
    expect(classifyOutageRound(roundWith(T0, ['aftr', 'isp4', ...ALL_INET]))).toBe('isp');
    expect(classifyOutageRound(roundWith(T0, ALL_INET, { missing: ['aftr', 'isp4'] }))).toBe('isp');
    expect(classifyOutageRound(roundWith(T0, ALL_INET))).toBe('internet'); // Vodafone's own hops answer
    // CMTS lost too, but the provider hops answer → not the cable line
    expect(classifyOutageRound(roundWith(T0, ['isp6', ...ALL_INET]))).toBe('internet');
  });

  it('isp: native IPv6 down while IPv4 (tunnelled to the AFTR) works', () => {
    expect(classifyOutageRound(roundWith(T0, ['cf6', 'g6']))).toBe('isp');
  });

  it('internet: individual targets of both families (target specific)', () => {
    expect(classifyOutageRound(roundWith(T0, ['cf4', 'cf6']))).toBe('internet');
  });

  it('unknown: the deciding layer was not measured', () => {
    expect(classifyOutageRound(roundWith(T0, ['aftr', 'isp4', ...ALL_INET], { missing: ['isp6'] }))).toBe('unknown');
    expect(classifyOutageRound(roundWith(T0, ['cf4', 'g4'], { missing: ['cf6', 'g6'] }))).toBe('unknown');
  });

  it('outage and success rounds', () => {
    expect(isOutageRound(roundWith(T0, ['cf4']))).toBe(false);
    expect(isOutageRound(roundWith(T0, ['cf4', 'g6']))).toBe(true);
    expect(isSuccessRound(roundWith(T0, ['cf4']))).toBe(true);
    expect(isSuccessRound(roundWith(T0, [], { missing: ALL_INET }))).toBe(false); // no internet data → neutral
  });
});

describe('majorityClass', () => {
  it('takes the most frequent known class, ties go to the layer closest to the PC', () => {
    expect(majorityClass({})).toBe('unknown');
    expect(majorityClass({ docsis: 3, internet: 5 })).toBe('internet');
    expect(majorityClass({ lan: 2, docsis: 2 })).toBe('lan');
    expect(majorityClass({ unknown: 9, aftr: 1 })).toBe('aftr');
    expect(majorityClass({ unknown: 4 })).toBe('unknown');
  });
});

describe('OutageDetector', () => {
  function setup(minRounds = 3) {
    const started: OutageInfo[] = [];
    const ended: FinishedOutage[] = [];
    let min = minRounds;
    const det = new OutageDetector(
      { onStart: (o) => started.push(o), onEnd: (o) => ended.push(o) },
      { minRounds: () => min },
    );
    return { det, started, ended, setMin: (m: number) => (min = m) };
  }

  it('needs outageMinSec consecutive lost rounds; duration = next success − last success − interval', () => {
    const { det, started, ended } = setup(3);
    det.process(healthy(s(0)));
    det.process(roundWith(s(1), ALL_INET));
    det.process(roundWith(s(2), ALL_INET));
    expect(started).toHaveLength(0);
    det.process(roundWith(s(3), ['isp6', 'aftr', 'isp4', ...ALL_INET]));
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({ startTs: s(1), rounds: 3, lastSuccessTs: s(0), lostTargets: ['aftr', 'cf4', 'cf6', 'g4', 'g6', 'isp4', 'isp6'] });
    expect(started[0].classification).toBe('internet'); // 2 × internet, 1 × docsis
    expect(det.isActive).toBe(true);
    det.process(roundWith(s(4), ['isp6', 'aftr', 'isp4', ...ALL_INET]));
    det.process(roundWith(s(5), ['isp6', 'aftr', 'isp4', ...ALL_INET]));
    det.process(healthy(s(6)));
    expect(ended).toHaveLength(1);
    expect(ended[0]).toMatchObject({
      startTs: s(1),
      endTs: s(6),
      nextSuccessTs: s(6),
      durationMs: 5000, // 6 − 0 − 1 s: rounds 1…5 lost
      rounds: 5,
      interrupted: false,
      classification: 'docsis', // 3 × docsis vs. 2 × internet
      initialClassification: 'internet',
    });
    expect(det.isActive).toBe(false);
  });

  it('two lost rounds followed by a success are no outage', () => {
    const { det, started } = setup(3);
    det.process(roundWith(s(0), ALL_INET));
    det.process(roundWith(s(1), ALL_INET));
    det.process(roundWith(s(2), ['cf4']));
    det.process(roundWith(s(3), ALL_INET));
    det.process(roundWith(s(4), ALL_INET));
    expect(started).toHaveLength(0);
  });

  it('rounds without internet data are neutral; a tick gap breaks the consecutive rounds', () => {
    const { det, started } = setup(3);
    det.process(roundWith(s(0), ALL_INET));
    det.process(roundWith(s(1), [], { missing: ALL_INET })); // neutral
    det.process(roundWith(s(2), ALL_INET));
    det.process(roundWith(s(6), ALL_INET)); // 4 s gap → starts over
    det.process(roundWith(s(7), ALL_INET));
    expect(started).toHaveLength(0);
    det.process(roundWith(s(8), ALL_INET));
    expect(started).toHaveLength(1);
    expect(started[0].startTs).toBe(s(6));
    expect(started[0].lastSuccessTs).toBe(s(5)); // no success right before → startTs − interval
  });

  it('speed-test rounds cannot start an outage but continue an active one', () => {
    const { det, started, ended } = setup(2);
    det.process(roundWith(s(0), ALL_INET, { load: true }));
    det.process(roundWith(s(1), ALL_INET, { load: true }));
    expect(started).toHaveLength(0);
    det.process(roundWith(s(2), ALL_INET));
    det.process(roundWith(s(3), ALL_INET));
    expect(started).toHaveLength(1);
    det.process(roundWith(s(4), ALL_INET, { load: true }));
    det.process(healthy(s(5)));
    expect(ended[0]).toMatchObject({ rounds: 3, durationMs: 3000 });
  });

  it('interrupt() closes the outage with the observed lower bound and forgets the last success', () => {
    const { det, started, ended } = setup(3);
    det.process(healthy(s(0)));
    for (let i = 1; i <= 4; i++) det.process(roundWith(s(i), ['cf4', 'g4']));
    expect(started[0].classification).toBe('aftr');
    det.interrupt();
    expect(ended[0]).toMatchObject({ startTs: s(1), endTs: s(5), durationMs: 4000, nextSuccessTs: null, interrupted: true });
    det.process(roundWith(s(100), ['cf4', 'g4']));
    det.process(roundWith(s(101), ['cf4', 'g4']));
    det.process(roundWith(s(102), ['cf4', 'g4']));
    expect(started[1].lastSuccessTs).toBe(s(99));
  });

  it('reads outageMinSec fresh and reports target overlap for loss-burst suppression', () => {
    const { det, started, setMin } = setup(5);
    setMin(2);
    det.process(roundWith(s(10), ['gw', 'gw6', ...ALL_INET]));
    det.process(roundWith(s(11), ['gw', 'gw6', ...ALL_INET]));
    expect(started[0].classification).toBe('lan');
    expect(det.overlaps('cf4', s(8), s(10))).toBe(true); // active outage
    expect(det.overlaps('isp6', s(8), s(10))).toBe(false); // isp6 was never lost
    det.process(healthy(s(12)));
    expect(det.overlaps('gw', s(11), s(20))).toBe(true); // finished span [10, 12]
    expect(det.overlaps('gw', s(13), s(20))).toBe(false);
  });
});
