// SQLite writer used by the engine (implements EngineDb). Samples and metrics are buffered and
// written in one transaction per second to keep the event loop free.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { AppConfig } from '../../src/lib/shared/config';
import {
  EVENT_COLUMNS,
  ROLLUP_COLUMNS,
  SECONDS_COLUMNS,
  SPEEDTEST_COLUMNS,
  TRACEROUTE_COLUMNS,
  type SqlValue,
  eventToParams,
  rollupToParams,
  rowToRollup,
  rowToSeconds,
  rowToSession,
  rowToSnapshot,
  rowToSpeedtest,
  rowToTraceroute,
  secondsToParams,
  speedtestToParams,
  tracerouteToParams,
} from '../../src/lib/shared/db/rows';
import { migrate } from '../../src/lib/shared/db/schema';
import type {
  IpFamily,
  MetricPoint,
  NetEvent,
  Rollup,
  Sample,
  SampleStatusCode,
  SecondsRollup,
  Snapshot,
  SnapshotKind,
  SpeedtestResult,
  TestSession,
  TracerouteResult,
} from '../../src/lib/shared/types';
import type { EngineDb } from '../core/types';

const placeholders = (columns: string) => columns.split(',').map(() => '?').join(', ');
const DAY = 86_400_000;

export interface EngineDbOptions {
  flushIntervalMs?: number;
  /** called when a flush fails (e.g. disk full) */
  onError?: (err: unknown) => void;
}

export function openEngineDb(dbPath: string, opts: EngineDbOptions = {}): EngineDb {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  migrate(db);
  return new SqliteEngineDb(db, dbPath, opts);
}

class SqliteEngineDb implements EngineDb {
  private sampleBuf: Sample[] = [];
  private metricBuf: MetricPoint[] = [];
  private timer: NodeJS.Timeout | null = null;
  private closed = false;
  private readonly stmts: Record<string, StatementSync>;

  constructor(private readonly db: DatabaseSync, readonly path: string, private readonly opts: EngineDbOptions) {
    this.stmts = {
      sample: db.prepare('INSERT OR IGNORE INTO samples(target_id, ts, rtt, status, flags) VALUES (?, ?, ?, ?, ?)'),
      seconds: db.prepare(`INSERT OR REPLACE INTO seconds_1m(${SECONDS_COLUMNS}) VALUES (${placeholders(SECONDS_COLUMNS)})`),
      secondsAt: db.prepare(`SELECT ${SECONDS_COLUMNS} FROM seconds_1m WHERE ts = ?`),
      eventIdByKey: db.prepare('SELECT id FROM events WHERE dedupe_key = ?'),
      minuteBucketsOf: db.prepare('SELECT DISTINCT (ts / 60000) * 60000 AS m FROM samples WHERE target_id = ? AND ts >= ? AND ts < ?'),
      rollupMinutesOf: db.prepare('SELECT ts FROM rollup_1m WHERE target_id = ? AND ts >= ? AND ts < ?'),
      rollupsSince: db.prepare(`SELECT ${ROLLUP_COLUMNS} FROM rollup_1m WHERE ts >= ? ORDER BY ts`),
      metric: db.prepare('INSERT OR REPLACE INTO metrics(key, ts, value) VALUES (?, ?, ?)'),
      event: db.prepare(`INSERT OR IGNORE INTO events(${EVENT_COLUMNS}) VALUES (${placeholders(EVENT_COLUMNS)})`),
      hasEvent: db.prepare('SELECT 1 AS x FROM events WHERE dedupe_key = ?'),
      snapshot: db.prepare('INSERT INTO snapshots(ts, kind, data) VALUES (?, ?, ?)'),
      latestSnapshot: db.prepare('SELECT * FROM snapshots WHERE kind = ? ORDER BY ts DESC, id DESC LIMIT 1'),
      speedtest: db.prepare(`INSERT INTO speedtests(${SPEEDTEST_COLUMNS}) VALUES (${placeholders(SPEEDTEST_COLUMNS)})`),
      latestSpeedtest: db.prepare('SELECT * FROM speedtests ORDER BY ts DESC LIMIT 1'),
      traceroute: db.prepare(`INSERT INTO traceroutes(${TRACEROUTE_COLUMNS}) VALUES (${placeholders(TRACEROUTE_COLUMNS)})`),
      latestTraceroute: db.prepare('SELECT * FROM traceroutes WHERE family = ? ORDER BY ts DESC, id DESC LIMIT 1'),
      rollup: db.prepare(`INSERT OR REPLACE INTO rollup_1m(${ROLLUP_COLUMNS}) VALUES (${placeholders(ROLLUP_COLUMNS)})`),
      samplesBetween: db.prepare('SELECT target_id, ts, rtt, status, flags FROM samples WHERE target_id = ? AND ts >= ? AND ts < ? ORDER BY ts'),
      createSession: db.prepare('INSERT INTO sessions(started_at, ended_at, planned_end_at, label, status, note) VALUES (?, ?, ?, ?, ?, ?)'),
      getSession: db.prepare('SELECT * FROM sessions WHERE id = ?'),
      runningSession: db.prepare("SELECT * FROM sessions WHERE status = 'running' ORDER BY started_at DESC LIMIT 1"),
      getSetting: db.prepare('SELECT value FROM settings WHERE key = ?'),
      setSetting: db.prepare(
        'INSERT INTO settings(key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      ),
      deleteSetting: db.prepare('DELETE FROM settings WHERE key = ?'),
    };
    const interval = opts.flushIntervalMs ?? 1000;
    this.timer = setInterval(() => this.safeFlush(), interval);
    this.timer.unref();
  }

  // ─── buffered writes ─────────────────────────────────────────────────────

  addSample(s: Sample): void {
    if (this.closed) return;
    this.sampleBuf.push(s);
    if (this.sampleBuf.length >= 5000) this.safeFlush();
  }

  addMetrics(points: MetricPoint[]): void {
    if (this.closed) return;
    for (const p of points) {
      if (Number.isFinite(p.value)) this.metricBuf.push(p);
    }
    if (this.metricBuf.length >= 5000) this.safeFlush();
  }

  flush(): void {
    if (this.sampleBuf.length === 0 && this.metricBuf.length === 0) return;
    const samples = this.sampleBuf;
    const metrics = this.metricBuf;
    this.sampleBuf = [];
    this.metricBuf = [];
    this.tx(() => {
      for (const s of samples) {
        this.stmts.sample.run(
          s.targetId,
          Math.round(s.ts),
          s.rtt === null ? null : Math.round(s.rtt * 1000) / 1000,
          s.status,
          s.flags ?? 0,
        );
      }
      for (const m of metrics) {
        this.stmts.metric.run(m.key, Math.round(m.ts), m.value);
      }
    });
  }

  private safeFlush(): void {
    try {
      this.flush();
    } catch (err) {
      this.opts.onError?.(err);
    }
  }

  private tx(fn: () => void): void {
    this.db.exec('BEGIN');
    try {
      fn();
      this.db.exec('COMMIT');
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* ignore */
      }
      throw err;
    }
  }

  // ─── events ──────────────────────────────────────────────────────────────

  insertEvent(e: NetEvent): number | null {
    const res = this.stmts.event.run(...eventToParams(e));
    if (Number(res.changes) === 0) return null;
    return Number(res.lastInsertRowid);
  }

  updateEvent(id: number, patch: Partial<Pick<NetEvent, 'endTs' | 'severity' | 'title' | 'details' | 'segment'>>): void {
    const sets: string[] = [];
    const params: SqlValue[] = [];
    if (patch.endTs !== undefined) {
      sets.push('end_ts = ?');
      params.push(patch.endTs ?? null);
    }
    if (patch.severity !== undefined) {
      sets.push('severity = ?');
      params.push(patch.severity);
    }
    if (patch.title !== undefined) {
      sets.push('title = ?');
      params.push(patch.title);
    }
    if (patch.segment !== undefined) {
      sets.push('segment = ?');
      params.push(patch.segment ?? null);
    }
    if (patch.details !== undefined) {
      sets.push('details = ?');
      params.push(patch.details ? JSON.stringify(patch.details) : null);
    }
    if (sets.length === 0) return;
    params.push(id);
    this.db.prepare(`UPDATE events SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  }

  hasEvent(dedupeKey: string): boolean {
    return this.stmts.hasEvent.get(dedupeKey) !== undefined;
  }

  eventIdByDedupeKey(dedupeKey: string): number | null {
    const row = this.stmts.eventIdByKey.get(dedupeKey) as { id: number | bigint } | undefined;
    return row ? Number(row.id) : null;
  }

  // ─── snapshots, speedtests, traceroutes, rollups ─────────────────────────

  insertSnapshot<T>(kind: SnapshotKind, ts: number, data: T): number {
    return Number(this.stmts.snapshot.run(Math.round(ts), kind, JSON.stringify(data)).lastInsertRowid);
  }

  latestSnapshot<T>(kind: SnapshotKind): Snapshot<T> | null {
    const row = this.stmts.latestSnapshot.get(kind) as Record<string, unknown> | undefined;
    return row ? rowToSnapshot<T>(row) : null;
  }

  insertSpeedtest(r: SpeedtestResult): number {
    return Number(this.stmts.speedtest.run(...speedtestToParams(r)).lastInsertRowid);
  }

  latestSpeedtest(): SpeedtestResult | null {
    const row = this.stmts.latestSpeedtest.get() as Record<string, unknown> | undefined;
    return row ? rowToSpeedtest(row, false) : null;
  }

  insertTraceroute(r: TracerouteResult): number {
    return Number(this.stmts.traceroute.run(...tracerouteToParams(r)).lastInsertRowid);
  }

  latestTraceroute(family: IpFamily): TracerouteResult | null {
    const row = this.stmts.latestTraceroute.get(family) as Record<string, unknown> | undefined;
    return row ? rowToTraceroute(row) : null;
  }

  upsertRollups(rs: Rollup[]): void {
    if (rs.length === 0) return;
    this.tx(() => {
      for (const r of rs) this.stmts.rollup.run(...rollupToParams(r));
    });
  }

  rollupsSince(since: number): Rollup[] {
    return (this.stmts.rollupsSince.all(since) as Record<string, unknown>[]).map(rowToRollup);
  }

  upsertSecondsRollups(rs: SecondsRollup[]): void {
    if (rs.length === 0) return;
    this.tx(() => {
      for (const r of rs) this.stmts.seconds.run(...secondsToParams(r));
    });
  }

  secondsRollupAt(minuteTs: number): SecondsRollup | null {
    const row = this.stmts.secondsAt.get(minuteTs) as Record<string, unknown> | undefined;
    return row ? rowToSeconds(row) : null;
  }

  samplesBetween(targetId: string, from: number, to: number): Sample[] {
    this.safeFlush();
    const rows = this.stmts.samplesBetween.all(targetId, from, to) as Record<string, unknown>[];
    return rows.map((r) => ({
      targetId: String(r.target_id),
      ts: Number(r.ts),
      rtt: r.rtt === null ? null : Number(r.rtt),
      status: Number(r.status) as SampleStatusCode,
      flags: Number(r.flags ?? 0),
    }));
  }

  minutesMissingRollup(since: number, before: number, limit: number): { targetId: string; ts: number }[] {
    this.safeFlush();
    // per target over the (target_id, ts) primary key – no full table scan
    const out: { targetId: string; ts: number }[] = [];
    for (const targetId of this.distinctValues('samples', 'target_id')) {
      const have = new Set(
        (this.stmts.rollupMinutesOf.all(targetId, since, before) as { ts: number }[]).map((r) => Number(r.ts)),
      );
      for (const r of this.stmts.minuteBucketsOf.all(targetId, since, before) as { m: number }[]) {
        const m = Number(r.m);
        if (!have.has(m)) out.push({ targetId, ts: m });
        if (out.length >= limit) return out;
      }
    }
    return out;
  }

  /** distinct values of an indexed leading column via a loose index scan (no full scan) */
  private distinctValues(table: 'samples' | 'metrics' | 'snapshots', column: 'target_id' | 'key' | 'kind'): string[] {
    const rows = this.db
      .prepare(
        `WITH RECURSIVE v(x) AS (
           SELECT (SELECT ${column} FROM ${table} ORDER BY ${column} LIMIT 1)
           UNION ALL
           SELECT (SELECT ${column} FROM ${table} WHERE ${column} > v.x ORDER BY ${column} LIMIT 1) FROM v WHERE v.x IS NOT NULL
         ) SELECT x FROM v WHERE x IS NOT NULL`,
      )
      .all() as { x: string }[];
    return rows.map((r) => String(r.x));
  }

  // ─── sessions ────────────────────────────────────────────────────────────

  createSession(s: Omit<TestSession, 'id'>): TestSession {
    const res = this.stmts.createSession.run(s.startedAt, s.endedAt, s.plannedEndAt, s.label, s.status, s.note);
    const row = this.stmts.getSession.get(Number(res.lastInsertRowid)) as Record<string, unknown>;
    return rowToSession(row);
  }

  updateSession(id: number, patch: Partial<Omit<TestSession, 'id'>>): void {
    const map: Record<string, string> = {
      startedAt: 'started_at', endedAt: 'ended_at', plannedEndAt: 'planned_end_at', label: 'label', status: 'status', note: 'note',
    };
    const sets: string[] = [];
    const params: SqlValue[] = [];
    for (const [k, col] of Object.entries(map)) {
      const v = (patch as Record<string, unknown>)[k];
      if (v !== undefined) {
        sets.push(`${col} = ?`);
        params.push(v as SqlValue);
      }
    }
    if (sets.length === 0) return;
    params.push(id);
    this.db.prepare(`UPDATE sessions SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  }

  runningSession(): TestSession | null {
    const row = this.stmts.runningSession.get() as Record<string, unknown> | undefined;
    return row ? rowToSession(row) : null;
  }

  // ─── settings ────────────────────────────────────────────────────────────

  getSetting(key: string): string | null {
    const row = this.stmts.getSetting.get(key) as { value: string } | undefined;
    return row ? row.value : null;
  }

  setSetting(key: string, value: string | null): void {
    if (value === null) this.stmts.deleteSetting.run(key);
    else this.stmts.setSetting.run(key, value, Date.now());
  }

  // ─── maintenance ─────────────────────────────────────────────────────────

  purge(cfg: AppConfig['retention'], now: number): void {
    this.safeFlush();
    const rawBefore = now - cfg.rawDays * DAY;
    const delSamples = this.db.prepare('DELETE FROM samples WHERE target_id = ? AND ts < ?');
    for (const t of this.distinctValues('samples', 'target_id')) delSamples.run(t, rawBefore);

    this.db.prepare('DELETE FROM rollup_1m WHERE ts < ?').run(now - cfg.rollupDays * DAY);
    this.db.prepare('DELETE FROM seconds_1m WHERE ts < ?').run(now - cfg.rollupDays * DAY);
    this.db.prepare('DELETE FROM events WHERE ts < ?').run(now - cfg.eventsDays * DAY);

    const metricBefore = now - cfg.metricsDays * DAY;
    const delMetrics = this.db.prepare('DELETE FROM metrics WHERE key = ? AND ts < ?');
    for (const k of this.distinctValues('metrics', 'key')) delMetrics.run(k, metricBefore);

    const snapBefore = now - cfg.snapshotsDays * DAY;
    const delSnaps = this.db.prepare('DELETE FROM snapshots WHERE kind = ? AND ts < ?');
    for (const k of this.distinctValues('snapshots', 'kind')) delSnaps.run(k, snapBefore);

    this.db.exec('PRAGMA incremental_vacuum(4000)');
    this.db.exec('PRAGMA wal_checkpoint(PASSIVE)');
  }

  sizeBytes(): number | null {
    try {
      let total = fs.statSync(this.path).size;
      try {
        total += fs.statSync(`${this.path}-wal`).size;
      } catch {
        /* no wal */
      }
      return total;
    } catch {
      return null;
    }
  }

  close(): void {
    if (this.closed) return;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    try {
      this.flush();
    } finally {
      this.closed = true;
      this.db.close();
    }
  }
}
