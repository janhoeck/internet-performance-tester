// NIC link event aggregation (Windows event log incl. imported history). Pure functions.
// Link-down events carry details.cause ('boot' | 'pre_sleep' | 'router_reboot' | 'runtime'),
// details.relinkMbps, details.downtimeMs and details.wlanFailover (see ARCHITECTURE §4.9);
// link-up events carry details.speedMbps.
import type { ClientResponse } from '../shared/api-types';
import type { LinkEventDay } from '../shared/types';
import { DAY, addLocalDays, localDayKey, startOfLocalDay } from './time';

export type LinkCause = 'boot' | 'pre_sleep' | 'router_reboot' | 'runtime';

export interface LinkEventLite {
  ts: number;
  type: string;
  details: Record<string, unknown> | null;
}

export function linkCause(details: Record<string, unknown> | null | undefined): LinkCause | null {
  const c = details?.cause;
  return c === 'boot' || c === 'pre_sleep' || c === 'router_reboot' || c === 'runtime' ? c : null;
}

function firstNumber(details: Record<string, unknown> | null | undefined, keys: readonly string[]): number | null {
  if (!details) return null;
  for (const k of keys) {
    const v = details[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  }
  return null;
}

/** Link speed of a nic_link_up event (Mbit/s). */
export function upSpeedMbps(details: Record<string, unknown> | null | undefined): number | null {
  return firstNumber(details, ['speedMbps', 'linkMbps', 'mbps', 'relinkMbps']);
}

/** Speed the link came back with after a nic_link_down event (Mbit/s). */
export function relinkMbps(details: Record<string, unknown> | null | undefined): number | null {
  return firstNumber(details, ['relinkMbps', 'speedMbps']);
}

const MAX_DAYS = 3660;

/**
 * Per local day: link-down count and link-ups split by speed. Days without events between the
 * first event and `untilTs` (default: last event) are zero-filled so charts keep a linear time axis.
 */
export function linkEventDays(events: readonly LinkEventLite[], untilTs?: number): LinkEventDay[] {
  const map = new Map<string, LinkEventDay>();
  let first = Number.POSITIVE_INFINITY;
  let last = Number.NEGATIVE_INFINITY;
  for (const e of events) {
    if (e.type !== 'nic_link_down' && e.type !== 'nic_link_up') continue;
    first = Math.min(first, e.ts);
    last = Math.max(last, e.ts);
    const key = localDayKey(e.ts);
    let d = map.get(key);
    if (!d) {
      d = { day: key, down: 0, up1g: 0, up100m: 0, upOther: 0 };
      map.set(key, d);
    }
    if (e.type === 'nic_link_down') d.down++;
    else {
      const s = upSpeedMbps(e.details);
      if (s !== null && s >= 1000) d.up1g++;
      else if (s === 100) d.up100m++;
      else d.upOther++;
    }
  }
  if (map.size === 0) return [];
  const end = Math.max(last, untilTs ?? last);
  const out: LinkEventDay[] = [];
  let day = startOfLocalDay(first);
  for (let i = 0; i < MAX_DAYS && day <= end; i++) {
    const key = localDayKey(day);
    out.push(map.get(key) ?? { day: key, down: 0, up1g: 0, up100m: 0, upOther: 0 });
    day = addLocalDays(day, 1);
  }
  return out;
}

/**
 * Link-drop KPIs. `downs` = nic_link_down events (any order) covering at least
 * [min(from, to − 7 d), to). Only cause 'runtime' counts as a fault; 24 h / 7 d windows end at `to`.
 */
export function computeLinkSummary(
  downs: readonly LinkEventLite[],
  from: number,
  to: number,
): ClientResponse['linkSummary'] {
  let runtimeDrops24h = 0;
  let runtimeDrops7d = 0;
  let bootRelinks = 0;
  let relinks = 0;
  let relinksBelow1g = 0;
  let wlanFailovers24h = 0;
  let lastDropTs: number | null = null;
  for (const e of downs) {
    if (e.type !== 'nic_link_down' || e.ts >= to) continue;
    const cause = linkCause(e.details);
    const in24h = e.ts >= to - DAY;
    if (cause === 'runtime') {
      if (in24h) runtimeDrops24h++;
      if (e.ts >= to - 7 * DAY) runtimeDrops7d++;
      if (lastDropTs === null || e.ts > lastDropTs) lastDropTs = e.ts;
    }
    if (in24h && e.details?.wlanFailover === true) wlanFailovers24h++;
    if (e.ts < from) continue;
    if (cause === 'boot') bootRelinks++;
    if (cause === 'boot' || cause === 'runtime') {
      const mbps = relinkMbps(e.details);
      if (mbps !== null) {
        relinks++;
        if (mbps < 1000) relinksBelow1g++;
      }
    }
  }
  return {
    runtimeDrops24h,
    runtimeDrops7d,
    bootRelinks,
    relinkBelow1gPct: relinks > 0 ? Math.round((relinksBelow1g / relinks) * 1000) / 10 : null,
    wlanFailovers24h,
    lastDropTs,
  };
}
