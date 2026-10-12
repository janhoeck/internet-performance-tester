// Probes module (ARCHITECTURE §4.5): runs during a measurement session.
//  - ICMP: ONE PowerShell pinger agent for all enabled icmp targets (+ 1 Hz NIC link ticks),
//    ping.exe fallback handled by the supervisor (pinger.ts); on macOS one ping per target and
//    second scheduled by MacPinger (mac-pinger.ts)
//  - TCP / UDP-DNS / HTTP runners for the other enabled targets (grid-aligned intervals)
//  - 1 Hz egress interface check (bus 'egress')
// Dynamic hosts are resolved via ctx.hosts; an unresolved placeholder keeps its target idle until
// 'dynamicHosts' changes. Samples get the flags LOAD / FAILOVER / LATE.
import type { ChildProcess } from 'node:child_process';
import os from 'node:os';
import { type AppConfig, enabledTargets } from '../../src/lib/shared/config';
import type {
  AdapterSnapshot,
  ModuleState,
  ProbeState,
  Sample,
  SampleStatusCode,
  TargetConfig,
} from '../../src/lib/shared/types';
import { SampleStatus } from '../../src/lib/shared/types';
import type { EgressTick, EngineContext, EngineModule, Logger, NicTick } from '../core/types';
import { isMac } from '../platform';
import { type AgentConfig, type AgentTarget, DEFAULT_NICS, normalizeAddress } from './agent-protocol';
import { type IcmpEcho, type ProbeOutcome, RecentTimestamps, errorMessage, sampleFlags } from './common';
import { EgressChecker, type EgressHooks } from './egress';
import { buildProbeUrl, httpProbe } from './http';
import { MacPinger } from './mac-pinger';
import { type PingerHooks, type PingerInfo, PingerSupervisor } from './pinger';
import { HostCache, pendingText, targetAddress } from './resolve';
import { IntervalRunner, staggerOffset } from './runner';
import { tcpConnectProbe } from './tcp';
import { type DnsProbeResult, type DnsQuestionSpec, UdpDnsClient, questionForQuery } from './udp-dns';

export interface ProbesModule extends EngineModule {
  /** live state of every enabled target (EngineStatus.probes) */
  probeStates(): ProbeState[];
  /** Cloudflare PoP per udp-dns target from the id.server TXT answer, e.g. { 'cf4-udp': 'dus01' } */
  popNames(): Record<string, string>;
  /** pinger agent status (mode, heartbeat, restarts, preventSleep) – null outside a session */
  pingerInfo(): PingerInfo | null;
}

export interface PingerLike {
  start(cfg: AgentConfig): void;
  update(cfg: AgentConfig): void;
  stop(): void;
  info(): PingerInfo;
  activeTargetIds(): string[];
}

export interface EgressLike {
  start(): void;
  stop(): void;
}

export interface DnsClientLike {
  readonly server: string;
  query(timeoutMs: number): Promise<DnsProbeResult>;
  close(): void;
}

export interface ProbesDeps {
  createPinger(hooks: PingerHooks): PingerLike;
  createEgress(hooks: EgressHooks): EgressLike;
  tcpProbe(ip: string, port: number, timeoutMs: number): Promise<ProbeOutcome>;
  httpProbe(url: string, timeoutMs: number): Promise<ProbeOutcome>;
  createDnsClient(server: string, port: number, family: 4 | 6, q: DnsQuestionSpec): DnsClientLike;
  hostCache: Pick<HostCache, 'resolve' | 'resolveAll' | 'peek'>;
  liveInterfaces(): NodeJS.Dict<os.NetworkInterfaceInfo[]>;
}

/** ICMP pinger of this platform: PowerShell agent supervisor (Windows) or MacPinger (macOS). */
export function createDefaultPinger(hooks: PingerHooks): PingerLike {
  return isMac() ? new MacPinger(hooks) : new PingerSupervisor(hooks);
}

const DEFAULT_DEPS: ProbesDeps = {
  createPinger: createDefaultPinger,
  createEgress: (hooks) => new EgressChecker(hooks),
  tcpProbe: tcpConnectProbe,
  httpProbe,
  createDnsClient: (server, port, family, q) => new UdpDnsClient(server, port, family, q),
  hostCache: new HostCache(),
  liveInterfaces: () => os.networkInterfaces(),
};

/** ICMP hostnames are re-resolved this often (restart only when the old IP disappeared). */
const ICMP_DNS_REFRESH_MS = 10 * 60_000;
const ICMP_DNS_RETRY_MS = 60_000;
const OWN_ADDR_TTL_MS = 30_000;
const MAX_NICS = 8;

/** Physical adapters of a snapshot (+ the expected interface), sorted; default Ethernet + WLAN. */
export function nicNamesFor(snapshot: AdapterSnapshot | null, expectedIf: string | null): string[] {
  const names = new Map<string, string>();
  for (const a of snapshot?.adapters ?? []) {
    const n = a.name.trim();
    if (!a.isVirtual && n !== '') names.set(n.toLowerCase(), n);
  }
  if (names.size === 0) for (const n of DEFAULT_NICS) names.set(n.toLowerCase(), n);
  if (expectedIf && expectedIf.trim() !== '') names.set(expectedIf.trim().toLowerCase(), expectedIf.trim());
  return [...names.values()].sort((a, b) => a.localeCompare(b)).slice(0, MAX_NICS);
}

/** Fields that require a new runner when they change. */
export function runnerSignature(t: TargetConfig): string {
  return JSON.stringify([t.kind, t.host, t.family, t.port ?? null, t.path ?? null, t.query ?? null, t.intervalMs, t.timeoutMs]);
}

interface RunnerEntry {
  target: TargetConfig;
  signature: string;
  runner: IntervalRunner;
  dns: DnsClientLike | null;
}

interface IcmpDnsEntry {
  host: string;
  family: 4 | 6;
  ip: string | null;
  error: string | null;
  inflight: boolean;
  resolvedAt: number;
  retryAt: number;
}

function emptyState(targetId: string): ProbeState {
  return { targetId, resolvedHost: null, running: false, lastTs: null, lastRtt: null, lastStatus: null, error: null };
}

class ProbesManager implements ProbesModule {
  readonly name = 'probes';
  private ctx: EngineContext | null = null;
  private log: Logger | null = null;
  private active = false;
  private generation = 0;
  private unsubs: (() => void)[] = [];
  private adapters: AdapterSnapshot | null = null;
  private pinger: PingerLike | null = null;
  private egress: EgressLike | null = null;
  private readonly runners = new Map<string, RunnerEntry>();
  private readonly states = new Map<string, ProbeState>();
  private readonly icmpDns = new Map<string, IcmpDnsEntry>();
  private readonly pops = new Map<string, string>();
  /** recently recorded ICMP ts per target (drops duplicates on agent ⇄ fallback switches) */
  private readonly recentIcmp = new RecentTimestamps(8);
  private icmpDnsTimer: NodeJS.Timeout | null = null;
  private ownCache: { at: number; set: Set<string>; list: string[] } | null = null;
  private lastSampleTs: number | null = null;
  private lastError: string | null = null;
  private readonly deps: ProbesDeps;

  constructor(deps: Partial<ProbesDeps>) {
    this.deps = { ...DEFAULT_DEPS, ...deps };
  }

  // ─── lifecycle ───────────────────────────────────────────────────────────

  init(ctx: EngineContext): void {
    this.ctx = ctx;
    // the context handed to a module already logs with the module scope ('probes')
    this.log = ctx.log;
    this.adapters = this.loadSnapshot();
    this.unsubs.push(
      ctx.bus.on('adapters', (snap) => this.onAdapters(snap)),
      ctx.bus.on('dynamicHosts', () => {
        if (this.active) this.refreshPinger(ctx.config());
      }),
    );
  }

  start(): void {
    const ctx = this.ctx;
    if (!ctx || this.active) return;
    this.active = true;
    this.generation++;
    this.lastError = null;
    if (!this.adapters) this.adapters = this.loadSnapshot();
    const cfg = ctx.config();
    this.refreshPinger(cfg);
    this.syncRunners(cfg);
    this.egress = this.deps.createEgress({
      onTick: (tick) => this.onEgress(tick),
      adapters: () => this.adapters?.adapters ?? null,
      onError: (err) => this.log?.warn('egress check failed', err),
    });
    this.egress.start();
    this.icmpDnsTimer = setInterval(() => this.refreshIcmpDns(), 30_000);
    this.log?.info(`probes started (${enabledTargets(cfg).length} targets)`);
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    this.generation++;
    this.pinger?.stop();
    this.pinger = null;
    for (const id of [...this.runners.keys()]) this.stopRunner(id);
    this.egress?.stop();
    this.egress = null;
    if (this.icmpDnsTimer) clearInterval(this.icmpDnsTimer);
    this.icmpDnsTimer = null;
    for (const s of this.states.values()) s.running = false;
    this.log?.info('probes stopped');
  }

  dispose(): void {
    this.stop();
    for (const u of this.unsubs) u();
    this.unsubs = [];
  }

  reconfigure(cfg: AppConfig): void {
    this.pruneStates(cfg);
    if (!this.active) return;
    this.refreshPinger(cfg);
    this.syncRunners(cfg);
  }

  state(): ModuleState {
    const info = this.pinger?.info() ?? null;
    return {
      name: this.name,
      enabled: true,
      running: this.active,
      busy: false,
      lastRunTs: this.lastSampleTs,
      nextRunTs: null,
      lastError: info?.lastError ?? this.lastError,
    };
  }

  probeStates(): ProbeState[] {
    const ctx = this.ctx;
    if (!ctx) return [];
    const pingerActive = new Set(this.pinger?.activeTargetIds() ?? []);
    return enabledTargets(ctx.config()).map((t) => {
      const s = { ...(this.states.get(t.id) ?? emptyState(t.id)) };
      const pop = this.pops.get(t.id);
      if (pop) s.info = `Cloudflare-Standort ${pop}`;
      else if (t.kind === 'icmp' && this.pinger?.info().mode === 'fallback') s.info = 'Ersatzmessung (ping.exe)';
      if (!this.active) s.running = false;
      else if (t.kind === 'icmp') s.running = s.resolvedHost !== null && pingerActive.has(t.id);
      else s.running = this.runners.has(t.id) && s.resolvedHost !== null;
      return s;
    });
  }

  popNames(): Record<string, string> {
    return Object.fromEntries(this.pops);
  }

  pingerInfo(): PingerInfo | null {
    return this.pinger?.info() ?? null;
  }

  // ─── ICMP agent ──────────────────────────────────────────────────────────

  private loadSnapshot(): AdapterSnapshot | null {
    try {
      return this.ctx?.db.latestSnapshot<AdapterSnapshot>('adapters')?.data ?? null;
    } catch {
      return null;
    }
  }

  private onAdapters(snap: AdapterSnapshot): void {
    this.adapters = snap;
    this.ownCache = null;
    if (this.active && this.ctx) this.refreshPinger(this.ctx.config());
  }

  private agentConfig(cfg: AppConfig): AgentConfig {
    const targets: AgentTarget[] = [];
    for (const t of enabledTargets(cfg)) {
      if (t.kind !== 'icmp') continue;
      const st = this.stateOf(t.id);
      const ip = this.icmpAddress(t, st);
      st.resolvedHost = ip;
      if (ip === null) continue;
      const every = Math.max(1, Math.round(t.intervalMs / 1000));
      targets.push({ id: t.id, ip, ...(every > 1 ? { every } : {}), ...(t.timeoutMs !== 2000 ? { to: t.timeoutMs } : {}) });
    }
    return {
      targets,
      intervalMs: 1000,
      timeoutMs: 2000,
      size: 32,
      nics: nicNamesFor(this.adapters, this.ctx?.expectedInterface() ?? null),
      preventSleep: cfg.session.preventSleep,
      ppid: process.pid,
    };
  }

  /** IP for an icmp target or null (pending placeholder / DNS lookup running or failed). */
  private icmpAddress(t: TargetConfig, st: ProbeState): string | null {
    const ctx = this.ctx;
    if (!ctx) return null;
    const addr = targetAddress(ctx.hosts, t);
    if (addr.kind === 'pending') {
      st.error = pendingText(addr.placeholder);
      return null;
    }
    if (addr.kind === 'ip') {
      if (st.error !== null && st.lastStatus === null) st.error = null;
      return addr.ip;
    }
    const e = this.icmpDns.get(t.id);
    if (e && e.host === addr.host && e.family === t.family) {
      if (e.ip) return e.ip;
      st.error = e.error ?? 'DNS-Auflösung läuft …';
      return null;
    }
    this.icmpDns.set(t.id, { host: addr.host, family: t.family, ip: null, error: null, inflight: false, resolvedAt: 0, retryAt: 0 });
    st.error = 'DNS-Auflösung läuft …';
    this.resolveIcmpHost(t.id);
    return null;
  }

  private resolveIcmpHost(id: string): void {
    const e = this.icmpDns.get(id);
    if (!e || e.inflight) return;
    e.inflight = true;
    const gen = this.generation;
    this.deps.hostCache
      .resolveAll(e.host, e.family)
      .then((ips) => {
        e.error = null;
        e.resolvedAt = Date.now();
        if (e.ip === null || !ips.includes(e.ip)) e.ip = ips[0];
      })
      .catch((err: unknown) => {
        e.error = errorMessage(err);
        e.retryAt = Date.now() + ICMP_DNS_RETRY_MS;
        const st = this.states.get(id);
        if (st) st.error = e.error;
      })
      .finally(() => {
        e.inflight = false;
        if (this.active && gen === this.generation && this.ctx) this.refreshPinger(this.ctx.config());
      });
  }

  private refreshIcmpDns(): void {
    const now = Date.now();
    for (const [id, e] of this.icmpDns) {
      if (e.inflight) continue;
      if ((e.ip === null && now >= e.retryAt) || (e.ip !== null && now - e.resolvedAt >= ICMP_DNS_REFRESH_MS)) this.resolveIcmpHost(id);
    }
  }

  private refreshPinger(cfg: AppConfig): void {
    if (!this.active || !this.ctx) return;
    const agentCfg = this.agentConfig(cfg);
    if (this.pinger) {
      this.pinger.update(agentCfg);
      return;
    }
    const ctx = this.ctx;
    const log = this.log ?? ctx.log;
    this.pinger = this.deps.createPinger({
      log: log.child('pinger'),
      onEcho: (e) => this.onEcho(e),
      onNic: (tick) => this.onNic(tick),
      isOwnAddress: (ip) => this.ownAddresses().set.has(ip),
      ownAddresses: () => this.ownAddresses().list,
      trackChild: (child: ChildProcess) => ctx.trackChild(child),
      onModeChange: (mode) => log.info(`pinger mode: ${mode}`),
    });
    this.pinger.start(agentCfg);
  }

  private onEcho(e: IcmpEcho): void {
    const ctx = this.ctx;
    if (!this.active || !ctx) return;
    const t = ctx.config().targets.find((x) => x.id === e.targetId);
    if (!t || !t.enabled || t.kind !== 'icmp') return;
    if (!this.recentIcmp.add(t.id, e.ts)) return;
    this.record(t.id, e.ts, { status: e.status, rtt: e.rtt });
  }

  private onNic(tick: NicTick): void {
    if (!this.active || !this.ctx) return;
    this.ctx.bus.emit('nic', tick);
  }

  private onEgress(tick: EgressTick): void {
    if (!this.active || !this.ctx) return;
    this.ctx.bus.emit('egress', tick);
  }

  /** Own addresses (adapters snapshot + live interfaces), normalized set + raw list. */
  private ownAddresses(): { set: Set<string>; list: string[] } {
    const now = Date.now();
    if (this.ownCache && now - this.ownCache.at < OWN_ADDR_TTL_MS) return this.ownCache;
    const list: string[] = [];
    for (const a of this.adapters?.adapters ?? []) list.push(...(a.addresses ?? []));
    try {
      for (const infos of Object.values(this.deps.liveInterfaces())) {
        for (const i of infos ?? []) if (!i.internal) list.push(i.address);
      }
    } catch {
      // ignore – snapshot addresses are enough
    }
    const set = new Set<string>();
    for (const a of list) {
      try {
        set.add(normalizeAddress(a));
      } catch {
        // skip malformed
      }
    }
    this.ownCache = { at: now, set, list };
    return this.ownCache;
  }

  // ─── TCP / UDP-DNS / HTTP runners ────────────────────────────────────────

  private syncRunners(cfg: AppConfig): void {
    const wanted = new Map(enabledTargets(cfg).filter((t) => t.kind !== 'icmp').map((t) => [t.id, t]));
    for (const [id, entry] of this.runners) {
      const t = wanted.get(id);
      if (!t || runnerSignature(t) !== entry.signature) this.stopRunner(id);
    }
    for (const t of wanted.values()) {
      if (this.runners.has(t.id)) {
        // same signature – keep the runner, refresh metadata (name, segment …)
        const entry = this.runners.get(t.id);
        if (entry) entry.target = t;
        continue;
      }
      const entry: RunnerEntry = { target: t, signature: runnerSignature(t), runner: null as unknown as IntervalRunner, dns: null };
      entry.runner = new IntervalRunner(
        t.intervalMs,
        staggerOffset(t.id, t.intervalMs),
        (ts) => this.probeOnce(entry, ts),
        (err) => this.log?.warn(`probe ${t.id} failed`, err),
      );
      this.runners.set(t.id, entry);
      this.stateOf(t.id);
      entry.runner.start();
    }
  }

  private stopRunner(id: string): void {
    const entry = this.runners.get(id);
    if (!entry) return;
    this.runners.delete(id);
    entry.runner.stop();
    entry.dns?.close();
    entry.dns = null;
  }

  private isCurrent(entry: RunnerEntry): boolean {
    return this.active && this.runners.get(entry.target.id) === entry;
  }

  /** Resolve the address of a runner target; null = idle (state updated). */
  private async runnerAddress(t: TargetConfig): Promise<string | null> {
    const ctx = this.ctx;
    if (!ctx) return null;
    const st = this.stateOf(t.id);
    const addr = targetAddress(ctx.hosts, t);
    if (addr.kind === 'pending') {
      st.resolvedHost = null;
      st.error = pendingText(addr.placeholder);
      return null;
    }
    if (addr.kind === 'ip') return addr.ip;
    if (t.kind === 'http') return addr.host; // fetch resolves itself (TLS needs the name)
    try {
      return await this.deps.hostCache.resolve(addr.host, t.family);
    } catch (err) {
      st.resolvedHost = null;
      st.error = errorMessage(err);
      return null;
    }
  }

  private async probeOnce(entry: RunnerEntry, ts: number): Promise<void> {
    const t = entry.target;
    const host = await this.runnerAddress(t);
    if (host === null || !this.isCurrent(entry)) return;
    const st = this.stateOf(t.id);
    st.resolvedHost = host;
    let outcome: ProbeOutcome;
    switch (t.kind) {
      case 'tcp':
        outcome = await this.deps.tcpProbe(host, t.port ?? 443, t.timeoutMs);
        break;
      case 'http':
        outcome = await this.deps.httpProbe(buildProbeUrl(host, t.port, t.path), t.timeoutMs);
        break;
      case 'udp-dns': {
        if (!entry.dns || entry.dns.server !== host) {
          entry.dns?.close();
          entry.dns = this.deps.createDnsClient(host, t.port ?? 53, t.family, questionForQuery(t.query));
        }
        const r = await entry.dns.query(t.timeoutMs);
        if (!this.isCurrent(entry)) return;
        if (r.status === SampleStatus.OK && r.txt.length > 0 && questionForQuery(t.query).name === 'id.server') {
          this.pops.set(t.id, r.txt[0]);
        }
        if (r.first) {
          // first answer after (re)start includes the NAT/AFTR mapping creation – not recorded
          st.error = r.error ?? null;
          return;
        }
        outcome = r;
        break;
      }
      default:
        return;
    }
    if (!this.isCurrent(entry)) return;
    if (outcome.discard) {
      st.error = outcome.error ?? null;
      return;
    }
    this.record(t.id, ts, outcome);
  }

  // ─── samples & state ─────────────────────────────────────────────────────

  private record(targetId: string, ts: number, outcome: ProbeOutcome): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const ok = outcome.status === SampleStatus.OK;
    const rtt = ok ? outcome.rtt : null;
    const sample: Sample = {
      ts,
      targetId,
      rtt,
      status: outcome.status,
      flags: sampleFlags(rtt, { load: ctx.speedtestActive(), failover: ctx.clientState()?.onExpected === false }),
    };
    try {
      ctx.recordSample(sample);
    } catch (err) {
      this.lastError = `Messwert konnte nicht gespeichert werden: ${errorMessage(err)}`;
      this.log?.error('recordSample failed', err);
    }
    const st = this.stateOf(targetId);
    st.lastTs = ts;
    st.lastRtt = rtt;
    st.lastStatus = outcome.status as SampleStatusCode;
    st.error = outcome.error ?? null;
    if (this.lastSampleTs === null || ts > this.lastSampleTs) this.lastSampleTs = ts;
  }

  private stateOf(id: string): ProbeState {
    let s = this.states.get(id);
    if (!s) {
      s = emptyState(id);
      this.states.set(id, s);
    }
    return s;
  }

  private pruneStates(cfg: AppConfig): void {
    const ids = new Set(enabledTargets(cfg).map((t) => t.id));
    for (const id of [...this.states.keys()]) {
      if (ids.has(id)) continue;
      this.states.delete(id);
      this.recentIcmp.delete(id);
    }
    for (const id of [...this.icmpDns.keys()]) if (!ids.has(id)) this.icmpDns.delete(id);
    for (const id of [...this.pops.keys()]) if (!ids.has(id)) this.pops.delete(id);
  }
}

export function createProbesModule(deps: Partial<ProbesDeps> = {}): ProbesModule {
  return new ProbesManager(deps);
}
