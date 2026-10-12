import { describe, expect, it } from 'vitest';
import {
  DNS_CLASS,
  DNS_TYPE,
  answersQuestion,
  decodeDnsHeader,
  decodeDnsMessage,
  decodeTxtRdata,
  encodeDnsName,
  encodeDnsQuery,
  extractAddresses,
  extractTxtStrings,
  formatIPv6,
  isDnsResponseTo,
  rcodeName,
  readDnsName,
} from './dns';

const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0));

/** Minimal response builder: question copied from the query + answers with a name pointer to it (0xC00C). */
function response(
  query: Uint8Array,
  answers: { type: number; cls: number; ttl: number; rdata: number[] }[],
  flags = 0x8180,
): Uint8Array {
  const out: number[] = Array.from(query);
  out[2] = flags >> 8;
  out[3] = flags & 0xff;
  out[6] = answers.length >> 8;
  out[7] = answers.length & 0xff;
  for (const a of answers) {
    out.push(0xc0, 0x0c, a.type >> 8, a.type & 0xff, a.cls >> 8, a.cls & 0xff);
    out.push((a.ttl >>> 24) & 0xff, (a.ttl >>> 16) & 0xff, (a.ttl >>> 8) & 0xff, a.ttl & 0xff);
    out.push(a.rdata.length >> 8, a.rdata.length & 0xff, ...a.rdata);
  }
  return Uint8Array.from(out);
}

describe('encodeDnsQuery', () => {
  it('builds the verified CH TXT id.server query byte for byte', () => {
    const q = encodeDnsQuery({ id: 0xbeef, name: 'id.server', type: DNS_TYPE.TXT, cls: DNS_CLASS.CH });
    expect(Array.from(q)).toEqual([
      0xbe, 0xef, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0,
      2, ...ascii('id'), 6, ...ascii('server'), 0,
      0x00, 0x10, 0x00, 0x03,
    ]);
  });

  it('defaults to IN A with recursion desired and accepts a trailing dot', () => {
    const q = encodeDnsQuery({ id: 1, name: 'cloudflare.com.' });
    const h = decodeDnsHeader(q);
    expect(h).toMatchObject({ id: 1, qr: false, rd: true, qdCount: 1, anCount: 0 });
    expect(Array.from(q.subarray(q.length - 4))).toEqual([0, 1, 0, 1]);
    expect(encodeDnsQuery({ id: 1, name: 'a.b', recursionDesired: false })[2]).toBe(0);
  });

  it('rejects invalid names', () => {
    expect(() => encodeDnsName('a'.repeat(64) + '.com')).toThrow();
    expect(() => encodeDnsName('bad name.com')).toThrow();
    expect(() => encodeDnsName('ümlaut.de')).toThrow();
    expect(Array.from(encodeDnsName('.'))).toEqual([0]);
  });
});

describe('decoding responses', () => {
  const query = encodeDnsQuery({ id: 0x1234, name: 'id.server', type: DNS_TYPE.TXT, cls: DNS_CLASS.CH });

  it('extracts the TXT answer (Cloudflare PoP) and matches id + QR', () => {
    const res = response(query, [{ type: DNS_TYPE.TXT, cls: DNS_CLASS.CH, ttl: 0, rdata: [5, ...ascii('dus01')] }]);
    expect(isDnsResponseTo(res, 0x1234)).toBe(true);
    expect(isDnsResponseTo(res, 0x1235)).toBe(false);
    expect(isDnsResponseTo(query, 0x1234)).toBe(false); // QR bit not set
    const msg = decodeDnsMessage(res);
    expect(msg).not.toBeNull();
    expect(msg?.header).toMatchObject({ qr: true, rcode: 0, ra: true, anCount: 1 });
    expect(msg?.questions).toEqual([{ name: 'id.server', type: DNS_TYPE.TXT, cls: DNS_CLASS.CH }]);
    expect(msg && extractTxtStrings(msg)).toEqual(['dus01']);
    expect(msg && answersQuestion(msg, { name: 'ID.SERVER.', type: DNS_TYPE.TXT, cls: DNS_CLASS.CH })).toBe(true);
    expect(msg && answersQuestion(msg, { name: 'id.server', type: DNS_TYPE.A, cls: DNS_CLASS.IN })).toBe(false);
  });

  it('decodes A and AAAA answers and rcodes', () => {
    const q = encodeDnsQuery({ id: 7, name: 'example.com' });
    const res = response(q, [
      { type: DNS_TYPE.A, cls: 1, ttl: 84, rdata: [104, 20, 23, 154] },
      { type: DNS_TYPE.AAAA, cls: 1, ttl: 84, rdata: [0x26, 0x06, 0x47, 0, 0x47, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x11, 0x11] },
    ]);
    const msg = decodeDnsMessage(res);
    expect(msg && extractAddresses(msg)).toEqual(['104.20.23.154', '2606:4700:4700::1111']);
    expect(msg?.answers[0].ttl).toBe(84);
    const nx = response(q, [], 0x8183);
    expect(decodeDnsHeader(nx)?.rcode).toBe(3);
    expect(rcodeName(3)).toBe('NXDOMAIN');
    expect(rcodeName(9)).toBe('RCODE9');
  });

  it('handles multiple character-strings and truncated TXT data', () => {
    expect(decodeTxtRdata(Uint8Array.from([2, ...ascii('ab'), 3, ...ascii('cde')]))).toEqual(['ab', 'cde']);
    expect(decodeTxtRdata(Uint8Array.from([5, ...ascii('ab')]))).toEqual([]);
  });

  it('rejects truncated or malicious messages without throwing', () => {
    const res = response(query, [{ type: DNS_TYPE.TXT, cls: 3, ttl: 0, rdata: [5, ...ascii('dus01')] }]);
    for (let n = 0; n < res.length; n++) {
      expect(() => decodeDnsMessage(res.subarray(0, n))).not.toThrow();
      if (n < res.length) expect(decodeDnsMessage(res.subarray(0, n))).toBeNull();
    }
    // self-referencing compression pointer at offset 12
    const loop = Uint8Array.from([0, 1, 0x81, 0x80, 0, 1, 0, 0, 0, 0, 0, 0, 0xc0, 0x0c, 0, 1, 0, 1]);
    expect(readDnsName(loop, 12)).toBeNull();
    expect(decodeDnsMessage(loop)).toBeNull();
    expect(decodeDnsHeader(Uint8Array.from([1, 2, 3]))).toBeNull();
  });

  it('follows backward compression pointers', () => {
    // "example.com" at 12, then "www" + pointer to 12 at offset 25
    const buf = Uint8Array.from([
      ...new Array(12).fill(0),
      7, ...ascii('example'), 3, ...ascii('com'), 0,
      3, ...ascii('www'), 0xc0, 12,
    ]);
    expect(readDnsName(buf, 12)).toEqual({ name: 'example.com', next: 25 });
    expect(readDnsName(buf, 25)).toEqual({ name: 'www.example.com', next: 31 });
  });
});

describe('formatIPv6', () => {
  it('compresses the longest zero run (RFC 5952)', () => {
    const b = (hex: string) => Uint8Array.from(hex.match(/../g)?.map((h) => parseInt(h, 16)) ?? []);
    expect(formatIPv6(b('00000000000000000000000000000001'))).toBe('::1');
    expect(formatIPv6(b('00000000000000000000000000000000'))).toBe('::');
    expect(formatIPv6(b('fe800000000000000000000000000000'))).toBe('fe80::');
    expect(formatIPv6(b('20010db8000100000001000000000001'))).toBe('2001:db8:1:0:1::1');
    expect(formatIPv6(b('2a020000000000000cff84a000000003'))).toBe('2a02::cff:84a0:0:3');
  });
});
