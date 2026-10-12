// VPN / Cloudflare WARP collector (ARCHITECTURE §4.9): read-only `warp-cli -j status` and
// `warp-cli -j settings list` (operation_mode, split_tunnel_mode) plus other active tunnel adapters
// from the adapters snapshot → VpnInfo snapshot 'vpn' and vpn_change events. WARP is never
// controlled (no connect/disconnect/mode/settings commands).
// macOS (docs/research/macos.md §0): warp-cli from /usr/local/bin or the app bundle; other tunnels are
// the utun/ipsec/ppp/… interfaces with a routable address (shown by their BSD name).
import { constants as fsConstants } from 'node:fs';
import { access } from 'node:fs/promises';
import { isLinkLocalV6 } from '../../src/lib/shared/net';
import type { AdapterInfo, AdapterSnapshot, ModuleState, NetEvent, Severity, VpnInfo } from '../../src/lib/shared/types';
import type { EngineContext, EngineModule, Logger } from '../core/types';
import { isMac } from '../platform';
import { WARP_CLI_MAC_PATHS, toolEnv } from './macos/tools';
import { PollTimer, ProcessRunner, asString, childTracker, errorMessage, isRecord, timersState, warpCliPath } from './util';

const SNAPSHOT_EVERY_MS = 6 * 3600_000;
const WARP_TIMEOUT_MS = 10_000;

/** First JSON object in a CLI output (tolerates banners or trailing lines). */
export function extractJson(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as unknown;
  } catch {
    return null;
  }
}

export interface WarpStatus {
  status: string | null;
  reason: string | null;
}

/** `warp-cli -j status` → {"status":"Connected","reason":"NetworkHealthy"} */
export function parseWarpStatus(v: unknown): WarpStatus | null {
  if (!isRecord(v)) return null;
  const status = asString(v.status);
  const reason = asString(v.reason);
  if (status === null && reason === null) return null;
  return { status, reason };
}

export interface WarpSettings {
  mode: string | null;
  splitTunnel: 'include' | 'exclude' | null;
}

/** `warp-cli -j settings list` → {"settings":{"operation_mode":"tunnel_only","split_tunnel_mode":"include",…}} */
export function parseWarpSettings(v: unknown): WarpSettings | null {
  if (!isRecord(v)) return null;
  const s = isRecord(v.settings) ? v.settings : v;
  const mode = asString(s.operation_mode);
  const split = asString(s.split_tunnel_mode);
  if (mode === null && split === null) return null;
  return { mode, splitTunnel: split === 'include' || split === 'exclude' ? split : null };
}

const TUNNEL = /wireguard|wintun|tap-windows|tap adapter|openvpn|\bvpn\b|tunnel|tailscale|zerotier|nordlynx|anyconnect|fortinet|forticlient|globalprotect|pangp|juniper|pulse secure|proton|mullvad|expressvpn|softether|hamachi|radmin/i;
const NOT_TUNNEL = /cloudflare\s*warp|vethernet|hyper-v|bluetooth|loopback|wan miniport|teredo|isatap|6to4|kernel debug/i;

/** Active tunnel/VPN adapters other than WARP (WARP is reported via warp-cli). */
export function otherTunnels(adapters: readonly AdapterInfo[]): string[] {
  return adapters
    .filter((a) => a.status === 'Up' && (a.isVirtual || TUNNEL.test(a.description)))
    .filter((a) => TUNNEL.test(`${a.name} ${a.description}`) && !NOT_TUNNEL.test(`${a.name} ${a.description}`))
    .map((a) => a.name)
    .sort((a, b) => a.localeCompare(b));
}

/** macOS tunnel interfaces (BSD names) – the macOS adapter source lists them only with an address. */
const MAC_TUNNEL = /^(utun|ipsec|ppp|tun|tap|wg|zt|feth)\d+$/;

/**
 * Cloudflare WARP's own tunnel on macOS: utun with WARP's interface address – 172.16.0.2 (consumer
 * WARP), 100.96.0.0/12 (Zero Trust, 100.96.0.7 on the Windows PC, environment.md) or 2606:4700:110::/48.
 * It is reported via warp-cli, never as "other tunnel".
 */
export function isWarpTunnel(a: Pick<AdapterInfo, 'addresses'>): boolean {
  return (a.addresses ?? []).some((ip) => {
    const v4 = /^100\.(\d+)\./.exec(ip);
    return ip === '172.16.0.2' || (v4 !== null && Number(v4[1]) >= 96 && Number(v4[1]) <= 111) || /^2606:4700:110:/i.test(ip);
  });
}

const routable = (ip: string) => ip !== '' && ip !== '::1' && !ip.startsWith('127.') && !isLinkLocalV6(ip.split('%')[0]);

/**
 * Active macOS tunnels other than WARP: virtual utun/ipsec/ppp/… adapters that are up and carry a
 * routable address (the always-present system utuns only have link-local addresses). The WARP
 * tunnel is excluded whenever WARP is installed – otherwise every WARP connect would show up as an
 * unknown VPN.
 */
export function macOtherTunnels(adapters: readonly AdapterInfo[], opts: { warpInstalled: boolean }): string[] {
  return adapters
    .filter((a) => a.isVirtual && a.status === 'Up' && MAC_TUNNEL.test(a.name) && (a.addresses ?? []).some(routable))
    .filter((a) => !(opts.warpInstalled && isWarpTunnel(a)))
    .map((a) => a.name)
    .sort((a, b) => a.localeCompare(b));
}

/** First existing warp-cli on macOS (null = WARP not installed). */
export async function findMacWarpCli(paths: readonly string[] = WARP_CLI_MAC_PATHS): Promise<string | null> {
  for (const p of paths) {
    try {
      await access(p, fsConstants.X_OK);
      return p;
    } catch {
      /* not here */
    }
  }
  return null;
}

export function buildVpnInfo(
  ts: number,
  warp: { installed: boolean; status: WarpStatus | null; settings: WarpSettings | null },
  tunnels: string[],
): VpnInfo {
  const st = warp.status?.status ?? null;
  return {
    ts,
    warp: {
      installed: warp.installed,
      connected: st === null ? null : /^connected$/i.test(st),
      status: st === null ? null : warp.status?.reason ? `${st} (${warp.status.reason})` : st,
      mode: warp.settings?.mode ?? null,
      splitTunnel: warp.settings?.splitTunnel ?? null,
    },
    otherTunnels: tunnels,
  };
}

export function vpnSignature(v: VpnInfo): string {
  return JSON.stringify([v.warp?.installed ?? null, v.warp?.connected ?? null, v.warp?.mode ?? null, v.warp?.splitTunnel ?? null, v.otherTunnels]);
}

const MODE_TEXT: Record<string, string> = {
  tunnel_only: 'nur Tunnel (ohne DNS)',
  warp: 'Tunnel + DNS',
  doh_only: 'nur DNS (DoH)',
  dot_only: 'nur DNS (DoT)',
  proxy: 'Proxy',
  posture_only: 'nur Gerätestatus',
};

const modeText = (m: string | null) => (m ? (MODE_TEXT[m] ?? m) : '–');

/** vpn_change events between two states (unknown → known transitions are not reported). */
export function diffVpn(prev: VpnInfo | null, cur: VpnInfo): NetEvent[] {
  if (!prev) return [];
  const out: NetEvent[] = [];
  const ev = (severity: Severity, title: string, details: Record<string, unknown>): NetEvent => ({
    ts: cur.ts,
    type: 'vpn_change',
    severity,
    segment: 'client',
    title,
    details: { ...details, warp: cur.warp, otherTunnels: cur.otherTunnels },
    source: 'vpn',
  });
  const p = prev.warp;
  const c = cur.warp;
  if (p && c) {
    if (p.installed !== c.installed) {
      out.push(ev('info', c.installed ? 'Cloudflare WARP installiert' : 'Cloudflare WARP nicht mehr installiert', { change: 'installed', from: p.installed, to: c.installed }));
    } else if (c.installed) {
      if (p.connected !== null && c.connected !== null && p.connected !== c.connected) {
        out.push(ev('info', c.connected ? 'Cloudflare WARP verbunden' : `Cloudflare WARP getrennt${c.status ? ` (${c.status})` : ''}`, { change: 'connected', from: p.connected, to: c.connected }));
      }
      if (p.mode && c.mode && p.mode !== c.mode) {
        out.push(ev('info', `WARP-Modus geändert: ${modeText(p.mode)} → ${modeText(c.mode)}`, { change: 'mode', from: p.mode, to: c.mode }));
      }
      if (p.splitTunnel && c.splitTunnel && p.splitTunnel !== c.splitTunnel) {
        const all = c.splitTunnel === 'exclude';
        out.push(
          ev(all ? 'warn' : 'info', all ? 'WARP leitet jetzt fast den gesamten Verkehr durch den Tunnel (Split-Tunnel „Ausschließen“)' : 'WARP tunnelt nur noch ausgewählte Netze (Split-Tunnel „Einschließen“)', {
            change: 'splitTunnel',
            from: p.splitTunnel,
            to: c.splitTunnel,
          }),
        );
      }
    }
  }
  const before = new Set(prev.otherTunnels);
  const after = new Set(cur.otherTunnels);
  for (const name of cur.otherTunnels) if (!before.has(name)) out.push(ev('warn', `VPN-Tunnel aktiv: ${name}`, { change: 'tunnel_up', tunnel: name }));
  for (const name of prev.otherTunnels) if (!after.has(name)) out.push(ev('info', `VPN-Tunnel beendet: ${name}`, { change: 'tunnel_down', tunnel: name }));
  return out;
}

export interface VpnModuleDeps {
  /** child process runner (tests) */
  runner?: Pick<ProcessRunner, 'run' | 'killAll'>;
  /** warp-cli location (default: Windows %ProgramFiles% path, macOS findMacWarpCli()); null = not installed */
  warpCli?: () => Promise<string | null>;
  /** force the macOS tunnel rules (default: isMac()) */
  mac?: boolean;
}

class VpnModule implements EngineModule {
  readonly name = 'vpn';
  private ctx: EngineContext | null = null;
  private log: Logger | null = null;
  private runner: Pick<ProcessRunner, 'run' | 'killAll'> | null = null;
  private mac = false;
  private timer: PollTimer | null = null;
  private adapters: AdapterInfo[] = [];
  private last: VpnInfo | null = null;
  private lastSignature = '';
  private lastSnapshotTs = 0;
  private unsubs: (() => void)[] = [];
  private lastError: string | null = null;

  constructor(private readonly deps: VpnModuleDeps = {}) {}

  init(ctx: EngineContext): void {
    this.ctx = ctx;
    this.log = ctx.log;
    this.mac = this.deps.mac ?? isMac();
    this.runner = this.deps.runner ?? new ProcessRunner(childTracker(ctx));
    try {
      this.adapters = ctx.db.latestSnapshot<AdapterSnapshot>('adapters')?.data?.adapters ?? [];
      const prev = ctx.db.latestSnapshot<VpnInfo>('vpn');
      if (prev && isRecord(prev.data) && Array.isArray(prev.data.otherTunnels)) {
        this.last = prev.data;
        this.lastSignature = vpnSignature(prev.data);
        this.lastSnapshotTs = prev.ts;
      }
    } catch {
      /* no snapshots yet */
    }
    this.unsubs.push(ctx.bus.on('adapters', (snap) => this.onAdapters(snap)));
    this.timer = new PollTimer({
      intervalMs: () => ctx.config().schedules.vpnPollSec * 1000,
      run: () => this.poll(),
      onError: (err) => {
        this.lastError = errorMessage(err);
        this.log?.debug('VPN-Abfrage fehlgeschlagen', { error: this.lastError });
      },
    });
    this.timer.start(4000);
  }

  reconfigure(): void {
    this.timer?.trigger(1000);
  }

  async runNow(): Promise<VpnInfo | null> {
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

  private tunnels(list: readonly AdapterInfo[], warpInstalled: boolean): string[] {
    return this.mac ? macOtherTunnels(list, { warpInstalled }) : otherTunnels(list);
  }

  /** re-check soon when a tunnel adapter or the WARP adapter changes state */
  private onAdapters(snap: AdapterSnapshot): void {
    const warpUp = (a: AdapterInfo) => (this.mac ? isWarpTunnel(a) : /cloudflare\s*warp/i.test(a.description)) && a.status === 'Up';
    const installed = this.last?.warp?.installed ?? false;
    const sig = (list: readonly AdapterInfo[]) => `${this.tunnels(list, installed).join('|')}#${list.some(warpUp)}`;
    const before = sig(this.adapters);
    this.adapters = snap.adapters;
    if (sig(this.adapters) !== before) this.timer?.trigger(1000);
  }

  private async warpCli(args: string[]): Promise<{ installed: boolean; json: unknown; error: string | null }> {
    const runner = this.runner;
    if (!runner) return { installed: false, json: null, error: 'nicht initialisiert' };
    const path = this.deps.warpCli ? await this.deps.warpCli() : this.mac ? await findMacWarpCli() : warpCliPath();
    if (path === null) return { installed: false, json: null, error: null };
    const r = await runner.run(path, ['-j', ...args], { timeoutMs: WARP_TIMEOUT_MS, maxBytes: 4 * 1024 * 1024, ...(this.mac ? { env: toolEnv() } : {}) });
    if (r.error?.code === 'ENOENT') return { installed: false, json: null, error: null };
    if (r.error) return { installed: true, json: null, error: errorMessage(r.error) };
    if (r.timedOut) return { installed: true, json: null, error: 'warp-cli: Zeitüberschreitung' };
    const json = extractJson(r.stdout.toString('utf8'));
    if (r.code !== 0 && json === null) {
      const msg = (r.stderr.toString('utf8') || r.stdout.toString('utf8')).replace(/\s+/g, ' ').trim().slice(0, 200);
      return { installed: true, json: null, error: `warp-cli ${r.code}: ${msg || 'Fehler'}` };
    }
    return { installed: true, json, error: null };
  }

  private async poll(): Promise<void> {
    const ctx = this.ctx;
    if (!ctx) return;
    const status = await this.warpCli(['status']);
    let settings: WarpSettings | null = null;
    let error = status.error;
    if (status.installed) {
      const st = await this.warpCli(['settings', 'list']);
      settings = parseWarpSettings(st.json);
      error = error ?? st.error;
    }
    const ts = Date.now();
    const info = buildVpnInfo(ts, { installed: status.installed, status: parseWarpStatus(status.json), settings }, this.tunnels(this.adapters, status.installed));
    for (const e of diffVpn(this.last, info)) ctx.recordEvent(e);
    const sig = vpnSignature(info);
    if (sig !== this.lastSignature || ts - this.lastSnapshotTs >= SNAPSHOT_EVERY_MS) {
      ctx.recordSnapshot('vpn', info, ts);
      this.lastSignature = sig;
      this.lastSnapshotTs = ts;
    }
    this.last = info;
    this.lastError = error;
  }
}

export function createVpnModule(deps: VpnModuleDeps = {}): EngineModule {
  return new VpnModule(deps);
}
