import { EventEmitter } from 'node:events';
import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SampleStatus } from '../../src/lib/shared/types';
import { type ProbeSocket, REFUSED_MAX_RTT_MS, REFUSED_SLOW_TEXT, tcpConnectProbe, tcpErrorOutcome, tcpErrorStatus } from './tcp';

describe('tcpErrorStatus / tcpErrorOutcome', () => {
  it('maps socket error codes', () => {
    expect(tcpErrorStatus('ECONNREFUSED')).toBe(SampleStatus.OK);
    expect(tcpErrorStatus('EHOSTUNREACH')).toBe(SampleStatus.UNREACHABLE);
    expect(tcpErrorStatus('ENETUNREACH')).toBe(SampleStatus.UNREACHABLE);
    expect(tcpErrorStatus('ETIMEDOUT')).toBe(SampleStatus.TIMEOUT);
    expect(tcpErrorStatus('ECONNRESET')).toBe(SampleStatus.ERROR);
    expect(tcpErrorStatus(null)).toBe(SampleStatus.ERROR);
  });

  it('a quick refusal is a valid RTT (the host answered with RST)', () => {
    expect(tcpErrorOutcome('ECONNREFUSED', 1.6234)).toEqual({ status: SampleStatus.OK, rtt: 1.623 });
  });

  it("a refusal after Windows' SYN retries (≈ 2 s) is neither RTT nor loss → discarded with a hint", () => {
    const o = tcpErrorOutcome('ECONNREFUSED', 2057.1);
    expect(o).toEqual({ status: SampleStatus.ERROR, rtt: null, discard: true, error: REFUSED_SLOW_TEXT });
    expect(tcpErrorOutcome('ECONNREFUSED', REFUSED_MAX_RTT_MS).discard).toBe(true);
  });

  it('other errors carry a German note only for local errors', () => {
    expect(tcpErrorOutcome('EHOSTUNREACH', 3)).toEqual({ status: SampleStatus.UNREACHABLE, rtt: null, error: null });
    expect(tcpErrorOutcome('EACCES', 1)).toEqual({ status: SampleStatus.ERROR, rtt: null, error: 'Verbindungsfehler (EACCES)' });
  });
});

describe('tcpConnectProbe (loopback)', () => {
  let server: net.Server;
  let port = 0;
  let closedPort = 0;

  beforeAll(async () => {
    server = net.createServer((s) => s.destroy());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as net.AddressInfo).port;
    const tmp = net.createServer();
    await new Promise<void>((resolve) => tmp.listen(0, '127.0.0.1', resolve));
    closedPort = (tmp.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => tmp.close(() => resolve()));
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('measures the handshake to an open port', async () => {
    const o = await tcpConnectProbe('127.0.0.1', port, 2000);
    expect(o.status).toBe(SampleStatus.OK);
    expect(o.rtt).toBeGreaterThanOrEqual(0);
    expect(o.rtt).toBeLessThan(500);
  });

  it('a closed port: OK when refused quickly, otherwise discarded – never a fake RTT', async () => {
    const o = await tcpConnectProbe('127.0.0.1', closedPort, 3000);
    if (o.status === SampleStatus.OK) expect(o.rtt).toBeLessThan(REFUSED_MAX_RTT_MS);
    else expect(o).toMatchObject({ discard: true, rtt: null });
  });

  it('times out and destroys the socket when nothing answers', async () => {
    const sock = new EventEmitter() as EventEmitter & { destroyed: boolean; connected: unknown };
    sock.destroyed = false;
    const fake = Object.assign(sock, {
      connect(opts: unknown) {
        sock.connected = opts;
        return sock;
      },
      destroy() {
        sock.destroyed = true;
        return sock;
      },
    });
    const o = await tcpConnectProbe('192.0.2.1', 443, 50, () => fake as unknown as ProbeSocket);
    expect(o).toEqual({ status: SampleStatus.TIMEOUT, rtt: null });
    expect(sock.destroyed).toBe(true);
    expect(sock.connected).toEqual({ host: '192.0.2.1', port: 443, noDelay: true });
  });

  it('reports a synchronous connect exception as ERROR', async () => {
    const sock = new EventEmitter();
    const fake = Object.assign(sock, {
      connect() {
        throw Object.assign(new Error('bad port'), { code: 'ERR_SOCKET_BAD_PORT' });
      },
      destroy() {
        return sock;
      },
    });
    const o = await tcpConnectProbe('1.1.1.1', 70_000, 100, () => fake as unknown as ProbeSocket);
    expect(o).toEqual({ status: SampleStatus.ERROR, rtt: null, error: 'Verbindungsfehler (ERR_SOCKET_BAD_PORT)' });
  });
});
