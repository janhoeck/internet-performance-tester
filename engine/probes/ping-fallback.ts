// ICMP fallback: one `ping.exe -t -w <timeout> -4|-6 <ip>` per target, parsed line by line.
// Used only after the PowerShell pinger agent failed to start 3 times (see pinger.ts).
// ping.exe streams one CP850 line per echo (not block-buffered). Its cadence is ~1 s after a reply
// and `timeout + 1 s` after a timeout, so samples are NOT on a shared grid: the timestamp is the
// estimated send time rounded to the whole second (unique and increasing per target).
import { type ChildProcess, type SpawnOptions, spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { ConsoleLineSplitter } from '../../src/lib/shared/cp850';
import { type PingLine, parsePingLine } from '../../src/lib/shared/parsers/ping';
import type { Logger } from '../core/types';
import { type IcmpEcho, RESTART_BACKOFF_MS, systemExe } from './common';

export interface FallbackTarget {
  id: string;
  ip: string;
  family: 4 | 6;
  timeoutMs: number;
}

export interface FallbackHooks {
  log: Logger;
  onEcho(echo: IcmpEcho): void;
  /** own interface addresses (to recognise local ARP failures) */
  ownAddresses(): readonly string[];
  trackChild?(child: ChildProcess): void;
}

export type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

export interface FallbackOptions {
  pingPath?: string;
  spawnFn?: SpawnFn;
  backoffMs?: readonly number[];
  /** kill + restart a ping process that printed nothing for this long (default: max(15 s, 3 × timeout + 3 s)) */
  silenceMs?: number;
  /** monotonic clock (ms) */
  now?: () => number;
}

/** Time ping.exe waits before printing a timeout: IcmpSendEcho2 fires ~420 ms early (measured). */
const EARLY_TIMEOUT_MS = 420;

/**
 * Estimates the send time of each echo line and turns it into a unique per-target timestamp
 * (whole seconds, strictly increasing). Pure apart from its own state.
 */
export class FallbackTimestamper {
  private last: number | null = null;

  constructor(private readonly timeoutMs: number) {}

  stamp(arrivalMs: number, line: PingLine): number {
    let elapsed: number;
    switch (line.kind) {
      case 'reply':
        elapsed = line.rtt ?? 0;
        break;
      case 'timeout':
        elapsed = Math.max(0, this.timeoutMs - EARLY_TIMEOUT_MS);
        break;
      case 'unreachable':
        // ARP/ND failure: reported after the neighbour resolution gave up (≤ timeout)
        elapsed = Math.min(1000, Math.max(0, this.timeoutMs - EARLY_TIMEOUT_MS));
        break;
      default:
        elapsed = 0; // local failures are reported immediately
    }
    let ts = Math.round((arrivalMs - elapsed) / 1000) * 1000;
    if (this.last !== null && ts <= this.last) ts = this.last + 1000;
    this.last = ts;
    return ts;
  }
}

interface TargetProc {
  target: FallbackTarget;
  child: ChildProcess | null;
  restartTimer: NodeJS.Timeout | null;
  backoffIdx: number;
  lastLineMono: number;
  startedMono: number;
  echoes: number;
}

function sameTarget(a: FallbackTarget, b: FallbackTarget): boolean {
  return a.ip === b.ip && a.family === b.family && a.timeoutMs === b.timeoutMs;
}

export class PingFallback {
  private readonly procs = new Map<string, TargetProc>();
  private watchdog: NodeJS.Timeout | null = null;
  private active = false;
  private readonly pingPath: string;
  private readonly spawnFn: SpawnFn;
  private readonly backoff: readonly number[];
  private readonly now: () => number;

  constructor(
    private readonly hooks: FallbackHooks,
    private readonly opts: FallbackOptions = {},
  ) {
    this.pingPath = opts.pingPath ?? systemExe('PING.EXE');
    this.spawnFn = opts.spawnFn ?? ((cmd, args, options) => spawn(cmd, [...args], options));
    this.backoff = opts.backoffMs ?? RESTART_BACKOFF_MS;
    this.now = opts.now ?? (() => performance.now());
  }

  start(targets: readonly FallbackTarget[]): void {
    this.active = true;
    this.update(targets);
    if (!this.watchdog) this.watchdog = setInterval(() => this.checkSilence(), 1000);
  }

  /** Apply a new target list: start new targets, restart changed ones, stop removed ones. */
  update(targets: readonly FallbackTarget[]): void {
    if (!this.active) return;
    const wanted = new Map(targets.map((t) => [t.id, t]));
    for (const [id, p] of this.procs) {
      const t = wanted.get(id);
      if (!t || !sameTarget(t, p.target)) this.stopProc(id);
    }
    for (const t of targets) {
      if (!this.procs.has(t.id)) {
        const p: TargetProc = {
          target: t, child: null, restartTimer: null, backoffIdx: 0, lastLineMono: 0, startedMono: 0, echoes: 0,
        };
        this.procs.set(t.id, p);
        this.spawnProc(p);
      }
    }
  }

  stop(): void {
    this.active = false;
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    for (const id of [...this.procs.keys()]) this.stopProc(id);
  }

  /** ids of targets with a live ping.exe process */
  runningIds(): string[] {
    return [...this.procs.values()].filter((p) => p.child !== null).map((p) => p.target.id);
  }

  private stopProc(id: string): void {
    const p = this.procs.get(id);
    if (!p) return;
    this.procs.delete(id);
    if (p.restartTimer) clearTimeout(p.restartTimer);
    const child = p.child;
    p.child = null;
    if (child) child.kill();
  }

  private spawnProc(p: TargetProc): void {
    const { target } = p;
    const args = ['-t', '-w', String(target.timeoutMs), target.family === 6 ? '-6' : '-4', target.ip];
    let child: ChildProcess;
    try {
      child = this.spawnFn(this.pingPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      this.hooks.log.warn(`ping fallback: spawn failed for ${target.id}`, err);
      this.scheduleRestart(p);
      return;
    }
    p.child = child;
    p.startedMono = this.now();
    p.lastLineMono = p.startedMono;
    p.echoes = 0;
    this.hooks.trackChild?.(child);
    const splitter = new ConsoleLineSplitter();
    const stamper = new FallbackTimestamper(target.timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => {
      if (p.child !== child) return;
      const arrival = Date.now();
      p.lastLineMono = this.now();
      for (const text of splitter.push(chunk)) {
        const line = parsePingLine(text, { ownAddresses: this.hooks.ownAddresses() });
        if (line.echo && line.status !== null) {
          p.echoes++;
          this.hooks.onEcho({ targetId: target.id, ts: stamper.stamp(arrival, line), status: line.status, rtt: line.rtt });
        } else if (line.kind === 'resolve_failed' || line.kind === 'unknown') {
          this.hooks.log.debug(`ping fallback ${target.id}: ${text}`);
        }
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      this.hooks.log.debug(`ping fallback ${target.id} stderr: ${chunk.toString('latin1').trim()}`);
    });
    const gone = (reason: string) => {
      if (p.child !== child) return;
      p.child = null;
      if (!this.active || this.procs.get(target.id) !== p) return;
      this.hooks.log.warn(`ping fallback: ping.exe for ${target.id} ended (${reason})`);
      // a process that worked for a while starts again from the shortest backoff
      if (p.echoes > 10) p.backoffIdx = 0;
      this.scheduleRestart(p);
    };
    child.once('error', (err) => gone(err.message));
    child.once('close', (code, signal) => gone(`code ${code ?? signal ?? '?'}`));
  }

  private scheduleRestart(p: TargetProc): void {
    if (!this.active || p.restartTimer) return;
    const delay = this.backoff[Math.min(p.backoffIdx, this.backoff.length - 1)];
    p.backoffIdx++;
    p.restartTimer = setTimeout(() => {
      p.restartTimer = null;
      if (this.active && this.procs.get(p.target.id) === p) this.spawnProc(p);
    }, delay);
  }

  private checkSilence(): void {
    const now = this.now();
    for (const p of this.procs.values()) {
      if (!p.child) continue;
      const limit = this.opts.silenceMs ?? Math.max(15_000, 3 * p.target.timeoutMs + 3000);
      if (now - p.lastLineMono > limit) {
        this.hooks.log.warn(`ping fallback: no output from ping.exe for ${p.target.id} – restarting`);
        p.lastLineMono = now;
        p.child.kill(); // 'close' schedules the restart
      }
    }
  }
}
