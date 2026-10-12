// WLAN collector (ARCHITECTURE §4.9): `netsh wlan show interfaces` (UTF-8, de/en labels) parsed by
// parseNetshWlan(); "connected" comes from MSFT_NetAdapter.MediaConnectState (adapters snapshot).
// Metrics wlan.* while connected, snapshot 'wlan' on change (+ every 5 min while connected),
// wlan_roam events (BSSID or channel change). wlan_connect/wlan_disconnect come with exact times from
// the event log (WLAN-AutoConfig 8001/8003, eventlog module); this module only emits them as a
// fallback when that log is not read.
import { decodeConsole } from '../../src/lib/shared/cp850';
import { parseNetshWlan, wlanInfoFromNetsh } from '../../src/lib/shared/parsers/netsh';
import type { AdapterInfo, AdapterSnapshot, MetricPoint, ModuleState, NetEvent, WlanInfo } from '../../src/lib/shared/types';
import type { EngineContext, EngineModule, Logger } from '../core/types';
import { WLAN_CURSOR_KEY } from './eventlog';
import { PollTimer, ProcessRunner, childTracker, errorMessage, pollMs, system32, timersState } from './util';

const NETSH = (): string => system32('netsh.exe');
const IDLE_POLL_SEC = 60;
const NO_ADAPTER_POLL_MS = 30 * 60_000;
const SNAPSHOT_EVERY_MS = 5 * 60_000;

export function wlanMetrics(info: WlanInfo): MetricPoint[] {
  if (!info.connected) return [];
  const out: MetricPoint[] = [];
  const add = (key: string, v: number | null) => {
    if (v !== null && Number.isFinite(v)) out.push({ ts: info.ts, key, value: v });
  };
  add('wlan.signal_pct', info.signalPct);
  add('wlan.rssi_dbm', info.rssiDbm);
  add('wlan.rx_mbps', info.rxMbps);
  add('wlan.tx_mbps', info.txMbps);
  add('wlan.channel', info.channel);
  return out;
}

/** Fields whose change triggers a snapshot. */
export function wlanSignature(info: WlanInfo): string {
  return JSON.stringify([info.present, info.connected, info.ssid, info.bssid, info.channel, info.band, info.radioType]);
}

const describe = (i: WlanInfo): string => {
  const parts = [i.ssid, i.band, i.channel !== null ? `Kanal ${i.channel}` : null].filter((x): x is string => !!x);
  return parts.length ? ` (${parts.join(', ')})` : '';
};

function wlanDetails(i: WlanInfo): Record<string, unknown> {
  return { ssid: i.ssid, bssid: i.bssid, band: i.band, channel: i.channel, signalPct: i.signalPct, rssiDbm: i.rssiDbm, radioType: i.radioType, via: 'netsh' };
}

/**
 * Events between two WLAN states. Roam = BSSID change within the same SSID; channel change with the
 * same BSSID (e.g. DFS radar) is reported as roam with reason 'channel'.
 */
export function diffWlan(prev: WlanInfo | null, cur: WlanInfo, opts: { connectEvents: boolean }): NetEvent[] {
  if (!prev) return [];
  const out: NetEvent[] = [];
  const base = { ts: cur.ts, segment: 'client' as const, source: 'wlan' as const };
  if (!prev.connected && cur.connected) {
    if (opts.connectEvents) out.push({ ...base, type: 'wlan_connect', severity: 'info', title: `WLAN verbunden${describe(cur)}`, details: wlanDetails(cur) });
    return out;
  }
  if (prev.connected && !cur.connected) {
    if (opts.connectEvents) {
      out.push({ ...base, type: 'wlan_disconnect', severity: 'info', title: `WLAN getrennt${prev.ssid ? ` (${prev.ssid})` : ''}`, details: { ...wlanDetails(prev), kind: 'disconnected' } });
    }
    return out;
  }
  if (!prev.connected || !cur.connected) return out;
  if (prev.ssid && cur.ssid && prev.ssid !== cur.ssid) {
    if (opts.connectEvents) {
      out.push({ ...base, type: 'wlan_disconnect', severity: 'info', title: `WLAN getrennt (${prev.ssid})`, details: { ...wlanDetails(prev), kind: 'disconnected' } });
      out.push({ ...base, type: 'wlan_connect', severity: 'info', title: `WLAN verbunden${describe(cur)}`, details: wlanDetails(cur) });
    }
    return out;
  }
  const roamDetails = {
    ssid: cur.ssid,
    fromBssid: prev.bssid,
    toBssid: cur.bssid,
    fromChannel: prev.channel,
    toChannel: cur.channel,
    fromBand: prev.band,
    toBand: cur.band,
    signalPct: cur.signalPct,
    rssiDbm: cur.rssiDbm,
  };
  if (prev.bssid && cur.bssid && prev.bssid !== cur.bssid) {
    const band = prev.band !== cur.band && cur.band ? `, ${prev.band ?? '?'} → ${cur.band}` : '';
    out.push({ ...base, type: 'wlan_roam', severity: 'info', title: `WLAN-Roaming: Zugangspunkt gewechselt${band}`, details: { ...roamDetails, reason: 'bssid' } });
  } else if (prev.channel !== null && cur.channel !== null && prev.channel !== cur.channel) {
    out.push({ ...base, type: 'wlan_roam', severity: 'info', title: `WLAN-Kanal gewechselt: ${prev.channel} → ${cur.channel}`, details: { ...roamDetails, reason: 'channel' } });
  }
  return out;
}

export function wifiAdapterOf(snap: Pick<AdapterSnapshot, 'adapters'> | null): AdapterInfo | null {
  if (!snap) return null;
  return snap.adapters.find((a) => a.isWifi && !a.isVirtual) ?? null;
}

class WlanModule implements EngineModule {
  readonly name = 'wlan';
  private ctx: EngineContext | null = null;
  private log: Logger | null = null;
  private runner: ProcessRunner | null = null;
  private timer: PollTimer | null = null;
  private adapters: AdapterSnapshot | null = null;
  private last: WlanInfo | null = null;
  private lastSignature = '';
  private lastSnapshotTs = 0;
  private lastMediaConnected: boolean | null | undefined = undefined;
  private noAdapter = false;
  private unsubs: (() => void)[] = [];
  private lastError: string | null = null;

  init(ctx: EngineContext): void {
    this.ctx = ctx;
    this.log = ctx.log;
    this.runner = new ProcessRunner(childTracker(ctx));
    try {
      this.adapters = ctx.db.latestSnapshot<AdapterSnapshot>('adapters')?.data ?? null;
      // only the signature: a change during engine downtime is no live roam/connect event
      const prev = ctx.db.latestSnapshot<WlanInfo>('wlan')?.data;
      if (prev && typeof prev.connected === 'boolean') this.lastSignature = wlanSignature(prev);
    } catch {
      /* no snapshots yet */
    }
    this.unsubs.push(ctx.bus.on('adapters', (snap) => this.onAdapters(snap)));
    this.timer = new PollTimer({
      intervalMs: () => (this.noAdapter ? NO_ADAPTER_POLL_MS : pollMs(ctx, ctx.config().schedules.wlanPollSec, IDLE_POLL_SEC)),
      run: () => this.poll(),
      onError: (err) => {
        this.lastError = errorMessage(err);
        this.log?.debug('WLAN-Abfrage fehlgeschlagen', { error: this.lastError });
      },
    });
    this.timer.start(1500);
  }

  start(): void {
    this.timer?.trigger(0);
  }

  stop(): void {
    this.timer?.trigger(1000);
  }

  reconfigure(): void {
    this.timer?.trigger(1000);
  }

  async runNow(): Promise<WlanInfo | null> {
    await this.timer?.runNow();
    return this.last;
  }

  dispose(): void {
    this.timer?.stop();
    this.runner?.killAll();
    for (const off of this.unsubs) off();
    this.unsubs = [];
  }

  state(): ModuleState {
    return timersState(this.name, true, this.timer ? [this.timer] : [], this.lastError);
  }

  private onAdapters(snap: AdapterSnapshot): void {
    this.adapters = snap;
    const wifi = wifiAdapterOf(snap);
    const mc = wifi ? wifi.mediaConnected : null;
    if (this.lastMediaConnected !== undefined && mc !== this.lastMediaConnected) this.timer?.trigger(500);
    this.lastMediaConnected = mc;
    if (wifi && this.noAdapter) {
      this.noAdapter = false;
      this.timer?.trigger(500);
    }
  }

  private async poll(): Promise<void> {
    const ctx = this.ctx;
    const runner = this.runner;
    if (!ctx || !runner) return;
    const wifi = wifiAdapterOf(this.adapters);
    const r = await runner.run(NETSH(), ['wlan', 'show', 'interfaces'], { timeoutMs: 10_000, maxBytes: 1024 * 1024 });
    if (r.error) throw r.error;
    if (r.timedOut) throw new Error('netsh: Zeitüberschreitung');
    const ts = Date.now();
    const ifaces = parseNetshWlan(decodeConsole(new Uint8Array(r.stdout)));
    const info = wlanInfoFromNetsh(ifaces, ts, { adapterName: wifi?.name ?? null, mediaConnected: wifi ? wifi.mediaConnected : null });
    // no WLAN hardware (netsh lists nothing and the adapters snapshot knows no WLAN adapter)
    this.noAdapter = !info.present && this.adapters !== null && wifi === null;

    const connectEvents = ctx.db.getSetting(WLAN_CURSOR_KEY) === null;
    for (const e of diffWlan(this.last, info, { connectEvents })) ctx.recordEvent(e);
    const points = wlanMetrics(info);
    if (points.length) ctx.recordMetrics(points);
    const sig = wlanSignature(info);
    if (sig !== this.lastSignature || (info.connected && ts - this.lastSnapshotTs >= SNAPSHOT_EVERY_MS)) {
      ctx.recordSnapshot('wlan', info, ts);
      this.lastSignature = sig;
      this.lastSnapshotTs = ts;
    }
    this.last = info;
    this.lastError = null;
  }
}

export function createWlanModule(): EngineModule {
  return new WlanModule();
}
