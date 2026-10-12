import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { ControlRequest, EngineStatus, LiveMessage } from '../src/lib/shared/types';
import { createBus } from './core/bus';
import { LiveHub } from './core/live';
import { silentLogger } from './core/logger';
import { createControlServer, isAllowedRequest, MAX_BODY_BYTES, PortInUseError, type ControlServer } from './server';

const status: EngineStatus = {
  version: '0.1.0', pid: process.pid, startedAt: 1, now: 2, session: null, probes: [], modules: [],
  dynamicHosts: { gateway: '192.168.0.1', isp4: null, isp6: null, aftr: null, router6: null },
  client: null, speedtest: null, dbPath: 'test.db', dbSizeBytes: 0,
};

const servers: ControlServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

async function start(attach = true) {
  const log = silentLogger();
  const bus = createBus(log);
  const srv = createControlServer({ version: '0.1.0', log });
  servers.push(srv);
  const port = await srv.listen(0, '127.0.0.1');
  const received: ControlRequest[] = [];
  const live = new LiveHub({ bus, log, status: () => status });
  if (attach) {
    srv.attach({
      status: () => status,
      control: async (req) => {
        received.push(req);
        return req.action === 'session.stop' ? { ok: true, result: null } : { ok: false, error: 'Modul „mtu“ ist nicht verfügbar.' };
      },
      live,
    });
  }
  return { port, bus, received, srv, live, base: `http://127.0.0.1:${port}` };
}

describe('control server', () => {
  it('serves /health and /status', async () => {
    const { base } = await start();
    const health = await fetch(`${base}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true, version: '0.1.0', pid: process.pid });
    const st = await fetch(`${base}/status`);
    expect(st.headers.get('content-type')).toContain('application/json');
    expect(await st.json()).toEqual(status);
  });

  it('answers 503 before the engine is attached (health works)', async () => {
    const { base } = await start(false);
    expect((await fetch(`${base}/health`)).status).toBe(200);
    expect((await fetch(`${base}/status`)).status).toBe(503);
    const res = await fetch(`${base}/control`, { method: 'POST', body: JSON.stringify({ action: 'session.stop' }) });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(false);
  });

  it('dispatches POST /control and validates the body', async () => {
    const { base, received } = await start();
    const ok = await fetch(`${base}/control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'session.stop' }) });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, result: null });
    const failed = await fetch(`${base}/control`, { method: 'POST', body: JSON.stringify({ action: 'mtu.run' }) });
    expect(failed.status).toBe(200);
    expect(await failed.json()).toEqual({ ok: false, error: 'Modul „mtu“ ist nicht verfügbar.' });
    expect(received.map((r) => r.action)).toEqual(['session.stop', 'mtu.run']);

    const badJson = await fetch(`${base}/control`, { method: 'POST', body: '{kaputt' });
    expect(badJson.status).toBe(400);
    expect(await badJson.json()).toEqual({ ok: false, error: 'Ungültiges JSON' });
    const unknown = await fetch(`${base}/control`, { method: 'POST', body: JSON.stringify({ action: 'format.c' }) });
    expect(unknown.status).toBe(400);
    expect(((await unknown.json()) as { error: string }).error).toBe('Unbekannte Aktion: format.c');
    const tooBig = await fetch(`${base}/control`, { method: 'POST', body: JSON.stringify({ action: 'session.stop', params: { x: 'x'.repeat(MAX_BODY_BYTES) } }) });
    expect(tooBig.status).toBe(413);
    expect(received).toHaveLength(2);
  });

  it('returns 404 / 405 for unknown paths and wrong methods', async () => {
    const { base } = await start();
    expect((await fetch(`${base}/nope`)).status).toBe(404);
    const wrong = await fetch(`${base}/control`);
    expect(wrong.status).toBe(405);
    expect(wrong.headers.get('allow')).toBe('POST');
    expect((await fetch(`${base}/status`, { method: 'POST' })).status).toBe(405);
  });

  it('rejects cross-site browser requests and foreign Host headers', async () => {
    const { base } = await start();
    const res = await fetch(`${base}/control`, { method: 'POST', headers: { origin: 'https://evil.example' }, body: JSON.stringify({ action: 'session.stop' }) });
    expect(res.status).toBe(403);
    expect(isAllowedRequest('127.0.0.1:3901', undefined)).toBe(true);
    expect(isAllowedRequest('localhost:3901', 'http://localhost:3000')).toBe(true);
    expect(isAllowedRequest('[::1]:3901', 'http://127.0.0.1:3000')).toBe(true);
    expect(isAllowedRequest('rebind.evil.example:3901', undefined)).toBe(false);
    expect(isAllowedRequest('127.0.0.1:3901', 'null')).toBe(false);
  });

  it('streams /live: retry, hello, immediate session message, cleanup on close', async () => {
    const { port, bus, live } = await start();
    const chunks: string[] = [];
    await new Promise<void>((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port, path: '/live' }, (res) => {
        expect(res.statusCode).toBe(200);
        expect(res.headers['content-type']).toBe('text/event-stream; charset=utf-8');
        expect(res.headers['cache-control']).toBe('no-cache, no-transform');
        res.setEncoding('utf8');
        res.on('data', (c: string) => {
          chunks.push(c);
          const text = chunks.join('');
          if (text.includes('"type":"hello"') && !text.includes('"type":"session"')) bus.emit('session', null);
          if (text.includes('"type":"session"')) {
            req.destroy();
            resolve();
          }
        });
      });
      req.on('error', (err) => {
        if (chunks.join('').includes('"type":"session"')) resolve();
        else reject(err);
      });
    });
    const text = chunks.join('');
    expect(text.startsWith('retry: 3000\n\n')).toBe(true);
    const msgs = text
      .split('\n\n')
      .filter((b) => b.startsWith('data: '))
      .map((b) => JSON.parse(b.slice(6)) as LiveMessage);
    expect(msgs.map((m) => m.type)).toEqual(['hello', 'session']);
    // the server notices the closed connection and removes the client
    for (let i = 0; i < 50 && live.size > 0; i++) await new Promise((r) => setTimeout(r, 20));
    expect(live.size).toBe(0);
  });

  it('fails with PortInUseError when the port is taken', async () => {
    const { port } = await start();
    const second = createControlServer({ version: '0.1.0', log: silentLogger() });
    servers.push(second);
    await expect(second.listen(port, '127.0.0.1')).rejects.toBeInstanceOf(PortInUseError);
    await expect(second.listen(port, '127.0.0.1')).rejects.toThrow(`Engine läuft bereits (Port ${port} belegt)`);
  });
});
