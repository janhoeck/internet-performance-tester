// Parsers for macOS `netstat -ibn` (per-interface 64-bit counters) and `netstat -s -p tcp`
// (docs/research/macos.md §3). Not localized. Pure.
//
//   Name       Mtu   Network       Address            Ipkts Ierrs     Ibytes    Opkts Oerrs     Obytes  Coll
//   en0        1500  <Link#11>   3c:22:fb:aa:bb:02   8123456     0 9876543210  4123456     0  987654321     0
//   gif0*      1280  <Link#2>                              0     0          0        0     0          0     0

export interface NetstatLinkRow {
  /** BSD name without the trailing '*' */
  device: string;
  /** '*' after the name: interface is down (IFF_UP not set) */
  down: boolean;
  /** interface index from "<Link#N>" */
  ifIndex: number;
  mtu: number | null;
  mac: string | null;
  ipkts: number;
  ierrs: number;
  ibytes: number;
  opkts: number;
  oerrs: number;
  obytes: number;
  coll: number;
  /** only with `netstat -ibnd`: dropped packets */
  drops: number | null;
}

/**
 * macOS tools (netstat, arp, route) print MAC octets without leading zeros ('0:e0:4c:aa:bb:3').
 * Returns 'aa:bb:cc:dd:ee:ff' (lower case, two digits per octet) or null.
 */
export function padMac(mac: string | null | undefined): string | null {
  if (!mac) return null;
  const parts = mac.trim().split(/[:-]/);
  if (parts.length !== 6 || parts.some((p) => !/^[0-9a-fA-F]{1,2}$/.test(p))) return null;
  return parts.map((p) => p.padStart(2, '0').toLowerCase()).join(':');
}

const num = (s: string | undefined): number | null => {
  if (s === undefined || !/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

/**
 * `<Link#N>` rows of `netstat -ibn` (one per interface; address rows are skipped). Columns are
 * read from the right because the Address column is empty for interfaces without a MAC address.
 */
export function parseNetstatInterfaces(text: string): NetstatLinkRow[] {
  const out: NetstatLinkRow[] = [];
  const seen = new Set<string>();
  let hasDrop = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '') continue;
    const tokens = line.split(/\s+/);
    if (tokens[0] === 'Name') {
      hasDrop = tokens.includes('Drop');
      continue;
    }
    const link = tokens.findIndex((t) => /^<Link#\d+>$/.test(t));
    if (link !== 2) continue;
    const counters = tokens.slice(link + 1);
    // [address] Ipkts Ierrs Ibytes Opkts Oerrs Obytes Coll [Drop]
    const want = hasDrop ? 8 : 7;
    const values = counters.slice(-want);
    if (values.length < want) continue;
    const nums = values.map(num);
    if (nums.some((n) => n === null)) continue;
    const [ipkts, ierrs, ibytes, opkts, oerrs, obytes, coll, drops] = nums as number[];
    const addr = counters.length > want ? counters[0] : null;
    const name = tokens[0];
    const device = name.replace(/\*$/, '');
    if (seen.has(device)) continue;
    seen.add(device);
    out.push({
      device,
      down: name.endsWith('*'),
      ifIndex: Number(/^<Link#(\d+)>$/.exec(tokens[link])?.[1] ?? 0),
      mtu: num(tokens[1]),
      mac: padMac(addr),
      ipkts,
      ierrs,
      ibytes,
      opkts,
      oerrs,
      obytes,
      coll,
      drops: hasDrop ? (drops ?? null) : null,
    });
  }
  return out;
}

export interface TcpStats {
  /** "N packets sent" */
  sent: number;
  /** "N data packets (M bytes) retransmitted" */
  retransmitted: number;
}

/**
 * `netstat -s -p tcp`: total sent packets and retransmitted data packets (macOS keeps one TCP
 * statistic for IPv4 and IPv6). Null when the lines are missing.
 */
export function parseNetstatTcp(text: string): TcpStats | null {
  let sent: number | null = null;
  let retransmitted: number | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    let m: RegExpExecArray | null;
    if (sent === null && (m = /^(\d+) packets? sent$/.exec(line))) sent = Number(m[1]);
    else if (retransmitted === null && (m = /^(\d+) data packets? \(\d+ bytes?\) retransmitted$/.exec(line))) retransmitted = Number(m[1]);
  }
  return sent !== null && retransmitted !== null ? { sent, retransmitted } : null;
}
