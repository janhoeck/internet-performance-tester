import dgram from 'node:dgram';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { buildIdServerQuery, createIdServerProber, parseDnsReply } from './speed-dns';

/**
 * Real reply of 1.1.1.1 (and 2606:4700:4700::1111) to `id.server` CH TXT, id 0x1234, captured on
 * this machine on 2026-10-09: TXT "dus01" (Cloudflare PoP Düsseldorf), compression pointer c00c.
 */
const REAL_REPLY_HEX = '123481800001000100000000026964067365727665720000100003c00c00100003000000000006056475733031';
/** query bytes from docs/research/critique.md §7.3 (TXT = 16, class CH = 3) */
const RESEARCH_QUERY = [0x12, 0x34, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0, 2, 0x69, 0x64, 6, 0x73, 0x65, 0x72, 0x76, 0x65, 0x72, 0, 0x00, 0x10, 0x00, 0x03];

describe('DNS id.server wire format', () => {
  it('builds the documented query', () => {
    expect([...buildIdServerQuery(0x1234)]).toEqual(RESEARCH_QUERY);
    expect(buildIdServerQuery(0xbeef).readUInt16BE(0)).toBe(0xbeef);
  });

  it('parses the real Cloudflare reply', () => {
    expect(parseDnsReply(Buffer.from(REAL_REPLY_HEX, 'hex'))).toEqual({ id: 0x1234, rcode: 0, txt: ['dus01'] });
  });

  it('works on a Uint8Array view with an offset', () => {
    const backing = Buffer.concat([Buffer.alloc(7, 0xff), Buffer.from(REAL_REPLY_HEX, 'hex')]);
    const view = new Uint8Array(backing.buffer, backing.byteOffset + 7, backing.length - 7);
    expect(parseDnsReply(view)?.txt).toEqual(['dus01']);
  });

  it('rejects queries and runts, tolerates truncated answers', () => {
    expect(parseDnsReply(buildIdServerQuery(1))).toBeNull(); // QR bit not set
    expect(parseDnsReply(Buffer.alloc(5))).toBeNull();
    const truncated = Buffer.from(REAL_REPLY_HEX, 'hex').subarray(0, 40);
    expect(parseDnsReply(truncated)).toEqual({ id: 0x1234, rcode: 0, txt: [] });
    const refused = Buffer.from(REAL_REPLY_HEX, 'hex');
    refused[3] = 0x85; // RCODE 5
    expect(parseDnsReply(refused)?.rcode).toBe(5);
  });
});

/** Local stand-in for 1.1.1.1:53 – answers with the real reply (id patched), optionally delayed or silent. */
async function fakeResolver(opts: { delayMs?: number; silent?: boolean } = {}): Promise<{ port: number; queries: number; close(): void }> {
  const sock = dgram.createSocket('udp4');
  const state = { port: 0, queries: 0, close: () => sock.close() };
  sock.on('message', (msg, rinfo) => {
    state.queries += 1;
    if (opts.silent) return;
    const reply = Buffer.from(REAL_REPLY_HEX, 'hex');
    msg.copy(reply, 0, 0, 2); // echo the query id
    setTimeout(() => sock.send(reply, rinfo.port, rinfo.address), opts.delayMs ?? 0);
  });
  await new Promise<void>((resolve) => sock.bind(0, '127.0.0.1', resolve));
  state.port = (sock.address() as AddressInfo).port;
  return state;
}

describe('createIdServerProber', () => {
  const cleanup: (() => void)[] = [];
  afterEach(() => {
    for (const fn of cleanup.splice(0)) fn();
  });

  it('measures the RTT and reports the PoP name', async () => {
    const srv = await fakeResolver({ delayMs: 30 });
    cleanup.push(() => srv.close());
    const prober = createIdServerProber({ host: '127.0.0.1', port: srv.port, timeoutMs: 1000 });
    cleanup.push(() => prober.close());
    await prober.open();
    const results = await Promise.all(
      [0, 1, 2].map(() => new Promise<[number | null, string | null]>((resolve) => prober.probe((rtt, pop) => resolve([rtt, pop])))),
    );
    for (const [rtt, pop] of results) {
      expect(pop).toBe('dus01');
      expect(rtt).not.toBeNull();
      expect(rtt ?? 0).toBeGreaterThanOrEqual(25);
      expect(rtt ?? 0).toBeLessThan(800);
    }
    expect(srv.queries).toBe(3);
    expect(prober.pending).toBe(0);
  });

  it('reports a lost probe after the timeout', async () => {
    const srv = await fakeResolver({ silent: true });
    cleanup.push(() => srv.close());
    const prober = createIdServerProber({ host: '127.0.0.1', port: srv.port, timeoutMs: 80 });
    cleanup.push(() => prober.close());
    await prober.open();
    const t0 = performance.now();
    const [rtt, pop] = await new Promise<[number | null, string | null]>((resolve) => prober.probe((r, p) => resolve([r, p])));
    expect(rtt).toBeNull();
    expect(pop).toBeNull();
    expect(performance.now() - t0).toBeGreaterThanOrEqual(60);
  });

  it('drops pending probes on close without calling back', async () => {
    const srv = await fakeResolver({ silent: true });
    cleanup.push(() => srv.close());
    const prober = createIdServerProber({ host: '127.0.0.1', port: srv.port, timeoutMs: 50 });
    await prober.open();
    let called = 0;
    prober.probe(() => {
      called += 1;
    });
    expect(prober.pending).toBe(1);
    prober.close();
    expect(prober.pending).toBe(0);
    await new Promise((r) => setTimeout(r, 120));
    expect(called).toBe(0);
    // probing a closed prober answers immediately with "lost"
    const late = await new Promise<number | null>((resolve) => prober.probe((rtt) => resolve(rtt)));
    expect(late).toBeNull();
  });

  it('open() rejects when the socket cannot be connected', async () => {
    const prober = createIdServerProber({ host: 'no-such-host.invalid', port: 53 });
    await expect(prober.open()).rejects.toThrow();
    prober.close();
  });
});
