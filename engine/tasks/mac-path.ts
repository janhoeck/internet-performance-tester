// macOS path probing (docs/research/macos.md §6), dispatched from traceroute.ts / mtu.ts:
//  - TTL probes: ONE `/usr/sbin/traceroute -n -I -q 1 -w <s> -f T -m T <dst>` (traceroute6 for IPv6)
//    per (TTL, round) – same plan semantics as ttl-probe.ps1 (≤ maxConc in flight, rounds start
//    intervalMs apart and never overlap, stopAtDest, trimSilent). traceroute is setuid root and
//    times the probe itself, so the process start does not distort the RTT; one probe per hop and
//    second respects ICMP rate limits like the Windows runner.
//  - fallback: one sequential UDP-mode `traceroute -n -q 3 -w 1 -m N` (different probe type in case
//    ICMP is filtered)
//  - MTU: DF echo `ping -n -D -s <payload> -c 1` / `ping6 -n -D -m -s <payload> -c 1` and the path MTU
//    of the cloned host route from `route -n get [-inet6] <dst>`
// No top-level use of traceroute.ts values: the two modules import each other.
import { performance } from 'node:perf_hooks';
import { isIpLiteral, sameIp } from '../../src/lib/shared/net';
import { parseMacPing } from '../../src/lib/shared/parsers/macos/ping';
import { parseRouteGet } from '../../src/lib/shared/parsers/macos/route';
import { type BsdTraceProbe, type BsdTraceroute, isUnreachableAnnotation, parseBsdTraceroute } from '../../src/lib/shared/parsers/macos/traceroute';
import { type HopProbe, type HopProbeKind, buildTraceHops } from '../../src/lib/shared/path-analysis';
import type { IpFamily } from '../../src/lib/shared/types';
import { MAC_TOOLS, toolEnv } from '../collectors/macos/tools';
import type { MtuProbeOutcome } from './mtu';
import {
  type ProcessOptions,
  type ProcessResult,
  type SpawnOpts,
  type TracertRunResult,
  type TtlPlan,
  type TtlRunOptions,
  type TtlRunResult,
  PROBE_TIMEOUT_MS,
  normalizeResponder,
  runProcess,
  trimSilentTail,
} from './traceroute';

export type RunFn = (file: string, args: readonly string[], opts: ProcessOptions) => Promise<ProcessResult>;

export interface MacPathDeps {
  /** child process runner (tests) */
  run?: RunFn;
  /** monotonic clock in ms (tests) */
  now?: () => number;
}

/** EX_USAGE of the BSD tools (unknown option). */
const EX_USAGE = 64;

/** traceroute6 rejected -I (ICMP mode) once – later runs use UDP probes for IPv6. */
let traceroute6NoIcmp = false;
/** ping6 rejected -D (no fragmentation) once – later MTU probes rely on -m and the route cache. */
let ping6NoDontFrag = false;

/** Tests only: forget the remembered option fallbacks. */
export function resetMacPathState(): void {
  traceroute6NoIcmp = false;
  ping6NoDontFrag = false;
}

const familyOf = (ip: string): IpFamily => (ip.includes(':') ? 6 : 4);
const output = (p: ProcessResult): string => `${p.stdout.toString('utf8')}\n${p.stderr.toString('utf8')}`;
const isUsage = (p: ProcessResult, parsed: { usage: boolean }): boolean => parsed.usage || p.code === EX_USAGE;

// ─── TTL probes ────────────────────────────────────────────────────────────

/** traceroute wait time: whole seconds, at least 1. */
export const waitSeconds = (timeoutMs: number): number => Math.max(1, Math.ceil(timeoutMs / 1000));

export function ttlProbeArgs(dst: string, ttl: number, timeoutMs: number, icmp: boolean): string[] {
  const t = String(ttl);
  return ['-n', ...(icmp ? ['-I'] : []), '-q', '1', '-w', String(waitSeconds(timeoutMs)), '-f', t, '-m', t, dst];
}

/** Upper bound of a run (every round at its worst) – the hard timeout. */
export function estimateMacRunMs(plan: TtlPlan): number {
  const batches = Math.max(1, Math.ceil(plan.ttls.length / Math.max(1, plan.maxConc)));
  const perRound = Math.max(plan.intervalMs, batches * (waitSeconds(plan.timeoutMs) * 1000 + 2500));
  return 5_000 + plan.rounds * perRound;
}

/**
 * One parsed traceroute probe → HopProbe (same semantics as hopProbeKind for the .NET runner):
 * destination answered → reply; another responder → ttl-expired; "!H/!N/…" → unreachable (from our
 * own address = local failure → error); '*' → lost; send failure → error.
 */
export function bsdProbeToHop(p: BsdTraceProbe | null, ttl: number, round: number, dst: string, isLocal: (ip: string) => boolean): HopProbe {
  const lost = (kind: HopProbeKind): HopProbe => ({ ttl, round, from: null, rttMs: null, kind });
  if (!p) return lost('error');
  if (p.sendError) return lost('error');
  const from = normalizeResponder(p.from);
  if (from === null) return lost('lost');
  let kind: HopProbeKind;
  if (isUnreachableAnnotation(p.annotation)) kind = isLocal(from) ? 'error' : 'unreachable';
  else kind = sameIp(from, dst) ? 'reply' : 'ttl-expired';
  if (kind === 'error') return lost('error');
  const ms = p.rttMs !== null && p.rttMs >= 0 ? Math.round(p.rttMs * 100) / 100 : null;
  return { ttl, round, from, rttMs: ms, kind };
}

/** Probe of one single-TTL run (the hop line of `ttl`, else the only hop line). */
export function singleRunProbe(parsed: BsdTraceroute, ttl: number, round: number, dst: string, isLocal: (ip: string) => boolean, timedOut: boolean): HopProbe {
  const hop = parsed.hops.find((h) => h.ttl === ttl) ?? (parsed.hops.length === 1 ? parsed.hops[0] : null);
  const p = hop?.probes[0] ?? null;
  // killed before it printed anything: the probe got no answer in time
  if (!p && timedOut) return { ttl, round, from: null, rttMs: null, kind: 'lost' };
  return bsdProbeToHop(p, ttl, round, dst, isLocal);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, Math.max(0, ms));
    signal.addEventListener('abort', done, { once: true });
  });
}

/** TTL plan with one traceroute process per (TTL, round). Never rejects. */
export async function runMacTtlProbes(plan: TtlPlan, opts: TtlRunOptions = {}, deps: MacPathDeps = {}): Promise<TtlRunResult> {
  const now = deps.now ?? (() => performance.now());
  const run = deps.run ?? runProcess;
  const started = now();
  if (!isIpLiteral(plan.dst)) {
    return { ok: false, probes: [], complete: false, error: `invalid probe destination: ${plan.dst}`, durationMs: 0 };
  }
  const family = familyOf(plan.dst);
  const isLocal = opts.isLocal ?? (() => false);
  const abort = new AbortController();
  const onAbort = () => abort.abort();
  if (opts.signal?.aborted) abort.abort();
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  let timedOut = false;
  const hardTimer = setTimeout(() => {
    timedOut = true;
    abort.abort();
  }, opts.timeoutMs ?? estimateMacRunMs(plan));

  const probes: HopProbe[] = [];
  let limit = Number.POSITIVE_INFINITY; // smallest TTL with a terminal answer
  let cap = Number.POSITIVE_INFINITY; // TTL cap for later rounds when nothing answers beyond a hop
  let lastResp = 0;
  let fatal: string | null = null;
  const procTimeoutMs = waitSeconds(plan.timeoutMs) * 1000 + 2000;

  const probeOnce = async (ttl: number, round: number): Promise<void> => {
    const tool = family === 6 ? MAC_TOOLS.traceroute6 : MAC_TOOLS.traceroute;
    for (let attempt = 0; attempt < 2; attempt++) {
      const icmp = family === 4 || !traceroute6NoIcmp;
      const proc = await run(tool, ttlProbeArgs(plan.dst, ttl, plan.timeoutMs, icmp), {
        timeoutMs: procTimeoutMs,
        signal: abort.signal,
        track: opts.track,
        env: toolEnv(),
        maxBytes: 64 * 1024,
      });
      if (proc.aborted) return;
      if (proc.error && !proc.timedOut) {
        fatal ??= `${tool}: ${proc.error}`;
        probes.push({ ttl, round, from: null, rttMs: null, kind: 'error' });
        return;
      }
      const parsed = parseBsdTraceroute(output(proc));
      if (isUsage(proc, parsed)) {
        if (icmp && family === 6) {
          // KAME traceroute6 without -I: fall back to UDP probes for the rest of the engine run
          traceroute6NoIcmp = true;
          continue;
        }
        fatal ??= `${tool}: unsupported arguments`;
        probes.push({ ttl, round, from: null, rttMs: null, kind: 'error' });
        return;
      }
      const hp = singleRunProbe(parsed, ttl, round, plan.dst, isLocal, proc.timedOut);
      probes.push(hp);
      if (hp.from !== null) {
        lastResp = Math.max(lastResp, ttl);
        if ((hp.kind === 'reply' || hp.kind === 'unreachable') && ttl < limit) limit = ttl;
      }
      return;
    }
  };

  const inflight = new Set<Promise<void>>();
  const beyond = (ttl: number) => plan.stopAtDest && (ttl > limit || ttl > cap);
  // the tool is missing / unusable: every probe so far failed locally
  const hopeless = () => fatal !== null && probes.length > 0 && probes.every((p) => p.kind === 'error');
  let rounds = 0;
  try {
    for (let round = 1; round <= plan.rounds && !abort.signal.aborted && !hopeless(); round++) {
      const roundStart = now();
      for (const ttl of plan.ttls) {
        if (beyond(ttl)) break;
        while (inflight.size >= Math.max(1, plan.maxConc)) await Promise.race(inflight);
        if (abort.signal.aborted || beyond(ttl) || hopeless()) break;
        const p: Promise<void> = probeOnce(ttl, round)
          .catch(() => undefined)
          .finally(() => inflight.delete(p));
        inflight.add(p);
      }
      await Promise.all(inflight);
      if (abort.signal.aborted) break;
      rounds = round;
      if (plan.stopAtDest && plan.trimSilent > 0 && limit === Number.POSITIVE_INFINITY) cap = lastResp + plan.trimSilent;
      if (round < plan.rounds) await sleep(plan.intervalMs - (now() - roundStart), abort.signal);
    }
  } finally {
    clearTimeout(hardTimer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
  const aborted = opts.signal?.aborted === true;
  const complete = rounds === plan.rounds && !aborted && !timedOut;
  probes.sort((a, b) => a.round - b.round || a.ttl - b.ttl);
  let error: string | null = null;
  if (fatal) error = fatal;
  else if (aborted) error = 'aborted';
  else if (timedOut) error = 'timeout';
  else if (!complete) error = `incomplete run (${rounds}/${plan.rounds} rounds)`;
  return {
    ok: probes.length > 0 && (fatal === null || probes.some((p) => p.kind !== 'error')),
    probes,
    complete,
    error,
    durationMs: now() - started,
  };
}

// ─── sequential fallback ───────────────────────────────────────────────────

export function tracerouteArgs(dst: string, maxHops: number): string[] {
  return ['-n', '-q', '3', '-w', '1', '-m', String(maxHops), dst];
}

/** One sequential UDP-mode traceroute → hops (macOS counterpart of runTracert). Never rejects. */
export async function runMacTraceroute(dst: string, family: IpFamily, maxHops: number, opts: SpawnOpts = {}, deps: MacPathDeps = {}): Promise<TracertRunResult> {
  const run = deps.run ?? runProcess;
  const tool = family === 6 ? MAC_TOOLS.traceroute6 : MAC_TOOLS.traceroute;
  const proc = await run(tool, tracerouteArgs(dst, maxHops), {
    timeoutMs: maxHops * 3 * 1500 + 10_000,
    signal: opts.signal,
    track: opts.track,
    env: toolEnv(),
  });
  const parsed = parseBsdTraceroute(output(proc));
  const probes = parsed.hops.flatMap((h) => h.probes.map((p, i) => bsdProbeToHop(p, h.ttl, i + 1, dst, () => false)));
  const built = buildTraceHops(probes, { silentTail: 2 });
  const ok = parsed.hops.length > 0 && !proc.aborted && !isUsage(proc, parsed);
  let error: string | null = null;
  if (!ok) {
    error =
      proc.error ??
      (isUsage(proc, parsed) ? `${tool}: unsupported arguments` : null) ??
      parsed.errors[0] ??
      (proc.timedOut ? 'timeout' : `traceroute exited (code ${proc.code ?? 'n/a'})`);
  }
  return { ok, hops: trimSilentTail(built.hops, built.reached), reached: built.reached, error, durationMs: proc.durationMs };
}

// ─── MTU ───────────────────────────────────────────────────────────────────

export function dfPingArgs(family: IpFamily, target: string, payload: number, timeoutMs: number, dontFragment = true): string[] {
  const size = ['-s', String(payload), '-c', '1'];
  return family === 4
    ? ['-n', '-D', ...size, '-W', String(Math.max(1, Math.round(timeoutMs))), target]
    : ['-n', ...(dontFragment ? ['-D'] : []), '-m', ...size, target];
}

/** Outcome of one DF echo: reply → ok; "Frag needed" / "Packet too big" / "Message too long" → too-big. */
export function classifyMacDfPing(text: string, timedOut = false): MtuProbeOutcome {
  const r = parseMacPing(text);
  if (r.kind === 'reply') return 'ok';
  if (r.kind === 'too_big') return 'too-big';
  if (r.kind === 'none') return 'timeout';
  if (timedOut && r.kind === 'send_error' && !r.usage) return 'timeout';
  return 'error';
}

/** IPv6 MTU probes set the "don't fragment" option (false after ping6 rejected -D). */
export function macV6DontFragment(): boolean {
  return !ping6NoDontFrag;
}

/** One DF echo with `payload` bytes (macOS counterpart of pingExeDfProbe). Never rejects. */
export async function macDfProbe(
  family: IpFamily,
  target: string,
  payload: number,
  opts: SpawnOpts & { timeoutMs?: number } = {},
  deps: MacPathDeps = {},
): Promise<MtuProbeOutcome> {
  if (!isIpLiteral(target) || !Number.isInteger(payload) || payload < 0 || payload > 65_500) return 'error';
  const run = deps.run ?? runProcess;
  const timeoutMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS;
  for (let attempt = 0; attempt < 2; attempt++) {
    const dontFragment = family === 4 || !ping6NoDontFrag;
    const proc = await run(family === 6 ? MAC_TOOLS.ping6 : MAC_TOOLS.ping, dfPingArgs(family, target, payload, timeoutMs, dontFragment), {
      // ping -W ends IPv4 by itself; ping6 has no reply timeout → our kill timer
      timeoutMs: family === 6 ? timeoutMs + 500 : timeoutMs + 1500,
      signal: opts.signal,
      track: opts.track,
      env: toolEnv(),
    });
    if (proc.aborted || (proc.error && !proc.timedOut)) return 'error';
    const text = output(proc);
    if (family === 6 && dontFragment && isUsage(proc, parseMacPing(text))) {
      ping6NoDontFrag = true;
      continue;
    }
    return classifyMacDfPing(text, proc.timedOut);
  }
  return 'error';
}

/**
 * Path MTU macOS learned for `target` (`route -n get`): the MTU of a cloned host route (created by
 * "fragmentation needed" / ICMPv6 Packet Too Big); null for the plain default route (its MTU is
 * just the interface MTU) or when the route cannot be read.
 */
export async function readMacPmtu(family: IpFamily, target: string, opts: SpawnOpts = {}, deps: MacPathDeps = {}): Promise<number | null> {
  const run = deps.run ?? runProcess;
  const proc = await run(MAC_TOOLS.route, ['-n', 'get', ...(family === 6 ? ['-inet6'] : []), target], {
    timeoutMs: 10_000,
    signal: opts.signal,
    track: opts.track,
    env: toolEnv(),
  });
  if (proc.error || proc.timedOut || proc.aborted) return null;
  const r = parseRouteGet(proc.stdout.toString('utf8'));
  if (!r || r.mtu === null) return null;
  const hostRoute = r.flags.includes('HOST') || r.flags.includes('WASCLONED') || (r.destination !== null && sameIp(r.destination, target));
  return hostRoute ? r.mtu : null;
}
