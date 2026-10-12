// macOS sources of the identity module (docs/research/macos.md §0): the interface towards the router
// (`route -n get <router>`), the router MAC (`arp -n`, octets without leading zeros), the DHCP server
// (`ipconfig getpacket <dev>`), the DNS servers (`scutil --dns`) and the IPv6 router-advertisement
// addresses (ifconfig `autoconf`). The result has the shape of Get-NdIdentity, so identity.ts parses
// both platforms with parseIdentity(). Game detection: `ps -ww -A -o comm=`.
import { isGlobalV6, isIpLiteral } from '../../../src/lib/shared/net';
import { parseArp } from '../../../src/lib/shared/parsers/macos/arp';
import type { MacInterface } from '../../../src/lib/shared/parsers/macos/interfaces';
import { parseIpconfigPacket } from '../../../src/lib/shared/parsers/macos/ipconfig';
import { parsePsComm } from '../../../src/lib/shared/parsers/macos/ps';
import { parseRouteGet } from '../../../src/lib/shared/parsers/macos/route';
import { defaultNameservers, parseScutilDns } from '../../../src/lib/shared/parsers/macos/scutil';
import { MacInterfaceCatalog } from './interfaces';
import { type ToolRunner, runTool, toolText } from './tools';

const TOOL_TIMEOUT_MS = 10_000;

export interface MacIdentityNeighbor {
  ifIndex: number | null;
  mac: string;
  state: 'Reachable' | 'Permanent';
}

/** Same fields as Get-NdIdentity (ps-helpers.ps1). */
export type MacIdentityRecord =
  | { t: number; found: false }
  | {
      t: number;
      found: true;
      ifIndex: number | null;
      ifAlias: string;
      neighbors: MacIdentityNeighbor[];
      dhcpEnabled: boolean | null;
      dhcpServer: string | null;
      dns: string[];
      v6: { ip: string; prefixLength: number | null; suffixOrigin: string | null }[];
    };

export interface MacIdentityOutputs {
  /** `route -n get <router>` */
  route: string;
  /** `arp -n <router>` (may be empty) */
  arp: string;
  /** `ipconfig getpacket <device>` (empty without DHCP lease) */
  packet: string;
  /** `scutil --dns` (may be empty) */
  scutil: string;
}

/** Tool outputs + interface list → Get-NdIdentity-shaped record (pure). */
export function buildMacIdentity(out: MacIdentityOutputs, list: readonly MacInterface[], routerIp: string, now: number): MacIdentityRecord {
  const route = parseRouteGet(out.route);
  if (!route?.interface) return { t: now, found: false };
  const device = route.interface;
  const iface = list.find((i) => i.device === device) ?? null;
  const indexOf = (dev: string | null) => (dev ? (list.find((i) => i.device === dev)?.ifIndex ?? null) : null);
  const neighbors: MacIdentityNeighbor[] = [];
  for (const e of parseArp(out.arp)) {
    if (e.ip !== routerIp || !e.mac) continue;
    neighbors.push({ ifIndex: indexOf(e.device), mac: e.mac, state: e.permanent ? 'Permanent' : 'Reachable' });
  }
  if (route.gatewayMac) neighbors.push({ ifIndex: iface?.ifIndex ?? null, mac: route.gatewayMac, state: 'Reachable' });
  const packet = parseIpconfigPacket(out.packet);
  const scoped = defaultNameservers(parseScutilDns(out.scutil));
  const dns = scoped.length > 0 ? scoped : (packet?.dnsServers ?? []);
  const v6 = (iface?.inet6 ?? [])
    .filter((a) => a.flags.includes('autoconf') && isGlobalV6(a.ip))
    .map((a) => ({ ip: a.ip, prefixLength: a.prefixLength, suffixOrigin: a.flags.includes('temporary') ? 'Random' : null }));
  return {
    t: now,
    found: true,
    ifIndex: iface?.ifIndex ?? null,
    ifAlias: iface?.name ?? device,
    neighbors,
    dhcpEnabled: packet ? true : null,
    dhcpServer: packet?.serverIdentifier ?? null,
    dns,
    v6,
  };
}

const textOf = (r: { stdout: Buffer; error: unknown; timedOut: boolean }) => (r.error || r.timedOut ? '' : r.stdout.toString('utf8'));

/**
 * Runs the tools for one identity poll. `route` decides whether a route exists (its exit code is
 * non-zero without one); the other tools are optional – their failures only leave fields empty.
 */
export async function readMacIdentity(runner: ToolRunner, catalog: MacInterfaceCatalog, routerIp: string, now: () => number = Date.now): Promise<MacIdentityRecord> {
  if (!isIpLiteral(routerIp)) return { t: now(), found: false };
  const r = await runTool(runner, 'route', ['-n', 'get', routerIp], { timeoutMs: TOOL_TIMEOUT_MS, maxBytes: 64 * 1024 });
  if (r.error) throw new Error(`route: ${r.error.code === 'ENOENT' ? 'nicht gefunden' : r.error.message}`);
  if (r.timedOut) throw new Error('route: Zeitüberschreitung');
  const routeText = r.stdout.toString('utf8');
  const device = parseRouteGet(routeText)?.interface ?? null;
  if (!device) return { t: now(), found: false };
  const [list, arp, packet, scutil] = await Promise.all([
    catalog.read({ counters: false }),
    runTool(runner, 'arp', ['-n', routerIp], { timeoutMs: TOOL_TIMEOUT_MS, maxBytes: 64 * 1024 }),
    runTool(runner, 'ipconfig', ['getpacket', device], { timeoutMs: TOOL_TIMEOUT_MS, maxBytes: 256 * 1024 }),
    runTool(runner, 'scutil', ['--dns'], { timeoutMs: TOOL_TIMEOUT_MS, maxBytes: 1024 * 1024 }),
  ]);
  return buildMacIdentity({ route: routeText, arp: textOf(arp), packet: textOf(packet), scutil: textOf(scutil) }, list, routerIp, now());
}

/** Running executables (basenames) from `ps -ww -A -o comm=`. */
export function createMacProcessListSource(runner: ToolRunner): { list(): Promise<string[]> } {
  return {
    async list() {
      const r = await runTool(runner, 'ps', ['-ww', '-A', '-o', 'comm='], { timeoutMs: 15_000, maxBytes: 8 * 1024 * 1024 });
      return parsePsComm(toolText(r, 'ps'));
    },
  };
}
