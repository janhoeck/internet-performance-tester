// Pure helpers for the router module (engine/router/index.ts): PC identity matching, DOCSIS
// metric extraction, DOCSIS change signatures and the login backoff schedule. Kept side-effect free
// so they can be unit-tested without timers or sockets.
import { normalizeMac } from './arris-parse';
import type { RatedDocsisSnapshot } from '../../src/lib/shared/docsis';
import { sameIp } from '../../src/lib/shared/net';
import type { AdapterSnapshot, MetricPoint, RouterAttachedDevice } from '../../src/lib/shared/types';

// ─── PC identity (mark the tool's own PC in the router's device list) ────────

export interface PcIdentity {
  macs: Set<string>;
  ipv4: string[];
  ipv6: string[];
}

/** Normalized MAC / IP addresses of the local PC from the latest adapters snapshot. */
export function pcIdentity(adapters: AdapterSnapshot | null | undefined): PcIdentity {
  const macs = new Set<string>();
  const ipv4: string[] = [];
  const ipv6: string[] = [];
  for (const a of adapters?.adapters ?? []) {
    if (a.isVirtual) continue;
    const mac = normalizeMac(a.mac);
    if (mac) macs.add(mac);
    for (const addr of a.addresses ?? []) {
      const ip = addr.split('%')[0].split('/')[0].trim();
      if (ip.includes(':')) ipv6.push(ip);
      else if (ip !== '') ipv4.push(ip);
    }
  }
  return { macs, ipv4, ipv6 };
}

/** Mark the device that matches the PC (by MAC first, then by IPv4/IPv6 address). */
export function markThisPc(devices: readonly RouterAttachedDevice[], id: PcIdentity): RouterAttachedDevice[] {
  const matchesByMac = (d: RouterAttachedDevice): boolean => {
    const mac = normalizeMac(d.mac);
    return mac !== null && id.macs.has(mac);
  };
  const anyMac = devices.some(matchesByMac);
  return devices.map((d) => {
    const byMac = matchesByMac(d);
    const byIp = !anyMac && (id.ipv4.some((ip) => sameIp(ip, d.ipv4)) || id.ipv6.some((ip) => sameIp(ip, d.ipv6)));
    return { ...d, isThisPc: byMac || byIp };
  });
}

// ─── DOCSIS metrics (metrics.ts keys) ───────────────────────────────────────

const isNum = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);

/** DOCSIS summary → metric points (keys from metrics.ts). Codeword deltas are omitted on the
 *  Vodafone Station (no counters → summary.corrected/uncorrectable null → "nicht verfügbar"). */
export function docsisMetricPoints(ts: number, snap: RatedDocsisSnapshot): MetricPoint[] {
  const s = snap.summary;
  const out: MetricPoint[] = [];
  const push = (key: string, value: number | null | undefined) => {
    if (isNum(value)) out.push({ ts, key, value });
  };
  push('docsis.ds.count', s.families.ds.count + s.families.ofdm.count);
  push('docsis.ds.locked', s.families.ds.locked + s.families.ofdm.locked);
  if (s.dsPower) {
    push('docsis.ds.power_min', s.dsPower.min);
    push('docsis.ds.power_max', s.dsPower.max);
    push('docsis.ds.power_avg', s.dsPower.avg);
  }
  if (s.dsSnr) {
    push('docsis.ds.snr_min', s.dsSnr.min);
    push('docsis.ds.snr_avg', s.dsSnr.avg);
  }
  push('docsis.ofdm.power_avg', s.ofdmPowerAvg);
  push('docsis.ofdm.snr_min', s.ofdmMerMin);
  push('docsis.us.count', s.families.us.count + s.families.ofdma.count);
  if (s.usPower) {
    push('docsis.us.power_min', s.usPower.min);
    push('docsis.us.power_max', s.usPower.max);
    push('docsis.us.power_avg', s.usPower.avg);
  }
  push('docsis.ofdma.power_avg', s.ofdmaPowerAvg);
  return out;
}

// ─── DOCSIS change detection (debounced over 2 polls) ───────────────────────

/**
 * Signature that changes when a channel is lost/gained, (un)locks, changes modulation or crosses a
 * rating boundary. Keyed by (dir, type, frequency) so re-registration (new channel ids) alone does
 * not count as a change.
 */
export function docsisSignature(snap: RatedDocsisSnapshot): string {
  const chan = [...snap.ds, ...snap.us]
    .map((c) => `${c.key}=${c.locked === false ? 'x' : c.locked === true ? 'L' : '?'}:${c.modulation ?? '-'}:${c.rating}`)
    .sort();
  const fam = snap.summary.families;
  const counts = (['ds', 'ofdm', 'us', 'ofdma'] as const).map((f) => `${f}${fam[f].locked}/${fam[f].count}`).join(',');
  return `${snap.grade}|${counts}|${chan.join('|')}`;
}

/** Debounced DOCSIS-change detector: emits only after a new state has held for 2 consecutive polls. */
export class DocsisChangeDebouncer {
  private committed: string | null = null;
  private prev: string | null = null;

  /** @returns the previous committed signature when a change should be emitted, else null. */
  push(sig: string): { changed: boolean; from: string | null } {
    if (this.committed === null) {
      this.committed = sig;
      this.prev = sig;
      return { changed: false, from: null };
    }
    let result: { changed: boolean; from: string | null } = { changed: false, from: null };
    if (sig !== this.committed && sig === this.prev) {
      result = { changed: true, from: this.committed };
      this.committed = sig;
    }
    this.prev = sig;
    return result;
  }

  reset(): void {
    this.committed = null;
    this.prev = null;
  }
}

// ─── Family baseline (max locked channels over 7 days) ──────────────────────

export type DocsisFamilyName = 'ds' | 'ofdm' | 'us' | 'ofdma';
const FAMILIES: readonly DocsisFamilyName[] = ['ds', 'ofdm', 'us', 'ofdma'];

/** Rolling 7-day maximum of locked channels per family + the time partial service began. */
export class FamilyBaseline {
  private readonly history: { ts: number; locked: Record<DocsisFamilyName, number> }[] = [];
  private readonly partialSince: Record<DocsisFamilyName, number | null> = { ds: null, ofdm: null, us: null, ofdma: null };

  constructor(private readonly windowMs = 7 * 24 * 3_600_000) {}

  /** Record this poll and return the baseline + partial-service start usable by rateDocsis. */
  update(ts: number, lockedByFamily: Record<DocsisFamilyName, number>): {
    baseline: Record<DocsisFamilyName, number>;
    partialSince: Record<DocsisFamilyName, number | null>;
  } {
    this.history.push({ ts, locked: { ...lockedByFamily } });
    const cutoff = ts - this.windowMs;
    while (this.history.length > 0 && this.history[0].ts < cutoff) this.history.shift();
    const baseline: Record<DocsisFamilyName, number> = { ds: 0, ofdm: 0, us: 0, ofdma: 0 };
    for (const f of FAMILIES) {
      let max = 0;
      for (const h of this.history) if (h.locked[f] > max) max = h.locked[f];
      baseline[f] = max;
      if (lockedByFamily[f] < max) this.partialSince[f] ??= ts;
      else this.partialSince[f] = null;
    }
    return { baseline, partialSince: { ...this.partialSince } };
  }

  reset(): void {
    this.history.length = 0;
    for (const f of FAMILIES) this.partialSince[f] = null;
  }
}

// ─── Login backoff (transport errors only) ──────────────────────────────────

/** Backoff schedule for transport errors (ARCHITECTURE §4.10): 5 s → 30 s → 60 s → 5 min (capped). */
export const LOGIN_BACKOFF_MS: readonly number[] = [5000, 30_000, 60_000, 300_000];

export function loginBackoffMs(failures: number): number {
  if (failures <= 0) return 0;
  return LOGIN_BACKOFF_MS[Math.min(failures, LOGIN_BACKOFF_MS.length) - 1];
}

/** Extra wait added to a router-reported lockout time (ARCHITECTURE §4.10: p_waitTime + 30 s). */
export const LOCKOUT_GRACE_MS = 30_000;
