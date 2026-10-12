// Prepared-statement cache + typed helpers over the Next server's SQLite connection (db.ts).
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { getDb } from './db';

export type SqlParam = string | number | null;

const MAX_CACHED = 256;
const cache = new WeakMap<DatabaseSync, Map<string, StatementSync>>();

/**
 * Cached prepared statement. Never use a cached statement for long-lived iterators (another
 * request would reset it) – prepare a fresh one with getDb().prepare() instead.
 */
export function prepared(sql: string, arrays = false): StatementSync {
  const db = getDb();
  let m = cache.get(db);
  if (!m) {
    m = new Map();
    cache.set(db, m);
  }
  const key = (arrays ? 'A|' : 'O|') + sql;
  let s = m.get(key);
  if (!s) {
    if (m.size >= MAX_CACHED) m.clear();
    s = db.prepare(sql);
    if (arrays) s.setReturnArrays(true);
    m.set(key, s);
  }
  return s;
}

/** Rows as (null-prototype) objects. */
export function queryRows(sql: string, ...params: SqlParam[]): Record<string, unknown>[] {
  return prepared(sql).all(...params) as Record<string, unknown>[];
}

/** Rows as arrays (columnar chart queries, ~2× faster for large results). */
export function queryArrays(sql: string, ...params: SqlParam[]): unknown[][] {
  return prepared(sql, true).all(...params) as unknown as unknown[][];
}

export function queryOne(sql: string, ...params: SqlParam[]): Record<string, unknown> | undefined {
  return prepared(sql).get(...params) as Record<string, unknown> | undefined;
}

export function toNum(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function toNum0(v: unknown): number {
  return toNum(v) ?? 0;
}

export function toStr(v: unknown): string | null {
  return v === null || v === undefined ? null : String(v);
}

export const placeholders = (n: number): string => new Array<string>(n).fill('?').join(', ');
