# ARRIS TG6442 / TG3442DE (Vodafone Station) — Web API Adapter Spec

Target device on this LAN: **ARRIS Vodafone Station, model 6442** (`_ga.isModel6442='true'`),
firmware `01.05.069.14.EURO.PC20`, at **http://192.168.0.1** (NOT 192.168.0.2 — nothing answers there).
HTTP server is PHP with a `PHPSESSID` cookie, `Server: null` header, strict CSP, HSTS. HTTPS → 403 (lighttpd).

The firmware is the standard **ARRIS PHP GUI** (same codebase as TG3442DE). All login/crypto
behaviour below was **confirmed byte-exact** by running the router's own `sjcl.js` + `scripts/sjclCrypto.js`
in a Node `vm` sandbox and comparing to a `node:crypto` re-implementation (see `verify.mjs`, all 9 checks pass).
Endpoint names/field names were confirmed against the router (unauthenticated probes) and against two
independent open-source clients:
- `totev/vodafone-station-cli` (TypeScript; `src/modem/tools/crypto.ts`, `html-parser.ts`, `arris-modem.ts`)
- `fsck-block/arris-tg3442de-exporter` (Python; `tg3442de.py` + extractors) — **TG3442DE-specific, the closest match.**

---

## (a) VERIFIED login algorithm

### Crypto primitives (VERIFIED byte-exact vs router's sjcl.js)

| Wrapper | node:crypto equivalent |
|---|---|
| `sjclPbkdf2(pw, saltHex, 1000, 128)` | `pbkdf2Sync(pw, Buffer.from(saltHex,'hex'), 1000, 16, 'sha256')` → hex |
| `sjclCCMencrypt(keyHex, pt, ivHex, aad, 128)` | `aes-128-ccm`, nonce = `Buffer.from(ivHex,'hex')` (8 bytes), `authTagLength:16`, `setAAD(utf8(aad),{plaintextLength})` → `hex(ciphertext‖tag)` |
| `sjclCCMdecrypt(keyHex, ctHex, ivHex, aad, 128)` | `aes-128-ccm` decipher, split last 16 bytes = tag, `setAAD`, `setAuthTag`, verify in `final()` → utf8 |

Critical details that make it byte-exact:
- **salt is HEX-DECODED** before PBKDF2 (`Buffer.from(salt,'hex')`), 1000 iterations, **16-byte key** (128 bit).
- PBKDF2 PRF = **HMAC-SHA256** (sjcl default).
- IV `myIv` is **8 bytes** (16 hex chars) → used directly as the CCM nonce (L=7). Do not pad.
- AAD is the UTF-8 bytes of the string (`loginPassword` at login, `nonce` for the csrf response, `ARRIS` post-login).
- Output / input is `hex(ciphertext ‖ 16-byte tag)`.

Fixed test vector (password `test-password`, salt `badd6f0848f968df`, iv `c1697be73d452e75`):
- derived key = `249082069e5104592beaece2a76446dd`
- login plaintext `{"Password": "test-password", "Nonce": "df59fc3de28c9f18d95a162836aa298b"}` + aad `loginPassword`
  → cipher `7e66d67ae1de39bb88f060cb940d0eb947f973841242ffe71b788a152dfdb9f5e3605e13574376e579106557a5e2242fd6a8ea912afec352f1be6ad50bd6b752586bef2d4e15b625080ec4d05c7a793bea746519668b7f528fe1`

### Login sequence (VERIFIED from router JS `login()` in base_95x.js + fsck exporter)

1. **GET `/`** with a cookie jar enabled. Scrape three JS vars from the HTML `<head>`:
   - `var currentSessionId = '<32 hex>';`  → the Nonce
   - `var myIv = '<16 hex>';`
   - `var mySalt = '<16 hex>';`
   Regexes (tolerant to `'`/`"`): `/var currentSessionId = ['"](?<v>[0-9a-f]+)['"];/`, `myIv`, `mySalt`.
   The same page also exposes **unauthenticated** status (see section e), incl. `_ga.lockoutTimeLeft`.
2. `key = pbkdf2(password, hexDecode(mySalt), 1000, 16, sha256)`.
3. `plaintext = JSON.stringify({Password: password, Nonce: currentSessionId})`
   — **must serialize with a space after `:` and `,`** to match the router (`{"Password": "…", "Nonce": "…"}`).
   The browser builds this string literally; `JSON.stringify` with default separators does NOT add the space,
   so **build the string manually**: `` `{"Password": "${pw}", "Nonce": "${sid}"}` `` (password is validated by `_ga.netPwReg`
   and will not contain `"` in practice, but prefer manual concatenation exactly like the router).
4. `EncryptData = sjclCCMencrypt(key, plaintext, myIv, "loginPassword", 128)`.
5. **POST `/php/ajaxSet_Password.php`**, `Content-Type: application/json`, body:
   `{"EncryptData":"<hex>","Name":"admin","AuthData":"loginPassword"}`.
6. Response JSON fields:
   - `p_status`: success when it **contains `"Match"`** (admin → `"AdminMatch"`) or equals `"Default"`.
     `"Lockout"` → locked; `p_waitTime` = seconds remaining.
   - `encryptData`: `sjclCCMdecrypt(key, encryptData, myIv, "nonce", 128)` → **csrf_nonce** (32-hex string).
     (fsck takes first 32 bytes without tag-verify; our faithful impl verifies the tag with aad `nonce` — both yield the same nonce.)
7. Set session headers for all later requests:
   `csrfNonce: <csrf_nonce>`, `X-Requested-With: XMLHttpRequest`, `Origin: http://192.168.0.1`,
   and `Referer: http://192.168.0.1/` (browser sends a page-specific Referer; a generic one works).
8. **POST `/php/ajaxSet_Session.php`** (no body) to activate the session. (Browser also calls this; returns `{LoginStatus:"yes"|"no"}`.)
9. The `PHPSESSID` cookie from the jar + the `csrfNonce` header authorize subsequent GETs.
   The `credential=` cookie from `/base_95x.js` is **NOT required** (fsck omits it and it works).

### Logout
**POST `/php/logout.php`** (`Content-Type: application/x-www-form-urlencoded`, no body). Always call on shutdown to free the single session slot.

---

## (b) Data endpoints — exact requests & response formats

All data endpoints are **GET**, require the authenticated session (PHPSESSID + csrfNonce header),
and return **HTTP 200** with a body that is either HTML embedding `var …=…;` JS assignments, or (event log) raw JSON.
**Unauthenticated → HTTP 400** with body `…alert(xlate("PAGE_OVERVIEW_SESSION_LOST_POPUP_TEXT")); location.href="../index.php";…` (VERIFIED by probe).
The browser also appends a cache-buster `?_n=<5 random digits>` to every request; it is **optional** (fsck omits it).

| Endpoint | Auth | Format | Key variables / fields |
|---|---|---|---|
| `GET /` | no | HTML+JS | see section (e) |
| `GET /php/overview_data.php` | yes | HTML+JS | **VERIFIED** |
| `GET /php/status_status_data.php` | yes | HTML+JS | **VERIFIED** (serial/fw/hw/uptime) |
| `GET /php/status_docsis_data.php` | yes | HTML+JS | **VERIFIED** (channels) |
| `GET /php/status_event_log_data.php?{"eventLogRecord":{}}` | yes | **raw JSON** | **VERIFIED** (event log) |
| `GET /php/status_lan_data.php` | yes | HTML+JS | exists (probe=400 unauth); fields INFERRED |
| `GET /php/status_voice_data.php` | yes | HTML+JS | exists (probe=400 unauth); fields INFERRED |
| `GET /php/status_about_data.php` | yes | HTML+JS | exists (probe=400 unauth); fields INFERRED |

### DOCSIS — `status_docsis_data.php` (VERIFIED)
Body contains JS assignments. Extract and `JSON.parse`:
- `json_dsData = [ … ];` — downstream channels (SC-QAM **and** OFDM mixed in one array)
- `json_usData = [ … ];` — upstream channels (SC-QAM **and** OFDMA mixed)
- counts: `js_dsNums='..'`, `js_usNums='..'`, `js_ofdmNums='..'` (strings)

Each channel object (VERIFIED field names):
```
{ "ChannelID":"5", "ChannelType":"SC-QAM"|"OFDM"|"OFDMA",
  "Modulation":"256QAM"|"4096QAM"|"QPSK"|…, "Frequency":<number|"start~end">,
  "PowerLevel":"<dBmV>/<dBuV>", "SNRLevel":"<dB>" (downstream only),
  "LockStatus":"ACTIVE"|"Locked"|"SUCCESS"(=locked) | other(=unlocked) }
```
Parsing: `Frequency` is a plain number for SC-QAM, or `"start~end"` for OFDM/OFDMA → split on `~`, take `[0]`.
`PowerLevel` → split on `/`, `[0]` = dBmV (the meaningful one), `[1]` = dBuV.
**Correctable/uncorrectable codeword counts are NOT emitted by either reference client** → whether
`json_dsData` entries carry them on this firmware is **UNCERTAIN/INFERRED**; parse defensively (map
any of `CorrectedErrors`/`Correcteds`/`UncorrectableErrors`/`Uncorrectables`/`RxMER` if present, else null).

### Event log — `status_event_log_data.php?{"eventLogRecord":{}}` (VERIFIED)
The whole response body is **JSON** (not JS-var HTML). Shape:
```
{ "eventLog": [ { "Timestamp":"<ts>", "Index":"<n>", … }, … ] }
```
`Timestamp` + `Index` are VERIFIED (used as the dedupe key `"{Timestamp}-{Index}"`).
Additional per-entry fields (`Priority`/`Level`, `Text`/`Description`, `Docsis`…) and the **Timestamp string format**
are **INFERRED/UNCERTAIN** — ARRIS DOCSIS logs are typically `"Thu Jan 01 1970 01:00:00"`-style or
`"DD/MM/YYYY HH:MM:SS"`; capture the raw string and parse tolerantly. This endpoint is **the key diagnostic
feed** for the user's link-drop problem (DOCSIS T3/T4 timeouts, SYNC loss, downstream/upstream lock loss).

### Device/system — `status_status_data.php` (VERIFIED)
JS vars:
- `var js_SerialNumber = '…';`
- `var js_FWVersion = '…';`
- `var js_HWTypeVersion = '…';`
- `var js_UptimeSinceReboot = 'DD,HH,MM';` → seconds = `DD*86400 + HH*3600 + MM*60`

### Overview / attached devices — `overview_data.php` (VERIFIED)
JS vars → `JSON.parse`:
- `json_lanAttachedDevice = [ {Index, Speed:"1000 Mbps"|"100 Mbps"|"-", HostName, MAC, IPv4, IPv6}, … ];`
- `json_primaryWlanAttachedDevice = [ {Index, LinkRate, HostName, MAC, IPv4, IPv6}, … ];`
- `json_guestWlanAttachedDevice = [ … ];`
- counts: `js_lanHostNums`, `js_primaryWlanHostNums`, `js_guestWlanHostNums` (quoted strings)
- flags: `js_isCmOperational`, `js_wifiEnable`, `js_guestWifiEnable`, `js_wpsEnable`, `js_scheduleEnable`

No CPU/memory metric is exposed by either reference client (not available on this GUI). Traffic byte counters:
none exposed via this PHP GUI (INFERRED — ARRIS GUI shows per-client link speed, not byte totals).

---

## (c) Robust parsing strategy (firmware-tolerant)

Generic extractor, order matters (try JSON array/object first, then quoted scalar):
```
function jsVarRaw(html, name) {                 // var X = <raw>;  → raw up to the ; at line end
  const m = html.match(new RegExp(name + "\\s*=\\s*(.+?);\\s*(?:\\r?\\n|$)"));
  return m ? m[1].trim() : null;
}
function jsArray(html, name)  { const r = jsVarRaw(html,name); if(!r) return []; try { return JSON.parse(r); } catch { return []; } }
function jsScalar(html, name) { const m = html.match(new RegExp(name + "\\s*=\\s*['\"]([^'\"]*)['\"]")); return m ? m[1] : null; }
```
- Match **`json_*` / `js_*` / `var js_*`** assignments generically; never hard-code array indices.
- Map channel fields **case-and-name-tolerantly** (accept `SNRLevel`|`SNR`, `PowerLevel`|`RxPower`, lock synonyms above).
- Treat every value as possibly-string; coerce numbers with `parseFloat`, guard `NaN`.
- If a `*_data.php` body is `< ~20` bytes or contains `SESSION_LOST`/`index.php`, treat as **session expired** → re-login.
- Event log: `JSON.parse` the whole body; fall back to `json_eventLog`/`eventLog` key lookup if wrapped.
- Keep a per-endpoint "last good" cache so a transient parse miss doesn't blank the UI.

---

## (d) Polling & session recommendations

- **One shared session**, reused across polls. Do **not** log in per request.
- Suggested intervals: DOCSIS `status_docsis_data.php` every **30–60 s**; event log every **60 s**
  (fsck notes it is slowish — don't go sub-minute); overview/device every **60–120 s**.
- The GUI session idle timeout is **`logoutTime = 600000` ms (10 min)** and `nonActiveSession='1'`.
  Polling faster than 10 min keeps it alive; also re-`POST ajaxSet_Session.php` is unnecessary if polling.
- **Single-session firmware (INFERRED, NOT tested):** ARRIS typically allows one admin session. An API login
  **may evict the user's browser login**, and the user logging in via browser **may kill the API session**
  (next poll returns 400). Handle gracefully: on 400/401 or `SESSION_LOST` body → mark disconnected, re-login
  with **exponential backoff** (e.g. 5s → 30s → 60s, cap 5 min). Surface a clear "Router-Login aktiv?" state in the UI.
- **Lockout:** repeated bad passwords → `p_status:"Lockout"` + `p_waitTime` (seconds). Also readable **unauthenticated**
  from `/` as `_ga.lockoutTimeLeft`. On lockout: stop retrying, wait `p_waitTime`, show a warning. **Never** hammer the login.
- Always `POST /php/logout.php` on adapter shutdown so the browser session is freed.
- Keep traffic tiny; never touch reboot/config endpoints (`ajaxSet_status_restart.php`, any `*Set*` write).

---

## (e) Available UNAUTHENTICATED from the start page `GET /`

Scraped from the login HTML (no session needed) — useful for a always-on "router reachable" panel and
for reading failover/lockout without logging in:
- `_ga.swVersion` (`01.05.069.14.EURO.PC20`), `_ga.isModel6442`
- `_ga.modemConnectionStatus` (`DOCSIS Online`) — **cheap health signal, poll this while logged out**
- `_ga.docsisFailoverEnabled`, `_ga.docsisFailoverStatus` (`none`) — DOCSIS→LTE failover state
- `_ga.wanIpv4` (`0.0.0.0` — DS-Lite, no public v4), `_ga.wanIpv6`, `_ga.aftrAddress`, `_ga.dsLitePlusIpv6Mode`, `_ga.gwMode` (`Ipv6`)
- `_ga.lastRebootReason`, `_ga.lockoutTimeLeft`, `_ga.isWifiEnabled`
- crypto material `currentSessionId`, `myIv`, `mySalt` (rotate per GET)

---

## Files in this folder
- `SPEC.md` — this report
- `arris-crypto.mjs` — reference node:crypto impl (identical to the TS below)
- `verify.mjs` — vm-sandbox byte-exact verification harness (run: `node verify.mjs` → `allOk:true`)
- `testvectors.json` — fixed inputs/expected outputs
- `downloaded/sjcl.js` — router's own sjcl (GET from http://192.168.0.1/scripts/sjcl.js)
- `downloaded/fsck-exporter/*.py` — reference TG3442DE client source
- `probes/*` — unauthenticated GET probe responses

## Final verified TypeScript (node:crypto, no deps)
```ts
import { pbkdf2Sync, createCipheriv, createDecipheriv } from 'node:crypto';

/** sjclPbkdf2: salt is a HEX string that is hex-decoded; 1000 iters; 128-bit key; HMAC-SHA256. */
export function sjclPbkdf2(password: string, saltHex: string, iterations = 1000, keySizeBits = 128): string {
  return pbkdf2Sync(password, Buffer.from(saltHex, 'hex'), iterations, keySizeBits / 8, 'sha256').toString('hex');
}

/** AES-128-CCM encrypt. ivHex = 8-byte nonce; aad = utf8 string; returns hex(ciphertext‖tag16). */
export function sjclCCMencrypt(keyHex: string, plaintext: string, ivHex: string, aad: string, tagLenBits = 128): string {
  const authTagLength = tagLenBits / 8;
  const pt = Buffer.from(plaintext, 'utf8');
  const cipher = createCipheriv('aes-128-ccm', Buffer.from(keyHex, 'hex'), Buffer.from(ivHex, 'hex'), { authTagLength });
  cipher.setAAD(Buffer.from(aad, 'utf8'), { plaintextLength: pt.length });
  const ct = Buffer.concat([cipher.update(pt), cipher.final()]);
  return Buffer.concat([ct, cipher.getAuthTag()]).toString('hex');
}

/** AES-128-CCM decrypt of hex(ciphertext‖tag16). Verifies the tag with the given aad. */
export function sjclCCMdecrypt(keyHex: string, cipherHex: string, ivHex: string, aad: string, tagLenBits = 128): string {
  const authTagLength = tagLenBits / 8;
  const buf = Buffer.from(cipherHex, 'hex');
  const ct = buf.subarray(0, buf.length - authTagLength);
  const tag = buf.subarray(buf.length - authTagLength);
  const d = createDecipheriv('aes-128-ccm', Buffer.from(keyHex, 'hex'), Buffer.from(ivHex, 'hex'), { authTagLength });
  d.setAAD(Buffer.from(aad, 'utf8'), { plaintextLength: ct.length });
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}

/** Build login POST body for /php/ajaxSet_Password.php. */
export function buildLogin(password: string, sessionId: string, saltHex: string, ivHex: string) {
  const key = sjclPbkdf2(password, saltHex);
  const plaintext = `{"Password": "${password}", "Nonce": "${sessionId}"}`; // space after : and , (router-exact)
  const EncryptData = sjclCCMencrypt(key, plaintext, ivHex, 'loginPassword');
  return { key, body: { EncryptData, Name: 'admin', AuthData: 'loginPassword' } };
}
/** Decrypt the login response's encryptData → csrf_nonce (aad 'nonce'). */
export function readCsrfNonce(key: string, encryptDataHex: string, ivHex: string): string {
  return sjclCCMdecrypt(key, encryptDataHex, ivHex, 'nonce');
}
```
