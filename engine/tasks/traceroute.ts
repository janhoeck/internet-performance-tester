// Path discovery (ARCHITECTURE §4.7, methodology §7, windows-collectors §4): TTL-limited .NET pings
// (`Ping.SendPingAsync(dst, 1000, buf, PingOptions(ttl, false))`, Stopwatch timing – RoundtripTime
// is 0 for TtlExpired) in a SEPARATE short-lived powershell.exe running engine/tasks/ttl-probe.ps1,
// so the shared RPC worker is never blocked. Fallback: `tracert -d -w 1000 -h N -4|-6` parsed by
// parseTracert(). Targets 1.1.1.1 and 2606:4700:4700::1111. macOS: one `traceroute -I -q 1 -f T -m T` per
// TTL and round, fallback one sequential UDP-mode `traceroute` (engine/tasks/mac-path.ts).
//
// Runs: session start ('startup', up to 30 hops), every `tracerouteEveryMin` ('schedule', hops 1–8 ×
// 3 probes), outage start + shortly after the outage ends ('incident', at most one per 3 min) and
// runNow({ family }) ('manual', up to 30 hops, also without a session). Per result: pathHash (sha1
// of the responding hops), tolerant route-change detection (`route_change` event), dynamic hosts
// $isp4/$isp6, persisted traceroute row + bus 'traceroute'.
//
// This file also hosts the shared TTL-probe runner (used by mtr.ts) and the small child-process
// helpers used by mtu.ts.
import { type ChildProcess, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppConfig } from '../../src/lib/shared/config';
import { decodeConsole } from '../../src/lib/shared/cp850';
import { isIpLiteral, normalizeIp } from '../../src/lib/shared/net';
import { parseTracert } from '../../src/lib/shared/parsers/tracert';
import {
  buildTraceHops,
  chooseIspHost,
  comparePaths,
  type HopProbe,
  type HopProbeKind,
  type PathComparison,
  pathSignature,
  respondingHops,
} from '../../src/lib/shared/path-analysis';
import type { IpFamily, ModuleState, NetEvent, Segment, TraceHop, TracerouteResult } from '../../src/lib/shared/types';
import type { BusEvents, EngineContext, EngineModule, Logger, TaskResult } from '../core/types';
import { isMac } from '../platform';
import { runMacTraceroute, runMacTtlProbes } from './mac-path';

// ─── constants ─────────────────────────────────────────────────────────────

export const PATH_TARGETS: Readonly<Record<IpFamily, string>> = { 4: '1.1.1.1', 6: '2606:4700:4700::1111' };
export const FAMILIES: readonly IpFamily[] = [4, 6];
/** scheduled discovery: hops 1–8 × 3 probes */
export const SCHEDULE_MAX_HOPS = 8;
/** manual / incident / session start */
export const FULL_MAX_HOPS = 30;
export const DISCOVERY_ROUNDS = 3;
export const PROBE_TIMEOUT_MS = 1000;
export const MAX_CONCURRENT_PROBES = 8;
/** minimum distance between two incident-triggered discoveries */
export const INCIDENT_MIN_GAP_MS = 3 * 60_000;
/** traces kept per family for route-change tolerance (ECMP alternates) and stable $isp hosts */
export const HISTORY_SIZE = 10;

const SPEEDTEST_RETRY_MS = 2 * 60_000;
const TTL_FAILURES_BEFORE_TRACERT = 3;
const TRACERT_PREFERENCE_MS = 6 * 3_600_000;

// ─── small helpers ─────────────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function errorText(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  if (typeof err === 'string') return err;
  return String(err);
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

export function range(from: number, to: number): number[] {
  const out: number[] = [];
  for (let i = from; i <= to; i++) out.push(i);
  return out;
}

// ─── child processes ───────────────────────────────────────────────────────

/** `%SystemRoot%\System32\<parts…>` – console tools are always spawned by absolute path. */
export function system32(...parts: string[]): string {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  return path.win32.join(root, 'System32', ...parts);
}

export const powershellExe = (): string => system32('WindowsPowerShell', 'v1.0', 'powershell.exe');

export interface ProcessOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  /** register the child so the engine kills it on shutdown (ctx.trackChild) */
  track?: (child: ChildProcess) => void;
  /** stdout limit in bytes (default 4 MB); the child is killed when exceeded */
  maxBytes?: number;
  /** environment of the child (default: inherited; macOS tools get LC_ALL=C) */
  env?: NodeJS.ProcessEnv;
}

export interface ProcessResult {
  code: number | null;
  stdout: Buffer;
  stderr: Buffer;
  timedOut: boolean;
  aborted: boolean;
  /** spawn error or output limit (English, for logs) */
  error: string | null;
  durationMs: number;
}

/**
 * One-shot child process: no shell, hidden window, never detached, killed on timeout, abort and
 * output overflow. Never rejects.
 */
export function runProcess(file: string, args: readonly string[], opts: ProcessOptions): Promise<ProcessResult> {
  const started = performance.now();
  const maxBytes = opts.maxBytes ?? 4 * 1024 * 1024;
  return new Promise((resolve) => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let timedOut = false;
    let aborted = false;
    let error: string | null = null;
    let settled = false;
    let child: ChildProcess | null = null;

    const kill = () => {
      try {
        child?.kill();
      } catch {
        // already gone
      }
    };
    const onAbort = () => {
      aborted = true;
      kill();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, Math.max(1, opts.timeoutMs));
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({
        code,
        stdout: Buffer.concat(out),
        stderr: Buffer.concat(err),
        timedOut,
        aborted,
        error,
        durationMs: performance.now() - started,
      });
    };

    if (opts.signal?.aborted) {
      aborted = true;
      finish(null);
      return;
    }
    try {
      child = spawn(file, [...args], {
        windowsHide: true,
        shell: false,
        detached: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        ...(opts.env ? { env: opts.env } : {}),
      });
    } catch (e) {
      error = errorText(e);
      finish(null);
      return;
    }
    opts.track?.(child);
    child.stdout?.on('data', (chunk: Buffer) => {
      outBytes += chunk.length;
      if (outBytes > maxBytes) {
        error ??= 'output limit exceeded';
        kill();
        return;
      }
      out.push(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      errBytes += chunk.length;
      if (errBytes <= 64 * 1024) err.push(chunk);
    });
    child.once('error', (e) => {
      error ??= errorText(e);
      finish(null);
    });
    child.once('close', (code) => finish(code));
    opts.signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// ─── TTL probe runner (ttl-probe.ps1) ──────────────────────────────────────

/** Probe plan handed to ttl-probe.ps1 (base64 JSON, see the script header). */
export interface TtlPlan {
  dst: string;
  /** ascending TTLs probed in every round */
  ttls: number[];
  rounds: number;
  timeoutMs: number;
  maxConc: number;
  /** minimum spacing of round starts (rounds never overlap) */
  intervalMs: number;
  /** stop probing TTLs beyond the first terminal answer (destination reply / unreachable) */
  stopAtDest: boolean;
  /** destination silent in a round → later rounds probe at most lastResponding + trimSilent (0 = off) */
  trimSilent: number;
  /** ICMP payload bytes */
  size: number;
}

export function discoveryPlan(dst: string, maxHops: number): TtlPlan {
  return {
    dst,
    ttls: range(1, maxHops),
    rounds: DISCOVERY_ROUNDS,
    timeoutMs: PROBE_TIMEOUT_MS,
    maxConc: MAX_CONCURRENT_PROBES,
    intervalMs: 1000,
    stopAtDest: true,
    trimSilent: 3,
    size: 32,
  };
}

/** Upper bound of a run (PowerShell start-up + every round at its worst) – the hard timeout. */
export function estimateRunMs(plan: TtlPlan): number {
  const batches = Math.max(1, Math.ceil(plan.ttls.length / Math.max(1, plan.maxConc)));
  const perRound = Math.max(plan.intervalMs, batches * (plan.timeoutMs + 250));
  return 15_000 + plan.rounds * perRound;
}

export const PLAN_PLACEHOLDER = '__PLAN_B64__';
const TTL_SCRIPT_URL = new URL('./ttl-probe.ps1', import.meta.url);
let ttlScriptCache: Promise<string> | null = null;

export function loadTtlScript(): Promise<string> {
  ttlScriptCache ??= readFile(fileURLToPath(TTL_SCRIPT_URL), 'utf8').catch((err: unknown) => {
    ttlScriptCache = null;
    throw err;
  });
  return ttlScriptCache;
}

/** Drops full-line comments and blank lines (keeps -EncodedCommand far below the 32k limit). */
export function stripPsComments(script: string): string {
  return script
    .split(/\r?\n/)
    .filter((l) => {
      const t = l.trim();
      return t !== '' && !t.startsWith('#');
    })
    .join('\n');
}

/** powershell.exe arguments running `script` with `plan` substituted (base64 UTF-16LE command). */
export function ttlScriptArgs(script: string, plan: TtlPlan): string[] {
  if (!script.includes(PLAN_PLACEHOLDER)) throw new Error('ttl-probe.ps1: plan placeholder missing');
  if (!isIpLiteral(plan.dst)) throw new Error(`invalid probe destination: ${plan.dst}`);
  const planB64 = Buffer.from(JSON.stringify(plan), 'utf8').toString('base64');
  const body = stripPsComments(script).replace(PLAN_PLACEHOLDER, () => planB64);
  return [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-EncodedCommand',
    Buffer.from(body, 'utf16le').toString('base64'),
  ];
}

export type TtlProbeLine = {
  k: 'r';
  round: number;
  ttl: number;
  /** System.Net.NetworkInformation.IPStatus name */
  st: string;
  from: string | null;
  /** Stopwatch time from send to completion (ms) */
  ms: number | null;
  /** API RoundtripTime (Success only) */
  rtt: number | null;
  err: string | null;
};

export type TtlScriptLine =
  | { k: 'hello'; pid: number }
  | TtlProbeLine
  | { k: 'done'; ms: number | null }
  | { k: 'fatal'; err: string };

/** One stdout line of ttl-probe.ps1 → typed record (null for anything else). */
export function parseTtlScriptLine(line: string): TtlScriptLine | null {
  const t = line.trim();
  if (!t.startsWith('{')) return null;
  let v: unknown;
  try {
    v = JSON.parse(t);
  } catch {
    return null;
  }
  if (!isRecord(v)) return null;
  switch (v.k) {
    case 'hello':
      return { k: 'hello', pid: num(v.pid) ?? 0 };
    case 'done':
      return { k: 'done', ms: num(v.ms) };
    case 'fatal':
      return { k: 'fatal', err: str(v.err) ?? 'fatal' };
    case 'r': {
      const round = num(v.round);
      const ttl = num(v.ttl);
      if (round === null || ttl === null || typeof v.st !== 'string') return null;
      return { k: 'r', round, ttl, st: v.st, from: str(v.from), ms: num(v.ms), rtt: num(v.rtt), err: str(v.err) };
    }
    default:
      return null;
  }
}

/** Responder address as reported by .NET: null for 0.0.0.0 / :: (timeouts) and non-IPs, zone id stripped. */
export function normalizeResponder(from: string | null): string | null {
  if (!from) return null;
  const ip = from.trim().replace(/%.*$/, '');
  if (!isIpLiteral(ip)) return null;
  const n = normalizeIp(ip);
  if (n === '0.0.0.0' || /^[0:]+$/.test(n)) return null;
  return ip;
}

/**
 * IPStatus → probe outcome. "Destination unreachable" from one of our own addresses is a local
 * failure (ARP/ND failed, no route), not a router on the path.
 */
export function hopProbeKind(st: string, from: string | null, isLocal: (ip: string) => boolean): HopProbeKind {
  if (st === 'Success') return from ? 'reply' : 'error';
  if (st === 'TtlExpired' || st === 'TimeExceeded') return from ? 'ttl-expired' : 'lost';
  if (st.startsWith('Destination')) return from && !isLocal(from) ? 'unreachable' : 'error';
  if (st === 'TimedOut') return 'lost';
  return 'error';
}

export function toHopProbe(line: TtlProbeLine, isLocal: (ip: string) => boolean = () => false): HopProbe {
  const from = normalizeResponder(line.from);
  const kind = hopProbeKind(line.st, from, isLocal);
  const answered = kind === 'reply' || kind === 'ttl-expired' || kind === 'unreachable';
  const ms = line.ms !== null && line.ms >= 0 ? Math.round(line.ms * 100) / 100 : null;
  return { ttl: line.ttl, round: line.round, from: answered ? from : null, rttMs: answered ? ms : null, kind };
}

/** Set of this PC's addresses (normalized) as a membership test. */
export function localAddressChecker(): (ip: string) => boolean {
  const set = new Set<string>();
  try {
    for (const infos of Object.values(os.networkInterfaces())) {
      for (const i of infos ?? []) set.add(normalizeIp(i.address.replace(/%.*$/, '')));
    }
  } catch {
    // no interface list – nothing is local
  }
  return (ip) => set.has(normalizeIp(ip.replace(/%.*$/, '')));
}

export interface TtlRunOptions {
  signal?: AbortSignal;
  track?: (child: ChildProcess) => void;
  /** hard limit for the run (default estimateRunMs(plan)) */
  timeoutMs?: number;
  isLocal?: (ip: string) => boolean;
}

export interface TtlRunResult {
  /** the script started and reported (false → the caller should use a fallback) */
  ok: boolean;
  probes: HopProbe[];
  /** every round finished ('done' seen) */
  complete: boolean;
  /** English, for logs */
  error: string | null;
  durationMs: number;
}

/** Turns the collected stdout of one ttl-probe.ps1 run into probes + status (pure). */
export function interpretTtlOutput(
  stdout: string,
  proc: Pick<ProcessResult, 'code' | 'timedOut' | 'aborted' | 'error' | 'stderr' | 'durationMs'>,
  isLocal: (ip: string) => boolean = () => false,
): TtlRunResult {
  let hello = false;
  let done = false;
  let fatal: string | null = null;
  const probes: HopProbe[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = parseTtlScriptLine(raw);
    if (!line) continue;
    if (line.k === 'hello') hello = true;
    else if (line.k === 'done') done = true;
    else if (line.k === 'fatal') fatal = line.err;
    else probes.push(toHopProbe(line, isLocal));
  }
  const stderrLine = proc.stderr.toString('utf8').split(/\r?\n/).find((l) => l.trim() !== '')?.trim() ?? null;
  let error: string | null = null;
  if (proc.error) error = proc.error;
  else if (fatal) error = `ttl-probe.ps1: ${fatal}`;
  else if (proc.aborted) error = 'aborted';
  else if (proc.timedOut) error = 'timeout';
  else if (!hello) error = `powershell.exe exited (code ${proc.code ?? 'n/a'})${stderrLine ? `: ${stderrLine}` : ''}`;
  else if (!done) error = `incomplete run (code ${proc.code ?? 'n/a'})`;
  return {
    ok: hello && fatal === null && probes.length > 0,
    probes,
    complete: done,
    error,
    durationMs: proc.durationMs,
  };
}

/**
 * Runs ttl-probe.ps1 in its own short-lived powershell.exe (macOS: one traceroute per TTL and
 * round, engine/tasks/mac-path.ts). Never rejects.
 */
export async function runTtlProbes(plan: TtlPlan, opts: TtlRunOptions = {}): Promise<TtlRunResult> {
  if (isMac()) return runMacTtlProbes(plan, opts);
  let args: string[];
  try {
    args = ttlScriptArgs(await loadTtlScript(), plan);
  } catch (err) {
    return { ok: false, probes: [], complete: false, error: `ttl-probe.ps1: ${errorText(err)}`, durationMs: 0 };
  }
  const proc = await runProcess(powershellExe(), args, {
    timeoutMs: opts.timeoutMs ?? estimateRunMs(plan),
    signal: opts.signal,
    track: opts.track,
    maxBytes: 2 * 1024 * 1024,
  });
  return interpretTtlOutput(proc.stdout.toString('utf8'), proc, opts.isLocal);
}

// ─── tracert fallback ──────────────────────────────────────────────────────

export interface TracertRunResult {
  ok: boolean;
  hops: TraceHop[];
  reached: boolean;
  error: string | null;
  durationMs: number;
}

/**
 * Silent hops after the last responder carry no information ("nothing answers beyond hop X"):
 * an unreached trace keeps at most `keep` of them (tracert prints all 30).
 */
export function trimSilentTail(hops: readonly TraceHop[], reached: boolean, keep = 2): TraceHop[] {
  if (reached) return [...hops];
  let lastResp = 0;
  for (const h of hops) if (h.ip !== null) lastResp = Math.max(lastResp, h.hop);
  return hops.filter((h) => h.hop <= lastResp + keep);
}

export interface SpawnOpts {
  signal?: AbortSignal;
  track?: (child: ChildProcess) => void;
}

/** `tracert` fallback (macOS: one sequential UDP-mode `traceroute`, see mac-path.ts). */
export async function runTracert(dst: string, family: IpFamily, maxHops: number, opts: SpawnOpts = {}): Promise<TracertRunResult> {
  if (isMac()) return runMacTraceroute(dst, family, maxHops, opts);
  const args = ['-d', '-w', String(PROBE_TIMEOUT_MS), '-h', String(maxHops), family === 4 ? '-4' : '-6', dst];
  const proc = await runProcess(system32('tracert.exe'), args, {
    timeoutMs: maxHops * 3 * 1500 + 10_000,
    signal: opts.signal,
    track: opts.track,
  });
  const parsed = parseTracert(decodeConsole(proc.stdout));
  const ok = parsed.hops.length > 0 && !proc.aborted;
  return {
    ok,
    hops: trimSilentTail(parsed.hops, parsed.reached),
    reached: parsed.reached,
    error: ok ? null : (proc.error ?? parsed.error ?? (proc.timedOut ? 'timeout' : `tracert exited (code ${proc.code ?? 'n/a'})`)),
    durationMs: proc.durationMs,
  };
}

// ─── results, route changes, dynamic hosts ─────────────────────────────────

/** sha1 over the responding hops ("1=192.168.0.1|3=92.79.214.92|…"). */
export function pathHash(hops: readonly TraceHop[]): string {
  return createHash('sha1').update(pathSignature(hops)).digest('hex');
}

/** A trace that says something about the path beyond the router (used for comparisons / $isp hosts). */
export function isUsableTrace(r: Pick<TracerouteResult, 'hops' | 'reached'>): boolean {
  return r.reached || respondingHops(r.hops).some((h) => h.hop >= 2);
}

function pathLength(r: Pick<TracerouteResult, 'hops'>): number | null {
  return r.hops.length > 0 ? r.hops[r.hops.length - 1].hop : null;
}

/** Segment of a route change at `hop` (hop 2 is the CMTS for IPv6 and the silent AFTR for IPv4). */
export function routeChangeSegment(family: IpFamily, hop: number | null): Segment {
  if (hop === 1) return 'lan';
  if (hop === 2) return family === 6 ? 'docsis' : 'aftr';
  return 'isp';
}

export function routeChangeEvent(cur: TracerouteResult, prev: TracerouteResult, cmp: PathComparison): NetEvent {
  const first = cmp.diffs[0] ?? null;
  const fam = `IPv${cur.family}`;
  const title = first
    ? `Routenwechsel ${fam} ab Hop ${first.hop} (${first.before ?? '–'} → ${first.after ?? '–'})`
    : `Routenwechsel ${fam}: Ziel nach ${cmp.curLength ?? pathLength(cur) ?? '–'} statt ${cmp.prevLength ?? pathLength(prev) ?? '–'} Hops`;
  return {
    ts: cur.ts,
    type: 'route_change',
    severity: 'info',
    segment: routeChangeSegment(cur.family, first ? first.hop : null),
    title,
    details: {
      family: cur.family,
      target: cur.target,
      diffs: cmp.diffs,
      lengthChanged: cmp.lengthChanged,
      prevLength: cmp.prevLength,
      curLength: cmp.curLength,
      pathHash: cur.pathHash,
      prevPathHash: prev.pathHash,
      prevTs: prev.ts,
      trigger: cur.trigger,
      tracerouteId: cur.id ?? null,
    },
    source: 'traceroute',
    dedupeKey: `route_change:${cur.family}:${cur.ts}`,
  };
}

/** New value for $isp4/$isp6 (null = keep as is). */
export function nextIspHost(
  family: IpFamily,
  current: string | null,
  recent: readonly TracerouteResult[],
  routerIps: readonly (string | null | undefined)[],
): string | null {
  const latest = recent[recent.length - 1];
  if (!latest || !isUsableTrace(latest)) return null;
  const next = chooseIspHost(current, recent.map((r) => r.hops), family, latest.target, routerIps);
  return next !== null && next !== current ? next : null;
}

export function describeTrace(r: TracerouteResult): string {
  const hops = r.hops.map((h) => h.ip ?? '*').join(' → ');
  return `IPv${r.family} ${r.target}: ${r.reached ? 'reached' : 'not reached'} in ${pathLength(r) ?? 0} hops (${hops})`;
}

// ─── module ────────────────────────────────────────────────────────────────

export type TraceTrigger = TracerouteResult['trigger'];

export interface TracerouteModuleOptions {
  runTtl?: (plan: TtlPlan, opts: TtlRunOptions) => Promise<TtlRunResult>;
  runTracert?: (dst: string, family: IpFamily, maxHops: number, opts: SpawnOpts) => Promise<TracertRunResult>;
  /** schedule check interval (default 30 s; wall clock, survives standby) */
  checkIntervalMs?: number;
  /** delay of the session-start discovery (default 5 s) */
  startupDelayMs?: number;
  /** rediscovery after an outage ended (default 20 s) */
  postOutageDelayMs?: number;
}

/** German failure for ModuleState.lastError */
class PathError extends Error {}

/** name of the sequential fallback in logs */
const fallbackName = (): string => (isMac() ? 'traceroute (UDP)' : 'tracert');

export function createTracerouteModule(opts: TracerouteModuleOptions = {}): EngineModule {
  const runTtl = opts.runTtl ?? runTtlProbes;
  const runTr = opts.runTracert ?? runTracert;
  const checkMs = opts.checkIntervalMs ?? 30_000;
  const startupDelayMs = opts.startupDelayMs ?? 5_000;
  const postOutageDelayMs = opts.postOutageDelayMs ?? 20_000;

  let ctx: EngineContext | null = null;
  let log: Logger | null = null;
  const unsubscribe: (() => void)[] = [];
  const history: Record<IpFamily, TracerouteResult[]> = { 4: [], 6: [] };
  let scheduled = false;
  let checkTimer: NodeJS.Timeout | null = null;
  let kickTimer: NodeJS.Timeout | null = null;
  let postOutageTimer: NodeJS.Timeout | null = null;
  let nextRunTs: number | null = null;
  let nextTrigger: TraceTrigger = 'schedule';
  let lastRunTs: number | null = null;
  let lastError: string | null = null;
  let lastIncidentTs: number | null = null;
  let ttlFailures = 0;
  let preferTracertUntil = 0;
  let current: { abort: AbortController; trigger: TraceTrigger; done: Promise<TracerouteResult[]> } | null = null;

  const intervalMs = (cfg: AppConfig) => Math.max(1, cfg.schedules.tracerouteEveryMin) * 60_000;

  async function probePath(
    c: EngineContext,
    family: IpFamily,
    maxHops: number,
    signal: AbortSignal,
  ): Promise<{ hops: TraceHop[]; reached: boolean; method: 'ttl' | 'tracert' } | null> {
    const target = PATH_TARGETS[family];
    const track = (child: ChildProcess) => c.trackChild(child);
    let ttlError: string | null = null;
    if (Date.now() >= preferTracertUntil) {
      const run = await runTtl(discoveryPlan(target, maxHops), { signal, track, isLocal: localAddressChecker() });
      if (signal.aborted) return null;
      if (run.ok) {
        ttlFailures = 0;
        if (run.error) log?.debug(`TTL probes IPv${family}: ${run.error}`);
        const built = buildTraceHops(run.probes, { silentTail: 2 });
        return { hops: built.hops, reached: built.reached, method: 'ttl' };
      }
      ttlError = run.error;
      ttlFailures++;
      log?.warn(`TTL probes IPv${family} failed – falling back to ${fallbackName()}`, { error: run.error });
      if (ttlFailures >= TTL_FAILURES_BEFORE_TRACERT) {
        preferTracertUntil = Date.now() + TRACERT_PREFERENCE_MS;
        ttlFailures = 0;
        log?.warn(`TTL probes failed repeatedly – using ${fallbackName()} for the next 6 h`);
      }
    }
    const tr = await runTr(target, family, maxHops, { signal, track });
    if (signal.aborted) return null;
    if (!tr.ok) {
      throw new PathError(`Pfaderkennung IPv${family} fehlgeschlagen (${tr.error ?? ttlError ?? 'unbekannter Fehler'})`);
    }
    return { hops: tr.hops, reached: tr.reached, method: 'tracert' };
  }

  async function discover(c: EngineContext, family: IpFamily, trigger: TraceTrigger, signal: AbortSignal): Promise<TracerouteResult | null> {
    const target = PATH_TARGETS[family];
    const maxHops = trigger === 'schedule' ? SCHEDULE_MAX_HOPS : FULL_MAX_HOPS;
    const ts = Date.now();
    const t0 = performance.now();
    const probed = await probePath(c, family, maxHops, signal);
    if (!probed) return null;
    const result: TracerouteResult = {
      ts,
      target,
      family,
      hops: probed.hops,
      reached: probed.reached,
      pathHash: pathHash(probed.hops),
      changed: false,
      trigger,
      durationMs: Math.round(performance.now() - t0),
    };
    const hist = history[family];
    const usable = isUsableTrace(result);
    const prev = hist.length > 0 ? hist[hist.length - 1] : null;
    const cmp = prev && usable ? comparePaths(prev, result, hist) : null;
    result.changed = cmp?.changed ?? false;
    try {
      result.id = c.db.insertTraceroute(result);
    } catch (err) {
      log?.error('could not store traceroute', { error: errorText(err) });
    }
    if (usable) {
      hist.push(result);
      if (hist.length > HISTORY_SIZE) hist.shift();
    }
    c.bus.emit('traceroute', result);
    if (cmp?.changed && prev) c.recordEvent(routeChangeEvent(result, prev, cmp));
    if (usable) {
      const key = family === 4 ? 'isp4' : 'isp6';
      const hosts = c.hosts.get();
      const next = nextIspHost(family, hosts[key], hist, [c.config().router.ip, hosts.gateway, hosts.router6]);
      if (next) c.hosts.set(family === 4 ? { isp4: next } : { isp6: next }, 'traceroute');
    }
    log?.info(`path ${describeTrace(result)} [${probed.method}, ${trigger}, ${result.durationMs} ms]${result.changed ? ' – ROUTE CHANGED' : ''}`);
    return result;
  }

  function launch(trigger: TraceTrigger, families: readonly IpFamily[]): Promise<TracerouteResult[]> {
    const c = ctx;
    if (!c) return Promise.resolve([]);
    const abort = new AbortController();
    const startedAt = Date.now();
    const done = (async () => {
      const errors: string[] = [];
      const results = await Promise.all(
        families.map((f) =>
          discover(c, f, trigger, abort.signal).catch((err: unknown) => {
            errors.push(err instanceof PathError ? err.message : `Pfaderkennung IPv${f}: unerwarteter Fehler (${errorText(err)})`);
            log?.warn(`discovery IPv${f} failed`, { error: errorText(err) });
            return null;
          }),
        ),
      );
      if (!abort.signal.aborted) {
        lastRunTs = startedAt;
        lastError = errors.length > 0 ? errors.join(' · ') : null;
      }
      return results.filter((r): r is TracerouteResult => r !== null);
    })().finally(() => {
      if (current?.abort === abort) current = null;
    });
    current = { abort, trigger, done };
    return done;
  }

  function check(): void {
    const c = ctx;
    if (!c || !scheduled || current) return;
    const now = Date.now();
    if (nextRunTs === null || now < nextRunTs) return;
    if (c.speedtestActive()) {
      nextRunTs = now + SPEEDTEST_RETRY_MS;
      return;
    }
    const trigger = nextTrigger;
    nextTrigger = 'schedule';
    nextRunTs = now + intervalMs(c.config());
    void launch(trigger, FAMILIES);
  }

  function tryIncidentRun(): boolean {
    const c = ctx;
    if (!c || !scheduled || current || c.speedtestActive()) return false;
    const now = Date.now();
    if (lastIncidentTs !== null && now - lastIncidentTs < INCIDENT_MIN_GAP_MS) return false;
    lastIncidentTs = now;
    void launch('incident', FAMILIES);
    return true;
  }

  function onIncident(i: BusEvents['incident']): void {
    if (!scheduled) return;
    if (i.kind === 'outage-start') {
      if (tryIncidentRun()) log?.info(`outage (${i.classification}) – incident path discovery`);
      return;
    }
    // outage ended: rediscover the path (dynamic hosts) once the line is back
    if (postOutageTimer) clearTimeout(postOutageTimer);
    const sinceLast = lastIncidentTs === null ? Infinity : Date.now() - lastIncidentTs;
    const delay = Math.max(postOutageDelayMs, INCIDENT_MIN_GAP_MS - sinceLast);
    postOutageTimer = setTimeout(() => {
      postOutageTimer = null;
      tryIncidentRun();
    }, delay);
    postOutageTimer.unref();
  }

  function clearTimers(): void {
    if (checkTimer) clearInterval(checkTimer);
    if (kickTimer) clearTimeout(kickTimer);
    if (postOutageTimer) clearTimeout(postOutageTimer);
    checkTimer = kickTimer = postOutageTimer = null;
  }

  async function abortCurrent(includeManual: boolean): Promise<void> {
    const cur = current;
    if (!cur || (!includeManual && cur.trigger === 'manual')) return;
    cur.abort.abort();
    await Promise.race([cur.done.catch(() => undefined), new Promise((r) => setTimeout(r, 3000).unref())]);
  }

  return {
    name: 'traceroute',

    init(c: EngineContext) {
      ctx = c;
      log = c.log;
      for (const f of FAMILIES) {
        try {
          const last = c.db.latestTraceroute(f);
          if (last && isUsableTrace(last)) history[f] = [last];
        } catch (err) {
          log.warn(`could not read the latest IPv${f} traceroute`, { error: errorText(err) });
        }
      }
      unsubscribe.push(c.bus.on('incident', onIncident));
    },

    start() {
      const c = ctx;
      if (!c) return;
      scheduled = true;
      nextTrigger = 'startup';
      nextRunTs = Date.now() + startupDelayMs;
      if (!checkTimer) {
        checkTimer = setInterval(check, checkMs);
        checkTimer.unref();
      }
      if (kickTimer) clearTimeout(kickTimer);
      kickTimer = setTimeout(() => {
        kickTimer = null;
        check();
      }, startupDelayMs + 50);
      kickTimer.unref();
    },

    async stop() {
      scheduled = false;
      clearTimers();
      nextRunTs = null;
      nextTrigger = 'schedule';
      await abortCurrent(false);
    },

    async dispose() {
      scheduled = false;
      clearTimers();
      nextRunTs = null;
      await abortCurrent(true);
      for (const off of unsubscribe.splice(0)) off();
    },

    reconfigure(cfg: AppConfig) {
      if (!scheduled || nextRunTs === null || nextTrigger !== 'schedule') return;
      nextRunTs = Math.max(Date.now() + 5_000, (lastRunTs ?? Date.now()) + intervalMs(cfg));
    },

    async runNow(params?: Record<string, unknown>): Promise<TaskResult<TracerouteResult[]>> {
      if (!ctx) throw new Error('Pfaderkennung ist nicht initialisiert');
      if (current) throw new Error('Pfaderkennung läuft bereits');
      const f = params?.family;
      const families: readonly IpFamily[] = f === 4 || f === 6 ? [f] : FAMILIES;
      const results = await launch('manual', families);
      if (results.length === 0) return { ok: false, error: lastError ?? 'Pfaderkennung fehlgeschlagen' };
      return { ok: true, result: results };
    },

    state(): ModuleState {
      return {
        name: 'traceroute',
        enabled: true,
        running: scheduled,
        busy: current !== null,
        lastRunTs,
        nextRunTs: scheduled ? nextRunTs : null,
        lastError,
      };
    },
  };
}
