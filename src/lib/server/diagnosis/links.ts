// NIC link events (Windows event log, classified by the eventlog collector) → LinkDrop list,
// per-day history and summary values. Pure functions.
import type { LinkEventDay, NetEvent } from '../../shared/types';
import { localDayKey, MINUTE } from './time';
import type { LinkCause, LinkDrop } from './types';
import { detailBool, detailNumber, detailString } from './util';

const CAUSES: readonly LinkCause[] = ['boot', 'pre_sleep', 'router_reboot', 'runtime'];

/**
 * details.cause from the eventlog collector ('boot' | 'pre_sleep' | 'router_reboot' | 'runtime').
 * Without it: severity 'info' = boot/resume renegotiation, otherwise 'unknown'.
 */
export function linkCauseOf(e: NetEvent): LinkCause {
  const c = detailString(e, 'cause');
  if (c !== null && (CAUSES as readonly string[]).includes(c)) return c as LinkCause;
  return e.severity === 'info' ? 'boot' : 'unknown';
}

/** a drop that counts as a fault: classified runtime, or unclassified with warn/critical severity */
export function isFaultDrop(d: LinkDrop): boolean {
  return d.cause === 'runtime' || d.cause === 'unknown';
}

/** relink speed must arrive within this time after the drop to be attributed to it */
const RELINK_MAX_MS = 10 * MINUTE;
/** WLAN connect within this window after an Ethernet drop = failover (eventlog rule: 5 s) */
const FAILOVER_MS = 5000;

/**
 * Builds the drop list from nic_link_down / nic_link_up events (any order).
 * @param wlanConnects timestamps of wlan_connect events in the same window, or null when unknown
 */
export function buildLinkDrops(events: readonly NetEvent[], wlanConnects: readonly number[] | null): LinkDrop[] {
  const sorted = [...events].sort((a, b) => a.ts - b.ts);
  const wlan = wlanConnects ? [...wlanConnects].sort((a, b) => a - b) : null;
  const drops: LinkDrop[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const e = sorted[i];
    if (e.type !== 'nic_link_down') continue;
    // matching link-up: first nic_link_up after this down and before the next down
    let up: NetEvent | null = null;
    for (let j = i + 1; j < sorted.length; j++) {
      const n = sorted[j];
      if (n.type === 'nic_link_down') break;
      if (n.type === 'nic_link_up') {
        if (n.ts - e.ts <= RELINK_MAX_MS) up = n;
        break;
      }
    }
    const endTs = typeof e.endTs === 'number' ? e.endTs : up ? up.ts : null;
    const relink = detailNumber(e, 'relinkMbps') ?? (up ? detailNumber(up, 'speedMbps') : null);
    const downtime = detailNumber(e, 'downtimeMs') ?? (endTs !== null && endTs >= e.ts ? endTs - e.ts : null);
    let failover = detailBool(e, 'wlanFailover');
    if (failover === null && wlan) {
      failover = wlan.some((t) => t >= e.ts - 1000 && t <= e.ts + FAILOVER_MS);
    }
    drops.push({
      id: typeof e.id === 'number' ? e.id : null,
      ts: e.ts,
      endTs,
      cause: linkCauseOf(e),
      relinkMbps: relink !== null && relink > 0 ? relink : null,
      downtimeMs: downtime,
      wlanFailover: failover,
    });
  }
  return drops;
}

/** Per local day: link downs and link-ups by speed (≥ 1 Gbit/s, 100 Mbit/s, other). */
export function buildLinkDays(events: readonly NetEvent[]): LinkEventDay[] {
  const days = new Map<string, LinkEventDay>();
  const get = (ts: number) => {
    const k = localDayKey(ts);
    let d = days.get(k);
    if (!d) {
      d = { day: k, down: 0, up1g: 0, up100m: 0, upOther: 0 };
      days.set(k, d);
    }
    return d;
  };
  for (const e of events) {
    if (e.type === 'nic_link_down') get(e.ts).down++;
    else if (e.type === 'nic_link_up') {
      const mbps = detailNumber(e, 'speedMbps');
      const d = get(e.ts);
      if (mbps !== null && mbps >= 1000) d.up1g++;
      else if (mbps === 100) d.up100m++;
      else d.upOther++;
    }
  }
  return [...days.values()].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
}

export interface RelinkStats {
  /** relinks considered (most recent first window) */
  total: number;
  below1g: number;
  /** most recent relinks all ≥ 1 Gbit/s (≥ 10 of them) – MESSPLAN "Nachweis einer Behebung" */
  fixedRun: number;
}

/**
 * Speed outcome of the most recent relinks (all causes – every renegotiation is a free cable test).
 * @param maxRecent window size (default 20)
 */
export function relinkStats(drops: readonly LinkDrop[], maxRecent = 20): RelinkStats {
  const withSpeed = drops.filter((d) => d.relinkMbps !== null).sort((a, b) => a.ts - b.ts);
  const recent = withSpeed.slice(-maxRecent);
  let fixedRun = 0;
  for (let i = withSpeed.length - 1; i >= 0; i--) {
    if ((withSpeed[i].relinkMbps ?? 0) >= 1000) fixedRun++;
    else break;
  }
  return {
    total: recent.length,
    below1g: recent.filter((d) => (d.relinkMbps ?? 0) < 1000).length,
    fixedRun,
  };
}
