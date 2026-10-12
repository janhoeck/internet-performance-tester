// Scheduling helpers for the speed test (ARCHITECTURE §4.8): skip rules for scheduled runs,
// own-traffic window, primary adapter / link speed at test time. Pure, unit-tested.
import { fmtNumber, isNum } from '../../src/lib/shared/format';
import type { AdapterInfo, AdapterSnapshot, ClientState } from '../../src/lib/shared/types';

/** minimum distance between two speed tests (scheduled runs) */
export const MIN_GAP_MS = 30 * 60_000;
/** own traffic above this (mean of rx + tx over the last minute) postpones a scheduled run */
export const OWN_TRAFFIC_LIMIT_MBPS = 5;
export const TRAFFIC_WINDOW_MS = 60_000;
/** first scheduled run after a session (re)start – lets baselines settle first */
export const FIRST_RUN_DELAY_MS = 10 * 60_000;
/** retry delay after a skipped scheduled run */
export const SKIP_RETRY_MS = 10 * 60_000;
/** a client state older than this is ignored */
export const CLIENT_FRESH_MS = 10_000;
/** an adapters snapshot older than this is not trusted for "link down" */
export const SNAPSHOT_FRESH_MS = 5 * 60_000;

export interface QuietHours {
  from: number;
  to: number;
}

/** Local hour in [from, to) – wraps over midnight when from > to; from === to = no quiet hours. */
export function inQuietHours(hour: number, qh: QuietHours | null | undefined): boolean {
  if (!qh || qh.from === qh.to) return false;
  if (qh.from < qh.to) return hour >= qh.from && hour < qh.to;
  return hour >= qh.from || hour < qh.to;
}

export type LinkState = 'up' | 'down' | 'failover' | 'unknown';

export interface SkipContext {
  now: number;
  /** local hour 0..23 of `now` */
  hour: number;
  quietHours: QuietHours | null;
  gaming: boolean;
  /** mean own traffic (rx + tx, Mbit/s) over the last minute, null if unknown */
  ownTrafficMbps: number | null;
  outageActive: boolean;
  link: LinkState;
  lastRunTs: number | null;
  minGapMs?: number;
}

/** German reason why a scheduled run must be skipped, or null when it may run. */
export function skipReason(c: SkipContext): string | null {
  if (c.outageActive) return 'Ausfall läuft';
  if (c.link === 'down') return 'Netzwerkverbindung getrennt';
  if (c.link === 'failover') return 'Ausweichverbindung aktiv (nicht die erwartete Schnittstelle)';
  if (c.gaming) return 'Spiel läuft';
  if (c.quietHours && inQuietHours(c.hour, c.quietHours)) {
    return `Ruhezeit (${c.quietHours.from}–${c.quietHours.to} Uhr)`;
  }
  const gap = c.minGapMs ?? MIN_GAP_MS;
  if (c.lastRunTs !== null && c.now - c.lastRunTs < gap) {
    return `Letzter Speedtest vor weniger als ${Math.round(gap / 60_000)} min`;
  }
  if (c.ownTrafficMbps !== null && c.ownTrafficMbps > OWN_TRAFFIC_LIMIT_MBPS) {
    return `Eigener Datenverkehr ${fmtNumber(c.ownTrafficMbps, 1)} Mbit/s (> ${OWN_TRAFFIC_LIMIT_MBPS} Mbit/s)`;
  }
  return null;
}

/** When the next scheduled run is due (never before `earliest`). */
export function computeNextRun(lastRunTs: number | null, everyMin: number, earliest: number): number {
  const due = lastRunTs === null ? earliest : lastRunTs + everyMin * 60_000;
  return Math.max(due, earliest);
}

/** Rolling window of own throughput (from the 1 Hz client state). */
export class TrafficWindow {
  private readonly points: { ts: number; mbps: number }[] = [];

  constructor(private readonly keepMs = 2 * TRAFFIC_WINDOW_MS) {}

  push(ts: number, mbps: number): void {
    if (!Number.isFinite(ts) || !Number.isFinite(mbps)) return;
    this.points.push({ ts, mbps });
    const cutoff = ts - this.keepMs;
    while (this.points.length > 0 && this.points[0].ts < cutoff) this.points.shift();
  }

  /** Mean over (now − windowMs, now]; null with fewer than `minSamples` points. */
  meanMbps(now: number, windowMs = TRAFFIC_WINDOW_MS, minSamples = 10): number | null {
    let sum = 0;
    let n = 0;
    for (const p of this.points) {
      if (p.ts > now - windowMs && p.ts <= now) {
        sum += p.mbps;
        n++;
      }
    }
    return n >= minSamples ? sum / n : null;
  }

  clear(): void {
    this.points.length = 0;
  }
}

/** Own throughput of one client tick (rx + tx), null when unknown. */
export function clientTrafficMbps(c: ClientState): number | null {
  return isNum(c.rxMbps) && isNum(c.txMbps) ? c.rxMbps + c.txMbps : null;
}

function adapterUp(a: AdapterInfo): boolean {
  return a.status === 'Up' && a.mediaConnected !== false;
}

/**
 * Adapter carrying the internet traffic: `preferIf` (egress interface) if present, else the
 * adapter of the IPv4 (then IPv6) route, else the first connected physical adapter (Ethernet first).
 */
export function primaryAdapter(snap: AdapterSnapshot | null | undefined, preferIf?: string | null): AdapterInfo | null {
  if (!snap || !Array.isArray(snap.adapters)) return null;
  const list = snap.adapters;
  if (preferIf) {
    const a = list.find((x) => x.name === preferIf);
    if (a) return a;
  }
  for (const family of [4, 6] as const) {
    for (const r of snap.routes ?? []) {
      if (r.family !== family) continue;
      const a = list.find((x) => (r.ifIndex !== null && x.ifIndex === r.ifIndex) || (r.ifAlias !== null && x.name === r.ifAlias));
      if (a) return a;
    }
  }
  const up = list.filter((a) => !a.isVirtual && adapterUp(a));
  return up.find((a) => !a.isWifi) ?? up[0] ?? null;
}

function freshClient(client: ClientState | null | undefined, now: number): ClientState | null {
  return client && now - client.ts <= CLIENT_FRESH_MS ? client : null;
}

/**
 * NIC link speed at test time: the 1 Hz client state (primary physical adapter) when fresh and on
 * the expected interface, else the adapters snapshot (egress interface / primary adapter).
 */
export function pickLinkMbps(
  client: ClientState | null | undefined,
  snap: AdapterSnapshot | null | undefined,
  now: number,
): number | null {
  const c = freshClient(client, now);
  if (c && c.onExpected !== false && c.linkUp !== false && isNum(c.linkMbps) && c.linkMbps > 0) return c.linkMbps;
  const a = primaryAdapter(snap, c?.egressV4If ?? null);
  if (a && isNum(a.linkMbps) && a.linkMbps > 0) return a.linkMbps;
  return c && isNum(c.linkMbps) && c.linkMbps > 0 ? c.linkMbps : null;
}

/** Link state for the skip rules: client state first, adapters snapshot as fallback. */
export function linkState(
  client: ClientState | null | undefined,
  snap: AdapterSnapshot | null | undefined,
  now: number,
): LinkState {
  const c = freshClient(client, now);
  if (c) {
    if (c.linkUp === false) return 'down';
    if (c.onExpected === false) return 'failover';
    if (c.linkUp === true) return 'up';
  }
  if (snap && Array.isArray(snap.adapters) && now - snap.ts <= SNAPSHOT_FRESH_MS) {
    return snap.adapters.some((a) => !a.isVirtual && adapterUp(a)) ? 'up' : 'down';
  }
  return 'unknown';
}

/** Own traffic from two consecutive adapters snapshots (fallback without 1 Hz client ticks). */
export function adapterTrafficMbps(
  prev: AdapterSnapshot | null | undefined,
  cur: AdapterSnapshot | null | undefined,
  maxGapMs = 5 * 60_000,
): number | null {
  if (!prev || !cur) return null;
  const dt = cur.ts - prev.ts;
  if (!(dt > 0) || dt > maxGapMs) return null;
  const a = primaryAdapter(cur);
  if (!a) return null;
  const b = prev.adapters.find((x) => x.name === a.name);
  if (!b) return null;
  if (!isNum(a.rxBytes) || !isNum(a.txBytes) || !isNum(b.rxBytes) || !isNum(b.txBytes)) return null;
  if (a.rxBytes < b.rxBytes || a.txBytes < b.txBytes) return null; // counter reset (adapter restart)
  const delta = a.rxBytes - b.rxBytes + (a.txBytes - b.txBytes);
  return (delta * 8) / (dt * 1000);
}
