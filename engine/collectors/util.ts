// Small helpers shared by the Windows collectors: absolute tool paths, child processes without a
// shell (always with timeout + kill on dispose), self-rescheduling poll timers, value coercion.
import { type ChildProcess, spawn } from 'node:child_process';
import path from 'node:path';
import type { EngineContext, Logger } from '../core/types';
import type { ModuleState } from '../../src/lib/shared/types';

// ─── paths ─────────────────────────────────────────────────────────────────

/** `%SystemRoot%\System32\<parts…>` (never rely on PATH). */
export function system32(...parts: string[]): string {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  return path.win32.join(root, 'System32', ...parts);
}

export const POWERSHELL_EXE = (): string => system32('WindowsPowerShell', 'v1.0', 'powershell.exe');

/** `C:\Program Files\Cloudflare\Cloudflare WARP\warp-cli.exe` (via %ProgramFiles%). */
export function warpCliPath(): string {
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  return path.win32.join(pf, 'Cloudflare', 'Cloudflare WARP', 'warp-cli.exe');
}

// ─── child processes ───────────────────────────────────────────────────────

export interface RunResult {
  code: number | null;
  stdout: Buffer;
  stderr: Buffer;
  timedOut: boolean;
  /** spawn error (e.g. ENOENT) or output limit exceeded */
  error: (Error & { code?: string }) | null;
  durationMs: number;
}

export interface RunOptions {
  timeoutMs: number;
  /** stdout limit; the child is killed when exceeded (default 16 MB) */
  maxBytes?: number;
}

/**
 * Runs short-lived tools (wevtutil, netsh, tasklist, warp-cli). Every child is spawned without a
 * shell, hidden, never detached, killed on timeout and on `killAll()` (module dispose).
 */
export class ProcessRunner {
  private readonly children = new Set<ChildProcess>();
  private closed = false;

  constructor(private readonly track?: (child: ChildProcess) => void) {}

  run(file: string, args: string[], opts: RunOptions): Promise<RunResult> {
    const started = Date.now();
    if (this.closed) {
      return Promise.resolve({ code: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), timedOut: false, error: new Error('runner closed'), durationMs: 0 });
    }
    return new Promise<RunResult>((resolve) => {
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let outBytes = 0;
      let timedOut = false;
      let error: RunResult['error'] = null;
      let settled = false;
      let child: ChildProcess;
      try {
        child = spawn(file, args, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (e) {
        resolve({ code: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), timedOut: false, error: e as Error, durationMs: 0 });
        return;
      }
      this.children.add(child);
      try {
        this.track?.(child);
      } catch {
        /* tracking is best effort */
      }
      const maxBytes = opts.maxBytes ?? 16 * 1024 * 1024;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, opts.timeoutMs);
      timer.unref();
      const finish = (code: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.children.delete(child);
        resolve({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err), timedOut, error, durationMs: Date.now() - started });
      };
      child.stdout?.on('data', (d: Buffer) => {
        outBytes += d.length;
        if (outBytes > maxBytes) {
          if (!error) error = new Error(`output limit exceeded (${maxBytes} bytes)`);
          child.kill();
          return;
        }
        out.push(d);
      });
      child.stderr?.on('data', (d: Buffer) => {
        if (err.length < 64) err.push(d);
      });
      child.on('error', (e) => {
        error = e;
        finish(null);
      });
      child.on('close', (code) => finish(code));
    });
  }

  killAll(): void {
    this.closed = true;
    for (const c of this.children) {
      try {
        c.kill();
      } catch {
        /* already gone */
      }
    }
    this.children.clear();
  }
}

// ─── poll timer ────────────────────────────────────────────────────────────

export interface PollTimerOptions {
  /** evaluated before every scheduling (config/session may change) */
  intervalMs: () => number;
  run: () => Promise<void>;
  onError?: (err: unknown) => void;
}

/** setTimeout chain (never overlapping runs). `trigger()` reschedules soon, `runNow()` awaits a run. */
export class PollTimer {
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;
  private stopped = true;
  private rerun = false;
  busy = false;
  lastRunTs: number | null = null;
  nextRunTs: number | null = null;
  lastError: string | null = null;

  constructor(private readonly opts: PollTimerOptions) {}

  get active(): boolean {
    return !this.stopped;
  }

  start(initialDelayMs = 0): void {
    this.stopped = false;
    this.schedule(initialDelayMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.nextRunTs = null;
  }

  /** run soon (e.g. after a session start or config change); keeps the timer running */
  trigger(delayMs = 0): void {
    if (this.stopped) return;
    if (this.busy) {
      this.rerun = true;
      return;
    }
    this.schedule(delayMs);
  }

  /** runs now (or joins the running pass) and resolves when done */
  runNow(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    return this.execute();
  }

  private schedule(delayMs: number): void {
    if (this.timer) clearTimeout(this.timer);
    const d = Math.max(0, Math.round(delayMs));
    this.nextRunTs = Date.now() + d;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.execute();
    }, d);
    this.timer.unref();
  }

  private execute(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.busy = true;
    this.nextRunTs = null;
    const p = (async () => {
      try {
        await this.opts.run();
        this.lastError = null;
      } catch (err) {
        this.lastError = errorMessage(err);
        this.opts.onError?.(err);
      } finally {
        this.lastRunTs = Date.now();
        this.busy = false;
        this.inFlight = null;
        if (!this.stopped) {
          if (this.rerun) {
            this.rerun = false;
            this.schedule(0);
          } else {
            this.schedule(Math.max(1000, this.opts.intervalMs()));
          }
        }
      }
    })();
    this.inFlight = p;
    return p;
  }
}

/** ModuleState from one or more timers (busy if any timer runs, earliest next run). */
export function timersState(name: string, running: boolean, timers: PollTimer[], extraError: string | null = null): ModuleState {
  const next = timers.map((t) => t.nextRunTs).filter((v): v is number => v !== null);
  const last = timers.map((t) => t.lastRunTs).filter((v): v is number => v !== null);
  return {
    name,
    enabled: true,
    running,
    busy: timers.some((t) => t.busy),
    lastRunTs: last.length ? Math.max(...last) : null,
    nextRunTs: next.length ? Math.min(...next) : null,
    lastError: extraError ?? timers.map((t) => t.lastError).find((e) => e !== null) ?? null,
  };
}

// ─── misc ──────────────────────────────────────────────────────────────────

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** PowerShell single-quoted string literal (also escapes the typographic quotes PS treats as quotes). */
export function psQuote(s: string): string {
  return `'${s.replace(/['\u2018\u2019\u201A\u201B]/g, (c) => c + c)}'`;
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** null/undefined → [], single object → [obj] (ConvertTo-Json unwraps single-element arrays) */
export function asArray(v: unknown): unknown[] {
  if (v === null || v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

export function asString(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return null;
}

export function asNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function asBool(v: unknown): boolean | null {
  if (typeof v === 'boolean') return v;
  if (v === 'true' || v === 'True') return true;
  if (v === 'false' || v === 'False') return false;
  return null;
}

/** Fallback logger (used when a factory is called without context, e.g. in tests). */
export const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
};

/** bind ctx.trackChild safely (contexts in tests may not implement it) */
export function childTracker(ctx: EngineContext): (c: ChildProcess) => void {
  return (c) => {
    try {
      ctx.trackChild(c);
    } catch {
      /* optional */
    }
  };
}

/** Interval helper: session interval while measuring, idle interval otherwise (both in seconds). */
export function pollMs(ctx: EngineContext, sessionSec: number, idleSec: number): number {
  return (ctx.isMeasuring() ? sessionSec : idleSec) * 1000;
}
