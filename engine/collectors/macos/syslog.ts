// macOS "Systemprotokoll" module (registry name 'eventlog', docs/research/macos.md §5). macOS has no
// event log with stable IDs, so synthetic WinEvents feed the unchanged link-drop classification of
// parsers/winevent.ts:
//  - power markers from `pmset -g log` (history import, then re-read when `sysctl kern.boottime/
//    sleeptime/waketime` changed or every 30 min); sysctl alone when pmset is unavailable
//  - link down/up of wired adapters observed by the engine itself: NIC ticks (1 Hz, session) and
//    adapter snapshots (idle polls); NIC ticks win while they are fresh, so one transition is never
//    recorded twice
//  - WLAN connect/disconnect events of the wlan module as classification context (not stored again)
//  - history import of kernel "Link up/down on enX" messages from the unified log, only for the time
//    before the engine observed links itself (setting 'eventlog.macos.liveSince')
// Live link events are kept in setting 'eventlog.macos.recent' so open link drops can still be
// re-evaluated after an engine restart (they exist in no macOS log).
// NOTE: eventlog.ts imports this file – its exports are only used inside methods (import cycle).
import type { AppConfig } from '../../../src/lib/shared/config';
import { pmsetPowerEntries, type PmsetEntry, type PmsetKind } from '../../../src/lib/shared/parsers/macos/pmset';
import { type KernTimes, parseKernTimes } from '../../../src/lib/shared/parsers/macos/sysctl';
import { type KernelLinkEvent, parseKernelLinkEvents } from '../../../src/lib/shared/parsers/macos/unified-log';
import {
  LINK_RULES,
  LOG_WLAN,
  MAC_LINK_DOWN_ID,
  MAC_LINK_PROVIDER,
  MAC_POWER_ID,
  MAC_POWER_PROVIDER,
  analyzeLinkDrops,
  byTime,
  eventDedupeKey,
  linkDownEvent,
  linkDownPatch,
  linkKindOf,
  macEvent,
  macLinkUpId,
  macRecordId,
  winEventToNetEvent,
  type LinkDropAnalysis,
  type WinEvent,
} from '../../../src/lib/shared/parsers/winevent';
import type { AdapterInfo, AdapterSnapshot, ModuleState, NetEvent } from '../../../src/lib/shared/types';
import type { EngineContext, EngineModule, Logger, NicTick } from '../../core/types';
import { isConnected } from '../adapter';
import { IMPORT_SETTING, InternetTracker, OPEN_SETTING, countCauses, parseOpen, type ImportSummary, type OpenDown } from '../eventlog';
import { PollTimer, ProcessRunner, childTracker, errorMessage, isRecord, timersState } from '../util';
import { MacInterfaceCatalog } from './interfaces';
import { type ToolRunner, runTool, toolText } from './tools';

export const PMSET_CURSOR_KEY = 'eventlog.macos.pmsetCursor';
export const LIVE_SINCE_KEY = 'eventlog.macos.liveSince';
export const KERN_TIMES_KEY = 'eventlog.macos.kernTimes';
export const RECENT_KEY = 'eventlog.macos.recent';

/** recent context kept in memory for the classification of new link drops */
const WINDOW_MS = 2 * 3600_000;
const MAX_WARMUP_MS = 7 * 86_400_000;
/** events older than this are stored without live publication (history import) */
const HISTORY_AGE_MS = 3600_000;
const INSERT_CHUNK = 200;
const PMSET_MAX_AGE_MS = 30 * 60_000;
/** adapter snapshots are ignored for an adapter while its NIC ticks are this fresh */
const NIC_PRIORITY_MS = 5000;
const MAX_RECENT = 400;
const ADAPTERS_WAIT_MS = 15_000;
const SYSCTL_TIMEOUT_MS = 5000;
const PMSET_TIMEOUT_MS = 60_000;
const LOG_SHOW_TIMEOUT_MS = 180_000;
/** unified log query of the history import (kernel link messages of Ethernet drivers) */
export const LINK_LOG_PREDICATE = 'process == "kernel" AND (eventMessage CONTAINS[c] "Link up" OR eventMessage CONTAINS[c] "Link down")';
const WLAN_PROVIDER = 'Microsoft-Windows-WLAN-AutoConfig';

const POWER_IDS: Record<PmsetKind, number> = {
  start: MAC_POWER_ID.boot,
  sleep: MAC_POWER_ID.sleep,
  wake: MAC_POWER_ID.wake,
  darkwake: MAC_POWER_ID.darkWake,
  shutdown: MAC_POWER_ID.shutdown,
};

const yieldToLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

// ─── pure conversions ──────────────────────────────────────────────────────

/** Next seq (0–9) for events with the same (provider, id, ts) in the order of `events`. */
function withSeq<T>(items: readonly T[], key: (x: T) => string): { item: T; seq: number }[] {
  const counts = new Map<string, number>();
  return items.map((item) => {
    const k = key(item);
    const seq = counts.get(k) ?? 0;
    counts.set(k, seq + 1);
    return { item, seq };
  });
}

/** pmset power entries → macos-power WinEvents (deterministic ids: re-reads give the same keys). */
export function pmsetEvents(entries: readonly PmsetEntry[]): WinEvent[] {
  const power = entries.filter((e): e is PmsetEntry & { kind: PmsetKind } => e.kind !== null);
  return withSeq(power, (e) => `${e.ts}:${e.kind}`).map(({ item: e, seq }) =>
    macEvent(
      MAC_POWER_PROVIDER,
      POWER_IDS[e.kind],
      e.ts,
      { Reason: e.message.slice(0, 200), Source: 'pmset', ...(e.maintenance ? { Maintenance: '1' } : {}) },
      seq,
    ),
  );
}

/** Power events derived from changed sysctl values (fallback without pmset). */
export function sysctlEvents(prev: KernTimes | null, cur: KernTimes): WinEvent[] {
  const out: WinEvent[] = [];
  const add = (id: number, ts: number | null) => {
    if (ts !== null) out.push(macEvent(MAC_POWER_PROVIDER, id, ts, { Source: 'sysctl' }));
  };
  if (cur.boot !== null && cur.boot !== prev?.boot) add(MAC_POWER_ID.boot, cur.boot);
  if (prev && cur.sleep !== null && cur.sleep !== prev.sleep) add(MAC_POWER_ID.sleep, cur.sleep);
  if (prev && cur.wake !== null && cur.wake !== prev.wake) add(MAC_POWER_ID.wake, cur.wake);
  return out.sort(byTime);
}

export interface DeviceInfo {
  name: string;
  isWifi: boolean;
}

/**
 * Kernel link messages (unified log) → macos-link WinEvents of wired adapters, only before
 * `before` (the start of the engine's own observation). Unknown devices keep their BSD name.
 */
export function unifiedLogLinkEvents(list: readonly KernelLinkEvent[], devices: ReadonlyMap<string, DeviceInfo>, before: number | null): WinEvent[] {
  const wired = list.filter((l) => (before === null || l.ts < before) && devices.get(l.device)?.isWifi !== true);
  return withSeq(wired, (l) => `${l.ts}:${l.up ? macLinkUpId(l.mbps, l.duplex) : MAC_LINK_DOWN_ID}`).map(({ item: l, seq }) => {
    const data: Record<string, string> = { p0: devices.get(l.device)?.name ?? l.device, Device: l.device, Source: 'unifiedlog' };
    if (!l.up) return macEvent(MAC_LINK_PROVIDER, MAC_LINK_DOWN_ID, l.ts, data, seq);
    if (l.mbps !== null) data.Mbps = String(l.mbps);
    if (l.duplex !== null) data.Duplex = l.duplex;
    return macEvent(MAC_LINK_PROVIDER, macLinkUpId(l.mbps, l.duplex), l.ts, data, seq);
  });
}

/** WinEvent-shaped JSON from the 'recent' setting (invalid entries dropped). */
export function parseRecent(json: string | null): WinEvent[] {
  if (!json) return [];
  try {
    const v: unknown = JSON.parse(json);
    if (!Array.isArray(v)) return [];
    const out: WinEvent[] = [];
    for (const x of v) {
      if (!isRecord(x) || typeof x.log !== 'string' || typeof x.provider !== 'string') continue;
      if (typeof x.id !== 'number' || typeof x.recordId !== 'number' || typeof x.ts !== 'number' || !isRecord(x.data)) continue;
      const data: Record<string, string> = {};
      for (const [k, val] of Object.entries(x.data)) if (typeof val === 'string') data[k] = val;
      out.push({ log: x.log, provider: x.provider, id: x.id, recordId: x.recordId, ts: x.ts, level: typeof x.level === 'number' ? x.level : null, data });
    }
    return out;
  } catch {
    return [];
  }
}

function parseKernSetting(json: string | null): KernTimes | null {
  if (!json) return null;
  try {
    const v: unknown = JSON.parse(json);
    if (!isRecord(v)) return null;
    const n = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
    return { boot: n(v.boot), sleep: n(v.sleep), wake: n(v.wake) };
  } catch {
    return null;
  }
}

const sameKern = (a: KernTimes | null, b: KernTimes) => a !== null && a.boot === b.boot && a.sleep === b.sleep && a.wake === b.wake;

// ─── module ────────────────────────────────────────────────────────────────

export interface MacSystemLogDeps {
  /** replaces the tool runner (tests) */
  runner?: ToolRunner & Pick<ProcessRunner, 'killAll'>;
  /** clock (tests) */
  now?: () => number;
  /** start the poll timer in init() (default true) */
  autoStart?: boolean;
}

interface LinkState {
  up: boolean;
  /** this.now() of the last NIC tick for the adapter (0 = none) */
  nicAt: number;
}

export class MacSystemLogModule implements EngineModule {
  readonly name = 'eventlog';
  private ctx: EngineContext | null = null;
  private log: Logger | null = null;
  private runner: (ToolRunner & Pick<ProcessRunner, 'killAll'>) | null = null;
  private timer: PollTimer | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private open = new Map<string, OpenDown>();
  private window: WinEvent[] = [];
  private readonly windowKeys = new Set<string>();
  private readonly processed = new Set<string>();
  /** WLAN context records: classification only, never stored */
  private readonly contextKeys = new Set<string>();
  private pending: WinEvent[] = [];
  private readonly links = new Map<string, LinkState>();
  private readonly internet = new InternetTracker();
  private unsubs: (() => void)[] = [];
  private adapters: AdapterInfo[] = [];
  private adaptersSeen = false;
  private adaptersWaiters: (() => void)[] = [];
  private hasWifi = false;
  private kern: KernTimes | null = null;
  private pmsetReadAt = 0;
  private warmedUp = false;
  private importing = false;
  private lastError: string | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: MacSystemLogDeps = {}) {
    this.now = deps.now ?? Date.now;
  }

  init(ctx: EngineContext): void {
    this.ctx = ctx;
    this.log = ctx.log;
    this.runner = this.deps.runner ?? new ProcessRunner(childTracker(ctx));
    this.open = parseOpen(ctx.db.getSetting(OPEN_SETTING));
    this.kern = parseKernSetting(ctx.db.getSetting(KERN_TIMES_KEY));
    if (ctx.db.getSetting(LIVE_SINCE_KEY) === null) ctx.db.setSetting(LIVE_SINCE_KEY, String(this.now()));
    // live link/WLAN records of the last hours: already stored – context for open link drops
    for (const e of parseRecent(ctx.db.getSetting(RECENT_KEY))) {
      const key = eventDedupeKey(e);
      this.processed.add(key);
      if (e.provider === WLAN_PROVIDER) this.contextKeys.add(key);
      this.addToWindow([e]);
    }
    try {
      const snap = ctx.db.latestSnapshot<AdapterSnapshot>('adapters')?.data;
      if (snap && Array.isArray(snap.adapters)) {
        this.adapters = snap.adapters;
        this.hasWifi = snap.adapters.some((a) => a.isWifi && !a.isVirtual);
      }
    } catch {
      /* no snapshot yet */
    }
    this.internet.setTargets(ctx.config());
    this.unsubs.push(
      ctx.bus.on('sample', (s) => this.internet.onSample(s, this.now())),
      ctx.bus.on('config', (cfg) => this.internet.setTargets(cfg)),
      ctx.bus.on('nic', (t) => this.onNic(t)),
      ctx.bus.on('adapters', (snap) => this.onAdapters(snap)),
      ctx.bus.on('event', (e) => this.onEvent(e)),
    );
    this.timer = new PollTimer({
      intervalMs: () => ctx.config().schedules.eventLogPollSec * 1000,
      run: () => this.serialized(() => this.tick()),
      onError: (err) => {
        this.lastError = errorMessage(err);
        this.log?.warn(`Systemprotokoll: Abfrage fehlgeschlagen (${this.lastError})`);
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

  /** one poll cycle (history import on first start, then power + live link events); public for tests */
  async tick(): Promise<void> {
    const ctx = this.ctx;
    if (!ctx) return;
    const errors: string[] = [];
    if (ctx.db.getSetting(IMPORT_SETTING) === null) {
      if (this.deps.autoStart !== false) await this.waitForAdapters(ADAPTERS_WAIT_MS);
      const summary = await this.importHistory(ctx.config().eventLog.importDays);
      errors.push(...summary.errors);
      this.log?.info(
        `Systemprotokoll importiert: ${summary.scanned} Einträge, ${summary.inserted} neue Ereignisse, Link-Abbrüche ${JSON.stringify(summary.linkDowns)} (${summary.durationMs} ms)`,
      );
    }
    const now = this.now();
    const fresh = await this.pollPower(now, errors);
    fresh.push(...this.pending.splice(0));
    this.lastError = errors.length ? [...new Set(errors)].join('; ') : null;
    this.addToWindow(fresh);
    const analyses = this.analyze(this.window, now);
    for (const e of [...fresh].sort(byTime)) {
      const key = eventDedupeKey(e);
      if (this.processed.has(key)) continue;
      this.processed.add(key);
      if (this.contextKeys.has(key)) continue;
      this.recordWinEvent(e, analyses, now);
    }
    this.updateOpen(analyses, now);
    this.pruneWindow(now);
    this.saveRecent(now);
  }

  private serialized<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(fn, fn);
    this.chain = p.catch(() => undefined);
    return p;
  }

  // ─── live observation ────────────────────────────────────────────────────

  private onNic(t: NicTick): void {
    if (t.isWifi) return;
    const st = this.links.get(t.name);
    if (!st) {
      this.links.set(t.name, { up: t.up, nicAt: this.now() });
      return;
    }
    st.nicAt = this.now();
    if (st.up === t.up) return;
    st.up = t.up;
    this.queueLink(t.name, t.up, t.ts, t.mbps, 'nic', null);
  }

  private onAdapters(snap: AdapterSnapshot): void {
    this.adapters = snap.adapters;
    this.hasWifi = snap.adapters.some((a) => a.isWifi && !a.isVirtual);
    this.adaptersSeen = true;
    for (const wake of this.adaptersWaiters.splice(0)) wake();
    const now = this.now();
    const present = new Set<string>();
    for (const a of snap.adapters) {
      if (a.isWifi || a.isVirtual) continue;
      present.add(a.name);
      this.observeAdapter(a.name, isConnected(a), snap.ts, now, a.linkMbps, deviceOf(a));
    }
    // an unplugged USB/Thunderbolt adapter vanishes from the list – that is a link loss as well
    for (const name of this.links.keys()) {
      if (!present.has(name)) this.observeAdapter(name, false, snap.ts, now, null, null);
    }
  }

  private observeAdapter(name: string, up: boolean, ts: number, now: number, mbps: number | null, device: string | null): void {
    const st = this.links.get(name);
    if (!st) {
      this.links.set(name, { up, nicAt: 0 });
      return;
    }
    // the 1 Hz NIC ticks of a running session are more precise – they own the state meanwhile
    if (st.nicAt > 0 && now - st.nicAt < NIC_PRIORITY_MS) return;
    if (st.up === up) return;
    st.up = up;
    this.queueLink(name, up, ts, up ? mbps : null, 'adapter', device);
  }

  private onEvent(e: NetEvent): void {
    if (e.source !== 'wlan' || (e.type !== 'wlan_connect' && e.type !== 'wlan_disconnect')) return;
    const id = e.type === 'wlan_connect' ? 8001 : 8003;
    const ssid = isRecord(e.details) && typeof e.details.ssid === 'string' ? e.details.ssid : '';
    const ev: WinEvent = { log: LOG_WLAN, provider: WLAN_PROVIDER, id, recordId: this.freeRecordId(LOG_WLAN, e.ts, id), ts: e.ts, level: 4, data: { SSID: ssid } };
    this.contextKeys.add(eventDedupeKey(ev));
    this.pending.push(ev);
  }

  private queueLink(name: string, up: boolean, ts: number, mbps: number | null, source: 'nic' | 'adapter', device: string | null): void {
    const id = up ? macLinkUpId(mbps, null) : MAC_LINK_DOWN_ID;
    const data: Record<string, string> = { p0: name, Source: source };
    if (device) data.Device = device;
    if (up && mbps !== null) data.Mbps = String(mbps);
    this.pending.push({ log: MAC_LINK_PROVIDER, provider: MAC_LINK_PROVIDER, id, recordId: this.freeRecordId(MAC_LINK_PROVIDER, ts, id), ts, level: 4, data });
    // a fresh link drop should show up within seconds (provisional, updated later)
    this.timer?.trigger(1500);
  }

  /** record id not used yet by the window or the queue (several adapters in the same ms) */
  private freeRecordId(log: string, ts: number, id: number): number {
    const used = new Set([...this.windowKeys, ...this.pending.map(eventDedupeKey)]);
    for (let seq = 0; seq < 10; seq++) {
      const rid = macRecordId(ts, id, seq);
      if (!used.has(`evtlog:${log}:${rid}`)) return rid;
    }
    return macRecordId(ts, id, 9);
  }

  private waitForAdapters(timeoutMs: number): Promise<void> {
    if (this.adaptersSeen || this.adapters.length > 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      timer.unref();
      this.adaptersWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  // ─── power markers ───────────────────────────────────────────────────────

  private async readKern(): Promise<KernTimes> {
    const runner = this.runner;
    if (!runner) throw new Error('nicht initialisiert');
    const r = await runTool(runner, 'sysctl', ['kern.boottime', 'kern.sleeptime', 'kern.waketime'], { timeoutMs: SYSCTL_TIMEOUT_MS, maxBytes: 64 * 1024 });
    // an unknown name makes sysctl exit 1 while the other values are printed
    return parseKernTimes(toolText(r, 'sysctl', [0, 1]));
  }

  private async readPmset(): Promise<WinEvent[]> {
    const runner = this.runner;
    if (!runner) throw new Error('nicht initialisiert');
    const r = await runTool(runner, 'pmset', ['-g', 'log'], { timeoutMs: PMSET_TIMEOUT_MS, maxBytes: 128 * 1024 * 1024 });
    const text = toolText(r, 'pmset');
    await yieldToLoop();
    return pmsetEvents(pmsetPowerEntries(text));
  }

  /** New power events since the cursor (re-reads pmset only when sysctl changed or every 30 min). */
  private async pollPower(now: number, errors: string[]): Promise<WinEvent[]> {
    const ctx = this.ctx;
    if (!ctx) return [];
    let kern: KernTimes | null = null;
    try {
      kern = await this.readKern();
    } catch (err) {
      errors.push(errorMessage(err));
    }
    const changed = kern !== null && !sameKern(this.kern, kern);
    if (!this.warmedUp || changed || now - this.pmsetReadAt >= PMSET_MAX_AGE_MS) {
      try {
        const events = await this.readPmset();
        this.pmsetReadAt = now;
        const cursor = Number(ctx.db.getSetting(PMSET_CURSOR_KEY) ?? 0) || 0;
        let warmFrom = now - WINDOW_MS;
        for (const o of this.open.values()) warmFrom = Math.min(warmFrom, o.ts - 30 * 60_000);
        warmFrom = Math.max(warmFrom, now - MAX_WARMUP_MS);
        const fresh: WinEvent[] = [];
        for (const e of events) {
          if (e.ts < cursor) {
            // already recorded – only context for the classification after a restart
            if (!this.warmedUp && e.ts >= warmFrom) {
              this.processed.add(eventDedupeKey(e));
              this.addToWindow([e]);
            }
            continue;
          }
          fresh.push(e);
        }
        this.warmedUp = true;
        const max = Math.max(cursor, ...events.map((e) => e.ts));
        if (max > cursor) ctx.db.setSetting(PMSET_CURSOR_KEY, String(max));
        this.saveKern(kern);
        return fresh;
      } catch (err) {
        errors.push(errorMessage(err));
      }
    }
    // only reached without pmset data: when sysctl changed, pmset was tried and failed → sysctl is the source
    const fallback = kern !== null && changed ? sysctlEvents(this.kern, kern) : [];
    this.warmedUp = true;
    this.saveKern(kern);
    return fallback;
  }

  private saveKern(kern: KernTimes | null): void {
    if (!kern || sameKern(this.kern, kern)) return;
    this.kern = kern;
    this.ctx?.db.setSetting(KERN_TIMES_KEY, JSON.stringify(kern));
  }

  // ─── analysis / recording (same rules as the Windows module) ─────────────

  private analyze(events: readonly WinEvent[], now: number): Map<string, LinkDropAnalysis> {
    const map = new Map<string, LinkDropAnalysis>();
    const res = analyzeLinkDrops(events, {
      now,
      wlanLogAvailable: this.hasWifi,
      internetRecovery: (ts) => this.internet.recovery(ts),
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

  private recordWinEvent(e: WinEvent, analyses: Map<string, LinkDropAnalysis>, now: number): boolean {
    const key = eventDedupeKey(e);
    if (linkKindOf(e)?.kind === 'down') {
      const a = analyses.get(key);
      if (!a) return false;
      const id = this.record(linkDownEvent(a), now);
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
        this.contextKeys.delete(key);
      }
    }
    this.window = kept;
  }

  private saveOpen(): void {
    const list = [...this.open.entries()].map(([key, o]) => ({ key, ...o }));
    this.ctx?.db.setSetting(OPEN_SETTING, list.length ? JSON.stringify(list) : null);
  }

  /** live link + WLAN context records of the window (they exist in no macOS log) */
  private saveRecent(now: number): void {
    const keep = this.window.filter((e) => (e.provider === WLAN_PROVIDER || (e.provider === MAC_LINK_PROVIDER && e.data.Source !== 'unifiedlog')) && e.ts >= now - MAX_WARMUP_MS);
    const json = keep.length ? JSON.stringify(keep.slice(-MAX_RECENT)) : null;
    const ctx = this.ctx;
    if (ctx && ctx.db.getSetting(RECENT_KEY) !== json) ctx.db.setSetting(RECENT_KEY, json);
  }

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

  // ─── history import ──────────────────────────────────────────────────────

  private async deviceMap(): Promise<Map<string, DeviceInfo>> {
    const map = new Map<string, DeviceInfo>();
    for (const a of this.adapters) {
      const dev = deviceOf(a);
      if (dev) map.set(dev, { name: a.name, isWifi: a.isWifi });
    }
    if (map.size > 0 || !this.runner) return map;
    try {
      for (const i of await new MacInterfaceCatalog(this.runner).read({ counters: false })) map.set(i.device, { name: i.name, isWifi: i.isWifi });
    } catch {
      /* BSD names are used as they are */
    }
    return map;
  }

  private async readLinkHistory(days: number): Promise<WinEvent[]> {
    const runner = this.runner;
    const ctx = this.ctx;
    if (!runner || !ctx || days <= 0) return [];
    const r = await runTool(runner, 'log', ['show', '--style', 'ndjson', '--last', `${days}d`, '--predicate', LINK_LOG_PREDICATE], {
      timeoutMs: LOG_SHOW_TIMEOUT_MS,
      maxBytes: 256 * 1024 * 1024,
    });
    const text = toolText(r, 'log show');
    await yieldToLoop();
    const liveSince = Number(ctx.db.getSetting(LIVE_SINCE_KEY) ?? 0) || null;
    return unifiedLogLinkEvents(parseKernelLinkEvents(text), await this.deviceMap(), liveSince);
  }

  /** History import (first start or manual `eventlog.import`). Idempotent via dedupe keys. */
  private async importHistory(days: number): Promise<ImportSummary> {
    const ctx = this.ctx;
    const t0 = this.now();
    const summary: ImportSummary = { days, scanned: 0, inserted: 0, linkDowns: { boot: 0, pre_sleep: 0, router_reboot: 0, runtime: 0 }, durationMs: 0, errors: [] };
    if (!ctx) return summary;
    this.importing = true;
    try {
      const all: WinEvent[] = [];
      const since = t0 - days * 86_400_000;
      try {
        // baseline for the change detection (no second pmset read right after the import)
        this.saveKern(await this.readKern());
      } catch {
        /* the next poll reports the sysctl error */
      }
      if (days > 0) {
        try {
          const power = await this.readPmset();
          this.pmsetReadAt = t0;
          all.push(...power.filter((e) => e.ts >= since));
          const max = Math.max(Number(ctx.db.getSetting(PMSET_CURSOR_KEY) ?? 0) || 0, ...power.map((e) => e.ts));
          if (max > 0) ctx.db.setSetting(PMSET_CURSOR_KEY, String(max));
        } catch (err) {
          summary.errors.push(errorMessage(err));
        }
        try {
          all.push(...(await this.readLinkHistory(days)).filter((e) => e.ts >= since));
        } catch (err) {
          summary.errors.push(`Link-Historie: ${errorMessage(err)}`);
        }
      } else if (ctx.db.getSetting(PMSET_CURSOR_KEY) === null) {
        // no import wanted: start at "now" so the next poll does not import the whole pmset log
        ctx.db.setSetting(PMSET_CURSOR_KEY, String(t0));
      }
      // live records stay in the analysis (open drops), history is added around them (no duplicates)
      const byKey = new Map<string, WinEvent>();
      for (const e of [...this.window, ...all]) byKey.set(eventDedupeKey(e), e);
      const combined = [...byKey.values()].sort(byTime);
      summary.scanned = all.length;
      const now = this.now();
      const analyses = this.analyze(combined, now);
      const keys = new Set(all.map(eventDedupeKey));
      summary.linkDowns = countCauses([...analyses.values()].filter((a) => keys.has(eventDedupeKey(a.down))));
      for (let i = 0; i < all.length; i++) {
        const e = all[i];
        if (this.recordWinEvent(e, analyses, now)) summary.inserted++;
        this.processed.add(eventDedupeKey(e));
        if (i % INSERT_CHUNK === INSERT_CHUNK - 1) await yieldToLoop();
      }
      this.updateOpen(analyses, now);
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

/** BSD name of an adapter (AdapterInfoExt.device written by the macOS adapter source). */
function deviceOf(a: AdapterInfo): string | null {
  const d = (a as AdapterInfo & { device?: unknown }).device;
  return typeof d === 'string' && d !== '' ? d : null;
}

export function createMacSystemLogModule(deps: MacSystemLogDeps = {}): EngineModule {
  return new MacSystemLogModule(deps);
}
