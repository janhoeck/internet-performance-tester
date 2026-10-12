// Tiny HTTP/1.1 client for the router web UI: node:http, per-request deadline, response size cap,
// cookie jar, and redirects only to the same (private) host. No keep-alive, no HTTPS (the
// Vodafone Station answers HTTPS with 403). Never logs headers or bodies (they carry secrets).
import http from 'node:http';
import { performance } from 'node:perf_hooks';
import { isIPv4, isIPv6, isLinkLocalV6, isPrivateV4 } from '../../src/lib/shared/net';

/**
 * Router addresses the engine may talk to: RFC1918 IPv4, IPv4/IPv6 link-local. Hostnames are
 * refused (easy.box / kabel.box resolve to public Internet hosts – credentials must never go there).
 */
export function isAllowedRouterAddress(host: string): boolean {
  const h = host.trim();
  if (isIPv4(h)) {
    const [a, b] = h.split('.').map(Number);
    return isPrivateV4(h) || (a === 169 && b === 254);
  }
  if (isIPv6(h)) return isLinkLocalV6(h);
  return false;
}

export type HttpErrorCode = 'timeout' | 'refused' | 'network' | 'too-large' | 'blocked' | 'aborted';

export class HttpError extends Error {
  constructor(readonly code: HttpErrorCode, message: string) {
    super(message);
    this.name = 'HttpError';
  }
}

export interface TransportRequest {
  host: string;
  port: number;
  method: 'GET' | 'POST';
  path: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
  maxBytes: number;
  signal?: AbortSignal;
}

export interface TransportResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** One HTTP exchange (no redirects, no cookies). Injectable for tests. */
export type HttpTransport = (req: TransportRequest) => Promise<TransportResponse>;

function mapNetError(err: unknown): HttpError {
  if (err instanceof HttpError) return err;
  const code = typeof err === 'object' && err !== null && 'code' in err ? String((err as { code: unknown }).code) : '';
  const msg = err instanceof Error ? err.message : String(err);
  if (code === 'ECONNREFUSED') return new HttpError('refused', 'Verbindung abgelehnt');
  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT') return new HttpError('timeout', 'Zeitüberschreitung');
  if (code === 'ABORT_ERR') return new HttpError('aborted', 'abgebrochen');
  return new HttpError('network', code ? `Netzwerkfehler (${code})` : `Netzwerkfehler: ${msg}`);
}

/** node:http transport: fresh connection per request, hard deadline, body size cap. */
export const nodeTransport: HttpTransport = (req) =>
  new Promise<TransportResponse>((resolve, reject) => {
    if (req.signal?.aborted) {
      reject(new HttpError('aborted', 'abgebrochen'));
      return;
    }
    let settled = false;
    const finish = (err: HttpError | null, res?: TransportResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.signal?.removeEventListener('abort', onAbort);
      if (err) reject(err);
      else if (res) resolve(res);
    };
    const headers: Record<string, string> = { ...req.headers };
    if (req.method === 'POST') headers['Content-Length'] = String(Buffer.byteLength(req.body ?? '', 'utf8'));
    const cr = http.request({
      host: req.host,
      port: req.port,
      method: req.method,
      path: req.path,
      headers,
      agent: false,
      setHost: true,
    });
    const timer = setTimeout(() => {
      finish(new HttpError('timeout', `Zeitüberschreitung nach ${Math.round(req.timeoutMs / 1000)} s`));
      cr.destroy();
    }, req.timeoutMs);
    const onAbort = () => {
      finish(new HttpError('aborted', 'abgebrochen'));
      cr.destroy();
    };
    req.signal?.addEventListener('abort', onAbort, { once: true });
    cr.on('error', (err) => finish(mapNetError(err)));
    cr.on('response', (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > req.maxBytes) {
          finish(new HttpError('too-large', 'Antwort zu groß'));
          cr.destroy();
          return;
        }
        chunks.push(c);
      });
      res.on('error', (err) => finish(mapNetError(err)));
      res.on('end', () => {
        finish(null, {
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: new TextDecoder('utf-8').decode(Buffer.concat(chunks)),
        });
      });
    });
    cr.end(req.method === 'POST' ? (req.body ?? '') : undefined);
  });

// ─── Cookie jar (single host) ──────────────────────────────────────────────

export class CookieJar {
  private readonly map = new Map<string, string>();

  get(name: string): string | null {
    return this.map.get(name) ?? null;
  }

  set(name: string, value: string): void {
    this.map.set(name, value);
  }

  delete(name: string): void {
    this.map.delete(name);
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }

  /** Apply `Set-Cookie` header value(s); expired / max-age ≤ 0 / 'deleted' cookies are removed. */
  store(setCookie: string | string[] | undefined, now: number = Date.now()): void {
    if (!setCookie) return;
    for (const line of Array.isArray(setCookie) ? setCookie : [setCookie]) {
      const parts = line.split(';');
      const eq = parts[0].indexOf('=');
      if (eq <= 0) continue;
      const name = parts[0].slice(0, eq).trim();
      const value = parts[0].slice(eq + 1).trim();
      let expired = value === '' || value === 'deleted';
      for (const attr of parts.slice(1)) {
        const [k, ...rest] = attr.split('=');
        const key = k.trim().toLowerCase();
        const v = rest.join('=').trim();
        if (key === 'max-age' && Number(v) <= 0) expired = true;
        if (key === 'expires') {
          const t = Date.parse(v);
          if (Number.isFinite(t) && t <= now) expired = true;
        }
      }
      if (expired) this.map.delete(name);
      else this.map.set(name, value);
    }
  }

  /** `Cookie` request header value, null when empty. */
  header(): string | null {
    if (this.map.size === 0) return null;
    return [...this.map.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

// ─── Session (base host + jar + redirects) ────────────────────────────────

export interface HttpSessionOptions {
  host: string;
  port?: number;
  transport?: HttpTransport;
  /** host policy (default: isAllowedRouterAddress); checked for the base host and every redirect */
  allowHost?: (host: string) => boolean;
  defaultTimeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
}

export interface RequestOptions {
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

export interface HttpResult {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  /** wall duration incl. redirects (monotonic clock) */
  ms: number;
  /** final request path */
  path: string;
}

const DEFAULT_HEADERS: Record<string, string> = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Netzdiagnose/1.0',
  Accept: '*/*',
  'Accept-Language': 'de-DE,de;q=0.9,en;q=0.5',
  'Cache-Control': 'no-cache',
};

function headerValue(h: string | string[] | undefined): string | null {
  if (Array.isArray(h)) return h[0] ?? null;
  return h ?? null;
}

export class HttpSession {
  readonly jar = new CookieJar();
  readonly host: string;
  readonly port: number;
  private readonly transport: HttpTransport;
  private readonly allowHost: (host: string) => boolean;
  private readonly defaultTimeoutMs: number;
  private readonly maxBytes: number;
  private readonly maxRedirects: number;
  private readonly ctrl = new AbortController();

  constructor(opts: HttpSessionOptions) {
    this.host = opts.host.trim();
    this.port = opts.port ?? 80;
    this.transport = opts.transport ?? nodeTransport;
    this.allowHost = opts.allowHost ?? isAllowedRouterAddress;
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 10_000;
    this.maxBytes = opts.maxBytes ?? 4 * 1024 * 1024;
    this.maxRedirects = opts.maxRedirects ?? 3;
    if (!this.allowHost(this.host)) {
      throw new HttpError('blocked', `Adresse ${this.host} ist keine private Router-Adresse`);
    }
  }

  /** 'http://192.168.0.1' (IPv6 in brackets, port only when not 80) */
  get origin(): string {
    const h = isIPv6(this.host) ? `[${this.host.replace('%', '%25')}]` : this.host;
    return `http://${h}${this.port === 80 ? '' : `:${this.port}`}`;
  }

  get aborted(): boolean {
    return this.ctrl.signal.aborted;
  }

  /** Abort in-flight and future requests of this session. */
  abort(): void {
    this.ctrl.abort();
  }

  get(path: string, opts: RequestOptions = {}): Promise<HttpResult> {
    return this.request('GET', path, opts);
  }

  post(path: string, opts: RequestOptions = {}): Promise<HttpResult> {
    return this.request('POST', path, opts);
  }

  async request(method: 'GET' | 'POST', path: string, opts: RequestOptions = {}): Promise<HttpResult> {
    const t0 = performance.now();
    let currentPath = path.startsWith('/') ? path : `/${path}`;
    for (let hop = 0; ; hop++) {
      if (this.ctrl.signal.aborted) throw new HttpError('aborted', 'abgebrochen');
      const headers: Record<string, string> = { ...DEFAULT_HEADERS, ...(opts.headers ?? {}) };
      const cookie = this.jar.header();
      if (cookie) headers.Cookie = cookie;
      const res = await this.transport({
        host: this.host,
        port: this.port,
        method,
        path: currentPath,
        headers,
        body: method === 'POST' ? (opts.body ?? '') : undefined,
        timeoutMs: opts.timeoutMs ?? this.defaultTimeoutMs,
        maxBytes: this.maxBytes,
        signal: this.ctrl.signal,
      });
      this.jar.store(res.headers['set-cookie']);
      const location = headerValue(res.headers.location);
      const isRedirect = [301, 302, 303, 307, 308].includes(res.status) && location !== null;
      if (!isRedirect || method !== 'GET' || hop >= this.maxRedirects) {
        return { status: res.status, headers: res.headers, body: res.body, ms: performance.now() - t0, path: currentPath };
      }
      currentPath = this.redirectPath(location);
    }
  }

  /** Same-host redirects only (relative or absolute http URL to this host). */
  private redirectPath(location: string): string {
    let url: URL;
    try {
      url = new URL(location, `${this.origin}/`);
    } catch {
      throw new HttpError('blocked', 'ungültige Weiterleitung');
    }
    const host = url.hostname.replace(/^\[|\]$/g, '').replace('%25', '%');
    const port = url.port === '' ? 80 : Number(url.port);
    if (url.protocol !== 'http:' || !this.allowHost(host) || host.toLowerCase() !== this.host.toLowerCase() || port !== this.port) {
      throw new HttpError('blocked', `Weiterleitung zu ${url.protocol}//${url.host} blockiert`);
    }
    return `${url.pathname}${url.search}`;
  }
}
