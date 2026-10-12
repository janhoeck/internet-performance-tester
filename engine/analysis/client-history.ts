// Short history of the 1 Hz ClientState (link state, egress interface, own throughput) so that a
// pinger tick evaluated ~3 s late is judged with the client state of ITS second, plus the
// "expected link came back" transitions for the 60 s LINK recovery window.
import type { ClientState } from '../../src/lib/shared/types';

export interface ClientHistoryOptions {
  /** number of states kept (1 Hz), default 180 */
  maxStates?: number;
  /** a state derived up to this long after a tick still describes that tick, default 1000 ms */
  lookAheadMs?: number;
  /** states older than this (relative to the tick) are stale → unknown, default 5000 ms */
  maxAgeMs?: number;
  /** seconds after the expected link came back that still count as LINK, default 60 000 ms */
  recoveryMs?: number;
}

export class ClientHistory {
  private states: ClientState[] = [];
  private comebacks: number[] = [];
  private last: ClientState | null = null;
  private readonly maxStates: number;
  private readonly lookAheadMs: number;
  private readonly maxAgeMs: number;
  private readonly recoveryMs: number;

  constructor(opts: ClientHistoryOptions = {}) {
    this.maxStates = opts.maxStates ?? 180;
    this.lookAheadMs = opts.lookAheadMs ?? 1000;
    this.maxAgeMs = opts.maxAgeMs ?? 5000;
    this.recoveryMs = opts.recoveryMs ?? 60_000;
  }

  /** add a state (duplicates / older states are ignored) */
  push(s: ClientState | null | undefined): void {
    if (!s || !Number.isFinite(s.ts)) return;
    const prev = this.last;
    if (prev && s.ts <= prev.ts) return;
    if (prev && ((prev.linkUp === false && s.linkUp === true) || (prev.onExpected === false && s.onExpected === true))) {
      this.comebacks.push(s.ts);
      if (this.comebacks.length > 32) this.comebacks.shift();
    }
    this.states.push(s);
    if (this.states.length > this.maxStates) this.states.splice(0, this.states.length - this.maxStates);
    this.last = s;
  }

  /** client state describing the second at `ts` (null if unknown / stale) */
  at(ts: number): ClientState | null {
    for (let i = this.states.length - 1; i >= 0; i--) {
      const s = this.states[i];
      if (s.ts <= ts + this.lookAheadMs) return ts - s.ts <= this.maxAgeMs ? s : null;
    }
    return null;
  }

  /** true within `recoveryMs` after the expected link came back (link up again / egress back) */
  inRecovery(ts: number): boolean {
    for (const c of this.comebacks) {
      if (ts >= c - this.lookAheadMs && ts - c <= this.recoveryMs) return true;
    }
    return false;
  }

  get latest(): ClientState | null {
    return this.last;
  }

  clear(): void {
    this.states = [];
    this.comebacks = [];
    this.last = null;
  }
}
