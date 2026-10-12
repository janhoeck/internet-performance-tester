// Joins networksetup (friendly port names), ifconfig (state, media, addresses) and netstat (index,
// counters) into one interface list – the macOS equivalent of Get-NetAdapter (docs/research/macos.md §3).
// Pure.
import { isLinkLocalV6 } from '../../net';
import { type IfconfigInet6, type IfconfigInterface, ifconfigAddresses, ifconfigLinkUp } from './ifconfig';
import type { NetstatLinkRow } from './netstat';
import { type HardwarePort, isBridgePort, isWifiPort } from './networksetup';

export type MacAdapterStatus = 'Up' | 'Disconnected' | 'Disabled';

export interface MacInterface {
  /** BSD name, e.g. 'en7' */
  device: string;
  /** shown name: hardware port ("Ethernet", "Wi-Fi") or the BSD name for tunnels */
  name: string;
  /** hardware port name (null for interfaces that are no hardware port) */
  port: string | null;
  /** interface index (netstat <Link#N>), null when unknown */
  ifIndex: number | null;
  isWifi: boolean;
  /** tunnels, bridges, everything that is no physical link */
  isVirtual: boolean;
  /** Windows-like status: Up = link/association present, Disconnected = no link, Disabled = interface down */
  status: MacAdapterStatus;
  /** carrier / association (ifconfig status), null when the interface reports none */
  linkUp: boolean | null;
  mediaMbps: number | null;
  duplex: 'full' | 'half' | null;
  media: string | null;
  mtu: number | null;
  mac: string | null;
  /** IPv4 + IPv6 addresses (zone ids stripped) */
  addresses: string[];
  inet6: IfconfigInet6[];
  counters: NetstatLinkRow | null;
}

/** VPN / tunnel interfaces worth listing (others like awdl0, llw0, anpi0, gif0, stf0, ap1 are noise). */
const TUNNEL_DEVICE = /^(utun|ipsec|ppp|tun|tap|wg|zt|feth)\d+$/;

const routable = (i: IfconfigInterface) => i.inet.length > 0 || i.inet6.some((a) => !isLinkLocalV6(a.ip) && a.ip !== '::1');

function statusOf(i: IfconfigInterface, linkUp: boolean | null): MacAdapterStatus {
  if (!i.up) return 'Disabled';
  if (linkUp === true) return 'Up';
  if (linkUp === false) return 'Disconnected';
  return i.running ? 'Up' : 'Disconnected';
}

/**
 * All hardware ports (also when ifconfig does not know them yet, e.g. an unplugged USB adapter is
 * skipped only if ifconfig lacks it) plus active tunnels with a routable address. Without any port
 * information (networksetup failed) every en* interface is treated as a physical adapter.
 */
export function buildMacInterfaces(ports: readonly HardwarePort[], ifc: readonly IfconfigInterface[], netstat: readonly NetstatLinkRow[]): MacInterface[] {
  const portByDev = new Map(ports.map((p) => [p.device, p]));
  const statsByDev = new Map(netstat.map((r) => [r.device, r]));
  const out: MacInterface[] = [];
  for (const i of ifc) {
    const port = portByDev.get(i.device) ?? null;
    const physicalFallback = ports.length === 0 && /^en\d+$/.test(i.device);
    const tunnel = !port && TUNNEL_DEVICE.test(i.device) && i.up && routable(i);
    if (!port && !physicalFallback && !tunnel) continue;
    const linkUp = ifconfigLinkUp(i);
    const isWifi = port ? isWifiPort(port.port) : false;
    const bridge = port ? isBridgePort(port.port, i.device) : false;
    const counters = statsByDev.get(i.device) ?? null;
    out.push({
      device: i.device,
      name: port?.port ?? i.device,
      port: port?.port ?? null,
      ifIndex: counters?.ifIndex ?? null,
      isWifi,
      isVirtual: tunnel || bridge,
      status: statusOf(i, linkUp),
      linkUp,
      mediaMbps: isWifi ? null : i.mediaMbps,
      duplex: isWifi ? null : i.duplex,
      media: i.media,
      mtu: i.mtu,
      mac: i.mac ?? port?.mac ?? null,
      addresses: ifconfigAddresses(i),
      inet6: i.inet6,
      counters,
    });
  }
  return out;
}

/** BSD name → shown name ('en7' → 'Ethernet'); unknown devices keep their BSD name. */
export function displayNameOf(list: readonly Pick<MacInterface, 'device' | 'name'>[], device: string): string {
  return list.find((i) => i.device === device)?.name ?? device;
}

/** shown name → BSD name (case-insensitive; a BSD name is accepted as well). */
export function deviceOf(list: readonly Pick<MacInterface, 'device' | 'name'>[], name: string): string | null {
  const n = name.trim().toLowerCase();
  return list.find((i) => i.name.toLowerCase() === n)?.device ?? list.find((i) => i.device.toLowerCase() === n)?.device ?? null;
}
