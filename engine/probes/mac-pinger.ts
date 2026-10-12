// ICMP pinger for macOS (docs/research/macos.md §2): Node keeps the fixed 1 Hz grid on whole seconds
// and spawns ONE `/sbin/ping -c 1` (IPv4) or `/sbin/ping6 -c 1` (IPv6) per target and tick – Node
// cannot send ICMP itself, and a long-running `ping -i 1` drifts off the grid. ping is setuid root
// and measures the RTT itself, so the spawn latency does not distort it. Each child is killed
// `timeout + 500 ms` after the spawn; the sample ts is the scheduled tick.
//  - NIC link ticks once per tick from `ifconfig -a` + `netstat -ibn` (MacInterfaceCatalog)
//  - preventSleep: `/usr/bin/caffeinate -i -w <engine pid>` while running (ends with the engine)
// Same PingerHooks / PingerInfo as the Windows supervisor (pinger.ts), so manager.ts is unchanged.
import { type ChildProcess, spawn } from 'node:child_process';
import { ipFamily } from '../../src/lib/shared/net';
import type { MacInterface } from '../../src/lib/shared/parsers/macos/interfaces';
import { macPingRtt, macPingStatus, parseMacPing } from '../../src/lib/shared/parsers/macos/ping';
import { MacInterfaceCatalog } from '../collectors/macos/interfaces';
import { MAC_TOOLS, toolEnv } from '../collectors/macos/tools';
import { ProcessRunner } from '../collectors/util';
import type { NicTick } from '../core/types';
import { type AgentConfig, type AgentTarget, normalizeAddress, sanitizeAgentTargets } from './agent-protocol';
import { errorMessage } from './common';
import type { PingerHooks, PingerInfo, PingerMode, SpawnFn } from './pinger';
import { IntervalRunner } from './runner';

export interface MacPingerOptions {
  spawnFn?: SpawnFn;
  /** interface list for the NIC ticks (default: MacInterfaceCatalog on a tracked ProcessRunner) */
  readInterfaces?: () => Promise<readonly MacInterface[]>;
  /** a ping child is killed this long after its timeout (default 500 ms) */
  killGraceMs?: number;
  /** caffeinate is started again this long after it exited unexpectedly (default 30 s) */
  caffeinateRetryMs?: number;
  /** consecutive failed interface reads before lastError is set (default 3) */
  nicFailuresForError?: number;
  /** process watched by caffeinate -w (default: this engine) */
  pid?: number;
}

const MAX_NICS = 8;

/** ping / ping6 arguments for one echo (ping6's -W means something else, its timeout is ours). */
export function macPingArgs(ip: string, family: 4 | 6, size: number, timeoutMs: number): string[] {
  const base = ['-n', '-c', '1', '-s', String(size)];
  return family === 6 ? [...base, ip] : [...base, '-W', String(Math.max(1, Math.round(timeoutMs))), ip];
}

/** 1 Hz link tick of one interface (null without counters – rates would be wrong). */
export function nicTickOf(i: MacInterface, ts: number): NicTick | null {
  const c = i.counters;
  if (!c) return null;
  const up = i.status === 'Up';
  return {
    ts,
    name: i.name,
    up,
    mbps: up && !i.isWifi && i.mediaMbps !== null && i.mediaMbps > 0 ? i.mediaMbps : null,
    rxBytes: c.ibytes,
    txBytes: c.obytes,
    rxErrors: c.ierrs,
    rxDiscards: c.drops ?? 0,
    isWifi: i.isWifi,
  };
}

/**
 * Interfaces reported as NIC ticks: the configured names (shown name or BSD name). When none of
 * them exists (no adapters snapshot yet – the defaults are Windows names), all physical interfaces.
 */
export function nicsToReport(list: readonly MacInterface[], names: readonly string[]): MacInterface[] {
  const out: MacInterface[] = [];
  for (const raw of names) {
    const n = raw.trim().toLowerCase();
    const i = list.find((x) => x.name.toLowerCase() === n) ?? list.find((x) => x.device.toLowerCase() === n);
    if (i && !out.includes(i)) out.push(i);
  }
  if (out.length > 0) return out;
  return list.filter((i) => !i.isVirtual).slice(0, MAX_NICS);
}

export class MacPinger {
  private cfg: AgentConfig | null = null;
  private mode: PingerMode = 'stopped';
  private runner: IntervalRunner | null = null;
  private generation = 0;
  private readonly inflight = new Set<ChildProcess>();
  private procRunner: ProcessRunner | null = null;
  private catalog: MacInterfaceCatalog | null = null;
  private nicBusy = false;
  private nicFailures = 0;
  private nicError: string | null = null;
  private pingError: string | null = null;
  private caffeinate: ChildProcess | null = null;
  private caffeinateTimer: NodeJS.Timeout | null = null;
  private startedAt: number | null = null;
  private lastTickTs: number | null = null;
  private readonly spawnFn: SpawnFn;
  private readonly graceMs: number;

  constructor(
    private readonly hooks: PingerHooks,
    private readonly opts: MacPingerOptions = {},
  ) {
    this.spawnFn = opts.spawnFn ?? ((cmd, args, options) => spawn(cmd, [...args], options));
    this.graceMs = opts.killGraceMs ?? 500;
  }

  start(cfg: AgentConfig): void {
    if (this.mode !== 'stopped') {
      this.update(cfg);
      return;
    }
    this.cfg = { ...cfg, targets: sanitizeAgentTargets(cfg.targets) };
    this.generation++;
    this.mode = 'agent';
    this.startedAt = Date.now();
    this.pingError = this.nicError = null;
    this.nicFailures = 0;
    if (!this.opts.readInterfaces) {
      this.procRunner = new ProcessRunner((child) => this.hooks.trackChild?.(child));
      this.catalog = new MacInterfaceCatalog(this.procRunner);
    }
    this.hooks.log.info(`pinger (macOS): ${this.cfg.targets.length} targets, one ping per target and second`);
    this.hooks.onModeChange?.('agent');
    if (this.cfg.preventSleep) this.startCaffeinate();
    this.runner = new IntervalRunner(
      1000,
      0,
      (ts) => this.tick(ts),
      (err) => this.hooks.log.warn('pinger tick failed', err),
    );
    this.runner.start();
  }

  update(cfg: AgentConfig): void {
    const next = { ...cfg, targets: sanitizeAgentTargets(cfg.targets) };
    const prev = this.cfg;
    this.cfg = next;
    if (this.mode === 'stopped') return;
    if (next.preventSleep && !prev?.preventSleep) this.startCaffeinate();
    else if (!next.preventSleep && prev?.preventSleep) this.stopCaffeinate();
  }

  stop(): void {
    if (this.mode === 'stopped') return;
    this.mode = 'stopped';
    this.generation++;
    this.runner?.stop();
    this.runner = null;
    for (const child of this.inflight) killQuietly(child);
    this.inflight.clear();
    this.procRunner?.killAll();
    this.procRunner = null;
    this.catalog = null;
    this.nicBusy = false;
    this.stopCaffeinate();
    this.hooks.onModeChange?.('stopped');
  }

  info(): PingerInfo {
    return {
      mode: this.mode,
      pid: null,
      startedAt: this.startedAt,
      lastHeartbeatTs: this.lastTickTs,
      restarts: 0,
      failedStarts: 0,
      preventSleepActive: this.mode !== 'stopped' && this.cfg?.preventSleep ? this.caffeinate !== null : null,
      lastError: this.pingError ?? this.nicError,
    };
  }

  activeTargetIds(): string[] {
    return this.mode === 'agent' ? (this.cfg?.targets ?? []).map((t) => t.id) : [];
  }

  // ─── ticks ───────────────────────────────────────────────────────────────

  private tick(ts: number): void {
    const cfg = this.cfg;
    if (!cfg || this.mode === 'stopped') return;
    this.lastTickTs = ts;
    const sec = Math.round(ts / 1000);
    for (const t of cfg.targets) {
      const every = t.every ?? 1;
      if (every > 1 && sec % every !== 0) continue;
      this.ping(t, ts, cfg);
    }
    this.readNics(ts, cfg);
  }

  private ping(t: AgentTarget, ts: number, cfg: AgentConfig): void {
    const family = ipFamily(t.ip);
    if (family === null) return;
    const timeoutMs = t.to ?? cfg.timeoutMs;
    const gen = this.generation;
    let child: ChildProcess;
    try {
      child = this.spawnFn(family === 6 ? MAC_TOOLS.ping6 : MAC_TOOLS.ping, macPingArgs(t.ip, family, cfg.size, timeoutMs), {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: toolEnv(),
        windowsHide: true,
      });
    } catch (err) {
      this.spawnFailed(err);
      return;
    }
    this.inflight.add(child);
    try {
      this.hooks.trackChild?.(child);
    } catch {
      // tracking is best effort
    }
    // separate buffers: interleaved stdout/stderr chunks must not split lines
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout?.on('data', (c: Buffer) => out.push(c));
    child.stderr?.on('data', (c: Buffer) => err.push(c));
    let done = false;
    const timer = setTimeout(() => killQuietly(child), timeoutMs + this.graceMs);
    const finish = (spawnErr: unknown) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      this.inflight.delete(child);
      if (gen !== this.generation) return;
      if (spawnErr !== null) {
        this.spawnFailed(spawnErr);
        return;
      }
      const r = parseMacPing(`${Buffer.concat(out).toString('utf8')}\n${Buffer.concat(err).toString('utf8')}`, family);
      if (r.usage) {
        // a tool problem, not a network result – no sample (like a missing Windows agent heartbeat)
        this.setPingError(`Ping wurde mit ungültigen Argumenten aufgerufen (${r.error ?? 'usage'})`);
        return;
      }
      if (this.pingError !== null) this.hooks.log.info('pinger: ping works again');
      this.pingError = null;
      const status = macPingStatus(r, timeoutMs, (ip) => this.isOwn(ip));
      this.hooks.onEcho({ targetId: t.id, ts, status, rtt: macPingRtt(r, status) });
    };
    child.once('error', (err) => finish(err));
    child.once('close', () => finish(null));
  }

  private isOwn(ip: string): boolean {
    try {
      return this.hooks.isOwnAddress(normalizeAddress(ip));
    } catch {
      return false;
    }
  }

  /**
   * ping could not even be started (ENOENT, EAGAIN …): the second is not measured, so no sample is
   * recorded – an ERROR sample would count as packet loss in the analysis.
   */
  private spawnFailed(err: unknown): void {
    this.setPingError(`Ping konnte nicht gestartet werden (${errorMessage(err)})`);
  }

  /** logs only the first failure of a streak (one line per tick and target would flood the log) */
  private setPingError(msg: string): void {
    if (this.pingError === null) this.hooks.log.warn(`pinger: ${msg}`);
    this.pingError = msg;
  }

  private readNics(ts: number, cfg: AgentConfig): void {
    if (this.nicBusy || cfg.nics.length === 0) return;
    const read = this.opts.readInterfaces ?? (this.catalog ? () => (this.catalog as MacInterfaceCatalog).read() : null);
    if (!read) return;
    this.nicBusy = true;
    const gen = this.generation;
    read()
      .then((list) => {
        if (gen !== this.generation) return;
        this.nicFailures = 0;
        this.nicError = null;
        for (const i of nicsToReport(list, cfg.nics)) {
          const tick = nicTickOf(i, ts);
          if (tick) this.hooks.onNic(tick);
        }
      })
      .catch((err: unknown) => {
        if (gen !== this.generation) return;
        this.nicFailures++;
        if (this.nicFailures >= (this.opts.nicFailuresForError ?? 3)) {
          const msg = `Link-Status der Netzwerkadapter nicht lesbar (${errorMessage(err)})`;
          if (this.nicError !== msg) this.hooks.log.warn(`pinger: ${msg}`);
          this.nicError = msg;
        }
      })
      .finally(() => {
        if (gen === this.generation) this.nicBusy = false;
      });
  }

  // ─── preventSleep ────────────────────────────────────────────────────────

  private startCaffeinate(): void {
    if (this.caffeinate || this.mode === 'stopped') return;
    if (this.caffeinateTimer) clearTimeout(this.caffeinateTimer);
    this.caffeinateTimer = null;
    let child: ChildProcess;
    try {
      child = this.spawnFn(MAC_TOOLS.caffeinate, ['-i', '-w', String(this.opts.pid ?? process.pid)], { stdio: 'ignore', windowsHide: true });
    } catch (err) {
      this.hooks.log.warn(`pinger: caffeinate konnte nicht gestartet werden (${errorMessage(err)})`);
      this.retryCaffeinate();
      return;
    }
    this.caffeinate = child;
    try {
      this.hooks.trackChild?.(child);
    } catch {
      // tracking is best effort
    }
    const gone = (why: string) => {
      if (this.caffeinate !== child) return;
      this.caffeinate = null;
      this.hooks.log.warn(`pinger: caffeinate beendet (${why}) – Ruhezustand nicht mehr verhindert`);
      this.retryCaffeinate();
    };
    child.once('error', (err) => gone(err.message));
    child.once('close', (code, signal) => gone(`Exit-Code ${code ?? signal ?? '?'}`));
    this.hooks.log.info('pinger: caffeinate -i active (no idle sleep while the session runs)');
  }

  private retryCaffeinate(): void {
    if (this.mode === 'stopped' || !this.cfg?.preventSleep || this.caffeinateTimer) return;
    this.caffeinateTimer = setTimeout(() => {
      this.caffeinateTimer = null;
      if (this.mode !== 'stopped' && this.cfg?.preventSleep) this.startCaffeinate();
    }, this.opts.caffeinateRetryMs ?? 30_000);
    this.caffeinateTimer.unref?.();
  }

  private stopCaffeinate(): void {
    if (this.caffeinateTimer) clearTimeout(this.caffeinateTimer);
    this.caffeinateTimer = null;
    const c = this.caffeinate;
    this.caffeinate = null;
    if (c) killQuietly(c);
  }
}

function killQuietly(child: ChildProcess): void {
  try {
    child.kill('SIGKILL');
  } catch {
    // already gone
  }
}
