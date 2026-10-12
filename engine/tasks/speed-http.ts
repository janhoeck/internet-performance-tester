// Cloudflare speed test transport (docs/research/methodology.md §10):
//  download: fetch GET https://speed.cloudflare.com/__down?bytes=N (streamed, accept-encoding identity)
//  upload:   node:https POST https://speed.cloudflare.com/__up with a fixed-size body written in
//            64 KiB chunks with backpressure; progress = bytes accepted by the socket (write callbacks)
import { randomInt } from 'node:crypto';
import http, { type ClientRequest, type IncomingMessage, type RequestOptions } from 'node:http';
import https from 'node:https';

export const CF_HOST = 'speed.cloudflare.com';
export const CF_BASE = `https://${CF_HOST}`;
/** bytes per download request (re-issued until the phase ends) */
export const DOWNLOAD_REQUEST_BYTES = 25_000_000;
/** body size per upload request */
export const UPLOAD_REQUEST_BYTES = 10_000_000;
export const DEFAULT_RETRY_AFTER_MS = 5000;
export const MAX_RETRY_AFTER_MS = 60_000;
const PREFLIGHT_TIMEOUT_MS = 10_000;
const UPLOAD_IDLE_TIMEOUT_MS = 15_000;
const CHUNK = Buffer.alloc(64 * 1024, 0x30); // '0' like the official client

export interface StreamOutcome {
  /** HTTP status (0 = no response) */
  status: number;
  /** Cloudflare PoP (IATA code) from the response headers */
  colo: string | null;
  /** parsed Retry-After for HTTP 429, else null */
  retryAfterMs: number | null;
}

export interface PreflightInfo extends StreamOutcome {
  /** IP family the test traffic uses (from cf-meta-ip) */
  family: 4 | 6 | null;
}

/** Load generator used by the speed test (injectable for tests). Created per test run. */
export interface LoadTransport {
  /** tiny request: reachability, rate limiting (429) and PoP before the line is loaded */
  preflight(signal: AbortSignal): Promise<PreflightInfo>;
  /**
   * One download request: `onResponse` as soon as the response headers arrived (a 25 MB request
   * may outlast the whole phase on slow lines), `onBytes` per received body chunk (only for
   * HTTP 200); resolves with the same outcome when the body is complete.
   */
  download(
    bytes: number,
    signal: AbortSignal,
    onBytes: (n: number) => void,
    onResponse?: (o: StreamOutcome) => void,
  ): Promise<StreamOutcome>;
  /** one upload request; `onBytes` per chunk accepted by the socket; resolves on the response */
  upload(bytes: number, signal: AbortSignal, onBytes: (n: number) => void): Promise<StreamOutcome>;
  /** closes kept-alive sockets */
  dispose(): void;
}

/** Retry-After (seconds or HTTP date) → ms, default 5 s, clamped to 0…60 s. */
export function parseRetryAfter(value: string | null | undefined, now: number = Date.now()): number {
  const clamp = (ms: number) => Math.min(MAX_RETRY_AFTER_MS, Math.max(0, Math.round(ms)));
  if (value === null || value === undefined) return DEFAULT_RETRY_AFTER_MS;
  const v = value.trim();
  if (/^\d+(\.\d+)?$/.test(v)) return clamp(Number(v) * 1000);
  const date = Date.parse(v);
  if (Number.isFinite(date)) return clamp(date - now);
  return DEFAULT_RETRY_AFTER_MS;
}

/** PoP code from `colo` (current), `cf-meta-colo` (legacy/upload) or the CF-RAY suffix. */
export function coloFromHeaders(get: (name: string) => string | null | undefined): string | null {
  for (const name of ['colo', 'cf-meta-colo']) {
    const v = get(name)?.trim();
    if (v && /^[A-Za-z]{3}$/.test(v)) return v.toUpperCase();
  }
  const ray = get('cf-ray')?.trim();
  const m = ray ? /-([A-Za-z]{3})$/.exec(ray) : null;
  return m ? m[1].toUpperCase() : null;
}

/** e.g. 'Cloudflare DUS' */
export function serverLabel(colo: string | null | undefined): string | null {
  return colo ? `Cloudflare ${colo}` : null;
}

export function familyFromIp(ip: string | null | undefined): 4 | 6 | null {
  if (!ip) return null;
  if (ip.includes(':')) return 6;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip.trim())) return 4;
  return null;
}

/** Short technical reason of a network error (undici hides the code in `cause`). */
export function errorText(err: unknown): string {
  if (err instanceof Error) {
    const cause: unknown = 'cause' in err ? err.cause : undefined;
    if (cause && typeof cause === 'object' && 'code' in cause && typeof cause.code === 'string') return cause.code;
    if ('code' in err && typeof err.code === 'string') return err.code;
    return err.message;
  }
  return String(err);
}

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
}

function abortError(): Error {
  const e = new Error('Abgebrochen');
  e.name = 'AbortError';
  return e;
}

function headerValue(res: IncomingMessage, name: string): string | null {
  const v = res.headers[name];
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}

function newMeasId(): string {
  // 16 digits like the official client (randomInt is limited to < 2^48 per call)
  return `${randomInt(10_000_000, 100_000_000)}${randomInt(10_000_000, 100_000_000)}`;
}

function waitDrain(req: ClientRequest): Promise<void> {
  return new Promise<void>((resolve) => {
    if (req.destroyed) {
      resolve();
      return;
    }
    const done = () => {
      req.off('drain', done);
      req.off('close', done);
      resolve();
    };
    req.on('drain', done);
    req.on('close', done);
  });
}

/** Writes `total` bytes in 64 KiB chunks honouring backpressure; counts bytes once the socket took them. */
async function pumpBody(
  req: ClientRequest,
  total: number,
  onBytes: (n: number) => void,
  stop: () => boolean,
): Promise<void> {
  let queued = 0;
  while (queued < total) {
    if (stop() || req.destroyed) return;
    const n = Math.min(CHUNK.length, total - queued);
    const chunk = n === CHUNK.length ? CHUNK : CHUNK.subarray(0, n);
    queued += n;
    const ok = req.write(chunk, (err) => {
      if (!err) onBytes(n);
    });
    if (!ok) await waitDrain(req);
  }
  if (!req.destroyed && !stop()) req.end();
}

/** Where the load requests go (default speed.cloudflare.com; tests use a local http server). */
interface Endpoint {
  /** origin + path prefix without trailing slash, e.g. 'https://speed.cloudflare.com' */
  base: string;
  secure: boolean;
  hostname: string;
  port: number | undefined;
  pathPrefix: string;
}

export function parseEndpoint(baseUrl: string): Endpoint {
  const u = new URL(baseUrl);
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error(`Nicht unterstütztes Protokoll: ${u.protocol}`);
  const pathPrefix = u.pathname.replace(/\/+$/, '');
  return {
    base: `${u.origin}${pathPrefix}`,
    secure: u.protocol === 'https:',
    hostname: u.hostname.replace(/^\[|\]$/g, ''),
    port: u.port ? Number(u.port) : undefined,
    pathPrefix,
  };
}

function postUpload(
  ep: Endpoint,
  agent: http.Agent,
  measId: string,
  bytes: number,
  signal: AbortSignal,
  onBytes: (n: number) => void,
): Promise<StreamOutcome> {
  return new Promise<StreamOutcome>((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    let settled = false;
    let responded = false;
    const options: RequestOptions = {
      hostname: ep.hostname,
      port: ep.port,
      path: `${ep.pathPrefix}/__up?measId=${measId}`,
      method: 'POST',
      agent,
      timeout: UPLOAD_IDLE_TIMEOUT_MS,
      headers: { 'content-type': 'text/plain;charset=UTF-8', 'content-length': String(bytes) },
    };
    const req = ep.secure ? https.request(options) : http.request(options);
    const onAbort = () => req.destroy(abortError());
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      fn();
    };
    signal.addEventListener('abort', onAbort, { once: true });
    req.on('response', (res) => {
      responded = true;
      const status = res.statusCode ?? 0;
      const outcome: StreamOutcome = {
        status,
        colo: coloFromHeaders((n) => headerValue(res, n)),
        retryAfterMs: status === 429 ? parseRetryAfter(headerValue(res, 'retry-after')) : null,
      };
      const done = () =>
        finish(() => {
          // early answer (e.g. 429) before the body was sent completely: the socket cannot be reused
          if (!req.writableFinished) req.destroy();
          resolve(outcome);
        });
      res.on('end', done);
      res.on('close', done);
      res.on('error', done);
      res.resume();
    });
    req.on('timeout', () => req.destroy(new Error('Zeitüberschreitung beim Upload')));
    req.on('error', (err) => finish(() => reject(signal.aborted ? abortError() : err)));
    req.on('close', () => {
      if (!responded) finish(() => reject(signal.aborted ? abortError() : new Error('Verbindung vorzeitig geschlossen')));
    });
    void pumpBody(req, bytes, onBytes, () => responded || settled).catch((err: unknown) => {
      req.destroy(err instanceof Error ? err : new Error(String(err)));
    });
  });
}

export interface CloudflareTransportOptions {
  /** server base URL (default https://speed.cloudflare.com; tests point it at a local http server) */
  baseUrl?: string;
}

/** Real transport against speed.cloudflare.com (download: fetch streams, upload: node:https). */
export function createCloudflareTransport(opts: CloudflareTransportOptions = {}): LoadTransport {
  const ep = parseEndpoint(opts.baseUrl ?? CF_BASE);
  const measId = newMeasId();
  const agentOptions = { keepAlive: true, maxSockets: 16 };
  const agent = ep.secure ? new https.Agent(agentOptions) : new http.Agent(agentOptions);
  return {
    async preflight(signal) {
      const res = await fetch(`${ep.base}/__down?bytes=0&measId=${measId}`, {
        headers: { 'accept-encoding': 'identity' },
        signal: AbortSignal.any([signal, AbortSignal.timeout(PREFLIGHT_TIMEOUT_MS)]),
      });
      const info: PreflightInfo = {
        status: res.status,
        colo: coloFromHeaders((n) => res.headers.get(n)),
        family: familyFromIp(res.headers.get('cf-meta-ip')),
        retryAfterMs: res.status === 429 ? parseRetryAfter(res.headers.get('retry-after')) : null,
      };
      await res.arrayBuffer().catch(() => undefined);
      return info;
    },
    async download(bytes, signal, onBytes, onResponse) {
      const res = await fetch(`${ep.base}/__down?bytes=${bytes}&measId=${measId}`, {
        headers: { 'accept-encoding': 'identity' },
        signal,
      });
      const outcome: StreamOutcome = {
        status: res.status,
        colo: coloFromHeaders((n) => res.headers.get(n)),
        retryAfterMs: res.status === 429 ? parseRetryAfter(res.headers.get('retry-after')) : null,
      };
      onResponse?.(outcome);
      if (res.status !== 200 || !res.body) {
        await res.body?.cancel().catch(() => undefined);
        return outcome;
      }
      const reader = res.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) onBytes(value.byteLength);
        }
      } finally {
        try {
          reader.releaseLock();
        } catch {
          /* stream already errored/cancelled */
        }
      }
      return outcome;
    },
    upload(bytes, signal, onBytes) {
      return postUpload(ep, agent, measId, bytes, signal, onBytes);
    },
    dispose() {
      agent.destroy();
    },
  };
}
