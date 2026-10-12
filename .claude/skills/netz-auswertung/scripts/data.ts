// Collects everything the evaluation skill needs from the Netzpuls database through the app's own
// server query layer (src/lib/server) – the same numbers the UI shows. Read-only usage; the caller
// decides which connection db.ts uses (collect.ts opens the live database read-only).
import { getConfig } from '../../../../src/lib/server/config-store';
import { runDiagnosis } from '../../../../src/lib/server/diagnosis/index';
import { buildReport, type ReportBundle } from '../../../../src/lib/server/export';
import { linkCause } from '../../../../src/lib/server/link-events';
import { getClient, getEvents, getSeconds, getSessions, getStats, listSpeedtests } from '../../../../src/lib/server/queries';
import { redactDeep } from '../../../../src/lib/server/redact';
import { DAY, HOUR, MINUTE } from '../../../../src/lib/server/time';
import type { ClientResponse } from '../../../../src/lib/shared/api-types';
import type { SecondsRollup, TargetStats, TestSession } from '../../../../src/lib/shared/types';

/** targets used for the compact key figures (router → cable network → DS-Lite → internet → game region) */
export const KEY_TARGETS: readonly string[] = ['gw', 'isp6', 'aftr', 'cf4', 'cf6', 'aws-fra'];

/** minimum session length that counts as "a test" when no session is given explicitly */
const MIN_SESSION_MS = 30 * MINUTE;
/** window around a lag mark (the user presses the button shortly after the lag) */
const MARK_BEFORE_MS = 2 * MINUTE;
const MARK_AFTER_MS = MINUTE;

export interface Zeitraum {
  from: number;
  to: number;
  /** German description of the source, e.g. 'Langzeittest „LAN-Kabel“ (#4)' */
  quelle: string;
  session: TestSession | null;
  /** the session is still running (range ends "now") */
  laeuftNoch: boolean;
}

export interface Kennzahlen {
  label: string;
  from: number;
  to: number;
  /** classified seconds (sum over the range) */
  seconds: SecondsRollup;
  /** KEY_TARGETS that exist in the configuration, speed-test minutes excluded */
  stats: TargetStats[];
  /** NIC link drops with cause 'runtime' (real faults, not boot/standby) */
  linkDrops: number;
  speed: {
    n: number;
    downMedian: number | null;
    upMedian: number | null;
    bloatDownMedian: number | null;
    bloatUpMedian: number | null;
  };
}

export interface Markierung {
  ts: number;
  text: string;
  /** classified seconds from 2 min before to 1 min after the mark */
  seconds: SecondsRollup;
  stats: TargetStats[];
}

export interface AuswertungData {
  version: 1;
  erzeugt: number;
  zeitraum: Zeitraum;
  /** the app's report bundle ("Störungsnachweis", MAC addresses redacted) */
  bundle: ReportBundle;
  /** classified seconds per hour (local hours) */
  stunden: SecondsRollup[];
  kennzahlen: Kennzahlen;
  markierungen: Markierung[];
  client: Pick<ClientResponse, 'adapters' | 'wlan' | 'vpn'>;
  /** comparison with an earlier test (before/after a change), null if not requested */
  vergleich: Kennzahlen | null;
}

// ─── range selection (pure) ─────────────────────────────────────────────────

export type RangeRequest =
  | { kind: 'auto' }
  | { kind: 'session'; id: number }
  | { kind: 'days'; days: number }
  | { kind: 'range'; from: number; to: number };

export function sessionLabel(s: TestSession): string {
  return s.label ? `Langzeittest „${s.label}“ (#${s.id})` : `Langzeittest #${s.id}`;
}

function sessionRange(s: TestSession, now: number): Zeitraum {
  const running = s.status === 'running';
  const to = running ? Math.min(now, s.plannedEndAt ?? now) : (s.endedAt ?? now);
  return { from: s.startedAt, to: Math.max(to, s.startedAt + 1), quelle: sessionLabel(s), session: s, laeuftNoch: running };
}

/**
 * Picks the evaluation range. 'auto': the running session, else the newest session of at least
 * 30 min, else the last 24 h. Throws Error (German) for an unknown session id or an empty range.
 */
export function resolveZeitraum(req: RangeRequest, sessions: readonly TestSession[], now: number): Zeitraum {
  switch (req.kind) {
    case 'session': {
      const s = sessions.find((x) => x.id === req.id);
      if (!s) throw new Error(`Langzeittest #${req.id} gibt es nicht. Vorhanden: ${sessions.map((x) => `#${x.id}`).join(', ') || 'keine'}`);
      return sessionRange(s, now);
    }
    case 'days':
      return { from: now - req.days * DAY, to: now, quelle: `letzte ${req.days === 1 ? '24 Stunden' : `${req.days} Tage`}`, session: null, laeuftNoch: true };
    case 'range':
      if (!(req.to > req.from)) throw new Error('Ungültiger Zeitraum: „bis“ muss nach „von“ liegen');
      return { from: req.from, to: Math.min(req.to, now), quelle: 'frei gewählter Zeitraum', session: null, laeuftNoch: req.to >= now };
    case 'auto': {
      const running = sessions.find((s) => s.status === 'running');
      if (running) return sessionRange(running, now);
      const done = sessions.find((s) => (s.endedAt ?? now) - s.startedAt >= MIN_SESSION_MS);
      if (done) return sessionRange(done, now);
      return resolveZeitraum({ kind: 'days', days: 1 }, sessions, now);
    }
  }
}

/** "2026-10-10 12:00", "2026-10-10T12:00", "10.10.2026 12:00" or "10.10.2026" → epoch ms (local time) */
export function parseLocalDate(text: string): number {
  const t = text.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?$/.exec(t);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0)).getTime();
  m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:,?\s+(\d{1,2}):(\d{2}))?$/.exec(t);
  if (m) return new Date(+m[3], +m[2] - 1, +m[1], +(m[4] ?? 0), +(m[5] ?? 0)).getTime();
  throw new Error(`Datum nicht erkannt: „${text}“ (Beispiel: 2026-10-10 18:00 oder 10.10.2026 18:00)`);
}

export function median(values: readonly (number | null | undefined)[]): number | null {
  const v = values.filter((x): x is number => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

// ─── DB-backed collection ───────────────────────────────────────────────────

function keyTargets(): string[] {
  const ids = new Set(getConfig().targets.filter((t) => t.enabled).map((t) => t.id));
  return KEY_TARGETS.filter((id) => ids.has(id));
}

export function kennzahlen(label: string, from: number, to: number): Kennzahlen {
  const speed = listSpeedtests(from, to, 1000).items.filter((s) => s.error === null);
  const drops = getEvents({ from, to, types: ['nic_link_down'], limit: 5000, offset: 0 }).events.filter((e) => linkCause(e.details) === 'runtime');
  return {
    label,
    from,
    to,
    seconds: getSeconds(from, to, to - from).total,
    stats: getStats({ from, to, targets: keyTargets(), excludeSpeedtests: true }).stats,
    linkDrops: drops.length,
    speed: {
      n: speed.length,
      downMedian: median(speed.map((s) => s.downMbps)),
      upMedian: median(speed.map((s) => s.upMbps)),
      bloatDownMedian: median(speed.map((s) => s.bloatDownMs)),
      bloatUpMedian: median(speed.map((s) => s.bloatUpMs)),
    },
  };
}

function markierungen(from: number, to: number): Markierung[] {
  const notes = getEvents({ from, to, types: ['note'], limit: 500, offset: 0 }).events.slice().reverse();
  const targets = keyTargets();
  return notes.map((e) => {
    const a = e.ts - MARK_BEFORE_MS;
    const b = e.ts + MARK_AFTER_MS;
    return {
      ts: e.ts,
      text: e.title,
      seconds: getSeconds(a, b, b - a).total,
      stats: getStats({ from: a, to: b, targets, excludeSpeedtests: false }).stats,
    };
  });
}

export function listSessions(): TestSession[] {
  return getSessions(1000).items;
}

export interface CollectOptions {
  range: RangeRequest;
  /** session id of an earlier test to compare with */
  vergleich?: number | null;
  now?: number;
}

export async function collectData(opts: CollectOptions): Promise<AuswertungData> {
  const now = opts.now ?? Date.now();
  const sessions = listSessions();
  const zeitraum = resolveZeitraum(opts.range, sessions, now);
  const { from, to } = zeitraum;
  const cfg = getConfig();
  const bundle = await buildReport(from, to, cfg, runDiagnosis, now);
  const client = getClient(from, to);
  let vergleich: Kennzahlen | null = null;
  if (opts.vergleich != null) {
    const v = resolveZeitraum({ kind: 'session', id: opts.vergleich }, sessions, now);
    vergleich = kennzahlen(v.quelle, v.from, v.to);
  }
  return {
    version: 1,
    erzeugt: now,
    zeitraum,
    bundle,
    stunden: getSeconds(from, to, HOUR).buckets,
    kennzahlen: kennzahlen(zeitraum.quelle, from, to),
    markierungen: markierungen(from, to),
    client: redactDeep({ adapters: client.adapters, wlan: client.wlan, vpn: client.vpn }),
    vergleich,
  };
}
