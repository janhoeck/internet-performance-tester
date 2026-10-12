// Pure parser tests for the ARRIS Vodafone Station web UI. Uses the REAL unauthenticated probe
// fixtures (fixtures/router/*) for session-lost detection and synthetic authenticated bodies built
// from docs/research/router-api.md §b and docs/research/docsis-thresholds.md §2.2 for the data pages.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  categorizeLog,
  detectArris,
  displayMessage,
  extractCredentialCookie,
  extractJsString,
  extractJsValue,
  htmlTitle,
  isLockout,
  isLoginSuccess,
  isSessionLost,
  jsLiteralToJson,
  normalizeMac,
  parseChannelRow,
  parseDb,
  parseDocsisPage,
  parseEventLog,
  parseFrequency,
  parseJsonLenient,
  parseLoginResponse,
  parsePowerDbmv,
  parseRouterTimestamp,
  parseStartPage,
  parseStatusPage,
  parseUptime,
  parseOverviewPage,
  startPageInfo,
} from './arris-parse';

const fixture = (name: string): string => readFileSync(new URL(`../../fixtures/router/${name}`, import.meta.url), 'utf8');

// ─── Generic JS extraction ──────────────────────────────────────────────────

describe('extractJsValue', () => {
  it('parses arrays, objects, quoted strings, numbers, booleans and null', () => {
    const src = `var a = [1, 2, 3]; obj = {"x": 1}; s = 'hi'; d = "quux"; n = 42; b = true; z = null;`;
    expect(extractJsValue(src, 'a')).toEqual([1, 2, 3]);
    expect(extractJsValue(src, 'obj')).toEqual({ x: 1 });
    expect(extractJsValue(src, 's')).toBe('hi');
    expect(extractJsValue(src, 'd')).toBe('quux');
    expect(extractJsValue(src, 'n')).toBe(42);
    expect(extractJsValue(src, 'b')).toBe(true);
    expect(extractJsValue(src, 'z')).toBe(null);
    expect(extractJsValue(src, 'missing')).toBeUndefined();
  });

  it('does not match a variable that is a suffix of another', () => {
    const src = `var json_usData = [1]; var my_json_usData = [2];`;
    expect(extractJsValue(src, 'json_usData')).toEqual([1]);
  });

  it('handles multi-line arrays with nested objects and brackets in strings', () => {
    const src = `json_dsData = [\n  {"ChannelID":"5","note":"a]b"},\n  {"ChannelID":"6"}\n];`;
    expect(extractJsValue(src, 'json_dsData')).toEqual([
      { ChannelID: '5', note: 'a]b' },
      { ChannelID: '6' },
    ]);
  });

  it('extractJsString stringifies numbers', () => {
    expect(extractJsString('var js_dsNums = 24;', 'js_dsNums')).toBe('24');
    expect(extractJsString("var x = '7';", 'x')).toBe('7');
  });
});

describe('jsLiteralToJson / parseJsonLenient', () => {
  it('normalizes single quotes, unquoted keys and trailing commas', () => {
    const js = "[{ChannelID:'5', Modulation:'256QAM',},]";
    expect(parseJsonLenient(js)).toEqual([{ ChannelID: '5', Modulation: '256QAM' }]);
  });

  it('keeps separators inside strings intact', () => {
    expect(jsLiteralToJson(`{a:'1,2,3'}`)).toBe('{"a":"1,2,3"}');
  });

  it('returns undefined for unparseable input', () => {
    expect(parseJsonLenient('not json at all {')).toBeUndefined();
  });
});

// ─── Start page ───────────────────────────────────────────────────────────

const START_PAGE = `<!DOCTYPE html><html><head>
<script>
var loginUserName = 'admin';
var currentSessionId = 'fdc0a1b2c3d4e5f6a7b8c9d0e1f2a3b4';
var myIv = 'f765dead00112233';
var mySalt = 'e0b5cafe44556677';
var _ga = {};
_ga.swVersion = '01.05.069.14.EURO.PC20';
_ga.isModel6442 = 'true';
_ga.modemConnectionStatus = 'DOCSIS Online';
_ga.wanIpv4 = '0.0.0.0';
_ga.wanIpv6 = '2a02:908:f000:1ab::74f';
_ga.aftrAddress = '2a00:0:cff:84a0::3';
_ga.dsLitePlusIpv6Mode = 'true';
_ga.gwMode = 'Ipv6';
_ga.lastRebootReason = 'unknown';
_ga.lockoutTimeLeft = '0';
_ga.docsisFailoverStatus = 'none';
_ga.isDFSEnabled = 'true';
_ga.netPwReg = decodeURIComponent('%5BA-Za-z0-9%5D');
</script>
<script src="scripts/sjclCrypto.js"></script>
<link href="skins/vod/css/global.css"/>
</head><body></body></html>`;

describe('parseStartPage / startPageInfo', () => {
  const page = parseStartPage(START_PAGE);
  const info = startPageInfo(page);

  it('scrapes crypto material and the login user', () => {
    expect(page.sessionId).toBe('fdc0a1b2c3d4e5f6a7b8c9d0e1f2a3b4');
    expect(page.iv).toBe('f765dead00112233');
    expect(page.salt).toBe('e0b5cafe44556677');
    expect(page.loginUserName).toBe('admin');
    expect(page.isArris).toBe(true);
  });

  it('maps _ga vars to RouterStatus fields (DS-Lite: wanIpv4 0.0.0.0 → null)', () => {
    expect(info.vendor).toBe('ARRIS');
    expect(info.model).toBe('Vodafone Station Wi-Fi 6 (TG6442)');
    expect(info.firmware).toBe('01.05.069.14.EURO.PC20');
    expect(info.connectionStatus).toBe('DOCSIS Online');
    expect(info.wanIpv4).toBeNull();
    expect(info.wanIpv6).toBe('2a02:908:f000:1ab::74f');
    expect(info.aftrAddress).toBe('2a00:0:cff:84a0::3');
    expect(info.dsLite).toBe(true);
    expect(info.gwMode).toBe('Ipv6');
    expect(info.lockoutSec).toBe(0);
  });

  it('keeps _ga vars in extra but drops the password regex', () => {
    expect(info.extra.isDFSEnabled).toBe(true);
    expect(info.extra.swVersion).toBe('01.05.069.14.EURO.PC20');
    expect('netPwReg' in info.extra).toBe(false);
  });

  it('reads a non-zero lockout time', () => {
    const locked = startPageInfo(parseStartPage(START_PAGE.replace("lockoutTimeLeft = '0'", "lockoutTimeLeft = '42'")));
    expect(locked.lockoutSec).toBe(42);
  });

  it('infers DS-Lite from an AFTR address even without the explicit flag', () => {
    const html = START_PAGE.replace("_ga.dsLitePlusIpv6Mode = 'true';", '');
    expect(startPageInfo(parseStartPage(html)).dsLite).toBe(true);
  });

  it('detects ARRIS by signature strings', () => {
    expect(detectArris('<html>... skins/vod ...</html>')).toBe(true);
    expect(detectArris('<html>sjclCrypto.js</html>')).toBe(true);
    expect(detectArris('<html>generic router</html>')).toBe(false);
  });

  it('the real session-lost fixtures are not ARRIS start pages', () => {
    const page2 = parseStartPage(fixture('overview_data.body'));
    expect(page2.sessionId).toBeNull();
    expect(page2.isArris).toBe(false);
  });
});

// ─── Session-lost detection (real fixtures) ─────────────────────────────────

describe('isSessionLost', () => {
  it('treats the real 400 + popup body as expired', () => {
    for (const name of ['overview_data', 'status_docsis_data', 'status_event_log_data', 'status_about_data']) {
      expect(isSessionLost(400, fixture(`${name}.body`))).toBe(true);
    }
  });

  it('treats 401/403 and the login page as expired', () => {
    expect(isSessionLost(401, '')).toBe(true);
    expect(isSessionLost(403, '')).toBe(true);
    expect(isSessionLost(200, "var currentSessionId = 'abc';")).toBe(true);
  });

  it('a short HTML data page is expired when minLength is set', () => {
    expect(isSessionLost(200, 'x', { minLength: 40 })).toBe(true);
    expect(isSessionLost(200, 'x'.repeat(50), { minLength: 40 })).toBe(false);
  });

  it('a 200 with real content is not expired', () => {
    expect(isSessionLost(200, 'json_dsData = [{"ChannelID":"5"}];')).toBe(false);
  });
});

// ─── Value coercion ─────────────────────────────────────────────────────────

describe('parseDb / parsePowerDbmv / parseFrequency', () => {
  it('parseDb takes the first float, handles comma decimals and rounds float noise', () => {
    expect(parseDb('38.60000000000000142')).toBe(38.6);
    expect(parseDb('−3,5')).toBe(-3.5); // unicode minus + comma
    expect(parseDb(40)).toBe(40);
    expect(parseDb('n/a')).toBeNull();
  });

  it('parsePowerDbmv takes the dBmV part of "dBmV/dBµV"', () => {
    expect(parsePowerDbmv('-3.5/56.5')).toBe(-3.5);
    expect(parsePowerDbmv('-1.5 dBmV/58.5 dBuV')).toBe(-1.5);
    expect(parsePowerDbmv('49/109')).toBe(49);
    expect(parsePowerDbmv(5)).toBe(5);
  });

  it('parsePowerDbmv converts a lone dBµV value', () => {
    expect(parsePowerDbmv('58.5 dBuV')).toBe(-1.5);
  });

  it('parseFrequency handles numbers, Hz and "start~end" blocks', () => {
    expect(parseFrequency(602)).toEqual({ mhz: 602, text: null });
    expect(parseFrequency(602000000)).toEqual({ mhz: 602, text: null });
    expect(parseFrequency('151~324')).toEqual({ mhz: 151, text: '151~324' });
    expect(parseFrequency('-')).toEqual({ mhz: null, text: null });
  });
});

// ─── DOCSIS page ────────────────────────────────────────────────────────────

const DOCSIS_PAGE = `
js_dsNums = '2'; js_usNums = '1'; js_ofdmNums = '1';
json_dsData = [
  {"ChannelType":"OFDM","Modulation":"1024QAM","Frequency":"151~324","ChannelID":"33","PowerLevel":"-3.5/56.5","SNRLevel":"40","LockStatus":"Locked"},
  {"ChannelType":"SC-QAM","Frequency":602,"PowerLevel":"-3/57","SNRLevel":38.60000000000000142,"Modulation":"256QAM","ChannelID":"5","LockStatus":"Locked"}
];
json_usData = [
  {"Frequency":36,"PowerLevel":"49/109","ChannelType":"SC-QAM","ChannelID":"4","Modulation":"64QAM","LockStatus":"ACTIVE"}
];
`;

describe('parseDocsisPage / parseChannelRow', () => {
  const page = parseDocsisPage(DOCSIS_PAGE);

  it('reads channel counts', () => {
    expect(page.counts).toEqual({ ds: 2, us: 1, ofdm: 1 });
  });

  it('parses downstream OFDM + SC-QAM channels', () => {
    expect(page.found).toBe(true);
    const ofdm = page.ds.find((c) => c.type === 'OFDM');
    expect(ofdm).toMatchObject({ dir: 'ds', channelId: 33, type: 'OFDM', frequencyMHz: 151, frequencyText: '151~324', powerDbmv: -3.5, snrDb: 40, modulation: '1024QAM', locked: true });
    const scqam = page.ds.find((c) => c.type === 'SC-QAM');
    expect(scqam).toMatchObject({ dir: 'ds', channelId: 5, frequencyMHz: 602, powerDbmv: -3, snrDb: 38.6, modulation: '256QAM', locked: true });
  });

  it('parses the upstream channel (no SNR, ACTIVE = locked)', () => {
    expect(page.us[0]).toMatchObject({ dir: 'us', channelId: 4, frequencyMHz: 36, powerDbmv: 49, snrDb: null, modulation: '64QAM', locked: true });
  });

  it('has no codeword counters (Vodafone Station)', () => {
    expect(page.ds[0].corrected).toBeNull();
    expect(page.ds[0].uncorrectable).toBeNull();
  });

  it('maps an unlocked ChannelID 0 row (DS) to locked=false', () => {
    const c = parseChannelRow({ ChannelID: '0', ChannelType: 'SC-QAM', Modulation: '64QAM', LockStatus: 'NEIN' }, 'ds');
    expect(c?.locked).toBe(false);
  });

  it('tolerates alias field names (SNR, RxPower, Ranging Status)', () => {
    const c = parseChannelRow({ 'Channel ID': '7', chType: 'SC-QAM', mod: '256QAM', freq: '690', RxPower: '2.5', SNR: '34', 'Ranging Status': 'SUCCESS' }, 'us');
    expect(c).toMatchObject({ channelId: 7, powerDbmv: 2.5, locked: true });
  });
});

// ─── Status / overview / uptime ─────────────────────────────────────────────

describe('parseUptime', () => {
  it('parses the "D,HH,MM" format', () => {
    expect(parseUptime('3,04,12')).toBe(3 * 86400 + 4 * 3600 + 12 * 60);
  });
  it('parses "D,HH,MM,SS"', () => {
    expect(parseUptime('0,00,01,30')).toBe(90);
  });
  it('parses "3 days 04:12:33"', () => {
    expect(parseUptime('3 days 04:12:33')).toBe(3 * 86400 + 4 * 3600 + 12 * 60 + 33);
  });
  it('returns null for junk', () => {
    expect(parseUptime('')).toBeNull();
    expect(parseUptime(null)).toBeNull();
  });
});

describe('parseStatusPage', () => {
  it('reads firmware, hardware and uptime', () => {
    const html = `var js_FWVersion = '01.05.069.14'; var js_HWTypeVersion = '6442'; var js_UptimeSinceReboot = '1,02,03';`;
    expect(parseStatusPage(html)).toMatchObject({ firmware: '01.05.069.14', hardware: '6442', uptimeSec: 86400 + 2 * 3600 + 3 * 60 });
  });
});

describe('parseOverviewPage / normalizeMac', () => {
  it('parses LAN + WLAN devices with speed/MAC/host', () => {
    const html = `
      json_lanAttachedDevice = [{"Index":"1","Speed":"1000 Mbps","HostName":"Jan-PC","MAC":"AA-BB-CC-DD-EE-FF","IPv4":"192.168.0.23","IPv6":"-"}];
      json_primaryWlanAttachedDevice = [{"Index":"1","LinkRate":"866","HostName":"phone","MAC":"11:22:33:44:55:66","IPv4":"192.168.0.44"}];
    `;
    const devices = parseOverviewPage(html);
    expect(devices).toHaveLength(2);
    expect(devices[0]).toMatchObject({ kind: 'lan', hostName: 'Jan-PC', mac: 'aa:bb:cc:dd:ee:ff', ipv4: '192.168.0.23', speed: '1000 Mbps', isThisPc: false });
    expect(devices[1]).toMatchObject({ kind: 'wlan', hostName: 'phone', speed: '866' });
  });

  it('normalizeMac canonicalizes separators and rejects non-MACs', () => {
    expect(normalizeMac('AA-BB-CC-DD-EE-FF')).toBe('aa:bb:cc:dd:ee:ff');
    expect(normalizeMac('aabbccddeeff')).toBe('aa:bb:cc:dd:ee:ff');
    expect(normalizeMac('00:00:00:00:00:00')).toBeNull();
    expect(normalizeMac('nope')).toBeNull();
  });
});

// ─── Login response ─────────────────────────────────────────────────────────

describe('parseLoginResponse / isLoginSuccess / isLockout', () => {
  it('reads p_status, p_waitTime and encryptData', () => {
    const r = parseLoginResponse('{"p_status":"AdminMatch","encryptData":"deadbeef"}');
    expect(r).toEqual({ pStatus: 'AdminMatch', waitSec: null, encryptData: 'deadbeef' });
  });

  it('reads a lockout with a wait time', () => {
    expect(parseLoginResponse('{"p_status":"Lockout","p_waitTime":"120"}')).toEqual({ pStatus: 'Lockout', waitSec: 120, encryptData: null });
  });

  it('returns null for a non-JSON body', () => {
    expect(parseLoginResponse('<html>oops</html>')).toBeNull();
  });

  it('isLoginSuccess accepts Match/Default but rejects failure-like statuses', () => {
    expect(isLoginSuccess('AdminMatch')).toBe(true);
    expect(isLoginSuccess('Match')).toBe(true);
    expect(isLoginSuccess('Default')).toBe(true);
    expect(isLoginSuccess('MisMatch')).toBe(false);
    expect(isLoginSuccess('NoMatch')).toBe(false);
    expect(isLoginSuccess('Error')).toBe(false);
    expect(isLoginSuccess(null)).toBe(false);
  });

  it('isLockout detects the lockout status', () => {
    expect(isLockout('Lockout')).toBe(true);
    expect(isLockout('AdminMatch')).toBe(false);
  });
});

describe('extractCredentialCookie', () => {
  it('reads the credential cookie from base_95x.js', () => {
    expect(extractCredentialCookie(`function x(){ createCookie("credential", "abc123=="); }`)).toBe('abc123==');
    expect(extractCredentialCookie('no cookie here')).toBeNull();
  });
});

// ─── Event log ──────────────────────────────────────────────────────────────

describe('parseEventLog / categorizeLog', () => {
  it('parses {"eventLog":[…]} with Timestamp/Index and tolerant message fields', () => {
    const body = JSON.stringify({
      eventLog: [
        { Timestamp: '01.10.2026 20:15:00', Index: '7', Priority: '3', Text: 'No Ranging Response received - T3 time-out;CM-MAC=aa:bb:cc:dd:ee:ff;CMTS-MAC=11:22:33:44:55:66;' },
        { Timestamp: '01.10.2026 20:15:05', Index: '8', Priority: '6', Docsis: 'Honoring MDD; IP provisioning mode = IPv6' },
      ],
    });
    const entries = parseEventLog(body);
    expect(entries).not.toBeNull();
    expect(entries).toHaveLength(2);
    const t3 = entries!.find((e) => e.index === '7');
    expect(t3?.dedupeKey).toBe('router:01.10.2026 20:15:00-7');
    expect(t3?.message).toContain('T3 time-out');
    expect(t3?.ts).not.toBeNull();
  });

  it('falls back to unknown field names (longest string) and other wrappers', () => {
    const body = JSON.stringify({ data: [{ t: '01.10.2026 10:00:00', n: '1', whatever: 'T4 time-out happened on upstream' }] });
    const entries = parseEventLog(body);
    expect(entries?.[0].message).toContain('T4 time-out');
  });

  it('accepts a JS-var wrapped log', () => {
    const body = `json_eventLog = [{"Timestamp":"01.10.2026 10:00:00","Index":"1","Text":"T2 time-out"}];`;
    expect(parseEventLog(body)?.[0].message).toContain('T2 time-out');
  });

  it('returns null for a body that is not a log', () => {
    expect(parseEventLog('<html>not a log</html>')).toBeNull();
  });

  it('categorizes + sorts newest first and keeps the raw message for redaction', () => {
    const entries = parseEventLog(
      JSON.stringify({
        eventLog: [
          { Timestamp: '01.10.2026 20:15:00', Index: '7', Text: 'No Ranging Response received - T3 time-out;CM-MAC=aa:bb:cc:dd:ee:ff;' },
          { Timestamp: '01.10.2026 20:16:00', Index: '8', Text: 'CM-STATUS message sent. Event Type Code: 16; Chan ID: 32;' },
        ],
      }),
    )!;
    const cat = categorizeLog(entries);
    expect(cat[0].index).toBe('8'); // newest first
    expect(cat[0].key).toBe('cm_status_16');
    expect(cat[1].key).toBe('us_t3_timeout');
    expect(cat[1].message).not.toContain('CM-MAC'); // display message strips the MAC tail
    expect(cat[1].rawMessage).toContain('CM-MAC'); // raw kept for redaction
  });
});

describe('parseRouterTimestamp', () => {
  const REF_NOW = new Date(2026, 9, 20, 0, 0, 0).getTime();
  it('parses ISO, D.M.Y and D/M/Y', () => {
    expect(parseRouterTimestamp('2026-10-01T20:15:00', REF_NOW)).toBe(new Date(2026, 9, 1, 20, 15, 0).getTime());
    expect(parseRouterTimestamp('01.10.2026 20:15:00', REF_NOW)).toBe(new Date(2026, 9, 1, 20, 15, 0).getTime());
    // unambiguous day > 12 → D/M/Y (EURO firmware)
    expect(parseRouterTimestamp('13/10/2026 08:00:00', REF_NOW)).toBe(new Date(2026, 9, 13, 8, 0, 0).getTime());
  });

  it('rejects a timestamp more than a day in the future', () => {
    expect(parseRouterTimestamp('13/10/2026 08:00:00', new Date(2026, 9, 9).getTime())).toBeNull();
  });

  it('parses epoch seconds and milliseconds', () => {
    const ms = Date.UTC(2026, 0, 2, 3, 4, 5);
    expect(parseRouterTimestamp(ms)).toBe(ms);
    expect(parseRouterTimestamp(Math.floor(ms / 1000))).toBe(ms);
  });

  it('rejects "Time Not Established" / pre-2001 / far-future', () => {
    expect(parseRouterTimestamp('Time Not Established')).toBeNull();
    expect(parseRouterTimestamp('01.01.1970 01:00:00')).toBeNull();
    expect(parseRouterTimestamp('01.10.2099 00:00:00', Date.UTC(2026, 0, 1))).toBeNull();
  });
});

describe('displayMessage / htmlTitle', () => {
  it('strips the CM-MAC tail', () => {
    expect(displayMessage('T3 time-out;CM-MAC=aa:bb:cc:dd:ee:ff;CMTS-MAC=11:22:33:44:55:66;')).toBe('T3 time-out');
  });
  it('reads a page title', () => {
    expect(htmlTitle('<html><head><title>404 Not Found</title></head></html>')).toBe('404 Not Found');
    expect(htmlTitle('<html></html>')).toBeNull();
  });
});
