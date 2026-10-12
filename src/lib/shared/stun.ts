// Public-address discovery helpers (pure, no Node APIs – Uint8Array/DataView only):
//  - STUN binding test (RFC 5389/8489): 20-byte request, XOR-MAPPED-ADDRESS for IPv4/IPv6,
//    transaction-id check, NAT mapping classification (docs/research/environment.md §4)
//  - minimal DNS TXT query/response codec for `o-o.myaddr.l.google.com` (CGNAT exit subnet)
import { expandIPv6, isIPv4, isPrivateV4, isPublicV4, isCgnatV4, normalizeIp, sameIp } from './net';
import type { NatMapping } from './types';

// ─── STUN ──────────────────────────────────────────────────────────────────

export const STUN_MAGIC_COOKIE = 0x2112a442;
export const STUN_BINDING_REQUEST = 0x0001;
export const STUN_BINDING_SUCCESS = 0x0101;
export const STUN_BINDING_ERROR = 0x0111;

export const STUN_ATTR = {
  MAPPED_ADDRESS: 0x0001,
  ERROR_CODE: 0x0009,
  XOR_MAPPED_ADDRESS: 0x0020,
  SOFTWARE: 0x8022,
  RESPONSE_ORIGIN: 0x802b,
  OTHER_ADDRESS: 0x802c,
} as const;

const COOKIE_BYTES = [0x21, 0x12, 0xa4, 0x42] as const;

export interface StunEndpoint {
  family: 4 | 6;
  address: string;
  port: number;
}

/** 12 random bytes (Web Crypto, available in Node ≥ 19 and browsers). */
export function newTransactionId(): Uint8Array {
  const id = new Uint8Array(12);
  globalThis.crypto.getRandomValues(id);
  return id;
}

/** Binding request without attributes: type 0x0001, length 0, magic cookie, transaction id. */
export function buildBindingRequest(txId: Uint8Array): Uint8Array {
  if (txId.length !== 12) throw new Error('STUN transaction id must be 12 bytes');
  const buf = new Uint8Array(20);
  const dv = new DataView(buf.buffer);
  dv.setUint16(0, STUN_BINDING_REQUEST);
  dv.setUint16(2, 0);
  dv.setUint32(4, STUN_MAGIC_COOKIE);
  buf.set(txId, 8);
  return buf;
}

/** True if the datagram is a STUN message carrying our magic cookie and transaction id. */
export function matchesTransaction(msg: Uint8Array, txId: Uint8Array): boolean {
  if (msg.length < 20 || txId.length !== 12) return false;
  for (let i = 0; i < 4; i++) if (msg[4 + i] !== COOKIE_BYTES[i]) return false;
  for (let i = 0; i < 12; i++) if (msg[8 + i] !== txId[i]) return false;
  return true;
}

/** RFC 5952 text form of a 16-byte IPv6 address (lowercase, longest zero run compressed). */
export function formatIPv6(bytes: Uint8Array): string {
  const groups: number[] = [];
  for (let i = 0; i < 16; i += 2) groups.push((bytes[i] << 8) | bytes[i + 1]);
  let bestStart = -1;
  let bestLen = 0;
  for (let i = 0; i < 8; ) {
    if (groups[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === 0) j++;
    if (j - i > bestLen) {
      bestStart = i;
      bestLen = j - i;
    }
    i = j;
  }
  const hex = groups.map((g) => g.toString(16));
  if (bestLen < 2) return hex.join(':');
  const head = hex.slice(0, bestStart).join(':');
  const tail = hex.slice(bestStart + bestLen).join(':');
  return `${head}::${tail}`;
}

function decodeAddress(v: Uint8Array, xor: boolean, txId: Uint8Array): StunEndpoint | null {
  if (v.length < 8) return null;
  const family = v[1];
  let port = (v[2] << 8) | v[3];
  if (xor) port ^= STUN_MAGIC_COOKIE >>> 16;
  if (family === 0x01) {
    const a = v.slice(4, 8);
    if (xor) for (let i = 0; i < 4; i++) a[i] ^= COOKIE_BYTES[i];
    return { family: 4, address: Array.from(a).join('.'), port };
  }
  if (family === 0x02 && v.length >= 20) {
    const a = v.slice(4, 20);
    if (xor) {
      for (let i = 0; i < 4; i++) a[i] ^= COOKIE_BYTES[i];
      for (let i = 0; i < 12; i++) a[4 + i] ^= txId[i];
    }
    return { family: 6, address: formatIPv6(a), port };
  }
  return null;
}

export type StunParseError =
  | 'short'
  | 'not-stun'
  | 'bad-cookie'
  | 'txid-mismatch'
  | 'truncated'
  | 'error-response'
  | 'unexpected-type';

export type StunParseResult =
  | {
      ok: true;
      type: number;
      /** XOR-MAPPED-ADDRESS (preferred) */
      xorMapped: StunEndpoint | null;
      /** legacy MAPPED-ADDRESS */
      mapped: StunEndpoint | null;
      responseOrigin: StunEndpoint | null;
      otherAddress: StunEndpoint | null;
      software: string | null;
      attributes: number[];
    }
  | { ok: false; error: StunParseError; errorCode?: number; reason?: string };

/** Parse and validate a STUN response for the given transaction id. */
export function parseStunMessage(msg: Uint8Array, txId: Uint8Array): StunParseResult {
  if (msg.length < 20) return { ok: false, error: 'short' };
  const dv = new DataView(msg.buffer, msg.byteOffset, msg.byteLength);
  const type = dv.getUint16(0);
  if ((type & 0xc000) !== 0) return { ok: false, error: 'not-stun' };
  const len = dv.getUint16(2);
  if (dv.getUint32(4) !== STUN_MAGIC_COOKIE) return { ok: false, error: 'bad-cookie' };
  for (let i = 0; i < 12; i++) if (msg[8 + i] !== txId[i]) return { ok: false, error: 'txid-mismatch' };
  if (len % 4 !== 0 || 20 + len > msg.length) return { ok: false, error: 'truncated' };

  let xorMapped: StunEndpoint | null = null;
  let mapped: StunEndpoint | null = null;
  let responseOrigin: StunEndpoint | null = null;
  let otherAddress: StunEndpoint | null = null;
  let software: string | null = null;
  let errorCode: number | undefined;
  let reason: string | undefined;
  const attributes: number[] = [];
  let off = 20;
  const end = 20 + len;
  while (off + 4 <= end) {
    const at = dv.getUint16(off);
    const al = dv.getUint16(off + 2);
    if (off + 4 + al > end) return { ok: false, error: 'truncated' };
    const v = msg.subarray(off + 4, off + 4 + al);
    attributes.push(at);
    if (at === STUN_ATTR.XOR_MAPPED_ADDRESS) xorMapped = decodeAddress(v, true, txId);
    else if (at === STUN_ATTR.MAPPED_ADDRESS) mapped = decodeAddress(v, false, txId);
    else if (at === STUN_ATTR.RESPONSE_ORIGIN) responseOrigin = decodeAddress(v, false, txId);
    else if (at === STUN_ATTR.OTHER_ADDRESS) otherAddress = decodeAddress(v, false, txId);
    else if (at === STUN_ATTR.SOFTWARE) software = new TextDecoder().decode(v);
    else if (at === STUN_ATTR.ERROR_CODE && al >= 4) {
      errorCode = (v[2] & 0x07) * 100 + v[3];
      reason = new TextDecoder().decode(v.subarray(4));
    }
    off += 4 + al + ((4 - (al % 4)) % 4);
  }
  if (type === STUN_BINDING_ERROR) return { ok: false, error: 'error-response', errorCode, reason };
  if (type !== STUN_BINDING_SUCCESS) return { ok: false, error: 'unexpected-type' };
  return { ok: true, type, xorMapped, mapped, responseOrigin, otherAddress, software, attributes };
}

/** "92.208.29.229:19830" / "[2a02:…:870a]:55953" */
export function formatEndpoint(ep: StunEndpoint): string {
  return ep.family === 6 ? `[${ep.address}]:${ep.port}` : `${ep.address}:${ep.port}`;
}

export function parseEndpoint(s: string | null | undefined): StunEndpoint | null {
  if (!s) return null;
  const v6 = /^\[([^\]]+)\]:(\d{1,5})$/.exec(s.trim());
  if (v6 && expandIPv6(v6[1])) return { family: 6, address: v6[1], port: Number(v6[2]) };
  const v4 = /^([\d.]+):(\d{1,5})$/.exec(s.trim());
  if (v4 && isIPv4(v4[1])) return { family: 4, address: v4[1], port: Number(v4[2]) };
  return null;
}

/** Result of one binding request (one server). */
export interface StunProbeOutcome {
  /** label, e.g. 'stun.l.google.com:19302' */
  server: string;
  /** resolved server address, null when DNS failed */
  serverIp: string | null;
  mapped: StunEndpoint | null;
  rttMs: number | null;
  /** 'timeout' | 'dns' | socket error code | parse error */
  error: string | null;
}

/**
 * NAT mapping behaviour from binding requests sent from ONE local socket to ≥ 2 servers with
 * different IPs: same mapped ip:port → endpoint-independent (RFC 4787 EIM), different →
 * endpoint-dependent ("symmetric"); every resolved server timed out → blocked; else unknown.
 */
export function classifyMapping(outcomes: readonly StunProbeOutcome[]): NatMapping {
  const ok = outcomes.filter((o): o is StunProbeOutcome & { mapped: StunEndpoint; serverIp: string } => o.mapped !== null && o.serverIp !== null);
  if (ok.length === 0) {
    const attempted = outcomes.filter((o) => o.serverIp !== null);
    return attempted.length > 0 && attempted.every((o) => o.error === 'timeout') ? 'blocked' : 'unknown';
  }
  const servers = new Set(ok.map((o) => normalizeIp(o.serverIp)));
  if (servers.size < 2) return 'unknown';
  const first = ok[0].mapped;
  const same = ok.every((o) => sameIp(o.mapped.address, first.address) && o.mapped.port === first.port);
  return same ? 'endpoint-independent' : 'endpoint-dependent';
}

/** Most common mapped IP among the successful outcomes (normally all agree). */
export function publicIpFrom(outcomes: readonly StunProbeOutcome[]): string | null {
  const counts = new Map<string, { ip: string; n: number }>();
  for (const o of outcomes) {
    if (!o.mapped) continue;
    const k = normalizeIp(o.mapped.address);
    const c = counts.get(k);
    if (c) c.n++;
    else counts.set(k, { ip: o.mapped.address, n: 1 });
  }
  let best: { ip: string; n: number } | null = null;
  for (const c of counts.values()) if (!best || c.n > best.n) best = c;
  return best ? best.ip : null;
}

/** Router facts relevant for CGNAT (subset of RouterStatus). */
export interface RouterNatHints {
  dsLite?: boolean | null;
  wanIpv4?: string | null;
}

/**
 * IPv4 behind carrier-grade NAT? true when the router runs DS-Lite, when its WAN IPv4 is itself
 * private/shared, or when the STUN public IPv4 differs from the router WAN IPv4; false when they
 * match; null when unknown.
 */
export function deriveCgnatV4(publicIp: string | null, router: RouterNatHints | null): boolean | null {
  if (router?.dsLite === true) return true;
  const wan = router?.wanIpv4 ?? null;
  if (wan && isIPv4(wan) && wan !== '0.0.0.0') {
    if (isPrivateV4(wan) || isCgnatV4(wan) || !isPublicV4(wan)) return true;
    if (publicIp) return !sameIp(publicIp, wan);
  }
  if (publicIp && isIPv4(publicIp) && !isPublicV4(publicIp)) return true;
  return null;
}

/** IPv6: NAT66 present when the mapped address differs from the local source address. */
export function deriveNat66(localAddress: string | null, mapped: StunEndpoint | null): boolean | null {
  if (!localAddress || !mapped) return null;
  return !sameIp(localAddress, mapped.address);
}

export const NAT_MAPPING_LABEL: Record<NatMapping, string> = {
  'endpoint-independent': 'endpunktunabhängig (günstig für Spiele)',
  'endpoint-dependent': 'endpunktabhängig (strikter NAT)',
  blocked: 'blockiert (keine STUN-Antwort)',
  unknown: 'unbekannt',
};

// ─── DNS (o-o.myaddr.l.google.com TXT) ─────────────────────────────────────

export const DNS_TYPE_TXT = 16;
export const DNS_CLASS_IN = 1;

/** Standard query with RD=1 and one question. */
export function buildDnsQuery(id: number, name: string, qtype: number, qclass: number = DNS_CLASS_IN): Uint8Array {
  const labels = name.split('.').filter((l) => l.length > 0);
  const parts: number[] = [];
  for (const label of labels) {
    if (label.length > 63 || !/^[\x21-\x7e]+$/.test(label)) throw new Error(`invalid DNS label: ${label}`);
    parts.push(label.length);
    for (let i = 0; i < label.length; i++) parts.push(label.charCodeAt(i));
  }
  parts.push(0);
  const buf = new Uint8Array(12 + parts.length + 4);
  const dv = new DataView(buf.buffer);
  dv.setUint16(0, id & 0xffff);
  dv.setUint16(2, 0x0100);
  dv.setUint16(4, 1);
  buf.set(parts, 12);
  dv.setUint16(12 + parts.length, qtype);
  dv.setUint16(14 + parts.length, qclass);
  return buf;
}

function skipName(msg: Uint8Array, off: number): number {
  for (let guard = 0; guard < 128 && off < msg.length; guard++) {
    const len = msg[off];
    if (len === 0) return off + 1;
    if ((len & 0xc0) === 0xc0) return off + 2;
    off += 1 + len;
  }
  throw new Error('bad DNS name');
}

export type DnsTxtResult =
  | { ok: true; rcode: number; truncated: boolean; txt: string[] }
  | { ok: false; error: 'short' | 'id-mismatch' | 'not-response' | 'question-mismatch' | 'malformed' };

/**
 * Validate a DNS response (id, QR bit, echoed question) and return the TXT answers; each answer
 * record's character-strings are concatenated into one string.
 */
export function parseDnsTxtResponse(msg: Uint8Array, id: number, question?: Uint8Array): DnsTxtResult {
  if (msg.length < 12) return { ok: false, error: 'short' };
  const dv = new DataView(msg.buffer, msg.byteOffset, msg.byteLength);
  if (dv.getUint16(0) !== (id & 0xffff)) return { ok: false, error: 'id-mismatch' };
  const flags = dv.getUint16(2);
  if ((flags & 0x8000) === 0) return { ok: false, error: 'not-response' };
  const qd = dv.getUint16(4);
  const an = dv.getUint16(6);
  if (question && qd >= 1) {
    if (msg.length < 12 + question.length) return { ok: false, error: 'question-mismatch' };
    for (let i = 0; i < question.length; i++) {
      if (msg[12 + i] !== question[i]) return { ok: false, error: 'question-mismatch' };
    }
  }
  const txt: string[] = [];
  try {
    let off = 12;
    for (let i = 0; i < qd; i++) off = skipName(msg, off) + 4;
    for (let i = 0; i < an; i++) {
      off = skipName(msg, off);
      if (off + 10 > msg.length) throw new Error('short rr');
      const type = dv.getUint16(off);
      const rdlen = dv.getUint16(off + 8);
      const rd = off + 10;
      if (rd + rdlen > msg.length) throw new Error('short rdata');
      if (type === DNS_TYPE_TXT) {
        let s = '';
        let p = rd;
        while (p < rd + rdlen) {
          const l = msg[p];
          s += String.fromCharCode(...msg.subarray(p + 1, Math.min(p + 1 + l, rd + rdlen)));
          p += 1 + l;
        }
        txt.push(s);
      }
      off = rd + rdlen;
    }
  } catch {
    return { ok: false, error: 'malformed' };
  }
  return { ok: true, rcode: flags & 0x0f, truncated: (flags & 0x0200) !== 0, txt };
}

/**
 * Interpret the TXT answers of `o-o.myaddr.l.google.com`. Asked through 8.8.8.8 they contain the
 * EDNS client subnet (`edns0-client-subnet 92.208.29.0/24` = the /24 of our CGNAT exit) and the
 * address that queried Google's authoritative server (the resolver's egress IP).
 */
export function parseGoogleMyAddr(txt: readonly string[]): { clientSubnet: string | null; sourceIp: string | null } {
  let clientSubnet: string | null = null;
  let sourceIp: string | null = null;
  for (const raw of txt) {
    const s = raw.trim();
    const ecs = /^edns0-client-subnet\s+(\S+)$/i.exec(s);
    if (ecs) clientSubnet = ecs[1];
    else if (sourceIp === null && (isIPv4(s) || expandIPv6(s))) sourceIp = s;
  }
  return { clientSubnet, sourceIp };
}

/** IPv4 CIDR membership (false for non-IPv4 input). */
export function ipv4InCidr(ip: string, cidr: string): boolean {
  const m = /^([\d.]+)\/(\d{1,2})$/.exec(cidr.trim());
  if (!m || !isIPv4(ip) || !isIPv4(m[1])) return false;
  const bits = Number(m[2]);
  if (bits > 32) return false;
  const toInt = (s: string) => s.split('.').reduce((acc, p) => (acc * 256 + Number(p)) >>> 0, 0);
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return ((toInt(ip) & mask) >>> 0) === ((toInt(m[1]) & mask) >>> 0);
}
