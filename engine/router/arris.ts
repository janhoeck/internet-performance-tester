// ARRIS Vodafone Station adapter: unauthenticated status + authenticated DOCSIS / uptime /
// attached devices / event log. Login crypto per docs/research/router-api.md. This class only
// performs single exchanges and reports precise outcomes - the safety POLICY (never auto-retry a
// failed login, lockout wait, wrong password -> stop, backoff) is enforced by the router module.
import { buildLoginRequest, readCsrfNonce } from './arris-crypto';
import {
  categorizeLog,
  extractCredentialCookie,
  isLockout,
  isLoginSuccess,
  isSessionLost,
  parseDocsisPage,
  parseEventLog,
  parseLoginResponse,
  parseOverviewPage,
  parseStartPage,
  parseStatusPage,
  startPageInfo,
  type ArrisStartPage,
  type CategorizedLogEntry,
  type StartPageInfo,
  type StatusPage,
} from './arris-parse';
import { HttpError, HttpSession } from './http';
import type { DocsisChannelInput } from '../../src/lib/shared/docsis';
import type { RouterAttachedDevice } from '../../src/lib/shared/types';

export const ENDPOINTS = {
  start: '/',
  login: '/php/ajaxSet_Password.php',
  session: '/php/ajaxSet_Session.php',
  logout: '/php/logout.php',
  credentialJs: '/base_95x.js',
  docsis: '/php/status_docsis_data.php',
  status: '/php/status_status_data.php',
  overview: '/php/overview_data.php',
  eventLog: '/php/status_event_log_data.php?{"eventLogRecord":{}}',
} as const;

/** HTML data pages shorter than this are treated as "session expired" (not for the event-log JSON). */
const MIN_DATA_LENGTH = 40;
/** the credential cookie value from /base_95x.js is static JS - re-read at most every 6 h */
const CREDENTIAL_CACHE_MS = 6 * 3_600_000;

export const TIMEOUTS = {
  start: 10_000,
  login: 15_000,
  data: 20_000,
  eventLog: 30_000,
  logout: 5_000,
} as const;

/**
 * Login outcome:
 *  success        - p_status accepted AND the csrf nonce decrypted with our key (proves the password)
 *  wrong-password - router answered with a non-success p_status (never retry automatically)
 *  implausible    - success-like answer without a decryptable nonce (treated like a failure)
 *  lockout        - too many failed attempts (`p_waitTime` / `_ga.lockoutTimeLeft` seconds)
 *  unanswered     - the password POST was sent but no usable answer came back (timeout, non-JSON)
 *  error          - nothing was sent (start page unreachable, crypto vars missing, local error)
 */
export type LoginOutcome =
  | { kind: 'success'; csrfNonce: string }
  | { kind: 'wrong-password'; pStatus: string | null }
  | { kind: 'implausible'; message: string }
  | { kind: 'lockout'; waitSec: number | null }
  | { kind: 'unanswered'; message: string }
  | { kind: 'error'; message: string };

export interface LoginResult {
  outcome: LoginOutcome;
  /** session to reuse after success; aborted for every other outcome */
  session: HttpSession;
  /** start page fetched for the crypto material (doubles as a status read), null if unreachable */
  page: ArrisStartPage | null;
  httpMs: number | null;
}

export interface LoginContext {
  csrfNonce: string;
  session: HttpSession;
}

export interface ArrisAdapterOptions {
  host: string;
  port?: number;
  username?: string;
  /** injected for tests (HttpSession.transport) */
  makeSession?: (host: string, port: number) => HttpSession;
  /** cache-buster `?_n=<digits>` on data GETs (router GUI adds it; optional) */
  cacheBuster?: boolean;
  now?: () => number;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function headersFor(session: HttpSession, csrfNonce: string): Record<string, string> {
  return {
    csrfNonce,
    'X-Requested-With': 'XMLHttpRequest',
    Origin: session.origin,
    Referer: `${session.origin}/`,
  };
}


/**
 * Authenticated GET of a *_data.php page; returns null on "session expired" (incl. a redirect to
 * the login page) so the caller can re-login once. Other HTTP errors throw.
 */
async function dataGet(ctx: LoginContext, path: string, opts: { minLength?: number; timeoutMs: number }): Promise<string | null> {
  const res = await ctx.session.get(path, { headers: headersFor(ctx.session, ctx.csrfNonce), timeoutMs: opts.timeoutMs });
  if (isSessionLost(res.status, res.body, { minLength: opts.minLength })) return null;
  if (res.status !== 200) throw new HttpError('network', `HTTP ${res.status} für ${path.split('?')[0]}`);
  return res.body;
}

export class ArrisAdapter {
  readonly id = 'arris-vodafone-station' as const;
  readonly host: string;
  readonly port: number;
  readonly username: string;
  private readonly makeSession: (host: string, port: number) => HttpSession;
  private readonly cacheBuster: boolean;
  private readonly now: () => number;
  private credential: { value: string | null; ts: number } | null = null;

  constructor(opts: ArrisAdapterOptions) {
    this.host = opts.host;
    this.port = opts.port ?? 80;
    this.username = opts.username ?? 'admin';
    this.makeSession = opts.makeSession ?? ((host, port) => new HttpSession({ host, port }));
    this.cacheBuster = opts.cacheBuster ?? false;
    this.now = opts.now ?? Date.now;
  }

  private cb(path: string): string {
    if (!this.cacheBuster) return path;
    const n = Math.floor(Math.random() * 90000 + 10000);
    return path.includes('?') ? `${path}&_n=${n}` : `${path}?_n=${n}`;
  }

  /**
   * Unauthenticated start-page poll: `_ga.*` status + HTTP response time (never logs in).
   * A long-lived session may be passed to reuse its cookie jar (one anonymous PHP session).
   */
  async fetchStatus(reuse?: HttpSession): Promise<{ info: StartPageInfo; page: ArrisStartPage; httpMs: number }> {
    const session = reuse ?? this.makeSession(this.host, this.port);
    try {
      const res = await session.get(ENDPOINTS.start, { timeoutMs: TIMEOUTS.start });
      if (res.status !== 200) throw new HttpError('network', `HTTP ${res.status} von der Startseite`);
      const page = parseStartPage(res.body);
      return { info: startPageInfo(page), page, httpMs: Math.round(res.ms) };
    } finally {
      if (!reuse) session.abort();
    }
  }

  /**
   * One login attempt on a fresh session: GET / (crypto material + lockout check), POST the
   * encrypted password once, decrypt the csrf nonce (proves the password), optional credential
   * cookie, activate the session. Never sends more than ONE password POST. The caller must not call
   * this again after `wrong-password`/`implausible`/`lockout` until the password or lockout changes.
   */
  async login(password: string): Promise<LoginResult> {
    const session = this.makeSession(this.host, this.port);
    const fail = (outcome: LoginOutcome, page: ArrisStartPage | null, httpMs: number | null): LoginResult => {
      session.abort();
      return { outcome, session, page, httpMs };
    };

    let startRes;
    try {
      startRes = await session.get(ENDPOINTS.start, { timeoutMs: TIMEOUTS.start });
    } catch (err) {
      return fail({ kind: 'error', message: errorText(err) }, null, null);
    }
    const httpMs = Math.round(startRes.ms);
    if (startRes.status !== 200) {
      return fail({ kind: 'error', message: `HTTP ${startRes.status} von der Startseite` }, null, httpMs);
    }
    const page = parseStartPage(startRes.body);
    const lockoutSec = startPageInfo(page).lockoutSec;
    if (lockoutSec !== null && lockoutSec > 0) {
      return fail({ kind: 'lockout', waitSec: lockoutSec }, page, httpMs);
    }
    if (!page.sessionId || !page.iv || !page.salt) {
      return fail({ kind: 'error', message: 'Login-Parameter (Session/IV/Salt) nicht gefunden' }, page, httpMs);
    }

    let body;
    let key: string;
    try {
      ({ key, body } = await buildLoginRequest(password, this.username, page.sessionId, page.salt, page.iv));
    } catch (err) {
      return fail({ kind: 'error', message: `Login konnte nicht verschlüsselt werden: ${errorText(err)}` }, page, httpMs);
    }

    let loginRes;
    try {
      loginRes = await session.post(ENDPOINTS.login, {
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
          Origin: session.origin,
          Referer: `${session.origin}/`,
        },
        body: JSON.stringify(body),
        timeoutMs: TIMEOUTS.login,
      });
    } catch (err) {
      // the POST may or may not have reached the router: treat as "unanswered", do not auto-retry
      return fail({ kind: 'unanswered', message: errorText(err) }, page, httpMs);
    }

    const parsed = parseLoginResponse(loginRes.body);
    if (!parsed) {
      return fail({ kind: 'unanswered', message: `Login-Antwort nicht lesbar (HTTP ${loginRes.status})` }, page, httpMs);
    }
    if (isLockout(parsed.pStatus)) {
      return fail({ kind: 'lockout', waitSec: parsed.waitSec }, page, httpMs);
    }
    if (!isLoginSuccess(parsed.pStatus)) {
      return fail({ kind: 'wrong-password', pStatus: parsed.pStatus }, page, httpMs);
    }
    if (!parsed.encryptData) {
      return fail({ kind: 'implausible', message: 'Login ohne csrf-Nonce in der Antwort' }, page, httpMs);
    }
    let csrfNonce: string;
    try {
      csrfNonce = readCsrfNonce(key, parsed.encryptData, page.iv);
    } catch {
      // success-like p_status but the nonce does not decrypt with our key -> not a real success
      return fail({ kind: 'implausible', message: 'csrf-Nonce konnte nicht entschlüsselt werden' }, page, httpMs);
    }
    if (!/^[0-9a-fA-F]{8,}$/.test(csrfNonce)) {
      return fail({ kind: 'implausible', message: 'csrf-Nonce hat ein unerwartetes Format' }, page, httpMs);
    }

    try {
      await this.loadCredentialCookie(session);
      await this.activateSession(session, csrfNonce);
    } catch (err) {
      return fail({ kind: 'error', message: errorText(err) }, page, httpMs);
    }
    return { outcome: { kind: 'success', csrfNonce }, session, page, httpMs };
  }

  /** `credential` cookie from /base_95x.js (harmless if the endpoint is missing or has no cookie). */
  private async loadCredentialCookie(session: HttpSession): Promise<void> {
    const cached = this.credential;
    if (cached && this.now() - cached.ts < CREDENTIAL_CACHE_MS) {
      if (cached.value) session.jar.set('credential', cached.value);
      return;
    }
    try {
      const res = await session.get(ENDPOINTS.credentialJs, { timeoutMs: TIMEOUTS.start });
      const value = res.status === 200 ? extractCredentialCookie(res.body) : null;
      this.credential = { value, ts: this.now() };
      if (value) session.jar.set('credential', value);
    } catch {
      /* optional */
    }
  }

  /** POST ajaxSet_Session.php to activate the session (no body); ignore its outcome. */
  private async activateSession(session: HttpSession, csrfNonce: string): Promise<void> {
    try {
      await session.post(ENDPOINTS.session, { headers: headersFor(session, csrfNonce), timeoutMs: TIMEOUTS.start });
    } catch {
      /* some firmwares do not need it */
    }
  }

  /** POST logout.php to free the single admin session (best effort), then abort the session. */
  async logout(ctx: LoginContext): Promise<void> {
    try {
      await ctx.session.post(ENDPOINTS.logout, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headersFor(ctx.session, ctx.csrfNonce) },
        timeoutMs: TIMEOUTS.logout,
      });
    } catch {
      /* best effort */
    } finally {
      ctx.session.abort();
    }
  }

  async fetchDocsis(ctx: LoginContext): Promise<{ ds: DocsisChannelInput[]; us: DocsisChannelInput[] } | null> {
    const body = await dataGet(ctx, this.cb(ENDPOINTS.docsis), { minLength: MIN_DATA_LENGTH, timeoutMs: TIMEOUTS.data });
    if (body === null) return null;
    const page = parseDocsisPage(body);
    return { ds: page.ds, us: page.us };
  }

  async fetchDeviceStatus(ctx: LoginContext): Promise<StatusPage | null> {
    const body = await dataGet(ctx, this.cb(ENDPOINTS.status), { minLength: MIN_DATA_LENGTH, timeoutMs: TIMEOUTS.data });
    if (body === null) return null;
    return parseStatusPage(body);
  }

  async fetchAttachedDevices(ctx: LoginContext): Promise<RouterAttachedDevice[] | null> {
    const body = await dataGet(ctx, this.cb(ENDPOINTS.overview), { minLength: MIN_DATA_LENGTH, timeoutMs: TIMEOUTS.data });
    if (body === null) return null;
    return parseOverviewPage(body);
  }

  async fetchEventLog(ctx: LoginContext, now: number = this.now()): Promise<CategorizedLogEntry[] | null> {
    const body = await dataGet(ctx, this.cb(ENDPOINTS.eventLog), { timeoutMs: TIMEOUTS.eventLog });
    if (body === null) return null;
    const parsed = parseEventLog(body, now);
    if (parsed === null) return [];
    return categorizeLog(parsed);
  }
}
