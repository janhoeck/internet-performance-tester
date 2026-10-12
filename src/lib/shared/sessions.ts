// Long-term tests ("Langzeittests"): API shapes of GET /api/sessions/overview and
// DELETE /api/sessions/[id] plus pure helpers shared by the Next server and the UI.
// Module-local types on purpose (api-types.ts is a fixed contract file).
import type { SecondsRollup, TestSession } from './types';

/** Connection at the start of a test (from its first `session_start` event). */
export interface SessionStartContext {
  primaryAdapter: string | null;
  isWifi: boolean | null;
  linkMbps: number | null;
  ssid: string | null;
}

export interface SessionOverview {
  session: TestSession;
  /** the test is still measuring */
  running: boolean;
  /** analysed window: startedAt … end (now for a running test) */
  from: number;
  to: number;
  /** summed classified seconds of the window (null = nothing classified) */
  seconds: SecondsRollup | null;
  outages: number;
  /** user marks ("Lag markieren") */
  notes: number;
  speedtests: number;
  context: SessionStartContext | null;
}

export interface SessionOverviewResponse {
  generatedAt: number;
  items: SessionOverview[];
}

/** entry = only the list entry; data = entry + everything measured during the test */
export type SessionDeleteScope = 'entry' | 'data';

export interface SessionDeleteResult {
  id: number;
  scope: SessionDeleteScope;
  /** deleted rows per table */
  deleted: Record<string, number>;
  durationMs: number;
}

export function isRunningSession(s: TestSession): boolean {
  return s.status === 'running' && s.endedAt == null;
}

/**
 * Time window of a test: start … end (running: now; ended without endedAt: planned end).
 * null while `now` is unknown for a running test.
 */
export function sessionWindow(s: TestSession, now: number | null): { from: number; to: number } | null {
  const end = isRunningSession(s) ? now : (s.endedAt ?? s.plannedEndAt ?? now);
  if (end == null) return null;
  return { from: s.startedAt, to: Math.max(s.startedAt, end) };
}

/** Lower case, without diacritics and surrounding blanks ("Küche" → "kuche") for name search. */
export function searchKey(v: string): string {
  return v.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Every word of the query occurs in the test's name or note (empty query = all). */
export function matchesSessionQuery(s: TestSession, query: string): boolean {
  const words = searchKey(query).split(' ').filter(Boolean);
  if (words.length === 0) return true;
  const hay = searchKey(`${s.label ?? ''} ${s.note ?? ''} #${s.id}`);
  return words.every((w) => hay.includes(w));
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Connection details of a `session_start` event (null if none are present). */
export function startContextOf(details: Record<string, unknown> | null): SessionStartContext | null {
  if (!details) return null;
  const ctx: SessionStartContext = {
    primaryAdapter: str(details.primaryAdapter) ?? str(details.expectedIf),
    isWifi: typeof details.isWifi === 'boolean' ? details.isWifi : null,
    linkMbps: num(details.linkMbps),
    ssid: str(details.ssid),
  };
  return ctx.primaryAdapter == null && ctx.isWifi == null && ctx.linkMbps == null ? null : ctx;
}
