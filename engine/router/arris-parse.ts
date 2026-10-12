// Pure parsers for the ARRIS Vodafone Station (TG6442 / TG3442DE) PHP web UI.
// Formats: docs/research/router-api.md (§b, §c, §e) and docs/research/docsis-thresholds.md (§2.2).
// Every value from the router may be a string or a number – coerce defensively, never throw.
import {
  classifyLogMessage,
  escalateLogBursts,
  extractMacs,
  normalizeChannelType,
  parseLockStatus,
  type DocsisChannelInput,
  type LogCategory,
} from '../../src/lib/shared/docsis';
import { isIPv4, isIPv6 } from '../../src/lib/shared/net';
import type { RouterAttachedDevice, RouterLogEntry, Severity } from '../../src/lib/shared/types';

// ─── Generic JS variable extraction ───────────────────────────────────────

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Index just behind the closing bracket of a balanced JSON/JS literal starting at `start`, or -1. */
function balancedEnd(src: string, start: number): number {
  const open = src[start];
  const close = open === '[' ? ']' : '}';
  const stack: string[] = [close];
  let quote: string | null = null;
  for (let i = start + 1; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '[') stack.push(']');
    else if (c === '{') stack.push('}');
    else if (c === ']' || c === '}') {
      if (stack.pop() !== c) return -1;
      if (stack.length === 0) return i + 1;
    }
  }
  return -1;
}

function unescapeJsString(s: string): string {
  return s.replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/g, (_m, e: string) => {
    if (e[0] === 'u' && e.length === 5) return String.fromCharCode(parseInt(e.slice(1), 16));
    if (e[0] === 'x' && e.length === 3) return String.fromCharCode(parseInt(e.slice(1), 16));
    if (e === 'n') return '\n';
    if (e === 't') return '\t';
    if (e === 'r') return '\r';
    return e;
  });
}

const IDENT_START = /[A-Za-z_$]/;
const BARE_KEY = /([A-Za-z_$][\w$]*)\s*:/y;
const TRAILING_COMMA = /,\s*[\]}]/y;

/**
 * JS object/array literal → JSON text: single-quoted strings, unquoted keys and trailing commas
 * are normalized (string contents are never touched). Linear time.
 */
export function jsLiteralToJson(src: string): string {
  let out = '';
  let last = ''; // last non-whitespace char emitted
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === '\\' ? 2 : 1;
      out += JSON.stringify(unescapeJsString(src.slice(i + 1, Math.min(j, src.length))));
      last = '"';
      i = j + 1;
      continue;
    }
    if (c === ',') {
      TRAILING_COMMA.lastIndex = i;
      if (TRAILING_COMMA.test(src)) {
        i++;
        continue;
      }
    }
    if (IDENT_START.test(c) && (last === '{' || last === ',')) {
      BARE_KEY.lastIndex = i;
      const m = BARE_KEY.exec(src);
      if (m) {
        out += `${JSON.stringify(m[1])}:`;
        last = ':';
        i += m[0].length;
        continue;
      }
    }
    out += c;
    if (!/\s/.test(c)) last = c;
    i++;
  }
  return out;
}

/** JSON.parse with a fallback for JS literal syntax; undefined when both fail. */
export function parseJsonLenient(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    try {
      return JSON.parse(jsLiteralToJson(text)) as unknown;
    } catch {
      return undefined;
    }
  }
}

/**
 * Value of a JS assignment `name = <value>;` in an HTML/JS body (with or without `var`):
 * arrays/objects are JSON-parsed (balanced scan, multi-line safe, lenient JS literal fallback),
 * quoted strings unescaped, bare tokens converted to number/boolean/null. `undefined` when absent
 * or unparseable.
 */
export function extractJsValue(src: string, name: string): unknown {
  const re = new RegExp(`(?:^|[^A-Za-z0-9_$.])${escapeRe(name)}\\s*=(?!=)\\s*`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const pos = m.index + m[0].length;
    const c = src[pos];
    if (c === '[' || c === '{') {
      const end = balancedEnd(src, pos);
      if (end < 0) continue;
      const v = parseJsonLenient(src.slice(pos, end));
      if (v === undefined) continue;
      return v;
    }
    if (c === '"' || c === "'") {
      let i = pos + 1;
      while (i < src.length && src[i] !== c) i += src[i] === '\\' ? 2 : 1;
      if (i >= src.length) continue;
      return unescapeJsString(src.slice(pos + 1, i));
    }
    const tok = /^[^;\r\n]*/.exec(src.slice(pos))?.[0].trim() ?? '';
    if (tok === '') continue;
    if (tok === 'true') return true;
    if (tok === 'false') return false;
    if (tok === 'null') return null;
    const n = Number(tok);
    return Number.isFinite(n) ? n : tok;
  }
  return undefined;
}

/** String value of a JS variable (numbers are stringified), null when absent. */
export function extractJsString(src: string, name: string): string | null {
  const v = extractJsValue(src, name);
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return null;
}

// ─── Value coercion ───────────────────────────────────────────────────────

function cleanNumText(s: string): string {
  return s.replace(/[\u2212\u2012\u2013]/g, '-').replace(/(\d),(\d)/g, '$1.$2');
}

/** First float in a string/number, rounded to 0.1 (router floats carry noise like 38.60000000000000142). */
export function parseDb(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v * 10) / 10 : null;
  if (typeof v !== 'string') return null;
  const m = /-?\d+(?:\.\d+)?/.exec(cleanNumText(v));
  if (!m) return null;
  const n = parseFloat(m[0]);
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : null;
}

/**
 * Router power level → dBmV: "-3.5/56.5", "-1.5 dBmV/58.5 dBuV", bare numbers; a part explicitly
 * labelled dBµV is converted (dBmV = dBµV − 60).
 */
export function parsePowerDbmv(v: unknown): number | null {
  if (typeof v === 'number') return parseDb(v);
  if (typeof v !== 'string' || v.trim() === '') return null;
  const parts = v.split('/');
  const mv = parts.find((p) => /dbmv/i.test(p));
  if (mv) return parseDb(mv);
  const uv = parts.find((p) => /db[uµμ]/i.test(p));
  if (uv && parts.length === 1) {
    const n = parseDb(uv);
    return n === null ? null : Math.round((n - 60) * 10) / 10;
  }
  return parseDb(parts[0]);
}

function toMHz(x: number): number {
  if (x >= 1e6) return x / 1e6;
  if (x >= 1e4) return x / 1e3;
  return x;
}

/** Frequency: number (MHz, kHz or Hz) or "start~end" (OFDM block, MHz) → start MHz + raw range text. */
export function parseFrequency(v: unknown): { mhz: number | null; text: string | null } {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? { mhz: toMHz(v), text: null } : { mhz: null, text: null };
  if (typeof v !== 'string') return { mhz: null, text: null };
  const s = v.trim();
  if (s === '' || s === '-' || s === '0') return { mhz: null, text: null };
  const range = /^(\d+(?:[.,]\d+)?)\s*(?:~|–|-|to|bis)\s*(\d+(?:[.,]\d+)?)/i.exec(s);
  if (range) {
    const a = toMHz(Number(range[1].replace(',', '.')));
    return { mhz: Number.isFinite(a) ? a : null, text: s };
  }
  const m = /\d+(?:\.\d+)?/.exec(cleanNumText(s));
  const x = m ? parseFloat(m[0]) : Number.NaN;
  return Number.isFinite(x) && x > 0 ? { mhz: toMHz(x), text: null } : { mhz: null, text: null };
}

function toInt(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? Math.trunc(v) : null;
  if (typeof v === 'string' && /^\s*-?\d+\s*$/.test(v)) return Number(v.trim());
  return null;
}

function toCounter(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? v : null;
  if (typeof v === 'string' && /^\s*\d+\s*$/.test(v)) return Number(v.trim());
  return null;
}

function str(v: unknown): string | null {
  if (typeof v === 'string') {
    const s = v.trim();
    return s === '' || s === '-' || s.toLowerCase() === 'n/a' ? null : s;
  }
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const normKey = (k: string) => k.toLowerCase().replace(/[^a-z0-9]/g, '');

/** First present field by alias list (keys compared case/punctuation-insensitively). */
function pick(row: Record<string, unknown>, aliases: readonly string[]): unknown {
  const map = new Map<string, unknown>();
  for (const [k, v] of Object.entries(row)) {
    const nk = normKey(k);
    if (!map.has(nk)) map.set(nk, v);
  }
  for (const a of aliases) {
    if (map.has(a)) {
      const v = map.get(a);
      if (v !== undefined && v !== null && v !== '') return v;
    }
  }
  return undefined;
}

// ─── Start page (unauthenticated GET /) ───────────────────────────────────

export interface ArrisStartPage {
  /** all `_ga.<name> = '<value>';` string assignments */
  ga: Record<string, string>;
  /** login crypto material (rotates on every GET /) */
  sessionId: string | null;
  iv: string | null;
  salt: string | null;
  loginUserName: string | null;
  isArris: boolean;
}

/** ARRIS signature of the Vodafone Station GUI. */
export function detectArris(html: string): boolean {
  return html.includes('skins/vod') || html.includes('sjclCrypto.js') || html.includes('ARRIS');
}

function jsVarHex(html: string, name: string): string | null {
  const m = new RegExp(`(?:var\\s+)?${name}\\s*=\\s*['"]([0-9a-fA-F]+)['"]`).exec(html);
  return m ? m[1] : null;
}

export function parseStartPage(html: string): ArrisStartPage {
  const ga: Record<string, string> = {};
  const re = /_ga\.([A-Za-z0-9_]+)\s*=\s*(?:'([^'\\]*(?:\\.[^'\\]*)*)'|"([^"\\]*(?:\\.[^"\\]*)*)")\s*;/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    ga[m[1]] = unescapeJsString(m[2] ?? m[3] ?? '');
  }
  return {
    ga,
    sessionId: jsVarHex(html, 'currentSessionId'),
    iv: jsVarHex(html, 'myIv'),
    salt: jsVarHex(html, 'mySalt'),
    loginUserName: extractJsString(html, 'loginUserName'),
    isArris: detectArris(html),
  };
}

export interface StartPageInfo {
  vendor: string | null;
  model: string | null;
  firmware: string | null;
  connectionStatus: string | null;
  wanIpv4: string | null;
  wanIpv6: string | null;
  /** IPv6 literal or AFTR name as configured */
  aftrAddress: string | null;
  dsLite: boolean | null;
  gwMode: string | null;
  lastRebootReason: string | null;
  /** `_ga.lockoutTimeLeft` in seconds (0 = no lockout) */
  lockoutSec: number | null;
  docsisFailoverStatus: string | null;
  extra: Record<string, string | number | boolean | null>;
}

/** `_ga` variables that are not useful as status values. */
const GA_SKIP = new Set(['netPwReg']);

/** Map `_ga.*` vars to RouterStatus fields (DS-Lite: wanIpv4 '0.0.0.0' → null). */
export function startPageInfo(page: ArrisStartPage): StartPageInfo {
  const g = page.ga;
  const v = (k: string): string | null => {
    const s = g[k];
    return s === undefined || s.trim() === '' ? null : s.trim();
  };
  const wan4 = v('wanIpv4');
  const wan6 = v('wanIpv6');
  const aftr = v('aftrAddress');
  const wanIpv4 = wan4 && isIPv4(wan4) && wan4 !== '0.0.0.0' ? wan4 : null;
  const wanIpv6 = wan6 && isIPv6(wan6) && wan6 !== '::' ? wan6 : null;
  const aftrAddress = aftr && aftr !== '::' && aftr !== '0.0.0.0' ? aftr : null;
  const dsMode = v('dsLitePlusIpv6Mode');
  let dsLite: boolean | null = null;
  if (dsMode === 'true') dsLite = true;
  else if (aftrAddress && wanIpv4 === null) dsLite = true;
  else if (dsMode === 'false') dsLite = false;
  const lockRaw = v('lockoutTimeLeft');
  const lockNum = lockRaw !== null ? Number(lockRaw) : Number.NaN;
  const extra: Record<string, string | number | boolean | null> = {};
  for (const [k, val] of Object.entries(g)) {
    if (GA_SKIP.has(k)) continue;
    extra[k] = val === 'true' ? true : val === 'false' ? false : val;
  }
  const isModel6442 = v('isModel6442') === 'true';
  return {
    vendor: page.isArris ? 'ARRIS' : null,
    model: isModel6442 ? 'Vodafone Station Wi-Fi 6 (TG6442)' : page.isArris ? 'Vodafone Station (ARRIS)' : null,
    firmware: v('swVersion'),
    connectionStatus: v('modemConnectionStatus'),
    wanIpv4,
    wanIpv6,
    aftrAddress,
    dsLite,
    gwMode: v('gwMode'),
    lastRebootReason: v('lastRebootReason'),
    lockoutSec: Number.isFinite(lockNum) && lockNum >= 0 ? lockNum : null,
    docsisFailoverStatus: v('docsisFailoverStatus'),
    extra,
  };
}

/** `<title>` text of an HTML page (generic adapter), null if absent/empty. */
export function htmlTitle(html: string): string | null {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!m) return null;
  const t = m[1].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  return t === '' ? null : t.slice(0, 120);
}

// ─── Session handling helpers ─────────────────────────────────────────────

/**
 * Data request answered with "session lost": HTTP 400/401/403, the SESSION_LOST popup script
 * (`location.href="../index.php"`) or the login page itself (crypto vars of GET /). `minLength`:
 * HTML data pages shorter than this are also treated as expired (never use it for the event-log
 * JSON, `{"eventLog":[]}` is short).
 */
export function isSessionLost(status: number, body: string, opts: { minLength?: number } = {}): boolean {
  if (status === 400 || status === 401 || status === 403) return true;
  if (/SESSION_LOST|location\.href\s*=\s*["'][^"']*index\.php/i.test(body)) return true;
  if (/var\s+(?:currentSessionId|mySalt)\s*=/.test(body)) return true;
  return opts.minLength !== undefined && body.trim().length < opts.minLength;
}

export interface LoginResponse {
  pStatus: string | null;
  waitSec: number | null;
  encryptData: string | null;
}

/** JSON answer of POST /php/ajaxSet_Password.php; null when not JSON. */
export function parseLoginResponse(body: string): LoginResponse | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.replace(/^\uFEFF/, '').trim());
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const wait = pick(parsed, ['pwaittime', 'waittime']);
  const waitNum = typeof wait === 'number' ? wait : typeof wait === 'string' ? Number(wait) : Number.NaN;
  return {
    pStatus: str(pick(parsed, ['pstatus', 'status'])),
    waitSec: Number.isFinite(waitNum) && waitNum >= 0 ? waitNum : null,
    encryptData: str(pick(parsed, ['encryptdata'])),
  };
}

/**
 * Router GUI logic: success iff p_status contains "Match" (e.g. "AdminMatch") or equals "Default".
 * Defensive: a status that also reads like a failure ("MisMatch", "NoMatch", "Fail…") is never a
 * success – a misread failure would otherwise be retried and could lock the account.
 */
export function isLoginSuccess(pStatus: string | null): boolean {
  if (!pStatus) return false;
  const s = pStatus.trim();
  if (s === 'Default') return true;
  return s.includes('Match') && !/mis-?match|no-?match|fail|invalid|wrong|error|lock/i.test(s);
}

export function isLockout(pStatus: string | null): boolean {
  return !!pStatus && /lockout/i.test(pStatus);
}

/** `createCookie("credential", "<value>")` in /base_95x.js (only some firmwares). */
export function extractCredentialCookie(js: string): string | null {
  const m = /createCookie\(\s*["']credential["']\s*,\s*["']([^"']+)["']/.exec(js);
  return m ? m[1] : null;
}

// ─── DOCSIS page (status_docsis_data.php) ─────────────────────────────────

const A_CHANNEL_ID = ['channelid', 'chid', 'channel', 'id', 'channelindex'];
const A_TYPE = ['channeltype', 'chtype', 'type'];
const A_MOD = ['modulation', 'mod', 'modulationtype', 'modtype', 'profile'];
const A_FREQ = ['frequency', 'freq', 'centralfrequency', 'centerfrequency', 'frequencymhz', 'freqmhz'];
const A_POWER = ['powerlevel', 'power', 'rxpower', 'txpower', 'signalstrength', 'powerdbmv', 'level'];
const A_SNR = ['snrlevel', 'snr', 'snrmer', 'mer', 'rxmer', 'snrdb'];
const A_LOCK = ['lockstatus', 'lock', 'locked', 'rangingstatus', 'ranging', 'status'];
const A_CORR = ['correctederrors', 'correcteds', 'corrected', 'correctable', 'correctables', 'correctablecodewords', 'corr'];
const A_UNCORR = ['uncorrectableerrors', 'uncorrectables', 'uncorrectable', 'uncorrected', 'uncorrectablecodewords', 'uncorr'];

/** One `json_dsData` / `json_usData` row → DocsisChannelInput (rating applied later). */
export function parseChannelRow(row: unknown, dir: 'ds' | 'us'): DocsisChannelInput | null {
  if (!isRecord(row)) return null;
  const lockRaw = pick(row, A_LOCK);
  const lockText = typeof lockRaw === 'boolean' ? (lockRaw ? 'true' : 'false') : str(lockRaw);
  const freq = parseFrequency(pick(row, A_FREQ));
  const typeRaw = str(pick(row, A_TYPE));
  return {
    dir,
    channelId: toInt(pick(row, A_CHANNEL_ID)),
    type: normalizeChannelType(typeRaw, dir),
    frequencyMHz: freq.mhz,
    frequencyText: freq.text,
    powerDbmv: parsePowerDbmv(pick(row, A_POWER)),
    snrDb: dir === 'ds' ? parseDb(pick(row, A_SNR)) : null,
    modulation: str(pick(row, A_MOD)),
    locked: parseLockStatus(lockText, dir),
    lockText,
    corrected: toCounter(pick(row, A_CORR)),
    uncorrectable: toCounter(pick(row, A_UNCORR)),
    raw: { ...row },
  };
}

export interface DocsisPage {
  /** json_dsData was present */
  found: boolean;
  ds: DocsisChannelInput[];
  us: DocsisChannelInput[];
  /** js_dsNums / js_usNums / js_ofdmNums when present */
  counts: { ds: number | null; us: number | null; ofdm: number | null };
}

function rowsOf(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

export function parseDocsisPage(html: string): DocsisPage {
  const dsRaw = extractJsValue(html, 'json_dsData');
  const usRaw = extractJsValue(html, 'json_usData');
  const num = (name: string): number | null => {
    const s = extractJsString(html, name);
    const n = s !== null ? Number(s) : Number.NaN;
    return Number.isFinite(n) ? n : null;
  };
  return {
    found: Array.isArray(dsRaw) || Array.isArray(usRaw),
    ds: rowsOf(dsRaw).map((r) => parseChannelRow(r, 'ds')).filter((c): c is DocsisChannelInput => c !== null),
    us: rowsOf(usRaw).map((r) => parseChannelRow(r, 'us')).filter((c): c is DocsisChannelInput => c !== null),
    counts: { ds: num('js_dsNums'), us: num('js_usNums'), ofdm: num('js_ofdmNums') },
  };
}

// ─── Device status page (status_status_data.php) ─────────────────────────

/** `js_UptimeSinceReboot` 'd,hh,mm' (also 'd,hh,mm,ss' and "3 days 04:12:33" variants) → seconds. */
export function parseUptime(text: string | null | undefined): number | null {
  if (text === null || text === undefined) return null;
  const s = String(text).trim();
  if (s === '') return null;
  const csv = /^(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*(\d+))?$/.exec(s);
  if (csv) {
    const [d, h, m, sec] = [csv[1], csv[2], csv[3], csv[4] ?? '0'].map(Number);
    return d * 86400 + h * 3600 + m * 60 + sec;
  }
  const days = /(\d+)\s*(?:d|days?|tage?n?)\b/i.exec(s);
  const clock = /(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(s);
  const hours = /(\d+)\s*(?:h|std|stunden?|hours?)\b/i.exec(s);
  const mins = /(\d+)\s*(?:m|min|minuten?|minutes?)\b/i.exec(s);
  const secs = /(\d+)\s*(?:s|sek|sec|sekunden?|seconds?)\b/i.exec(s);
  if (!days && !clock && !hours && !mins && !secs) return null;
  let total = days ? Number(days[1]) * 86400 : 0;
  if (clock) total += Number(clock[1]) * 3600 + Number(clock[2]) * 60 + Number(clock[3] ?? 0);
  else total += (hours ? Number(hours[1]) * 3600 : 0) + (mins ? Number(mins[1]) * 60 : 0) + (secs ? Number(secs[1]) : 0);
  return total;
}

export interface StatusPage {
  uptimeSec: number | null;
  uptimeText: string | null;
  firmware: string | null;
  hardware: string | null;
  ipv4: string | null;
  ipv6: string | null;
}

export function parseStatusPage(html: string): StatusPage {
  const uptimeText = extractJsString(html, 'js_UptimeSinceReboot');
  return {
    uptimeSec: parseUptime(uptimeText),
    uptimeText,
    firmware: extractJsString(html, 'js_FWVersion'),
    hardware: extractJsString(html, 'js_HWTypeVersion'),
    ipv4: extractJsString(html, 'js_ipv4addr'),
    ipv6: extractJsString(html, 'js_ipv6addr'),
  };
}

// ─── Overview page (overview_data.php) ────────────────────────────────────

/** MAC in any notation → 'aa:bb:cc:dd:ee:ff', null if not a MAC. */
export function normalizeMac(mac: string | null | undefined): string | null {
  if (!mac) return null;
  const hex = mac.toLowerCase().replace(/[^0-9a-f]/g, '');
  if (hex.length !== 12 || /^0+$/.test(hex)) return null;
  return hex.match(/.{2}/g)?.join(':') ?? null;
}

function parseDevice(row: unknown, kind: RouterAttachedDevice['kind']): RouterAttachedDevice | null {
  if (!isRecord(row)) return null;
  const mac = normalizeMac(str(pick(row, ['mac', 'macaddr', 'macaddress', 'hwaddr'])));
  const ipv4 = str(pick(row, ['ipv4', 'ipv4addr', 'ipaddr', 'ip', 'ipaddress']));
  const ipv6 = str(pick(row, ['ipv6', 'ipv6addr', 'ipv6address']));
  const hostName = str(pick(row, ['hostname', 'host', 'name', 'devicename']));
  if (!mac && !ipv4 && !hostName) return null;
  return {
    kind,
    hostName,
    mac,
    ipv4,
    ipv6,
    speed: str(pick(row, ['speed', 'linkrate', 'phyrate', 'rate', 'linkspeed'])),
    isThisPc: false,
  };
}

export function parseOverviewPage(html: string): RouterAttachedDevice[] {
  const lists: [string, RouterAttachedDevice['kind']][] = [
    ['json_lanAttachedDevice', 'lan'],
    ['json_primaryWlanAttachedDevice', 'wlan'],
    ['json_guestWlanAttachedDevice', 'guest'],
  ];
  const out: RouterAttachedDevice[] = [];
  for (const [name, kind] of lists) {
    for (const row of rowsOf(extractJsValue(html, name))) {
      const d = parseDevice(row, kind);
      if (d) out.push(d);
    }
  }
  return out;
}

// ─── Event log (status_event_log_data.php) ───────────────────────────────

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, mrz: 3, mär: 3, apr: 4, may: 5, mai: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, okt: 10,
  nov: 11, dec: 12, dez: 12,
};

function localTs(y: number, mo: number, d: number, h: number, mi: number, s: number): number | null {
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 60) return null;
  const t = new Date(y, mo - 1, d, h, mi, Math.min(s, 59)).getTime();
  return Number.isFinite(t) ? t : null;
}

function fullYear(y: number): number {
  return y < 100 ? 2000 + y : y;
}

/**
 * Tolerant router timestamp parser (format of this firmware is unverified): ISO, "DD.MM.YYYY HH:MM:SS",
 * "DD/MM/YYYY HH:MM:SS" (MM/DD when unambiguous), time-first variants, "Thu Jan 01 1970 01:00:00",
 * asctime, epoch s/ms. Router-local time = PC local time. Dates before 2001 ("Time Not Established")
 * or more than a day in the future → null.
 */
export function parseRouterTimestamp(text: string | number | null | undefined, now: number = Date.now()): number | null {
  if (text === null || text === undefined) return null;
  let ts: number | null = null;
  if (typeof text === 'number' || /^\s*\d{9,13}\s*$/.test(String(text))) {
    const n = Number(text);
    ts = n > 1e12 ? n : n > 1e9 ? n * 1000 : null;
  } else {
    const s = String(text).trim().replace(/\s+/g, ' ');
    if (s === '' || /not established|unknown|n\/a/i.test(s)) return null;
    let m: RegExpExecArray | null;
    if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?\s*(Z|[+-]\d{2}:?\d{2})?/.exec(s))) {
      if (m[7]) {
        const p = Date.parse(s.replace(' ', 'T'));
        ts = Number.isFinite(p) ? p : null;
      } else {
        ts = localTs(+m[1], +m[2], +m[3], +m[4], +m[5], +(m[6] ?? 0));
      }
    } else if ((m = /^(\d{1,2})([./-])(\d{1,2})\2(\d{2,4})[ ,T]+(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(s))) {
      ts = dmy(+m[1], +m[3], fullYear(+m[4]), m[2], +m[5], +m[6], +(m[7] ?? 0));
    } else if ((m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?[ ,]+(\d{1,2})([./-])(\d{1,2})\5(\d{2,4})/.exec(s))) {
      ts = dmy(+m[4], +m[6], fullYear(+m[7]), m[5], +m[1], +m[2], +(m[3] ?? 0));
    } else {
      ts = textualDate(s);
    }
  }
  if (ts === null) return null;
  if (ts < Date.UTC(2001, 0, 1) || ts > now + 86_400_000) return null;
  return ts;
}

function dmy(a: number, b: number, y: number, sep: string, h: number, mi: number, s: number): number | null {
  // '.' is always German D.M.Y; '/' and '-': D/M unless only M/D is valid (EURO firmware)
  if (sep !== '.' && a <= 12 && b > 12) return localTs(y, a, b, h, mi, s);
  return localTs(y, b, a, h, mi, s);
}

function textualDate(s: string): number | null {
  const tokens = s.toLowerCase().replace(/,/g, ' ').split(' ').filter((t) => t !== '');
  let month: number | null = null;
  let year: number | null = null;
  let day: number | null = null;
  let time: [number, number, number] | null = null;
  for (const t of tokens) {
    const tm = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(t);
    if (tm) {
      time = [+tm[1], +tm[2], +(tm[3] ?? 0)];
      continue;
    }
    const key = t.replace(/\.$/, '').slice(0, 3);
    if (month === null && MONTHS[key] !== undefined && /^[a-zä]+\.?$/.test(t)) {
      month = MONTHS[key];
      continue;
    }
    if (/^\d{4}$/.test(t)) {
      year = +t;
      continue;
    }
    if (/^\d{1,2}\.?$/.test(t) && day === null) day = parseInt(t, 10);
  }
  if (month === null || year === null || day === null) return null;
  const [h, mi, sec] = time ?? [0, 0, 0];
  return localTs(year, month, day, h, mi, sec);
}

export interface ParsedRouterLogEntry {
  timeText: string;
  /** router-side running index (dedupe), null if absent */
  index: string | null;
  level: string | null;
  /** full message as delivered (incl. CM-MAC tail) */
  message: string;
  ts: number | null;
  /** 'router:<Timestamp>-<Index>' */
  dedupeKey: string;
  raw: Record<string, unknown>;
}

const A_TIME = ['timestamp', 'time', 'datetime', 'eventtime', 'logtime', 'occurred', 'date'];
const A_INDEX = ['index', 'idx', 'eventindex', 'eventid', 'no', 'number', 'id'];
const A_LEVEL = ['priority', 'level', 'severity', 'prio', 'eventlevel', 'loglevel'];
const A_MSG = ['text', 'description', 'desc', 'message', 'msg', 'event', 'eventtext', 'eventdescription', 'log', 'details', 'detail'];

const OSSI_LEVELS = ['', 'Notfall', 'Alarm', 'Kritisch', 'Fehler', 'Warnung', 'Hinweis', 'Information', 'Debug'];

function levelText(v: unknown): string | null {
  const s = str(v);
  if (s === null) return null;
  if (/^[1-8]$/.test(s)) return `${OSSI_LEVELS[Number(s)]} (${s})`;
  return s;
}

/** Tiny stable hash for dedupe keys of entries without an index. */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function logArray(parsed: unknown): unknown[] | null {
  if (Array.isArray(parsed)) return parsed;
  if (!isRecord(parsed)) return null;
  for (const [k, v] of Object.entries(parsed)) if (normKey(k) === 'eventlog' && Array.isArray(v)) return v;
  for (const [k, v] of Object.entries(parsed)) if (normKey(k).includes('log') && Array.isArray(v)) return v;
  for (const v of Object.values(parsed)) if (Array.isArray(v)) return v;
  for (const v of Object.values(parsed)) {
    if (isRecord(v)) {
      const inner = logArray(v);
      if (inner) return inner;
    }
  }
  return null;
}

function parseLogEntry(e: unknown, now: number): ParsedRouterLogEntry | null {
  if (typeof e === 'string') {
    const message = e.trim();
    if (message === '') return null;
    return { timeText: '', index: null, level: null, message, ts: null, dedupeKey: `router:-${fnv1a(message)}`, raw: { text: e } };
  }
  if (!isRecord(e)) return null;
  const timeRaw = pick(e, A_TIME.filter((a) => a !== 'date'));
  const dateRaw = pick(e, ['date', 'eventdate', 'logdate']);
  let timeText = str(timeRaw) ?? '';
  const dateText = str(dateRaw);
  if (dateText && timeText && !timeText.includes(dateText) && /^\d{1,2}:\d{2}/.test(timeText)) timeText = `${dateText} ${timeText}`;
  else if (dateText && !timeText) timeText = dateText;
  const index = str(pick(e, A_INDEX));
  const level = levelText(pick(e, A_LEVEL));
  let message = str(pick(e, A_MSG));
  if (message === null) {
    // unknown field names: longest remaining string value
    const used = new Set([...A_TIME, ...A_INDEX, ...A_LEVEL, 'eventdate', 'logdate']);
    let best = '';
    for (const [k, v] of Object.entries(e)) {
      if (used.has(normKey(k)) || typeof v !== 'string') continue;
      if (v.trim().length > best.length) best = v.trim();
    }
    message = best === '' ? null : best;
  }
  if (message === null && timeText === '') return null;
  const msg = message ?? '';
  const ts = parseRouterTimestamp(typeof timeRaw === 'number' ? timeRaw : timeText, now);
  const dedupeKey = `router:${timeText}-${index ?? fnv1a(msg)}`;
  return { timeText, index, level, message: msg, ts, dedupeKey, raw: { ...e } };
}

/**
 * Event log body (raw JSON `{"eventLog":[{Timestamp, Index, …}]}`; tolerant to other wrappers and
 * unknown field names). Returns null when the body is not a recognizable log.
 */
export function parseEventLog(body: string, now: number = Date.now()): ParsedRouterLogEntry[] | null {
  const trimmed = body.replace(/^\uFEFF/, '').trim();
  let parsed: unknown = trimmed.startsWith('{') || trimmed.startsWith('[') ? parseJsonLenient(trimmed) : undefined;
  if (parsed === undefined) parsed = extractJsValue(trimmed, 'json_eventLog') ?? extractJsValue(trimmed, 'eventLog');
  const arr = logArray(parsed);
  if (!arr) return null;
  const out: ParsedRouterLogEntry[] = [];
  for (const e of arr) {
    const p = parseLogEntry(e, now);
    if (p) out.push(p);
  }
  return out;
}

/** Router log entry with classification (stored in events + 'router_log' snapshots). */
export interface CategorizedLogEntry extends RouterLogEntry {
  index: string | null;
  dedupeKey: string;
  /** classifier rule key, e.g. 'us_t3_timeout', 'cm_status_16' */
  key: string;
  category: LogCategory;
  cmStatusCode: number | null;
  dir: 'US' | 'DS' | '-';
  /** German short title */
  title: string;
  /** burst rule that escalated the severity, null otherwise */
  burst: string | null;
  baseSeverity: Severity;
  /** full message incl. CM-MAC tail (contains MACs – redact in exports) */
  rawMessage: string;
}

/** Strip the `;CM-MAC=…;CMTS-MAC=…;CM-QOS=…` tail for display. */
export function displayMessage(raw: string): string {
  return raw.replace(/;?\s*(?:cm|cmts)-mac\s*=.*$/i, '').replace(/\s+/g, ' ').trim();
}

/** Classify all entries (§11) and escalate bursts (T3 ≥ 3/10 min or ≥ 10/day, …). Newest first. */
export function categorizeLog(entries: readonly ParsedRouterLogEntry[]): CategorizedLogEntry[] {
  const cls = entries.map((e) => classifyLogMessage(e.message, e.level));
  const esc = escalateLogBursts(entries.map((e, i) => ({ ts: e.ts, key: cls[i].key, severity: cls[i].severity })));
  const out = entries.map((e, i): CategorizedLogEntry => ({
    ts: e.ts,
    timeText: e.timeText,
    level: e.level,
    message: displayMessage(e.message),
    category: cls[i].category,
    severity: esc[i].severity,
    index: e.index,
    dedupeKey: e.dedupeKey,
    key: cls[i].key,
    cmStatusCode: cls[i].cmStatusCode,
    dir: cls[i].dir,
    title: cls[i].title,
    burst: esc[i].burst,
    baseSeverity: cls[i].severity,
    rawMessage: e.message,
  }));
  const idxNum = (e: CategorizedLogEntry) => (e.index !== null && /^\d+$/.test(e.index) ? Number(e.index) : -1);
  return out.sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0) || idxNum(b) - idxNum(a));
}

/** MACs of a log message (for redaction checks). */
export function logMacs(entry: Pick<CategorizedLogEntry, 'rawMessage'>): string[] {
  return extractMacs(entry.rawMessage);
}
