// ClientState derivation (ARCHITECTURE §4.2): combines the latest 1 Hz NIC ticks (pinger agent)
// and egress ticks (egress check) into the connection context of the PC. Pure logic – the
// context feeds it from the bus and calls derive() once per second.
import type { ClientState } from '../../src/lib/shared/types';
import type { EgressTick, NicTick } from './types';
import { round, sameInterface } from './util';

/** ticks older than this are ignored (pinger/egress stopped or stalled) */
export const CLIENT_FRESH_MS = 5000;
/** rates of adapters whose last tick is older than this are not summed */
const RATE_FRESH_MS = 3000;
/** byte deltas over longer intervals are not "the last second" any more */
const MAX_RATE_INTERVAL_MS = 5000;
/** Mbit/s with 6 decimals = 1 bit/s resolution (idle background traffic must not round to 0) */
const RATE_DECIMALS = 6;

export interface NicRate {
  ts: number;
  rxMbps: number | null;
  txMbps: number | null;
}

/** Throughput between two ticks of the same adapter (null on counter reset / bad interval). */
export function nicRate(prev: NicTick | undefined, cur: NicTick): NicRate {
  const none: NicRate = { ts: cur.ts, rxMbps: null, txMbps: null };
  if (!prev) return none;
  const dtMs = cur.ts - prev.ts;
  if (dtMs <= 0 || dtMs > MAX_RATE_INTERVAL_MS) return none;
  const mbps = (delta: number) =>
    Number.isFinite(delta) && delta >= 0 ? round((delta * 8) / (dtMs / 1000) / 1e6, RATE_DECIMALS) : null;
  return { ts: cur.ts, rxMbps: mbps(cur.rxBytes - prev.rxBytes), txMbps: mbps(cur.txBytes - prev.txBytes) };
}

export interface DeriveOptions {
  now: number;
  /** expected interface of the running session (null without session/unknown) */
  expectedIf: string | null;
  gaming: boolean;
  preventSleep: boolean;
}

/**
 * Keeps the latest NIC tick + rate per adapter and the latest egress tick.
 * Adapter names are matched case-insensitively.
 */
export class ClientTracker {
  private readonly nics = new Map<string, NicTick>();
  private readonly rates = new Map<string, NicRate>();
  private egress: EgressTick | null = null;

  onNic(tick: NicTick): void {
    const key = tick.name.trim().toLowerCase();
    const prev = this.nics.get(key);
    if (prev && tick.ts < prev.ts) return; // out of order
    this.rates.set(key, nicRate(prev, tick));
    this.nics.set(key, tick);
  }

  onEgress(tick: EgressTick): void {
    if (this.egress && tick.ts < this.egress.ts) return;
    this.egress = tick;
  }

  /** latest NIC tick of an adapter (any age) */
  nic(name: string): NicTick | null {
    return this.nics.get(name.trim().toLowerCase()) ?? null;
  }

  latestEgress(): EgressTick | null {
    return this.egress;
  }

  hasFreshData(now: number): boolean {
    if (this.egress && isFresh(this.egress.ts, now)) return true;
    for (const t of this.nics.values()) if (isFresh(t.ts, now)) return true;
    return false;
  }

  reset(): void {
    this.nics.clear();
    this.rates.clear();
    this.egress = null;
  }

  derive(o: DeriveOptions): ClientState {
    return deriveClientState({
      ...o,
      nics: [...this.nics.values()],
      rates: [...this.rates.entries()].map(([key, r]) => ({ key, ...r })),
      egress: this.egress,
    });
  }
}

function isFresh(ts: number, now: number, maxAge = CLIENT_FRESH_MS): boolean {
  return now - ts <= maxAge && ts - now <= maxAge;
}

export interface ClientInputs extends DeriveOptions {
  nics: readonly NicTick[];
  rates: readonly (NicRate & { key: string })[];
  egress: EgressTick | null;
}

/** Picks the adapter whose link state represents the PC: expected → egress → first wired up → any. */
export function pickPrimaryNic(nics: readonly NicTick[], expectedIf: string | null, egressIf: string | null): NicTick | null {
  if (expectedIf) return nics.find((n) => sameInterface(n.name, expectedIf)) ?? null;
  if (egressIf) {
    const byEgress = nics.find((n) => sameInterface(n.name, egressIf));
    if (byEgress) return byEgress;
  }
  return nics.find((n) => n.up && !n.isWifi) ?? nics.find((n) => n.up) ?? nics[0] ?? null;
}

export function deriveClientState(i: ClientInputs): ClientState {
  const egress = i.egress && isFresh(i.egress.ts, i.now) ? i.egress : null;
  const egressV4If = egress?.v4If ?? null;
  const egressV6If = egress?.v6If ?? null;
  const onExpected = i.expectedIf && egressV4If ? sameInterface(egressV4If, i.expectedIf) : null;

  const freshNics = i.nics.filter((n) => isFresh(n.ts, i.now));
  const primary = pickPrimaryNic(freshNics, i.expectedIf, egressV4If);

  let rx: number | null = null;
  let tx: number | null = null;
  for (const r of i.rates) {
    if (!isFresh(r.ts, i.now, RATE_FRESH_MS)) continue;
    if (r.rxMbps !== null) rx = round((rx ?? 0) + r.rxMbps, RATE_DECIMALS);
    if (r.txMbps !== null) tx = round((tx ?? 0) + r.txMbps, RATE_DECIMALS);
  }

  return {
    ts: i.now,
    expectedIf: i.expectedIf,
    egressV4If,
    egressV6If,
    egressV4Address: egress?.v4Address ?? null,
    egressV6Address: egress?.v6Address ?? null,
    onExpected,
    linkUp: primary ? primary.up : null,
    linkMbps: primary && primary.up ? primary.mbps : null,
    rxMbps: rx,
    txMbps: tx,
    gaming: i.gaming,
    preventSleep: i.preventSleep,
  };
}

/** What the probes module reports about its pinger agent (optional `pingerInfo()`, see runtime). */
export interface PingerSleepInfo {
  /** 'stopped' | 'starting' | 'agent' | 'fallback' */
  mode: string;
  /** SetThreadExecutionState succeeded in the running agent (null = unknown / not requested) */
  preventSleepActive: boolean | null;
}

/**
 * ClientState.preventSleep: the pinger agent keeps Windows from idle sleep while a session runs
 * with `config.session.preventSleep`. `agent` = undefined: no information (trust the config);
 * null: no pinger agent (probes module missing/stopped). The ping.exe fallback cannot prevent sleep.
 */
export function effectivePreventSleep(
  sessionRunning: boolean,
  configured: boolean,
  agent: PingerSleepInfo | null | undefined,
): boolean {
  if (!sessionRunning || !configured) return false;
  if (agent === undefined) return true;
  if (agent === null || agent.mode === 'fallback' || agent.mode === 'stopped') return false;
  return agent.preventSleepActive !== false;
}

/**
 * Tracks `onExpected` for the metric `net.on_expected_if` (written on change only).
 * Unknown (null) values never produce a point; the first known value after reset() does.
 */
export class OnExpectedTracker {
  private last: boolean | null = null;

  update(value: boolean | null): number | null {
    if (value === null || value === this.last) return null;
    this.last = value;
    return value ? 1 : 0;
  }

  reset(): void {
    this.last = null;
  }
}
