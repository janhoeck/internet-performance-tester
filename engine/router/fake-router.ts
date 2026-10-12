// In-memory ARRIS Vodafone Station used by the adapter/module tests. It speaks the real wire
// protocol (crypto, cookies, csrf nonce, session-lost 400s) through an injected HttpTransport, so
// the login path is exercised end-to-end with the genuine node:crypto implementation.
// NOT a test file itself (no `.test.` in the name) – imported by arris.test.ts / index.test.ts.
import { sjclCcmDecrypt, sjclCcmEncrypt, sjclPbkdf2 } from './arris-crypto';
import { HttpSession, type HttpTransport, type TransportRequest, type TransportResponse } from './http';

export interface FakeRouterOptions {
  password: string;
  sessionId?: string;
  iv?: string;
  salt?: string;
  csrfNonce?: string;
  /** `_ga.*` values merged into the start page */
  ga?: Record<string, string>;
  lockoutSec?: number;
  /** force a p_status (overrides the password check) */
  forceStatus?: 'lockout';
  waitSec?: number;
  /** bodies returned by the authenticated data endpoints */
  docsisBody?: string;
  statusBody?: string;
  overviewBody?: string;
  eventLogBody?: string;
  credentialJs?: string | null;
  /** start page / whole device unreachable */
  unreachable?: boolean;
  requireAuth?: boolean;
}

export interface FakeRouter {
  transport: HttpTransport;
  makeSession: (host: string, port: number) => HttpSession;
  /** call counts per path (basename) */
  readonly calls: Record<string, number>;
  /** currently valid admin sessions (PHPSESSID values) */
  readonly sessions: Set<string>;
}

const DEFAULTS = {
  sessionId: 'df59fc3de28c9f18d95a162836aa298b',
  iv: 'c1697be73d452e75',
  salt: 'badd6f0848f968df',
  csrfNonce: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
};

const okHtml = (body: string, cookie?: string): TransportResponse => ({
  status: 200,
  headers: cookie ? { 'content-type': 'text/html', 'set-cookie': cookie } : { 'content-type': 'text/html' },
  body,
});

const sessionLost = (): TransportResponse => ({
  status: 400,
  headers: { 'content-type': 'text/html' },
  body: '<script> alert(xlate("PAGE_OVERVIEW_SESSION_LOST_POPUP_TEXT")); location.href="../index.php";</script>',
});

export const DEFAULT_DOCSIS_BODY = `
js_dsNums = '2'; js_usNums = '1'; js_ofdmNums = '1';
json_dsData = [
  {"ChannelType":"OFDM","Modulation":"4096QAM","Frequency":"151~324","ChannelID":"33","PowerLevel":"-1/59","SNRLevel":"44","LockStatus":"Locked"},
  {"ChannelType":"SC-QAM","Frequency":602,"PowerLevel":"3/63","SNRLevel":38,"Modulation":"256QAM","ChannelID":"5","LockStatus":"Locked"}
];
json_usData = [ {"Frequency":31,"PowerLevel":"44/104","ChannelType":"SC-QAM","ChannelID":"4","Modulation":"64QAM","LockStatus":"ACTIVE"} ];
`;

export const DEFAULT_STATUS_BODY = `var js_FWVersion = '01.05.069.14'; var js_HWTypeVersion = '6442'; var js_UptimeSinceReboot = '1,02,03';`;
export const DEFAULT_OVERVIEW_BODY = `json_lanAttachedDevice = [{"Index":"1","Speed":"1000 Mbps","HostName":"Jan-PC","MAC":"AA-BB-CC-DD-EE-FF","IPv4":"192.168.0.23","IPv6":"-"}];`;
export const DEFAULT_EVENTLOG_BODY = JSON.stringify({
  eventLog: [
    { Timestamp: '01.10.2026 20:15:00', Index: '7', Priority: '3', Text: 'No Ranging Response received - T3 time-out;CM-MAC=aa:bb:cc:dd:ee:ff;' },
  ],
});

export function startPageHtml(o: Required<Pick<FakeRouterOptions, 'sessionId' | 'iv' | 'salt'>> & { ga: Record<string, string> }): string {
  const ga = Object.entries(o.ga).map(([k, v]) => `_ga.${k} = '${v}';`).join('\n');
  return `<!DOCTYPE html><html><head>
<script src="scripts/sjclCrypto.js"></script>
<script>
var loginUserName = 'admin';
var currentSessionId = '${o.sessionId}';
var myIv = '${o.iv}';
var mySalt = '${o.salt}';
var _ga = {};
${ga}
</script></head><body>skins/vod</body></html>`;
}

export function createFakeRouter(opts: FakeRouterOptions): FakeRouter {
  const cfg = { ...DEFAULTS, ...opts };
  const ga: Record<string, string> = {
    swVersion: '01.05.069.14.EURO.PC20',
    isModel6442: 'true',
    modemConnectionStatus: 'DOCSIS Online',
    wanIpv4: '0.0.0.0',
    wanIpv6: '2a02:908:f000:1ab::74f',
    aftrAddress: '2a00:0:cff:84a0::3',
    dsLitePlusIpv6Mode: 'true',
    gwMode: 'Ipv6',
    lastRebootReason: 'unknown',
    lockoutTimeLeft: String(opts.lockoutSec ?? 0),
    docsisFailoverStatus: 'none',
    ...opts.ga,
  };
  const calls: Record<string, number> = {};
  const sessions = new Set<string>();
  let cookieSeq = 0;

  const transport: HttpTransport = async (req: TransportRequest): Promise<TransportResponse> => {
    const path = req.path.split('?')[0];
    const base = path.replace(/^\/php\//, '').replace(/^\//, '') || 'root';
    calls[base] = (calls[base] ?? 0) + 1;
    if (opts.unreachable) {
      throw Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' });
    }
    const hasCsrf = req.headers.csrfNonce === cfg.csrfNonce || req.headers.csrfnonce === cfg.csrfNonce;
    const cookie = req.headers.Cookie ?? req.headers.cookie ?? '';
    const authed = hasCsrf && /PHPSESSID=/.test(cookie);

    if (req.method === 'GET' && path === '/') {
      const sid = `sess${cookieSeq++}`;
      return okHtml(startPageHtml({ sessionId: cfg.sessionId, iv: cfg.iv, salt: cfg.salt, ga }), `PHPSESSID=${sid}; path=/; HttpOnly`);
    }
    if (req.method === 'GET' && path === '/base_95x.js') {
      const js = opts.credentialJs === undefined ? 'function x(){ createCookie("credential", "cred-value=="); }' : opts.credentialJs;
      return js === null ? { status: 404, headers: {}, body: '' } : okHtml(js);
    }
    if (req.method === 'POST' && path === '/php/ajaxSet_Password.php') {
      if (cfg.forceStatus === 'lockout') return okHtml(JSON.stringify({ p_status: 'Lockout', p_waitTime: String(cfg.waitSec ?? 60) }));
      let plaintext = '';
      try {
        const body = JSON.parse(req.body ?? '{}') as { EncryptData?: string };
        const key = sjclPbkdf2(cfg.password, cfg.salt);
        plaintext = sjclCcmDecrypt(key, body.EncryptData ?? '', cfg.iv, 'loginPassword');
      } catch {
        plaintext = '';
      }
      const ok = plaintext.includes(`"Password": "${cfg.password}"`);
      if (!ok) return okHtml(JSON.stringify({ p_status: 'MisMatch' }));
      const key = sjclPbkdf2(cfg.password, cfg.salt);
      const encryptData = sjclCcmEncrypt(key, cfg.csrfNonce, cfg.iv, 'nonce');
      return okHtml(JSON.stringify({ p_status: 'AdminMatch', encryptData }));
    }
    if (req.method === 'POST' && path === '/php/ajaxSet_Session.php') {
      if (hasCsrf) sessions.add('ok');
      return okHtml(JSON.stringify({ LoginStatus: 'yes' }));
    }
    if (req.method === 'POST' && path === '/php/logout.php') {
      sessions.delete('ok');
      return okHtml('');
    }
    // authenticated data endpoints
    const needAuth = opts.requireAuth ?? true;
    if (req.method === 'GET') {
      if (needAuth && !authed) return sessionLost();
      if (path === '/php/status_docsis_data.php') return okHtml(opts.docsisBody ?? DEFAULT_DOCSIS_BODY);
      if (path === '/php/status_status_data.php') return okHtml(opts.statusBody ?? DEFAULT_STATUS_BODY);
      if (path === '/php/overview_data.php') return okHtml(opts.overviewBody ?? DEFAULT_OVERVIEW_BODY);
      if (path === '/php/status_event_log_data.php') {
        return { status: 200, headers: { 'content-type': 'application/json' }, body: opts.eventLogBody ?? DEFAULT_EVENTLOG_BODY };
      }
    }
    return { status: 404, headers: {}, body: 'not found' };
  };

  const makeSession = (host: string, port: number): HttpSession => new HttpSession({ host, port, transport });
  return { transport, makeSession, calls, sessions };
}
