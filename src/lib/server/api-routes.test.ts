// Route handlers of src/app/api/** called directly (connection() mocked – there is no Next
// request scope in vitest) against a seeded temp DB and a fake engine on an ephemeral port.
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as clientRoute from '../../app/api/client/route';
import * as configRoute from '../../app/api/config/route';
import * as controlRoute from '../../app/api/control/route';
import * as eventsRoute from '../../app/api/events/route';
import * as heatmapRoute from '../../app/api/heatmap/route';
import * as liveRoute from '../../app/api/live/route';
import * as metricsRoute from '../../app/api/metrics/route';
import * as pathRoute from '../../app/api/path/route';
import * as routerRoute from '../../app/api/router/route';
import * as samplesRoute from '../../app/api/samples/route';
import * as secondsRoute from '../../app/api/seconds/route';
import * as seriesRoute from '../../app/api/series/route';
import * as sessionsRoute from '../../app/api/sessions/route';
import * as speedtestRoute from '../../app/api/speedtests/[id]/route';
import * as speedtestsRoute from '../../app/api/speedtests/route';
import * as statsRoute from '../../app/api/stats/route';
import * as statusRoute from '../../app/api/status/route';
import * as traceroutesRoute from '../../app/api/traceroutes/route';
import type {
  ApiError,
  ConfigResponse,
  ControlApiResponse,
  EventsResponse,
  StatusResponse,
} from '../shared/api-types';
import type { NetEvent } from '../shared/types';
import { ROUTER_ADDRESS_ERROR } from './config-api';
import { TEST_END, TEST_FROM, type SeededDb, seedTempDb } from './test-seed';

vi.mock('next/server', async (importOriginal) => {
  const mod = await importOriginal<typeof import('next/server')>();
  return { ...mod, connection: async () => undefined };
});
vi.mock('./diagnosis/index', () => ({
  runDiagnosis: async (from: number, to: number) => ({
    from,
    to,
    generatedAt: 1,
    verdict: { severity: 'info', title: 'Test-Diagnose', text: '', primarySegment: null },
    findings: [],
    segments: [],
    seconds: null,
    gamingScore: null,
    dataQuality: { samples: 0, coveragePct: 0, gaps: 0, notes: [] },
  }),
}));

const hasDiagnosisModule = fs.existsSync(fileURLToPath(new URL('./diagnosis/index.ts', import.meta.url)));

let seeded: SeededDb;
let engine: http.Server;
let engineUrl = '';
let deadUrl = '';
const controlCalls: { action: string; params?: Record<string, unknown> }[] = [];

beforeAll(async () => {
  seeded = seedTempDb();
  engine = http.createServer((req, res) => {
    if (req.url === '/status') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return void res.end(JSON.stringify({ version: 'test', pid: 1, now: 2 }));
    }
    if (req.url === '/control') {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString('utf8')));
      req.on('end', () => {
        const parsed = JSON.parse(body) as { action: string; params?: Record<string, unknown> };
        controlCalls.push(parsed);
        const unknown = parsed.action === 'udpburst.run';
        res.writeHead(unknown ? 409 : 200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(unknown ? { ok: false, error: 'läuft bereits' } : { ok: true, result: { started: true } }));
      });
      return;
    }
    if (req.url === '/live') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      return void res.write('retry: 3000\n\ndata: {"type":"hello","data":{}}\n\n');
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => engine.listen(0, '127.0.0.1', resolve));
  engineUrl = `http://127.0.0.1:${(engine.address() as AddressInfo).port}`;
  const tmp = http.createServer();
  await new Promise<void>((resolve) => tmp.listen(0, '127.0.0.1', resolve));
  deadUrl = `http://127.0.0.1:${(tmp.address() as AddressInfo).port}`;
  await new Promise<void>((resolve) => tmp.close(() => resolve()));
});

afterAll(async () => {
  delete process.env.NETDIAG_ENGINE_URL;
  engine.closeAllConnections();
  await new Promise<void>((resolve) => engine.close(() => resolve()));
  seeded.cleanup();
});

beforeEach(() => {
  controlCalls.length = 0;
  process.env.NETDIAG_ENGINE_URL = deadUrl;
});

const useEngine = () => {
  process.env.NETDIAG_ENGINE_URL = engineUrl;
};
const get = (pathAndQuery: string) => new NextRequest(`http://127.0.0.1:3000${pathAndQuery}`);
const send = (method: 'POST' | 'PUT', pathName: string, body: unknown) =>
  new NextRequest(`http://127.0.0.1:3000${pathName}`, {
    method,
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });

async function expectJson<T>(res: Response, status = 200): Promise<T> {
  expect(res.status).toBe(status);
  expect(res.headers.get('cache-control')).toBe('no-store');
  return (await res.json()) as T;
}

async function expectError(res: Response, status: number, pattern: RegExp | string): Promise<void> {
  const body = await expectJson<ApiError>(res, status);
  expect(Object.keys(body)).toEqual(['error']);
  if (typeof pattern === 'string') expect(body.error).toContain(pattern);
  else expect(body.error).toMatch(pattern);
}

describe('/api/status', () => {
  it('reports an offline engine without failing', async () => {
    const body = await expectJson<StatusResponse>(await statusRoute.GET());
    expect(body.engineOnline).toBe(false);
    expect(body.engine).toBeNull();
    expect(body.engineError).toContain('Messdienst');
    expect(body.db.firstSampleTs).toBe(TEST_FROM);
    expect(body.config.router.hasPassword).toBe(false);
    expect(body.config.tariff.downMbps).toBe(500);
  });

  it('proxies the engine status', async () => {
    useEngine();
    const body = await expectJson<StatusResponse>(await statusRoute.GET());
    expect(body).toMatchObject({ engineOnline: true, engine: { version: 'test', pid: 1 }, engineError: null });
  });
});

describe('/api/live', () => {
  it('engine down → HTTP 200 event stream with retry + offline message, never 503', async () => {
    const res = await liveRoute.GET(get('/api/live'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    const text = await res.text();
    expect(text.startsWith('retry: 3000\n\n')).toBe(true);
    const msg = JSON.parse(text.split('data: ')[1]) as { type: string; data: { since: number; error: string } };
    expect(msg.type).toBe('offline');
    expect(msg.data.error).toContain('Messdienst');
    expect(msg.data.since).toBeGreaterThan(0);
  });

  it('engine up → proxies the stream until the client disconnects', async () => {
    useEngine();
    const client = new AbortController();
    const res = await liveRoute.GET(new NextRequest('http://127.0.0.1:3000/api/live', { signal: client.signal }));
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toContain('"type":"hello"');
    client.abort();
    expect((await reader.read()).done).toBe(true);
  });
});

describe('/api/control', () => {
  it('validates the request', async () => {
    await expectError(await controlRoute.POST(send('POST', '/api/control', { action: 'rm -rf' })), 400, /^Ungültige Anfrage – /);
    await expectError(await controlRoute.POST(send('POST', '/api/control', '{kaputt')), 400, 'Ungültiges JSON in der Anfrage.');
    await expectError(await controlRoute.POST(send('POST', '/api/control', '')), 400, 'Leere Anfrage');
    await expectError(await controlRoute.POST(send('POST', '/api/control', { action: 'speedtest.run', params: { x: 'y'.repeat(70_000) } })), 413, 'zu groß');
  });

  it('engine offline → 503 with ControlResponse', async () => {
    const body = await expectJson<ControlApiResponse>(await controlRoute.POST(send('POST', '/api/control', { action: 'speedtest.run' })), 503);
    expect(body.ok).toBe(false);
    expect(body.error).toContain('Messdienst');
  });

  it('forwards to the engine and passes its answer through', async () => {
    useEngine();
    const ok = await expectJson<ControlApiResponse>(await controlRoute.POST(send('POST', '/api/control', { action: 'traceroute.run', params: { family: 6 } })));
    expect(ok).toEqual({ ok: true, result: { started: true } });
    expect(controlCalls).toEqual([{ action: 'traceroute.run', params: { family: 6 } }]);
    const busy = await expectJson<ControlApiResponse>(await controlRoute.POST(send('POST', '/api/control', { action: 'udpburst.run' })), 409);
    expect(busy).toEqual({ ok: false, error: 'läuft bereits' });
  });
});

describe('/api/config', () => {
  it('GET returns the public config without the password', async () => {
    const body = await expectJson<ConfigResponse>(await configRoute.GET());
    expect(body.config.router).toMatchObject({ ip: '192.168.0.1', hasPassword: false });
    expect(JSON.stringify(body)).not.toMatch(/"(router)?password"/i);
  });

  it('rejects non-private router addresses and invalid settings in German', async () => {
    await expectError(await configRoute.PUT(send('PUT', '/api/config', { router: { ip: 'easy.box' } })), 400, ROUTER_ADDRESS_ERROR);
    await expectError(await configRoute.PUT(send('PUT', '/api/config', { router: { ip: '45.77.92.157' } })), 400, ROUTER_ADDRESS_ERROR);
    await expectError(await configRoute.PUT(send('PUT', '/api/config', { schedules: { speedtestEveryMin: 1 } })), 400, /^Ungültige Einstellungen: schedules\.speedtestEveryMin/);
  });

  it('saves even when the engine is offline and explains it in `warning`', async () => {
    const body = await expectJson<ConfigResponse>(await configRoute.PUT(send('PUT', '/api/config', { tariff: { name: 'Test 1000', downMbps: 1000, upMbps: 50 } })));
    expect(body.config.tariff).toEqual({ name: 'Test 1000', downMbps: 1000, upMbps: 50 });
    expect(body.warning).toContain('läuft gerade nicht');
    const again = await expectJson<ConfigResponse>(await configRoute.GET());
    expect(again.config.tariff.downMbps).toBe(1000);
  });

  it('hands a new router password to the engine (never stored by Next) and reloads the config', async () => {
    useEngine();
    const body = await expectJson<ConfigResponse>(await configRoute.PUT(send('PUT', '/api/config', { routerPassword: 'geheim', router: { loginEnabled: true, hasPassword: true } })));
    expect(body.warning).toBeNull();
    expect(controlCalls).toEqual([{ action: 'router.setPassword', params: { password: 'geheim' } }, { action: 'config.reload' }]);
    expect(body.config.router.loginEnabled).toBe(true);
    expect(body.config.router.hasPassword).toBe(false); // Next only reads the engine's DPAPI entry
  });
});

describe('measurement routes', () => {
  const range = `from=${TEST_FROM}&to=${TEST_END}`;

  it('/api/series', async () => {
    const body = await expectJson<{ source: string; series: Record<string, { ts: number[] }> }>(await seriesRoute.GET(get(`/api/series?targets=gw,cf4&${range}`)));
    expect(body.source).toBe('raw');
    expect(Object.keys(body.series)).toEqual(['gw', 'cf4']);
    const all = await expectJson<{ series: Record<string, unknown> }>(await seriesRoute.GET(get(`/api/series?${range}`)));
    expect(Object.keys(all.series)).toContain('aws-irl'); // default: all enabled targets
    await expectError(await seriesRoute.GET(get('/api/series?targets=GW')), 400, 'Ziel');
    await expectError(await seriesRoute.GET(get(`/api/series?from=${TEST_END}&to=${TEST_FROM}`)), 400, '„from“ muss vor „to“');
    await expectError(await seriesRoute.GET(get('/api/series?from=0&to=99999999999')), 400, 'Zeitraum zu groß');
  });

  it('/api/samples, /api/stats, /api/seconds, /api/heatmap', async () => {
    const s = await expectJson<{ ts: number[]; truncated: boolean }>(await samplesRoute.GET(get(`/api/samples?target=cf4&${range}&limit=10`)));
    expect(s.ts).toHaveLength(10);
    expect(s.truncated).toBe(true);
    await expectError(await samplesRoute.GET(get('/api/samples')), 400, 'target');
    const st = await expectJson<{ excludeSpeedtests: boolean; stats: { targetId: string }[] }>(await statsRoute.GET(get(`/api/stats?${range}&targets=gw,isp6`)));
    expect(st.excludeSpeedtests).toBe(true);
    expect(st.stats.map((x) => x.targetId)).toEqual(['gw', 'isp6']);
    const st2 = await expectJson<{ excludeSpeedtests: boolean }>(await statsRoute.GET(get(`/api/stats?${range}&excludeSpeedtests=0`)));
    expect(st2.excludeSpeedtests).toBe(false);
    const sec = await expectJson<{ total: { covered: number } }>(await secondsRoute.GET(get(`/api/seconds?${range}`)));
    expect(sec.total.covered).toBeGreaterThan(9000);
    await expectError(await secondsRoute.GET(get('/api/seconds?step=1000')), 400, 'step');
    const hm = await expectJson<{ days: string[]; values: unknown[][]; coverage: unknown[][] }>(await heatmapRoute.GET(get('/api/heatmap?target=cf4&metric=loss&days=3')));
    expect(hm.days).toHaveLength(3);
    expect(hm.coverage).toHaveLength(3);
    await expectError(await heatmapRoute.GET(get('/api/heatmap?target=cf4&metric=median')), 400, 'metric');
  });

  it('/api/events GET + POST note', async () => {
    const created = await expectJson<NetEvent>(await eventsRoute.POST(send('POST', '/api/events', { title: '  Lag jetzt  ', ts: TEST_END - 1000, details: { spiel: 'cs2' } })), 201);
    expect(created).toMatchObject({ type: 'note', title: 'Lag jetzt', source: 'user', ts: TEST_END - 1000 });
    await expectError(await eventsRoute.POST(send('POST', '/api/events', { title: '' })), 400, 'Titel fehlt');
    const list = await expectJson<EventsResponse>(await eventsRoute.GET(get(`/api/events?${range}&types=note,outage&limit=50`)));
    expect(list.events.map((e) => e.type).sort()).toEqual(['note', 'note', 'outage', 'outage']);
    expect(list.events[0].id).toBe(created.id);
    await expectError(await eventsRoute.GET(get('/api/events?types=bogus')), 400, 'Ereignistyp');
    await expectError(await eventsRoute.GET(get('/api/events?severity=fatal')), 400, 'Schweregrad');
  });

  it('/api/metrics', async () => {
    const m = await expectJson<{ series: Record<string, { ts: number[] }> }>(await metricsRoute.GET(get(`/api/metrics?keys=router.http_ms,docsis.ds.snr_min&${range}`)));
    expect(m.series['router.http_ms'].ts.length).toBeGreaterThan(100);
    await expectError(await metricsRoute.GET(get('/api/metrics')), 400, '„keys“ fehlt');
  });
});

describe('detail routes', () => {
  it('/api/speedtests and /api/speedtests/[id]', async () => {
    const list = await expectJson<{ items: { id: number; series: unknown[] }[] }>(await speedtestsRoute.GET(get('/api/speedtests')));
    expect(list.items).toHaveLength(6);
    const id = list.items[0].id;
    const detail = await expectJson<{ id: number; series: unknown[] }>(await speedtestRoute.GET(get(`/api/speedtests/${id}`), { params: Promise.resolve({ id: String(id) }) }));
    expect(detail.series.length).toBeGreaterThan(100);
    await expectError(await speedtestRoute.GET(get('/api/speedtests/999999'), { params: Promise.resolve({ id: '999999' }) }), 404, 'nicht gefunden');
    await expectError(await speedtestRoute.GET(get('/api/speedtests/abc'), { params: Promise.resolve({ id: 'abc' }) }), 400, 'id');
  });

  it('/api/traceroutes, /api/path, /api/router, /api/client, /api/sessions', async () => {
    const tr = await expectJson<{ items: { family: number }[] }>(await traceroutesRoute.GET(get('/api/traceroutes?family=6&limit=2')));
    expect(tr.items.map((t) => t.family)).toEqual([6, 6]);
    await expectError(await traceroutesRoute.GET(get('/api/traceroutes?family=5')), 400, 'family');
    const p = await expectJson<{ mtu: unknown[]; nat: unknown[] }>(await pathRoute.GET());
    expect(p.mtu).toHaveLength(2);
    const r = await expectJson<{ status: { model: string } | null; log: unknown[] }>(await routerRoute.GET(get(`/api/router?from=${TEST_FROM}&to=${TEST_END}`)));
    expect(r.status?.model).toContain('TG6442');
    const c = await expectJson<{ linkSummary: { runtimeDrops24h: number } }>(await clientRoute.GET(get(`/api/client?from=${TEST_FROM}&to=${TEST_END}`)));
    expect(c.linkSummary.runtimeDrops24h).toBe(4);
    const s = await expectJson<{ items: unknown[]; active: { status: string } | null }>(await sessionsRoute.GET(get('/api/sessions')));
    expect(s.items).toHaveLength(2);
    expect(s.active?.status).toBe('running');
  });
});

describe.skipIf(!hasDiagnosisModule)('routes using the diagnosis (src/lib/server/diagnosis/index.ts)', () => {
  it('/api/diagnosis', async () => {
    const route = await import('../../app/api/diagnosis/route');
    const body = await expectJson<{ from: number; to: number; verdict: { title: string } }>(await route.GET(get(`/api/diagnosis?from=${TEST_FROM}&to=${TEST_END}`)));
    expect(body).toMatchObject({ from: TEST_FROM, to: TEST_END, verdict: { title: 'Test-Diagnose' } });
    await expectError(await route.GET(get('/api/diagnosis?from=abc')), 400, 'from');
  });

  it('/api/export', async () => {
    const route = await import('../../app/api/export/route');
    const res = await route.GET(get(`/api/export?kind=report&from=${TEST_FROM}&to=${TEST_END}`));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="netzdiagnose-bericht-\d{8}-\d{4}\.json"$/);
    const report = (await res.json()) as { diagnosis: { verdict: { title: string } } };
    expect(report.diagnosis.verdict.title).toBe('Test-Diagnose');
    const csv = await route.GET(get(`/api/export?kind=samples&format=csv&targets=gw&from=${TEST_END - 60_000}&to=${TEST_END}`));
    expect(csv.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    await expectError(await route.GET(get('/api/export?kind=passwords')), 400, 'kind');
    await expectError(await route.GET(get('/api/export?kind=samples&from=0&to=99999999999')), 400, 'Zeitraum zu groß');
  });
});
