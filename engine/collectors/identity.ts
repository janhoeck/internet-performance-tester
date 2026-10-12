// Network identity + game detection (ARCHITECTURE §4.9), every identityPollSec:
//  - gateway MAC (neighbor cache for config.router.ip), DHCP server, DNS servers and IPv6 /64 prefix
//    of the interface towards the router (Get-NdIdentity via the PowerShell worker). State is kept per
//    interface (Ethernet and WLAN legitimately differ) in settings 'identity.state'; the first values
//    are just stored, later changes → identity_change events.
//  - running game processes (`tasklist /FO CSV /NH` vs config.gaming.processNames, case-insensitive)
//    → bus 'gaming', metric pc.gaming and 'gaming' episode events (ts … endTs).
import { decodeConsole } from '../../src/lib/shared/cp850';
import { expandIPv6, isGlobalV6, isIPv4 } from '../../src/lib/shared/net';
import type { ModuleState, NetEvent } from '../../src/lib/shared/types';
import type { EngineContext, EngineModule, Logger } from '../core/types';
import { PollTimer, ProcessRunner, asArray, asNumber, asString, childTracker, errorMessage, isRecord, psQuote, system32, timersState } from './util';

export const IDENTITY_SETTING = 'identity.state';
export const GAMING_SETTING = 'gaming.episode';
const TASKLIST = (): string => system32('tasklist.exe');

// ─── identity ──────────────────────────────────────────────────────────────

export interface IdentitySample {
  ts: number;
  ifAlias: string;
  ifIndex: number | null;
  gatewayMac: string | null;
  dhcpServer: string | null;
  dns: string[];
  v6Prefix: string | null;
}

export interface IdentityValues {
  gatewayMac: string | null;
  dhcpServer: string | null;
  dns: string[] | null;
  v6Prefix: string | null;
  ts: number;
}

export type IdentityState = Record<string, IdentityValues>;

const USABLE_NEIGHBOR = /^(reachable|stale|delay|probe|permanent)$/i;

/** 'dc-73-06-12-34-df' / 'DC:73:…' → 'DC-73-06-12-34-DF'; null for empty/incomplete entries */
export function normalizeMac(mac: string | null | undefined): string | null {
  if (!mac) return null;
  const hex = mac.replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  if (hex.length !== 12 || /^0+$/.test(hex) || /^F+$/.test(hex)) return null;
  return hex.match(/../g)?.join('-') ?? null;
}

/** /64 prefix(es) of global IPv6 addresses learned via router advertisement, e.g. '3fff:8071:7ca0:c980::/64' */
export function v6PrefixOf(addresses: readonly string[]): string | null {
  const set = new Set<string>();
  for (const ip of addresses) {
    if (!isGlobalV6(ip)) continue;
    const g = expandIPv6(ip);
    if (!g) continue;
    set.add(`${g.slice(0, 4).map((x) => x.replace(/^0+(?=.)/, '')).join(':')}::/64`);
  }
  return set.size ? [...set].sort().join(', ') : null;
}

/** JSON of Get-NdIdentity → sample (null when no route towards the router exists). */
export function parseIdentity(v: unknown, now: number): IdentitySample | null {
  if (!isRecord(v) || v.found !== true) return null;
  const ifAlias = asString(v.ifAlias);
  if (!ifAlias) return null;
  const ifIndex = asNumber(v.ifIndex);
  const neighbors = asArray(v.neighbors).filter(isRecord);
  const usable = neighbors.filter((n) => USABLE_NEIGHBOR.test(asString(n.state) ?? '') && normalizeMac(asString(n.mac)) !== null);
  const preferred = usable.find((n) => asNumber(n.ifIndex) === ifIndex) ?? usable[0];
  const dhcp = asString(v.dhcpServer);
  const dns = [...new Set(asArray(v.dns).map((d) => asString(d)?.trim() ?? '').filter((d) => d !== ''))];
  const v6 = asArray(v.v6)
    .filter(isRecord)
    .map((x) => asString(x.ip) ?? '')
    .filter((ip) => ip !== '');
  return {
    ts: asNumber(v.t) ?? now,
    ifAlias,
    ifIndex,
    gatewayMac: preferred ? normalizeMac(asString(preferred.mac)) : null,
    dhcpServer: dhcp && isIPv4(dhcp.trim()) && dhcp.trim() !== '255.255.255.255' ? dhcp.trim() : null,
    dns,
    v6Prefix: v6PrefixOf(v6),
  };
}

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && [...a].sort().join('|') === [...b].sort().join('|');

/**
 * identity_change events of one interface (first observation → no events) and the merged new state
 * (null values keep the previous value: a missing neighbor entry is not a change).
 */
export function diffIdentity(prev: IdentityValues | undefined, cur: IdentitySample, routerIp: string): { events: NetEvent[]; next: IdentityValues } {
  const next: IdentityValues = {
    gatewayMac: cur.gatewayMac ?? prev?.gatewayMac ?? null,
    dhcpServer: cur.dhcpServer ?? prev?.dhcpServer ?? null,
    dns: cur.dns.length ? cur.dns : (prev?.dns ?? null),
    v6Prefix: cur.v6Prefix ?? prev?.v6Prefix ?? null,
    ts: cur.ts,
  };
  const events: NetEvent[] = [];
  if (!prev) return { events, next };
  const ev = (severity: NetEvent['severity'], title: string, field: string, from: unknown, to: unknown): NetEvent => ({
    ts: cur.ts,
    type: 'identity_change',
    severity,
    segment: 'lan',
    title,
    details: { kind: field, field, from, to, interface: cur.ifAlias, routerIp },
    source: 'system',
  });
  const where = ` (${cur.ifAlias})`;
  if (prev.gatewayMac && cur.gatewayMac && prev.gatewayMac !== cur.gatewayMac) {
    events.push(ev('critical', `Router-MAC-Adresse geändert${where}`, 'gatewayMac', prev.gatewayMac, cur.gatewayMac));
  }
  if (prev.dhcpServer && cur.dhcpServer && prev.dhcpServer !== cur.dhcpServer) {
    events.push(ev('critical', `DHCP-Server geändert: ${prev.dhcpServer} → ${cur.dhcpServer}${where}`, 'dhcpServer', prev.dhcpServer, cur.dhcpServer));
  }
  if (prev.dns && prev.dns.length && cur.dns.length && !sameList(prev.dns, cur.dns)) {
    events.push(ev('warn', `DNS-Server geändert${where}`, 'dns', prev.dns, cur.dns));
  }
  if (prev.v6Prefix && cur.v6Prefix && prev.v6Prefix !== cur.v6Prefix) {
    events.push(ev('warn', `IPv6-Präfix geändert: ${prev.v6Prefix} → ${cur.v6Prefix}${where}`, 'v6Prefix', prev.v6Prefix, cur.v6Prefix));
  }
  return { events, next };
}

/** values that matter for persistence (ts excluded) */
export function identitySignature(v: IdentityValues | undefined): string {
  return v ? JSON.stringify([v.gatewayMac, v.dhcpServer, v.dns, v.v6Prefix]) : '';
}

export function parseIdentityState(json: string | null): IdentityState {
  if (!json) return {};
  try {
    const v: unknown = JSON.parse(json);
    if (!isRecord(v)) return {};
    const out: IdentityState = {};
    for (const [k, x] of Object.entries(v)) {
      if (!isRecord(x)) continue;
      out[k] = {
        gatewayMac: asString(x.gatewayMac),
        dhcpServer: asString(x.dhcpServer),
        dns: Array.isArray(x.dns) ? x.dns.filter((d): d is string => typeof d === 'string') : null,
        v6Prefix: asString(x.v6Prefix),
        ts: asNumber(x.ts) ?? 0,
      };
    }
    return out;
  } catch {
    return {};
  }
}

// ─── game detection ────────────────────────────────────────────────────────

/** Image names from `tasklist /FO CSV /NH` ("cs2.exe","1234","Console","1","123.456 K"). */
export function parseTasklistCsv(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*"((?:[^"]|"")*)"/.exec(line);
    if (m && m[1] !== '') out.push(m[1].replace(/""/g, '"'));
  }
  return out;
}

const normProc = (n: string) => {
  const s = n.trim().toLowerCase();
  return s.includes('.') ? s : `${s}.exe`;
};

/** First configured game (config order) that runs, as configured (lower case) – or null. */
export function detectGame(processes: readonly string[], configured: readonly string[]): string | null {
  const running = new Set(processes.map(normProc));
  for (const name of configured) {
    const n = normProc(name);
    if (n !== '.exe' && running.has(n)) return n;
  }
  return null;
}

export interface GamingEpisode {
  id: number | null;
  process: string;
  ts: number;
  lastSeen: number;
}

export function parseEpisode(json: string | null): GamingEpisode | null {
  if (!json) return null;
  try {
    const v: unknown = JSON.parse(json);
    if (!isRecord(v)) return null;
    const process = asString(v.process);
    const ts = asNumber(v.ts);
    if (!process || ts === null) return null;
    return { id: asNumber(v.id), process, ts, lastSeen: asNumber(v.lastSeen) ?? ts };
  } catch {
    return null;
  }
}

export function gamingEvent(process: string, ts: number): NetEvent {
  return {
    ts,
    endTs: null,
    type: 'gaming',
    severity: 'info',
    segment: 'client',
    title: `Spiel läuft: ${process}`,
    details: { process },
    source: 'system',
  };
}

// ─── module ────────────────────────────────────────────────────────────────

class IdentityModule implements EngineModule {
  readonly name = 'identity';
  private ctx: EngineContext | null = null;
  private log: Logger | null = null;
  private runner: ProcessRunner | null = null;
  private timer: PollTimer | null = null;
  private identity: IdentityState = {};
  private episode: GamingEpisode | null = null;
  private gamingKnown = false;
  private lastError: string | null = null;

  init(ctx: EngineContext): void {
    this.ctx = ctx;
    this.log = ctx.log;
    this.runner = new ProcessRunner(childTracker(ctx));
    this.identity = parseIdentityState(ctx.db.getSetting(IDENTITY_SETTING));
    this.episode = parseEpisode(ctx.db.getSetting(GAMING_SETTING));
    this.timer = new PollTimer({
      intervalMs: () => ctx.config().schedules.identityPollSec * 1000,
      run: () => this.poll(),
      onError: (err) => {
        this.lastError = errorMessage(err);
        this.log?.debug('Identitäts-/Spielerkennung fehlgeschlagen', { error: this.lastError });
      },
    });
    this.timer.start(3000);
  }

  start(): void {
    this.timer?.trigger(500);
  }

  reconfigure(): void {
    this.timer?.trigger(1000);
  }

  async runNow(): Promise<{ identity: IdentityState; gaming: string | null }> {
    await this.timer?.runNow();
    return { identity: this.identity, gaming: this.episode?.process ?? null };
  }

  dispose(): void {
    this.timer?.stop();
    this.runner?.killAll();
  }

  state(): ModuleState {
    return timersState(this.name, true, this.timer ? [this.timer] : [], this.lastError);
  }

  private async poll(): Promise<void> {
    const errors: string[] = [];
    try {
      await this.pollGames();
    } catch (err) {
      errors.push(`Spielerkennung: ${errorMessage(err)}`);
    }
    try {
      await this.pollIdentity();
    } catch (err) {
      errors.push(`Identität: ${errorMessage(err)}`);
    }
    this.lastError = errors.length ? errors.join('; ') : null;
  }

  private async pollIdentity(): Promise<void> {
    const ctx = this.ctx;
    if (!ctx) return;
    if (!ctx.ps.available) throw new Error('PowerShell nicht verfügbar');
    const routerIp = ctx.config().router.ip;
    const data = await ctx.ps.json<unknown>(`Get-NdIdentity -RouterIp ${psQuote(routerIp)}`, { timeoutMs: 20_000 });
    const sample = parseIdentity(data, Date.now());
    if (!sample) return; // no route towards the router right now (link down)
    const prev = this.identity[sample.ifAlias];
    const { events, next } = diffIdentity(prev, sample, routerIp);
    for (const e of events) ctx.recordEvent(e);
    this.identity[sample.ifAlias] = next;
    if (identitySignature(prev) !== identitySignature(next)) ctx.db.setSetting(IDENTITY_SETTING, JSON.stringify(this.identity));
  }

  private async pollGames(): Promise<void> {
    const ctx = this.ctx;
    const runner = this.runner;
    if (!ctx || !runner) return;
    const r = await runner.run(TASKLIST(), ['/FO', 'CSV', '/NH'], { timeoutMs: 15_000, maxBytes: 8 * 1024 * 1024 });
    if (r.error) throw r.error;
    if (r.timedOut || r.code !== 0) throw new Error(`tasklist ${r.timedOut ? 'Zeitüberschreitung' : `Exit-Code ${r.code}`}`);
    const now = Date.now();
    const game = detectGame(parseTasklistCsv(decodeConsole(new Uint8Array(r.stdout))), ctx.config().gaming.processNames);
    const ep = this.episode;
    const wasActive = this.gamingKnown ? ep !== null : null;

    if (ep && (game === null || game !== ep.process)) {
      // episode ended (after a restart while the game is gone: end at the last time it was seen)
      const endTs = this.gamingKnown ? now : ep.lastSeen;
      if (ep.id !== null) ctx.updateEvent(ep.id, { endTs, details: { process: ep.process, durationMs: Math.max(0, endTs - ep.ts) } });
      this.episode = null;
    }
    if (game !== null) {
      if (this.episode && this.episode.process === game) {
        this.episode.lastSeen = now;
      } else {
        const id = ctx.recordEvent(gamingEvent(game, now));
        this.episode = { id, process: game, ts: now, lastSeen: now };
      }
    }
    ctx.db.setSetting(GAMING_SETTING, this.episode ? JSON.stringify(this.episode) : null);

    const active = this.episode !== null;
    if (wasActive !== active || (this.episode && ep && this.episode.process !== ep.process)) {
      ctx.bus.emit('gaming', { active, process: this.episode?.process ?? null, ts: now });
      ctx.recordMetrics([{ ts: now, key: 'pc.gaming', value: active ? 1 : 0 }]);
    } else if (ctx.isMeasuring()) {
      ctx.recordMetrics([{ ts: now, key: 'pc.gaming', value: active ? 1 : 0 }]);
    }
    this.gamingKnown = true;
  }
}

export function createIdentityModule(): EngineModule {
  return new IdentityModule();
}
