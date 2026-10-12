// Egress interface check (1 Hz while a session runs, sends NO packet): a UDP socket connect()ed
// to 1.1.1.1:53 / [2606:4700:4700::1111]:53 makes Windows pick the route and source address;
// socket.address() reveals it. The address is mapped to the interface alias via the latest
// adapters snapshot (AdapterInfo.addresses), falling back to os.networkInterfaces().
// Detects the WLAN failover within a second of an Ethernet drop (and the switch back).
import dgram from 'node:dgram';
import os from 'node:os';
import type { AdapterInfo } from '../../src/lib/shared/types';
import type { EgressTick } from '../core/types';
import { normalizeAddress } from './agent-protocol';
import { IntervalRunner } from './runner';

export const EGRESS_V4_TARGET = '1.1.1.1';
export const EGRESS_V6_TARGET = '2606:4700:4700::1111';

export type LiveInterfaces = NodeJS.Dict<os.NetworkInterfaceInfo[]>;

/** Local source address Windows would use towards `host` (null: no route / no address family). */
export function probeSourceAddress(family: 4 | 6, host: string, port = 53, timeoutMs = 500): Promise<string | null> {
  return new Promise((resolve) => {
    let sock: dgram.Socket;
    try {
      sock = dgram.createSocket(family === 6 ? 'udp6' : 'udp4');
    } catch {
      resolve(null);
      return;
    }
    let done = false;
    const finish = (addr: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        sock.close();
      } catch {
        // already closed
      }
      resolve(addr && addr !== '0.0.0.0' && addr !== '::' ? addr : null);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    sock.once('error', () => finish(null));
    try {
      sock.connect(port, host, (...args: unknown[]) => {
        if (args[0] instanceof Error) {
          finish(null);
          return;
        }
        try {
          finish(sock.address().address);
        } catch {
          finish(null);
        }
      });
    } catch {
      finish(null);
    }
  });
}

/**
 * Interface alias owning `address`: first the adapters snapshot, then the live interface list
 * (new addresses after a failover appear there before the next snapshot). Pure.
 */
export function interfaceForAddress(
  address: string | null,
  adapters: readonly Pick<AdapterInfo, 'name' | 'addresses'>[] | null,
  live: LiveInterfaces | null,
): string | null {
  if (!address) return null;
  const want = normalizeAddress(address);
  for (const a of adapters ?? []) {
    for (const x of a.addresses ?? []) if (normalizeAddress(x) === want) return a.name;
  }
  for (const [name, infos] of Object.entries(live ?? {})) {
    for (const i of infos ?? []) if (normalizeAddress(i.address) === want) return name;
  }
  return null;
}

/**
 * Shown adapter name of a live interface: os.networkInterfaces() uses BSD names on macOS ('en7')
 * while the adapters snapshot names hardware ports ('Ethernet', extra field `device`). Windows
 * adapters carry no device – the name is returned unchanged.
 */
export function aliasForDevice(adapters: readonly Pick<AdapterInfo, 'name'>[] | null, device: string): string {
  for (const a of adapters ?? []) {
    const d = (a as { device?: unknown }).device;
    if (typeof d === 'string' && d === device) return a.name;
  }
  return device;
}

export interface EgressOptions {
  probe?: (family: 4 | 6, host: string) => Promise<string | null>;
  liveInterfaces?: () => LiveInterfaces;
}

/** One egress check at scheduled time `ts`. */
export async function checkEgress(
  ts: number,
  adapters: readonly AdapterInfo[] | null,
  opts: EgressOptions = {},
): Promise<EgressTick> {
  const probe = opts.probe ?? ((f: 4 | 6, h: string) => probeSourceAddress(f, h));
  const [v4, v6] = await Promise.all([probe(4, EGRESS_V4_TARGET), probe(6, EGRESS_V6_TARGET)]);
  let live: LiveInterfaces | null = null;
  const liveList = (): LiveInterfaces | null => {
    if (live === null) {
      try {
        live = (opts.liveInterfaces ?? os.networkInterfaces)();
      } catch {
        live = {};
      }
    }
    return live;
  };
  const map = (addr: string | null): string | null => {
    if (!addr) return null;
    const known = interfaceForAddress(addr, adapters, null);
    if (known !== null) return known;
    const live = interfaceForAddress(addr, null, liveList());
    return live === null ? null : aliasForDevice(adapters, live);
  };
  return { ts, v4Address: v4, v6Address: v6, v4If: map(v4), v6If: map(v6) };
}

export interface EgressHooks {
  onTick(tick: EgressTick): void;
  /** adapters of the latest snapshot (null when none yet) */
  adapters(): readonly AdapterInfo[] | null;
  onError?(err: unknown): void;
}

/** 1 Hz egress check on whole seconds. */
export class EgressChecker {
  private runner: IntervalRunner | null = null;

  constructor(
    private readonly hooks: EgressHooks,
    private readonly opts: EgressOptions = {},
  ) {}

  start(): void {
    if (this.runner) return;
    this.runner = new IntervalRunner(
      1000,
      0,
      async (ts) => {
        const tick = await checkEgress(ts, this.hooks.adapters(), this.opts);
        if (this.runner) this.hooks.onTick(tick);
      },
      this.hooks.onError,
    );
    this.runner.start();
  }

  stop(): void {
    this.runner?.stop();
    this.runner = null;
  }
}
