import { describe, expect, it } from 'vitest';
import {
  buildBindingRequest, buildDnsQuery, classifyMapping, deriveCgnatV4, deriveNat66, formatEndpoint, formatIPv6,
  ipv4InCidr, matchesTransaction, NAT_MAPPING_LABEL, newTransactionId, parseDnsTxtResponse, parseEndpoint,
  parseGoogleMyAddr, parseStunMessage, publicIpFrom, type StunProbeOutcome,
} from './stun';

const hex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (b) => parseInt(b, 16));

// Real binding responses captured on this machine (2026-10-09, one socket per request).
const CAPTURED = {
  googleV4: { tx: '17be8803eb7c267791bb22da', resp: '0101000c2112a44217be8803eb7c267791bb22da0020000800016c157dc2b9a7' },
  cloudflareV4: { tx: 'df021ce21b4967b53f9235b0', resp: '0101000c2112a442df021ce21b4967b53f9235b00020000800016dec7dc2b9a7' },
  googleV6: {
    tx: '3a66eb3e264166fe59ec054a',
    resp: '010100182112a4423a66eb3e264166fe59ec054a002000140002fb831eed243346c622be12d9ff383fe48240',
  },
  cloudflareV6: {
    tx: 'cff095eccc5cad32c39d4f0d',
    resp: '010100182112a442cff095eccc5cad32c39d4f0d002000140002fb801eed2433b3505c6cf8c434f4a595c807',
  },
};

describe('STUN binding request', () => {
  it('is exactly 20 bytes: type, length 0, magic cookie, transaction id', () => {
    const tx = hex('0102030405060708090a0b0c');
    expect(Array.from(buildBindingRequest(tx))).toEqual([0, 1, 0, 0, 0x21, 0x12, 0xa4, 0x42, ...Array.from(tx)]);
    expect(newTransactionId()).toHaveLength(12);
    expect(() => buildBindingRequest(new Uint8Array(4))).toThrow();
  });
});

describe('parseStunMessage (captured responses)', () => {
  it('decodes XOR-MAPPED-ADDRESS for IPv4 (DS-Lite CGNAT exit)', () => {
    const g = parseStunMessage(hex(CAPTURED.googleV4.resp), hex(CAPTURED.googleV4.tx));
    expect(g).toMatchObject({ ok: true, type: 0x0101, xorMapped: { family: 4, address: '92.208.29.229', port: 19719 }, attributes: [0x0020] });
    const c = parseStunMessage(hex(CAPTURED.cloudflareV4.resp), hex(CAPTURED.cloudflareV4.tx));
    expect(c).toMatchObject({ ok: true, xorMapped: { address: '92.208.29.229', port: 19710 } });
  });

  it('decodes XOR-MAPPED-ADDRESS for IPv6 (cookie ‖ transaction id mask)', () => {
    const g = parseStunMessage(hex(CAPTURED.googleV6.resp), hex(CAPTURED.googleV6.tx));
    expect(g).toMatchObject({ ok: true, xorMapped: { family: 6, address: '3fff:8071:7ca0:c980:3498:99c6:6608:870a', port: 55953 } });
    const c = parseStunMessage(hex(CAPTURED.cloudflareV6.resp), hex(CAPTURED.cloudflareV6.tx));
    expect(c).toMatchObject({ ok: true, xorMapped: { address: '3fff:8071:7ca0:c980:3498:99c6:6608:870a', port: 55954 } });
  });

  it('rejects foreign, truncated and error responses', () => {
    const msg = hex(CAPTURED.googleV4.resp);
    expect(parseStunMessage(msg, hex(CAPTURED.cloudflareV4.tx))).toEqual({ ok: false, error: 'txid-mismatch' });
    expect(matchesTransaction(msg, hex(CAPTURED.googleV4.tx))).toBe(true);
    expect(matchesTransaction(msg, hex(CAPTURED.cloudflareV4.tx))).toBe(false);
    expect(parseStunMessage(msg.subarray(0, 24), hex(CAPTURED.googleV4.tx))).toEqual({ ok: false, error: 'truncated' });
    expect(parseStunMessage(msg.subarray(0, 10), hex(CAPTURED.googleV4.tx))).toEqual({ ok: false, error: 'short' });
    const badCookie = msg.slice();
    badCookie[4] = 0;
    expect(parseStunMessage(badCookie, hex(CAPTURED.googleV4.tx))).toEqual({ ok: false, error: 'bad-cookie' });
    // binding error response with ERROR-CODE 420 "Unknown"
    const tx = hex(CAPTURED.googleV4.tx);
    const err = new Uint8Array([0x01, 0x11, 0x00, 0x0c, 0x21, 0x12, 0xa4, 0x42, ...Array.from(tx), 0x00, 0x09, 0x00, 0x08, 0, 0, 4, 20, 0x55, 0x6e, 0x6b, 0x6e]);
    expect(parseStunMessage(err, tx)).toEqual({ ok: false, error: 'error-response', errorCode: 420, reason: 'Unkn' });
  });

  it('decodes legacy MAPPED-ADDRESS and RFC 5780 OTHER-ADDRESS', () => {
    const tx = hex('000102030405060708090a0b');
    const msg = new Uint8Array([
      0x01, 0x01, 0x00, 0x18, 0x21, 0x12, 0xa4, 0x42, ...Array.from(tx),
      0x00, 0x01, 0x00, 0x08, 0x00, 0x01, 0x4d, 0x07, 92, 208, 29, 229, // MAPPED-ADDRESS 92.208.29.229:19719
      0x80, 0x2c, 0x00, 0x08, 0x00, 0x01, 0x0d, 0x97, 212, 227, 67, 34, // OTHER-ADDRESS 212.227.67.34:3479
    ]);
    expect(parseStunMessage(msg, tx)).toMatchObject({
      ok: true, xorMapped: null,
      mapped: { family: 4, address: '92.208.29.229', port: 19719 },
      otherAddress: { address: '212.227.67.34', port: 3479 },
    });
  });
});

describe('endpoint formatting', () => {
  it('formats and parses v4/v6 endpoints (RFC 5952)', () => {
    expect(formatIPv6(hex('20010db8000000000000000000000001'))).toBe('2001:db8::1');
    expect(formatIPv6(hex('2606470000490000000000000000000a'))).toBe('2606:4700:49::a');
    expect(formatIPv6(hex('00000000000000000000000000000000'))).toBe('::');
    expect(formatIPv6(hex('20010db8000100000001000000000001'))).toBe('2001:db8:1:0:1::1');
    expect(formatEndpoint({ family: 6, address: '2a02:8071::1', port: 3478 })).toBe('[2a02:8071::1]:3478');
    expect(parseEndpoint('[2a02:8071::1]:3478')).toEqual({ family: 6, address: '2a02:8071::1', port: 3478 });
    expect(parseEndpoint('92.208.29.229:19830')).toEqual({ family: 4, address: '92.208.29.229', port: 19830 });
    expect(parseEndpoint('nonsense')).toBeNull();
  });
});

describe('NAT classification', () => {
  const ep = (address: string, port: number) => ({ family: 4 as const, address, port });
  const o = (server: string, serverIp: string | null, mapped: ReturnType<typeof ep> | null, error: string | null = null): StunProbeOutcome => ({
    server, serverIp, mapped, rttMs: mapped ? 20 : null, error,
  });

  it('classifies endpoint-independent / dependent / blocked / unknown', () => {
    expect(classifyMapping([o('g', '74.125.250.129', ep('92.208.29.229', 19830)), o('c', '162.159.207.0', ep('92.208.29.229', 19830))])).toBe('endpoint-independent');
    expect(classifyMapping([o('g', '74.125.250.129', ep('92.208.29.229', 19830)), o('c', '162.159.207.0', ep('92.208.29.229', 19831))])).toBe('endpoint-dependent');
    expect(classifyMapping([o('g', '74.125.250.129', null, 'timeout'), o('c', '162.159.207.0', null, 'timeout')])).toBe('blocked');
    expect(classifyMapping([o('g', null, null, 'dns'), o('c', null, null, 'dns')])).toBe('unknown');
    expect(classifyMapping([o('g', '74.125.250.129', ep('92.208.29.229', 19830)), o('c', '162.159.207.0', null, 'timeout')])).toBe('unknown');
    // same server IP twice proves nothing
    expect(classifyMapping([o('g', '74.125.250.129', ep('1.2.3.4', 1)), o('g1', '74.125.250.129', ep('1.2.3.4', 1))])).toBe('unknown');
    expect(publicIpFrom([o('g', '1.1.1.1', ep('92.208.29.229', 1)), o('c', '1.0.0.1', null, 'timeout')])).toBe('92.208.29.229');
    expect(NAT_MAPPING_LABEL['endpoint-dependent']).toBe('endpunktabhängig (strikter NAT)');
  });

  it('derives CGNAT from the router state and the public IPv4', () => {
    expect(deriveCgnatV4('92.208.29.229', { dsLite: true, wanIpv4: '0.0.0.0' })).toBe(true);
    expect(deriveCgnatV4('92.208.29.229', { dsLite: false, wanIpv4: '92.208.29.229' })).toBe(false);
    expect(deriveCgnatV4('92.208.29.229', { dsLite: false, wanIpv4: '84.1.2.3' })).toBe(true);
    expect(deriveCgnatV4('92.208.29.229', { dsLite: null, wanIpv4: '100.64.12.1' })).toBe(true);
    expect(deriveCgnatV4('92.208.29.229', null)).toBeNull();
    expect(deriveCgnatV4(null, { dsLite: false, wanIpv4: null })).toBeNull();
    expect(deriveNat66('3fff:8071:7ca0:c980:3498:99c6:6608:870a', { family: 6, address: '3fff:8071:7ca0:c980:3498:99c6:6608:870a', port: 1 })).toBe(false);
    expect(deriveNat66(null, null)).toBeNull();
  });
});

describe('DNS TXT (o-o.myaddr.l.google.com via 8.8.8.8)', () => {
  // real answer captured on this machine
  const RESPONSE =
    '123481800001000200000000036f2d6f066d7961646472016c06676f6f676c6503636f6d0000100001c00c001000010000003c00232265646e73302d636c69656e742d7375626e65742039322e3230382e32392e302f3234c00c001000010000003c00100f3137322e3235332e3233372e313531';

  it('encodes the query exactly like the captured request', () => {
    const q = buildDnsQuery(0x1234, 'o-o.myaddr.l.google.com', 16);
    const r = hex(RESPONSE);
    expect(Array.from(q.subarray(0, 4))).toEqual([0x12, 0x34, 0x01, 0x00]);
    expect(Array.from(q.subarray(12))).toEqual(Array.from(r.subarray(12, q.length)));
    expect(() => buildDnsQuery(1, `${'a'.repeat(64)}.de`, 16)).toThrow();
  });

  it('parses the TXT answers and the CGNAT exit subnet', () => {
    const q = buildDnsQuery(0x1234, 'o-o.myaddr.l.google.com', 16);
    const res = parseDnsTxtResponse(hex(RESPONSE), 0x1234, q.subarray(12));
    expect(res).toEqual({ ok: true, rcode: 0, truncated: false, txt: ['edns0-client-subnet 92.208.29.0/24', '172.253.237.151'] });
    if (!res.ok) throw new Error('unreachable');
    expect(parseGoogleMyAddr(res.txt)).toEqual({ clientSubnet: '92.208.29.0/24', sourceIp: '172.253.237.151' });
    expect(parseDnsTxtResponse(hex(RESPONSE), 0x4321)).toEqual({ ok: false, error: 'id-mismatch' });
    expect(parseDnsTxtResponse(q, 0x1234)).toEqual({ ok: false, error: 'not-response' });
    expect(parseDnsTxtResponse(hex(RESPONSE).subarray(0, 60), 0x1234)).toEqual({ ok: false, error: 'malformed' });
    expect(ipv4InCidr('92.208.29.229', '92.208.29.0/24')).toBe(true);
    expect(ipv4InCidr('92.208.30.1', '92.208.29.0/24')).toBe(false);
    expect(ipv4InCidr('2a02::1', '92.208.29.0/24')).toBe(false);
  });
});
