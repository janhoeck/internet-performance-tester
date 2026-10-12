// Supervisor of the ICMP pinger agent: ONE long-running powershell.exe (-EncodedCommand) running
// engine/probes/pinger.ps1 for all ICMP targets + NIC link ticks (ARCHITECTURE §4.5).
//  - heartbeat watchdog: no `hb` line for 5 s → kill + restart (backoff 1, 2, 5, 10, 30 s)
//  - 3 failed starts in a row (no heartbeat) → ping.exe fallback; the agent is retried every 10 min
//  - config changes (targets, hosts, NICs, preventSleep) → restart with the new config
//  - planned restart once a day (keeps a week-long session fresh)
import { type ChildProcess, type SpawnOptions, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { ConsoleLineSplitter } from '../../src/lib/shared/cp850';
import { ipFamily } from '../../src/lib/shared/net';
import type { Logger, NicTick } from '../core/types';
import {
  type AgentConfig,
  type AgentEchoLine,
  agentArgs,
  agentConfigKey,
  agentEnv,
  buildAgentScript,
  encodePowerShellCommand,
  mapAgentRtt,
  mapAgentStatus,
  parseAgentLine,
  sanitizeAgentTargets,
} from './agent-protocol';
import { type IcmpEcho, RESTART_BACKOFF_MS, errorMessage, systemExe } from './common';
import { type FallbackHooks, type FallbackTarget, PingFallback } from './ping-fallback';

export type PingerMode = 'stopped' | 'starting' | 'agent' | 'fallback';

export interface PingerInfo {
  mode: PingerMode;
  pid: number | null;
  /** wall clock of the current agent start */
  startedAt: number | null;
  /** tick ts of the last heartbeat */
  lastHeartbeatTs: number | null;
  restarts: number;
  failedStarts: number;
  /** SetThreadExecutionState succeeded in the running agent (null = unknown / not requested) */
  preventSleepActive: boolean | null;
  /** German status text for the UI (null = all fine) */
  lastError: string | null;
}

export interface PingerHooks {
  log: Logger;
  onEcho(echo: IcmpEcho): void;
  onNic(tick: NicTick): void;
  /** normalized own address (see normalizeAddress) – failures "from" it are local ARP failures */
  isOwnAddress(normalizedIp: string): boolean;
  /** raw own addresses for the ping.exe fallback */
  ownAddresses(): readonly string[];
  trackChild?(child: ChildProcess): void;
  onModeChange?(mode: PingerMode): void;
}

export interface FallbackLike {
  start(targets: readonly FallbackTarget[]): void;
  update(targets: readonly FallbackTarget[]): void;
  stop(): void;
  runningIds(): string[];
}

export type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

export interface PingerOptions {
  powershellPath?: string;
  /** pinger.ps1 content (default: read next to this file) */
  scriptTemplate?: string;
  /** first heartbeat must arrive within this time (PowerShell start + Add-Type compile) */
  startupTimeoutMs?: number;
  heartbeatTimeoutMs?: number;
  backoffMs?: readonly number[];
  maxFailedStarts?: number;
  fallbackRetryMs?: number;
  /** a run this long resets the backoff */
  healthyResetMs?: number;
  /** planned restart after this agent age */
  maxAgentAgeMs?: number;
  spawnFn?: SpawnFn;
  createFallback?: (hooks: FallbackHooks) => FallbackLike;
  /** monotonic clock (ms) */
  now?: () => number;
}

const DEFAULTS = {
  startupTimeoutMs: 15_000,
  heartbeatTimeoutMs: 5000,
  maxFailedStarts: 3,
  fallbackRetryMs: 10 * 60_000,
  healthyResetMs: 60_000,
  maxAgentAgeMs: 24 * 3_600_000,
};

let cachedTemplate: string | null = null;

/** pinger.ps1 next to this module. */
export function loadPingerTemplate(): string {
  if (cachedTemplate === null) {
    cachedTemplate = readFileSync(fileURLToPath(new URL('./pinger.ps1', import.meta.url)), 'utf8');
  }
  return cachedTemplate;
}

/** Fallback targets derived from the agent config. */
export function fallbackTargets(cfg: AgentConfig): FallbackTarget[] {
  const out: FallbackTarget[] = [];
  for (const t of cfg.targets) {
    const family = ipFamily(t.ip);
    if (family === null) continue;
    out.push({ id: t.id, ip: t.ip, family, timeoutMs: t.to ?? cfg.timeoutMs });
  }
  return out;
}

export class PingerSupervisor {
  private cfg: AgentConfig | null = null;
  private key = '';
  private mode: PingerMode = 'stopped';
  private child: ChildProcess | null = null;
  private childPid: number | null = null;
  private spawnedMono = 0;
  private spawnedWall: number | null = null;
  private graceStartMono = 0;
  private gotHeartbeat = false;
  private lastHbMono = 0;
  private lastHbTs: number | null = null;
  private failedStarts = 0;
  private backoffIdx = 0;
  private restarts = 0;
  private plannedRestart = false;
  private killReason: string | null = null;
  private probing = false;
  private preventSleepActive: boolean | null = null;
  private lastError: string | null = null;
  private stderrTail = '';
  private restartTimer: NodeJS.Timeout | null = null;
  private fallbackRetryTimer: NodeJS.Timeout | null = null;
  private watchdog: NodeJS.Timeout | null = null;
  private lastWatchdogWall = 0;
  private fallback: FallbackLike | null = null;
  /** -EncodedCommand value (the script is constant, so it is encoded once) */
  private encoded: string | null = null;
  private readonly now: () => number;
  private readonly spawnFn: SpawnFn;
  private readonly backoff: readonly number[];
  private readonly o: typeof DEFAULTS;

  constructor(
    private readonly hooks: PingerHooks,
    private readonly opts: PingerOptions = {},
  ) {
    this.now = opts.now ?? (() => performance.now());
    this.spawnFn = opts.spawnFn ?? ((cmd, args, options) => spawn(cmd, [...args], options));
    this.backoff = opts.backoffMs ?? RESTART_BACKOFF_MS;
    this.o = {
      startupTimeoutMs: opts.startupTimeoutMs ?? DEFAULTS.startupTimeoutMs,
      heartbeatTimeoutMs: opts.heartbeatTimeoutMs ?? DEFAULTS.heartbeatTimeoutMs,
      maxFailedStarts: opts.maxFailedStarts ?? DEFAULTS.maxFailedStarts,
      fallbackRetryMs: opts.fallbackRetryMs ?? DEFAULTS.fallbackRetryMs,
      healthyResetMs: opts.healthyResetMs ?? DEFAULTS.healthyResetMs,
      maxAgentAgeMs: opts.maxAgentAgeMs ?? DEFAULTS.maxAgentAgeMs,
    };
  }

  /** Start supervising with `cfg` (no-op apart from `update` when already running). */
  start(cfg: AgentConfig): void {
    if (this.mode !== 'stopped') {
      this.update(cfg);
      return;
    }
    this.cfg = { ...cfg, targets: sanitizeAgentTargets(cfg.targets) };
    this.key = agentConfigKey(this.cfg);
    this.failedStarts = 0;
    this.backoffIdx = 0;
    this.lastError = null;
    this.setMode('starting');
    this.lastWatchdogWall = Date.now();
    this.watchdog = setInterval(() => this.checkWatchdog(), 1000);
    this.spawnAgent();
  }

  /** Apply a new config; restarts the agent only when something relevant changed. */
  update(cfg: AgentConfig): void {
    const next = { ...cfg, targets: sanitizeAgentTargets(cfg.targets) };
    const key = agentConfigKey(next);
    this.cfg = next;
    if (key === this.key || this.mode === 'stopped') {
      this.key = key;
      return;
    }
    this.key = key;
    if (this.mode === 'fallback') {
      this.fallback?.update(fallbackTargets(next));
      if (this.probing) this.killChild('Konfiguration geändert');
      return;
    }
    this.hooks.log.info('pinger: config changed – restarting agent');
    if (this.child) {
      this.plannedRestart = true;
      this.killChild('Konfiguration geändert');
    } else if (this.restartTimer) {
      // waiting for a backoff restart: start right away with the new config
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
      this.spawnAgent();
    }
  }

  stop(): void {
    if (this.mode === 'stopped') return;
    this.setMode('stopped');
    if (this.watchdog) clearInterval(this.watchdog);
    if (this.restartTimer) clearTimeout(this.restartTimer);
    if (this.fallbackRetryTimer) clearTimeout(this.fallbackRetryTimer);
    this.watchdog = this.restartTimer = this.fallbackRetryTimer = null;
    const child = this.child;
    this.child = null;
    this.childPid = null;
    this.probing = false;
    if (child) child.kill();
    this.fallback?.stop();
    this.fallback = null;
    this.preventSleepActive = null;
  }

  info(): PingerInfo {
    return {
      mode: this.mode,
      pid: this.childPid,
      startedAt: this.spawnedWall,
      lastHeartbeatTs: this.lastHbTs,
      restarts: this.restarts,
      failedStarts: this.failedStarts,
      preventSleepActive: this.preventSleepActive,
      lastError: this.lastError,
    };
  }

  /** ids measured right now (agent: all configured targets once healthy; fallback: live ping.exe processes) */
  activeTargetIds(): string[] {
    if (this.mode === 'agent') return (this.cfg?.targets ?? []).map((t) => t.id);
    if (this.mode === 'fallback') return this.fallback?.runningIds() ?? [];
    return [];
  }

  // ─── internals ───────────────────────────────────────────────────────────

  private setMode(mode: PingerMode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    this.hooks.onModeChange?.(mode);
  }

  private spawnAgent(): void {
    if (this.mode === 'stopped' || !this.cfg) return;
    let encoded: string;
    try {
      encoded = this.encoded ?? encodePowerShellCommand(buildAgentScript(this.opts.scriptTemplate ?? loadPingerTemplate()));
      this.encoded = encoded;
    } catch (err) {
      this.hooks.log.error('pinger: cannot build agent script', err);
      this.onStartFailed(`Skriptfehler: ${errorMessage(err)}`);
      return;
    }
    const psPath = this.opts.powershellPath ?? systemExe('WindowsPowerShell', 'v1.0', 'powershell.exe');
    let child: ChildProcess;
    try {
      child = this.spawnFn(psPath, agentArgs(encoded), {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: agentEnv(this.cfg, process.env),
      });
    } catch (err) {
      this.onStartFailed(`Start fehlgeschlagen: ${errorMessage(err)}`);
      return;
    }
    this.child = child;
    this.childPid = child.pid ?? null;
    this.spawnedMono = this.now();
    this.graceStartMono = this.spawnedMono;
    this.spawnedWall = Date.now();
    this.gotHeartbeat = false;
    this.killReason = null;
    this.plannedRestart = false;
    this.stderrTail = '';
    this.hooks.trackChild?.(child);
    const splitter = new ConsoleLineSplitter();
    child.stdout?.on('data', (chunk: Buffer) => {
      if (this.child !== child) return;
      for (const line of splitter.push(chunk)) this.handleLine(line);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString('utf8')).slice(-2000);
    });
    child.once('error', (err) => this.onChildGone(child, `Startfehler: ${err.message}`));
    child.once('close', (code, signal) => this.onChildGone(child, `Exit-Code ${code ?? signal ?? '?'}`));
  }

  private handleLine(line: string): void {
    const msg = parseAgentLine(line);
    if (!msg) {
      if (line.trim() !== '') this.hooks.log.debug(`pinger: unexpected output: ${line.slice(0, 200)}`);
      return;
    }
    switch (msg.k) {
      case 'hb':
        this.onHeartbeat(msg.ts);
        break;
      case 'icmp':
        if (!this.probing && this.gotHeartbeat) this.hooks.onEcho(this.mapEcho(msg));
        break;
      case 'nic':
        if (!this.probing) this.hooks.onNic(msg.tick);
        break;
      case 'hello':
        this.preventSleepActive = this.cfg?.preventSleep ? msg.sleep : null;
        this.hooks.log.info(`pinger: agent pid ${msg.pid ?? '?'} ready (preventSleep=${String(msg.sleep)})`);
        break;
      case 'warn':
        this.hooks.log.warn(`pinger agent: ${msg.msg}`);
        break;
    }
  }

  private mapEcho(m: AgentEchoLine): IcmpEcho {
    return {
      targetId: m.id,
      ts: m.ts,
      status: mapAgentStatus(m.st, m.from, this.hooks.isOwnAddress),
      rtt: mapAgentRtt(m.st, m.rtt),
    };
  }

  private onHeartbeat(ts: number): void {
    this.lastHbMono = this.now();
    this.lastHbTs = ts;
    if (this.gotHeartbeat) return;
    this.gotHeartbeat = true;
    this.failedStarts = 0;
    this.lastError = null;
    if (this.probing) {
      this.probing = false;
      this.fallback?.stop();
      this.fallback = null;
      this.hooks.log.info('pinger: agent works again – ping.exe fallback stopped');
    }
    this.setMode('agent');
  }

  private killChild(reason: string): void {
    if (!this.child) return;
    this.killReason = reason;
    this.child.kill();
  }

  private onChildGone(child: ChildProcess, reason: string): void {
    if (this.child !== child) return;
    this.child = null;
    this.childPid = null;
    const why = this.killReason ?? reason;
    const wasHealthy = this.gotHeartbeat;
    const ranMs = this.now() - this.spawnedMono;
    if (this.mode === 'stopped') return;
    const stderr = this.stderrTail.trim().slice(-500);
    if (stderr !== '') {
      // an agent that died on its own usually left a PowerShell error message
      if (this.killReason === null) this.hooks.log.warn(`pinger stderr: ${stderr}`);
      else this.hooks.log.debug(`pinger stderr: ${stderr}`);
    }

    if (this.probing) {
      this.probing = false;
      this.hooks.log.warn(`pinger: agent retry failed (${why}) – staying on ping.exe fallback`);
      this.scheduleFallbackRetry();
      return;
    }
    if (this.plannedRestart) {
      this.plannedRestart = false;
      this.setMode('starting');
      this.spawnAgent();
      return;
    }
    if (!wasHealthy) {
      this.onStartFailed(`Ping-Agent startet nicht (${why})`);
      return;
    }
    if (ranMs >= this.o.healthyResetMs) this.backoffIdx = 0;
    this.scheduleRestart(`Ping-Agent beendet (${why})`);
  }

  private onStartFailed(reason: string): void {
    if (this.probing || this.mode === 'fallback') {
      // a retry from fallback mode failed before the process even ran
      this.probing = false;
      this.hooks.log.warn(`pinger: agent retry failed (${reason}) – staying on ping.exe fallback`);
      this.scheduleFallbackRetry();
      return;
    }
    this.failedStarts++;
    if (this.failedStarts >= this.o.maxFailedStarts) {
      this.enterFallback(reason);
      return;
    }
    this.scheduleRestart(reason);
  }

  private scheduleRestart(reason: string): void {
    const delay = this.backoff[Math.min(this.backoffIdx, this.backoff.length - 1)];
    this.backoffIdx++;
    this.restarts++;
    this.lastError = `${reason} – Neustart in ${Math.round(delay / 1000)} s`;
    this.hooks.log.warn(`pinger: ${reason}; restart in ${delay} ms`);
    this.setMode('starting');
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.spawnAgent();
    }, delay);
  }

  private enterFallback(reason: string): void {
    if (!this.cfg) return;
    this.hooks.log.error(`pinger: ${reason} – ${this.failedStarts} failed starts, switching to ping.exe fallback`);
    this.lastError = 'Ping-Agent (PowerShell) startet nicht – Ersatzmessung mit ping.exe aktiv';
    this.setMode('fallback');
    const create = this.opts.createFallback ?? ((h: FallbackHooks) => new PingFallback(h));
    this.fallback = create({
      log: this.hooks.log,
      onEcho: (e) => this.hooks.onEcho(e),
      ownAddresses: () => this.hooks.ownAddresses(),
      trackChild: this.hooks.trackChild,
    });
    this.fallback.start(fallbackTargets(this.cfg));
    this.scheduleFallbackRetry();
  }

  private scheduleFallbackRetry(): void {
    if (this.fallbackRetryTimer) clearTimeout(this.fallbackRetryTimer);
    this.fallbackRetryTimer = setTimeout(() => {
      this.fallbackRetryTimer = null;
      if (this.mode !== 'fallback' || this.child) return;
      this.hooks.log.info('pinger: retrying the PowerShell agent');
      this.probing = true;
      this.spawnAgent();
    }, this.o.fallbackRetryMs);
  }

  private checkWatchdog(): void {
    const wall = Date.now();
    const gap = wall - this.lastWatchdogWall;
    this.lastWatchdogWall = wall;
    if (!this.child) return;
    const now = this.now();
    if (gap > 3000) {
      // the engine (or the whole PC) was suspended – give the agent a fresh grace period
      this.graceStartMono = now;
      this.lastHbMono = now;
      return;
    }
    if (!this.gotHeartbeat) {
      if (now - this.graceStartMono > this.o.startupTimeoutMs) this.killChild('kein Lebenszeichen nach dem Start');
      return;
    }
    if (now - Math.max(this.lastHbMono, this.graceStartMono) > this.o.heartbeatTimeoutMs) {
      this.lastError = 'Ping-Agent reagiert nicht (kein Lebenszeichen seit 5 s) – Neustart';
      this.killChild('Watchdog: kein Lebenszeichen');
      return;
    }
    if (now - this.spawnedMono > this.o.maxAgentAgeMs) {
      this.hooks.log.info('pinger: planned daily restart');
      this.plannedRestart = true;
      this.killChild('geplanter Neustart');
    }
  }
}
