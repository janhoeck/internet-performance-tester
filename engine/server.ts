// Control API (ARCHITECTURE §4.4): node:http on 127.0.0.1 only.
//   GET /health → { ok, version, pid }      GET /status → EngineStatus
//   POST /control (JSON ControlRequest, ≤ 64 KB) → ControlResponse
//   GET /live → SSE stream of LiveMessages
import http from 'node:http';
import { ENGINE_PORT } from '../src/lib/shared/db/path';
import type { ControlRequest, ControlResponse, EngineStatus } from '../src/lib/shared/types';
import { parseControlRequest } from './core/control';
import { type LiveClient, type LiveHub, SSE_HEADERS } from './core/live';
import type { Logger } from './core/types';
import { errorCode, errorMessage } from './core/util';

export const ENGINE_HOST = '127.0.0.1';
export const MAX_BODY_BYTES = 64 * 1024;
/** a live client that cannot keep up (buffered bytes) is disconnected; EventSource reconnects */
const MAX_SSE_BUFFER_BYTES = 8 * 1024 * 1024;

export interface EngineApi {
  status(): EngineStatus;
  control(req: ControlRequest): Promise<ControlResponse>;
  live: LiveHub;
}

export class PortInUseError extends Error {
  override name = 'PortInUseError';
  constructor(readonly port: number) {
    super(`Engine läuft bereits (Port ${port} belegt)`);
  }
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;
const LOOPBACK_ORIGIN = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;

/**
 * Protection against DNS rebinding and cross-site requests from web pages: the Host header must
 * be a loopback name and a browser Origin (if any) must be a loopback origin. Server-side
 * callers (the Next proxy, curl) send no Origin.
 */
export function isAllowedRequest(host: string | undefined, origin: string | undefined): boolean {
  if (host !== undefined && host !== '' && !LOOPBACK_HOST.test(host)) return false;
  if (origin !== undefined && !LOOPBACK_ORIGIN.test(origin)) return false;
  return true;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': String(Buffer.byteLength(text)),
    ...extraHeaders,
  });
  res.end(text);
}

/** Reads the request body as UTF-8 with a size limit (413 when exceeded). */
export function readBody(req: http.IncomingMessage, limit = MAX_BODY_BYTES): Promise<string> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      req.resume();
      reject(new HttpError(413, `Anfrage zu groß (maximal ${limit / 1024} KB)`));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        tooLarge = true;
        if (size > limit * 16) req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) reject(new HttpError(413, `Anfrage zu groß (maximal ${limit / 1024} KB)`));
      else resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

export interface ControlServer {
  readonly server: http.Server;
  /** binds the port; rejects with PortInUseError on EADDRINUSE. Resolves with the bound port. */
  listen(port?: number, host?: string): Promise<number>;
  /** makes /status, /control and /live available (503 before) */
  attach(api: EngineApi): void;
  close(): Promise<void>;
}

export function createControlServer(opts: { version: string; log: Logger }): ControlServer {
  const { log } = opts;
  let api: EngineApi | null = null;

  const notReady = (res: http.ServerResponse) =>
    sendJson(res, 503, { ok: false, error: 'Engine startet noch – bitte gleich erneut versuchen.' }, { 'Retry-After': '2' });

  const methodNotAllowed = (res: http.ServerResponse, allow: string) =>
    sendJson(res, 405, { ok: false, error: 'Methode nicht erlaubt' }, { Allow: allow });

  const handleControl = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    let body: string;
    try {
      body = await readBody(req);
    } catch (err) {
      if (err instanceof HttpError) return sendJson(res, err.status, { ok: false, error: err.message });
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = body.trim() === '' ? undefined : JSON.parse(body);
    } catch {
      return sendJson(res, 400, { ok: false, error: 'Ungültiges JSON' });
    }
    let request: ControlRequest;
    try {
      request = parseControlRequest(parsed);
    } catch (err) {
      return sendJson(res, 400, { ok: false, error: errorMessage(err) });
    }
    if (!api) return notReady(res);
    log.info(`Steuerbefehl: ${request.action}`); // never log params (router password!)
    const response = await api.control(request);
    if (!response.ok) log.warn(`Steuerbefehl ${request.action} abgelehnt: ${response.error ?? 'unbekannter Fehler'}`);
    sendJson(res, 200, response);
  };

  const handleLive = (req: http.IncomingMessage, res: http.ServerResponse, hub: LiveHub) => {
    req.socket.setNoDelay(true);
    req.socket.setKeepAlive(true, 30_000);
    res.writeHead(200, SSE_HEADERS);
    const client: LiveClient = {
      write: (chunk) => {
        if (res.writableEnded || res.destroyed) throw new Error('Verbindung geschlossen');
        res.write(chunk);
        if (res.writableLength > MAX_SSE_BUFFER_BYTES) {
          res.destroy();
          throw new Error('Live-Client zu langsam');
        }
      },
      close: () => {
        if (!res.writableEnded) res.end();
      },
    };
    const remove = hub.add(client);
    res.on('close', remove);
  };

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
    if (!isAllowedRequest(req.headers.host, origin)) {
      return sendJson(res, 403, { ok: false, error: 'Zugriff nur lokal erlaubt' });
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const method = req.method ?? 'GET';
    const isGet = method === 'GET' || method === 'HEAD';
    switch (path) {
      case '/health':
        if (!isGet) return methodNotAllowed(res, 'GET');
        return sendJson(res, 200, { ok: true, version: opts.version, pid: process.pid });
      case '/status':
        if (!isGet) return methodNotAllowed(res, 'GET');
        if (!api) return notReady(res);
        return sendJson(res, 200, api.status());
      case '/control':
        if (method !== 'POST') return methodNotAllowed(res, 'POST');
        return handleControl(req, res);
      case '/live':
        if (method !== 'GET') return methodNotAllowed(res, 'GET');
        if (!api) return notReady(res);
        return handleLive(req, res, api.live);
      default:
        return sendJson(res, 404, { ok: false, error: 'Nicht gefunden' });
    }
  };

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      log.error(`Fehler bei ${req.method ?? '?'} ${req.url ?? '?'}: ${errorMessage(err)}`, err instanceof Error ? err : undefined);
      try {
        sendJson(res, 500, { ok: false, error: `Interner Fehler: ${errorMessage(err)}` });
      } catch {
        res.destroy();
      }
    });
  });
  server.on('clientError', (_err, socket) => {
    try {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    } catch {
      socket.destroy();
    }
  });

  return {
    server,
    listen: (port = ENGINE_PORT, host = ENGINE_HOST) =>
      new Promise<number>((resolve, reject) => {
        const onError = (err: Error) => {
          server.off('listening', onListening);
          reject(errorCode(err) === 'EADDRINUSE' ? new PortInUseError(port) : err);
        };
        const onListening = () => {
          server.off('error', onError);
          server.on('error', (err) => log.error(`Steuer-Server: ${errorMessage(err)}`));
          const addr = server.address();
          resolve(typeof addr === 'object' && addr !== null ? addr.port : port);
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, host);
      }),
    attach: (a) => {
      api = a;
    },
    close: () =>
      new Promise<void>((resolve) => {
        api?.live.close();
        if (!server.listening) {
          resolve();
          return;
        }
        const timer = setTimeout(resolve, 2000);
        timer.unref();
        server.close(() => {
          clearTimeout(timer);
          resolve();
        });
        server.closeAllConnections();
      }),
  };
}
