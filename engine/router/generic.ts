// Generic router adapter: reachability + HTTP response time only (no vendor knowledge, no login).
// Used when the configured router is not an ARRIS Vodafone Station (or adapter = 'generic').
import { htmlTitle } from './arris-parse';
import { HttpError, HttpSession } from './http';

export const GENERIC_TIMEOUT_MS = 8000;

export interface GenericStatus {
  reachable: boolean;
  httpMs: number | null;
  /** HTTP status code of GET / (null when the request failed before a response) */
  httpStatus: number | null;
  /** <title> of the start page, if any (a weak device hint) */
  title: string | null;
  error: string | null;
}

export interface GenericAdapterOptions {
  host: string;
  port?: number;
  makeSession?: (host: string, port: number) => HttpSession;
}

/** Minimal "is the router there and how fast does its web UI answer" probe. */
export class GenericAdapter {
  readonly id = 'generic' as const;
  readonly host: string;
  readonly port: number;
  private readonly makeSession: (host: string, port: number) => HttpSession;

  constructor(opts: GenericAdapterOptions) {
    this.host = opts.host;
    this.port = opts.port ?? 80;
    this.makeSession = opts.makeSession ?? ((host, port) => new HttpSession({ host, port }));
  }

  async fetchStatus(reuse?: HttpSession): Promise<GenericStatus> {
    const session = reuse ?? this.makeSession(this.host, this.port);
    try {
      const res = await session.get('/', { timeoutMs: GENERIC_TIMEOUT_MS });
      // Any HTTP answer (even 401/403/404) means the router is reachable and its UI responded.
      return {
        reachable: true,
        httpMs: Math.round(res.ms),
        httpStatus: res.status,
        title: res.status === 200 ? htmlTitle(res.body) : null,
        error: null,
      };
    } catch (err) {
      const msg = err instanceof HttpError ? err.message : err instanceof Error ? err.message : String(err);
      return { reachable: false, httpMs: null, httpStatus: null, title: null, error: msg };
    } finally {
      if (!reuse) session.abort();
    }
  }
}
