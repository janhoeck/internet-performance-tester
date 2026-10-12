// Mapping of stored router event log data (router_log events / 'router_log' snapshots) to the
// RouterLogEntry shape of the API. Field names written by the router module are not fixed by the
// contract, so the mapping is tolerant (also accepts the raw ARRIS field names). Pure functions.
import type { NetEvent, RouterLogEntry, Severity } from '../shared/types';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

function firstStr(r: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const k of keys) {
    const s = str(r[k]);
    if (s !== null && s !== '') return s;
  }
  return null;
}

function isSeverity(v: unknown): v is Severity {
  return v === 'info' || v === 'warn' || v === 'critical';
}

const TIME_KEYS = ['timeText', 'timestamp', 'Timestamp', 'time', 'Time', 'date'];
const LEVEL_KEYS = ['level', 'Level', 'priority', 'Priority', 'prio'];
const MESSAGE_KEYS = ['message', 'Message', 'text', 'Text', 'description', 'Description', 'msg', 'event', 'Event'];
const CATEGORY_KEYS = ['category', 'key', 'kind'];

function parsedTs(r: Record<string, unknown>, fallback: number | null): number | null {
  if (!('ts' in r)) return fallback;
  const v = r.ts;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** router_log event → RouterLogEntry (details may hold the entry directly or under `entry`). */
export function routerLogFromEvent(e: NetEvent): RouterLogEntry {
  const base = e.details ?? {};
  const d = isRecord(base.entry) ? base.entry : base;
  return {
    ts: parsedTs(d, e.ts),
    timeText: firstStr(d, TIME_KEYS) ?? '',
    level: firstStr(d, LEVEL_KEYS),
    message: firstStr(d, MESSAGE_KEYS) ?? e.title,
    category: firstStr(d, CATEGORY_KEYS) ?? 'other',
    severity: e.severity,
  };
}

function entryFromRecord(r: Record<string, unknown>): RouterLogEntry | null {
  const message = firstStr(r, MESSAGE_KEYS);
  if (message === null) return null;
  return {
    ts: parsedTs(r, null),
    timeText: firstStr(r, TIME_KEYS) ?? '',
    level: firstStr(r, LEVEL_KEYS),
    message,
    category: firstStr(r, CATEGORY_KEYS) ?? 'other',
    severity: isSeverity(r.severity) ? r.severity : 'info',
  };
}

/** 'router_log' snapshot data (array or {entries|log|items|eventLog: […]}) → entries, newest first. */
export function routerLogFromSnapshot(data: unknown): RouterLogEntry[] {
  let list: unknown = data;
  if (isRecord(data)) list = data.entries ?? data.log ?? data.items ?? data.eventLog ?? null;
  if (!Array.isArray(list)) return [];
  const out: RouterLogEntry[] = [];
  for (const item of list) {
    if (!isRecord(item)) continue;
    const entry = entryFromRecord(item);
    if (entry) out.push(entry);
  }
  return out.sort((a, b) => (b.ts ?? Number.NEGATIVE_INFINITY) - (a.ts ?? Number.NEGATIVE_INFINITY));
}
