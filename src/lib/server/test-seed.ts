// Shared fixture for DB-backed tests of the API layer (never imported by app code): seeds a
// short, deterministic demo range into a temp SQLite file and points db.ts at it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { type SeedSummary, seedDemo } from '../../../scripts/seed-demo';

/** 08.10.2026 23:00 local – the seeded range covers the evening peak (20–23 h). */
export const TEST_END = new Date(2026, 9, 8, 23, 0, 0).getTime();
export const TEST_SPAN = 3 * 3_600_000;
export const TEST_FROM = TEST_END - TEST_SPAN;

export interface SeededDb {
  dir: string;
  dbPath: string;
  summary: SeedSummary;
  cleanup(): void;
}

type Holder = { db: DatabaseSync; path: string };

/** Close the connection db.ts keeps on globalThis (contract file without a close function). */
export function closeServerDb(): void {
  const g = globalThis as typeof globalThis & { __netdiagDb?: Holder };
  if (!g.__netdiagDb) return;
  try {
    g.__netdiagDb.db.close();
  } catch {
    /* already closed */
  }
  delete g.__netdiagDb;
}

export function seedTempDb(opts: { end?: number; spanMs?: number; seed?: number } = {}): SeededDb {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'netdiag-api-'));
  const dbPath = path.join(dir, 'test.db');
  const summary = seedDemo({ dbPath, end: opts.end ?? TEST_END, spanMs: opts.spanMs ?? TEST_SPAN, seed: opts.seed ?? 7, historyDays: 10 });
  closeServerDb();
  process.env.NETDIAG_DB = dbPath;
  return {
    dir,
    dbPath,
    summary,
    cleanup() {
      closeServerDb();
      // keep pointing into the temp dir: a late getDb() must never fall back to <cwd>/data/netdiag.db
      process.env.NETDIAG_DB = path.join(dir, 'closed.db');
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* Windows may keep the file locked briefly */
      }
    },
  };
}
