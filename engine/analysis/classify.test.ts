import { describe, expect, it } from 'vitest';
import {
  type MemberResult,
  type SecondInput,
  addSecond,
  classifySecond,
  emptySecondsRollup,
  groupState,
  isLinkSecond,
  isSelfLoad,
} from './classify';
import { T0, clientState, testConfig } from './test-helpers';

const good = (targetId: string, rtt = 18): MemberResult => ({ targetId, lost: false, spike: false, rtt });
const lost = (targetId: string): MemberResult => ({ targetId, lost: true, spike: false, rtt: null });
const spike = (targetId: string, rtt = 120): MemberResult => ({ targetId, lost: false, spike: true, rtt });

function input(patch: Partial<SecondInput> = {}): SecondInput {
  return {
    ts: T0,
    excluded: false,
    link: false,
    gw: [good('gw', 1), good('gw6', 1)],
    isp6: [good('isp6', 12)],
    v4: [good('cf4'), good('g4')],
    v6: [good('cf6'), good('g6')],
    game: [good('aws-fra', 25)],
    selfLoad: false,
    ...patch,
  };
}

describe('groupState', () => {
  it('is bad when any member is lost or spiked, none without members', () => {
    expect(groupState([])).toBe('none');
    expect(groupState([good('a'), good('b')])).toBe('ok');
    expect(groupState([good('a'), lost('b')])).toBe('bad');
    expect(groupState([spike('a'), good('b')])).toBe('bad');
  });
});

describe('classifySecond (first match wins)', () => {
  it('excluded', () => {
    const r = classifySecond(input({ excluded: true, link: true, v4: [lost('cf4'), lost('g4')] }));
    expect(r).toEqual({ ts: T0, cls: 'excluded', es: false, ses: false, selfLoad: false });
  });

  it('link beats everything else (failover / link down / relink window)', () => {
    const r = classifySecond(input({ link: true, gw: [lost('gw')], v4: [lost('cf4'), lost('g4')], v6: [lost('cf6'), lost('g6')] }));
    expect(r.cls).toBe('link');
    expect(r.es).toBe(true);
    expect(r.ses).toBe(true);
  });

  it('lan when the gateway is lost or spikes', () => {
    expect(classifySecond(input({ gw: [lost('gw'), good('gw6')] })).cls).toBe('lan');
    expect(classifySecond(input({ gw: [good('gw'), spike('gw6', 15)] })).cls).toBe('lan');
    expect(classifySecond(input({ gw: [lost('gw')], v4: [lost('cf4'), good('g4')] })).cls).toBe('lan');
  });

  it('good when no group is errored (also with unknown groups)', () => {
    expect(classifySecond(input()).cls).toBe('good');
    const r = classifySecond(input({ isp6: [], game: [] }));
    expect(r).toEqual({ ts: T0, cls: 'good', es: false, ses: false, selfLoad: false });
  });

  it('access: CMTS bad and both families errored', () => {
    const r = classifySecond(input({ isp6: [spike('isp6', 138)], v4: [spike('cf4', 145), good('g4')], v6: [good('cf6'), spike('g6', 150)] }));
    expect(r.cls).toBe('access');
    expect(r.es).toBe(true);
    expect(r.ses).toBe(false);
  });

  it('aftr: IPv4 errored while IPv6 is clean', () => {
    expect(classifySecond(input({ v4: [lost('cf4'), lost('g4')] })).cls).toBe('aftr');
    // CMTS spiking on its own does not matter when IPv6 through it is clean
    expect(classifySecond(input({ isp6: [spike('isp6')], v4: [spike('cf4'), good('g4')] })).cls).toBe('aftr');
  });

  it('backbone: CMTS fine, both families errored', () => {
    const r = classifySecond(input({ v4: [lost('cf4'), good('g4')], v6: [spike('cf6', 90), good('g6')] }));
    expect(r.cls).toBe('backbone');
  });

  it('remote: only the game target is bad', () => {
    expect(classifySecond(input({ game: [lost('aws-fra')] })).cls).toBe('remote');
    expect(classifySecond(input({ game: [spike('aws-irl', 210)] })).cls).toBe('remote');
  });

  it('unknown: errored but no rule matches', () => {
    expect(classifySecond(input({ v6: [lost('cf6'), good('g6')] })).cls).toBe('unknown'); // IPv6 only
    expect(classifySecond(input({ isp6: [spike('isp6')] })).cls).toBe('unknown'); // CMTS alone
    expect(classifySecond(input({ isp6: [], v4: [lost('cf4'), good('g4')], v6: [lost('cf6'), good('g6')] })).cls).toBe('unknown'); // CMTS unknown
    expect(classifySecond(input({ isp6: [spike('isp6')], game: [lost('aws-fra')] })).cls).toBe('unknown');
    expect(classifySecond(input({ v4: [lost('cf4')], v6: [] })).cls).toBe('unknown'); // no IPv6 data
  });

  it('es = loss or spike on v4 or v6; ses = ≥ half of the internet probes lost or RTT ≥ 200 ms', () => {
    const one = classifySecond(input({ v4: [lost('cf4'), good('g4')] }));
    expect(one.es).toBe(true);
    expect(one.ses).toBe(false); // 1 of 4
    const half = classifySecond(input({ v4: [lost('cf4'), lost('g4')] }));
    expect(half.ses).toBe(true); // 2 of 4
    const lag = classifySecond(input({ v6: [spike('cf6', 200), good('g6')] }));
    expect(lag.es).toBe(true);
    expect(lag.ses).toBe(true);
    const nearly = classifySecond(input({ v6: [spike('cf6', 199), good('g6')] }));
    expect(nearly.ses).toBe(false);
    // only the CMTS or the game is bad → not an errored internet second
    expect(classifySecond(input({ isp6: [spike('isp6', 250)] })).es).toBe(false);
    expect(classifySecond(input({ game: [spike('aws-fra', 260)] })).ses).toBe(false);
  });

  it('passes selfLoad through (except for excluded seconds)', () => {
    expect(classifySecond(input({ selfLoad: true })).selfLoad).toBe(true);
    expect(classifySecond(input({ selfLoad: true, excluded: true })).selfLoad).toBe(false);
  });
});

describe('isLinkSecond', () => {
  it('link down, failover (egress not on the expected interface) or relink window', () => {
    expect(isLinkSecond(null, false)).toBe(false);
    expect(isLinkSecond(null, true)).toBe(true);
    expect(isLinkSecond(clientState(T0), false)).toBe(false);
    expect(isLinkSecond(clientState(T0, { linkUp: false }), false)).toBe(true);
    expect(isLinkSecond(clientState(T0, { onExpected: false }), false)).toBe(true);
    expect(isLinkSecond(clientState(T0, { onExpected: null, linkUp: null }), false)).toBe(false);
  });
});

describe('isSelfLoad', () => {
  it('compares own rx/tx with selfLoadPct % of min(link speed, tariff)', () => {
    const noTariff = testConfig();
    expect(isSelfLoad(clientState(T0, { linkMbps: 100, rxMbps: 80 }), noTariff)).toBe(true); // 100 Mbit link
    expect(isSelfLoad(clientState(T0, { linkMbps: 1000, rxMbps: 80 }), noTariff)).toBe(false);
    const tariff = testConfig((c) => {
      c.tariff = { name: 'Kabel 250', downMbps: 250, upMbps: 50 };
    });
    expect(isSelfLoad(clientState(T0, { linkMbps: 1000, rxMbps: 200 }), tariff)).toBe(true);
    expect(isSelfLoad(clientState(T0, { linkMbps: 1000, rxMbps: 199 }), tariff)).toBe(false);
    expect(isSelfLoad(clientState(T0, { linkMbps: 1000, txMbps: 40 }), tariff)).toBe(true);
    expect(isSelfLoad(clientState(T0, { linkMbps: null, rxMbps: 500 }), noTariff)).toBe(false);
    expect(isSelfLoad(clientState(T0, { linkMbps: null, rxMbps: null, txMbps: 45 }), tariff)).toBe(true);
    expect(isSelfLoad(null, tariff)).toBe(false);
  });
});

describe('minute rows', () => {
  it('counts classes, es/ses/selfLoad and skips excluded seconds', () => {
    const row = emptySecondsRollup(T0);
    addSecond(row, { ts: T0, cls: 'good', es: false, ses: false, selfLoad: false });
    addSecond(row, { ts: T0 + 1000, cls: 'access', es: true, ses: true, selfLoad: true });
    addSecond(row, { ts: T0 + 2000, cls: 'excluded', es: false, ses: false, selfLoad: false });
    addSecond(row, { ts: T0 + 3000, cls: 'link', es: true, ses: false, selfLoad: false });
    expect(row).toEqual({ ts: T0, covered: 3, good: 1, link: 1, lan: 0, access: 1, aftr: 0, backbone: 0, remote: 0, unknown: 0, es: 2, ses: 1, selfLoad: 1 });
  });
});
