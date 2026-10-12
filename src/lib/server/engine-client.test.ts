import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { describeEngineError, engineOfflineSince, getEngineStatus, openEngineLive, sendEngineControl } from './engine-client';

/** Minimal stand-in for engine/server.ts (127.0.0.1, ephemeral port). */
let server: http.Server;
let base = '';
let liveClosed = 0;
let mode: 'ok' | 'slow' | 'error' = 'ok';

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/status') {
      if (mode === 'slow') return void setTimeout(() => res.end('{}'), 1500);
      if (mode === 'error') {
        res.writeHead(500, { 'content-type': 'application/json' });
        return void res.end(JSON.stringify({ error: 'kaputt' }));
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      return void res.end(JSON.stringify({ version: '0.1.0', pid: 42, now: 1 }));
    }
    if (req.url === '/control' && req.method === 'POST') {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString('utf8')));
      req.on('end', () => {
        const parsed = JSON.parse(body) as { action: string; params?: unknown };
        if (parsed.action === 'unknown.action') {
          res.writeHead(400, { 'content-type': 'application/json' });
          return void res.end(JSON.stringify({ ok: false, error: 'Unbekannte Aktion' }));
        }
        if (parsed.action === 'garbage') {
          res.writeHead(502);
          return void res.end('<html>');
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, result: { echo: parsed } }));
      });
      return;
    }
    if (req.url === '/live') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('retry: 3000\n\ndata: {"type":"hello","data":{}}\n\n');
      req.on('close', () => liveClosed++);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  delete process.env.NETDIAG_ENGINE_URL;
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  mode = 'ok';
  process.env.NETDIAG_ENGINE_URL = base;
});

/** a port nobody listens on */
async function deadUrl(): Promise<string> {
  const s = http.createServer();
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((resolve) => s.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}

describe('getEngineStatus', () => {
  it('returns the engine status', async () => {
    const res = await getEngineStatus();
    expect(res).toEqual({ ok: true, status: 200, data: { version: '0.1.0', pid: 42, now: 1 } });
    expect(engineOfflineSince()).toBeNull();
  });

  it('reports HTTP errors without marking the engine offline', async () => {
    mode = 'error';
    const res = await getEngineStatus();
    expect(res).toMatchObject({ ok: false, status: 500, offline: false });
    if (!res.ok) expect(res.error).toBe('Der Messdienst antwortete mit HTTP 500: kaputt.');
  });

  it('times out with a German message', async () => {
    mode = 'slow';
    const res = await getEngineStatus(200);
    expect(res).toMatchObject({ ok: false, offline: true, status: null });
    if (!res.ok) expect(res.error).toMatch(/^Zeitüberschreitung: Der Messdienst \(Engine\) hat nicht innerhalb von 0,2 s|^Zeitüberschreitung/);
  });

  it('detects a stopped engine (connection refused) and remembers since when', async () => {
    await getEngineStatus(); // success resets "offline since"
    process.env.NETDIAG_ENGINE_URL = await deadUrl();
    const before = Date.now();
    const res = await getEngineStatus();
    expect(res).toMatchObject({ ok: false, offline: true });
    if (!res.ok) expect(res.error).toContain('läuft nicht oder ist nicht erreichbar');
    expect(engineOfflineSince()).toBeGreaterThanOrEqual(before);
    process.env.NETDIAG_ENGINE_URL = base;
    await getEngineStatus();
    expect(engineOfflineSince()).toBeNull();
  });
});

describe('sendEngineControl', () => {
  it('forwards the request and returns the ControlResponse', async () => {
    const res = await sendEngineControl({ action: 'traceroute.run', params: { family: 6 } });
    expect(res).toEqual({ ok: true, status: 200, data: { ok: true, result: { echo: { action: 'traceroute.run', params: { family: 6 } } } } });
  });

  it('passes engine-side errors through with their status', async () => {
    const res = await sendEngineControl({ action: 'unknown.action' as never });
    expect(res).toEqual({ ok: true, status: 400, data: { ok: false, error: 'Unbekannte Aktion' } });
  });

  it('flags non-JSON error answers and offline engines', async () => {
    const bad = await sendEngineControl({ action: 'garbage' as never });
    expect(bad).toMatchObject({ ok: false, status: 502, offline: false });
    process.env.NETDIAG_ENGINE_URL = await deadUrl();
    const off = await sendEngineControl({ action: 'speedtest.run' });
    expect(off).toMatchObject({ ok: false, status: null, offline: true });
  });
});

describe('openEngineLive', () => {
  it('opens the stream and aborting closes the engine connection', async () => {
    const client = new AbortController();
    const live = await openEngineLive(client.signal);
    expect(live.ok).toBe(true);
    if (!live.ok) return;
    const reader = live.body.getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toContain('"type":"hello"');
    const closedBefore = liveClosed;
    client.abort();
    await reader.cancel().catch(() => undefined);
    for (let i = 0; i < 50 && liveClosed === closedBefore; i++) await new Promise((r) => setTimeout(r, 20));
    expect(liveClosed).toBe(closedBefore + 1);
  });

  it('reports an offline engine', async () => {
    process.env.NETDIAG_ENGINE_URL = await deadUrl();
    const live = await openEngineLive(new AbortController().signal);
    expect(live.ok).toBe(false);
    if (!live.ok) {
      expect(live.error).toContain('Messdienst');
      expect(live.since).toBeGreaterThan(0);
    }
  });
});

describe('describeEngineError', () => {
  it('maps error kinds to German texts', () => {
    expect(describeEngineError(Object.assign(new Error('x'), { name: 'AbortError' }), 1000)).toBe('Anfrage an den Messdienst wurde abgebrochen.');
    expect(describeEngineError(new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } }), 1000)).toContain('läuft nicht');
    expect(describeEngineError(new Error('boom'), 1000)).toBe('Messdienst nicht erreichbar: boom');
  });
});
