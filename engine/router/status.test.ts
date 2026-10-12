// Tests for the pure router-module helpers (PC identity, DOCSIS metrics/signatures, family
// baseline, login backoff).
import { describe, expect, it } from 'vitest';
import { rateDocsis, type DocsisChannelInput, type RatedDocsisSnapshot } from '../../src/lib/shared/docsis';
import type { AdapterSnapshot, RouterAttachedDevice } from '../../src/lib/shared/types';
import {
  DocsisChangeDebouncer,
  docsisMetricPoints,
  docsisSignature,
  FamilyBaseline,
  LOGIN_BACKOFF_MS,
  loginBackoffMs,
  markThisPc,
  pcIdentity,
} from './status';

const ch = (o: Partial<DocsisChannelInput> & { dir: 'ds' | 'us' }): DocsisChannelInput => ({
  channelId: 1,
  type: 'SC-QAM',
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

const healthyDs: DocsisChannelInput[] = [
  ch({ dir: 'ds', channelId: 1, frequencyMHz: 114, powerDbmv: 3, snrDb: 38, modulation: '256QAM' }),
  ch({ dir: 'ds', channelId: 2, frequencyMHz: 138, powerDbmv: 3, snrDb: 38, modulation: '256QAM' }),
  ch({ dir: 'ds', channelId: 33, type: 'OFDM', frequencyText: '151~324', powerDbmv: -1, snrDb: 44, modulation: '4096QAM' }),
];
const healthyUs: DocsisChannelInput[] = [ch({ dir: 'us', channelId: 4, frequencyMHz: 31, powerDbmv: 44, modulation: '64QAM' })];
const snap = (ds = healthyDs, us = healthyUs): RatedDocsisSnapshot => rateDocsis(1_000, ds, us);

// ─── PC identity ────────────────────────────────────────────────────────────

const adapterSnap = (adapters: Partial<AdapterSnapshot['adapters'][number]>[]): AdapterSnapshot => ({
  ts: 0,
  adapters: adapters.map((a) => ({
    name: 'Ethernet',
    description: 'Intel I225-V',
    ifIndex: 1,
    status: 'Up',
    linkMbps: 1000,
    mediaType: '802.3',
    mac: null,
    driverVersion: null,
    driverDate: null,
    serviceName: 'e2fexpress',
    isWifi: false,
    isVirtual: false,
    mediaConnected: null,
    addresses: [],
    rxBytes: null,
    txBytes: null,
    rxErrors: null,
    rxDiscards: null,
    txErrors: null,
    txDiscards: null,
    ...a,
  })),
  routes: [],
  advanced: [],
});

const dev = (o: Partial<RouterAttachedDevice>): RouterAttachedDevice => ({
  kind: 'lan',
  hostName: null,
  mac: null,
  ipv4: null,
  ipv6: null,
  speed: null,
  isThisPc: false,
  ...o,
});

describe('pcIdentity / markThisPc', () => {
  it('collects MACs and addresses from non-virtual adapters', () => {
    const id = pcIdentity(adapterSnap([{ mac: 'AA-BB-CC-DD-EE-FF', addresses: ['192.168.0.23', 'fe80::1%4', '2a02:908::5'] }, { mac: '00:11:22:33:44:55', isVirtual: true }]));
    expect(id.macs.has('aa:bb:cc:dd:ee:ff')).toBe(true);
    expect(id.macs.has('00:11:22:33:44:55')).toBe(false); // virtual skipped
    expect(id.ipv4).toContain('192.168.0.23');
    expect(id.ipv6).toContain('2a02:908::5');
  });

  it('marks the device matching the PC MAC', () => {
    const id = pcIdentity(adapterSnap([{ mac: 'AA-BB-CC-DD-EE-FF' }]));
    const devices = [dev({ mac: '11:22:33:44:55:66', hostName: 'phone' }), dev({ mac: 'aa:bb:cc:dd:ee:ff', hostName: 'Jan-PC', speed: '1000 Mbps' })];
    const marked = markThisPc(devices, id);
    expect(marked.find((d) => d.hostName === 'Jan-PC')?.isThisPc).toBe(true);
    expect(marked.find((d) => d.hostName === 'phone')?.isThisPc).toBe(false);
  });

  it('falls back to IP matching when no MAC matches', () => {
    const id = pcIdentity(adapterSnap([{ mac: null, addresses: ['192.168.0.23'] }]));
    const marked = markThisPc([dev({ ipv4: '192.168.0.23', hostName: 'PC' })], id);
    expect(marked[0].isThisPc).toBe(true);
  });

  it('handles a missing adapters snapshot', () => {
    const id = pcIdentity(null);
    expect(id.macs.size).toBe(0);
    expect(markThisPc([dev({ mac: 'aa:bb:cc:dd:ee:ff' })], id)[0].isThisPc).toBe(false);
  });
});

// ─── DOCSIS metrics ─────────────────────────────────────────────────────────

describe('docsisMetricPoints', () => {
  it('emits the summary metrics but no codeword deltas (Vodafone Station)', () => {
    const points = docsisMetricPoints(5_000, snap());
    const keys = points.map((p) => p.key);
    expect(keys).toContain('docsis.ds.count');
    expect(keys).toContain('docsis.ds.snr_min');
    expect(keys).toContain('docsis.ofdm.power_avg');
    expect(keys).toContain('docsis.us.power_avg');
    expect(keys).not.toContain('docsis.ds.corrected_delta');
    expect(keys).not.toContain('docsis.ds.uncorrectable_delta');
    expect(points.every((p) => p.ts === 5_000 && Number.isFinite(p.value))).toBe(true);
  });

  it('ds.count includes OFDM, us.count includes OFDMA', () => {
    const points = docsisMetricPoints(5_000, snap());
    expect(points.find((p) => p.key === 'docsis.ds.count')?.value).toBe(3); // 2 SC-QAM + 1 OFDM
  });
});

// ─── DOCSIS change signature + debouncer ────────────────────────────────────

describe('docsisSignature / DocsisChangeDebouncer', () => {
  it('signature is stable across equal snapshots and changes on modulation/lock/grade', () => {
    expect(docsisSignature(snap())).toBe(docsisSignature(snap()));
    const degraded = snap([
      ch({ dir: 'ds', channelId: 1, frequencyMHz: 114, powerDbmv: -9, snrDb: 38, modulation: '256QAM' }),
      ch({ dir: 'ds', channelId: 2, frequencyMHz: 138, powerDbmv: 3, snrDb: 38, modulation: '256QAM' }),
      ch({ dir: 'ds', channelId: 33, type: 'OFDM', frequencyText: '151~324', powerDbmv: -1, snrDb: 44, modulation: '4096QAM' }),
    ]);
    expect(docsisSignature(degraded)).not.toBe(docsisSignature(snap()));
  });

  it('emits a change only after it holds for 2 consecutive polls', () => {
    const d = new DocsisChangeDebouncer();
    const a = docsisSignature(snap());
    const b = `${a}changed`;
    expect(d.push(a).changed).toBe(false); // first poll = baseline
    expect(d.push(a).changed).toBe(false); // unchanged
    expect(d.push(b).changed).toBe(false); // new value seen once → wait
    const res = d.push(b);
    expect(res.changed).toBe(true); // held for 2 polls → emit
    expect(res.from).toBe(a);
    expect(d.push(b).changed).toBe(false); // already committed
  });

  it('a one-poll blip does not emit', () => {
    const d = new DocsisChangeDebouncer();
    d.push('A');
    d.push('A');
    d.push('B'); // blip
    expect(d.push('A').changed).toBe(false); // back to A before B held
  });
});

// ─── Family baseline ────────────────────────────────────────────────────────

describe('FamilyBaseline', () => {
  it('tracks the 7-day max and the partial-service start time', () => {
    const b = new FamilyBaseline();
    const t0 = 1_000_000;
    let r = b.update(t0, { ds: 16, ofdm: 1, us: 4, ofdma: 1 });
    expect(r.baseline.ds).toBe(16);
    expect(r.partialSince.ds).toBeNull();
    // a drop below the max starts partial service
    r = b.update(t0 + 60_000, { ds: 14, ofdm: 1, us: 4, ofdma: 1 });
    expect(r.baseline.ds).toBe(16);
    expect(r.partialSince.ds).toBe(t0 + 60_000);
    // recovery clears it
    r = b.update(t0 + 120_000, { ds: 16, ofdm: 1, us: 4, ofdma: 1 });
    expect(r.partialSince.ds).toBeNull();
  });

  it('expires samples older than the window', () => {
    const b = new FamilyBaseline(1000);
    b.update(0, { ds: 32, ofdm: 2, us: 5, ofdma: 2 });
    const r = b.update(5000, { ds: 16, ofdm: 1, us: 4, ofdma: 1 });
    expect(r.baseline.ds).toBe(16); // the 32 fell out of the 1 s window
    expect(r.partialSince.ds).toBeNull();
  });
});

// ─── Login backoff ──────────────────────────────────────────────────────────

describe('loginBackoffMs', () => {
  it('follows the 5s → 30s → 60s → 5min schedule and caps', () => {
    expect(loginBackoffMs(0)).toBe(0);
    expect(loginBackoffMs(1)).toBe(5000);
    expect(loginBackoffMs(2)).toBe(30_000);
    expect(loginBackoffMs(3)).toBe(60_000);
    expect(loginBackoffMs(4)).toBe(300_000);
    expect(loginBackoffMs(9)).toBe(LOGIN_BACKOFF_MS[LOGIN_BACKOFF_MS.length - 1]);
  });
});
