# METHOD.md — Measurement methodology & thresholds for the long-running gaming-focused internet diagnostics tool

Research date: 2026-10-09 (machine: Win11 Pro 26200, de-DE, Node 22.16.0, Vodafone Kabel DS-Lite, ARRIS TG6442 at 192.168.0.1).
Audience: implementers of the Next.js UI + Node "probe engine" (tsx) + SQLite.

Legend used throughout:
- **[VERIFIED]** = measured/executed on this machine during this research (2026-10-09, ~12:40–13:05 UTC).
- **[SOURCE]** = taken from a cited primary source (URL in section 16).
- **[RECOMMENDATION]** = design decision proposed by this research (sensible default, configurable).
- **[UNCERTAIN]** = could not be verified; treat as assumption.

Scratch artefacts (all under `.../scratchpad/research/method/`):
- `scripts/analysis.js` — runnable reference implementations of every algorithm in this document (self-test: `node analysis.js`).
- `koffitest/icmp_ref.js` — verified ICMP module (v4+v6, TTL, no admin) (`UV_THREADPOOL_SIZE=64 node icmp_ref.js`).
- `scripts/sqlite_sizing.js`, `scripts/sketch_test.js`, `scripts/udp_probe_test.js`, `scripts/pingspawn.js`, `scripts/tracertspawn.js`.
- `cfverify/` — raw Cloudflare response headers (`h_down0_*.txt`, `h_down5M.txt`, `h_up1M.txt`), `meta.json`, `locations.json`, LibreSpeed and M-Lab listings.
- `cf_src/` — downloaded source of `cloudflare/speedtest` (AIM scoring, bandwidth engine).

---------------------------------------------------------------------------------------------------

## 0. Key decisions (TL;DR)

1. **Probe primitive: ICMP via `iphlpapi.dll` (`IcmpSendEcho` / `Icmp6SendEcho2`) through `koffi@3.3.1`** — no admin, no `ping.exe` spawning, per-probe TTL control, RTT also for TTL-expired replies (MTR-style per-hop RTT), status codes, IPv4+IPv6. [VERIFIED] **Must** start the engine with `UV_THREADPOOL_SIZE=64` set in the environment *before* Node starts (setting `process.env` inside the script does NOT work on Windows — verified: with 4 default threads, 8 timing-out probes blocked all other probes for 1.7 s). Fallback: `ping.exe` (output is OEM codepage CP850, line-buffered, German).
2. **Layered target model for this connection** (auto-discovered, observed addresses below): Router LAN (v4+v6) → CMTS/first ISP hop (IPv6 hop 2) → Vodafone core (IPv6 hop 3) → **DS-Lite AFTR** (IPv6 address from router start page `_ga.aftrAddress`; answers ICMPv6 echo [VERIFIED]) → first public IPv4 hop after the AFTR (IPv4 hop 3) → anycast v4+v6 (1.1.1.1/2606:4700:4700::1111, 8.8.8.8/2001:4860:4860::8888) → user game servers. 1 Hz each. Fault localisation = which layers degrade *in the same probe round*.
3. **Jitter shown to the user = MASD** (mean absolute difference of consecutive successful RTTs; same as Cloudflare speed test and PingPlotter). Additionally **PDV tail = p99 − p50** (RFC 5481 style) for "spikes", and an RFC 3550 smoothed jitter for live gauges only. Never stddev as headline.
4. **Loss classification by run length** at 1 Hz: 1 = isolated, 2 = burst, ≥3 consecutive (≥ ~3 s) = outage; scope by simultaneity across targets (gateway lost too ⇒ LAN/link; only IPv4 ⇒ AFTR/CGNAT; one target only ⇒ target-specific/ICMP policy). Report Gilbert burstiness (clp/ulp), RFC 3611 bursts (Gmin = 16), Wilson 95 % CI for loss %. Suspend/standby gaps are NOT loss.
5. **Spike detection = robust baseline** (rolling 10-min median + 1.4826·MAD), spike if `rtt > median + max(5σ, 25 ms)` or `rtt ≥ 200 ms`; merge into episodes (gap ≤ 2 s); periodicity via autocorrelation of the 1-s spike series (significance 4/√n) → e.g. "every 60 s".
6. **MTR interpretation** = loss/latency only counts if it **persists to all later hops incl. destination** (Steenbergen; pathping); implemented as `persistentLoss(hop) = min(loss of this and all later hops)`, `linkLoss = persistent(hop) − persistent(prev)`, `nodeLoss = loss(hop) − persistent(hop)` (reproduces Microsoft's pathping example exactly). Plus time-correlation: a hop's spikes are real only if the destination spikes in the same round.
7. **Bufferbloat test** (on demand + every 6 h, off while "gaming mode"): 10 s idle, 15 s download (6 parallel streams), 15 s upload (4–6 streams) against speed.cloudflare.com, latency probes every 200 ms to several layers; ignore first 3–4 s; grade by **max(mean_loaded − mean_idle) over DL/UL** with Waveform scale **A+ <5, A <30, B <60, C <200, D <400, F ≥400 ms** [SOURCE: Waveform live bundle]. Per-layer probes show *where* the queue is (LAN link vs. DOCSIS upstream).
8. **Cloudflare endpoints verified**: `GET https://speed.cloudflare.com/__down?bytes=N`, `POST https://speed.cloudflare.com/__up`; server time = sum of `cfSpeedEdge` + `cfSpeedWorker` in `server-timing` (download only — for uploads the worker time includes body reception). Geo headers are now unprefixed (`colo`, `asn`, `city`, …). `/meta` and `/locations` require `Referer: https://speed.cloudflare.com/`. Colo for this line: **DUS**.
9. **Storage**: raw 1 Hz samples in a `WITHOUT ROWID` table keyed `(probe_id, ts)` = **18.8 bytes/row** [VERIFIED] (rowid+index = 40.2 B/row) → ~13 MB/day for 8 probes; keep raw 30 days; 1-min rollups with mergeable log-bucket histogram (γ = 1.04 ⇒ ≤ 2 % quantile error, ~13 buckets ≈ 100 B JSON per minute [VERIFIED]) kept ≥ 1 year; 1-h rollups forever.
10. **Gaming score** = `100 × Π fᵢ` with piecewise-linear factors for latency p50, jitter (MASD), spike tail (p99−p50), loss %, outages/h; explain via "points lost per factor" (log-share) + "limiting factor". Show Cloudflare AIM "gaming" class and E-model MOS (voice chat) as secondary, well-known references.
11. **Preliminary observations on this line** (small samples, see §14): the Ethernet link at **100 Mbit/s caps throughput (~85 Mbit/s single-stream measured)**; noticeable jitter already at the **first ISP hop (CMTS 10–41 ms)** while the gateway stays at ~1 ms ⇒ variation originates in the cable/DOCSIS segment or beyond, not the LAN; ad-hoc spikes of 120–150 ms seen to Cloudflare; IPv4 path MTU 1460 (DS-Lite confirmed).

---------------------------------------------------------------------------------------------------

## 1. Probe architecture

### 1.1 Why not just `ping.exe`?

[VERIFIED] behaviour of Windows `ping.exe` when spawned from Node (`child_process.spawn`, pipes):
- Output arrives **line by line** (no pipe buffering) — usable for a long-running `ping -t`.
- Output encoding is the **OEM codepage CP850**, not UTF-8: `ü` arrives as byte `0x81`, `Ü` as `0x9A` (even though the interactive console is 65001). Decode as `latin1` and match with umlaut-agnostic regexes.
- Cadence: after a reply, the next echo is sent ~1 s later (intervals observed 972–1027 ms). After a timeout the cadence stretches to ~timeout + 1 s (observed 2.0 s with `-w 1000`, 1.5 s with `-w 700`), i.e. **sampling becomes irregular exactly during loss**.
- Windows ICMP timeouts fire **early**: 451 ms (w=700), 579–964 ms (w=1000) — both in ping.exe and the raw API. Don't rely on exact timeout timing.
- `ping -i <TTL>` gives the hop address but **no RTT** for TTL-expired replies ("Die Gültigkeitsdauer wurde bei der Übertragung überschritten."), so MTR-style per-hop RTT is impossible with ping.exe. .NET `Ping.Send` (PowerShell 5.1) likewise returns `RoundtripTime = 0` for `TtlExpired` (stopwatch needed).
- Spawning one `ping -n 1` per probe costs ~15–20 ms wall and ~6 ms parent CPU per probe [VERIFIED: 10 spawns = 31 ms user + 31 ms sys in Node] → workable as fallback at ≤ 10 probes/s, wasteful otherwise.

Verified German strings (decode latin1; `?` = umlaut byte):
| Case | Line (as seen) | Regex suggestion |
|---|---|---|
| header | `Ping wird ausgef?hrt f?r 1.1.1.1 mit 32 Bytes Daten:` | `/^Ping wird ausgef/` |
| IPv4 ok | `Antwort von 1.1.1.1: Bytes=32 Zeit=20ms TTL=57` | `/^Antwort von ([0-9a-f.:]+): Bytes=\d+ Zeit[=<](\d+)ms TTL=(\d+)/i` |
| IPv6 ok (no TTL!) | `Antwort von 2a02:8101:3ff:ff89::3: Zeit=34ms ` | `/^Antwort von ([0-9a-f:]+): Zeit[=<](\d+)ms/i` |
| sub-ms | `Zeit<1ms` | treat as 0.5 ms or 0 |
| timeout | `Zeit?berschreitung der Anforderung.` | `/berschreitung der Anforderung/` |
| TTL expired | `Antwort von 92.79.214.92: Die G?ltigkeitsdauer wurde bei der ?bertragung ?berschritten.` | `/ltigkeitsdauer/` |
| ARP fail (counted as "received" by Windows!) | `Antwort von 192.168.0.192: Zielhost nicht erreichbar.` | `/Zielhost nicht erreichbar/` |
| DF too big | `Paket m?sste fragmentiert werden, DF-Flag ist jedoch gesetzt.` | `/fragmentiert werden/` |
| stats | `Pakete: Gesendet = 4, Empfangen = 4, Verloren = 0` / `Minimum = 16ms, Maximum = 52ms, Mittelwert = 31ms` | — |

### 1.2 Recommended primitive: `IcmpSendEcho` / `Icmp6SendEcho2` via koffi [VERIFIED]

- Package: `koffi@3.3.1` (released 2026-09-19; 3.3.2 is <14 days old). Unpacked 1.7 MB + platform package `@koromix/koffi-win32-x64`; installs with `--ignore-scripts` (no build step). Pin exactly.
- Works as normal user. Returns: status code, RTT (integer ms; `0` = sub-ms), responder address (hop address for TTL-expired), reply TTL (v4).
- Concurrency: koffi `.async()` runs on the **libuv threadpool (default 4 threads, independent of core count; 28 cores here)**. `IcmpSendEcho` blocks a thread until reply/timeout. With 4 threads, 8 timeouts delayed all responsive probes by 1.7 s [VERIFIED]; with `UV_THREADPOOL_SIZE=32` all 16 concurrent probes completed in 5–45 ms [VERIFIED]. Setting `process.env.UV_THREADPOOL_SIZE` inside the script had **no effect** on Windows [VERIFIED] → set it in the launcher (e.g. `concurrently "cross-env UV_THREADPOOL_SIZE=64 tsx engine/index.ts" "next dev"`, or spawn the engine with `env`). The pool is shared with `fs`, `dns.lookup`, `zlib`, `crypto`, so be generous (64).
- `GetLastError()` is meaningless after async calls (other thread) → derive status from the reply buffer; if the call returned 0 *and* the buffer status is 0, treat as `error`.
- One ICMP handle can be used concurrently (16 parallel calls on one handle worked).
- Reply layouts (x64): `ICMP_ECHO_REPLY`: Address u32 @0 (network order), Status u32 @4, RoundTripTime u32 @8, DataSize u16 @12, Data ptr @16, Options.Ttl u8 @24 (size 40). `ICMPV6_ECHO_REPLY`: packed IPV6_ADDRESS_EX (port u16 @0, flowinfo u32 @2, **addr 8×u16 BE @6..21**, scope u32 @22), **Status u32 @28, RTT u32 @32** [VERIFIED empirically].
- Status codes (ipexport.h): 0 SUCCESS, 11002 DEST_NET_UNREACHABLE, 11003 DEST_HOST_UNREACHABLE, 11010 REQ_TIMED_OUT, 11013 TTL_EXPIRED_TRANSIT (IPv6: hop limit exceeded), 11050 GENERAL_FAILURE (local stack/adapter problem — strong "local" indicator), others → `other`.

```ts
// engine/probes/icmp.ts — verified logic (see koffitest/icmp_ref.js). Requires UV_THREADPOOL_SIZE>=32 in env before node starts.
import koffi from 'koffi';
const iphlp = koffi.load('iphlpapi.dll');
koffi.struct('IP_OPTION_INFORMATION', { Ttl: 'uint8', Tos: 'uint8', Flags: 'uint8', OptionsSize: 'uint8', OptionsData: 'void *' });
const IcmpCreateFile = iphlp.func('void * __stdcall IcmpCreateFile()');
const Icmp6CreateFile = iphlp.func('void * __stdcall Icmp6CreateFile()');
const IcmpSendEcho = iphlp.func('uint32 __stdcall IcmpSendEcho(void *h, uint32 dst, void *req, uint16 reqSize, IP_OPTION_INFORMATION *opt, _Inout_ uint8 *reply, uint32 replySize, uint32 timeout)');
const Icmp6SendEcho2 = iphlp.func('uint32 __stdcall Icmp6SendEcho2(void *h, void *ev, void *apc, void *ctx, uint8 *src, uint8 *dst, void *req, uint16 reqSize, IP_OPTION_INFORMATION *opt, _Inout_ uint8 *reply, uint32 replySize, uint32 timeout)');
const h4 = IcmpCreateFile(), h6 = Icmp6CreateFile();
const PAYLOAD = Buffer.alloc(32, 0x61);
export type IcmpStatus = 'ok'|'ttl_expired'|'timeout'|'host_unreachable'|'net_unreachable'|'general_failure'|'other'|'error';
const STATUS: Record<number, IcmpStatus> = { 0:'ok', 11013:'ttl_expired', 11010:'timeout', 11003:'host_unreachable', 11002:'net_unreachable', 11050:'general_failure' };
export interface IcmpResult { status: IcmpStatus; code: number; rttMs: number|null; from: string|null; replyTtl: number|null; sentAt: number }
const v4ToU32 = (ip: string) => Buffer.from(ip.split('.').map(Number)).readUInt32LE(0);
const u32ToV4 = (u: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(u >>> 0); return [...b].join('.'); };
function sockaddrIn6(ip?: string): Buffer {           // sockaddr_in6, AF_INET6 = 23 on Windows
  const b = Buffer.alloc(28); b.writeUInt16LE(23, 0); if (!ip) return b;
  const [head, tail] = ip.includes('::') ? ip.split('::') : [ip, null];
  const h = head ? head.split(':') : [], t = tail ? tail.split(':') : [];
  const g = tail === null ? h : [...h, ...Array(8 - h.length - t.length).fill('0'), ...t];
  g.forEach((x, i) => b.writeUInt16BE(parseInt(x || '0', 16), 8 + i * 2)); return b;
}
const mapStatus = (n: number, raw: number) => { const code = n === 0 && raw === 0 ? -1 : raw; return { code, status: (STATUS[code] ?? (code === -1 ? 'error' : 'other')) as IcmpStatus }; };
export function echo4(ip: string, ttl = 128, timeoutMs = 1000): Promise<IcmpResult> {
  return new Promise((resolve) => {
    const reply = Buffer.alloc(40 + PAYLOAD.length + 8 + 64), sentAt = Date.now();
    IcmpSendEcho.async(h4, v4ToU32(ip), PAYLOAD, PAYLOAD.length, { Ttl: ttl, Tos: 0, Flags: 0, OptionsSize: 0, OptionsData: null }, reply, reply.length, timeoutMs, (err: unknown, n: number) => {
      if (err) return resolve({ status: 'error', code: -2, rttMs: null, from: null, replyTtl: null, sentAt });
      const { code, status } = mapStatus(n, reply.readUInt32LE(4)); const got = status === 'ok' || status === 'ttl_expired';
      resolve({ status, code, sentAt, rttMs: got ? reply.readUInt32LE(8) : null, from: got ? u32ToV4(reply.readUInt32LE(0)) : null, replyTtl: got ? reply.readUInt8(24) : null });
    });
  });
}
export function echo6(ip: string, hopLimit = 128, timeoutMs = 1000): Promise<IcmpResult> {
  return new Promise((resolve) => {
    const reply = Buffer.alloc(36 + PAYLOAD.length + 8 + 64), sentAt = Date.now();
    Icmp6SendEcho2.async(h6, null, null, null, sockaddrIn6(), sockaddrIn6(ip), PAYLOAD, PAYLOAD.length, { Ttl: hopLimit, Tos: 0, Flags: 0, OptionsSize: 0, OptionsData: null }, reply, reply.length, timeoutMs, (err: unknown, n: number) => {
      if (err) return resolve({ status: 'error', code: -2, rttMs: null, from: null, replyTtl: null, sentAt });
      const { code, status } = mapStatus(n, reply.readUInt32LE(28)); const got = status === 'ok' || status === 'ttl_expired';
      const g: string[] = []; for (let i = 0; i < 8; i++) g.push(reply.readUInt16BE(6 + i * 2).toString(16));
      resolve({ status, code, sentAt, rttMs: got ? reply.readUInt32LE(32) : null, from: got ? g.join(':') : null, replyTtl: null }); // normalise/compress for display
    });
  });
}
```
Verified output (2026-10-09): gateway `ok 0 ms ttl 64`; `1.1.1.1 ok 31 ms ttl 57`; `8.8.8.8 ttl=3 → ttl_expired 28 ms from 92.79.214.92`; `ttl=2 → timeout` (silent AFTR inside the DS-Lite tunnel); IPv6 `hop 2 → ttl_expired 23 ms from 2a02:8101:3ff:ff89::3`; AFTR `2a00:0:cff:84a0::3 ok 26 ms`.

### 1.3 Other probe types (all verified to work without admin)

| Probe | How | Why | Rate |
|---|---|---|---|
| UDP STUN Binding (RFC 8489) | 20-byte request (type 0x0001, magic 0x2112A442, 12-byte txid) to `stun.cloudflare.com:3478` (v4 162.159.207.0, v6 2606:4700:49::) via `dgram`; parse XOR-MAPPED-ADDRESS 0x0020 | UDP path like games; shows **CGNAT mapping** (public IPv4:port) → detect AFTR mapping changes; IPv6 shows no NAT | 0.2 Hz (each from a persistent socket) |
| UDP DNS | A-query for a popular name to `1.1.1.1:53` / `[2606:4700:4700::1111]:53` | UDP loss/RTT + resolver health | 0.2 Hz |
| TCP connect | `net.connect(443, host)`; RTT = connect time (kernel handshake, no app processing) | for game servers that drop ICMP; app-like path | 0.1–0.2 Hz per target |
| HTTP RTT | `__down?bytes=0` on a warm keep-alive connection, `TTFB − server-timing` | only for speed/bufferbloat tests (server time 30–50 ms adds noise) | test-time only |

[VERIFIED] STUN v4 RTT 25–50 ms (mapped port stable 19673 on one socket), STUN v6 12–49 ms, DNS v4 19–76 ms, DNS v6 17–58 ms (ad-hoc, 5 samples each).

### 1.4 Scheduling rules [RECOMMENDATION]

- **Rounds**: every 1000 ms (self-correcting: `next = t0 + k·1000`, not `setInterval` drift); in each round fire all 1 Hz probes, staggered by 5–10 ms to avoid self-queuing; store `round_id` (= floor(ts/1000)) so targets can be compared per round.
- **Timeout** 1000 ms (Windows returns early anyway); RTT recorded = API RTT (integer ms). Display `<1 ms` for 0.
- **Suspend/standby detection**: if wall-clock gap between rounds > 3 s, write a `gap` event (`reason='suspend_or_stall'`) and mark those seconds *unknown*, never *lost*. Cross-check with Windows Kernel-Power events (Windows agent). [UNCERTAIN] whether `performance.now()` advances during S3/modern standby on this box → use `Date.now()` deltas for gap detection.
- **Never count** probes during an active speed/bufferbloat test into the "idle" statistics (tag samples with `context='load_test'`).
- **Probe status taxonomy** (store as small int): 0 ok, 1 timeout, 2 host_unreachable, 3 net_unreachable, 4 general_failure, 5 ttl_expired (hop reply), 6 error, 9 skipped(gap).

### 1.5 Target layers for this line (observed 2026-10-09; must be auto-discovered, can change)

| Layer | Target | Observed RTT (ad hoc) | What it isolates |
|---|---|---|---|
| L1 LAN | 192.168.0.1 and router LAN IPv6 `3fff:8071:7ca0:c980:de73:6ff:fe12:34df` (EUI-64 of MAC DC-73-06-12-34-DF) | 0–2 ms | PC/NIC/cable/router LAN side (note: pings *to* the router are control-plane → isolated spikes there are benign) |
| L2 Access | IPv6 hop 2 `2a02:8101:3ff:ff89::3` (likely CMTS/first Vodafone router) | 10–41 ms | DOCSIS segment (upstream request-grant, segment congestion, noise) |
| L3 ISP core | IPv6 hop 3 `2a02:908:0:4d4::1` | 8–28 ms | Vodafone backbone |
| L4 AFTR | `2a00:0:cff:84a0::3` (from router start page `_ga.aftrAddress`; path: router → hop2 → hop3 → * → 2a00::43:eb:45 → AFTR, 6 hops) | 11–48 ms | DS-Lite tunnel endpoint over native IPv6 |
| L5 post-AFTR IPv4 | IPv4 hop 3 `92.79.214.92` (IPv4 hop 2 = AFTR, silent) | 14–32 ms | CGNAT/AFTR processing (L5 − L4) |
| L6 Internet | 1.1.1.1 / 2606:4700:4700::1111, 8.8.8.8 / 2001:4860:4860::8888 (Cloudflare colo DUS) | 16–52 ms (one burst 141–150 ms) | backbone/peering; v4-vs-v6 comparison isolates AFTR effects |
| L7 Game | user-configured (ICMP if answered, else TCP connect) | — | the thing that actually matters |

IPv4 path MTU = **1460** (largest DF ping payload 1432) ⇒ DS-Lite encapsulation confirmed; IPv6 MTU 1500 [VERIFIED].

---------------------------------------------------------------------------------------------------

## 2. Gaming thresholds

### 2.1 Reference values from sources

| Source | Latency | Jitter / PDV | Loss | Notes |
|---|---|---|---|---|
| **Cloudflare AIM** (`cloudflare/speedtest` `src/config/internalConfig.ts`) [SOURCE, code] | points: <10 ms → 20, <20 → 10, <50 → 5, <100 → 0, <500 → −10, else −20 | (rtc only) <10 → 10, <20 → 5, <100 → 0, <500 → −10, else −20 | <1 % → 10, <5 % → 5, <25 % → 0, <50 % → −10, else −20 | `loadedLatencyIncrease` (max(down,up loaded) − idle) uses the latency table. **Gaming = latency + packetLoss + loadedLatencyIncrease**, sum clamped ≥0, classes by thresholds [5,15,25,30] → bad <5, poor <15, average <25, good <30, great ≥30. RTC = latency+jitter+loss+loadedIncrease, thresholds [5,15,25,40]. |
| **Waveform** bufferbloat test (live JS bundle 2026-10-09) [SOURCE, code] | "Low Latency Gaming" requires 95th-pct latency **< 40 ms** (also ≥10 Mbit/s down, ≥3 Mbit/s up); "Video Conferencing"/"Audio Calls" < 400 ms; "Web Browsing" < 500 ms | — | — | Grades A+ <5, A <30, B <60, C <200, D <400, F ≥400 ms latency increase; A+..B = "should stay responsive". |
| **3GPP TR 26.928 §4.2.2** [SOURCE] | FPS 100 ms, RPG 500 ms, RTS 1000 ms delay tolerance; "60 ms, or even 45 ms are better estimates" for fast-paced games | — | — | |
| **3GPP TS 23.203 QCI 3** "Real Time Gaming" [SOURCE] | packet delay budget 50 ms | — | PELR 10⁻³ (0.1 %) | QCI 7 (voice/live video/"interactive gaming"): 100 ms, 10⁻³ [SOURCE: Wikipedia summary]. Budgets are access-network one-way, indicative only. |
| **ITU-T Y.1541 class 0** (real-time, jitter-sensitive, high interaction) [SOURCE] | mean one-way IPTD ≤ 100 ms | IPDV ≤ 50 ms (= 99.9th pct − min) | IPLR ≤ 10⁻³ | evaluation interval **1 minute** — matches our minute rollups. |
| **IETF draft-ietf-ippm-responsiveness-09** (2026-07-06) [SOURCE] | RPM = 60000/RTT_ms: Poor ≤300 RPM (≥200 ms), Fair 300–1000 (200–60 ms), Good 1000–6000 (60–10 ms), Excellent ≥6000 (<10 ms) | — | — | Apple networkQuality's own Low/Medium/High cut-offs are **not published** [UNCERTAIN]. |
| **CableLabs LLD / draft-white-tsvwg-lld** [SOURCE] | DOCSIS 3.1 access ~10 ms typical; DOCSIS 3.0 request-grant ≥ ~5 ms; spikes ≥100 ms under heavy load | — | — | context for L2 thresholds |

### 2.2 Proposed traffic-light thresholds (gut / ok / schlecht + alert) [RECOMMENDATION]

Evaluate over **≥ 15 min** windows for latency/jitter and **≥ 1 h** windows for loss % (1 Hz ⇒ 1 lost probe in 15 min = 0.11 %; percentages from < 1000 probes must show counts + Wilson CI).

| Kennzahl (UI) | gut | ok | schlecht | kritisch (alert) | Basis |
|---|---|---|---|---|---|
| RTT p50 Internet/Spielziel (DE/EU) | ≤ 40 ms | ≤ 80 ms | > 80 ms | > 150 ms | AIM ≥5 pts ≤50; 3GPP 45–60 fast-paced, FPS 100; RPM "Good" ≤60 |
| RTT p50 Router (LAN, Kabel) | ≤ 2 ms | ≤ 5 ms | > 5 ms | > 20 ms | wired LAN ~1 ms (observed) |
| RTT p50 erster ISP-Hop (CMTS) | ≤ 15 ms | ≤ 30 ms | > 30 ms | > 60 ms | DOCSIS ~10 ms typical (empirical, [UNCERTAIN] per-segment) |
| Jitter (MASD) | ≤ 5 ms | ≤ 15 ms | > 15 ms | > 30 ms | AIM rtc jitter <10/<20; Cisco VoIP ≤30 |
| Spitzen-Tail p99 − p50 | ≤ 20 ms | ≤ 50 ms | > 50 ms | > 150 ms | Y.1541 IPDV 50 ms; RFC 5481 PDV |
| Lag-Spikes ≥ 200 ms pro Stunde | 0 | ≤ 2 | > 2 | > 10 | user complaint ("Ping > 200 ms") |
| Paketverlust (Internet-weit) | < 0.1 % | < 1 % | ≥ 1 % | ≥ 3 % | Y.1541/QCI3 0.1 %; AIM <1 % = max points |
| Ausfälle ≥ 3 s (Internet-weit) | 0 / Tag | ≤ 1 / Tag | > 1 / Tag | ≥ 1 / h | disconnect/rubber-banding |
| Bufferbloat Δ (max DL/UL, Mittelwert) | < 30 ms (A+/A) | < 60 ms (B) | ≥ 60 ms (C–F) | ≥ 200 ms (D/F) | Waveform/DSLReports scale; Waveform gaming <40 ms loaded |
| Gestörte Sekunden (siehe §4.5) | < 0.1 % | < 1 % | ≥ 1 % | ≥ 5 % | ITU-T G.826 ES/SES idea |

Gateway latency spikes *alone* (without simultaneous spikes further out) are flagged as "Hinweis: Router antwortet verzögert (Control-Plane)" — not as a network problem.

---------------------------------------------------------------------------------------------------

## 3. Jitter — definitions and what to display

| Definition | Formula | Used by | Properties |
|---|---|---|---|
| **MASD** (mean abs. successive difference) | `J = Σ|Rᵢ − Rᵢ₋₁| / (n−1)` over consecutive received samples | **Cloudflare speed test** (`getJitter`: "average latency delta between consecutive samples") [SOURCE code], **PingPlotter** [SOURCE KB 50], Cloudflare blog ("average variation between consecutive RTT measurements") | intuitive, insensitive to slow level shifts, mergeable via (sum, n) |
| RFC 3550 interarrival jitter | `J ← J + (|D| − J)/16`, D = difference of transit times; applied to RTT deltas | RTP/VoIP stacks | exponentially smoothed (~16 samples); good live gauge; not mergeable |
| PDV (RFC 5481) | `PDV(i) = D(i) − D(min)`; report upper percentile, e.g. `p99.9 − min` | RFC 5481 recommends PDV for buffer sizing, **reporting to users** and SLAs; Y.1541 IPDV = 99.9th pct − min | one-sided, robust to loss; captures spike tail |
| IPDV (RFC 3393/5481) | `D(i) − D(i−1)` (signed) | path-change/clock-skew analysis | two-sided; needs consecutive arrivals |
| Mean absolute deviation around mean | `mean(|Rᵢ − mean|)` | **Waveform** (`t(e.map(n=>Math.abs(n-t(e))))`) [SOURCE code] | conflates level shifts with jitter |
| Std. deviation | `sqrt(Σ(R−μ)²/(n−1))` | MTR "StDev" | dominated by outliers; not recommended as headline |

**Decision** [RECOMMENDATION]:
- UI "Jitter" = **MASD** over the window, computed only over consecutive successful samples (a loss breaks the chain). Store `jit_sum`, `jit_n` per minute → exact merge across minutes (boundary pairs: carry last RTT per probe in memory; ignore the cross-minute pair if not available).
- UI "Latenzschwankung/Spitzen" = **p99 − p50** (≥1 h windows) or **p95 − p50** (15 min windows). (PDV with p50 instead of min is more robust to the integer-ms floor and single fast outliers.)
- Live gauge: RFC 3550 smoothed J per target.
- Caveat to show in the UI info text: jitter depends on sampling interval; MASD at 1 Hz measures second-to-second variation, not per-packet (20–128 Hz) jitter. Optional "Burst-Modus" (10 Hz for 60 s, gateway + CMTS + 1 anycast) for higher fidelity.

```ts
export function masd(rtts: (number|null)[]) { let sum = 0, n = 0, prev: number|null = null;
  for (const r of rtts) { if (r == null) { prev = null; continue; } if (prev != null) { sum += Math.abs(r - prev); n++; } prev = r; }
  return { sum, n, value: n ? sum / n : null }; }
export const rfc3550 = (J: number, prevRtt: number, rtt: number) => J + (Math.abs(rtt - prevRtt) - J) / 16;
```

---------------------------------------------------------------------------------------------------

## 4. Packet loss — random vs. bursty, outages, scope

### 4.1 Run-length classification [RECOMMENDATION, informed by RFC 3357/3611]

Per probe (1 Hz), find maximal runs of consecutive lost probes:
- `len = 1` → **isolated** ("Einzelverlust")
- `len = 2` → **burst** ("Verlustburst")
- `len ≥ 3` → **outage** ("Ausfall", ≈ ≥3 s). Duration estimate `= ts(next success) − ts(last success before) − interval` (bounds ±1 s at 1 Hz).
Games: 1–3 s gaps → rubber-banding; ≥5–20 s → disconnect (game-specific).

### 4.2 Burstiness statistics (per window)

- `ulp` = lost/sent; `clp` = P(lost | previous lost); **burstiness = clp/ulp** (≈1 random, ≫1 bursty).
- Gilbert model: `p = P(L|R)`, `r = P(R|L)`, mean burst length = 1/r, stationary loss = p/(p+r).
- RFC 3611 burst/gap with **Gmin = 16**: a burst is the longest sequence starting and ending with a loss and containing no run of ≥16 received packets; isolated losses with ≥16 received on both sides are *gap losses*. Report burst density, gap density, mean burst duration. [SOURCE RFC 3611 §4.7.2]
- Self-test [VERIFIED in `analysis.js`]: random 1 % loss → burstiness 1.27, mean burst 1.01; bursty pattern → burstiness 457, mean burst 5.0.

### 4.3 Scope classification by simultaneity (same round ±1)

| Pattern in the same rounds | Verdict (UI) |
|---|---|
| Gateway (v4 and v6) lost too, or ICMP status `general_failure`/`net_unreachable` | **Lokal: PC/Netzwerkkarte/Kabel/LAN** → correlate with NIC link-down events (e2fexpress 27/32/33) and link speed |
| Gateway OK, CMTS + everything beyond lost (v4 and v6) | **Zugangsnetz (Kabel/DOCSIS)** → check router DOCSIS log/levels (router agent) |
| Gateway + CMTS + AFTR(v6) OK, all IPv4 targets lost, IPv6 targets OK | **DS-Lite AFTR / CGNAT (IPv4)** |
| Only internet targets (v4 and v6) lost, ISP hops OK | **ISP-Backbone/Peering** |
| Only one target lost | **zielspezifisch** (ICMP rate limiting / remote) — never counted as "Internet loss" |
| No probes at all (gap) | Standby/engine stall — excluded |

"Internet-weit" loss/outage requires **≥ 2 independent internet targets** lost in the same round (ICMP deprioritisation at single targets is common).

### 4.4 Uncertainty: Wilson score interval

`p̂=k/n, z=1.96: center=(p̂+z²/2n)/(1+z²/n), half=z·sqrt(p̂(1−p̂)/n+z²/4n²)/(1+z²/n)`. Example [VERIFIED]: 1 loss in 900 probes → 0.11 % (95 % CI 0.020–0.627 %). Show "1 von 900 (0,11 %; 95 %-KI 0,02–0,63 %)".

### 4.5 "Gestörte Sekunden" (errored seconds) [RECOMMENDATION, ITU-T G.826 ES/SES idea]

Per second, over the internet targets of the primary family: *errored* if ≥ 1 internet target lost or `rtt > baseline + 50 ms` or `rtt ≥ 150 ms`; *severely errored* if all internet targets lost or `rtt ≥ 300 ms`. KPI: "In den letzten 24 h waren 0,8 % der Sekunden gestört (11 min 31 s)". Availability = 1 − outage seconds / measured seconds (exclude gaps).

```ts
export function lossRuns(seq: {ts:number; lost:boolean}[], burstMax = 2, intervalMs = 1000) {
  const runs: {startTs:number; len:number; approxDurationMs:number; kind:'isolated'|'burst'|'outage'}[] = []; let s = -1;
  for (let i = 0; i <= seq.length; i++) { const lost = i < seq.length && seq[i].lost;
    if (lost && s < 0) s = i;
    if (!lost && s >= 0) { const len = i - s, before = s > 0 ? seq[s-1].ts : seq[s].ts - intervalMs, after = i < seq.length ? seq[i].ts : seq[i-1].ts + intervalMs;
      runs.push({ startTs: seq[s].ts, len, approxDurationMs: after - before - intervalMs, kind: len === 1 ? 'isolated' : len <= burstMax ? 'burst' : 'outage' }); s = -1; } }
  return runs; }
export function gilbert(lost: boolean[]) { let rr=0, rl=0, lr=0, ll=0, k=0;
  lost.forEach((b, i) => { if (b) k++; if (!i) return; const a = lost[i-1]; if (!a && !b) rr++; else if (!a && b) rl++; else if (a && !b) lr++; else ll++; });
  const ulp = k / Math.max(1, lost.length), clp = ll / Math.max(1, ll + lr), p = rl / Math.max(1, rr + rl), r = lr / Math.max(1, lr + ll);
  return { ulp, clp, p, r, meanBurstLen: r > 0 ? 1 / r : null, burstiness: ulp > 0 ? clp / ulp : null }; }
export function wilson(k: number, n: number, z = 1.96): [number, number] { if (!n) return [0, 1];
  const p = k / n, d = 1 + z*z/n, c = (p + z*z/(2*n)) / d, h = z * Math.sqrt(p*(1-p)/n + z*z/(4*n*n)) / d; return [Math.max(0, c-h), Math.min(1, c+h)]; }
```

---------------------------------------------------------------------------------------------------

## 5. Latency spikes — robust, baseline-relative detection

Rationale: absolute thresholds alone miss relative degradation (20 → 70 ms is a lag spike even though 70 ms is "ok"); mean/stddev are inflated by the very spikes we want to find → use **median + MAD** (Leys et al. 2013 recommend MAD-based outlier rules with 2.5–3 for classic outliers; we use a stricter k because RTT distributions are heavy-tailed and we want rare-event detection). [SOURCE + RECOMMENDATION]

Algorithm per probe (internet targets; gateway uses `minDelta = 10 ms`):
1. Baseline window = last **600 successful samples** (10 min @1 Hz); require ≥ 60 samples.
2. `m = median`, `σ = max(1.4826·MAD, 1 ms)` (floor needed because ICMP RTT is integer ms → MAD can be 0).
3. Spike if `rtt > m + max(5σ, 25 ms)` **or** `rtt ≥ 200 ms` (absolute, matches the complaint).
4. Severity: 1 minor (< m+50), 2 major (≥ m+50), 3 severe (≥ 200 ms or ≥ m+150).
5. **Episodes**: merge spike samples with gaps ≤ 2 s → {start, end, count, peak, area Σ(rtt−m)}.
6. **Level shift / congestion**: if > 50 % of the last 60 s exceed the threshold → emit "anhaltend erhöhte Latenz" episode instead of many spikes (the 10-min median adapts after ~5 min; keep a separate 24-h p10 "floor" to show how far above normal we are).
7. **Cross-target correlation** (same round ±1): a spike counts as "Internet-weit" if ≥ 2 internet targets spike; attribute layer by the *first* layer that co-spikes (gateway → LAN, CMTS → DOCSIS, AFTR/post-AFTR only on v4 → CGNAT, …).
8. Display p95/p99 only over windows with ≥ 100 samples (p99 of 60 samples ≈ max).

[VERIFIED in `analysis.js`]: synthetic 1 h with a +120 ms spike every 60 s → 59/60 detected (the first falls into the warm-up).

```ts
class SpikeDetector { private buf: number[] = [];
  constructor(private o = { window: 600, k: 5, minDeltaMs: 25, sigmaFloorMs: 1, absMs: 200 }) {}
  push(rtt: number|null) { if (rtt == null) return null; let res: any = { spike: false };
    if (this.buf.length >= 60) { const s = [...this.buf].sort((a,b)=>a-b), q = (p:number)=>{const i=(s.length-1)*p,l=Math.floor(i),h=Math.ceil(i);return s[l]+(s[h]-s[l])*(i-l);};
      const m = q(0.5), dev = this.buf.map(x => Math.abs(x - m)).sort((a,b)=>a-b), mad = dev[Math.floor(dev.length/2)];
      const thr = m + Math.max(this.o.k * Math.max(1.4826 * mad, this.o.sigmaFloorMs), this.o.minDeltaMs);
      const spike = rtt > thr || rtt >= this.o.absMs;
      res = { baseline: m, threshold: thr, spike, severity: !spike ? 0 : (rtt >= this.o.absMs || rtt - m >= 150) ? 3 : rtt - m >= 50 ? 2 : 1 }; }
    this.buf.push(rtt); if (this.buf.length > this.o.window) this.buf.shift(); return res; } }
```
(Sorting 600 values per probe per second is negligible CPU for ~20 probes.)

---------------------------------------------------------------------------------------------------

## 6. Periodicity of spikes / losses

Two complementary, explainable methods [RECOMMENDATION]:
1. **Autocorrelation of the binary 1-s event series** over the last 6 h (n = 21600): `x_t = 1` if an episode starts in second t (dilate ±1 s to tolerate jitter); `r(k)` for k = 3…900 s; significant if `r(k) > 4/√n` and local maximum; drop peaks that are integer multiples (±5 %) of a stronger shorter peak → report fundamental periods. O(n·900) ≈ 20 M ops, fine in JS once per minute/hour.
2. **Inter-event-interval histogram** (1-s bins, 2–900 s) as the UI visual ("Abstände zwischen Spitzen"), with a peak marker.
Self-test [VERIFIED]: 60-s periodic spikes → `[{periodSec: 60, r: 0.982}]`.

Interpretation hints (heuristic, show as "mögliche Ursachen", not facts):
- **60 s / 120 s**: Windows WLAN background scans (only relevant for traffic over Wi-Fi; this PC is wired, WLAN adapter disconnected but enabled), location services, some telemetry.
- **≈ 30 s / 300 s / 900 s**: scheduled tasks, cloud sync, router housekeeping.
- **Time-of-day** (not periodic in seconds): evening prime time 18–23 h ⇒ DOCSIS segment/AFTR load → hour-of-day × weekday heatmap of loss % and p95 from 1-min rollups.
- Note: the user's link drops cluster in time (8 drops 18:29–18:43 on 2026-10-08) — look for clustering (bursts of events) as well as periodicity.

```ts
export function periodicity(events: number[] /* epoch s */, spanSec: number, maxLag = 900, minLag = 3) {
  if (events.length < 6) return []; const t0 = Math.min(...events), n = spanSec, x = new Float64Array(n);
  for (const e of events) for (let d = -1; d <= 1; d++) { const i = e - t0 + d; if (i >= 0 && i < n) x[i] = 1; }
  const mean = x.reduce((a, b) => a + b, 0) / n; let den = 0; for (let i = 0; i < n; i++) den += (x[i] - mean) ** 2; if (!den) return [];
  const r = new Float64Array(maxLag + 1);
  for (let k = minLag; k <= maxLag; k++) { let s = 0; for (let i = 0; i + k < n; i++) s += (x[i] - mean) * (x[i + k] - mean); r[k] = s / den; }
  const thr = 4 / Math.sqrt(n), peaks: {periodSec:number; r:number}[] = [];
  for (let k = minLag + 1; k < maxLag; k++) if (r[k] > thr && r[k] >= r[k-1] && r[k] >= r[k+1]) peaks.push({ periodSec: k, r: r[k] });
  peaks.sort((a, b) => b.r - a.r); const fund: typeof peaks = [];
  for (const p of peaks) if (!fund.some(f => Math.abs(p.periodSec / f.periodSec - Math.round(p.periodSec / f.periodSec)) < 0.05)) fund.push(p);
  return fund.slice(0, 3); }
```

---------------------------------------------------------------------------------------------------

## 7. Traceroute / MTR interpretation and continuous per-hop probing

### 7.1 Rules [SOURCE: Steenbergen "A Practical Guide to (Correctly) Troubleshooting with Traceroute"; Akamai/Linode MTR guide; Microsoft pathping docs]

1. A hop's RTT = forward path + **ICMP generation time on that router (slow path / control plane, lowest priority, rate-limited "typically in the 50–300 packets/sec range")** + return path. Item 2 is not experienced by forwarded traffic.
2. **Latency**: a jump that does **not continue into later hops** is cosmetic (slow ICMP generation). A real increase persists (or grows) at all later hops incl. destination; judge by the latency to the final hop.
3. **Loss**: loss at a hop that does **not persist to later hops** is ICMP rate limiting/CoPP; "always trust the reports from later hops". Real loss appears at the hop where it starts **and all subsequent hops**.
4. **Asymmetric return paths**: a hop's RTT includes its (possibly different) reverse path; asymmetry often starts at network boundaries. Track **reply TTL** of the destination — a change means the return path changed.
5. **MPLS ICMP tunnelling**: several consecutive hops showing the *same* RTT ≈ destination RTT is an artefact, not congestion.
6. **Hidden hops**: rows of `*` (here: IPv4 hop 2 = DS-Lite AFTR inside the IPv6 tunnel; Google edge hops) are normal.
7. Microsoft pathping semantics: link loss ("This Node/Link" with `|`) = forwarding loss on that link; router-address loss = the router dropping packets *addressed to it* without affecting forwarding.

### 7.2 Formalised attribution (pathping-style, generalised) [RECOMMENDATION; VERIFIED against MS example]

For hops ordered by TTL with source→hop loss `Lᵢ` and median RTT `Rᵢ` over the same window:
- `persistentLoss(i) = min_{j ≥ i} L_j`; **linkLoss(i) = persistentLoss(i) − persistentLoss(i−1)** (loss introduced on the link into hop i); **nodeLoss(i) = Lᵢ − persistentLoss(i)** (cosmetic ICMP loss at the router).
- Same for latency with medians: `persistentRtt(i) = min_{j ≥ i} R_j`; `addedRtt(i) = persistentRtt(i) − persistentRtt(i−1)`.
- Applied to Microsoft's pathping example (0/16/13/14/13 %): link 1→2 = 13 %, node 2 = 3 %, node 4 = 1 % — identical to pathping's output.
- Hops with no replies are skipped (their loss is unknown, not 100 %).

**Time-correlated propagation test** (only possible because we probe all hops in the same round): for each spike/loss event at hop i, check the destination in the same round (±1). `propagation(i) = share of hop-i events co-occurring at the destination`. ≥ 0.7 ⇒ real (data plane); ≤ 0.2 ⇒ cosmetic (control plane); otherwise inconclusive.

```ts
export function attributeHops(h: {ttl:number; lossPct:number|null; rttMed:number|null}[]) {
  const out = h.map((x, i) => { let pl = Infinity, pr = Infinity;
    for (let j = i; j < h.length; j++) { if (h[j].lossPct != null) pl = Math.min(pl, h[j].lossPct!); if (h[j].rttMed != null) pr = Math.min(pr, h[j].rttMed!); }
    return { ttl: x.ttl, persistentLoss: pl, nodeLoss: x.lossPct == null ? null : x.lossPct - pl, persistentRtt: pr, linkLoss: 0, addedRtt: 0 }; });
  out.forEach((o, i) => { o.linkLoss = Math.max(0, o.persistentLoss - (i ? out[i-1].persistentLoss : 0)); o.addedRtt = Math.max(0, o.persistentRtt - (i ? out[i-1].persistentRtt : 0)); });
  return out; }
```

### 7.3 Windows tools — specifics [SOURCE MS Learn; VERIFIED output]

- `tracert`: ICMP Echo with increasing TTL, **3 probes/hop**, default max 30 hops (`/h`), timeout 4000 ms (`/w`), `/d` no DNS (always use), `/4` `/6`. Sequential, ~1 s pause between hops [VERIFIED] → slow (seconds to minutes). Output is written **column by column** (partial lines) → buffer until newline. German: `Routenverfolgung zu 8.8.8.8 über maximal 4 Hops`, hop lines `  3    26 ms    16 ms    21 ms  92.79.214.92`, timeouts `*` and `Zeitüberschreitung der Anforderung.`, end `Ablaufverfolgung beendet.`; `<1 ms` possible.
- `pathping`: 100 queries/hop (`/q`), 250 ms period (`/p`; per-hop interval = period × hops), 3000 ms timeout (`/w`), `/n`, `/4`, `/6`; duration ≈ hops × q × p (8 hops ≈ 200 s). Good one-off cross-check; German column headers not verified [UNCERTAIN].
- Prefer the koffi TTL scan over parsing tracert (gives per-probe status, RTT and responder in one call).

### 7.4 Continuous per-hop strategy & rates [RECOMMENDATION]

- **Path discovery**: TTL scan 1…30 (3 probes per TTL, parallel per TTL, stop at destination) for each monitored destination & family; repeat every **15 min**, and immediately when (a) destination reply TTL changes, (b) a hop address changes, (c) destination p50 shifts > 30 % for 5 min. Store path versions (`path_id`, ordered hop list) and log changes as events.
- **Continuous MTR-light**: all hops of the primary v4 and v6 paths at **0.2 Hz** (one round every 5 s); layer targets of §1.5 at **1 Hz**. On any anomaly episode (outage, major spike, loss burst on ≥2 targets) switch **all hops to 1 Hz for 5 min** ("Burst-Diagnose") so the event is captured per hop.
- Rates are far below router ICMP limits (50–300 pps per router, shared by all users); still expect some cosmetic loss at intermediate hops. MTR's default is 1 probe/s/hop (Akamai guide recommends ≥50–100 cycles for a report).
- Bandwidth: ~10–20 probes/s × ~160 B round trip ≈ 13–26 kbit/s.

---------------------------------------------------------------------------------------------------

## 8. Fault-localisation matrix (for the "Ursache" view) [RECOMMENDATION]

| Observation (same time window) | Most likely cause | Evidence to show |
|---|---|---|
| Gateway loss/outage + NIC link-down event / 100 Mbit re-link | **Ethernet link (I225-V/driver/cable/port)** | e2fexpress 27/32/33 timeline, link speed history, "general_failure" ICMP status |
| Throughput ≈ 90–95 Mbit/s while tariff is higher, link speed 100 Mbit/s | **Link negotiated at 100 Mbit/s** (cable pair / port / NIC) | speed test vs. link speed |
| Gateway clean; CMTS hop + beyond spike/loss together (v4 and v6) | **DOCSIS access segment** (noise, upstream congestion, segment overbooking) | per-layer chart, evening heatmap, router DOCSIS stats (router agent) |
| CMTS, core and AFTR (v6) clean; IPv4 targets (incl. post-AFTR hop) degrade, IPv6 targets clean | **DS-Lite AFTR / CGNAT** | v4-vs-v6 split chart, STUN mapped-port changes |
| Only one destination degrades; persistent from hop N | **Remote network / peering** at hop N | attributed MTR table |
| Spikes only while own PC is loading (adapter bytes/s high) or during load test | **Bufferbloat / self-induced queueing** | latency vs. local throughput scatter, bufferbloat grade + queue location |
| Gateway-only spikes, nothing beyond | **Router control plane** (benign for gaming) | info hint |
| Periodic spikes (ACF peak) | background process / scan / scheduled job | period + hints |

---------------------------------------------------------------------------------------------------

## 9. Bufferbloat

### 9.1 How the reference tools do it

- **Waveform** (live bundle, constants object) [SOURCE code]: `PING_INTERVAL: 100` ms, `LATENCY_MEASUREMENT_DURATION: 8` s (unloaded), `DOWNLOAD_DURATION: 20` s, `UPLOAD_DURATION: 20` s, `NUM_LATENCY_STREAMS: 6`, `BANDWIDTH_NUM_STREAMS: 12` (`CF_SPEEDTEST: 6` streams to speed.cloudflare.com + `CF_WORKERS: 6` to their own Cloudflare workers), `IGNORE_FIRST_N_SECONDS: 4`, `IGNORE_N_LATENCIES: 3`, `BUFFERBLOAT_MEASUREMENT_METHOD: MEAN` (median for result versions < 1.0.7). Latency = `TTFB − server-timing` to cached Cloudflare endpoints. Grade text: "We compare your idle latency with your latency during the download and upload tests. **Whichever test creates the larger increase determines your final grade.**" Scale A+ <5, A <30, B <60, C <200, D <400, F ≥400 ms.
- **DSLReports** (legacy): same letter scale but based on the **average** of download and upload increase [SOURCE: forum summary, not official doc].
- **Cloudflare speed test** [SOURCE code]: sequential single-stream requests of increasing size (100 kB…250 MB down, 100 kB…50 MB up), a size class finishes once a request takes > `bandwidthFinishRequestDuration` = 1000 ms; loaded latency = parallel `__down?bytes=0&during=download|upload` every `loadedLatencyThrottle` = 400 ms, only from size classes whose min request duration ≥ 250 ms, last 20 points, **median**; bandwidth = **90th percentile** of per-request bps (requests ≥ 10 ms). Packet loss via WebRTC TURN (`turn.speed.cloudflare.com:50000`, 1000 msgs in batches of 10).
- **IETF responsiveness draft-09** [SOURCE]: up to 16 parallel HTTP/2 load connections added stepwise, 5-s intervals, moving average over 4 intervals, stability when stddev of moving averages within 5 %; probes ≤ 100/s and ≤ 5 % of capacity; trimmed mean 95 %; RPM bands see §2.1.
- **Flent RRUL**: 4 TCP down + 4 TCP up + ICMP & UDP RTT probes, typically 60 s [SOURCE; default length UNCERTAIN].

### 9.2 Our test plan [RECOMMENDATION]

| Phase | Duration | Load | Latency probes |
|---|---|---|---|
| 0 Idle | 10 s | none (abort/postpone if local adapter throughput > 2 Mbit/s) | every 200 ms: ICMP gateway, CMTS, AFTR(v6), 1.1.1.1 (v4) ; HTTP `__down?bytes=0` every 400 ms on a warm keep-alive connection (`TTFB − server-timing`) |
| 1 Download | 15 s | 6 parallel streaming GETs `__down?bytes=25000000` (re-issue on completion), `accept-encoding: identity` | same |
| 2 Upload | 15 s | 4–6 parallel POST `__up` with 10 MB bodies (re-issue) | same |

- Discard the first **3 s** of each load phase (ramp-up; Waveform discards 4 s).
- Throughput: bytes per 250 ms bin (download from body chunk callbacks; upload approximated from completed requests/stream pulls [UNCERTAIN accuracy]); report median and p90 of bins after ramp; record link speed at test time.
- Loaded latency stats per phase and per layer: mean (grade), median, p95; increase vs. idle (mean); **grade = Waveform scale on max(DL, UL) increase**; also DSLReports-style average, RPM (60000/median loaded RTT), AIM `loadedLatencyIncrease`.
- **Queue localisation**: the bottleneck queue sits before the first layer whose loaded RTT rises: gateway rises under download ⇒ queue at the router's LAN port (100 Mbit link!) ; CMTS rises under upload ⇒ cable-modem upstream buffer; only post-AFTR ⇒ CGNAT/ISP.
- Data volume: ~15 s × 95 Mbit/s ≈ 180 MB down + 15 s × 20–50 Mbit/s ≈ 40–95 MB up ⇒ **~250 MB per test**. Default schedule every 6 h + manual button; disabled while the user flags "Gaming aktiv"; cap per test 400 MB; store bytes used.
- Light throughput sample (optional, every 60 min): 1 × 25 MB down + 1 × 10 MB up (~35 MB).
- Handle HTTP 429 like the official client: up to 3 retries honouring `Retry-After` (default 5 s), then mark provider unavailable and fall back (§10.5).

---------------------------------------------------------------------------------------------------

## 10. Cloudflare speed test endpoints

### 10.1 Verified requests (2026-10-09 12:41 UTC, Windows `curl.exe` 8.21.0 / Schannel; Git-Bash curl 8.8.0 failed silently on TLS → use `C:\Windows\System32\curl.exe` or Node)

| Request | Result |
|---|---|
| `GET /__down?bytes=0&during=idle` ×3 (IPv6, new connections) | 200, `Content-Length: 0`; TCP connect 30–113 ms (!), TLS +41–69 ms, TTFB−pretransfer 50–73 ms, `Server-Timing: cfSpeedEdge;dur=6, cfSpeedWorker;dur=43` ⇒ RTT ≈ 24 ms |
| same, forced IPv4 | 200, server 31 ms, TTFB−pretransfer 91 ms ⇒ ≈ 60 ms (jittery moment) |
| two requests on one connection | 2nd: `num_connects=0`, TTFB 38 ms (keep-alive works; one response carried `Connection: close`, others `keep-alive`) |
| `GET /__down?bytes=5000000` | 200, 5,000,000 B, TTFB 136 ms (server 27 ms), **payload 471 ms ⇒ ≈ 85 Mbit/s** (≈ ceiling of a 100 Mbit/s Ethernet link) |
| `POST /__up` 1,000,000 B (`text/plain;charset=UTF-8`) | 200, empty body, `cf-meta-upload-bytes: 1000000`, `Server-Timing: cfSpeedEdge;dur=5, cfSpeedWorker;dur=360` (**worker time includes body reception**), TTFB−pretransfer 397 ms ⇒ ≈ 20 Mbit/s single request incl. slow start (underestimate) |
| `GET /meta`, `GET /locations` | **403 without `Referer: https://speed.cloudflare.com/`**; with it: /meta JSON `{hostname, clientIp, httpProtocol, asn: 3209, asOrganization: "Vodafone West GmbH", country, city, region, postalCode, latitude, longitude, colo:{iata:"DUS", lat, lon, cca2, region, city}}`; /locations = 309 colos (~30 kB) |
| `GET /cdn-cgi/trace` | works without headers; key=value: `fl, h, ip, ts, visit_scheme, uag, colo=DUS, sliver, http=http/1.1, loc=DE, tls=TLSv1.3, sni, warp=off, gateway=off, rbi=off, kex=X25519` |

### 10.2 Response headers (current format)

- `__down`: `Content-Type: application/octet-stream`, `Cache-Control: no-store, no-transform`, `Access-Control-Allow-Origin: *`, `timing-allow-origin: *`, `cf-meta-ip`, `cf-meta-request-time` (epoch ms), **unprefixed geo headers** `asn`, `city`, `colo`, `country`, `latitude`, `longitude`, `postalCode`, `timezone` (while `access-control-expose-headers` still lists `cf-meta-colo`, `cf-meta-asn`, … → read `colo ?? cf-meta-colo`), `Server-Timing: cfSpeedEdge;dur=…, cfSpeedWorker;dur=…`, and a second `server-timing: cfL4;desc="?proto=TCP&rtt=<µs>&min_rtt=<µs>&rtt_var=<µs>&sent=…&recv=…&lost=…&retrans=…&sent_bytes=…&recv_bytes=…&delivery_rate=…&cwnd=…&unsent_bytes=0&cid=…&ts=…&x=0"` (server-side TCP stats at response-header time — only covers the handshake for downloads), `CF-RAY: <id>-DUS`.
- `__up`: `cf-meta-colo`, `cf-meta-request-time`, `cf-meta-upload-bytes`, `Server-Timing` as above, `cfL4` with `recv_bytes`.
- Node `fetch` joins multiple `server-timing` headers with ", " → one regex pass works.

### 10.3 Parameters & official algorithm (`cloudflare/speedtest`, `src/config/defaultConfig.ts`, `BandwidthEngine.ts`) [SOURCE code]

- Query params: `bytes` (required), `measId` (random 16-digit id per test), `during=idle|download|upload` for latency probes; Waveform adds `uuid`. Upload body: `'0'.repeat(bytes)`.
- Server time: `/(?:^|,\s*)cfReq(?:uest)?Dur(?:ation)?;\s*dur=([0-9.]+)/i`, else **sum of** `/(?:^|,\s*)cfSpeed[a-zA-Z]*;\s*dur=([0-9.]+)/gi` (values ≤ 0.01 ignored).
- `ping = TTFB − serverTime − serverTimeDelta` (delta calibrated from HTTP/1.1 new connections, ≤ 15 ms); download duration = ping + payload time; download bps = `8 × (transferSize || bytes × 1.005) / duration`; **upload duration = TTFB (requestStart→responseStart), bps = 8 × bytes × 1.005 / duration**.
- Default sequence: latency 2 + 20 pings; down 1e5×10, 1e6×8, 1e7×6, 2.5e7×4, 1e8×3, 2.5e8×2; up 1e5×8, 1e6×6, 1e7×4, 2.5e7×4, 5e7×3; packet loss 1000 msgs; `bandwidthPercentile 0.9`, `latencyPercentile 0.5`, `bandwidthMinRequestDuration 10`, `loadedRequestMinDuration 250`, `loadedLatencyThrottle 400`, `loadedLatencyMaxPoints 20`, `bandwidthFinishRequestDuration 1000`.
- 429: retry ≤ 3× with `Retry-After` (seconds or HTTP date; default 5000 ms).
- Limits/fair use: **not documented** [UNCERTAIN]. Official client goes up to 250 MB/download request and 50 MB/upload request; Waveform runs 6 parallel streams against speed.cloudflare.com. Cloudflare's 2025 blog mentions a "Network Quality API" for partners and the client has an experimental `Authorization: Bearer` token option — endpoints currently work without token (verified), but may be restricted later → implement a provider abstraction with fallbacks.

### 10.4 Node client sketch [RECOMMENDATION]

```ts
const ST_RE = /(?:^|,\s*)cfReq(?:uest)?Dur(?:ation)?;\s*dur=([0-9.]+)/i, SPEED_RE = /(?:^|,\s*)cfSpeed[a-zA-Z]*;\s*dur=([0-9.]+)/gi;
export function serverTimeMs(h: string|null): number|undefined { if (!h) return; const m = h.match(ST_RE); if (m && +m[1] > 0.01) return +m[1];
  let s = 0; for (const x of h.matchAll(SPEED_RE)) s += +x[1]; return s > 0.01 ? s : undefined; }
export async function cfDown(bytes: number, measId: string, onChunk?: (n: number, t: number) => void, signal?: AbortSignal) {
  const t0 = performance.now();
  const res = await fetch(`https://speed.cloudflare.com/__down?bytes=${bytes}&measId=${measId}`, { headers: { 'accept-encoding': 'identity' }, signal });
  const tHdr = performance.now(); if (res.status === 429) throw Object.assign(new Error('429'), { retryAfter: res.headers.get('retry-after') });
  let n = 0; const rd = res.body!.getReader(); for (;;) { const { done, value } = await rd.read(); if (done) break; n += value.byteLength; onChunk?.(value.byteLength, performance.now()); }
  const tEnd = performance.now(), srv = serverTimeMs(res.headers.get('server-timing'));
  return { bytes: n, ttfbMs: tHdr - t0, serverMs: srv, rttMs: srv != null ? tHdr - t0 - srv : null, payloadMs: tEnd - tHdr, mbps: (n * 8) / ((tEnd - tHdr) / 1000) / 1e6, colo: res.headers.get('colo') ?? res.headers.get('cf-meta-colo') };
}
export async function cfUp(bytes: number, measId: string, signal?: AbortSignal) {
  const body = Buffer.alloc(bytes, 0x30), t0 = performance.now();
  const res = await fetch(`https://speed.cloudflare.com/__up?measId=${measId}`, { method: 'POST', body, headers: { 'content-type': 'text/plain;charset=UTF-8' }, signal });
  const tHdr = performance.now(); await res.arrayBuffer();
  return { bytes: Number(res.headers.get('cf-meta-upload-bytes') ?? bytes), durationMs: tHdr - t0, mbps: (bytes * 8 * 1.005) / ((tHdr - t0) / 1000) / 1e6 };
}
```
Note: the first request on a connection includes TCP+TLS in TTFB — for latency probes use a dedicated keep-alive `undici` Pool (connections 1) and discard the first (warm-up) sample; for parallel streams use separate connections (undici default Agent opens parallel connections per origin).

### 10.5 Alternatives / fallbacks [VERIFIED reachability]

| Provider | Endpoint | Notes |
|---|---|---|
| LibreSpeed public backends | list: `https://librespeed.org/backend-servers/servers.php` (22 servers), e.g. Frankfurt `https://fra.speedtest.clouvider.net/backend/` + `garbage.php?ckSize=<MiB chunks>` (download), `empty.php` (upload POST / ping), `getIP.php` | ckSize = number of 1 MiB chunks; server cap ~1024 [UNCERTAIN] |
| M-Lab NDT7 | locate: `https://locate.measurementlab.net/v2/nearest/ndt/ndt7` → `wss://<machine>/ndt/v7/download|upload?access_token=…` (returned Frankfurt machines) | WebSocket subprotocol `net.measurementlab.ndt.v7`, ~10 s per direction, server sends TCPInfo (MinRTT etc.). **Privacy: M-Lab publishes test data incl. client IP as open data** → only with explicit opt-in |
| OVH | `https://proof.ovh.net/files/100Mb.dat` (104,857,600 B; http→https 301) | static file |
| Tele2 | `http://speedtest.tele2.net/100MB.zip` (200) | HTTP only |
| Hetzner | `https://nbg1-speed.hetzner.com/100MB.bin` (also fsn1/hel1/ash) | Range GET works (206); HEAD failed with Schannel close_notify; `speed.hetzner.de` is gone (no DNS) |

---------------------------------------------------------------------------------------------------

## 11. Aggregation & storage

### 11.1 Sizing [VERIFIED with node:sqlite, 1,000,000 rows]

| Layout | Bytes/row | Insert rate (batched txn) | 1-h range query |
|---|---|---|---|
| `WITHOUT ROWID`, PK `(probe_id, ts)` | **18.8** | ~1.1 M rows/s | < 1 ms |
| rowid table + index `(target, ts)` | 40.2 | ~0.9 M rows/s | ~1 ms |

At 8 probes × 1 Hz = 691,200 rows/day ≈ **13 MB/day** (WITHOUT ROWID). MTR-light (≈ 15 hops @ 0.2 Hz) adds ~260 k rows/day ≈ 5 MB. ⇒ 30 days raw ≈ 0.55 GB.

### 11.2 Schema [RECOMMENDATION]

```sql
PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000; PRAGMA journal_size_limit=67108864;
-- auto_vacuum must be set before the first table is created (optional):
PRAGMA auto_vacuum=INCREMENTAL;

CREATE TABLE probe (id INTEGER PRIMARY KEY, kind TEXT NOT NULL,      -- icmp4|icmp6|stun4|stun6|dns4|dns6|tcp|hop4|hop6
  target TEXT NOT NULL, layer TEXT NOT NULL,                          -- lan|access|core|aftr|post_aftr|internet|game
  label TEXT, interval_ms INTEGER NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, path_id INTEGER, ttl INTEGER);

CREATE TABLE sample (                     -- one row per probe execution
  probe_id INTEGER NOT NULL, ts INTEGER NOT NULL,    -- epoch ms (send time)
  rtt_us INTEGER,                                    -- NULL if no reply (ICMP API gives ms → store ms*1000)
  status INTEGER NOT NULL,                           -- 0 ok,1 timeout,2 host_unr,3 net_unr,4 general_failure,5 ttl_expired,6 error,9 gap
  reply_ttl INTEGER, ctx INTEGER NOT NULL DEFAULT 0, -- ctx: 0 idle, 1 load_test, 2 burst_mode
  PRIMARY KEY (probe_id, ts)) WITHOUT ROWID;

CREATE TABLE rollup_1m (
  probe_id INTEGER NOT NULL, minute INTEGER NOT NULL,          -- epoch seconds / 60
  sent INTEGER NOT NULL, recv INTEGER NOT NULL,
  rtt_min REAL, rtt_max REAL, rtt_sum REAL, rtt_sumsq REAL,    -- ms
  p50 REAL, p95 REAL, p99 REAL,                                -- exact from raw at rollup time (display convenience)
  jit_sum REAL, jit_n INTEGER,                                 -- MASD components (mergeable)
  max_loss_run INTEGER, loss_runs INTEGER, outage_s INTEGER,
  spikes INTEGER, spikes_major INTEGER, spikes_200 INTEGER,
  hist TEXT,                                                   -- sparse JSON {"bucketIdx": count}, log buckets (11.3)
  ctx_mask INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (probe_id, minute)) WITHOUT ROWID;
CREATE TABLE rollup_1h ( /* same columns, hour = epoch s / 3600 */ probe_id INTEGER NOT NULL, hour INTEGER NOT NULL,
  sent INTEGER, recv INTEGER, rtt_min REAL, rtt_max REAL, rtt_sum REAL, rtt_sumsq REAL, p50 REAL, p95 REAL, p99 REAL,
  jit_sum REAL, jit_n INTEGER, max_loss_run INTEGER, loss_runs INTEGER, outage_s INTEGER, spikes INTEGER, spikes_major INTEGER, spikes_200 INTEGER,
  hist TEXT, ctx_mask INTEGER, PRIMARY KEY (probe_id, hour)) WITHOUT ROWID;

CREATE TABLE event (id INTEGER PRIMARY KEY, ts_start INTEGER NOT NULL, ts_end INTEGER, kind TEXT NOT NULL,  -- outage|loss_burst|spike_episode|level_shift|path_change|gap|link_down|nat_mapping_change|periodicity
  scope TEXT, layer TEXT, severity INTEGER, probe_id INTEGER, details TEXT);              -- details = JSON
CREATE INDEX event_ts ON event(ts_start);
CREATE TABLE path (id INTEGER PRIMARY KEY, family INTEGER, dest TEXT, first_seen INTEGER, last_seen INTEGER, hops TEXT); -- hops JSON ["192.168.0.1",null,"92.79.214.92",…]
CREATE TABLE load_test (id INTEGER PRIMARY KEY, ts INTEGER, provider TEXT, colo TEXT, link_mbps INTEGER, down_mbps REAL, up_mbps REAL,
  idle_ms REAL, dl_loaded_ms REAL, ul_loaded_ms REAL, dl_increase_ms REAL, ul_increase_ms REAL, grade TEXT, rpm REAL, bytes_used INTEGER, details TEXT);
```

### 11.3 Mergeable percentiles: log-bucket histogram (DDSketch-style) [RECOMMENDATION; VERIFIED accuracy]

- Percentiles **cannot be averaged** across minutes. Options: (a) recompute from raw while raw exists (≤ 30 days), (b) store a mergeable sketch. Use (b) for all rollups, (a) optionally for "exact" views.
- Buckets: `γ = 1.04` (relative accuracy α = (γ−1)/(γ+1) ≈ 1.96 %), values in ms, `idx = ceil(ln(ms/0.1)/ln γ)` (ms ≤ 0.1 → 0), representative value `0.1·2γ^idx/(γ+1)`. 1 ms→59, 10→118, 20→136, 50→159, 100→177, 200→194, 1000→235, 5000→276.
- Merge = add counts per idx. Quantile = walk sorted idx until cumulative count > q·(n−1).
- Simulated day @1 Hz [VERIFIED]: p50/p95/p99/p99.9 error +1.6/−1.0/+1.6/−0.5 %; **~12.7 non-empty buckets/minute ≈ 103 bytes JSON** → 8 probes ≈ 1.2 MB/day.
- (t-digest is also mergeable but more complex and less predictable for tails; HDR histograms need fixed ranges. The log-bucket sketch is ~20 lines.)

Merge rules for rollups: `sent, recv, rtt_sum, rtt_sumsq, jit_sum, jit_n, loss_runs, outage_s, spikes*` → sum; `rtt_min/max` → min/max; `max_loss_run` → max (runs crossing minute boundaries are split → take loss runs/outages from the `event` table for exact values); `p50/p95/p99` → from merged `hist`; stddev = `sqrt((sumsq − sum²/n)/(n−1))`; MASD = `jit_sum/jit_n`.

### 11.4 Retention & jobs [RECOMMENDATION]

- Raw `sample`: **30 days** default (configurable 7–90). Rollup_1m: **400 days**. Rollup_1h + events + paths + load tests: forever.
- Writer: buffer samples in memory, flush every 1 s in one transaction (node:sqlite is synchronous; a 20-row insert is sub-millisecond).
- Minute job at second :05 → rollup previous minute from raw + in-memory spike state; hour job at :01:30 → rollup_1h from rollup_1m.
- Daily cleanup (e.g. 04:00): `DELETE FROM sample WHERE probe_id = ? AND ts < ?` once per probe (uses the PK range; ~86 k rows per probe per day — fast; don't rely on `DELETE … LIMIT`, which needs a non-default SQLite compile option), then `PRAGMA incremental_vacuum(2000)` if auto_vacuum=INCREMENTAL; otherwise freed pages are simply reused (steady-state file size).
- UI query routing: ≤ 6 h → raw; ≤ 14 days → rollup_1m; longer → rollup_1h.
- node:sqlite prints an ExperimentalWarning on Node 22.16 → start with `--disable-warning=ExperimentalWarning` (works as node flag and via `NODE_OPTIONS=--disable-warning=ExperimentalWarning` [VERIFIED with plain node]; tsx inherits `NODE_OPTIONS` [UNCERTAIN, tsx not installed here]).

---------------------------------------------------------------------------------------------------

## 12. Composite gaming score (explainable) [RECOMMENDATION]

**Score = 100 × Π fᵢ**, each factor fᵢ ∈ [0,1] from piecewise-linear interpolation (clamped) over anchor points:

| Factor | Metric (window) | Anchors (value → factor) |
|---|---|---|
| Latenz | RTT p50 to the primary game/reference target | ≤35 →1.00, 60 →0.92, 100 →0.75, 150 →0.50, 200 →0.30, ≥300 →0 |
| Jitter | MASD | ≤3 →1.00, 5 →0.97, 10 →0.90, 20 →0.75, 30 →0.60, 50 →0.35, ≥100 →0 |
| Spitzen | p99 − p50 | ≤15 →1.00, 30 →0.95, 50 →0.85, 100 →0.65, 200 →0.40, ≥400 →0.10 |
| Verlust | loss % (internet-wide) | 0 →1.00, 0.1 →0.98, 0.5 →0.90, 1 →0.80, 2 →0.60, 5 →0.30, ≥10 →0 |
| Ausfälle | outages ≥3 s per hour | 0 →1.00, 0.04 (1/Tag) →0.95, 0.25 →0.85, 1 →0.60, 3 →0.30, ≥6 →0.10 |

- Grade: ≥85 A "sehr gut", ≥70 B "gut", ≥55 C "ok", ≥40 D "mäßig", <40 F "schlecht" (A/B green, C yellow, D/F red).
- **Explainability**: "points lost" per factor = `(100 − score) × ln fᵢ / Σ ln fⱼ` (additive, sums to the deficit) + "limitierender Faktor" = lowest fᵢ (if < 0.97). Example [VERIFIED in analysis.js]: p50 25 ms, MASD 12 ms, p99−p50 120 ms, loss 0.8 %, 0.5 outages/h → **34 (F)**; points lost: Spitzen 31.1, Ausfälle 16.2, Verlust 10.6, Jitter 8.5, Latenz 0 → "limitierender Faktor: Latenzspitzen". Ideal line → 100 (A).
- Windows: live (15 min), hourly, daily; daily uses the day's merged histogram/rollups.
- The multiplicative form means one severe problem (e.g. 5 % loss → ×0.3) cannot be hidden by good values elsewhere — matching how games feel.
- Bufferbloat is shown separately ("Unter Last"-Note) rather than in the live score (it is a risk under load, not continuous experience); optionally multiply its factor (Δ ≤30 →1, 60 →0.95, 200 →0.8, 400 →0.6, ≥800 →0.4) into a "Score unter Last".
- Secondary, citable references: **Cloudflare AIM gaming class** (needs idle latency, loss ratio, loaded increase; §2.1) and **E-model MOS** for voice chat (PingPlotter/NetBeez simplification): `EL = avgRTT + 2·jitter + 10; R = EL<160 ? 93.2 − EL/40 : 93.2 − (EL−120)/10; R −= 2.5·loss%; MOS = 1 + 0.035R + 7e-6·R(R−60)(100−R)` (clamp R<0 → 1, R>100 → 4.5).

```ts
const interp = (x: number, p: [number, number][]) => { if (x <= p[0][0]) return p[0][1];
  for (let i = 1; i < p.length; i++) if (x <= p[i][0]) { const [x0, y0] = p[i-1], [x1, y1] = p[i]; return y0 + (y1 - y0) * (x - x0) / (x1 - x0); }
  return p[p.length - 1][1]; };
export const ANCHORS = { latencyP50: [[35,1],[60,.92],[100,.75],[150,.5],[200,.3],[300,0]], jitterMasd: [[3,1],[5,.97],[10,.9],[20,.75],[30,.6],[50,.35],[100,0]],
  spikeTail: [[15,1],[30,.95],[50,.85],[100,.65],[200,.4],[400,.1]], lossPct: [[0,1],[.1,.98],[.5,.9],[1,.8],[2,.6],[5,.3],[10,0]],
  outagesPerHour: [[0,1],[.04,.95],[.25,.85],[1,.6],[3,.3],[6,.1]] } as Record<string, [number, number][]>;
export function gamingScore(m: Partial<Record<keyof typeof ANCHORS, number>>) {
  const f: Record<string, number> = {}; for (const k in ANCHORS) if (m[k as keyof typeof m] != null) f[k] = interp(m[k as keyof typeof m]!, ANCHORS[k]);
  const prod = Object.values(f).reduce((a, b) => a * b, 1), score = Math.round(100 * prod), ln = Object.values(f).reduce((s, v) => s + Math.log(Math.max(v, 1e-6)), 0);
  const pointsLost = Object.fromEntries(Object.entries(f).map(([k, v]) => [k, ln < 0 ? (100 - 100 * prod) * Math.log(Math.max(v, 1e-6)) / ln : 0]));
  const worst = Object.entries(f).sort((a, b) => a[1] - b[1])[0];
  return { score, grade: score >= 85 ? 'A' : score >= 70 ? 'B' : score >= 55 ? 'C' : score >= 40 ? 'D' : 'F', factors: f, pointsLost, limitingFactor: worst && worst[1] < 0.97 ? worst[0] : null }; }
```

---------------------------------------------------------------------------------------------------

## 13. Metric catalogue (what to measure, store and show)

| Group | Metric | Cadence | Stored as |
|---|---|---|---|
| Continuous per target (§1.5) | RTT, status, reply TTL | 1 Hz | `sample` |
| | loss %, min/avg/max, p50/p95/p99, MASD, stddev, RFC3550 J (live), max loss run, spikes (minor/major/≥200) | per minute/hour | `rollup_1m/1h` |
| UDP/TCP/DNS | STUN RTT/loss + mapped IPv4:port changes (CGNAT), DNS RTT/failures, TCP connect RTT to game endpoints | 0.1–0.2 Hz | `sample` + `event(nat_mapping_change)` |
| Path | hop list (v4/v6), per-hop RTT/loss, link vs node loss attribution, path changes, propagation ratio | 0.2 Hz (1 Hz in burst mode), discovery every 15 min | `sample` (hop probes), `path`, `event` |
| Events | outages (scope, duration), loss bursts, spike episodes, level shifts, gaps (standby), periodicity findings | on detection | `event` |
| Load | bufferbloat test (idle/loaded per layer, Δ, grade, RPM, AIM), throughput DL/UL (median/p90), link speed at test time, bytes used | every 6 h + manual; light sample hourly (opt.) | `load_test` |
| Derived KPIs | gestörte Sekunden (ES/SES), availability, gaming score + factors + limiting factor, MOS, hour×weekday heatmap, fault-localisation verdicts | live/hourly/daily | computed from rollups/events |
| From other agents | NIC link state/speed, e2fexpress link drops, suspend/resume, local adapter throughput (self-load correlation), router DOCSIS stats | — | own tables, correlated by time |

---------------------------------------------------------------------------------------------------

## 14. Preliminary observations on this machine (small ad-hoc samples, 2026-10-09 ~14:40–15:05 CEST — NOT conclusions)

- **Throughput capped by the 100 Mbit/s Ethernet link**: single 5 MB download payload rate ≈ 85 Mbit/s (TCP max on 100BASE-TX ≈ 94). If the tariff is > 100 Mbit/s, the downshifted link (30 of 77 re-links came up at 100 Mbit/s) is costing bandwidth and is consistent with a cable/pair/port or I225-V issue (Windows/hardware agents).
- **Gateway** 0–2 ms (stable) vs **first ISP hop (CMTS)** 10/12/12/34/41 ms and AFTR 11–48 ms ⇒ second-to-second variation (~20 ms MASD) appears **from the DOCSIS hop onward**, not in the LAN (must be confirmed by long-term data and by checking that it is data-plane, i.e. propagates to later hops).
- Ad-hoc spikes: 1.1.1.1 141–150 ms (4 parallel probes at the same moment), IPv6 1.1.1.1 120 ms once; TCP handshakes to speed.cloudflare.com 30–113 ms vs. ~20 ms ICMP baseline.
- DS-Lite confirmed: IPv4 hop 2 silent (AFTR), IPv4 PMTU 1460, AFTR reachable via IPv6 (6 hops, ~11–16 ms min). Cloudflare colo DUS for v4 and v6.
- No loss observed in the few dozen probes sent.

---------------------------------------------------------------------------------------------------

## 15. Open points / uncertainties

- Cloudflare fair-use limits and long-term third-party access (token?) — undocumented. Keep providers swappable; keep test volume modest.
- Exact accuracy of upload throughput time-series in Node (no ACK visibility) — use request-level averages as the authoritative number.
- Whether `performance.now()` advances across standby on this machine — use wall-clock deltas for gap detection.
- TG6442 chipset (Puma 7 vs. other) unverified; historic Puma 6/7 latency issues are anecdotal — detect empirically (gateway vs. WAN spikes correlation).
- DOCSIS-hop thresholds (CMTS p50 ≤ 15 ms "gut") are empirical; ICMP replies from the CMTS are control-plane (use propagation test before blaming DOCSIS).
- 1.1.1.1 / 8.8.8.8 ICMP rate limits at 5–10 Hz (bufferbloat/burst mode) unknown — keep ≤ 5 Hz per public target, prefer own-ISP hops/gateway for 10 Hz.
- pathping German column headers, LibreSpeed ckSize cap, flent default length — not verified.
- `NODE_OPTIONS=--disable-warning=ExperimentalWarning` verified with plain node; behaviour under tsx not verified.

---------------------------------------------------------------------------------------------------

## 16. Sources

- Cloudflare speedtest engine source: https://github.com/cloudflare/speedtest (files `src/config/defaultConfig.ts`, `src/config/internalConfig.ts`, `src/Results/MeasurementCalculations.ts`, `src/Results/ScoresCalculations.ts`, `src/engines/BandwidthEngine/BandwidthEngine.ts`, `ParallelLatency.ts`; copies in `cf_src/`)
- Cloudflare blog "How does Cloudflare's Speed Test really work?" (2025-10-27): https://blog.cloudflare.com/how-does-cloudflares-speed-test-really-work/
- Cloudflare AIM: https://blog.cloudflare.com/aim-database-for-internet-quality/ , https://developers.cloudflare.com/speed/aim/
- Waveform bufferbloat test (constants/grades extracted from live bundle `/tools/bufferbloat/assets/entry_v2-4-FYV5f7.js`, 2026-10-09): https://www.waveform.com/tools/bufferbloat
- DSLReports grade scale (forum summaries): https://mailman.nanog.org/pipermail/nanog/2016-July/087221.html ; 8x8 docs https://docs.8x8.com/8x8WebHelp/8x8-network-utility/2-3/maximum-acceptable-limits.htm
- IETF draft-ietf-ippm-responsiveness-09: https://datatracker.ietf.org/doc/draft-ietf-ippm-responsiveness/
- RFC 3550 (RTP, interarrival jitter §6.4.1/A.8): https://www.rfc-editor.org/rfc/rfc3550
- RFC 5481 (PDV vs IPDV applicability): https://www.rfc-editor.org/rfc/rfc5481.html
- RFC 3393 (IPDV), RFC 3357 (loss patterns), RFC 3611 (burst/gap, Gmin=16, §4.7.2): https://www.rfc-editor.org/rfc/rfc3611.html
- RFC 8489 (STUN): https://www.rfc-editor.org/rfc/rfc8489
- ITU-T Y.1541 class 0 summary (IPTD 100 ms, IPDV 50 ms, IPLR 1e-3, 1-min evaluation): https://datatracker.ietf.org/doc/html/draft-ietf-nsis-y1541-qosm-07 and https://www.itu.int/rec/T-REC-Y.1541
- 3GPP TS 23.203 QCI table: https://itecspec.com/3gpp/23.203/s/6.1.7.2 ; https://en.wikipedia.org/wiki/QoS_Class_Identifier
- 3GPP TR 26.928 §4.2.2 (game delay tolerance): https://itecspec.com/3gpp/26.928/s/4.2.2
- Claypool & Claypool, "Latency and Player Actions in Online Games", CACM 2006: https://cacm.acm.org/magazines/2006/11/5798-latency-and-player-actions-in-online-games
- Richard A. Steenbergen, "A Practical Guide to (Correctly) Troubleshooting with Traceroute" (book format, 2011): https://major.io/wp-content/uploads/2012/06/RAS_Traceroute_Book_Format.pdf ; NANOG 47 slides: https://archive.nanog.org/meetings/nanog47/presentations/Sunday/RAS_Traceroute_N47_Sun.pdf
- Akamai (Linode) "Diagnosing Network Issues with MTR": https://www.akamai.com/cloud/guides/diagnosing-network-issues-with-mtr/
- Microsoft Learn: tracert https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/tracert ; pathping https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/pathping
- IcmpSendEcho / Icmp6SendEcho2 (iphlpapi): https://learn.microsoft.com/en-us/windows/win32/api/icmpapi/nf-icmpapi-icmpsendecho , https://learn.microsoft.com/en-us/windows/win32/api/icmpapi/nf-icmpapi-icmp6sendecho2
- koffi docs (async calls on worker threads, settings): https://koffi.dev/ (bundled `doc/misc.md`, `doc/load.md`)
- PingPlotter MOS & jitter: https://www.pingman.com/kb/article/how-is-mos-calculated-in-pingplotter-pro-50.html ; NetBeez E-model: https://netbeez.net/blog/impact-of-packet-loss-jitter-and-latency-on-voip/
- Leys et al. (2013) "Detecting outliers: Do not use standard deviation around the mean, use absolute deviation around the median", J. Exp. Soc. Psych. 49(4):764–766
- DDSketch (Masson, Rim, Lee, VLDB 2019): https://arxiv.org/abs/1908.10693
- CableLabs Low Latency DOCSIS: https://datatracker.ietf.org/doc/draft-white-tsvwg-lld/ , https://www.cablelabs.com/technologies/low-latency-docsis
- Flent RRUL: https://flent.org/tests.html , https://netbeez.net/blog/flent/
- LibreSpeed servers: https://librespeed.org/backend-servers/servers.php ; M-Lab locate v2: https://locate.measurementlab.net/v2/nearest/ndt/ndt7 ; NDT7 spec: https://github.com/m-lab/ndt-server/blob/main/spec/ndt7-protocol.md
- Vodafone forum (Station chipsets/latency anecdotes): https://forum.vodafone.de/t5/Archiv-Internet-Ger%C3%A4te/alternatives-Modem-mit-Broadcom-Modem-Chip/m-p/1794519/highlight/true
