// Parser for macOS `ifconfig -a` (docs/research/macos.md §3). The output is not localized. Pure.
//
//   en7: flags=8863<UP,BROADCAST,SMART,RUNNING,SIMPLEX,MULTICAST> mtu 1500
//   	ether 00:e0:4c:68:01:23
//   	inet6 fe80::14a3:9d1e:3b1a:7f02%en7 prefixlen 64 secured scopeid 0x10
//   	inet 192.168.0.43 netmask 0xffffff00 broadcast 192.168.0.255
//   	inet6 2001:db8:aa00:1234:1c8a:2b3c:4d5e:6f70 prefixlen 64 autoconf secured
//   	media: autoselect (1000baseT <full-duplex>)
//   	status: active

export interface IfconfigInet6 {
  /** address without zone id */
  ip: string;
  prefixLength: number | null;
  /** zone id from "fe80::1%en0" (null for global addresses) */
  zone: string | null;
  /** flags after the prefix length, e.g. autoconf, secured, temporary, deprecated */
  flags: string[];
}

export interface IfconfigInterface {
  /** BSD name, e.g. 'en0' */
  device: string;
  flags: string[];
  /** administratively up (IFF_UP) */
  up: boolean;
  /** driver resources allocated (IFF_RUNNING) */
  running: boolean;
  mtu: number | null;
  mac: string | null;
  inet: { ip: string; netmask: string | null }[];
  inet6: IfconfigInet6[];
  /** raw media text after "media:", e.g. 'autoselect (1000baseT <full-duplex>)' */
  media: string | null;
  /** link speed from the media subtype (null when unknown / no link / Wi-Fi) */
  mediaMbps: number | null;
  duplex: 'full' | 'half' | null;
  /** 'active' | 'inactive' | other raw value; null when the interface has no status line */
  status: string | null;
}

const HEAD = /^([A-Za-z][\w.-]*\d*):\s+flags=[0-9a-fA-F]+<([^>]*)>(?:\s+mtu\s+(\d+))?/;

/**
 * Speed of a media subtype in Mbit/s: '10baseT/UTP' → 10, '100baseTX' → 100, '1000baseT' → 1000,
 * '2500Base-T' → 2500, '5GBase-T' → 5000, '10GbaseT' / '10Gbase-T' → 10000. Null for 'none',
 * 'autoselect' without subtype and unknown text.
 */
export function mediaSpeedMbps(media: string | null | undefined): number | null {
  if (!media) return null;
  // the active subtype is in parentheses when autoselect is used: "autoselect (1000baseT <…>)"
  const inner = /\(([^)]*)\)/.exec(media);
  const text = inner ? inner[1] : media;
  const m = /(\d+(?:\.\d+)?)\s*(G|M)?\s*base[-_ ]?[A-Za-z0-9/]*/i.exec(text);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  return m[2] && m[2].toUpperCase() === 'G' ? Math.round(n * 1000) : Math.round(n);
}

export function mediaDuplex(media: string | null | undefined): 'full' | 'half' | null {
  if (!media) return null;
  if (/full-duplex/i.test(media)) return 'full';
  if (/half-duplex/i.test(media)) return 'half';
  return null;
}

/** Parses the complete `ifconfig -a` (or `ifconfig <dev>`) output. Unknown lines are ignored. */
export function parseIfconfig(text: string): IfconfigInterface[] {
  const out: IfconfigInterface[] = [];
  let cur: IfconfigInterface | null = null;
  for (const raw of text.split(/\r?\n/)) {
    if (raw.trim() === '') continue;
    if (!/^\s/.test(raw)) {
      const h = HEAD.exec(raw);
      if (!h) {
        cur = null;
        continue;
      }
      const flags = h[2] ? h[2].split(',').map((f) => f.trim().toUpperCase()).filter((f) => f !== '') : [];
      cur = {
        device: h[1],
        flags,
        up: flags.includes('UP'),
        running: flags.includes('RUNNING'),
        mtu: h[3] ? Number(h[3]) : null,
        mac: null,
        inet: [],
        inet6: [],
        media: null,
        mediaMbps: null,
        duplex: null,
        status: null,
      };
      out.push(cur);
      continue;
    }
    if (!cur) continue;
    const line = raw.trim();
    let m: RegExpExecArray | null;
    if ((m = /^ether\s+([0-9a-fA-F:]+)/.exec(line))) {
      cur.mac = m[1].toLowerCase();
    } else if ((m = /^inet\s+(\d+\.\d+\.\d+\.\d+)(?:\s+-->\s+\S+)?(?:\s+netmask\s+(\S+))?/.exec(line))) {
      cur.inet.push({ ip: m[1], netmask: m[2] ?? null });
    } else if ((m = /^inet6\s+(\S+)(.*)$/.exec(line))) {
      const [ip, zone] = m[1].split('%');
      const rest = m[2].trim().split(/\s+/).filter((t) => t !== '');
      let prefixLength: number | null = null;
      const flags: string[] = [];
      for (let i = 0; i < rest.length; i++) {
        const t = rest[i];
        if (t === 'prefixlen' && i + 1 < rest.length) {
          const n = Number(rest[++i]);
          prefixLength = Number.isFinite(n) ? n : null;
        } else if (t === 'scopeid' && i + 1 < rest.length) {
          i++;
        } else if (/^[a-z_]+$/i.test(t)) {
          flags.push(t.toLowerCase());
        }
      }
      cur.inet6.push({ ip, prefixLength, zone: zone ?? null, flags });
    } else if ((m = /^media:\s*(.*)$/.exec(line))) {
      cur.media = m[1].trim() || null;
      cur.mediaMbps = mediaSpeedMbps(cur.media);
      cur.duplex = mediaDuplex(cur.media);
    } else if ((m = /^status:\s*(\S+)/.exec(line))) {
      cur.status = m[1].toLowerCase();
    }
  }
  return out;
}

/** All assigned addresses of an interface (IPv4 + IPv6, zone ids stripped). */
export function ifconfigAddresses(i: Pick<IfconfigInterface, 'inet' | 'inet6'>): string[] {
  return [...i.inet.map((a) => a.ip), ...i.inet6.map((a) => a.ip)];
}

/**
 * Carrier/association state: true = link (status active), false = no link (status inactive or the
 * interface is administratively down), null = the interface has no status line (utun, lo0, …).
 */
export function ifconfigLinkUp(i: Pick<IfconfigInterface, 'up' | 'running' | 'status'>): boolean | null {
  if (!i.up) return false;
  if (i.status === 'active') return i.running;
  if (i.status === 'inactive') return false;
  return i.status === null ? null : false;
}
