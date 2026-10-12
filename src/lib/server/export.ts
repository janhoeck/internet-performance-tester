// File downloads for GET /api/export: CSV (German Excel) or JSON per ExportKind, plus the
// 'report' JSON bundle for the provider ("Störungsnachweis"). Large tables are streamed from
// SQLite iterators; MAC addresses are redacted in everything that leaves the PC.
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { ExportKind } from '../shared/api-types';
import { type AppConfig } from '../shared/config';
import { EVENT_COLUMNS, rowToEvent, rowToSpeedtest, rowToTraceroute } from '../shared/db/rows';
import { METRICS, UDP_BURST_STATS, metricDef, udpBurstKey, type UdpBurstStat } from '../shared/metrics';
import type { DiagnosisReport, NetEvent, SampleStatusCode, TargetStats } from '../shared/types';
import { SampleFlag } from '../shared/types';
import { CSV_BOM, type CsvValue, csvRow } from './csv';
import { getDb } from './db';
import {
  getClient,
  getEvents,
  getHourProfile,
  getPath,
  getRouter,
  getSeconds,
  getSessions,
  getStats,
  listSpeedtests,
  listTraceroutes,
} from './queries';
import { redactDeep, redactMacs } from './redact';
import { DAY, fmtFileStamp, fmtLocalDateTime } from './time';

export type ExportFormat = 'csv' | 'json';

/** runDiagnosis of src/lib/server/diagnosis (injected by the route – keeps this module testable on its own). */
export type DiagnoseFn = (from: number, to: number) => DiagnosisReport | Promise<DiagnosisReport>;

export interface ExportQuery {
  kind: ExportKind;
  format: ExportFormat;
  from: number;
  to: number;
  /** samples/rollups: target ids (default: all configured targets) */
  targets?: readonly string[];
  /** metrics: keys (default: all registry keys + UDP burst keys) */
  keys?: readonly string[];
}

const STATUS_TEXT: Record<SampleStatusCode, string> = {
  0: 'OK',
  1: 'Zeitüberschreitung',
  2: 'Nicht erreichbar',
  3: 'Fehler',
  4: 'TTL abgelaufen',
};

export function statusText(status: number): string {
  return STATUS_TEXT[status as SampleStatusCode] ?? String(status);
}

export function flagsText(flags: number): string {
  const parts: string[] = [];
  if (flags & SampleFlag.LOAD) parts.push('Last (Speedtest)');
  if (flags & SampleFlag.FAILOVER) parts.push('WLAN-Ausweichen');
  if (flags & SampleFlag.LATE) parts.push('verspätet');
  return parts.join(', ');
}

export function exportFileName(kind: ExportKind, format: ExportFormat, now: number = Date.now()): string {
  const name = kind === 'report' ? 'bericht' : kind;
  return `netzdiagnose-${name}-${fmtFileStamp(now)}.${format}`;
}

function downloadHeaders(fileName: string, format: ExportFormat): Record<string, string> {
  return {
    'Content-Type': format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8',
    'Content-Disposition': `attachment; filename="${fileName}"`,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  };
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'bigint' ? Number(v) : null);
const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

// ─── streaming row sources ──────────────────────────────────────────────────

/** Sequential SQLite iterators (fresh statements – never the shared statement cache). */
class RowCursor {
  private stmt: StatementSync | null = null;
  private it: Iterator<unknown> | null = null;
  private part = 0;
  private done = false;

  constructor(
    private readonly db: DatabaseSync,
    private readonly sql: string,
    private readonly paramSets: readonly (readonly (string | number | null)[])[],
  ) {}

  /** next row as array, or null when exhausted */
  next(): unknown[] | null {
    while (!this.done) {
      if (!this.it) {
        if (this.part >= this.paramSets.length) {
          this.done = true;
          break;
        }
        this.stmt = this.db.prepare(this.sql);
        this.stmt.setReturnArrays(true);
        this.it = this.stmt.iterate(...this.paramSets[this.part]) as Iterator<unknown>;
        this.part++;
      }
      const r = this.it.next();
      if (!r.done) return r.value as unknown[];
      this.it = null;
      this.stmt = null;
    }
    return null;
  }

  close(): void {
    this.done = true;
    try {
      this.it?.return?.();
    } catch {
      /* ignore */
    }
    this.it = null;
    this.stmt = null;
  }
}

interface TableSpec {
  header: readonly string[];
  csv: (row: unknown[]) => CsvValue[];
  json: (row: unknown[]) => unknown;
}

const ROWS_PER_CHUNK = 2000;

function streamTable(cursor: RowCursor, spec: TableSpec, format: ExportFormat, meta: Record<string, unknown>): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let started = false;
  let first = true;
  let finished = false;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (finished) return;
      try {
        let out = '';
        if (!started) {
          started = true;
          out += format === 'csv' ? CSV_BOM + csvRow(spec.header) : `${JSON.stringify(meta).slice(0, -1)},"items":[`;
        }
        for (let i = 0; i < ROWS_PER_CHUNK; i++) {
          const row = cursor.next();
          if (row === null) {
            finished = true;
            break;
          }
          if (format === 'csv') out += csvRow(spec.csv(row));
          else {
            out += (first ? '\n' : ',\n') + JSON.stringify(spec.json(row));
            first = false;
          }
        }
        if (finished) {
          if (format === 'json') out += '\n]}\n';
          cursor.close();
        }
        if (out) controller.enqueue(enc.encode(out));
        if (finished) controller.close();
      } catch (err) {
        finished = true;
        cursor.close();
        controller.error(err);
      }
    },
    cancel() {
      finished = true;
      cursor.close();
    },
  });
}

const SAMPLE_SPEC: TableSpec = {
  header: ['Zeit', 'Zeitstempel (ms)', 'Ziel', 'RTT (ms)', 'Status', 'Kennzeichen'],
  csv: (r) => {
    const ts = num(r[1]) ?? 0;
    return [fmtLocalDateTime(ts), ts, str(r[0]), num(r[2]), statusText(num(r[3]) ?? 3), flagsText(num(r[4]) ?? 0)];
  },
  json: (r) => ({ targetId: str(r[0]), ts: num(r[1]), rtt: num(r[2]), status: num(r[3]), flags: num(r[4]) ?? 0 }),
};

const ROLLUP_SPEC: TableSpec = {
  header: ['Zeit', 'Zeitstempel (ms)', 'Ziel', 'Gesendet', 'Verloren', 'Verlust (%)', 'Min (ms)', 'Ø (ms)', 'Max (ms)', 'p50 (ms)', 'p95 (ms)', 'p99 (ms)', 'Jitter (ms)', 'Std.-Abw. (ms)', 'Spitzen'],
  csv: (r) => {
    const ts = num(r[1]) ?? 0;
    const sent = num(r[2]) ?? 0;
    const lost = num(r[3]) ?? 0;
    return [fmtLocalDateTime(ts), ts, str(r[0]), sent, lost, sent > 0 ? (lost / sent) * 100 : null, num(r[4]), num(r[5]), num(r[6]), num(r[7]), num(r[8]), num(r[9]), num(r[10]), num(r[11]), num(r[12])];
  },
  json: (r) => ({
    targetId: str(r[0]),
    ts: num(r[1]),
    sent: num(r[2]),
    lost: num(r[3]),
    min: num(r[4]),
    avg: num(r[5]),
    max: num(r[6]),
    p50: num(r[7]),
    p95: num(r[8]),
    p99: num(r[9]),
    jitter: num(r[10]),
    stddev: num(r[11]),
    spikes: num(r[12]),
    hist: str(r[13]),
  }),
};

const METRIC_SPEC: TableSpec = {
  header: ['Zeit', 'Zeitstempel (ms)', 'Kennzahl', 'Bezeichnung', 'Wert', 'Einheit'],
  csv: (r) => {
    const ts = num(r[1]) ?? 0;
    const key = str(r[0]);
    const def = metricDef(key);
    return [fmtLocalDateTime(ts), ts, key, def?.label ?? '', num(r[2]), def?.unit ?? ''];
  },
  json: (r) => ({ key: str(r[0]), ts: num(r[1]), value: num(r[2]) }),
};

function defaultMetricKeys(cfg: AppConfig): string[] {
  const keys = Object.keys(METRICS);
  for (const t of cfg.targets) {
    if (t.kind !== 'udp-dns') continue;
    for (const stat of Object.keys(UDP_BURST_STATS) as UdpBurstStat[]) keys.push(udpBurstKey(t.id, stat));
  }
  return keys;
}

// ─── small tables (events, speed tests, traceroutes) ────────────────────────

function eventsCsv(events: readonly NetEvent[]): string {
  let out = CSV_BOM + csvRow(['ID', 'Beginn', 'Ende', 'Dauer (s)', 'Typ', 'Schweregrad', 'Abschnitt', 'Quelle', 'Titel', 'Details']);
  for (const e of events) {
    const dur = e.endTs !== null && e.endTs !== undefined ? (e.endTs - e.ts) / 1000 : null;
    out += csvRow([
      e.id ?? null,
      fmtLocalDateTime(e.ts),
      e.endTs !== null && e.endTs !== undefined ? fmtLocalDateTime(e.endTs) : '',
      dur,
      e.type,
      e.severity,
      e.segment ?? '',
      e.source,
      e.title,
      e.details ? JSON.stringify(e.details) : '',
    ]);
  }
  return out;
}

function eventsInRange(from: number, to: number, limit = 200_000): NetEvent[] {
  const rows = getDb()
    .prepare(`SELECT id, ${EVENT_COLUMNS} FROM events WHERE ts >= ? AND ts < ? ORDER BY ts, id LIMIT ?`)
    .all(from, to, limit) as Record<string, unknown>[];
  return rows.map((r) => redactDeep(rowToEvent(r)));
}

function speedtestsCsv(from: number, to: number): string {
  const items = listSpeedtests(from, to, 100_000).items.slice().reverse();
  let out =
    CSV_BOM +
    csvRow([
      'ID', 'Beginn', 'Ende', 'Auslöser', 'Server', 'Download (Mbit/s)', 'Upload (Mbit/s)', 'Leerlauf-Latenz (ms)', 'Leerlauf-Jitter (ms)',
      'Latenz unter Download-Last (ms)', 'p95 Download-Last (ms)', 'Latenz unter Upload-Last (ms)', 'p95 Upload-Last (ms)',
      'Bufferbloat Download (ms)', 'Bufferbloat Upload (ms)', 'Note', 'Daten Download (Byte)', 'Daten Upload (Byte)', 'Verbindungen',
      'Link (Mbit/s)', 'Fehler',
    ]);
  for (const s of items) {
    out += csvRow([
      s.id ?? null, fmtLocalDateTime(s.ts), fmtLocalDateTime(s.endTs), s.trigger === 'manual' ? 'manuell' : 'Zeitplan', s.server ?? '',
      s.downMbps, s.upMbps, s.idleLatencyMs, s.idleJitterMs, s.loadedDownLatencyMs, s.loadedDownP95Ms, s.loadedUpLatencyMs,
      s.loadedUpP95Ms, s.bloatDownMs, s.bloatUpMs, s.grade ?? '', s.bytesDown, s.bytesUp, s.streams, s.nicLinkMbps, s.error ?? '',
    ]);
  }
  return out;
}

function speedtestsJson(from: number, to: number): unknown[] {
  const rows = getDb().prepare('SELECT * FROM speedtests WHERE ts >= ? AND ts < ? ORDER BY ts, id').all(from, to) as Record<string, unknown>[];
  return rows.map((r) => rowToSpeedtest(r, true));
}

function traceroutesInRange(from: number, to: number) {
  const rows = getDb().prepare('SELECT * FROM traceroutes WHERE ts >= ? AND ts < ? ORDER BY ts, id LIMIT 100000').all(from, to) as Record<string, unknown>[];
  return rows.map((r) => rowToTraceroute(r));
}

function traceroutesCsv(from: number, to: number): string {
  let out =
    CSV_BOM +
    csvRow(['Zeit', 'Zeitstempel (ms)', 'Ziel', 'IP-Version', 'Auslöser', 'Ziel erreicht', 'Route geändert', 'Hop', 'IP', 'Ø (ms)', 'Verlust (%)', 'RTTs (ms)']);
  for (const t of traceroutesInRange(from, to)) {
    for (const h of t.hops) {
      out += csvRow([
        fmtLocalDateTime(t.ts), t.ts, t.target, `IPv${t.family}`, t.trigger, t.reached, t.changed, h.hop, h.ip ?? '*', h.avgMs, h.lossPct,
        h.rtts.map((r) => (r === null ? '*' : String(r).replace('.', ','))).join(' / '),
      ]);
    }
  }
  return out;
}

// ─── report bundle ──────────────────────────────────────────────────────────

const PROFILE_TARGETS = ['gw', 'isp6', 'aftr', 'cf4', 'cf6', 'g4', 'g6'];

export interface ReportBundle {
  app: 'Netzdiagnose';
  version: 1;
  generatedAt: number;
  from: number;
  to: number;
  hinweis: string;
  config: {
    routerIp: string;
    routerAdapter: string;
    tariff: AppConfig['tariff'];
    targets: { id: string; name: string; host: string; family: number; kind: string; segment: string; enabled: boolean }[];
  };
  diagnosis: DiagnosisReport | null;
  diagnosisError: string | null;
  sessions: ReturnType<typeof getSessions>['items'];
  stats: TargetStats[];
  secondsTotal: ReturnType<typeof getSeconds>['total'];
  secondsPerDay: ReturnType<typeof getSeconds>['buckets'];
  timeProfile: Record<string, ReturnType<typeof getHourProfile>>;
  outages: NetEvent[];
  link: { summary: ReturnType<typeof getClient>['linkSummary']; days: ReturnType<typeof getClient>['linkDays']; events: NetEvent[] };
  speedtests: ReturnType<typeof listSpeedtests>['items'];
  traceroutes: ReturnType<typeof listTraceroutes>['items'];
  router: ReturnType<typeof getRouter>;
  path: ReturnType<typeof getPath>;
  notableEvents: NetEvent[];
  notes: NetEvent[];
}

export async function buildReport(from: number, to: number, cfg: AppConfig, diagnose: DiagnoseFn, now: number = Date.now()): Promise<ReportBundle> {
  let diagnosis: DiagnosisReport | null = null;
  let diagnosisError: string | null = null;
  try {
    diagnosis = await diagnose(from, to);
  } catch (err) {
    diagnosisError = `Diagnose fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`;
  }
  const targetIds = cfg.targets.filter((t) => t.enabled).map((t) => t.id);
  const client = getClient(from, to);
  const seconds = getSeconds(from, to, DAY);
  const timeProfile: ReportBundle['timeProfile'] = {};
  for (const id of PROFILE_TARGETS) if (cfg.targets.some((t) => t.id === id)) timeProfile[id] = getHourProfile(id, from, to);
  const traceroutes = listTraceroutes({ from, to, limit: 500 }).items;
  const latestPerFamily = [4, 6].map((f) => traceroutes.find((t) => t.family === f)).filter((t) => t !== undefined);
  const changed = traceroutes.filter((t) => t.changed).slice(0, 50);
  const bundle: ReportBundle = {
    app: 'Netzdiagnose',
    version: 1,
    generatedAt: now,
    from,
    to,
    hinweis: 'Automatisch erzeugter Messbericht. MAC-Adressen sind unkenntlich gemacht. Zeitangaben in ms seit 1970 (UTC).',
    config: {
      routerIp: cfg.router.ip,
      routerAdapter: cfg.router.adapter,
      tariff: cfg.tariff,
      targets: cfg.targets.map((t) => ({ id: t.id, name: t.name, host: t.host, family: t.family, kind: t.kind, segment: t.segment, enabled: t.enabled })),
    },
    diagnosis,
    diagnosisError,
    sessions: getSessions(1000).items.filter((s) => s.startedAt < to && (s.endedAt ?? to) >= from),
    stats: getStats({ from, to, targets: targetIds, excludeSpeedtests: true }, cfg).stats,
    secondsTotal: seconds.total,
    secondsPerDay: seconds.buckets,
    timeProfile,
    outages: getEvents({ from, to, types: ['outage'], limit: 5000, offset: 0 }).events,
    link: { summary: client.linkSummary, days: client.linkDays, events: client.linkEvents },
    speedtests: listSpeedtests(from, to, 1000).items,
    traceroutes: [...new Map([...latestPerFamily, ...changed].map((t) => [t.id, t])).values()],
    router: getRouter(from, to, cfg),
    path: getPath(),
    notableEvents: getEvents({ from, to, severities: ['warn', 'critical'], limit: 2000, offset: 0 }).events,
    notes: getEvents({ from, to, types: ['note'], limit: 1000, offset: 0 }).events,
  };
  return redactDeep(bundle);
}

// ─── entry point ────────────────────────────────────────────────────────────

export async function exportResponse(q: ExportQuery, cfg: AppConfig, diagnose: DiagnoseFn, now: number = Date.now()): Promise<Response> {
  const format: ExportFormat = q.kind === 'report' ? 'json' : q.format;
  const fileName = exportFileName(q.kind, format, now);
  const headers = downloadHeaders(fileName, format);
  const meta = { kind: q.kind, from: q.from, to: q.to, generatedAt: now };
  const db = getDb();
  switch (q.kind) {
    case 'samples': {
      const targets = q.targets ?? cfg.targets.map((t) => t.id);
      const cursor = new RowCursor(
        db,
        'SELECT target_id, ts, rtt, status, flags FROM samples WHERE target_id = ? AND ts >= ? AND ts < ? ORDER BY ts',
        targets.map((t) => [t, q.from, q.to]),
      );
      return new Response(streamTable(cursor, SAMPLE_SPEC, format, meta), { headers });
    }
    case 'rollups': {
      const targets = q.targets ?? cfg.targets.map((t) => t.id);
      const cursor = new RowCursor(
        db,
        'SELECT target_id, ts, sent, lost, min, avg, max, p50, p95, p99, jitter, stddev, spikes, hist FROM rollup_1m WHERE target_id = ? AND ts >= ? AND ts < ? ORDER BY ts',
        targets.map((t) => [t, q.from, q.to]),
      );
      return new Response(streamTable(cursor, ROLLUP_SPEC, format, meta), { headers });
    }
    case 'metrics': {
      const keys = q.keys ?? defaultMetricKeys(cfg);
      const cursor = new RowCursor(
        db,
        'SELECT key, ts, value FROM metrics WHERE key = ? AND ts >= ? AND ts < ? ORDER BY ts',
        keys.map((k) => [k, q.from, q.to]),
      );
      return new Response(streamTable(cursor, METRIC_SPEC, format, meta), { headers });
    }
    case 'events': {
      const events = eventsInRange(q.from, q.to);
      const body = format === 'csv' ? eventsCsv(events) : JSON.stringify({ ...meta, items: events });
      return new Response(body, { headers });
    }
    case 'speedtests': {
      const body = format === 'csv' ? speedtestsCsv(q.from, q.to) : JSON.stringify({ ...meta, items: speedtestsJson(q.from, q.to) });
      return new Response(body, { headers });
    }
    case 'traceroutes': {
      const body = format === 'csv' ? traceroutesCsv(q.from, q.to) : JSON.stringify({ ...meta, items: traceroutesInRange(q.from, q.to) });
      return new Response(redactMacs(body), { headers });
    }
    case 'report': {
      const bundle = await buildReport(q.from, q.to, cfg, diagnose, now);
      return new Response(JSON.stringify(bundle, null, 2), { headers });
    }
  }
}
