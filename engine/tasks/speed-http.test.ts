import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CF_BASE,
  type LoadTransport,
  type StreamOutcome,
  coloFromHeaders,
  createCloudflareTransport,
  errorText,
  familyFromIp,
  isAbortError,
  parseEndpoint,
  parseRetryAfter,
  serverLabel,
} from './speed-http';

describe('header helpers', () => {
  it('parses Retry-After (seconds or HTTP date), clamped to 0…60 s', () => {
    const now = Date.UTC(2026, 9, 9, 12, 0, 0);
    expect(parseRetryAfter('3', now)).toBe(3000);
    expect(parseRetryAfter(' 1.5 ', now)).toBe(1500);
    expect(parseRetryAfter('0', now)).toBe(0);
    expect(parseRetryAfter('600', now)).toBe(60_000);
    expect(parseRetryAfter(new Date(now + 10_000).toUTCString(), now)).toBe(10_000);
    expect(parseRetryAfter(new Date(now - 10_000).toUTCString(), now)).toBe(0);
    expect(parseRetryAfter('bald', now)).toBe(5000);
    expect(parseRetryAfter(null, now)).toBe(5000);
  });

  it('reads the PoP from colo ?? cf-meta-colo ?? CF-RAY', () => {
    const h = (m: Record<string, string>) => (name: string) => m[name] ?? null;
    // current __down format: unprefixed geo headers
    expect(coloFromHeaders(h({ colo: 'DUS', 'cf-ray': '8c1a2b3c4d5e6f70-FRA' }))).toBe('DUS');
    // __up still uses the prefixed header
    expect(coloFromHeaders(h({ 'cf-meta-colo': 'fra' }))).toBe('FRA');
    expect(coloFromHeaders(h({ colo: 'Düsseldorf', 'cf-ray': '8c1a2b3c4d5e6f70-DUS' }))).toBe('DUS');
    expect(coloFromHeaders(h({}))).toBeNull();
    expect(serverLabel('DUS')).toBe('Cloudflare DUS');
    expect(serverLabel(null)).toBeNull();
  });

  it('IP family of cf-meta-ip', () => {
    expect(familyFromIp('3fff:8071:7ca0:c980::1')).toBe(6);
    expect(familyFromIp('92.79.214.92')).toBe(4);
    expect(familyFromIp('unknown')).toBeNull();
    expect(familyFromIp(null)).toBeNull();
  });

  it('short error reasons', () => {
    const undiciLike = new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }) });
    expect(errorText(undiciLike)).toBe('ENOTFOUND');
    expect(errorText(Object.assign(new Error('x'), { code: 'ECONNRESET' }))).toBe('ECONNRESET');
    expect(errorText(new Error('kaputt'))).toBe('kaputt');
    expect(errorText('text')).toBe('text');
    expect(isAbortError(Object.assign(new Error('a'), { name: 'AbortError' }))).toBe(true);
    expect(isAbortError(new Error('a'))).toBe(false);
  });

  it('parses the endpoint', () => {
    expect(parseEndpoint(CF_BASE)).toEqual({
      base: 'https://speed.cloudflare.com',
      secure: true,
      hostname: 'speed.cloudflare.com',
      port: undefined,
      pathPrefix: '',
    });
    expect(parseEndpoint('http://127.0.0.1:8080/st/')).toMatchObject({ base: 'http://127.0.0.1:8080/st', secure: false, port: 8080, pathPrefix: '/st' });
    expect(parseEndpoint('http://[::1]:9000').hostname).toBe('::1');
    expect(() => parseEndpoint('ftp://example.org')).toThrow();
  });
});

// ─── real transport against a local stand-in for speed.cloudflare.com ──────

interface ServerState {
  uploaded: number[];
  /** next requests answer 429 (per path) */
  reject429: Record<string, number>;
  /** download bytes per 10 ms tick (0 = as fast as possible) */
  downChunkPer10Ms: number;
}

function startServer(state: ServerState): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if ((state.reject429[url.pathname] ?? 0) > 0) {
      state.reject429[url.pathname] -= 1;
      res.writeHead(429, { 'retry-after': '2', 'content-type': 'text/plain' });
      res.end('rate limited');
      return;
    }
    if (url.pathname === '/__down') {
      const total = Number(url.searchParams.get('bytes') ?? 0);
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': String(total),
        colo: 'DUS',
        'cf-meta-ip': '3fff:8071:7ca0:c980::1',
      });
      let sent = 0;
      const chunk = Buffer.alloc(64 * 1024, 0x30);
      const pump = () => {
        while (sent < total) {
          const n = Math.min(state.downChunkPer10Ms || chunk.length, total - sent);
          sent += n;
          const more = res.write(chunk.subarray(0, n));
          if (state.downChunkPer10Ms) {
            if (sent < total) setTimeout(pump, 10);
            else res.end();
            return;
          }
          if (!more) {
            res.once('drain', pump);
            return;
          }
        }
        res.end();
      };
      pump();
      return;
    }
    if (url.pathname === '/__up') {
      let got = 0;
      req.on('data', (c: Buffer) => {
        got += c.length;
      });
      req.on('end', () => {
        state.uploaded.push(got);
        res.writeHead(200, { 'cf-meta-colo': 'DUS', 'cf-meta-upload-bytes': String(got) });
        res.end();
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

describe('createCloudflareTransport (local server)', () => {
  const state: ServerState = { uploaded: [], reject429: {}, downChunkPer10Ms: 0 };
  let server: http.Server;
  let transport: LoadTransport;

  beforeAll(async () => {
    server = await startServer(state);
    const { port } = server.address() as AddressInfo;
    transport = createCloudflareTransport({ baseUrl: `http://127.0.0.1:${port}` });
  });

  afterAll(() => {
    transport.dispose();
    server.closeAllConnections();
    server.close();
  });

  const never = new AbortController().signal;

  it('preflight reports status, PoP and IP family', async () => {
    expect(await transport.preflight(never)).toEqual({ status: 200, colo: 'DUS', family: 6, retryAfterMs: null });
    state.reject429['/__down'] = 1;
    expect(await transport.preflight(never)).toMatchObject({ status: 429, retryAfterMs: 2000 });
  });

  it('download streams the body and reports the status at header time', async () => {
    const order: string[] = [];
    let bytes = 0;
    const out = await transport.download(
      1_000_000,
      never,
      (n) => {
        if (bytes === 0) order.push('bytes');
        bytes += n;
      },
      (o: StreamOutcome) => order.push(`response ${o.status} ${o.colo}`),
    );
    expect(out).toEqual({ status: 200, colo: 'DUS', retryAfterMs: null });
    expect(bytes).toBe(1_000_000);
    expect(order).toEqual(['response 200 DUS', 'bytes']);
  });

  it('download: HTTP 429 with Retry-After, no bytes counted', async () => {
    state.reject429['/__down'] = 1;
    let bytes = 0;
    const out = await transport.download(1000, never, (n) => {
      bytes += n;
    });
    expect(out).toMatchObject({ status: 429, retryAfterMs: 2000 });
    expect(bytes).toBe(0);
  });

  it('upload counts the bytes accepted by the socket and reuses the connection', async () => {
    let bytes = 0;
    const before = state.uploaded.length;
    for (let i = 0; i < 2; i++) {
      const out = await transport.upload(3_000_000, never, (n) => {
        bytes += n;
      });
      expect(out).toEqual({ status: 200, colo: 'DUS', retryAfterMs: null });
    }
    expect(bytes).toBe(6_000_000);
    expect(state.uploaded.slice(before)).toEqual([3_000_000, 3_000_000]);
  });

  it('upload: an early 429 (before the body is complete) resolves instead of hanging', async () => {
    state.reject429['/__up'] = 1;
    const out = await transport.upload(50_000_000, never, () => undefined);
    expect(out).toMatchObject({ status: 429, retryAfterMs: 2000 });
    // the connection is usable again for the next request
    expect((await transport.upload(100_000, never, () => undefined)).status).toBe(200);
  });

  it('aborts a running download and upload', async () => {
    state.downChunkPer10Ms = 16 * 1024; // ≈ 13 Mbit/s – far from finishing 25 MB
    try {
      const ac = new AbortController();
      let bytes = 0;
      const p = transport.download(25_000_000, ac.signal, (n) => {
        bytes += n;
      });
      setTimeout(() => ac.abort(), 80);
      const err = await p.then(
        () => null,
        (e: unknown) => e,
      );
      expect(isAbortError(err)).toBe(true);
      expect(bytes).toBeGreaterThan(0);
      expect(bytes).toBeLessThan(25_000_000);
    } finally {
      state.downChunkPer10Ms = 0;
    }
    const ac = new AbortController();
    const up = transport.upload(2_000_000_000, ac.signal, () => undefined);
    setTimeout(() => ac.abort(), 50);
    const err = await up.then(
      () => null,
      (e: unknown) => e,
    );
    expect(isAbortError(err)).toBe(true);
    const pre = new AbortController();
    pre.abort();
    await expect(transport.upload(10, pre.signal, () => undefined)).rejects.toMatchObject({ name: 'AbortError' });
  });
});
