import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { mergeConfig } from '../../../src/lib/shared/config';
import type { AdapterInfo, AdapterSnapshot, MetricPoint, NetEvent, WlanInfo } from '../../../src/lib/shared/types';
import type { BusEvents, EngineContext, EngineDb } from '../../core/types';
import { setPlatformOverride } from '../../platform';
import type { RunResult } from '../util';
import { createWlanModule, diffWlan } from '../wlan';
import { SystemProfilerWlanSource, deviceOf } from './wlan';

const fixture = (name: string) => fs.readFileSync(new URL(`../../../fixtures/macos/${name}`, import.meta.url), 'utf8');

function fakeRunner(stdout: () => string) {
  const calls: { file: string; args: string[]; env?: NodeJS.ProcessEnv }[] = [];
  return {
    calls,
    run(file: string, args: string[], o: { env?: NodeJS.ProcessEnv }): Promise<RunResult> {
      calls.push({ file, args, env: o.env });
      return Promise.resolve({ code: 0, stdout: Buffer.from(stdout()), stderr: Buffer.alloc(0), timedOut: false, error: null, durationMs: 5 });
    },
  };
}

const wifiAdapter = (patch: Partial<AdapterInfo> & { device?: string } = {}) =>
  ({ name: 'Wi-Fi', description: 'en0 · Wi-Fi', ifIndex: 11, status: 'Up', isWifi: true, isVirtual: false, mediaConnected: true, addresses: [], device: 'en0', ...patch }) as unknown as AdapterInfo;

afterEach(() => setPlatformOverride(null));

describe('SystemProfilerWlanSource', () => {
  it('runs system_profiler by absolute path with the C locale and picks the adapter device', async () => {
    const r = fakeRunner(() => fixture('system_profiler_airport_connected.json'));
    const info = await new SystemProfilerWlanSource(r).read(wifiAdapter());
    expect(r.calls[0]).toMatchObject({ file: '/usr/sbin/system_profiler', args: ['SPAirPortDataType', '-json'] });
    expect(r.calls[0].env?.LC_ALL).toBe('C');
    expect(info).toMatchObject({ present: true, connected: true, ssid: 'Vodafone-43FE', channel: 100, rssiDbm: -58, signalPct: 84 });
  });

  it('adapter snapshot decides "connected"; garbage output throws a German error', async () => {
    const off = await new SystemProfilerWlanSource(fakeRunner(() => fixture('system_profiler_airport_connected.json'))).read(wifiAdapter({ mediaConnected: false }));
    expect(off).toMatchObject({ connected: false, channel: null });
    await expect(new SystemProfilerWlanSource(fakeRunner(() => 'oops')).read(null)).rejects.toThrow(/kein JSON/);
    expect(deviceOf(wifiAdapter())).toBe('en0');
    expect(deviceOf(wifiAdapter({ device: '' }))).toBeNull();
    expect(deviceOf(null)).toBeNull();
  });
});

describe('wlan module with the macOS source', () => {
  function fakeCtx(adapters: AdapterSnapshot | null) {
    const events: NetEvent[] = [];
    const metrics: MetricPoint[] = [];
    const snapshots: WlanInfo[] = [];
    const handlers = new Map<string, ((p: unknown) => void)[]>();
    const ctx = {
      log: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined, child: () => ctx.log },
      db: {
        latestSnapshot: (kind: string) => (kind === 'adapters' && adapters ? { ts: 1, kind, data: adapters } : null),
        getSetting: () => null,
      } as unknown as EngineDb,
      bus: {
        on: <K extends keyof BusEvents>(type: K, fn: (p: BusEvents[K]) => void) => {
          handlers.set(type, [...(handlers.get(type) ?? []), fn as (p: unknown) => void]);
          return () => undefined;
        },
        emit: () => undefined,
      },
      config: () => mergeConfig({}),
      isMeasuring: () => true,
      recordEvent: (e: NetEvent) => {
        events.push(e);
        return events.length;
      },
      recordMetrics: (p: MetricPoint[]) => metrics.push(...p),
      recordSnapshot: (_k: string, d: WlanInfo) => snapshots.push(d),
      trackChild: () => undefined,
    } as unknown as EngineContext;
    return { ctx, events, metrics, snapshots };
  }

  it('reports connect events with via = system_profiler and wlan.* metrics (no rx rate)', async () => {
    let text = fixture('system_profiler_airport_off.json');
    const r = fakeRunner(() => text);
    // mediaConnected unknown → the system_profiler status decides
    const snap = { ts: 1, adapters: [wifiAdapter({ mediaConnected: null })], routes: [], advanced: [] } as AdapterSnapshot;
    const { ctx, events, metrics, snapshots } = fakeCtx(snap);
    const mod = createWlanModule({ createSource: () => new SystemProfilerWlanSource(r) });
    mod.init?.(ctx);
    await mod.runNow?.();
    text = fixture('system_profiler_airport_connected.json');
    await mod.runNow?.();
    expect(events.map((e) => e.title)).toEqual(['WLAN verbunden (Vodafone-43FE, 5 GHz, Kanal 100)']);
    expect(events[0].details).toMatchObject({ via: 'system_profiler', bssid: null });
    expect(metrics.map((m) => m.key).sort()).toEqual(['wlan.channel', 'wlan.rssi_dbm', 'wlan.signal_pct', 'wlan.tx_mbps']);
    expect(snapshots).toHaveLength(2);
    mod.dispose?.();
  });

  it('channel change without BSSID is a roam event; default via stays netsh', () => {
    const base: WlanInfo = { ts: 1, present: true, connected: true, ssid: null, bssid: null, radioType: '802.11ax', band: '5 GHz', channel: 36, signalPct: 80, rssiDbm: -60, rxMbps: null, txMbps: 600, raw: {} };
    const [ev] = diffWlan(base, { ...base, channel: 100 }, { connectEvents: true, via: 'system_profiler' });
    expect(ev).toMatchObject({ type: 'wlan_roam', title: 'WLAN-Kanal gewechselt: 36 → 100' });
    const [c] = diffWlan({ ...base, connected: false }, base, { connectEvents: true });
    expect(c.details).toMatchObject({ via: 'netsh' });
  });

  it.skipIf(process.platform === 'darwin')('uses system_profiler on macOS (absolute path – missing here)', async () => {
    setPlatformOverride('macos');
    const { ctx } = fakeCtx(null);
    const mod = createWlanModule();
    mod.init?.(ctx);
    await mod.runNow?.();
    expect(mod.state().lastError).toMatch(/system_profiler/);
    mod.dispose?.();
  });
});
