// Path MTU (ARCHITECTURE §4.7, windows-collectors §5): DontFragment binary search with .NET Ping
// (`PingOptions(64, true)`) through the PowerShell RPC worker – one short command per probe size –
// and ping.exe (`-f -l`) as fallback when the worker is unavailable.
//  IPv4 → 1.1.1.1, payload 1200…1472 (+28 IP/ICMP header). DS-Lite today: 1432 → MTU 1460.
//  IPv6 → 2606:4700:4700::1111, payload 1200…1452 (+48). IPv6 has no DF bit: Windows fragments
//         oversized IPv6 echoes itself (verified: 1453/1480/8000 bytes all succeed, even with
//         PingOptions.DontFragment), so a success only counts when the packet fits into the path
//         MTU Windows learned for the target (destination cache, updated by ICMPv6 Packet Too Big).
//         LIMITATION: an IPv6 path that silently drops big packets (no Packet Too Big) is not seen.
// Windows caches the PMTU after the first "fragmentation needed"; later oversized DF probes fail
// locally (PacketTooBig without responder). Both count as "too big".
// Results: snapshot 'mtu' (MtuResult[]), metrics mtu.v4 / mtu.v6, `mtu_change` event on change.
// Runs every `mtuEveryMin` while a session runs (first run 2 min after the start when the last
// result is older than the interval) and runNow().
import type { ChildProcess } from 'node:child_process';
import type { AppConfig } from '../../src/lib/shared/config';
import { decodeConsole } from '../../src/lib/shared/cp850';
import { isIpLiteral, normalizeIp, sameIp } from '../../src/lib/shared/net';
import type { IpFamily, MetricPoint, ModuleState, MtuResult, NetEvent } from '../../src/lib/shared/types';
import type { EngineContext, EngineModule, Logger, PowerShellHost, TaskResult } from '../core/types';
import { FAMILIES, PATH_TARGETS, PROBE_TIMEOUT_MS, errorText, runProcess, system32 } from './traceroute';

export interface MtuRange {
  lo: number;
  hi: number;
  /** IP + ICMP header bytes added to the payload */
  overhead: number;
}

export const MTU_RANGES: Readonly<Record<IpFamily, MtuRange>> = {
  4: { lo: 1200, hi: 1472, overhead: 28 },
  6: { lo: 1200, hi: 1452, overhead: 48 },
};

export type MtuProbeOutcome = 'ok' | 'too-big' | 'timeout' | 'error';
export type MtuProbe = (payload: number) => Promise<MtuProbeOutcome>;

const FIRST_RUN_DELAY_MS = 2 * 60_000;
const SPEEDTEST_RETRY_MS = 2 * 60_000;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// ─── binary search (pure, probe injected) ──────────────────────────────────

export interface MtuSearchResult {
  /** largest payload that passed, null when undetermined */
  maxPayload: number | null;
  steps: { payload: number; outcome: MtuProbeOutcome }[];
  /** timeouts counted as "too big" (possible PMTU black hole) */
  timeoutsAsTooBig: number;
  /** why no value was determined: target unreachable, local/ICMP error, MTU below the search range */
  failure: 'unreachable' | 'error' | 'below-range' | null;
}

/**
 * Largest payload in [lo, hi] that passes. `lo` must pass (else the target is unreachable / the MTU
 * is below the range); a timeout is retried `retries` times and then counted as "too big" (packets
 * silently dropped = PMTU black hole); an error aborts the search.
 */
export async function searchMaxPayload(
  probe: MtuProbe,
  lo: number,
  hi: number,
  opts: { retries?: number; signal?: AbortSignal } = {},
): Promise<MtuSearchResult> {
  const retries = opts.retries ?? 1;
  const steps: MtuSearchResult['steps'] = [];
  const memo = new Map<number, MtuProbeOutcome>();
  let timeoutsAsTooBig = 0;
  const run = async (payload: number): Promise<MtuProbeOutcome> => {
    const known = memo.get(payload);
    if (known) return known;
    let outcome: MtuProbeOutcome = 'error';
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (opts.signal?.aborted) throw new Error('aborted');
      outcome = await probe(payload);
      steps.push({ payload, outcome });
      if (outcome === 'ok' || outcome === 'too-big') break;
    }
    memo.set(payload, outcome);
    return outcome;
  };
  const done = (maxPayload: number | null, failure: MtuSearchResult['failure']): MtuSearchResult => ({
    maxPayload,
    steps,
    timeoutsAsTooBig,
    failure,
  });

  const first = await run(lo);
  if (first === 'too-big') return done(null, 'below-range');
  if (first === 'timeout') return done(null, 'unreachable');
  if (first === 'error') return done(null, 'error');
  // probe the top first: most paths pass it (MTU 1500) and the search ends after two probes
  const top = await run(hi);
  if (top === 'ok') return done(hi, null);
  if (top === 'error') return done(null, 'error');
  if (top === 'timeout') timeoutsAsTooBig++;
  let good = lo;
  let bad = hi;
  while (bad - good > 1) {
    const mid = Math.floor((good + bad) / 2);
    const o = await run(mid);
    if (o === 'ok') good = mid;
    else if (o === 'too-big') bad = mid;
    else if (o === 'timeout') {
      bad = mid;
      timeoutsAsTooBig++;
    } else return done(null, 'error');
  }
  return done(good, null);
}

// ─── probes ────────────────────────────────────────────────────────────────

/** .NET IPStatus name → outcome (PacketTooBig: ICMP "fragmentation needed" or local PMTU cache). */
export function outcomeFromStatus(st: string): MtuProbeOutcome {
  if (st === 'Success') return 'ok';
  if (st === 'PacketTooBig') return 'too-big';
  if (st === 'TimedOut') return 'timeout';
  return 'error';
}

/** One DF echo via the RPC worker; writes exactly one JSON document. */
export function psDfPingScript(target: string, payload: number, timeoutMs: number): string {
  if (!isIpLiteral(target)) throw new Error(`invalid target: ${target}`);
  if (!Number.isInteger(payload) || payload < 0 || payload > 65_500) throw new Error(`invalid payload: ${payload}`);
  return [
    '$p = New-Object System.Net.NetworkInformation.Ping',
    'try {',
    '  $o = New-Object System.Net.NetworkInformation.PingOptions(64, $true)',
    `  $r = $p.Send('${target}', ${Math.round(timeoutMs)}, (New-Object byte[] ${payload}), $o)`,
    '  $from = $null',
    '  if ($null -ne $r.Address) { $from = $r.Address.ToString() }',
    '  ConvertTo-Json -Compress -InputObject @{ st = $r.Status.ToString(); from = $from; rtt = [int64]$r.RoundtripTime }',
    '} catch {',
    "  ConvertTo-Json -Compress -InputObject @{ st = 'Exception'; from = $null; rtt = $null; err = $_.Exception.GetBaseException().Message }",
    '} finally { $p.Dispose() }',
  ].join('\n');
}

export async function dotnetDfProbe(ps: PowerShellHost, target: string, payload: number): Promise<MtuProbeOutcome> {
  const res = await ps.json<unknown>(psDfPingScript(target, payload, PROBE_TIMEOUT_MS), { timeoutMs: PROBE_TIMEOUT_MS + 5_000 });
  if (!isRecord(res) || typeof res.st !== 'string') throw new Error('unexpected PowerShell result');
  return outcomeFromStatus(res.st);
}

/** ping.exe arguments: IPv4 with DF (-f), IPv6 without (ping.exe has no DF for IPv6). */
export function pingArgs(family: IpFamily, target: string, payload: number, timeoutMs: number): string[] {
  return family === 4
    ? ['-4', '-f', '-n', '1', '-w', String(timeoutMs), '-l', String(payload), target]
    : ['-6', '-n', '1', '-w', String(timeoutMs), '-l', String(payload), target];
}

/**
 * Classifies the output of `ping -f -l <n> -n 1` (de-DE + en-US, ASCII fragments only, see
 * fixtures/windows/ping_DF_*, ping_v6_*):
 *  "Paket müsste fragmentiert werden, DF-Flag ist jedoch gesetzt." / "Packet needs to be fragmented
 *  but DF set." (with or without "Antwort von <router>:") → too-big; echo reply → ok;
 *  "Zeitüberschreitung der Anforderung." / "Request timed out." → timeout; everything else → error.
 */
export function classifyDfPingOutput(text: string): MtuProbeOutcome {
  let outcome: MtuProbeOutcome | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '') continue;
    if (/fragment/i.test(line) && /\bDF\b/.test(line)) return 'too-big';
    // IPv6 addresses contain colons → the separator is ':' followed by whitespace
    const reply = /^(?:Antwort von|Reply from)\s+(\S+?):\s+(.*)$/i.exec(line);
    if (reply) {
      outcome ??= /(?:bytes=\d+|(?:zeit|time)\s*[=<]\s*\d+\s*ms)/i.test(reply[2]) ? 'ok' : 'error';
      continue;
    }
    if (/Zeit\S{0,2}berschreitung|timed out/i.test(line)) outcome ??= 'timeout';
    else if (/nicht erreichbar|unreachable|Allgemeiner Fehler|General failure|bertragung|transmit failed|Hardware/i.test(line)) {
      outcome ??= 'error';
    }
  }
  return outcome ?? 'error';
}

export async function pingExeDfProbe(
  family: IpFamily,
  target: string,
  payload: number,
  opts: { signal?: AbortSignal; track?: (child: ChildProcess) => void } = {},
): Promise<MtuProbeOutcome> {
  const proc = await runProcess(system32('PING.EXE'), pingArgs(family, target, payload, PROBE_TIMEOUT_MS), {
    timeoutMs: PROBE_TIMEOUT_MS + 5_000,
    signal: opts.signal,
    track: opts.track,
  });
  if (proc.error || proc.aborted || proc.timedOut) return 'error';
  return classifyDfPingOutput(decodeConsole(proc.stdout));
}

// ─── Windows destination cache (learned path MTU) ──────────────────────────

export interface DestCacheEntry {
  ifIndex: number | null;
  ifName: string | null;
  pmtu: number;
  destination: string;
  nextHop: string;
}

/**
 * `netsh interface ipv4|ipv6 show destinationcache` (table form, fixtures/windows/netsh_*_destinationcache*):
 * interface headers "Schnittstelle 4: Ethernet" / "Interface 4: Ethernet", data rows
 * "<pmtu> <destination> <next hop>" – the localized column headers are ignored.
 */
export function parseDestinationCache(text: string): DestCacheEntry[] {
  const out: DestCacheEntry[] = [];
  let ifIndex: number | null = null;
  let ifName: string | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '') continue;
    const row = /^(\d+)\s+(\S+)\s+(\S+)$/.exec(line);
    if (row && isIpLiteral(row[2]) && isIpLiteral(row[3])) {
      out.push({ ifIndex, ifName, pmtu: Number(row[1]), destination: row[2], nextHop: row[3] });
      continue;
    }
    const head = /^\S+\s+(\d+):\s*(.+)$/.exec(line);
    if (head) {
      ifIndex = Number(head[1]);
      ifName = head[2].trim();
    }
  }
  return out;
}

function isUnspecified(ip: string): boolean {
  const n = normalizeIp(ip);
  return n === '0.0.0.0' || /^[0:]+$/.test(n);
}

/**
 * Path MTU Windows uses for `target`: entries with a real next hop first, on the preferred
 * interface (current egress) if present; the smallest value wins.
 */
export function pickPmtu(entries: readonly DestCacheEntry[], target: string, preferIf?: string | null): number | null {
  const mine = entries.filter((e) => sameIp(e.destination, target) && e.pmtu > 0);
  if (mine.length === 0) return null;
  const routed = mine.filter((e) => !isUnspecified(e.nextHop));
  let pool = routed.length > 0 ? routed : mine;
  if (preferIf) {
    const want = preferIf.trim().toLowerCase();
    const onIf = pool.filter((e) => e.ifName !== null && e.ifName.toLowerCase() === want);
    if (onIf.length > 0) pool = onIf;
  }
  return Math.min(...pool.map((e) => e.pmtu));
}

export async function readDestinationCache(
  family: IpFamily,
  opts: { signal?: AbortSignal; track?: (child: ChildProcess) => void } = {},
): Promise<DestCacheEntry[] | null> {
  const proc = await runProcess(system32('netsh.exe'), ['interface', family === 4 ? 'ipv4' : 'ipv6', 'show', 'destinationcache'], {
    timeoutMs: 10_000,
    signal: opts.signal,
    track: opts.track,
  });
  if (proc.error || proc.timedOut || proc.aborted || proc.code !== 0) return null;
  return parseDestinationCache(decodeConsole(proc.stdout));
}

// ─── one family ────────────────────────────────────────────────────────────

export interface FamilyMeasurement {
  result: MtuResult;
  search: MtuSearchResult;
  /** path MTU from the Windows destination cache (null = not readable / no entry) */
  cachePmtu: number | null;
}

/**
 * Measures one family. For IPv6 the largest size is probed first (a router with a smaller MTU
 * answers with Packet Too Big and Windows learns it), then the destination cache caps every success.
 */
export async function measureFamilyMtu(
  family: IpFamily,
  probe: MtuProbe,
  readCachePmtu: () => Promise<number | null>,
  opts: { ts?: number; signal?: AbortSignal } = {},
): Promise<FamilyMeasurement> {
  const target = PATH_TARGETS[family];
  const range = MTU_RANGES[family];
  const ts = opts.ts ?? Date.now();
  const notes: string[] = [];
  let search: MtuSearchResult;
  let cachePmtu: number | null;
  if (family === 6) {
    const memo = new Map<number, MtuProbeOutcome>();
    const memoProbe: MtuProbe = async (payload) => {
      const known = memo.get(payload);
      if (known === 'ok' || known === 'too-big') return known;
      const o = await probe(payload);
      memo.set(payload, o);
      return o;
    };
    await memoProbe(range.hi);
    cachePmtu = await readCachePmtu();
    const capped: MtuProbe = async (payload) =>
      cachePmtu !== null && payload + range.overhead > cachePmtu ? 'too-big' : memoProbe(payload);
    search = await searchMaxPayload(capped, range.lo, range.hi, { signal: opts.signal });
    if (cachePmtu === null && search.maxPayload !== null) {
      notes.push('IPv6 ohne DF-Bit: Windows fragmentiert selbst, Pfad-MTU nicht überprüfbar (Zielcache nicht lesbar)');
    }
  } else {
    search = await searchMaxPayload(probe, range.lo, range.hi, { signal: opts.signal });
    cachePmtu = await readCachePmtu();
  }
  const mtu = search.maxPayload === null ? null : search.maxPayload + range.overhead;
  if (search.failure === 'unreachable') notes.push(`Ziel ${target} nicht erreichbar`);
  else if (search.failure === 'below-range') notes.push(`Pfad-MTU kleiner als ${range.lo + range.overhead} Byte`);
  else if (search.failure === 'error') notes.push('Ping mit gesetztem DF-Bit fehlgeschlagen');
  if (search.timeoutsAsTooBig > 0) notes.push('Zeitüberschreitungen als „zu groß“ gewertet (mögliches PMTU-Blackhole)');
  if (family === 4 && mtu !== null && cachePmtu !== null && cachePmtu !== mtu) notes.push(`Windows-Zielcache meldet ${cachePmtu} Byte`);
  return {
    result: { ts, family, target, mtu, maxPayload: search.maxPayload, note: notes.length > 0 ? notes.join(' · ') : null },
    search,
    cachePmtu,
  };
}

/** `mtu_change` when a determined MTU differs from the previous determined value. */
export function mtuChangeEvent(prev: MtuResult | null, cur: MtuResult): NetEvent | null {
  if (!prev || prev.mtu === null || cur.mtu === null || prev.mtu === cur.mtu) return null;
  const expected = cur.family === 4 ? 1460 : 1500;
  return {
    ts: cur.ts,
    type: 'mtu_change',
    severity: cur.mtu < expected ? 'warn' : 'info',
    segment: cur.family === 4 ? 'aftr' : 'isp',
    title: `Pfad-MTU IPv${cur.family} geändert: ${prev.mtu} → ${cur.mtu} Byte`,
    details: { family: cur.family, target: cur.target, before: prev.mtu, after: cur.mtu, maxPayload: cur.maxPayload, note: cur.note ?? null },
    source: 'mtu',
    dedupeKey: `mtu_change:${cur.family}:${cur.ts}`,
  };
}

export function mtuMetrics(results: readonly MtuResult[]): MetricPoint[] {
  return results
    .filter((r): r is MtuResult & { mtu: number } => r.mtu !== null)
    .map((r) => ({ ts: r.ts, key: r.family === 4 ? 'mtu.v4' : 'mtu.v6', value: r.mtu }));
}

/** MtuResult[] from a stored 'mtu' snapshot (array or { results }) – tolerant. */
export function mtuResultsFromSnapshot(data: unknown): MtuResult[] {
  const list = Array.isArray(data) ? data : isRecord(data) && Array.isArray(data.results) ? data.results : [];
  return list.filter(
    (r): r is MtuResult => isRecord(r) && (r.family === 4 || r.family === 6) && (r.mtu === null || typeof r.mtu === 'number') && typeof r.ts === 'number',
  );
}

// ─── module ────────────────────────────────────────────────────────────────

export interface MtuModuleOptions {
  /** probe override (tests): one DF echo with `payload` bytes */
  probe?: (family: IpFamily, target: string, payload: number) => Promise<MtuProbeOutcome>;
  /** destination cache override (tests) */
  readCache?: (family: IpFamily) => Promise<DestCacheEntry[] | null>;
  /** schedule check interval (default 60 s; wall clock, survives standby) */
  checkIntervalMs?: number;
  firstRunDelayMs?: number;
}

export function createMtuModule(opts: MtuModuleOptions = {}): EngineModule {
  const checkMs = opts.checkIntervalMs ?? 60_000;
  const firstRunDelayMs = opts.firstRunDelayMs ?? FIRST_RUN_DELAY_MS;

  let ctx: EngineContext | null = null;
  let log: Logger | null = null;
  let scheduled = false;
  let checkTimer: NodeJS.Timeout | null = null;
  let nextRunTs: number | null = null;
  let lastRunTs: number | null = null;
  let lastError: string | null = null;
  const lastKnown: Record<IpFamily, MtuResult | null> = { 4: null, 6: null };
  let current: { abort: AbortController; manual: boolean; done: Promise<MtuResult[]> } | null = null;

  const intervalMs = (cfg: AppConfig) => Math.max(10, cfg.schedules.mtuEveryMin) * 60_000;

  function proberFor(c: EngineContext, family: IpFamily, signal: AbortSignal): { probe: MtuProbe; method: () => string } {
    const target = PATH_TARGETS[family];
    const track = (child: ChildProcess) => c.trackChild(child);
    if (opts.probe) {
      const p = opts.probe;
      return { probe: (payload) => p(family, target, payload), method: () => 'custom' };
    }
    let usePs = c.ps.available;
    return {
      probe: async (payload) => {
        if (usePs) {
          try {
            return await dotnetDfProbe(c.ps, target, payload);
          } catch (err) {
            usePs = false;
            log?.warn('MTU probe via PowerShell worker failed – using ping.exe', { error: errorText(err) });
          }
        }
        return pingExeDfProbe(family, target, payload, { signal, track });
      },
      method: () => (usePs ? '.NET Ping' : 'ping.exe'),
    };
  }

  async function cachePmtu(c: EngineContext, family: IpFamily, signal: AbortSignal): Promise<number | null> {
    const entries = opts.readCache
      ? await opts.readCache(family)
      : await readDestinationCache(family, { signal, track: (child) => c.trackChild(child) });
    if (!entries) return null;
    const cs = c.clientState();
    return pickPmtu(entries, PATH_TARGETS[family], family === 4 ? cs?.egressV4If : cs?.egressV6If);
  }

  async function runAll(c: EngineContext, signal: AbortSignal): Promise<MtuResult[]> {
    const results: MtuResult[] = [];
    const errors: string[] = [];
    for (const family of FAMILIES) {
      if (signal.aborted) break;
      try {
        const prober = proberFor(c, family, signal);
        const m = await measureFamilyMtu(family, prober.probe, () => cachePmtu(c, family, signal), { signal });
        results.push(m.result);
        log?.info(
          `MTU IPv${family}: ${m.result.mtu ?? '–'} (payload ${m.result.maxPayload ?? '–'}, cache ${m.cachePmtu ?? '–'}, ${m.search.steps.length} probes via ${prober.method()})${m.result.note ? ` – ${m.result.note}` : ''}`,
        );
        if (m.result.mtu === null) errors.push(`MTU IPv${family}: ${m.result.note ?? 'nicht bestimmbar'}`);
      } catch (err) {
        if (signal.aborted) break;
        errors.push(`MTU IPv${family}: unerwarteter Fehler (${errorText(err)})`);
        log?.warn(`MTU IPv${family} failed`, { error: errorText(err) });
      }
    }
    if (signal.aborted) return results;
    const ts = Date.now();
    lastRunTs = ts;
    lastError = errors.length > 0 ? errors.join(' · ') : null;
    if (results.length > 0) {
      c.recordSnapshot('mtu', results, ts);
      c.recordMetrics(mtuMetrics(results));
      for (const r of results) {
        const ev = mtuChangeEvent(lastKnown[r.family], r);
        if (ev) c.recordEvent(ev);
        if (r.mtu !== null) lastKnown[r.family] = r;
      }
    }
    return results;
  }

  function launch(manual: boolean): Promise<MtuResult[]> {
    const c = ctx;
    if (!c) return Promise.resolve([]);
    const abort = new AbortController();
    const done = runAll(c, abort.signal).finally(() => {
      if (current?.abort === abort) current = null;
    });
    current = { abort, manual, done };
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
    nextRunTs = now + intervalMs(c.config());
    void launch(false);
  }

  async function abortCurrent(includeManual: boolean): Promise<void> {
    const cur = current;
    if (!cur || (!includeManual && cur.manual)) return;
    cur.abort.abort();
    await Promise.race([cur.done.catch(() => undefined), new Promise((r) => setTimeout(r, 3000).unref())]);
  }

  function clearTimer(): void {
    if (checkTimer) clearInterval(checkTimer);
    checkTimer = null;
  }

  return {
    name: 'mtu',

    init(c: EngineContext) {
      ctx = c;
      log = c.log;
      try {
        const snap = c.db.latestSnapshot<unknown>('mtu');
        if (snap) {
          lastRunTs = snap.ts;
          for (const r of mtuResultsFromSnapshot(snap.data)) if (r.mtu !== null) lastKnown[r.family] = r;
        }
      } catch (err) {
        log.warn('could not read the latest MTU snapshot', { error: errorText(err) });
      }
    },

    start() {
      const c = ctx;
      if (!c) return;
      scheduled = true;
      const now = Date.now();
      const due = lastRunTs === null ? now : lastRunTs + intervalMs(c.config());
      nextRunTs = Math.max(now + firstRunDelayMs, due);
      if (!checkTimer) {
        checkTimer = setInterval(check, checkMs);
        checkTimer.unref();
      }
    },

    async stop() {
      scheduled = false;
      clearTimer();
      nextRunTs = null;
      await abortCurrent(false);
    },

    async dispose() {
      scheduled = false;
      clearTimer();
      nextRunTs = null;
      await abortCurrent(true);
    },

    reconfigure(cfg: AppConfig) {
      if (!scheduled || nextRunTs === null) return;
      nextRunTs = Math.max(Date.now() + 60_000, (lastRunTs ?? Date.now()) + intervalMs(cfg));
    },

    async runNow(): Promise<TaskResult<MtuResult[]>> {
      if (!ctx) throw new Error('MTU-Modul ist nicht initialisiert');
      if (current) throw new Error('Eine MTU-Messung läuft bereits');
      const results = await launch(true);
      if (results.length === 0) return { ok: false, error: lastError ?? 'MTU-Messung fehlgeschlagen' };
      return { ok: true, result: results };
    },

    state(): ModuleState {
      return {
        name: 'mtu',
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
