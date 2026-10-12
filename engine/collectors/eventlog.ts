// Windows event log collector (ARCHITECTURE §4.9): incremental `wevtutil qe <log> /f:xml /uni:true`
// polls with one RecordId cursor per log (settings 'eventlog.cursor.<log>'), full history import on
// first start (config.eventLog.importDays), link-drop classification (parsers/winevent.ts) with
// provisional results that are updated until all look-ahead windows have passed.
import type { AppConfig } from '../../src/lib/shared/config';
import type { AdapterSnapshot, ModuleState, NetEvent, Sample } from '../../src/lib/shared/types';
import {
  EVENT_LOGS,
  LINK_RULES,
  LOG_SELECTORS,
  LOG_SYSTEM,
  LOG_WLAN,
  analyzeLinkDrops,
  buildEventQuery,
  byTime,
  decodeUtf16le,
  eventDedupeKey,
  linkDownEvent,
  linkDownPatch,
  linkKindOf,
  parseWevtutilXml,
  winEventToNetEvent,
  type EventLogName,
  type InternetRecovery,
  type LinkCause,
  type LinkDropAnalysis,
  type WinEvent,
} from '../../src/lib/shared/parsers/winevent';
import type { EngineContext, EngineModule, Logger, NicTick } from '../core/types';
import { PollTimer, ProcessRunner, childTracker, errorMessage, isRecord, system32, timersState } from './util';

export const CURSOR_PREFIX = 'eventlog.cursor.';
export const OPEN_SETTING = 'eventlog.open';
export const IMPORT_SETTING = 'eventlog.importedAt';
export const cursorKey = (log: string): string => `${CURSOR_PREFIX}${log}`;
/** set once the WLAN-AutoConfig log is read by this module (the wlan module then skips its own connect/disconnect events) */
export const WLAN_CURSOR_KEY = cursorKey(LOG_WLAN);

const WEVTUTIL = (): string => system32('wevtutil.exe');
const PAGE_SIZE = 5000;
const MAX_PAGES = 40;
const QUERY_TIMEOUT_MS = 30_000;
/** recent context kept in memory for the classification of new link drops */
const WINDOW_MS = 2 * 3600_000;
const MAX_WARMUP_MS = 7 * 86_400_000;
/** events older than this are stored without live publication (history import) */
const HISTORY_AGE_MS = 3600_000;
/** a log that does not exist (e.g. no WLAN service) is retried after this time */
const MISSING_RETRY_MS = 30 * 60_000;
/** check for a cleared log after this many empty polls */
const CLEAR_CHECK_EVERY = 15;
const INSERT_CHUNK = 200;
const WEVTUTIL_CHANNEL_NOT_FOUND = 15007;

// ─── wevtutil ──────────────────────────────────────────────────────────────

export type QueryResult = { ok: true; events: WinEvent[] } | { ok: false; missing: boolean; error: string };

function decodeStderr(buf: Buffer): string {
  if (buf.length === 0) return '';
  const text = buf.includes(0) ? decodeUtf16le(new Uint8Array(buf)) : buf.toString('latin1');
  return text.replace(/\s+/g, ' ').trim().slice(0, 300);
}

export type WevtutilRunner = Pick<ProcessRunner, 'run'>;

async function runQuery(runner: WevtutilRunner, log: string, args: string[]): Promise<QueryResult> {
  const r = await runner.run(WEVTUTIL(), ['qe', log, '/f:xml', '/uni:true', ...args], { timeoutMs: QUERY_TIMEOUT_MS, maxBytes: 256 * 1024 * 1024 });
  if (r.error) return { ok: false, missing: r.error.code === 'ENOENT', error: errorMessage(r.error) };
  if (r.timedOut) return { ok: false, missing: false, error: `wevtutil: Zeitüberschreitung (${log})` };
  if (r.code !== 0) {
    return { ok: false, missing: r.code === WEVTUTIL_CHANNEL_NOT_FOUND, error: `wevtutil ${r.code}: ${decodeStderr(r.stderr) || 'Fehler'}` };
  }
  return { ok: true, events: parseWevtutilXml(decodeUtf16le(new Uint8Array(r.stdout))) };
}

/** All matching events of one log (oldest first, paged by RecordId). */
export async function fetchEvents(
  runner: WevtutilRunner,
  log: EventLogName,
  opts: { afterRecordId?: number; maxAgeMs?: number },
): Promise<QueryResult> {
  const all: WinEvent[] = [];
  let after = opts.afterRecordId ?? 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const q = buildEventQuery(LOG_SELECTORS[log], { afterRecordId: after, maxAgeMs: opts.maxAgeMs });
    const r = await runQuery(runner, log, [`/c:${PAGE_SIZE}`, `/q:${q}`]);
    if (!r.ok) return page === 0 ? r : { ok: true, events: all };
    all.push(...r.events);
    if (r.events.length < PAGE_SIZE) break;
    after = Math.max(after, ...r.events.map((e) => e.recordId));
  }
  return { ok: true, events: all };
}

/** RecordId of the newest event in a log (0 for an empty log), null on error. */
export async function newestRecordId(runner: WevtutilRunner, log: string): Promise<number | null> {
  const r = await runQuery(runner, log, ['/c:1', '/rd:true']);
  if (!r.ok) return null;
  return r.events[0]?.recordId ?? 0;
}

// ─── internet reachability from the engine's own samples ───────────────────

/** Per second: did any internet target answer? (feeds the router-reboot rule while a session runs) */
export class InternetTracker {
  private readonly seconds = new Map<number, boolean>();
  private targets = new Set<string>();
  private lastPrune = 0;

  setTargets(cfg: AppConfig): void {
    this.targets = new Set(cfg.targets.filter((t) => t.segment === 'internet').map((t) => t.id));
  }

  onSample(s: Sample, now = Date.now()): void {
    if (!this.targets.has(s.targetId)) return;
    const sec = Math.floor(s.ts / 1000);
    this.seconds.set(sec, (this.seconds.get(sec) ?? false) || s.status === 0);
    if (now - this.lastPrune > 60_000) {
      this.lastPrune = now;
      const min = Math.floor((now - 45 * 60_000) / 1000);
      for (const k of this.seconds.keys()) if (k < min) this.seconds.delete(k);
    }
  }

  /** null when no samples cover the moment of the link drop */
  recovery(downTs: number): InternetRecovery | null {
    const s0 = Math.floor(downTs / 1000);
    let covered = false;
    for (let k = s0 - 10; k <= s0 + 10 && !covered; k++) covered = this.seconds.has(k);
    if (!covered) return null;
    const after = [...this.seconds.entries()].filter(([sec]) => sec > s0).sort((a, b) => a[0] - b[0]);
    let last = s0;
    for (const [sec, ok] of after) {
      if (ok) return { recoveredTs: sec * 1000, coveredUntil: sec * 1000 };
      last = sec;
    }
    return { recoveredTs: null, coveredUntil: last * 1000 };
  }
}

// ─── module ────────────────────────────────────────────────────────────────

/** interface GUIDs of the wired physical adapters (extra field 'guid' written by the adapter module) */
export function wiredGuidsOf(adapters: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const a of adapters) {
    if (!isRecord(a) || a.isWifi === true || a.isVirtual === true) continue;
    const g = typeof a.guid === 'string' ? a.guid.trim().toLowerCase() : '';
    if (g !== '') out.push(g);
  }
  return out;
}

/** the history import waits this long for the first adapters snapshot (wired GUIDs for the 'inactive' rule) */
const ADAPTERS_WAIT_MS = 15_000;

interface OpenDown {
  id: number;
  ts: number;
  /** JSON of the last written patch (update only on change) */
  sig: string;
}

export interface ImportSummary {
  days: number;
  scanned: number;
  inserted: number;
  linkDowns: Record<LinkCause, number>;
  durationMs: number;
  errors: string[];
}

function parseOpen(json: string | null): Map<string, OpenDown> {
  const out = new Map<string, OpenDown>();
  if (!json) return out;
  try {
    const v: unknown = JSON.parse(json);
    if (!Array.isArray(v)) return out;
    for (const item of v) {
      if (!isRecord(item)) continue;
      const { key, id, ts, sig } = item;
      if (typeof key === 'string' && typeof id === 'number' && typeof ts === 'number') {
        out.set(key, { id, ts, sig: typeof sig === 'string' ? sig : '' });
      }
    }
  } catch {
    /* corrupt setting – start fresh */
  }
  return out;
}

function countCauses(list: LinkDropAnalysis[]): Record<LinkCause, number> {
  const c: Record<LinkCause, number> = { boot: 0, pre_sleep: 0, router_reboot: 0, runtime: 0 };
  for (const a of list) c[a.cause]++;
  return c;
}

const yieldToLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

export interface EventLogDeps {
  /** replaces the wevtutil runner (tests) */
  runner?: Pick<ProcessRunner, 'run' | 'killAll'>;
  /** clock (tests) */
  now?: () => number;
  /** start the poll timer in init() (default true) */
  autoStart?: boolean;
}

export class EventLogModule implements EngineModule {
  readonly name = 'eventlog';
  private ctx: EngineContext | null = null;
  private log: Logger | null = null;
  private runner: Pick<ProcessRunner, 'run' | 'killAll'> | null = null;
  private timer: PollTimer | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly cursors = new Map<string, number>();
  private open = new Map<string, OpenDown>();
  private window: WinEvent[] = [];
  private readonly windowKeys = new Set<string>();
  private readonly processed = new Set<string>();
  private readonly missingUntil = new Map<string, number>();
  private readonly emptyPolls = new Map<string, number>();
  private readonly internet = new InternetTracker();
  private readonly nicUp = new Map<string, boolean>();
  private unsubs: (() => void)[] = [];
  private warmedUp = false;
  private lastError: string | null = null;
  private importing = false;
  private wiredGuids: string[] = [];
  private adaptersSeen = false;
  private adaptersWaiters: (() => void)[] = [];
  private readonly now: () => number;

  constructor(private readonly deps: EventLogDeps = {}) {
    this.now = deps.now ?? Date.now;
  }

  init(ctx: EngineContext): void {
    this.ctx = ctx;
    this.log = ctx.log;
    this.runner = this.deps.runner ?? new ProcessRunner(childTracker(ctx));
    for (const log of EVENT_LOGS) {
      const v = Number(ctx.db.getSetting(cursorKey(log)));
      if (Number.isFinite(v) && v > 0) this.cursors.set(log, v);
    }
    this.open = parseOpen(ctx.db.getSetting(OPEN_SETTING));
    try {
      const snap = ctx.db.latestSnapshot<AdapterSnapshot>('adapters')?.data;
      if (snap && Array.isArray(snap.adapters)) this.wiredGuids = wiredGuidsOf(snap.adapters);
    } catch {
      /* no snapshot yet */
    }
    this.internet.setTargets(ctx.config());
    this.unsubs.push(
      ctx.bus.on('sample', (s) => this.internet.onSample(s, this.now())),
      ctx.bus.on('config', (cfg) => this.internet.setTargets(cfg)),
      ctx.bus.on('nic', (t) => this.onNic(t)),
      ctx.bus.on('adapters', (snap) => this.onAdapters(snap)),
    );
    this.timer = new PollTimer({
      intervalMs: () => ctx.config().schedules.eventLogPollSec * 1000,
      run: () => this.serialized(() => this.tick()),
      onError: (err) => {
        this.lastError = errorMessage(err);
        this.log?.warn(`Ereignisprotokoll: Abfrage fehlgeschlagen (${this.lastError})`);
      },
    });
    if (this.deps.autoStart !== false) this.timer.start(2000);
  }

  start(): void {
    this.timer?.trigger(1000);
  }

  reconfigure(cfg: AppConfig): void {
    this.internet.setTargets(cfg);
  }

  async runNow(params?: Record<string, unknown>): Promise<ImportSummary> {
    const ctx = this.ctx;
    if (!ctx) throw new Error('Modul eventlog ist nicht initialisiert');
    const raw = Number(params?.days ?? ctx.config().eventLog.importDays);
    const days = Number.isFinite(raw) ? Math.min(3650, Math.max(0, Math.round(raw))) : ctx.config().eventLog.importDays;
    return this.serialized(() => this.importHistory(days));
  }

  dispose(): void {
    this.timer?.stop();
    this.runner?.killAll();
    for (const off of this.unsubs) off();
    this.unsubs = [];
    for (const wake of this.adaptersWaiters.splice(0)) wake();
  }

  state(): ModuleState {
    const s = timersState(this.name, true, this.timer ? [this.timer] : [], this.lastError);
    return { ...s, busy: s.busy || this.importing };
  }

  // ─── internals ───────────────────────────────────────────────────────────

  private serialized<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(fn, fn);
    this.chain = p.catch(() => undefined);
    return p;
  }

  private onAdapters(snap: AdapterSnapshot): void {
    const guids = wiredGuidsOf(snap.adapters);
    if (guids.length) this.wiredGuids = guids;
    this.adaptersSeen = true;
    for (const wake of this.adaptersWaiters.splice(0)) wake();
  }

  private waitForAdapters(timeoutMs: number): Promise<void> {
    if (this.adaptersSeen || this.wiredGuids.length > 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      timer.unref();
      this.adaptersWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private onNic(t: NicTick): void {
    const prev = this.nicUp.get(t.name);
    this.nicUp.set(t.name, t.up);
    // link just went down/up: fetch the exact driver events soon
    if (prev !== undefined && prev !== t.up && !t.isWifi) this.timer?.trigger(8000);
  }

  /** one poll cycle (import on first start, then incremental); public for tests */
  async tick(): Promise<void> {
    const ctx = this.ctx;
    if (!ctx) return;
    if (!this.cursors.has(LOG_SYSTEM)) {
      if (this.deps.autoStart !== false) await this.waitForAdapters(ADAPTERS_WAIT_MS);
      const summary = await this.importHistory(ctx.config().eventLog.importDays);
      this.log?.info(
        `Ereignisprotokoll importiert: ${summary.scanned} Einträge, ${summary.inserted} neue Ereignisse, Link-Abbrüche ${JSON.stringify(summary.linkDowns)} (${summary.durationMs} ms)`,
      );
      return;
    }
    if (!this.warmedUp) await this.warmUp();
    await this.poll();
  }

  private analyze(events: readonly WinEvent[], now: number): Map<string, LinkDropAnalysis> {
    const map = new Map<string, LinkDropAnalysis>();
    const res = analyzeLinkDrops(events, {
      now,
      wlanLogAvailable: !this.missingUntil.has(LOG_WLAN),
      internetRecovery: (ts) => this.internet.recovery(ts),
      wiredGuids: this.wiredGuids,
    });
    for (const a of res) map.set(eventDedupeKey(a.down), a);
    return map;
  }

  private record(e: NetEvent, now: number): number | null {
    const ctx = this.ctx;
    if (!ctx) return null;
    if (now - e.ts > HISTORY_AGE_MS) {
      try {
        return ctx.db.insertEvent(e);
      } catch (err) {
        this.log?.error(`Ereignis „${e.title}“ konnte nicht gespeichert werden`, err);
        return null;
      }
    }
    return ctx.recordEvent(e);
  }

  /** Records one event (link-downs from their analysis). Returns true when a new row was written. */
  private recordWinEvent(e: WinEvent, analyses: Map<string, LinkDropAnalysis>, now: number): boolean {
    const key = eventDedupeKey(e);
    if (linkKindOf(e)?.kind === 'down') {
      const a = analyses.get(key);
      if (!a) return false;
      const ev = linkDownEvent(a);
      const id = this.record(ev, now);
      if (id !== null && !a.final) {
        this.open.set(key, { id, ts: e.ts, sig: JSON.stringify(linkDownPatch(a)) });
        this.saveOpen();
      }
      return id !== null;
    }
    const ev = winEventToNetEvent(e);
    return ev ? this.record(ev, now) !== null : false;
  }

  private addToWindow(events: readonly WinEvent[]): void {
    let added = false;
    for (const e of events) {
      const key = eventDedupeKey(e);
      if (this.windowKeys.has(key)) continue;
      this.windowKeys.add(key);
      this.window.push(e);
      added = true;
    }
    if (added) this.window.sort(byTime);
  }

  private pruneWindow(now: number): void {
    let keepFrom = now - WINDOW_MS;
    for (const o of this.open.values()) keepFrom = Math.min(keepFrom, o.ts - 15 * 60_000);
    if (this.window.length === 0 || this.window[0].ts >= keepFrom) return;
    const kept: WinEvent[] = [];
    for (const e of this.window) {
      if (e.ts >= keepFrom) kept.push(e);
      else {
        const key = eventDedupeKey(e);
        this.windowKeys.delete(key);
        this.processed.delete(key);
      }
    }
    this.window = kept;
  }

  private setCursor(log: string, value: number): void {
    const cur = this.cursors.get(log) ?? 0;
    if (value <= cur) return;
    this.cursors.set(log, value);
    this.ctx?.db.setSetting(cursorKey(log), String(value));
  }

  private saveOpen(): void {
    const list = [...this.open.entries()].map(([key, o]) => ({ key, ...o }));
    this.ctx?.db.setSetting(OPEN_SETTING, list.length ? JSON.stringify(list) : null);
  }

  private markMissing(log: string, error: string): void {
    if (!this.missingUntil.has(log)) this.log?.info(`Ereignisprotokoll „${log}“ nicht verfügbar – neuer Versuch in 30 min (${error})`);
    this.missingUntil.set(log, this.now() + MISSING_RETRY_MS);
  }

  private logAvailable(log: string, now: number): boolean {
    const until = this.missingUntil.get(log);
    if (until === undefined) return true;
    if (now < until) return false;
    this.missingUntil.delete(log);
    return true;
  }

  /** Loads the recent context (and everything needed by open link drops) after a restart. */
  private async warmUp(): Promise<void> {
    const runner = this.runner;
    if (!runner) return;
    const now = this.now();
    let age = WINDOW_MS;
    for (const o of this.open.values()) age = Math.max(age, now - o.ts + 30 * 60_000);
    age = Math.min(age, MAX_WARMUP_MS);
    for (const log of EVENT_LOGS) {
      if (!this.logAvailable(log, now)) continue;
      const r = await fetchEvents(runner, log, { maxAgeMs: age });
      if (!r.ok) {
        if (r.missing) this.markMissing(log, r.error);
        continue;
      }
      const cursor = this.cursors.get(log) ?? 0;
      this.addToWindow(r.events);
      for (const e of r.events) if (e.recordId <= cursor) this.processed.add(eventDedupeKey(e));
    }
    this.warmedUp = true;
  }

  private async poll(): Promise<void> {
    const runner = this.runner;
    const ctx = this.ctx;
    if (!runner || !ctx) return;
    const now = this.now();
    const fresh: WinEvent[] = [];
    const errors: string[] = [];
    for (const log of EVENT_LOGS) {
      if (!this.logAvailable(log, now)) continue;
      const cursor = this.cursors.get(log) ?? 0;
      const r = await fetchEvents(runner, log, { afterRecordId: cursor });
      if (!r.ok) {
        if (r.missing) this.markMissing(log, r.error);
        else errors.push(r.error);
        continue;
      }
      if (r.events.length === 0) {
        const n = (this.emptyPolls.get(log) ?? 0) + 1;
        this.emptyPolls.set(log, n);
        if (n % CLEAR_CHECK_EVERY === 0 && cursor > 0) {
          const newest = await newestRecordId(runner, log);
          if (newest !== null && newest < cursor) {
            this.log?.warn(`Ereignisprotokoll „${log}“ wurde geleert – Lesezeiger wird zurückgesetzt`);
            this.cursors.set(log, newest);
            ctx.db.setSetting(cursorKey(log), String(newest));
          }
        }
        continue;
      }
      this.emptyPolls.set(log, 0);
      fresh.push(...r.events);
      this.setCursor(log, Math.max(...r.events.map((e) => e.recordId)));
    }
    this.lastError = errors.length ? errors.join('; ') : null;

    this.addToWindow(fresh);
    const analyses = this.analyze(this.window, now);
    for (const e of [...fresh].sort(byTime)) {
      const key = eventDedupeKey(e);
      if (this.processed.has(key)) continue;
      this.processed.add(key);
      this.recordWinEvent(e, analyses, now);
    }
    this.updateOpen(analyses, now);
    this.pruneWindow(now);
  }

  /** Re-evaluates provisional link drops; writes changes; drops final ones from the open list. */
  private updateOpen(analyses: Map<string, LinkDropAnalysis>, now: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    let changed = false;
    for (const [key, o] of [...this.open.entries()]) {
      const a = analyses.get(key);
      if (!a) {
        if (now - o.ts > LINK_RULES.finalAfterMs + MAX_WARMUP_MS) {
          this.open.delete(key);
          changed = true;
        }
        continue;
      }
      const patch = linkDownPatch(a);
      const sig = JSON.stringify(patch);
      if (sig !== o.sig) {
        ctx.updateEvent(o.id, patch);
        o.sig = sig;
        changed = true;
      }
      if (a.final) {
        this.open.delete(key);
        changed = true;
      }
    }
    if (changed) this.saveOpen();
  }

  /** History import (first start or manual `eventlog.import`). Idempotent via dedupe keys. */
  private async importHistory(days: number): Promise<ImportSummary> {
    const runner = this.runner;
    const ctx = this.ctx;
    const t0 = this.now();
    const summary: ImportSummary = { days, scanned: 0, inserted: 0, linkDowns: { boot: 0, pre_sleep: 0, router_reboot: 0, runtime: 0 }, durationMs: 0, errors: [] };
    if (!runner || !ctx) return summary;
    this.importing = true;
    try {
      const all: WinEvent[] = [];
      const maxPerLog = new Map<string, number>();
      for (const log of EVENT_LOGS) {
        if (days <= 0) break;
        const r = await fetchEvents(runner, log, { maxAgeMs: days * 86_400_000 });
        if (!r.ok) {
          if (r.missing) this.markMissing(log, r.error);
          else summary.errors.push(r.error);
          continue;
        }
        this.missingUntil.delete(log);
        all.push(...r.events);
        if (r.events.length) maxPerLog.set(log, Math.max(...r.events.map((e) => e.recordId)));
      }
      all.sort(byTime);
      summary.scanned = all.length;
      const now = this.now();
      const analyses = this.analyze(all, now);
      summary.linkDowns = countCauses([...analyses.values()]);
      for (let i = 0; i < all.length; i++) {
        const e = all[i];
        if (this.recordWinEvent(e, analyses, now)) summary.inserted++;
        this.processed.add(eventDedupeKey(e));
        if (i % INSERT_CHUNK === INSERT_CHUNK - 1) await yieldToLoop();
      }
      this.updateOpen(analyses, now);
      // cursors: newest imported record, or the log's newest record when nothing matched
      for (const log of EVENT_LOGS) {
        if (this.missingUntil.has(log)) continue;
        const max = maxPerLog.get(log);
        const value = max ?? (await newestRecordId(runner, log));
        if (value !== null && value !== undefined) {
          if (!this.cursors.has(log)) {
            this.cursors.set(log, value);
            ctx.db.setSetting(cursorKey(log), String(value));
          } else this.setCursor(log, value);
        }
      }
      if (!this.cursors.has(LOG_SYSTEM)) {
        // System log unreadable: remember the attempt so we do not re-import every minute
        this.cursors.set(LOG_SYSTEM, 0);
      }
      this.addToWindow(all.filter((e) => e.ts >= now - WINDOW_MS));
      this.pruneWindow(now);
      this.warmedUp = true;
      ctx.db.setSetting(IMPORT_SETTING, String(now));
      return summary;
    } finally {
      this.importing = false;
      summary.durationMs = this.now() - t0;
    }
  }
}

export function createEventLogModule(deps: EventLogDeps = {}): EngineModule {
  return new EventLogModule(deps);
}
