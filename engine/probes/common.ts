// Small shared pieces of the probe engine (module-local types and helpers).
import path from 'node:path';
import { SampleFlag, type SampleStatusCode } from '../../src/lib/shared/types';

/** Result of one probe (ICMP echo, TCP connect, DNS query, HTTP request). */
export interface ProbeOutcome {
  status: SampleStatusCode;
  /** round-trip time in ms; null when lost */
  rtt: number | null;
  /** short German note for ProbeState.error (null = fine) */
  error?: string | null;
  /**
   * The probe produced neither a valid latency nor a real loss (e.g. a TCP port that refuses
   * only after Windows' SYN retries) – no sample is recorded, only ProbeState.error is set.
   */
  discard?: boolean;
}

/** One ICMP echo result from the pinger agent or the ping.exe fallback. */
export interface IcmpEcho {
  targetId: string;
  /** scheduled tick (agent) or estimated send time rounded to the second (fallback) */
  ts: number;
  status: SampleStatusCode;
  rtt: number | null;
}

/** Restart backoff for supervised child processes (ms). */
export const RESTART_BACKOFF_MS: readonly number[] = [1000, 2000, 5000, 10_000, 30_000];

/** Absolute path of a Windows system executable, e.g. systemExe('PING.EXE'). */
export function systemExe(...parts: string[]): string {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  return path.win32.join(root, 'System32', ...parts);
}

/** Sample flags for a probe result (LOAD / FAILOVER / LATE). */
export function sampleFlags(rtt: number | null, opts: { load: boolean; failover: boolean }): number {
  let f = 0;
  if (opts.load) f |= SampleFlag.LOAD;
  if (opts.failover) f |= SampleFlag.FAILOVER;
  if (rtt !== null && rtt > 1000) f |= SampleFlag.LATE;
  return f;
}

/**
 * Remembers the last `size` timestamps per key. Used to drop duplicate ICMP samples (e.g. the
 * ping.exe fallback and the recovered agent reporting the same second). Per-target results are
 * not in ts order (a 2 s timeout arrives after the next tick's reply), so a plain "ts must
 * increase" check would be wrong.
 */
export class RecentTimestamps {
  private readonly seen = new Map<string, number[]>();

  constructor(private readonly size = 8) {}

  /** true if (key, ts) is new (and remembers it); false for a duplicate */
  add(key: string, ts: number): boolean {
    let list = this.seen.get(key);
    if (!list) {
      list = [];
      this.seen.set(key, list);
    }
    if (list.includes(ts)) return false;
    list.push(ts);
    if (list.length > this.size) list.shift();
    return true;
  }

  delete(key: string): void {
    this.seen.delete(key);
  }

  clear(): void {
    this.seen.clear();
  }
}

/** Round a duration to microseconds (3 decimals). */
export function roundMs(ms: number): number {
  return Math.round(ms * 1000) / 1000;
}

/** `code` of a Node system error (e.g. 'ECONNREFUSED'), searching `cause` chains (fetch). */
export function errorCode(err: unknown): string | null {
  let cur: unknown = err;
  for (let depth = 0; depth < 4 && cur !== null && typeof cur === 'object'; depth++) {
    const rec = cur as { code?: unknown; name?: unknown; cause?: unknown };
    if (typeof rec.code === 'string' && rec.code !== '') return rec.code;
    if (rec.name === 'TimeoutError' || rec.name === 'AbortError') return rec.name;
    cur = rec.cause;
  }
  return null;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === 'string' ? err : JSON.stringify(err);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}
