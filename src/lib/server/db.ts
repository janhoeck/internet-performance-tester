// Next.js server-side SQLite access (read-mostly). Never import from client components.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { resolveDbPath } from '../shared/db/path';
import { migrate } from '../shared/db/schema';

type Holder = { db: DatabaseSync; path: string };
const g = globalThis as typeof globalThis & { __netdiagDb?: Holder };

/** Lazily opened singleton connection (survives dev HMR via globalThis). */
export function getDb(): DatabaseSync {
  const p = resolveDbPath();
  if (g.__netdiagDb && g.__netdiagDb.path === p) return g.__netdiagDb.db;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const db = new DatabaseSync(p);
  migrate(db);
  g.__netdiagDb = { db, path: p };
  return db;
}

export function dbPath(): string {
  return resolveDbPath();
}

export function dbSizeBytes(): number | null {
  try {
    const p = resolveDbPath();
    let total = fs.statSync(p).size;
    for (const suffix of ['-wal', '-shm']) {
      try {
        total += fs.statSync(p + suffix).size;
      } catch {
        /* optional file */
      }
    }
    return total;
  } catch {
    return null;
  }
}

/** Typed helpers around prepared statements. */
export function all<T = Record<string, unknown>>(sql: string, ...params: (string | number | null)[]): T[] {
  return getDb().prepare(sql).all(...params) as T[];
}

export function get<T = Record<string, unknown>>(sql: string, ...params: (string | number | null)[]): T | undefined {
  return getDb().prepare(sql).get(...params) as T | undefined;
}

export function run(sql: string, ...params: (string | number | null)[]): void {
  getDb().prepare(sql).run(...params);
}
