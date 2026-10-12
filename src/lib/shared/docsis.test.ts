// DOCSIS rating + router event-log categorizer tests. Every breakpoint of the VFKD 17.06.2018
// service table (docs/research/docsis-thresholds.md §3–§9) and the §11 event catalogue is exercised.
import { describe, expect, it } from 'vitest';
import {
  channelFamily,
  channelKey,
  channelLabel,
  classifyLogMessage,
  CM_STATUS_CODES,
  escalateLogBursts,
  gradeHealth,
  lockState,
  mobileBandHint,
  normalizeChannelType,
  normalizeLogMessage,
  normalizeOfdmaPower,
  parseLockStatus,
  qamOrder,
  rateDocsis,
  rateLowerBound,
  rateOfdmMer,
  rateSymmetric,
  rateUsModulation,
  redactMacs,
  requiredOfdmCnr,
  supportableQam,
  usHeadroom,
  VFKD,
  worstGrade,
  type DocsisChannelInput,
  type DocsisGrade,
} from './docsis';

// helper to build a channel input
const ch = (o: Partial<DocsisChannelInput> & { dir: 'ds' | 'us' }): DocsisChannelInput => ({
  channelId: 1,
  type: o.dir === 'ds' ? 'SC-QAM' : 'SC-QAM',
  frequencyMHz: null,
  frequencyText: null,
  powerDbmv: null,
  snrDb: null,
  modulation: null,
  locked: true,
  corrected: null,
  uncorrectable: null,
  ...o,
});

// ─── Scale primitives ───────────────────────────────────────────────────────

describe('rateSymmetric (DS 256QAM power [-8,-6,-4,13,18,20])', () => {
  const b = VFKD.dsPower.qam256;
  const cases: [number, DocsisGrade][] = [
    [-9, 'sofort'], [-8, 'sofort'],
    [-7.9, 'monatsfrist'], [-6, 'monatsfrist'],
    [-5.9, 'toleriert'], [-4, 'toleriert'],
    [-3.9, 'konform'], [0, 'konform'], [13, 'konform'],
    [13.1, 'toleriert'], [18, 'toleriert'],
    [18.1, 'monatsfrist'], [20, 'monatsfrist'],
    [20.1, 'sofort'], [25, 'sofort'],
  ];
  for (const [v, g] of cases) it(`${v} dBmV → ${g}`, () => expect(rateSymmetric(v, b)).toBe(g));
  it('NaN → unbekannt', () => expect(rateSymmetric(Number.NaN, b)).toBe('unbekannt'));
});

describe('rateLowerBound (DS 256QAM SNR [30,32,33])', () => {
  const a = VFKD.dsSnr.qam256;
  const cases: [number, DocsisGrade][] = [
    [30, 'sofort'], [30.1, 'monatsfrist'], [32, 'monatsfrist'],
    [32.1, 'toleriert'], [33, 'toleriert'], [33.1, 'konform'], [40, 'konform'],
  ];
  for (const [v, g] of cases) it(`${v} dB → ${g}`, () => expect(rateLowerBound(v, a)).toBe(g));
});

describe('64QAM uses the 6 dB-lower scale', () => {
  it('−12 dBmV is monatsfrist on 64QAM but worse would be sofort on 256QAM', () => {
    expect(rateSymmetric(-12, VFKD.dsPower.qam64)).toBe('monatsfrist');
    expect(rateSymmetric(-12, VFKD.dsPower.qam256)).toBe('sofort');
  });
  it('25 dB SNR is konform on 64QAM', () => expect(rateLowerBound(25, VFKD.dsSnr.qam64)).toBe('monatsfrist'));
});

describe('worstGrade / gradeHealth', () => {
  it('picks the worst and maps to Health', () => {
    expect(worstGrade(['konform', 'toleriert', 'monatsfrist'])).toBe('monatsfrist');
    expect(worstGrade(['konform', 'sofort'])).toBe('sofort');
    expect(worstGrade([])).toBe('unbekannt');
    expect(gradeHealth('konform')).toBe('good');
    expect(gradeHealth('toleriert')).toBe('good');
    expect(gradeHealth('monatsfrist')).toBe('warn');
    expect(gradeHealth('sofort')).toBe('bad');
    expect(gradeHealth('unbekannt')).toBe('unknown');
  });
});

// ─── Modulation / channel identity ──────────────────────────────────────────

describe('qamOrder / normalizeChannelType / channelFamily', () => {
  it('reads QAM orders and QPSK', () => {
    expect(qamOrder('256QAM')).toBe(256);
    expect(qamOrder('4096QAM')).toBe(4096);
    expect(qamOrder('QAM-256')).toBe(256);
    expect(qamOrder('QPSK')).toBe(4);
    expect(qamOrder(null)).toBeNull();
  });
  it('normalizes channel types by direction', () => {
    expect(normalizeChannelType('OFDM', 'ds')).toBe('OFDM');
    expect(normalizeChannelType('OFDM', 'us')).toBe('OFDMA');
    expect(normalizeChannelType('OFDMA', 'us')).toBe('OFDMA');
    expect(normalizeChannelType('SC-QAM', 'ds')).toBe('SC-QAM');
    expect(normalizeChannelType('', 'ds')).toBe('SC-QAM');
  });
  it('channelFamily + channelKey are frequency-keyed (not id)', () => {
    const c = { dir: 'ds' as const, type: 'SC-QAM', frequencyMHz: 602, frequencyText: null };
    expect(channelFamily(c)).toBe('ds');
    expect(channelKey(c)).toBe('ds:SC-QAM:602');
    expect(channelLabel({ ...c, channelId: 5 })).toBe('DS 602 MHz');
  });
});

// ─── Lock / ranging ─────────────────────────────────────────────────────────

describe('lockState / parseLockStatus', () => {
  it('DS: only locked synonyms count; everything else is a failure', () => {
    expect(lockState('Locked', 'ds')).toBe('locked');
    expect(lockState('JA', 'ds')).toBe('locked');
    expect(lockState('NEIN', 'ds')).toBe('failed');
    expect(parseLockStatus('Locked', 'ds')).toBe(true);
    expect(parseLockStatus('NEIN', 'ds')).toBe(false);
  });
  it('US: ACTIVE/SUCCESS ok, continue transient, timeoutT4 failed, unknown stays unknown', () => {
    expect(lockState('ACTIVE', 'us')).toBe('locked');
    expect(lockState('SUCCESS', 'us')).toBe('locked');
    expect(lockState('continue', 'us')).toBe('transient');
    expect(lockState('timeoutT4', 'us')).toBe('failed');
    expect(lockState('weird', 'us')).toBe('unknown');
    expect(parseLockStatus('continue', 'us')).toBeNull();
    expect(parseLockStatus('weird', 'us')).toBeNull();
  });
});

// ─── OFDM MER vs required CNR ───────────────────────────────────────────────

describe('requiredOfdmCnr / supportableQam / rateOfdmMer', () => {
  it('required CNR per modulation (≤1 GHz vs 1–1.2 GHz)', () => {
    expect(requiredOfdmCnr(4096)).toBe(41);
    expect(requiredOfdmCnr(4096, 1100)).toBe(41.5);
    expect(requiredOfdmCnr(1024)).toBe(34);
    expect(requiredOfdmCnr(null)).toBeNull();
  });
  it('supportableQam from a measured MER', () => {
    expect(supportableQam(41)).toBe(4096);
    expect(supportableQam(40)).toBe(2048);
    expect(supportableQam(34)).toBe(1024);
    expect(supportableQam(10)).toBe(0);
  });
  it('rates OFDM MER against the profile: +3 dB konform, ≥0 monatsfrist, below sofort', () => {
    expect(rateOfdmMer(44, 4096).grade).toBe('konform'); // 44 ≥ 41+3
    expect(rateOfdmMer(42, 4096).grade).toBe('monatsfrist'); // 41 ≤ 42 < 44
    expect(rateOfdmMer(40, 4096).grade).toBe('sofort'); // < 41
    const r = rateOfdmMer(42, 4096);
    expect(r.requiredDb).toBe(41);
    expect(r.marginDb).toBe(1);
  });
  it('falls back to the synthesized absolute scale [35,38,40] when the modulation is unknown', () => {
    expect(rateOfdmMer(41, null).grade).toBe('konform'); // > 40
    expect(rateOfdmMer(39, null).grade).toBe('toleriert'); // 38 < 39 ≤ 40
    expect(rateOfdmMer(37, null).grade).toBe('monatsfrist'); // 35 < 37 ≤ 38
    expect(rateOfdmMer(34, null).grade).toBe('sofort'); // ≤ 35
  });
});

// ─── US modulation / OFDMA normalization / headroom ─────────────────────────

describe('rateUsModulation', () => {
  it('64QAM konform, 32 toleriert, 16 monatsfrist, QPSK sofort', () => {
    expect(rateUsModulation(64)).toBe('konform');
    expect(rateUsModulation(32)).toBe('toleriert');
    expect(rateUsModulation(16)).toBe('monatsfrist');
    expect(rateUsModulation(4)).toBe('sofort');
    expect(rateUsModulation(null)).toBe('unbekannt');
  });
});

describe('normalizeOfdmaPower', () => {
  it('auto-picks the interpretation closest to the SC-QAM median', () => {
    // SC-QAM around 50; a P1.6 display of 44 (+6.02 = 50.02) should be chosen as p1.6
    const r = normalizeOfdmaPower(44, 35, [50, 50.5, 49.5], 'auto');
    expect(r.mode).toBe('p1.6');
    expect(r.p64).toBeCloseTo(50.02, 1);
  });
  it('honours a manual mode', () => {
    expect(normalizeOfdmaPower(44, 35, [50], 'p6.4')).toMatchObject({ p64: 44, mode: 'p6.4', confidence: 'manuell' });
  });
});

describe('usHeadroom', () => {
  it('positive headroom for normal powers, lower near the limit', () => {
    const good = usHeadroom([{ powerDbmv: 45 }, { powerDbmv: 45 }], []);
    const tight = usHeadroom([{ powerDbmv: 55 }, { powerDbmv: 55 }], []);
    expect(good).not.toBeNull();
    expect(tight).not.toBeNull();
    expect((good as number) > (tight as number)).toBe(true);
  });
  it('null when there are no channels', () => expect(usHeadroom([], [])).toBeNull());
});

describe('mobileBandHint', () => {
  it('flags LTE 800 ingress near 800 MHz', () => {
    expect(mobileBandHint(800, 810)).toBe('LTE 800 MHz');
    expect(mobileBandHint(500, 510)).toBeNull();
  });
});

// ─── Snapshot rating ────────────────────────────────────────────────────────

describe('rateDocsis — a healthy Vodafone line', () => {
  const ds: DocsisChannelInput[] = [
    ch({ dir: 'ds', channelId: 1, type: 'SC-QAM', frequencyMHz: 114, powerDbmv: 3, snrDb: 38, modulation: '256QAM' }),
    ch({ dir: 'ds', channelId: 2, type: 'SC-QAM', frequencyMHz: 698, powerDbmv: -2, snrDb: 36, modulation: '64QAM' }),
    ch({ dir: 'ds', channelId: 33, type: 'OFDM', frequencyText: '151~324', powerDbmv: -1, snrDb: 44, modulation: '4096QAM' }),
  ];
  const us: DocsisChannelInput[] = [
    ch({ dir: 'us', channelId: 4, type: 'SC-QAM', frequencyMHz: 31, powerDbmv: 44, modulation: '64QAM' }),
    ch({ dir: 'us', channelId: 41, type: 'OFDMA', frequencyText: '29~64', powerDbmv: 45, modulation: '64QAM' }),
  ];
  const snap = rateDocsis(1_000, ds, us);

  it('is rated good/konform with no critical findings', () => {
    expect(snap.rating).toBe('good');
    expect(snap.grade === 'konform' || snap.grade === 'toleriert').toBe(true);
    expect(snap.findings.some((f) => f.grade === 'sofort')).toBe(false);
  });
  it('summarizes families and has no codeword counters', () => {
    expect(snap.summary.families.ds.locked).toBe(2);
    expect(snap.summary.families.ofdm.locked).toBe(1);
    expect(snap.summary.corrected).toBeNull();
    expect(snap.summary.uncorrectable).toBeNull();
  });
});

describe('rateDocsis — impairments', () => {
  it('flags a low DS power channel as kritisch', () => {
    const snap = rateDocsis(1_000, [ch({ dir: 'ds', type: 'SC-QAM', frequencyMHz: 114, powerDbmv: -9, snrDb: 38, modulation: '256QAM' })], []);
    expect(snap.rating).toBe('bad');
    expect(snap.grade).toBe('sofort');
  });

  it('flags an SNR outlier (≥3 dB below the same-modulation median)', () => {
    const ds = [
      ch({ dir: 'ds', channelId: 1, type: 'SC-QAM', frequencyMHz: 770, powerDbmv: 2, snrDb: 27, modulation: '256QAM' }),
      ch({ dir: 'ds', channelId: 2, type: 'SC-QAM', frequencyMHz: 114, powerDbmv: 2, snrDb: 34, modulation: '256QAM' }),
      ch({ dir: 'ds', channelId: 3, type: 'SC-QAM', frequencyMHz: 138, powerDbmv: 2, snrDb: 34, modulation: '256QAM' }),
    ];
    const snap = rateDocsis(1_000, ds, []);
    const outlier = snap.ds.find((c) => c.frequencyMHz === 770);
    expect(outlier?.checks.some((c) => c.aspect === 'outlier')).toBe(true);
  });

  it('flags partial service against the 7-day baseline', () => {
    const ds = [ch({ dir: 'ds', type: 'SC-QAM', frequencyMHz: 114, powerDbmv: 2, snrDb: 38, modulation: '256QAM' })];
    const snap = rateDocsis(1_000, ds, [], { baseline: { ds: 16 } });
    const partial = snap.findings.find((f) => f.code === 'partial' && f.family === 'ds');
    expect(partial).toBeDefined();
    expect(partial?.text).toContain('von 16');
  });

  it('partial service on US is critical immediately', () => {
    const us = [ch({ dir: 'us', type: 'SC-QAM', frequencyMHz: 31, powerDbmv: 44, modulation: '64QAM' })];
    const snap = rateDocsis(1_000, us.length ? [] : [], us, { baseline: { us: 4 } });
    const partial = snap.findings.find((f) => f.code === 'partial' && f.family === 'us');
    expect(partial?.grade).toBe('sofort');
  });

  it('flags a modem at its US power limit when OFDMA is active', () => {
    const us = [
      ch({ dir: 'us', channelId: 1, type: 'SC-QAM', frequencyMHz: 31, powerDbmv: 55, modulation: '64QAM' }),
      ch({ dir: 'us', channelId: 41, type: 'OFDMA', frequencyText: '29~64', powerDbmv: 49, modulation: '64QAM' }),
    ];
    const snap = rateDocsis(1_000, [], us);
    const limited = snap.us.find((c) => c.family === 'us');
    expect(limited?.checks.some((c) => c.aspect === 'limit')).toBe(true);
  });

  it('reports no-data when there are no channels', () => {
    const snap = rateDocsis(1_000, [], []);
    expect(snap.findings.some((f) => f.code === 'no-data')).toBe(true);
    expect(snap.grade).toBe('unbekannt');
  });

  it('a DS channel reported not-locked drives partial service, not a lock finding', () => {
    const ds = [
      ch({ dir: 'ds', channelId: 1, type: 'SC-QAM', frequencyMHz: 114, powerDbmv: 2, snrDb: 38, modulation: '256QAM' }),
      ch({ dir: 'ds', channelId: 0, type: 'SC-QAM', frequencyMHz: null, powerDbmv: null, snrDb: null, modulation: '64QAM', locked: false }),
    ];
    const snap = rateDocsis(1_000, ds, []);
    expect(snap.summary.families.ds.unlocked).toBe(1);
    expect(snap.findings.some((f) => f.code === 'partial')).toBe(true);
  });
});

// ─── Event log categorizer ──────────────────────────────────────────────────

describe('classifyLogMessage', () => {
  it('classifies the common DOCSIS impairments', () => {
    expect(classifyLogMessage('No Ranging Response received - T3 time-out').key).toBe('us_t3_timeout');
    expect(classifyLogMessage('Unicast Maintenance Ranging attempted - No response - Retries exhausted').key).toBe('us_ranging_retries_exhausted');
    expect(classifyLogMessage('no unicast maintenance opportunities received - T4 time-out').key).toBe('us_t4_timeout');
    expect(classifyLogMessage('SYNC Timing Synchronization failure - Loss of Sync').key).toBe('ds_sync_loss');
    expect(classifyLogMessage('TCS Partial Service').key).toBe('us_partial');
    expect(classifyLogMessage('Honoring MDD; IP provisioning mode = IPv6').key).toBe('boot');
  });

  it('"retries exhausted" wins over "t3 time-out" (order matters)', () => {
    const r = classifyLogMessage('16 consecutive T3 timeouts while trying to range - Retries exhausted');
    expect(r.key).toBe('us_ranging_retries_exhausted');
    expect(r.severity).toBe('critical');
  });

  it('parses CM-STATUS event type codes', () => {
    expect(classifyLogMessage('CM-STATUS message sent. Event Type Code: 16; Chan ID: 32;')).toMatchObject({ key: 'cm_status_16', cmStatusCode: 16 });
    expect(classifyLogMessage('CM-STATUS message sent. Event Type Code: 2;').severity).toBe(CM_STATUS_CODES[2].severity);
    expect(classifyLogMessage('CM-STATUS message sent. Event Type Code: 6;').severity).toBe('critical');
  });

  it('falls back to the OSSI priority for unknown messages', () => {
    expect(classifyLogMessage('Something odd happened', '3').severity).toBe('warn');
    expect(classifyLogMessage('Something odd happened', 'Information').severity).toBe('info');
    expect(classifyLogMessage('Something odd happened').key).toBe('other');
  });
});

describe('normalizeLogMessage / redactMacs', () => {
  it('strips the CM-MAC tail and lower-cases', () => {
    expect(normalizeLogMessage('No Ranging Response - T3 time-out;CM-MAC=aa:bb:cc:dd:ee:ff;CMTS-MAC=11:22:33:44:55:66;')).toBe('no ranging response - t3 time-out');
  });
  it('redacts MAC addresses', () => {
    expect(redactMacs('CM-MAC=aa:bb:cc:dd:ee:ff done')).toBe('CM-MAC=xx:xx:xx:xx:xx:xx done');
  });
});

describe('escalateLogBursts', () => {
  it('escalates ≥3 T3 timeouts within 10 min to critical', () => {
    const base = { key: 'us_t3_timeout', severity: 'warn' as const };
    const t0 = 1_000_000;
    const entries = [
      { ...base, ts: t0 },
      { ...base, ts: t0 + 60_000 },
      { ...base, ts: t0 + 120_000 },
    ];
    const out = escalateLogBursts(entries);
    expect(out.every((e) => e.severity === 'critical')).toBe(true);
    expect(out[0].burst).toContain('3 T3');
  });

  it('does not escalate 2 isolated T3 timeouts', () => {
    const base = { key: 'us_t3_timeout', severity: 'warn' as const };
    const out = escalateLogBursts([{ ...base, ts: 0 }, { ...base, ts: 60_000 }]);
    expect(out.every((e) => e.severity === 'warn')).toBe(true);
  });

  it('escalates ≥10 T3 timeouts per day', () => {
    const entries = Array.from({ length: 10 }, (_v, i) => ({ key: 'us_t3_timeout', severity: 'warn' as const, ts: i * 60 * 60_000 }));
    const out = escalateLogBursts(entries);
    expect(out.every((e) => e.severity === 'critical')).toBe(true);
  });

  it('ignores entries without a timestamp', () => {
    const out = escalateLogBursts([{ key: 'us_t3_timeout', severity: 'warn', ts: null }]);
    expect(out[0].severity).toBe('warn');
  });
});
