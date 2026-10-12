import dgram from 'node:dgram';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DNS_CLASS, DNS_TYPE, decodeDnsMessage } from '../../src/lib/shared/dns';
import { SampleStatus } from '../../src/lib/shared/types';
import { UdpDnsClient, questionForQuery, udpErrorStatus } from './udp-dns';

describe('questionForQuery', () => {
  it("'id.server' → CH TXT (answered by the Cloudflare PoP itself), anything else IN A", () => {
    expect(questionForQuery('id.server')).toEqual({ name: 'id.server', type: DNS_TYPE.TXT, cls: DNS_CLASS.CH });
    expect(questionForQuery('ID.SERVER.')).toEqual({ name: 'id.server', type: DNS_TYPE.TXT, cls: DNS_CLASS.CH });
    expect(questionForQuery('cloudflare.com')).toEqual({ name: 'cloudflare.com', type: DNS_TYPE.A, cls: DNS_CLASS.IN });
    expect(questionForQuery(undefined)).toEqual({ name: 'cloudflare.com', type: DNS_TYPE.A, cls: DNS_CLASS.IN });
    expect(questionForQuery('  ')).toEqual({ name: 'cloudflare.com', type: DNS_TYPE.A, cls: DNS_CLASS.IN });
  });

  it('maps send errors', () => {
    expect(udpErrorStatus('EHOSTUNREACH')).toBe(SampleStatus.UNREACHABLE);
    expect(udpErrorStatus('ENETUNREACH')).toBe(SampleStatus.UNREACHABLE);
    expect(udpErrorStatus('ECONNRESET')).toBe(SampleStatus.ERROR);
    expect(udpErrorStatus(null)).toBe(SampleStatus.ERROR);
  });
});

type Mode = 'answer' | 'drop' | 'late' | 'wrong-id' | 'no-qr' | 'nxdomain' | 'twice';

/** Tiny DNS server on loopback that answers CH TXT id.server with "dus01". */
class FakeDnsServer {
  sock: dgram.Socket;
  mode: Mode = 'answer';
  received = 0;
  constructor(readonly family: 4 | 6) {
    this.sock = dgram.createSocket(family === 6 ? 'udp6' : 'udp4');
    this.sock.on('message', (msg, rinfo) => this.onQuery(msg, rinfo));
  }
  async listen(): Promise<number> {
    await new Promise<void>((resolve) => this.sock.bind(0, this.family === 6 ? '::1' : '127.0.0.1', resolve));
    return this.sock.address().port;
  }
  close(): void {
    this.sock.close();
  }
  private onQuery(q: Buffer, rinfo: dgram.RemoteInfo): void {
    this.received++;
    const out = Buffer.from(q);
    out[2] = this.mode === 'no-qr' ? 0x01 : 0x81; // QR + RD
    out[3] = this.mode === 'nxdomain' ? 0x83 : 0x80; // RA (+ NXDOMAIN)
    if (this.mode === 'wrong-id') out.writeUInt16BE((out.readUInt16BE(0) + 1) & 0xffff, 0);
    let res = out;
    if (this.mode !== 'nxdomain') {
      out.writeUInt16BE(1, 6); // ANCOUNT
      const txt = Buffer.from('dus01');
      res = Buffer.concat([out, Buffer.from([0xc0, 0x0c, 0, 16, 0, 3, 0, 0, 0, 0, 0, txt.length + 1, txt.length]), txt]);
    }
    const send = () => this.sock.send(res, rinfo.port, rinfo.address);
    if (this.mode === 'drop') return;
    if (this.mode === 'late') setTimeout(send, 150);
    else if (this.mode === 'twice') {
      send();
      send();
    } else send();
  }
}

describe.each([4, 6] as const)('UdpDnsClient over IPv%s loopback', (family) => {
  let server: FakeDnsServer;
  let port = 0;
  const host = family === 6 ? '::1' : '127.0.0.1';
  const q = questionForQuery('id.server');

  beforeEach(async () => {
    server = new FakeDnsServer(family);
    port = await server.listen();
  });
  afterEach(() => {
    server.close();
  });

  it('matches answers by id + QR, extracts the PoP and flags only the first answer', async () => {
    const c = new UdpDnsClient(host, port, family, q);
    const a = await c.query(1000);
    expect(a).toMatchObject({ status: SampleStatus.OK, rcode: 0, txt: ['dus01'], first: true, error: null });
    expect(a.rtt).toBeGreaterThanOrEqual(0);
    expect(a.rtt).toBeLessThan(500);
    const b = await c.query(1000);
    expect(b).toMatchObject({ status: SampleStatus.OK, first: false, txt: ['dus01'] });
    c.close();
  });

  it('times out, ignores the late answer and keeps the socket (mapping) for the next query', async () => {
    const c = new UdpDnsClient(host, port, family, q);
    await c.query(1000);
    server.mode = 'late';
    const lost = await c.query(60);
    expect(lost).toMatchObject({ status: SampleStatus.TIMEOUT, rtt: null, first: false });
    await new Promise((r) => setTimeout(r, 200)); // late answer arrives and is dropped
    server.mode = 'answer';
    const next = await c.query(1000);
    expect(next).toMatchObject({ status: SampleStatus.OK, first: false });
    c.close();
  });

  it('ignores answers with a wrong id or without QR bit, and duplicate answers', async () => {
    const c = new UdpDnsClient(host, port, family, q);
    server.mode = 'wrong-id';
    expect((await c.query(80)).status).toBe(SampleStatus.TIMEOUT);
    server.mode = 'no-qr';
    expect((await c.query(80)).status).toBe(SampleStatus.TIMEOUT);
    server.mode = 'twice';
    expect((await c.query(1000)).status).toBe(SampleStatus.OK);
    c.close();
  });

  it('an error rcode still measures the RTT (the server answered)', async () => {
    const c = new UdpDnsClient(host, port, family, questionForQuery('nix.invalid'));
    server.mode = 'nxdomain';
    const r = await c.query(1000);
    expect(r).toMatchObject({ status: SampleStatus.OK, rcode: 3, txt: [], error: 'DNS-Antwort NXDOMAIN' });
    c.close();
  });

  it('close() resolves pending queries and refuses new ones', async () => {
    const c = new UdpDnsClient(host, port, family, q);
    await c.query(1000);
    server.mode = 'drop';
    const pending = c.query(5000);
    await new Promise((r) => setTimeout(r, 20));
    c.close();
    expect(await pending).toMatchObject({ status: SampleStatus.ERROR, error: 'UDP-Socket geschlossen' });
    expect(await c.query(100)).toMatchObject({ status: SampleStatus.ERROR, rtt: null });
  });

  it('sends a well-formed CH TXT query', async () => {
    const seen: Buffer[] = [];
    server.sock.on('message', (m) => seen.push(m));
    const c = new UdpDnsClient(host, port, family, q);
    await c.query(1000);
    c.close();
    const msg = decodeDnsMessage(seen[0]);
    expect(msg?.questions).toEqual([{ name: 'id.server', type: DNS_TYPE.TXT, cls: DNS_CLASS.CH }]);
    expect(msg?.header).toMatchObject({ qr: false, rd: true, qdCount: 1 });
  });
});
