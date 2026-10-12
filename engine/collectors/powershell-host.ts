// PowerShell RPC worker: ONE long-lived powershell.exe that executes queued scripts one at a time.
// Protocol (docs/research/code/ps_worker.ps1 + ps_worker_client.mjs):
//   stdin  (Node → PS): {"id":N,"cmd":"<script>","depth":6,"mode":"json"|"text"}   one line, ASCII only
//   stdout (PS → Node): @@RPC@@{"id":N,"ok":true,"data":<json>} | {"id":N,"ok":true,"text":"…"}
//                       @@RPC@@{"id":N,"ok":false,"error":"…","errorType":"…","errorId":"…"}
// Raw UTF-8 streams (never touch [Console]::OutputEncoding), $ProgressPreference off, helpers from
// ps-helpers.ps1 loaded once per start as `function global:`. A command that exceeds its timeout
// kills the worker; the next queued command runs on a fresh one.
import { type ChildProcess, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import type { Logger, PowerShellHost } from '../core/types';
import { POWERSHELL_EXE, errorMessage, isRecord, silentLogger } from './util';

export const RPC_PREFIX = '@@RPC@@';

/** Worker boot script (passed via -EncodedCommand). No backticks / `${` so it stays a plain TS string. */
export const WORKER_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$ProgressPreference = 'SilentlyContinue'",
  "$WarningPreference = 'SilentlyContinue'",
  "$InformationPreference = 'SilentlyContinue'",
  "$VerbosePreference = 'SilentlyContinue'",
  "$DebugPreference = 'SilentlyContinue'",
  '$nl = [string][char]10',
  '$utf8 = New-Object System.Text.UTF8Encoding($false)',
  '$stdin = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), $utf8)',
  '$stdout = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), $utf8)',
  '$stdout.AutoFlush = $true',
  '$stdout.NewLine = $nl',
  "function Send-NdRpc([string]$json) { $stdout.WriteLine('@@RPC@@' + $json) }",
  'function ConvertTo-NdJsonString($s) { ConvertTo-Json -InputObject ([string]$s) -Compress }',
  'Send-NdRpc (\'{"id":0,"ok":true,"data":{"ready":true,"pid":\' + $PID + \',"ps":"\' + $PSVersionTable.PSVersion.ToString() + \'"}}\')',
  'while ($true) {',
  '  $line = $stdin.ReadLine()',
  '  if ($null -eq $line) { break }',
  '  if ($line.Trim().Length -eq 0) { continue }',
  '  $id = 0',
  '  try {',
  '    $req = ConvertFrom-Json -InputObject $line',
  '    $id = [int64]$req.id',
  '    $depth = 6',
  '    if ($req.depth) { $depth = [int]$req.depth }',
  '    $res = @(& ([ScriptBlock]::Create([string]$req.cmd)))',
  "    if ($req.mode -eq 'text') {",
  "      $parts = @(foreach ($r in $res) { if ($null -eq $r) { '' } elseif ($r -is [string]) { $r } else { ($r | Out-String -Width 4096).TrimEnd() } })",
  '      Send-NdRpc (\'{"id":\' + $id + \',"ok":true,"text":\' + (ConvertTo-NdJsonString ($parts -join $nl)) + \'}\')',
  '    } elseif ($res.Count -eq 1 -and $res[0] -is [string]) {',
  '      Send-NdRpc (\'{"id":\' + $id + \',"ok":true,"text":\' + (ConvertTo-NdJsonString $res[0]) + \'}\')',
  '    } else {',
  "      if ($res.Count -eq 0) { $json = 'null' }",
  '      elseif ($res.Count -eq 1) { $json = ConvertTo-Json -InputObject $res[0] -Depth $depth -Compress }',
  '      else { $json = ConvertTo-Json -InputObject $res -Depth $depth -Compress }',
  "      if ([string]::IsNullOrEmpty($json)) { $json = 'null' }",
  '      Send-NdRpc (\'{"id":\' + $id + \',"ok":true,"data":\' + $json + \'}\')',
  '    }',
  '  } catch {',
  '    $e = $_',
  '    Send-NdRpc (\'{"id":\' + $id + \',"ok":false,"error":\' + (ConvertTo-NdJsonString $e.Exception.Message) + \',"errorType":\' + (ConvertTo-NdJsonString $e.Exception.GetType().FullName) + \',"errorId":\' + (ConvertTo-NdJsonString $e.FullyQualifiedErrorId) + \'}\')',
  '  }',
  '}',
].join('\n');

const STARTUP_TIMEOUT_MS = 30_000;
const INIT_TIMEOUT_MS = 30_000;
const QUEUE_SLACK_MS = 60_000;
const MAX_QUEUE = 500;

export interface PowerShellHostOptions {
  log?: Logger;
  /** default per-command timeout (ms), default 20 s */
  defaultTimeoutMs?: number;
  /** load the collector helper library (ps-helpers.ps1) after every (re)start; default true */
  helpers?: boolean;
  /** called for every spawned powershell.exe (e.g. ctx.trackChild) */
  onSpawn?: (child: ChildProcess) => void;
  /** recycle the worker (when idle) after this many commands / this age – memory hygiene */
  maxCommands?: number;
  maxAgeMs?: number;
  /** override powershell.exe (tests) */
  exe?: string;
}

export type PowerShellErrorKind = 'ps' | 'timeout' | 'exit' | 'unavailable' | 'queue';

export class PowerShellError extends Error {
  constructor(
    message: string,
    readonly kind: PowerShellErrorKind = 'ps',
    readonly errorId: string | null = null,
    readonly errorType: string | null = null,
  ) {
    super(message);
    this.name = 'PowerShellError';
  }
}

export interface RpcResponse {
  id: number;
  ok: boolean;
  data?: unknown;
  text?: string;
  error?: string;
  errorId?: string;
  errorType?: string;
}

/** Parse one stdout line; the prefix may be preceded by stray host output on the same line. */
export function parseRpcLine(line: string): RpcResponse | null {
  const i = line.indexOf(RPC_PREFIX);
  if (i < 0) return null;
  let v: unknown;
  try {
    v = JSON.parse(line.slice(i + RPC_PREFIX.length));
  } catch {
    return null;
  }
  if (!isRecord(v) || typeof v.id !== 'number' || typeof v.ok !== 'boolean') return null;
  const str = (x: unknown) => (typeof x === 'string' ? x : undefined);
  return {
    id: v.id,
    ok: v.ok,
    data: v.data,
    text: str(v.text),
    error: str(v.error),
    errorId: str(v.errorId),
    errorType: str(v.errorType),
  };
}

/** -EncodedCommand payload: base64 of the UTF-16LE script. */
export function encodePowerShellCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

/** JSON with every non-ASCII character escaped – stdin stays pure ASCII whatever the code page. */
export function asciiJson(v: unknown): string {
  return JSON.stringify(v).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/**
 * json() result: if the script wrote exactly one string (the contract: `… | ConvertTo-Json`), that
 * string is the JSON document; otherwise the worker serialized the objects itself (`data`).
 * A single non-JSON string is returned as is.
 */
export function decodeJsonResult(res: RpcResponse): unknown {
  if (res.text !== undefined) {
    const t = res.text.trim();
    if (t === '') return null;
    try {
      return JSON.parse(t) as unknown;
    } catch {
      return res.text;
    }
  }
  return res.data ?? null;
}

// ─── process bookkeeping (kill workers when the engine process exits) ──────

const liveChildren = new Set<ChildProcess>();
let exitHookInstalled = false;
function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once('exit', () => {
    for (const c of liveChildren) {
      try {
        c.kill();
      } catch {
        /* gone */
      }
    }
  });
}

let helpersPromise: Promise<string | null> | null = null;
function loadHelpers(): Promise<string | null> {
  helpersPromise ??= readFile(new URL('./ps-helpers.ps1', import.meta.url), 'utf8').then(
    (s) => s.replace(/^﻿/, ''),
    () => null,
  );
  return helpersPromise;
}

interface Job {
  id: number;
  script: string;
  mode: 'json' | 'text';
  timeoutMs: number;
  resolve: (r: RpcResponse) => void;
  reject: (e: Error) => void;
  queueTimer: NodeJS.Timeout | null;
  execTimer: NodeJS.Timeout | null;
}

interface Pending {
  id: number;
  resolve: (r: RpcResponse) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

class PowerShellWorkerHost implements PowerShellHost {
  private proc: ChildProcess | null = null;
  private ready = false;
  private starting = false;
  private readonly queue: Job[] = [];
  private current: Job | null = null;
  private internal: Pending | null = null;
  private seq = 0;
  private disposed = false;
  private fatal: Error | null = null;
  private failures = 0;
  private nextStartAt = 0;
  private retryTimer: NodeJS.Timeout | null = null;
  private commandsSinceStart = 0;
  private procStartedAt = 0;
  private stdoutBuf = '';
  private strayLogged = 0;
  private readonly log: Logger;
  private readonly defaultTimeoutMs: number;
  private readonly maxCommands: number;
  private readonly maxAgeMs: number;
  private readonly exe: string;

  constructor(private readonly opts: PowerShellHostOptions) {
    this.log = opts.log ?? silentLogger;
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 20_000;
    this.maxCommands = opts.maxCommands ?? 5000;
    this.maxAgeMs = opts.maxAgeMs ?? 6 * 3600_000;
    this.exe = opts.exe ?? POWERSHELL_EXE();
    installExitHook();
  }

  get available(): boolean {
    return !this.disposed && this.fatal === null;
  }

  async json<T = unknown>(script: string, opts?: { timeoutMs?: number }): Promise<T> {
    const res = await this.enqueue(script, 'json', opts?.timeoutMs);
    return decodeJsonResult(res) as T;
  }

  async text(script: string, opts?: { timeoutMs?: number }): Promise<string> {
    const res = await this.enqueue(script, 'text', opts?.timeoutMs);
    if (res.text !== undefined) return res.text;
    return res.data === undefined || res.data === null ? '' : JSON.stringify(res.data);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const err = new PowerShellError('PowerShell-Worker wurde beendet', 'unavailable');
    for (const j of this.queue.splice(0)) {
      if (j.queueTimer) clearTimeout(j.queueTimer);
      j.reject(err);
    }
    this.failCurrent(err);
    this.failInternal(err);
    const child = this.proc;
    this.detach();
    if (child) this.retire(child, 1500);
  }

  // ─── queue ───────────────────────────────────────────────────────────────

  private enqueue(script: string, mode: 'json' | 'text', timeoutMs?: number): Promise<RpcResponse> {
    if (this.disposed) return Promise.reject(new PowerShellError('PowerShell-Worker wurde beendet', 'unavailable'));
    if (this.fatal) return Promise.reject(new PowerShellError(`PowerShell nicht verfügbar: ${this.fatal.message}`, 'unavailable'));
    if (this.queue.length >= MAX_QUEUE) return Promise.reject(new PowerShellError('PowerShell-Warteschlange ist voll', 'queue'));
    const t = Math.max(100, timeoutMs ?? this.defaultTimeoutMs);
    return new Promise<RpcResponse>((resolve, reject) => {
      const job: Job = { id: ++this.seq, script, mode, timeoutMs: t, resolve, reject, queueTimer: null, execTimer: null };
      job.queueTimer = setTimeout(() => {
        const i = this.queue.indexOf(job);
        if (i >= 0) {
          this.queue.splice(i, 1);
          reject(new PowerShellError('Zeitüberschreitung in der PowerShell-Warteschlange', 'queue'));
        }
      }, t + QUEUE_SLACK_MS);
      this.queue.push(job);
      this.pump();
    });
  }

  private pump(): void {
    if (this.disposed || this.current || this.queue.length === 0) return;
    if (this.fatal) {
      const err = new PowerShellError(`PowerShell nicht verfügbar: ${this.fatal.message}`, 'unavailable');
      for (const j of this.queue.splice(0)) {
        if (j.queueTimer) clearTimeout(j.queueTimer);
        j.reject(err);
      }
      return;
    }
    const child = this.proc;
    if (!child || !this.ready) {
      if (!child && !this.starting) this.scheduleStart();
      return;
    }
    const job = this.queue.shift();
    if (!job) return;
    if (job.queueTimer) clearTimeout(job.queueTimer);
    job.queueTimer = null;
    this.current = job;
    job.execTimer = setTimeout(() => this.onJobTimeout(job), job.timeoutMs);
    this.commandsSinceStart++;
    if (!this.write(child, { id: job.id, cmd: job.script, depth: 6, mode: job.mode })) {
      this.current = null;
      clearTimeout(job.execTimer);
      job.reject(new PowerShellError('PowerShell-Worker nicht erreichbar', 'exit'));
      this.detach();
      this.retire(child, 0);
      this.pump();
    }
  }

  private scheduleStart(): void {
    const wait = this.nextStartAt - Date.now();
    if (wait > 0) {
      if (!this.retryTimer) {
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null;
          this.pump();
        }, wait);
      }
      return;
    }
    void this.start();
  }

  // ─── process lifecycle ───────────────────────────────────────────────────

  private async start(): Promise<void> {
    this.starting = true;
    let child: ChildProcess;
    try {
      child = spawn(
        this.exe,
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodePowerShellCommand(WORKER_SCRIPT)],
        { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] },
      );
    } catch (err) {
      this.starting = false;
      this.onStartFailure(err);
      return;
    }
    this.proc = child;
    this.ready = false;
    this.stdoutBuf = '';
    liveChildren.add(child);
    try {
      this.opts.onSpawn?.(child);
    } catch {
      /* optional */
    }
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (s: string) => this.onStdout(child, s));
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (s: string) => this.onStderr(s));
    child.stdin?.on('error', () => undefined);
    child.on('error', (err) => this.onChildError(child, err));
    child.on('exit', (code, signal) => this.onExit(child, code, signal));
    try {
      const hello = await this.waitInternal(0, STARTUP_TIMEOUT_MS);
      if (this.opts.helpers !== false) {
        const helpers = await loadHelpers();
        if (helpers && this.proc === child) {
          const id = ++this.seq;
          const wait = this.waitInternal(id, INIT_TIMEOUT_MS);
          this.write(child, { id, cmd: `${helpers}\n'ok'`, depth: 2, mode: 'json' });
          const init = await wait;
          if (!init.ok) this.log.warn('PowerShell-Hilfsfunktionen konnten nicht geladen werden', { error: init.error, errorId: init.errorId });
        } else if (!helpers) {
          this.log.warn('ps-helpers.ps1 nicht gefunden – Collector-Hilfsfunktionen fehlen');
        }
      }
      if (this.proc !== child) throw new Error('worker replaced during start');
      this.ready = true;
      this.failures = 0;
      this.commandsSinceStart = 0;
      this.procStartedAt = Date.now();
      const data = isRecord(hello.data) ? hello.data : {};
      this.log.debug('PowerShell-Worker bereit', { pid: data.pid, ps: data.ps });
    } catch (err) {
      if (this.proc === child) {
        this.detach();
        this.retire(child, 0);
      }
      this.onStartFailure(err);
    } finally {
      this.starting = false;
      this.pump();
    }
  }

  private onStartFailure(err: unknown): void {
    const code = isRecord(err) && typeof err.code === 'string' ? err.code : null;
    if (code === 'ENOENT' || code === 'EACCES') {
      this.fatal = err instanceof Error ? err : new Error(String(err));
      this.log.error('powershell.exe kann nicht gestartet werden', { error: errorMessage(err) });
      return;
    }
    this.failures++;
    const backoff = Math.min(30_000, 500 * 2 ** Math.min(6, this.failures - 1));
    this.nextStartAt = Date.now() + backoff;
    this.log.warn('PowerShell-Worker-Start fehlgeschlagen', { error: errorMessage(err), retryInMs: backoff });
  }

  private onChildError(child: ChildProcess, err: Error): void {
    if (child !== this.proc) return;
    // spawn failures (ENOENT) arrive here, possibly without an 'exit' event
    const pendingInternal = this.internal;
    this.detach();
    liveChildren.delete(child);
    const e = new PowerShellError(`PowerShell-Fehler: ${err.message}`, 'exit');
    this.failCurrent(e);
    if (pendingInternal) {
      clearTimeout(pendingInternal.timer);
      this.internal = null;
      pendingInternal.reject(Object.assign(new Error(err.message), { code: (err as Error & { code?: string }).code }));
    }
  }

  private onExit(child: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
    liveChildren.delete(child);
    if (child !== this.proc) return; // retired worker
    this.detach();
    const err = new PowerShellError(`PowerShell-Worker beendet (${code ?? signal ?? '?'})`, 'exit');
    const duringStart = this.starting; // start() counts the failure itself
    this.failInternal(err);
    this.failCurrent(err);
    if (!duringStart) {
      this.failures++;
      const backoff = Math.min(30_000, 500 * 2 ** Math.min(6, this.failures - 1));
      this.nextStartAt = Date.now() + backoff;
      if (!this.disposed) this.log.warn('PowerShell-Worker unerwartet beendet', { code, signal, retryInMs: backoff });
    }
    this.pump();
  }

  private onJobTimeout(job: Job): void {
    if (this.current !== job) return;
    this.current = null;
    job.reject(new PowerShellError(`PowerShell-Befehl: Zeitüberschreitung nach ${job.timeoutMs} ms`, 'timeout'));
    const child = this.proc;
    this.detach();
    if (child) this.retire(child, 0);
    this.log.warn('PowerShell-Befehl hängt – Worker wird neu gestartet', { timeoutMs: job.timeoutMs });
    this.pump();
  }

  /** forget the current process (its late output and exit are ignored from now on) */
  private detach(): void {
    this.proc = null;
    this.ready = false;
    this.stdoutBuf = '';
  }

  /** end a detached worker: close stdin (clean exit) and kill it after `graceMs` */
  private retire(child: ChildProcess, graceMs: number): void {
    try {
      child.stdin?.end();
    } catch {
      /* ignore */
    }
    const kill = () => {
      try {
        if (child.exitCode === null && child.signalCode === null) child.kill();
      } catch {
        /* gone */
      }
      liveChildren.delete(child);
    };
    if (graceMs <= 0) kill();
    else setTimeout(kill, graceMs).unref();
  }

  private maybeRecycle(): void {
    const child = this.proc;
    if (!child || !this.ready || this.current || this.queue.length > 0) return;
    if (this.commandsSinceStart < this.maxCommands && Date.now() - this.procStartedAt < this.maxAgeMs) return;
    this.log.debug('PowerShell-Worker wird turnusmäßig neu gestartet', { commands: this.commandsSinceStart });
    this.detach();
    this.retire(child, 2000);
  }

  // ─── I/O ─────────────────────────────────────────────────────────────────

  private write(child: ChildProcess, req: Record<string, unknown>): boolean {
    const stdin = child.stdin;
    if (!stdin || stdin.destroyed || !stdin.writable) return false;
    try {
      stdin.write(`${asciiJson(req)}\n`);
      return true;
    } catch {
      return false;
    }
  }

  private waitInternal(id: number, timeoutMs: number): Promise<RpcResponse> {
    return new Promise<RpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.internal?.id === id) this.internal = null;
        reject(new Error(`PowerShell-Worker antwortet nicht (id ${id})`));
      }, timeoutMs);
      timer.unref();
      this.internal = { id, resolve, reject, timer };
    });
  }

  private onStdout(child: ChildProcess, chunk: string): void {
    if (child !== this.proc) return;
    this.stdoutBuf += chunk;
    let nl: number;
    while ((nl = this.stdoutBuf.indexOf('\n')) >= 0) {
      const line = this.stdoutBuf.slice(0, nl).replace(/\r$/, '');
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
      const msg = parseRpcLine(line);
      if (!msg) {
        if (line.trim() && this.strayLogged < 20) {
          this.strayLogged++;
          this.log.debug('PowerShell: unerwartete Ausgabe', { line: line.slice(0, 200) });
        }
        continue;
      }
      this.dispatch(msg);
      if (child !== this.proc) return;
    }
    if (this.stdoutBuf.length > 64 * 1024 * 1024) this.stdoutBuf = ''; // runaway line without newline
  }

  private dispatch(msg: RpcResponse): void {
    const internal = this.internal;
    if (internal && internal.id === msg.id) {
      clearTimeout(internal.timer);
      this.internal = null;
      internal.resolve(msg);
      return;
    }
    const job = this.current;
    if (!job || job.id !== msg.id) return;
    this.current = null;
    if (job.execTimer) clearTimeout(job.execTimer);
    if (msg.ok) job.resolve(msg);
    else job.reject(new PowerShellError(msg.error ?? 'PowerShell-Fehler', 'ps', msg.errorId ?? null, msg.errorType ?? null));
    this.maybeRecycle();
    this.pump();
  }

  private onStderr(chunk: string): void {
    const text = chunk.trim();
    if (!text || text.startsWith('#< CLIXML') || text.startsWith('<Objs')) return;
    if (this.strayLogged < 20) {
      this.strayLogged++;
      this.log.debug('PowerShell stderr', { text: text.slice(0, 300) });
    }
  }

  private failCurrent(err: Error): void {
    const job = this.current;
    if (!job) return;
    this.current = null;
    if (job.execTimer) clearTimeout(job.execTimer);
    job.reject(err);
  }

  private failInternal(err: Error): void {
    const p = this.internal;
    if (!p) return;
    this.internal = null;
    clearTimeout(p.timer);
    p.reject(err);
  }
}

/** Creates a PowerShell RPC worker (lazy: powershell.exe starts with the first command). */
export function createPowerShellHost(opts: PowerShellHostOptions = {}): PowerShellHost {
  return new PowerShellWorkerHost(opts);
}
