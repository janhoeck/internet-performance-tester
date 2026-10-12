import http from 'node:http';
import type net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SampleStatus } from '../../src/lib/shared/types';
import { buildProbeUrl, httpErrorStatus, httpProbe } from './http';

describe('buildProbeUrl', () => {
  it('chooses the scheme by port and omits default ports', () => {
    expect(buildProbeUrl('192.168.0.1')).toBe('http://192.168.0.1/');
    expect(buildProbeUrl('192.168.0.1', 80)).toBe('http://192.168.0.1/');
    expect(buildProbeUrl('speed.cloudflare.com', 443, '/cdn-cgi/trace')).toBe('https://speed.cloudflare.com/cdn-cgi/trace');
    expect(buildProbeUrl('192.168.0.1', 8080, 'status')).toBe('http://192.168.0.1:8080/status');
    expect(buildProbeUrl('example.com', undefined, '  ')).toBe('http://example.com/');
  });

  it('brackets IPv6 literals and percent-encodes zone ids', () => {
    expect(buildProbeUrl('2606:4700:4700::1111', 443)).toBe('https://[2606:4700:4700::1111]/');
    expect(buildProbeUrl('fe80::de73:6ff:fe12:34df%4', 80)).toBe('http://[fe80::de73:6ff:fe12:34df%254]/');
  });
});

describe('httpErrorStatus', () => {
  it('maps fetch errors incl. undici cause chains', () => {
    expect(httpErrorStatus(Object.assign(new Error('t'), { name: 'TimeoutError' }))).toBe(SampleStatus.TIMEOUT);
    expect(httpErrorStatus(Object.assign(new Error('a'), { name: 'AbortError' }))).toBe(SampleStatus.TIMEOUT);
    expect(httpErrorStatus(new TypeError('fetch failed', { cause: Object.assign(new Error('x'), { code: 'UND_ERR_CONNECT_TIMEOUT' }) }))).toBe(
      SampleStatus.TIMEOUT,
    );
    expect(httpErrorStatus(new TypeError('fetch failed', { cause: Object.assign(new Error('x'), { code: 'EHOSTUNREACH' }) }))).toBe(
      SampleStatus.UNREACHABLE,
    );
    expect(httpErrorStatus(new TypeError('fetch failed', { cause: Object.assign(new Error('x'), { code: 'ECONNREFUSED' }) }))).toBe(
      SampleStatus.ERROR,
    );
    expect(httpErrorStatus('weird')).toBe(SampleStatus.ERROR);
  });
});

describe('httpProbe (loopback server)', () => {
  let server: http.Server;
  let base = '';

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/hang') return; // never answers
      if (req.url === '/fail') {
        res.writeHead(503).end('busy');
        return;
      }
      if (req.url === '/redirect') {
        res.writeHead(302, { location: '/elsewhere' }).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.write('x'.repeat(1000));
      setTimeout(() => res.end(), 50);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('measures the time until the response headers', async () => {
    const o = await httpProbe(`${base}/`, 2000);
    expect(o.status).toBe(SampleStatus.OK);
    expect(o.rtt).toBeLessThan(1000);
    expect(o.error).toBeNull();
  });

  it('any HTTP answer counts as OK; 5xx carries a note; redirects are not followed', async () => {
    expect(await httpProbe(`${base}/fail`, 2000)).toMatchObject({ status: SampleStatus.OK, error: 'HTTP 503' });
    expect(await httpProbe(`${base}/redirect`, 2000)).toMatchObject({ status: SampleStatus.OK, error: null });
  });

  it('times out when the server does not answer', async () => {
    expect(await httpProbe(`${base}/hang`, 150)).toEqual({ status: SampleStatus.TIMEOUT, rtt: null, error: null });
  });

  it('a refused connection is an error with a German note', async () => {
    const closed = http.createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const port = (closed.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const o = await httpProbe(`http://127.0.0.1:${port}/`, 3000);
    expect(o.status).not.toBe(SampleStatus.OK);
    expect(o.rtt).toBeNull();
  });
});
