// DNS wire-format helpers (RFC 1035): build queries, decode responses, extract TXT strings and
// addresses. Pure and dependency free (Uint8Array/DataView only) – used by the UDP-DNS probe, the
// UDP burst test and anyone else who needs a raw DNS query (e.g. `o-o.myaddr.l.google.com` TXT).

export const DNS_TYPE = { A: 1, NS: 2, CNAME: 5, SOA: 6, PTR: 12, MX: 15, TXT: 16, AAAA: 28 } as const;
export const DNS_CLASS = { IN: 1, CH: 3 } as const;

const RCODE_NAMES: Record<number, string> = {
  0: 'NOERROR', 1: 'FORMERR', 2: 'SERVFAIL', 3: 'NXDOMAIN', 4: 'NOTIMP', 5: 'REFUSED',
};

/** Human readable response code, e.g. 3 → 'NXDOMAIN'. */
export function rcodeName(rcode: number): string {
  return RCODE_NAMES[rcode] ?? `RCODE${rcode}`;
}

export interface DnsQuery {
  /** 16-bit transaction id */
  id: number;
  name: string;
  /** default A */
  type?: number;
  /** default IN */
  cls?: number;
  /** RD flag, default true */
  recursionDesired?: boolean;
}

/** Encode a domain name as a sequence of length-prefixed labels. Throws on invalid names. */
export function encodeDnsName(name: string): Uint8Array {
  const labels = name.split('.').filter((l) => l.length > 0);
  const out: number[] = [];
  for (const label of labels) {
    if (label.length > 63) throw new Error(`DNS label too long: ${label}`);
    out.push(label.length);
    for (let i = 0; i < label.length; i++) {
      const c = label.charCodeAt(i);
      if (c <= 0x20 || c >= 0x7f) throw new Error(`DNS name must be printable ASCII: ${name}`);
      out.push(c);
    }
  }
  out.push(0);
  if (out.length > 255) throw new Error(`DNS name too long: ${name}`);
  return Uint8Array.from(out);
}

/** Build a standard query with one question (header + QNAME + QTYPE + QCLASS). */
export function encodeDnsQuery(q: DnsQuery): Uint8Array {
  const qname = encodeDnsName(q.name);
  const buf = new Uint8Array(12 + qname.length + 4);
  const v = new DataView(buf.buffer);
  v.setUint16(0, q.id & 0xffff);
  v.setUint16(2, q.recursionDesired === false ? 0x0000 : 0x0100);
  v.setUint16(4, 1); // QDCOUNT
  buf.set(qname, 12);
  v.setUint16(12 + qname.length, q.type ?? DNS_TYPE.A);
  v.setUint16(14 + qname.length, q.cls ?? DNS_CLASS.IN);
  return buf;
}

export interface DnsHeader {
  id: number;
  /** true for responses */
  qr: boolean;
  opcode: number;
  aa: boolean;
  /** truncated */
  tc: boolean;
  rd: boolean;
  ra: boolean;
  rcode: number;
  qdCount: number;
  anCount: number;
  nsCount: number;
  arCount: number;
}

function view(buf: Uint8Array): DataView {
  return new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
}

/** Decode the 12-byte header; null when the buffer is too short. */
export function decodeDnsHeader(buf: Uint8Array): DnsHeader | null {
  if (buf.length < 12) return null;
  const v = view(buf);
  const flags = v.getUint16(2);
  return {
    id: v.getUint16(0),
    qr: (flags & 0x8000) !== 0,
    opcode: (flags >> 11) & 0x0f,
    aa: (flags & 0x0400) !== 0,
    tc: (flags & 0x0200) !== 0,
    rd: (flags & 0x0100) !== 0,
    ra: (flags & 0x0080) !== 0,
    rcode: flags & 0x0f,
    qdCount: v.getUint16(4),
    anCount: v.getUint16(6),
    nsCount: v.getUint16(8),
    arCount: v.getUint16(10),
  };
}

/** true if `buf` is a response (QR bit) carrying transaction id `id`. */
export function isDnsResponseTo(buf: Uint8Array, id: number): boolean {
  const h = decodeDnsHeader(buf);
  return h !== null && h.qr && h.id === (id & 0xffff);
}

/**
 * Read a (possibly compressed) name at `offset`. Compression pointers must point backwards, which
 * rules out loops. Returns the dotted name (lowercase as received) and the offset after the name
 * in the original position, or null when malformed.
 */
export function readDnsName(buf: Uint8Array, offset: number): { name: string; next: number } | null {
  const labels: string[] = [];
  let pos = offset;
  let next = -1;
  let total = 0;
  for (let hops = 0; hops < 128; hops++) {
    if (pos >= buf.length) return null;
    const len = buf[pos];
    if (len === 0) {
      return { name: labels.join('.'), next: next === -1 ? pos + 1 : next };
    }
    if ((len & 0xc0) === 0xc0) {
      if (pos + 1 >= buf.length) return null;
      const ptr = ((len & 0x3f) << 8) | buf[pos + 1];
      if (ptr >= pos) return null; // forward/self pointer → malformed or loop
      if (next === -1) next = pos + 2;
      pos = ptr;
      continue;
    }
    if ((len & 0xc0) !== 0) return null; // reserved label types
    if (pos + 1 + len > buf.length) return null;
    total += len + 1;
    if (total > 255) return null;
    let label = '';
    for (let i = 0; i < len; i++) label += String.fromCharCode(buf[pos + 1 + i]);
    labels.push(label);
    pos += 1 + len;
  }
  return null;
}

export interface DnsQuestion {
  name: string;
  type: number;
  cls: number;
}

export interface DnsRecord {
  name: string;
  type: number;
  cls: number;
  ttl: number;
  /** raw RDATA (a view into the message) */
  rdata: Uint8Array;
  /** offset of RDATA in the message (needed to decode compressed names inside RDATA) */
  rdataOffset: number;
}

export interface DnsMessage {
  header: DnsHeader;
  questions: DnsQuestion[];
  answers: DnsRecord[];
  authorities: DnsRecord[];
  additionals: DnsRecord[];
}

function readRecords(buf: Uint8Array, start: number, count: number): { records: DnsRecord[]; next: number } | null {
  const v = view(buf);
  const records: DnsRecord[] = [];
  let off = start;
  for (let i = 0; i < count; i++) {
    const n = readDnsName(buf, off);
    if (!n || n.next + 10 > buf.length) return null;
    off = n.next;
    const type = v.getUint16(off);
    const cls = v.getUint16(off + 2);
    const ttl = v.getUint32(off + 4);
    const rdlen = v.getUint16(off + 8);
    off += 10;
    if (off + rdlen > buf.length) return null;
    records.push({ name: n.name, type, cls, ttl, rdata: buf.subarray(off, off + rdlen), rdataOffset: off });
    off += rdlen;
  }
  return { records, next: off };
}

/** Decode a complete message; null when any section is malformed or truncated. */
export function decodeDnsMessage(buf: Uint8Array): DnsMessage | null {
  const header = decodeDnsHeader(buf);
  if (!header) return null;
  const v = view(buf);
  const questions: DnsQuestion[] = [];
  let off = 12;
  for (let i = 0; i < header.qdCount; i++) {
    const n = readDnsName(buf, off);
    if (!n || n.next + 4 > buf.length) return null;
    questions.push({ name: n.name, type: v.getUint16(n.next), cls: v.getUint16(n.next + 2) });
    off = n.next + 4;
  }
  const an = readRecords(buf, off, header.anCount);
  if (!an) return null;
  const ns = readRecords(buf, an.next, header.nsCount);
  if (!ns) return null;
  const ar = readRecords(buf, ns.next, header.arCount);
  if (!ar) return null;
  return { header, questions, answers: an.records, authorities: ns.records, additionals: ar.records };
}

const utf8 = new TextDecoder('utf-8');

/** Split TXT RDATA into its character-strings. */
export function decodeTxtRdata(rdata: Uint8Array): string[] {
  const out: string[] = [];
  let p = 0;
  while (p < rdata.length) {
    const len = rdata[p];
    if (p + 1 + len > rdata.length) break;
    out.push(utf8.decode(rdata.subarray(p + 1, p + 1 + len)));
    p += 1 + len;
  }
  return out;
}

/** All TXT strings of the answer section (e.g. the Cloudflare PoP 'dus01' for CH TXT id.server). */
export function extractTxtStrings(msg: DnsMessage): string[] {
  const out: string[] = [];
  for (const r of msg.answers) if (r.type === DNS_TYPE.TXT) out.push(...decodeTxtRdata(r.rdata));
  return out;
}

/** RFC 5952 text form of a 16-byte IPv6 address (lowercase, longest zero run compressed). */
export function formatIPv6(bytes: Uint8Array): string {
  const groups: number[] = [];
  for (let i = 0; i + 1 < 16 && i + 1 < bytes.length; i += 2) groups.push((bytes[i] << 8) | bytes[i + 1]);
  let bestStart = -1;
  let bestLen = 0;
  for (let i = 0; i < groups.length; ) {
    if (groups[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < groups.length && groups[j] === 0) j++;
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

/** A and AAAA addresses of the answer section, in order. */
export function extractAddresses(msg: DnsMessage): string[] {
  const out: string[] = [];
  for (const r of msg.answers) {
    if (r.type === DNS_TYPE.A && r.rdata.length === 4) out.push(Array.from(r.rdata).join('.'));
    else if (r.type === DNS_TYPE.AAAA && r.rdata.length === 16) out.push(formatIPv6(r.rdata));
  }
  return out;
}

/** true if the response echoes exactly our question (case-insensitive name, same type and class). */
export function answersQuestion(msg: DnsMessage, q: Pick<DnsQuery, 'name' | 'type' | 'cls'>): boolean {
  const want = q.name.replace(/\.$/, '').toLowerCase();
  return msg.questions.some(
    (x) => x.name.toLowerCase() === want && x.type === (q.type ?? DNS_TYPE.A) && x.cls === (q.cls ?? DNS_CLASS.IN),
  );
}
