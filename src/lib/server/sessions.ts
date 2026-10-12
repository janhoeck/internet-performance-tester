// Long-term tests ("Langzeittests"): overview with per-test key figures and deletion.
// Deletion writes from the Next process while the engine keeps measuring: it runs in short
// transactions (time budget) with pauses in between, so the engine's 1-s write batches never wait
// long for the lock (busy_timeout 5 s, DB_PRAGMAS).
import { parseJson, rowToSession } from '../shared/db/rows';
import {
  type SessionDeleteResult,
  type SessionDeleteScope,
  type SessionOverview,
  type SessionOverviewResponse,
  type SessionStartContext,
  sessionWindow,
  startContextOf,
} from '../shared/sessions';
import type { SecondsRollup, TestSession } from '../shared/types';
import { getDb } from './db';
import { HttpError } from './http';
import { type SqlParam, prepared, queryOne, queryRows, toNum0 } from './sql';
import { HOUR, MINUTE, minuteStart } from './time';

const MAX_SESSIONS = 500;

const SECONDS_SUM =
  'COUNT(*) AS n, SUM(covered) AS covered, SUM(good) AS good, SUM(link) AS link, SUM(lan) AS lan, SUM(access) AS access, ' +
  'SUM(aftr) AS aftr, SUM(backbone) AS backbone, SUM(remote) AS remote, SUM(unknown) AS unknown, SUM(es) AS es, SUM(ses) AS ses, ' +
  'SUM(self_load) AS self_load';

/** Connection at the start of each test: first non-resumed `session_start` event per session id. */
function startContexts(): Map<number, SessionStartContext | null> {
  const out = new Map<number, SessionStartContext | null>();
  const rows = queryRows("SELECT details FROM events WHERE type = 'session_start' ORDER BY ts ASC, id ASC LIMIT 5000");
  for (const r of rows) {
    const d = parseJson<unknown>(r.details, null);
    if (d === null || typeof d !== 'object' || Array.isArray(d)) continue;
    const details = d as Record<string, unknown>;
    const id = details.sessionId;
    if (typeof id !== 'number') continue;
    if (!out.has(id) || (details.resumed !== true && out.get(id) == null)) out.set(id, startContextOf(details));
  }
  return out;
}

function secondsTotal(from: number, to: number): SecondsRollup | null {
  const r = queryOne(`SELECT ${SECONDS_SUM} FROM seconds_1m WHERE ts >= ? AND ts < ?`, minuteStart(from), to);
  if (!r || toNum0(r.n) === 0) return null;
  const n = (k: string) => toNum0(r[k]);
  return {
    ts: from,
    covered: n('covered'),
    good: n('good'),
    link: n('link'),
    lan: n('lan'),
    access: n('access'),
    aftr: n('aftr'),
    backbone: n('backbone'),
    remote: n('remote'),
    unknown: n('unknown'),
    es: n('es'),
    ses: n('ses'),
    selfLoad: n('self_load'),
  };
}

/** GET /api/sessions/overview: all tests (newest first) with their key figures. */
export function getSessionOverview(now: number = Date.now()): SessionOverviewResponse {
  const sessions = queryRows('SELECT * FROM sessions ORDER BY started_at DESC, id DESC LIMIT ?', MAX_SESSIONS).map(rowToSession);
  const contexts = startContexts();
  const items = sessions.map((s): SessionOverview => {
    const w = sessionWindow(s, now) ?? { from: s.startedAt, to: now };
    const running = s.status === 'running' && s.endedAt == null;
    const counts = new Map<string, number>();
    for (const r of queryRows(
      "SELECT type, COUNT(*) AS n FROM events WHERE type IN ('outage', 'note') AND ts >= ? AND ts <= ? GROUP BY type",
      w.from,
      w.to,
    )) {
      counts.set(String(r.type), toNum0(r.n));
    }
    const speed = queryOne('SELECT COUNT(*) AS n FROM speedtests WHERE ts >= ? AND ts <= ?', w.from, w.to);
    return {
      session: s,
      running,
      from: w.from,
      to: w.to,
      seconds: secondsTotal(w.from, w.to),
      outages: counts.get('outage') ?? 0,
      notes: counts.get('note') ?? 0,
      speedtests: toNum0(speed?.n),
      context: contexts.get(s.id) ?? null,
    };
  });
  return { generatedAt: now, items };
}

// ─── deletion ───────────────────────────────────────────────────────────────

interface Job {
  table: string;
  sql: string;
  params: SqlParam[];
}

export interface DeleteOptions {
  /** max. time per write transaction (ms) */
  budgetMs?: number;
  /** pause between transactions, lets the engine write (ms) */
  pauseMs?: number;
}

/** Data window of a finished test: [from, to] for raw tables, [minFrom, minTo) for minute tables. */
export interface DataWindow {
  from: number;
  to: number;
  minFrom: number;
  minTo: number;
}

const FAR_FUTURE = 9e15;

/**
 * Window of the data measured during `s`. Minute tables hold whole minutes: the partial first and
 * last minute belong to the test unless a neighbouring test shares that minute (back-to-back runs).
 */
export function dataWindow(s: TestSession, others: readonly TestSession[]): DataWindow {
  const from = s.startedAt;
  const to = Math.max(from, s.endedAt ?? s.plannedEndAt ?? from);
  const endOf = (o: TestSession) => (o.status === 'running' && o.endedAt == null ? FAR_FUTURE : (o.endedAt ?? o.plannedEndAt ?? o.startedAt));
  const prevEnd = Math.max(-1, ...others.filter((o) => o.startedAt < from).map(endOf));
  const nextStart = Math.min(FAR_FUTURE, ...others.filter((o) => o.startedAt >= from).map((o) => o.startedAt));
  const firstMinute = minuteStart(from);
  const lastMinute = minuteStart(to);
  return {
    from,
    to,
    minFrom: prevEnd > firstMinute ? firstMinute + MINUTE : firstMinute,
    minTo: nextStart < lastMinute + MINUTE ? lastMinute : to,
  };
}

/** Distinct values of a leading key column (primary key or index seeks, no table scan). */
function leadingKeys(table: 'samples' | 'metrics' | 'snapshots', col: 'target_id' | 'key' | 'kind'): string[] {
  const out: string[] = [];
  let last = '';
  for (let i = 0; i < 10_000; i++) {
    const r = queryOne(`SELECT ${col} AS k FROM ${table} WHERE ${col} > ? ORDER BY ${col} LIMIT 1`, last);
    if (!r) break;
    last = String(r.k);
    out.push(last);
  }
  return out;
}

function slices(from: number, to: number, step: number): [number, number][] {
  const out: [number, number][] = [];
  for (let a = from; a <= to; a += step) out.push([a, Math.min(to, a + step - 1)]);
  return out;
}

/** All deletes for the data of a test, in a crash-safe order (the list entry goes last). */
export function deletionJobs(w: DataWindow): Job[] {
  const jobs: Job[] = [];
  if (w.minTo > w.minFrom) {
    jobs.push({ table: 'seconds_1m', sql: 'DELETE FROM seconds_1m WHERE ts >= ? AND ts < ?', params: [w.minFrom, w.minTo] });
    for (const [a, b] of slices(w.minFrom, w.minTo - 1, 6 * HOUR)) {
      jobs.push({ table: 'rollup_1m', sql: 'DELETE FROM rollup_1m WHERE ts >= ? AND ts <= ?', params: [a, b] });
    }
  }
  for (const id of leadingKeys('samples', 'target_id')) {
    for (const [a, b] of slices(w.from, w.to, HOUR)) {
      jobs.push({ table: 'samples', sql: 'DELETE FROM samples WHERE target_id = ? AND ts >= ? AND ts <= ?', params: [id, a, b] });
    }
  }
  for (const key of leadingKeys('metrics', 'key')) {
    for (const [a, b] of slices(w.from, w.to, 12 * HOUR)) {
      jobs.push({ table: 'metrics', sql: 'DELETE FROM metrics WHERE key = ? AND ts >= ? AND ts <= ?', params: [key, a, b] });
    }
  }
  // Windows event log and router log entries are copies of logs outside Netzpuls – they stay
  for (const [a, b] of slices(w.from, w.to, 6 * HOUR)) {
    jobs.push({
      table: 'events',
      sql: "DELETE FROM events WHERE ts >= ? AND ts <= ? AND source <> 'eventlog' AND type <> 'router_log'",
      params: [a, b],
    });
  }
  jobs.push({ table: 'speedtests', sql: 'DELETE FROM speedtests WHERE ts >= ? AND ts <= ?', params: [w.from, w.to] });
  jobs.push({ table: 'traceroutes', sql: 'DELETE FROM traceroutes WHERE ts >= ? AND ts <= ?', params: [w.from, w.to] });
  // the newest snapshot of each kind is the current state (router, DOCSIS, adapters …) – keep it
  for (const kind of leadingKeys('snapshots', 'kind')) {
    jobs.push({
      table: 'snapshots',
      sql: 'DELETE FROM snapshots WHERE kind = ? AND ts >= ? AND ts <= ? AND id <> (SELECT id FROM snapshots WHERE kind = ? ORDER BY ts DESC, id DESC LIMIT 1)',
      params: [kind, w.from, w.to, kind],
    });
  }
  return jobs;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function runJobs(jobs: readonly Job[], deleted: Record<string, number>, opts: Required<DeleteOptions>): Promise<void> {
  const db = getDb();
  let i = 0;
  while (i < jobs.length) {
    const started = performance.now();
    db.exec('BEGIN IMMEDIATE');
    try {
      do {
        const job = jobs[i++];
        const res = prepared(job.sql).run(...job.params);
        deleted[job.table] = (deleted[job.table] ?? 0) + Number(res.changes);
      } while (i < jobs.length && performance.now() - started < opts.budgetMs);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    if (i < jobs.length && opts.pauseMs > 0) await sleep(opts.pauseMs);
  }
}

let deleting = false;

/**
 * DELETE /api/sessions/[id]: removes a finished test – only the list entry (`entry`) or the entry
 * plus everything measured during the test (`data`). A running test is never deleted.
 */
export async function deleteSession(id: number, scope: SessionDeleteScope, opts: DeleteOptions = {}): Promise<SessionDeleteResult> {
  const row = queryOne('SELECT * FROM sessions WHERE id = ?', id);
  if (!row) throw new HttpError(404, `Langzeittest ${id} wurde nicht gefunden.`);
  const session = rowToSession(row);
  if (session.status === 'running') {
    throw new HttpError(409, 'Dieser Langzeittest läuft noch. Beende ihn zuerst über die Statusleiste – ein laufender Test kann nicht gelöscht werden.');
  }
  if (deleting) throw new HttpError(409, 'Es wird gerade schon ein Langzeittest gelöscht. Bitte warte, bis das fertig ist.');
  deleting = true;
  const started = performance.now();
  const deleted: Record<string, number> = {};
  try {
    if (scope === 'data') {
      const others = queryRows('SELECT * FROM sessions WHERE id <> ?', id).map(rowToSession);
      const w = dataWindow(session, others);
      const overlap = others.find((o) => {
        const ow = sessionWindow(o, FAR_FUTURE);
        return ow != null && ow.from < w.to && ow.to > w.from;
      });
      if (overlap) {
        throw new HttpError(
          409,
          `Der Zeitraum überschneidet sich mit Langzeittest ${overlap.label ? `„${overlap.label}“` : overlap.id}. Lösche nur den Eintrag, sonst gingen auch dessen Messdaten verloren.`,
        );
      }
      await runJobs(deletionJobs(w), deleted, { budgetMs: opts.budgetMs ?? 40, pauseMs: opts.pauseMs ?? 25 });
    }
    const res = prepared('DELETE FROM sessions WHERE id = ?').run(id);
    deleted.sessions = Number(res.changes);
  } finally {
    deleting = false;
  }
  return { id, scope, deleted, durationMs: Math.round(performance.now() - started) };
}
