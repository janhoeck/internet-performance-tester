// IP address helpers (pure, no node:net dependency so it can run anywhere).

const V4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

export function isIPv4(s: string): boolean {
  return V4.test(s);
}

/** Loose IPv6 literal check (accepts zone ids like fe80::1%4). */
export function isIPv6(s: string): boolean {
  const base = s.split('%')[0];
  if (!base.includes(':')) return false;
  if (!/^[0-9a-fA-F:.]+$/.test(base)) return false;
  const doubleColons = base.split('::').length - 1;
  if (doubleColons > 1) return false;
  const groups = base.split(':');
  return groups.length >= 3 && groups.length <= 8 + (doubleColons ? 1 : 0);
}

export function isIpLiteral(s: string): boolean {
  return isIPv4(s) || isIPv6(s);
}

export function ipFamily(s: string): 4 | 6 | null {
  if (isIPv4(s)) return 4;
  if (isIPv6(s)) return 6;
  return null;
}

function v4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, p) => (acc * 256 + Number(p)) >>> 0, 0);
}

function inV4Cidr(ip: string, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (v4ToInt(ip) & mask) === (v4ToInt(base) & mask);
}

/** RFC1918 private ranges */
export function isPrivateV4(ip: string): boolean {
  return isIPv4(ip) && (inV4Cidr(ip, '10.0.0.0', 8) || inV4Cidr(ip, '172.16.0.0', 12) || inV4Cidr(ip, '192.168.0.0', 16));
}

/** RFC6598 shared address space used by carrier-grade NAT */
export function isCgnatV4(ip: string): boolean {
  return isIPv4(ip) && inV4Cidr(ip, '100.64.0.0', 10);
}

/** true for addresses that are routable on the public internet */
export function isPublicV4(ip: string): boolean {
  if (!isIPv4(ip)) return false;
  return !(
    isPrivateV4(ip) ||
    isCgnatV4(ip) ||
    inV4Cidr(ip, '0.0.0.0', 8) ||
    inV4Cidr(ip, '127.0.0.0', 8) ||
    inV4Cidr(ip, '169.254.0.0', 16) ||
    inV4Cidr(ip, '192.0.0.0', 24) || // incl. DS-Lite B4/AFTR 192.0.0.0/29
    inV4Cidr(ip, '192.0.2.0', 24) ||
    inV4Cidr(ip, '198.18.0.0', 15) ||
    inV4Cidr(ip, '198.51.100.0', 24) ||
    inV4Cidr(ip, '203.0.113.0', 24) ||
    inV4Cidr(ip, '224.0.0.0', 4) ||
    inV4Cidr(ip, '240.0.0.0', 4)
  );
}

/** Expand an IPv6 literal to 8 hextets (lowercase, no zone). Returns null if invalid. */
export function expandIPv6(ip: string): string[] | null {
  if (!isIPv6(ip)) return null;
  let base = ip.split('%')[0].toLowerCase();
  // embedded IPv4 (::ffff:1.2.3.4)
  const lastColon = base.lastIndexOf(':');
  const tail = base.slice(lastColon + 1);
  if (isIPv4(tail)) {
    const n = v4ToInt(tail);
    base = `${base.slice(0, lastColon + 1)}${((n >>> 16) & 0xffff).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const [head, rest] = base.split('::');
  const h = head ? head.split(':') : [];
  const r = rest !== undefined && rest !== '' ? rest.split(':') : [];
  const fill = base.includes('::') ? 8 - h.length - r.length : 0;
  if (fill < 0) return null;
  const groups = [...h, ...new Array<string>(fill).fill('0'), ...r];
  if (groups.length !== 8) return null;
  return groups.map((g) => g.padStart(4, '0'));
}

/** Global unicast IPv6 (2000::/3), excluding documentation 2001:db8::/32 */
export function isGlobalV6(ip: string): boolean {
  const g = expandIPv6(ip);
  if (!g) return false;
  const first = parseInt(g[0], 16);
  if ((first & 0xe000) !== 0x2000) return false;
  if (g[0] === '2001' && g[1] === '0db8') return false;
  return true;
}

export function isLinkLocalV6(ip: string): boolean {
  const g = expandIPv6(ip);
  return !!g && (parseInt(g[0], 16) & 0xffc0) === 0xfe80;
}

/** Normalize for comparisons: IPv4 as is, IPv6 expanded + lowercase. */
export function normalizeIp(ip: string): string {
  const g = expandIPv6(ip);
  return g ? g.join(':') : ip.trim();
}

export function sameIp(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return normalizeIp(a) === normalizeIp(b);
}
