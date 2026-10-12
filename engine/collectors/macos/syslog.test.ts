import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { mergeConfig } from '../../../src/lib/shared/config';
import { pmsetPowerEntries } from '../../../src/lib/shared/parsers/macos/pmset';
import { parseKernelLinkEvents } from '../../../src/lib/shared/parsers/macos/unified-log';
import { MAC_LINK_PROVIDER, MAC_POWER_PROVIDER, macRecordId } from '../../../src/lib/shared/parsers/winevent';
import type { AdapterInfo, AdapterSnapshot, NetEvent } from '../../../src/lib/shared/types';
import type { BusEvents, EngineContext, EngineDb, NicTick } from '../../core/types';
import { setPlatformOverride } from '../../platform';
import { IMPORT_SETTING, OPEN_SETTING, createEventLogModule, type ImportSummary } from '../eventlog';
import { type RunResult, silentLogger } from '../util';
import {
  KERN_TIMES_KEY,
  LIVE_SINCE_KEY,
  LINK_LOG_PREDICATE,
  MacSystemLogModule,
  PMSET_CURSOR_KEY,
  RECENT_KEY,
  parseRecent,
  pmsetEvents,
  sysctlEvents,
  unifiedLogLinkEvents,
} from './syslog';

const fixture = (name: string) => fs.readFileSync(new URL(`../../../fixtures/macos/${name}`, import.meta.url), 'utf8');
const at = (iso: string) => new Date(iso).getTime();
const S = 1000;

// ─── fakes ─────────────────────────────────────────────────────────────────

const ok = (stdout: string, code = 0): RunResult => ({ code, stdout: Buffer.from(stdout), stderr: Buffer.alloc(0), timedOut: false, error: null, durationMs: 1 });

const sysctlText = (boot: number, sleep: number | null, wake: number | null) =>
  [boot, sleep, wake]
    .map((v, i) => `kern.${['boottime', 'sleeptime', 'waketime'][i]}: { sec = ${v === null ? 0 : Math.floor(v / 1000)}, usec = ${v === null ? 0 : (v % 1000) * 1000} } x`)
    .join('\n');

class FakeTools {
  sysctl = sysctlText(at('2026-10-11T08:01:02+02:00'), at('2026-10-12T01:40:58+02:00'), at('2026-10-12T07:30:05+02:00'));
  pmset: string | null = fixture('pmset_g_log.txt');
  log = fixture('log_show_kernel_link.ndjson');
  calls: { file: string; args: string[] }[] = [];

  run(file: string, args: string[]): Promise<RunResult> {
    this.calls.push({ file, args });
    if (file === '/usr/sbin/sysctl') return Promise.resolve(ok(this.sysctl));
    if (file === '/usr/bin/pmset') return Promise.resolve(this.pmset === null ? ok('', 1) : ok(this.pmset));
    if (file === '/usr/bin/log') return Promise.resolve(ok(this.log));
    return Promise.resolve(ok('', 1));
  }

  killAll(): void {}

  count(file: string): number {
    return this.calls.filter((c) => c.file === file).length;
  }
}

const adapter = (name: string, device: string, patch: Partial<AdapterInfo> = {}) =>
  ({ name, description: `${device} · ${name}`, ifIndex: 1, status: 'Up', linkMbps: 1000, isWifi: false, isVirtual: false, mediaConnected: true, addresses: [], device, ...patch }) as unknown as AdapterInfo;

const ADAPTERS: AdapterSnapshot = { ts: 1, adapters: [adapter('Ethernet', 'en7'), adapter('Wi-Fi', 'en0', { isWifi: true, linkMbps: null })], routes: [], advanced: [] };

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
    setSetting: (k: string, v: string | null) => (v === null ? settings.delete(k) : settings.set(k, v)),
    insertEvent,
    updateEvent,
    latestSnapshot: (kind: string) => (kind === 'adapters' ? { ts: 1, kind, data: ADAPTERS } : null),
  } as unknown as EngineDb;
  const cfg = mergeConfig({ eventLog: { importDays: 365 } });
  const bus = {
    on: <K extends keyof BusEvents>(type: K, fn: (p: BusEvents[K]) => void) => {
      handlers.set(type, [...(handlers.get(type) ?? []), fn as (p: unknown) => void]);
      return () => undefined;
    },
    emit: <K extends keyof BusEvents>(type: K, payload: BusEvents[K]) => {
      for (const fn of handlers.get(type) ?? []) fn(payload);
    },
  };
  const ctx = {
    log: silentLogger,
    db,
    bus,
    config: () => cfg,
    recordEvent: (e: NetEvent) => {
      const id = insertEvent(e);
      if (id !== null) published.push(e);
      return id;
    },
    updateEvent,
    trackChild: () => undefined,
    isMeasuring: () => true,
  } as unknown as EngineContext;
  return { ctx, bus, settings, rows, updates, published };
}

const nic = (ts: number, up: boolean, mbps: number | null = 1000): NicTick => ({ ts, name: 'Ethernet', up, mbps: up ? mbps : null, rxBytes: 0, txBytes: 0, rxErrors: 0, rxDiscards: 0, isWifi: false });

afterEach(() => setPlatformOverride(null));

// ─── pure helpers ──────────────────────────────────────────────────────────

describe('conversions', () => {
  it('pmset entries → power events with stable ids (dark wake + maintenance sleep kept as markers)', () => {
    const evs = pmsetEvents(pmsetPowerEntries(fixture('pmset_g_log.txt')));
    expect(evs.map((e) => `${e.id}${e.data.Maintenance ? '*' : ''}`)).toEqual(['1', '2', '4', '2*', '3', '5']);
    expect(evs[0]).toMatchObject({ provider: MAC_POWER_PROVIDER, log: MAC_POWER_PROVIDER, ts: at('2026-10-11T08:01:02+02:00'), recordId: macRecordId(at('2026-10-11T08:01:02+02:00'), 1) });
    expect(evs[1].data).toMatchObject({ Source: 'pmset', Reason: "Entering Sleep state due to 'Idle Sleep':TCPKeepAlive=active Using AC (Charge:100%)" });
    expect(pmsetEvents(pmsetPowerEntries(fixture('pmset_g_log.txt')))).toEqual(evs);
  });

  it('same-second entries get different seq', () => {
    const text = ['2026-10-12 07:30:05 +0200 DarkWake            \tDarkWake A', '2026-10-12 07:30:05 +0200 DarkWake            \tDarkWake B'].join('\n');
    const [a, b] = pmsetEvents(pmsetPowerEntries(text));
    expect(b.recordId - a.recordId).toBe(1);
  });

  it('sysctl fallback: boot on the first read, sleep/wake on change', () => {
    const k1 = { boot: 1000, sleep: null, wake: null };
    expect(sysctlEvents(null, k1).map((e) => e.id)).toEqual([1]);
    expect(sysctlEvents(k1, k1)).toEqual([]);
    const k2 = { boot: 1000, sleep: 5000, wake: 9000 };
    expect(sysctlEvents(k1, k2).map((e) => [e.id, e.ts, e.data.Source])).toEqual([
      [2, 5000, 'sysctl'],
      [3, 9000, 'sysctl'],
    ]);
  });

  it('unified log history: wired only, before the live observation, shown names', () => {
    const list = parseKernelLinkEvents(fixture('log_show_kernel_link.ndjson'));
    const devices = new Map([
      ['en7', { name: 'Ethernet', isWifi: false }],
      ['en0', { name: 'Wi-Fi', isWifi: true }],
    ]);
    const evs = unifiedLogLinkEvents(list, devices, at('2026-10-12T00:00:00+02:00'));
    expect(evs.map((e) => [e.id, e.data.p0, e.data.Mbps ?? '-'])).toEqual([
      [32, 'Ethernet', '1000'],
      [27, 'Ethernet', '-'],
      [33, 'Ethernet', '100'],
    ]);
    expect(evs[0]).toMatchObject({ provider: MAC_LINK_PROVIDER, data: { Device: 'en7', Source: 'unifiedlog', Duplex: 'full' } });
    expect(unifiedLogLinkEvents(list, new Map(), null).map((e) => e.data.p0)).toEqual(['en7', 'en7', 'en7', 'en0', 'en8']);
  });

  it('recent setting round trip ignores garbage', () => {
    const e = { log: 'macos-link', provider: 'macos-link', id: 27, recordId: 5, ts: 1, level: 4, data: { p0: 'Ethernet', x: 3 } };
    expect(parseRecent(JSON.stringify([e, { foo: 1 }, null]))).toEqual([{ ...e, data: { p0: 'Ethernet' } }]);
    expect(parseRecent('kaputt')).toEqual([]);
    expect(parseRecent(null)).toEqual([]);
  });
});

// ─── module ────────────────────────────────────────────────────────────────

describe('MacSystemLogModule', () => {
  const T0 = at('2026-10-13T12:00:00+02:00');

  it('imports pmset + kernel link history, then records live link drops from NIC ticks once', async () => {
    let now = T0;
    const tools = new FakeTools();
    const { ctx, bus, settings, rows, updates, published } = fakeContext();
    const mod = new MacSystemLogModule({ runner: tools, now: () => now, autoStart: false });
    mod.init(ctx);
    expect(settings.get(LIVE_SINCE_KEY)).toBe(String(T0));

    // 1) first start: history import
    await mod.tick();
    expect(rows.map((r) => r.type).sort()).toEqual(['nic_link_down', 'nic_link_up', 'nic_link_up', 'nic_link_up', 'resume', 'resume', 'standby', 'standby']);
    expect(rows.filter((r) => r.type === 'resume' || r.type === 'standby').map((r) => r.title)).toEqual([
      'Mac gestartet',
      'Mac wechselt in den Ruhezustand',
      'Mac aus dem Ruhezustand aufgewacht',
      'Mac heruntergefahren',
    ]);
    const down = rows.find((r) => r.type === 'nic_link_down');
    expect(down).toMatchObject({
      ts: at('2026-10-11T19:12:01.004+02:00'),
      title: 'Netzwerkverbindung am Mac unterbrochen (4 s, danach 100 Mbit/s)',
      details: { cause: 'runtime', adapter: 'Ethernet', observedBy: 'unifiedlog', provider: 'macos-link', final: true },
    });
    expect(published).toHaveLength(0);
    expect(settings.get(IMPORT_SETTING)).toBe(String(T0));
    expect(settings.get(PMSET_CURSOR_KEY)).toBe(String(at('2026-10-12T21:59:59+02:00')));
    expect(settings.has(KERN_TIMES_KEY)).toBe(true);
    expect(tools.calls.find((c) => c.file === '/usr/bin/log')?.args).toEqual(['show', '--style', 'ndjson', '--last', '365d', '--predicate', LINK_LOG_PREDICATE]);
    expect(tools.count('/usr/bin/pmset')).toBe(1); // no second read right after the import

    // 2) session: NIC ticks; the cable is pulled at T0+10 s
    now = T0 + 1 * S;
    bus.emit('nic', nic(T0 + 1 * S, true));
    now = T0 + 10 * S;
    bus.emit('nic', nic(T0 + 10 * S, false));
    // a slightly stale adapter poll reports the same drop – must not be recorded twice
    now = T0 + 11 * S;
    bus.emit('adapters', { ...ADAPTERS, ts: T0 + 11 * S, adapters: [adapter('Ethernet', 'en7', { status: 'Disconnected', linkMbps: null }), ADAPTERS.adapters[1]] });
    // Wi-Fi takes over (wlan module event) – context only
    bus.emit('event', { ts: T0 + 12 * S, type: 'wlan_connect', severity: 'info', segment: 'client', title: 'WLAN verbunden', details: { ssid: 'Vodafone-43FE' }, source: 'wlan' });
    now = T0 + 13 * S;
    await mod.tick();
    const live = rows.filter((r) => r.type === 'nic_link_down' && r.ts === T0 + 10 * S);
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ endTs: null, title: 'Netzwerkverbindung am Mac unterbrochen', details: { cause: 'runtime', final: false, wlanFailover: true, observedBy: 'nic' } });
    expect(published.map((e) => e.type)).toEqual(['nic_link_down']);
    expect(rows.some((r) => r.type === 'wlan_connect')).toBe(false);
    expect(JSON.parse(settings.get(OPEN_SETTING) ?? '[]')).toHaveLength(1);
    expect(parseRecent(settings.get(RECENT_KEY) ?? null).map((e) => e.provider)).toEqual(['macos-link', 'Microsoft-Windows-WLAN-AutoConfig']);

    // 3) link back at T0+16 s with 1 Gbit/s → link-up row, the open drop gets endTs/downtime
    now = T0 + 16 * S;
    bus.emit('nic', nic(T0 + 16 * S, true, 1000));
    now = T0 + 70 * S;
    await mod.tick();
    expect(live[0]).toMatchObject({ endTs: T0 + 16 * S, title: 'Netzwerkverbindung am Mac unterbrochen (6 s, danach 1 Gbit/s)', details: { downtimeMs: 6000, relinkMbps: 1000 } });
    expect(rows.filter((r) => r.type === 'nic_link_up' && r.ts === T0 + 16 * S)).toHaveLength(1);
    expect(updates.some((u) => u.id === live[0].id)).toBe(true);

    // 4) restart before the drop is final: no duplicates, the open drop is still finalized
    const mod2 = new MacSystemLogModule({ runner: tools, now: () => now, autoStart: false });
    mod2.init(ctx);
    now = T0 + 11 * 60 * S;
    await mod2.tick();
    expect(live[0].details).toMatchObject({ final: true, cause: 'runtime', downtimeMs: 6000 });
    expect(settings.has(OPEN_SETTING)).toBe(false);
    expect(rows.filter((r) => r.type === 'nic_link_down')).toHaveLength(2);

    // 5) manual re-import is idempotent
    const summary = (await mod2.runNow({ days: 30 })) as ImportSummary;
    expect(summary).toMatchObject({ days: 30, inserted: 0 });
    mod.dispose();
    mod2.dispose();
  });

  it('a drop right after a wake is a resume artefact; adapter polls are used without NIC ticks', async () => {
    let now = T0;
    const tools = new FakeTools();
    const { ctx, bus, rows, published } = fakeContext();
    const mod = new MacSystemLogModule({ runner: tools, now: () => now, autoStart: false });
    mod.init(ctx);
    await mod.tick();
    const before = rows.length;

    // idle (no session): adapter polls only
    bus.emit('adapters', { ...ADAPTERS, ts: T0 + 5 * S });
    // the Mac sleeps and wakes up at T0+1 h; the link is renegotiated 4 s after the wake
    const wake = T0 + 3600 * S;
    tools.sysctl = sysctlText(at('2026-10-11T08:01:02+02:00'), T0 + 600 * S, wake);
    tools.pmset = `${fixture('pmset_g_log.txt')}${new Date(wake).toISOString().slice(0, 10)} ${new Date(wake + 2 * 3600_000).toISOString().slice(11, 19)} +0200 Wake                \tWake from Deep Idle [CDNVA] : due to EC.LidOpen/Lid Open\n`;
    now = wake + 4 * S;
    bus.emit('adapters', { ...ADAPTERS, ts: wake + 4 * S, adapters: [adapter('Ethernet', 'en7', { status: 'Disconnected' }), ADAPTERS.adapters[1]] });
    now = wake + 20 * S;
    await mod.tick();
    const fresh = rows.slice(before);
    expect(fresh.map((r) => r.type)).toEqual(['resume', 'nic_link_down']);
    expect(fresh[0].title).toBe('Mac aus dem Ruhezustand aufgewacht');
    expect(fresh[1]).toMatchObject({ title: 'Link-Neuaufbau beim Aufwachen aus dem Standby', details: { cause: 'boot', observedBy: 'adapter', marker: { kind: 'resume', provider: 'macos-power' } } });
    expect(published.map((e) => e.type)).toEqual(['resume', 'nic_link_down']);
    mod.dispose();
  });

  it('an unplugged USB adapter (vanishes from the list) counts as link loss', async () => {
    let now = T0;
    const tools = new FakeTools();
    const { ctx, bus, rows } = fakeContext();
    const mod = new MacSystemLogModule({ runner: tools, now: () => now, autoStart: false });
    mod.init(ctx);
    await mod.tick();
    const before = rows.length;
    bus.emit('adapters', { ...ADAPTERS, ts: T0 + 5 * S });
    now = T0 + 65 * S;
    bus.emit('adapters', { ...ADAPTERS, ts: T0 + 65 * S, adapters: [ADAPTERS.adapters[1]] });
    now = T0 + 125 * S;
    bus.emit('adapters', { ...ADAPTERS, ts: T0 + 125 * S, adapters: [adapter('Ethernet', 'en7', { linkMbps: 100 }), ADAPTERS.adapters[1]] });
    now = T0 + 130 * S;
    await mod.tick();
    expect(rows.slice(before).map((r) => [r.type, r.ts])).toEqual([
      ['nic_link_down', T0 + 65 * S],
      ['nic_link_up', T0 + 125 * S],
    ]);
    expect(rows[before]).toMatchObject({ endTs: T0 + 125 * S, details: { relinkMbps: 100, observedBy: 'adapter' } });
    mod.dispose();
  });

  it('falls back to sysctl when pmset is unavailable; importDays 0 imports nothing', async () => {
    let now = T0;
    const tools = new FakeTools();
    tools.pmset = null;
    const { ctx, settings, rows } = fakeContext();
    (ctx as unknown as { config: () => unknown }).config = () => mergeConfig({ eventLog: { importDays: 0 } });
    const mod = new MacSystemLogModule({ runner: tools, now: () => now, autoStart: false });
    mod.init(ctx);
    await mod.tick();
    expect(rows).toHaveLength(0);
    expect(tools.count('/usr/bin/log')).toBe(0);
    expect(settings.get(PMSET_CURSOR_KEY)).toBe(String(T0));
    expect(mod.state().lastError).toMatch(/pmset/);
    now = T0 + 120 * S;
    tools.sysctl = sysctlText(at('2026-10-11T08:01:02+02:00'), T0 + 60 * S, T0 + 100 * S);
    await mod.tick();
    expect(rows.map((r) => [r.type, r.ts, r.details?.observedBy])).toEqual([
      ['standby', T0 + 60 * S, 'sysctl'],
      ['resume', T0 + 100 * S, 'sysctl'],
    ]);
    mod.dispose();
  });

  it('createEventLogModule returns the system log module on macOS', () => {
    setPlatformOverride('macos');
    expect(createEventLogModule({ autoStart: false })).toBeInstanceOf(MacSystemLogModule);
    setPlatformOverride('windows');
    expect(createEventLogModule({ autoStart: false })).not.toBeInstanceOf(MacSystemLogModule);
  });
});
