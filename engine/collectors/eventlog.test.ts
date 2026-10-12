import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, mergeConfig } from '../../src/lib/shared/config';
import { LOG_NCSI, LOG_SYSTEM, LOG_WLAN } from '../../src/lib/shared/parsers/winevent';
import type { NetEvent, Sample } from '../../src/lib/shared/types';
import type { BusEvents, EngineContext, EngineDb } from '../core/types';
import { EventLogModule, InternetTracker, OPEN_SETTING, cursorKey, wiredGuidsOf, type ImportSummary } from './eventlog';
import { type RunResult, silentLogger } from './util';

// ─── fake wevtutil ─────────────────────────────────────────────────────────

interface FakeEvent {
  log: string;
  rec: number;
  ts: number;
  xml: string;
}

const iso = (ms: number) => new Date(ms).toISOString().replace('Z', '0000Z');

function xmlEvent(log: string, provider: string, id: number, rec: number, ts: number, data: Record<string, string> | string[] = {}): FakeEvent {
  const body = Array.isArray(data)
    ? data.map((v) => `<Data>${v}</Data>`).join('')
    : Object.entries(data).map(([k, v]) => `<Data Name='${k}'>${v}</Data>`).join('');
  const xml = `<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='${provider}'/><EventID>${id}</EventID><Version>0</Version><Level>4</Level><TimeCreated SystemTime='${iso(ts)}'/><EventRecordID>${rec}</EventRecordID><Correlation/><Execution ProcessID='4' ThreadID='1'/><Channel>${log}</Channel><Computer>Jan-PC</Computer><Security/></System><EventData>${body}</EventData></Event>`;
  return { log, rec, ts, xml };
}

class FakeWevtutil {
  readonly events: FakeEvent[] = [];
  calls = 0;
  constructor(private readonly now: () => number) {}

  add(e: FakeEvent): void {
    this.events.push(e);
  }

  run(_file: string, args: string[]): Promise<RunResult> {
    this.calls++;
    const log = args[1];
    const q = args.find((a) => a.startsWith('/q:')) ?? '';
    const after = Number(/EventRecordID > (\d+)/.exec(q)?.[1] ?? 0);
    const age = Number(/timediff\(@SystemTime\) <= (\d+)/.exec(q)?.[1] ?? 0);
    let list = this.events.filter((e) => e.log === log && e.rec > after && (!age || this.now() - e.ts <= age)).sort((a, b) => a.rec - b.rec);
    if (args.includes('/rd:true')) list = list.reverse();
    const count = Number(args.find((a) => a.startsWith('/c:'))?.slice(3) ?? 0);
    if (count) list = list.slice(0, count);
    const text = `\uFEFF${list.map((e) => e.xml).join('\r\n')}`;
    return Promise.resolve({ code: 0, stdout: Buffer.from(text, 'utf16le'), stderr: Buffer.alloc(0), timedOut: false, error: null, durationMs: 1 });
  }

  killAll(): void {}
}

// ─── fake context ──────────────────────────────────────────────────────────

function fakeContext() {
  const settings = new Map<string, string>();
  const rows: (NetEvent & { id: number })[] = [];
  const updates: { id: number; patch: Partial<NetEvent> }[] = [];
  const published: NetEvent[] = [];
  let nextId = 1;
  const handlers = new Map<string, ((p: unknown) => void)[]>();
  const insertEvent = (e: NetEvent): number | null => {
    if (e.dedupeKey && rows.some((r) => r.dedupeKey === e.dedupeKey)) return null;
    const id = nextId++;
    rows.push({ ...e, id });
    return id;
  };
  const updateEvent = (id: number, patch: Partial<NetEvent>) => {
    updates.push({ id, patch });
    const row = rows.find((r) => r.id === id);
    if (row) Object.assign(row, patch);
  };
  const db = {
    getSetting: (k: string) => settings.get(k) ?? null,
    setSetting: (k: string, v: string | null) => {
      if (v === null) settings.delete(k);
      else settings.set(k, v);
    },
    insertEvent,
    updateEvent,
  } as unknown as EngineDb;
  const cfg = mergeConfig({ eventLog: { importDays: 365 } });
  const ctx = {
    log: silentLogger,
    db,
    bus: {
      on: <K extends keyof BusEvents>(type: K, fn: (p: BusEvents[K]) => void) => {
        const list = handlers.get(type) ?? [];
        list.push(fn as (p: unknown) => void);
        handlers.set(type, list);
        return () => undefined;
      },
      emit: <K extends keyof BusEvents>(type: K, payload: BusEvents[K]) => {
        for (const fn of handlers.get(type) ?? []) fn(payload);
      },
    },
    config: () => cfg,
    recordEvent: (e: NetEvent) => {
      const id = insertEvent(e);
      if (id !== null) published.push(e);
      return id;
    },
    updateEvent,
    trackChild: () => undefined,
    isMeasuring: () => false,
  } as unknown as EngineContext;
  return { ctx, settings, rows, updates, published };
}

const T0 = Date.UTC(2026, 9, 8, 16, 29, 13);
const S = 1000;
const NIC = ['', 'Intel(R) Ethernet Controller (3) I225-V'];
const ETH = '{178af0a6-93f5-4ace-ace2-2ecdf78704f2}';
const WIFI = '{1cdb0ef5-cb64-4b03-9b8d-3de53ab40921}';

function seedHistory(w: FakeWevtutil): void {
  const boot = T0 - 3 * 3600_000;
  w.add(xmlEvent(LOG_SYSTEM, 'Microsoft-Windows-Kernel-General', 12, 100, boot));
  w.add(xmlEvent(LOG_SYSTEM, 'e2fexpress', 27, 101, boot + 12 * S, NIC));
  w.add(xmlEvent(LOG_SYSTEM, 'e2fexpress', 33, 102, boot + 16 * S, NIC));
  const flap = T0 - 2 * 3600_000;
  w.add(xmlEvent(LOG_SYSTEM, 'e2fexpress', 27, 110, flap, NIC));
  w.add(xmlEvent(LOG_WLAN, 'Microsoft-Windows-WLAN-AutoConfig', 8001, 50, flap + 400, { SSID: 'Vodafone-43FE' }));
  w.add(xmlEvent(LOG_NCSI, 'Microsoft-Windows-NCSI', 4042, 700, flap + 900, { InterfaceGuid: ETH, Family: '0', Capability: '0', PreviousCapability: '2' }));
  w.add(xmlEvent(LOG_NCSI, 'Microsoft-Windows-NCSI', 4042, 701, flap + 1500, { InterfaceGuid: WIFI, Family: '0', Capability: '2', PreviousCapability: '1' }));
  w.add(xmlEvent(LOG_SYSTEM, 'e2fexpress', 32, 111, flap + 6 * S, NIC));
  w.add(xmlEvent(LOG_SYSTEM, 'Service Control Manager', 7045, 112, flap + 60 * S, { ServiceName: 'MSI Center Service', ImagePath: 'C:\\MSI\\svc.exe' }));
}

describe('wiredGuidsOf', () => {
  it('takes the GUIDs of physical wired adapters from the adapters snapshot', () => {
    expect(
      wiredGuidsOf([
        { name: 'Ethernet', isWifi: false, isVirtual: false, guid: '{178AF0A6-93F5-4ACE-ACE2-2ECDF78704F2}' },
        { name: 'WLAN', isWifi: true, isVirtual: false, guid: '{1cdb0ef5-cb64-4b03-9b8d-3de53ab40921}' },
        { name: 'CloudflareWARP', isWifi: false, isVirtual: true, guid: '{db484304-db04-6aa0-a33d-7236836b364d}' },
        { name: 'alt', isWifi: false, isVirtual: false },
        null,
      ]),
    ).toEqual(['{178af0a6-93f5-4ace-ace2-2ecdf78704f2}']);
  });
});

describe('InternetTracker', () => {
  const cfg = DEFAULT_CONFIG;
  const sample = (ts: number, targetId: string, status: 0 | 1): Sample => ({ ts, targetId, rtt: status === 0 ? 20 : null, status });
  it('finds the first second with an internet answer after a link drop', () => {
    const t = new InternetTracker();
    t.setTargets(cfg);
    for (let k = -5; k <= 20; k++) {
      t.onSample(sample(T0 + k * S, 'cf4', k > 0 && k < 4 ? 1 : 0), T0);
      t.onSample(sample(T0 + k * S, 'gw', 0), T0); // LAN target is ignored
    }
    expect(t.recovery(T0 + 300)).toEqual({ recoveredTs: T0 + 4 * S, coveredUntil: T0 + 4 * S });
    expect(t.recovery(T0 - 3600_000)).toBeNull();
  });
  it('reports an ongoing outage as lower bound', () => {
    const t = new InternetTracker();
    t.setTargets(cfg);
    for (let k = 0; k <= 30; k++) t.onSample(sample(T0 + k * S, 'cf6', 1), T0);
    expect(t.recovery(T0)).toEqual({ recoveredTs: null, coveredUntil: T0 + 30 * S });
  });
});

describe('EventLogModule (fake wevtutil)', () => {
  it('imports history, records provisional link drops, updates and finalizes them, survives restarts', async () => {
    let now = T0;
    const clock = () => now;
    const w = new FakeWevtutil(clock);
    seedHistory(w);
    const { ctx, settings, rows, updates, published } = fakeContext();
    const mod = new EventLogModule({ runner: w, now: clock, autoStart: false });
    mod.init(ctx);

    // 1) first start: history import
    await mod.tick();
    expect(rows.map((r) => r.type).sort()).toEqual(['nic_link_down', 'nic_link_down', 'nic_link_up', 'nic_link_up', 'resume', 'wlan_connect']);
    const downs = rows.filter((r) => r.type === 'nic_link_down');
    expect(downs.map((d) => d.details?.cause)).toEqual(['boot', 'runtime']);
    expect(downs[1]).toMatchObject({ severity: 'warn', endTs: T0 - 2 * 3600_000 + 6 * S, dedupeKey: 'evtlog:System:110', details: { relinkMbps: 1000, wlanFailover: true, internetDownMs: 1500, final: true } });
    expect(published).toHaveLength(0); // history is stored without live publication
    expect(settings.get(cursorKey(LOG_SYSTEM))).toBe('112');
    expect(settings.get(cursorKey(LOG_WLAN))).toBe('50');
    expect(settings.get(cursorKey(LOG_NCSI))).toBe('701');
    expect(settings.has(OPEN_SETTING)).toBe(false);

    // 2) a live link drop appears (no link-up yet) → provisional event, published
    w.add(xmlEvent(LOG_SYSTEM, 'e2fexpress', 27, 120, T0 + 10 * S, NIC));
    w.add(xmlEvent(LOG_NCSI, 'Microsoft-Windows-NCSI', 4042, 702, T0 + 10 * S + 500, { InterfaceGuid: ETH, Family: '0', Capability: '0', PreviousCapability: '2' }));
    now = T0 + 12 * S;
    await mod.tick();
    const live = rows.find((r) => r.dedupeKey === 'evtlog:System:120');
    expect(live).toMatchObject({ endTs: null, title: 'Netzwerkverbindung am PC unterbrochen', details: { cause: 'runtime', final: false, internetOngoing: true } });
    expect(published.map((e) => e.dedupeKey)).toEqual(['evtlog:System:120']);
    expect(JSON.parse(settings.get(OPEN_SETTING) ?? '[]')).toHaveLength(1);

    // 3) link-up + internet back → the open event is updated (endTs, downtime, relink speed)
    w.add(xmlEvent(LOG_SYSTEM, 'e2fexpress', 33, 121, T0 + 16 * S, NIC));
    w.add(xmlEvent(LOG_NCSI, 'Microsoft-Windows-NCSI', 4042, 703, T0 + 17 * S, { InterfaceGuid: ETH, Family: '0', Capability: '2', PreviousCapability: '1' }));
    now = T0 + 70 * S;
    await mod.tick();
    const upd = updates.filter((u) => u.id === live?.id);
    expect(upd.length).toBeGreaterThanOrEqual(1);
    expect(live).toMatchObject({ endTs: T0 + 16 * S, title: 'Netzwerkverbindung am PC unterbrochen (6 s, danach 100 Mbit/s)', details: { downtimeMs: 6000, relinkMbps: 100, internetDownMs: 7000, final: false } });
    expect(rows.filter((r) => r.type === 'nic_link_up')).toHaveLength(3);

    // 4) after all look-ahead windows: final, removed from the open list
    now = T0 + 11 * 60 * S;
    await mod.tick();
    expect(live?.details).toMatchObject({ final: true, cause: 'runtime' });
    expect(settings.has(OPEN_SETTING)).toBe(false);
    const nUpdates = updates.length;
    await mod.tick();
    expect(updates.length).toBe(nUpdates); // nothing changes anymore

    // 5) manual re-import is idempotent
    const summary = (await mod.runNow({ days: 1 })) as ImportSummary;
    expect(summary).toMatchObject({ days: 1, inserted: 0, linkDowns: { boot: 1, runtime: 2 } });

    // 6) restart with the same settings: no duplicates, new events still recorded
    const before = rows.length;
    const mod2 = new EventLogModule({ runner: w, now: clock, autoStart: false });
    mod2.init(ctx);
    w.add(xmlEvent(LOG_WLAN, 'Microsoft-Windows-WLAN-AutoConfig', 8003, 51, now - 5 * S, { SSID: 'Vodafone-43FE', ReasonCode: '5' }));
    await mod2.tick();
    expect(rows.length).toBe(before + 1);
    expect(rows[rows.length - 1]).toMatchObject({ type: 'wlan_disconnect', title: 'WLAN getrennt (Vodafone-43FE) – Kabelverbindung wieder aktiv' });
    mod.dispose();
    mod2.dispose();
  });

  it('importDays = 0 starts at the newest records without importing', async () => {
    let now = T0;
    const clock = () => now;
    const w = new FakeWevtutil(clock);
    seedHistory(w);
    const { ctx, settings, rows } = fakeContext();
    (ctx as unknown as { config: () => unknown }).config = () => mergeConfig({ eventLog: { importDays: 0 } });
    const mod = new EventLogModule({ runner: w, now: clock, autoStart: false });
    mod.init(ctx);
    await mod.tick();
    expect(rows).toHaveLength(0);
    expect(settings.get(cursorKey(LOG_SYSTEM))).toBe('112');
    now += 60 * S;
    w.add(xmlEvent(LOG_SYSTEM, 'Microsoft-Windows-Kernel-Power', 42, 113, now - S, { Reason: '4' }));
    await mod.tick();
    expect(rows.map((r) => r.type)).toEqual(['standby']);
    mod.dispose();
  });
});
