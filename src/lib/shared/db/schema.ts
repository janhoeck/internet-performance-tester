// SQLite schema + migrations shared by the engine (writer) and the Next server (reader).
// Uses the built-in `node:sqlite` module (Node ≥ 22.5). Server/engine only – never import from
// client components.
import type { DatabaseSync } from 'node:sqlite';

export const SCHEMA_VERSION = 1;

/**
 * Ordered migrations. Index i migrates from version i to i+1. Never edit a shipped migration –
 * append a new one instead.
 */
export const MIGRATIONS: readonly string[] = [
  /* v0 → v1 */ `
  CREATE TABLE IF NOT EXISTS settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at     INTEGER NOT NULL,
    ended_at       INTEGER,
    planned_end_at INTEGER,
    label          TEXT,
    status         TEXT NOT NULL,          -- running | completed | aborted
    note           TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at);

  -- raw latency samples (all probe kinds). rtt NULL = lost. flags = SampleFlag bits.
  CREATE TABLE IF NOT EXISTS samples (
    target_id TEXT    NOT NULL,
    ts        INTEGER NOT NULL,
    rtt       REAL,
    status    INTEGER NOT NULL,
    flags     INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (target_id, ts)
  ) WITHOUT ROWID;

  -- per-minute counts of classified seconds (see SecondClass in types.ts)
  CREATE TABLE IF NOT EXISTS seconds_1m (
    ts        INTEGER PRIMARY KEY,
    covered   INTEGER NOT NULL,
    good      INTEGER NOT NULL,
    link      INTEGER NOT NULL,
    lan       INTEGER NOT NULL,
    access    INTEGER NOT NULL,
    aftr      INTEGER NOT NULL,
    backbone  INTEGER NOT NULL,
    remote    INTEGER NOT NULL,
    unknown   INTEGER NOT NULL,
    es        INTEGER NOT NULL,
    ses       INTEGER NOT NULL,
    self_load INTEGER NOT NULL
  );

  -- one-minute aggregates per target; hist = encodeHistogram() string
  CREATE TABLE IF NOT EXISTS rollup_1m (
    target_id TEXT    NOT NULL,
    ts        INTEGER NOT NULL,
    sent      INTEGER NOT NULL,
    lost      INTEGER NOT NULL,
    min       REAL,
    avg       REAL,
    max       REAL,
    p50       REAL,
    p95       REAL,
    p99       REAL,
    jitter    REAL,
    stddev    REAL,
    spikes    INTEGER NOT NULL DEFAULT 0,
    hist      TEXT,
    PRIMARY KEY (target_id, ts)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS idx_rollup_ts ON rollup_1m(ts);

  CREATE TABLE IF NOT EXISTS events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ts         INTEGER NOT NULL,
    end_ts     INTEGER,
    type       TEXT    NOT NULL,
    severity   TEXT    NOT NULL,
    segment    TEXT,
    title      TEXT    NOT NULL,
    details    TEXT,                       -- JSON
    source     TEXT    NOT NULL,
    dedupe_key TEXT UNIQUE
  );
  CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
  CREATE INDEX IF NOT EXISTS idx_events_type_ts ON events(type, ts);

  -- generic numeric time series (see metrics.ts registry)
  CREATE TABLE IF NOT EXISTS metrics (
    key   TEXT    NOT NULL,
    ts    INTEGER NOT NULL,
    value REAL    NOT NULL,
    PRIMARY KEY (key, ts)
  ) WITHOUT ROWID;

  -- JSON snapshots (adapters, wlan, router status, docsis tables, …)
  CREATE TABLE IF NOT EXISTS snapshots (
    id   INTEGER PRIMARY KEY AUTOINCREMENT,
    ts   INTEGER NOT NULL,
    kind TEXT    NOT NULL,
    data TEXT    NOT NULL                  -- JSON
  );
  CREATE INDEX IF NOT EXISTS idx_snapshots_kind_ts ON snapshots(kind, ts);

  CREATE TABLE IF NOT EXISTS speedtests (
    id                     INTEGER PRIMARY KEY AUTOINCREMENT,
    ts                     INTEGER NOT NULL,
    end_ts                 INTEGER NOT NULL,
    trigger                TEXT    NOT NULL,
    server                 TEXT,
    down_mbps              REAL,
    up_mbps                REAL,
    idle_latency_ms        REAL,
    idle_jitter_ms         REAL,
    loaded_down_latency_ms REAL,
    loaded_down_p95_ms     REAL,
    loaded_up_latency_ms   REAL,
    loaded_up_p95_ms       REAL,
    bloat_down_ms          REAL,
    bloat_up_ms            REAL,
    grade                  TEXT,
    bytes_down             INTEGER NOT NULL DEFAULT 0,
    bytes_up               INTEGER NOT NULL DEFAULT 0,
    streams                INTEGER NOT NULL DEFAULT 0,
    nic_link_mbps          REAL,
    error                  TEXT,
    series                 TEXT              -- JSON SpeedSeriesPoint[]
  );
  CREATE INDEX IF NOT EXISTS idx_speedtests_ts ON speedtests(ts);

  CREATE TABLE IF NOT EXISTS traceroutes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ts          INTEGER NOT NULL,
    target      TEXT    NOT NULL,
    family      INTEGER NOT NULL,
    hops        TEXT    NOT NULL,           -- JSON TraceHop[]
    reached     INTEGER NOT NULL,
    path_hash   TEXT    NOT NULL,
    changed     INTEGER NOT NULL,
    trigger     TEXT    NOT NULL,
    duration_ms INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_traceroutes_ts ON traceroutes(ts);
  `,
];

export const DB_PRAGMAS = `
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA busy_timeout = 5000;
  PRAGMA temp_store = MEMORY;
  PRAGMA cache_size = -20000;
`;

/** Apply pragmas and pending migrations. Safe to call from several processes (uses BEGIN IMMEDIATE). */
export function migrate(db: DatabaseSync): void {
  db.exec(DB_PRAGMAS);
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
    | { value: string }
    | undefined;
  let version = row ? Number(row.value) : 0;
  if (version === 0) {
    // must be set before the first table is created to take effect (enables PRAGMA incremental_vacuum)
    db.exec('PRAGMA auto_vacuum = INCREMENTAL');
  }
  while (version < MIGRATIONS.length) {
    db.exec('BEGIN IMMEDIATE');
    try {
      // re-check inside the write lock (another process may have migrated meanwhile)
      const again = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
        | { value: string }
        | undefined;
      const current = again ? Number(again.value) : 0;
      if (current > version) {
        db.exec('COMMIT');
        version = current;
        continue;
      }
      db.exec(MIGRATIONS[version]);
      db.prepare(
        "INSERT INTO meta(key, value) VALUES('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ).run(String(version + 1));
      db.exec('COMMIT');
      version++;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}
