# Architecture & implementation contract

Binding for everyone writing code in this repo. If something is unclear, choose the simplest option
that keeps the contracts intact and mention the decision in your final report.
Research behind these decisions: `docs/research/*.md` (verified on this machine) and runnable
reference code in `docs/research/code/` (read it – do not import it). Real captured outputs of
Windows tools and the router are in `fixtures/` (use them in unit tests).

## 1. Overview

```
 Browser (React UI, German)
    │  fetch /api/*  +  EventSource /api/live
    ▼
 Next.js 16 (127.0.0.1:3000) ── reads ──►  SQLite  data/netdiag.db  (WAL)
    │  proxies control + live stream               ▲
    ▼                                              │ writes (batched, 1 tx/s)
 Probe engine (Node 22 + tsx, 127.0.0.1:3901) ─────┘      Windows | macOS (§4.11)
    ├─ ICMP pinger agent (ONE powershell.exe, .NET SendPingAsync, 1 Hz grid, + 1 Hz NIC link state)
    │    macOS: Node 1 Hz grid, one /sbin/ping(6) -c 1 per target and tick, ifconfig + netstat ticks
    ├─ TCP connect / DNS-over-UDP / HTTP probes, egress-interface check (1 Hz, Node)
    ├─ path discovery + MTR (.NET TTL probes) / MTU / STUN / speed test / UDP burst
    ├─ PowerShell RPC worker (adapters, routes, identity, TCP counters, DPAPI) + wevtutil (event log)
    ├─ netsh wlan, warp-cli -j, tasklist (game detection)
    │    macOS: networksetup/ifconfig/netstat/route/arp/scutil/ipconfig, system_profiler, pmset, ps,
    │    traceroute(6), Keychain (security) – no PowerShell
    └─ Router adapter (ARRIS Vodafone Station TG6442 web UI)
```

- The engine is the only component that measures. It must run without a browser.
- Next never measures; it reads SQLite for history/analysis and calls the engine for control.
- Heavy analysis (diagnosis over days) runs in Next. The engine only does constant-time work per
  sample/second (rollups, baselines, per-second classification, incident detection).

## 2. Directory layout & ownership

| Path | Owner | Content |
|---|---|---|
| `src/lib/shared/{types,config,stats,metrics,format,api-types,cp850,net}.ts`, `src/lib/shared/db/*` | **contract (fixed)** | Do not edit. If you need more, define module-local types and report it. |
| `engine/core/types.ts`, `engine/db/engine-db.ts` (`openEngineDb(path)`, tested) | **contract (fixed)** | Engine interfaces + SQLite writer |
| `src/lib/server/db.ts`, `src/lib/server/config-store.ts` | **contract (fixed)** | Next DB + config access |
| `engine/main.ts`, `engine/modules.ts`, `engine/core/*` (except types.ts), `engine/server.ts` | E-core | bootstrap, module registry, context (incl. ClientState derivation), bus, logger, hosts registry, session manager, control/SSE server, gap detection, loop lag |
| `engine/analysis/*`, `engine/aggregate/*` | E-analysis | baselines, incident detector, per-second classifier (`seconds_1m`), minute rollups, retention |
| `engine/probes/*` (incl. `pinger.ps1`), `src/lib/shared/parsers/ping.ts`, `src/lib/shared/dns.ts` | E-probes | ICMP pinger agent + ping.exe fallback, TCP/UDP-DNS/HTTP runners, egress check, UDP burst |
| `engine/tasks/{traceroute,mtr,mtu,stun}.ts` (+ `.ps1` helpers), `src/lib/shared/parsers/tracert.ts`, `src/lib/shared/stun.ts`, `src/lib/shared/path-analysis.ts` | E-path | path discovery/route changes/dynamic hosts, MTR + interpretation, MTU, STUN/NAT/CGNAT exit |
| `engine/tasks/speedtest.ts`, `src/lib/shared/grading.ts` | E-speed | Cloudflare speed test, loaded latency, bufferbloat grade, bottleneck localization |
| `engine/platform.ts`, `engine/collectors/macos/*`, `engine/probes/mac-pinger.ts`, `engine/tasks/mac-path.ts`, `src/lib/shared/parsers/macos/*`, `src/lib/shared/platform.ts` | E-macos | platform detection, macOS tool runner + interface catalog, macOS sources of adapter/identity/system/wlan/vpn, Keychain store, system log module, ping-per-tick pinger, traceroute-based TTL runner, DF ping/PMTU, OS wording for UI/diagnosis (§4.11) |
| `engine/collectors/*`, `src/lib/shared/parsers/{netsh,winevent}.ts` | E-windows | PowerShell RPC worker, adapters/routes/addresses, event log (+history, link-drop classification), WLAN, VPN/WARP, system + TCP retransmissions, identity + game detection, DPAPI secret store |
| `engine/router/*`, `src/lib/shared/docsis.ts` | E-router | router module, ARRIS adapter + crypto + parsers, generic adapter, DOCSIS rating, router-log categorizer |
| `src/lib/server/*` (except `diagnosis/`, `db.ts`, `config-store.ts`), `src/app/api/**` | N-api | queries, engine client, route handlers |
| `src/lib/server/diagnosis/*`, `src/lib/shared/scoring.ts` | N-diagnosis | root-cause rules, segment health, gaming score, report data |
| `src/app/globals.css`, `src/app/layout.tsx`, `src/components/**`, `src/lib/client/**` | U-foundation | design system, app shell, UI kit, charts, topology, hooks |
| `src/app/**/page.tsx` | U-pages | pages using the foundation |

Each engine module file exports a factory `createXxxModule(): EngineModule`. E-core loads them via
`engine/modules.ts` with **dynamic imports** – a missing/broken module is logged and skipped, never
fatal (so modules can be developed in parallel).

## 3. Conventions recap (see CLAUDE.md)

Epoch-ms timestamps, RTT in ms, Mbps. German UI strings. Relative imports inside `src/lib/shared`.
`package.json` has `"type": "module"` (ESM; tsx supports top-level await; `import.meta.url` works).
Spawn `%SystemRoot%\System32\…` executables by absolute path with `windowsHide: true`, never
`shell: true`, never `detached: true` (normal children die with the engine – libuv job object).
Decode console output with `ConsoleLineSplitter`/`decodeConsole` (`cp850.ts`): ping/tracert emit
CP850, netsh emits UTF-8, warp-cli ASCII. macOS: tools by absolute path from `MAC_TOOLS`
(`engine/collectors/macos/tools.ts`) via `runTool()` with `LC_ALL=C` (output is UTF-8/ASCII, not
localized); platform checks only through `engine/platform.ts` (`isMac()`, `setPlatformOverride` in tests). Wall clock (`Date.now()`) for timestamps; monotonic
clocks only for durations. Parsers are pure functions with vitest tests on `fixtures/`.

## 4. Engine

### 4.1 Startup (engine/main.ts)

1. Filter only the `node:sqlite` ExperimentalWarning (`.npmrc` already passes `--disable-warning=ExperimentalWarning`).
2. `openEngineDb(resolveDbPath())`.
3. Bind the control server on `127.0.0.1:${ENGINE_PORT}`; on `EADDRINUSE` print
   "Engine läuft bereits (Port 3901 belegt)" and exit(1).
4. Load config (`settings['config']` → `mergeConfig`), create context, PowerShell worker
   (`createPowerShellHost()`), secret store, hosts registry; init modules in this order: system,
   identity, adapter, eventlog, wlan, vpn, router, probes, traceroute, mtr, mtu, stun, speedtest,
   udpburst, incidents, classifier, rollup.
5. Resume a `running` session if `plannedEndAt` is null or in the future (event `session_start`
   with `details.resumed = true`), else mark it `completed` at `plannedEndAt`.
6. Graceful shutdown on SIGINT/SIGTERM/SIGBREAK/SIGHUP: stop + dispose modules (router logs out),
   flush and close DB. `tsx watch` restarts and `taskkill` skip handlers – everything must be
   crash-safe (WAL, idempotent startup). `uncaughtException`/`unhandledRejection`: log, continue.

### 4.2 Context, sessions, client state (E-core)

- `recordSample` → `db.addSample` + `bus.emit('sample')`; `recordEvent` → `db.insertEvent` (null if
  dedup) → `bus.emit('event', {...e, id})`; analogous for metrics/snapshots.
- `config.reload` re-reads settings, emits `config`, calls `reconfigure()` on modules.
- Session start: `expectedInterface` = current IPv4 egress interface (from the latest `client`
  state or adapters snapshot primary route), stored in setting `session.expectedIf` and in the
  `session_start` event details together with `{primaryAdapter, isWifi, linkMbps, ssid, band,
  channel, signalPct}` (A/B comparison of LAN vs. new cable vs. WLAN).
- ClientState: derived each second from the latest `nic` (expected interface's adapter) and
  `egress` ticks + gaming flag; `onExpected = egressV4If === expectedIf` (null if unknown);
  rx/tx Mbps from byte deltas. Emit `bus 'client'` (1 Hz) and metric `net.on_expected_if` (on change).
- Gap detection: 1 s timer; gap > 5 s → `engine_gap` event (ts = last tick, endTs = now, info).
- Loop lag: `monitorEventLoopDelay` → metric `engine.loop_lag_ms` (p99 every 10 s).

### 4.3 Modules (factory → file)

| Module | Factory | File | Runs |
|---|---|---|---|
| system | `createSystemModule` | engine/collectors/system.ts | session: CPU/mem every `systemPollSec`, TCP retrans every 60 s |
| identity | `createIdentityModule` | engine/collectors/identity.ts | always: gateway MAC, DHCP/DNS servers, IPv6 prefix, game processes every `identityPollSec` |
| adapter | `createAdapterModule` | engine/collectors/adapter.ts | always (60 s idle / `adapterPollSec` in session) |
| eventlog | `createEventLogModule` | engine/collectors/eventlog.ts | always (`eventLogPollSec`), history import on first start |
| wlan | `createWlanModule` | engine/collectors/wlan.ts | always (60 s idle / `wlanPollSec`) |
| vpn | `createVpnModule` | engine/collectors/vpn.ts | always (`vpnPollSec`) |
| router | `createRouterModule` | engine/router/index.ts | always (status 300 s idle / config intervals in session) |
| probes | `createProbesModule` | engine/probes/manager.ts | session (pinger agent, TCP/UDP/HTTP runners, egress check) |
| traceroute | `createTracerouteModule` | engine/tasks/traceroute.ts | session start + every `tracerouteEveryMin` + incident + manual |
| mtr | `createMtrModule` | engine/tasks/mtr.ts | every `mtrEveryMin` + incident + manual |
| mtu | `createMtuModule` | engine/tasks/mtu.ts | every `mtuEveryMin` + manual |
| stun | `createStunModule` | engine/tasks/stun.ts | every `stunEveryMin` + on IP/egress change + manual |
| speedtest | `createSpeedtestModule` | engine/tasks/speedtest.ts | schedule + manual |
| udpburst | `createUdpBurstModule` | engine/probes/udp-burst.ts | every `udpBurstEveryMin` + manual |
| incidents | `createIncidentsModule` | engine/analysis/incidents.ts | session |
| classifier | `createClassifierModule` | engine/analysis/classifier.ts | session |
| rollup | `createRollupModule` | engine/aggregate/rollup.ts | always (+ hourly retention) |

Dynamic hosts (engine/core/hosts.ts, E-core): `$gateway` = `config.router.ip`; `$isp4`/`$isp6` set by
traceroute; `$aftr` by the router module (`_ga.aftrAddress`); `$router6` by the adapter module =
IPv6 default-route next hop of the primary adapter **with zone id** (e.g. `fe80::de73:6ff:fe12:34df%4`).

Manual actions: `session.*` → session manager; `speedtest.run`, `traceroute.run` ({family}),
`mtr.run`, `mtu.run`, `stun.run`, `udpburst.run` → `runNow`; `router.poll`/`router.login` →
router.runNow({action}); `router.setPassword` → secrets + router.reconfigure; `eventlog.import`
→ eventlog.runNow({days}); `config.reload` → context reload. Manual tasks work without a session.

### 4.4 Control API (engine/server.ts, node:http, 127.0.0.1 only)

- `GET /health` → `{ ok: true, version, pid }`; `GET /status` → `EngineStatus`
- `POST /control` (JSON `ControlRequest`, ≤ 64 KB) → `ControlResponse`. Long tasks (speed test,
  traceroute, MTR) answer immediately `{ ok: true, result: { started: true } }` and report via the stream.
- `GET /live` → SSE: `retry: 3000\n\n`, then each message `data: <JSON LiveMessage>\n\n`. `hello` on
  connect; samples batched every 500 ms; metrics every 2 s; `client` 1 Hz; `status` every 5 s;
  events/speedtest/traceroute/router/session immediately; heartbeat `: hb\n\n` every 15 s.

### 4.5 Probes (E-probes) – see docs/research/windows-collectors.md §2–3, §8, critique.md §2

- **ICMP pinger agent** (primary): ONE `powershell.exe -NoLogo -NoProfile -NonInteractive
  -ExecutionPolicy Bypass -EncodedCommand <base64 UTF-16LE>` running `engine/probes/pinger.ps1`
  (based on `docs/research/code/ps_pinger.ps1` + `critic-agent-test.ps1`). Config passed as a
  base64 JSON argument: `{targets:[{id, ip}], intervalMs: 1000, timeoutMs: 2000, size: 32,
  nics: ['Ethernet','WLAN'], preventSleep: true}`.
  - Fixed grid on whole seconds (`t0 = ceil(now/1000)*1000`, tick k at `t0 + k·1000`), all targets
    sent in the same tick (≤ 5 ms stagger), `SendPingAsync`, requests may overlap (timeout 2000 –
    .NET timeouts fire early).
  - Output, one JSON object per line on stdout (UTF-8):
    `{"k":"icmp","id":"cf4","ts":<scheduled tick ms>,"st":"Success|TimedOut|DestinationHostUnreachable|DestinationNetworkUnreachable|TtlExpired|PacketTooBig|Error","rtt":<int|null>,"from":"<ip|null>"}`,
    per tick for each configured NIC `{"k":"nic","ts":..,"name":"Ethernet","up":true,"mbps":1000,"rx":<bytes>,"tx":<bytes>,"inErr":..,"inDisc":..,"wifi":false}`
    (via `[System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()` +
    `GetIPStatistics()`), and `{"k":"hb","ts":..}` once per tick.
  - `preventSleep`: P/Invoke `SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)` once at
    start (state ends automatically when the agent exits → only active during sessions).
  - Mapping: Success → OK (`rtt` 0 → 0.5 ms); TimedOut → TIMEOUT; *Unreachable → UNREACHABLE
    (also when `from` is our own address = ARP failure); TtlExpired → TTL_EXPIRED; others → ERROR.
    rtt > 1000 → flag LATE. Sample `ts` = scheduled tick.
  - Emit `bus 'nic'` for nic lines. Heartbeat watchdog: no `hb` for 5 s → kill + restart (backoff
    1, 2, 5, 10, 30 s). Target/host changes → restart the agent with the new config.
  - Fallback after 3 failed agent starts: `ping.exe -t -w 2000 -4|-6 <ip>` per target, parsed by
    `parsePingLine()` (`src/lib/shared/parsers/ping.ts`, de+en, never require TTL – IPv6 has none;
    "Zielhost nicht erreichbar" = loss although Windows counts it as received).
- **Egress check** (Node, 1 Hz in session, sends no packet): `dgram.createSocket('udp4')` →
  `connect(53, '1.1.1.1')` → `address().address`; same with udp6 to `2606:4700:4700::1111`.
  Map address → interface alias via the latest adapters snapshot (`AdapterInfo.addresses`).
  Emit `bus 'egress'`. Note: Windows fails over to WLAN within 1 s of an Ethernet drop and back
  30–60 s later – that is exactly what this detects.
- **Sample flags**: LOAD while `ctx.speedtestActive()`, FAILOVER while `ctx.clientState()?.onExpected === false`, LATE.
- **TCP**: `net.connect` to the resolved IP (`dns.lookup` per family, cached 5 min), rtt until
  `connect`, ECONNREFUSED = OK (host answered), EHOSTUNREACH/ENETUNREACH = UNREACHABLE, timeout = TIMEOUT.
- **UDP-DNS**: one socket per target; `query === 'id.server'` → class CH, type TXT (answered by the
  Cloudflare PoP itself – pure path RTT; the TXT answer is the PoP name, keep it in
  `ProbeState.error`-free status/details); otherwise class IN, type A. Match by 16-bit id + QR bit,
  drop the first sample after (re)start.
- **HTTP**: `fetch` + `AbortSignal.timeout`, rtt until headers.
- **UDP burst** (`udpburst`): per enabled `udp-dns` internet target, `packetsPerSecond × durationSec`
  queries at drift-corrected spacing → metrics `udp.burst.<id>.{loss_pct,avg_ms,p99_ms,jitter_ms}`;
  skipped during speed tests.

### 4.6 Analysis (E-analysis) – methodology.md §4–6, critique.md §5

- **Baselines** (engine/analysis/baseline.ts): per target `BaselineWindow(600, 60)` (stats.ts) of OK
  RTTs; warm on start from the last hour of rollups (push each minute's p50). Spike =
  `isSpike(rtt, baseline, spikeRuleFor(cfg, segment))`; severity via `spikeSeverity`.
- **Incidents**: *latency_spike* episodes per target (merge if gap ≤ 2 s; persist if ≥ 2 spike
  samples or severity ≥ major; "level shift" note if > 50 % of the last 60 s are spikes);
  *loss_burst* (≥ `burstMinLosses` in `burstWindowSec`); *outage* = ≥ 2 internet ICMP targets
  lost in ≥ `outageMinSec` consecutive rounds, classified by which layers fail in the same rounds:
  `client` (expected link down / failover), `lan` (gw lost), `docsis` (isp6 lost too), `aftr`
  (only IPv4 targets lost, IPv6 fine), `isp`, `internet`. Duration = next success − last success −
  interval. `endTs` + `details.durationMs` on recovery; emit `bus 'incident'`. No spike/burst events
  while `speedtestActive()`; reset state after `engine_gap`.
- **Per-second classifier** (classifier.ts): for each tick ts (evaluate 3 s late), reference groups:
  gw (+gw6), isp6, v4 = {cf4, g4}, v6 = {cf6, g6}, game = latest TCP sample ≤ 10 s old of `game`
  targets. A group is *errored* if any member lost or spiked. First match wins:
  `excluded` (no pinger heartbeat / gap) → `link` (expected link down, `onExpected === false`, or
  ≤ 60 s after the expected link came back) → `lan` (gw lost/spike) → `good` (no group errored) →
  `access` (isp6 bad, v4 and v6 errored) → `aftr` (v4 errored, v6 clean) → `backbone` (isp6 fine,
  v4 and v6 errored) → `remote` (only game bad) → `unknown`. `es` = v4 or v6 errored; `ses` = ≥ half
  of the internet probes lost or any RTT ≥ 200 ms; `selfLoad` = own rx or tx ≥ `selfLoadPct` % of
  min(link Mbps, tariff). Write `SecondsRollup` per minute via `db.upsertSecondsRollups`.
- **Rollup**: bucket per (target, minute), finalize minutes older than now − 65 s, `summarize()` +
  spike count → `upsertRollups`; backfill `minutesMissingRollup(now − 24 h, now − 2 min, 20000)` on
  start; hourly `db.purge(retention)`.

### 4.7 Path (E-path) – methodology.md §7, windows-collectors.md §9, environment.md §A.6

- **Path discovery** (`traceroute`): TTL probes with .NET `Ping.Send(host, 1000, buf, new
  PingOptions(ttl, false))` timed with a Stopwatch (RoundtripTime is 0 for TtlExpired; hop address
  = `Reply.Address`) in a **separate short-lived PowerShell process** (never block the shared RPC
  worker); hops 1–8 × 3 probes every `tracerouteEveryMin`, full 30 hops on manual/incident.
  Fallback `tracert -d -w 1000 -h 30 [-4|-6]` + `parseTracert()`. Targets 1.1.1.1 and
  2606:4700:4700::1111. `pathHash` = sha1 of responding hop IPs; `changed` → `route_change` event.
  Dynamic hosts: `isp6` = first responding hop ≥ 2 with a global IPv6 that is not the router (today
  `2a02:8101:3ff:ff89::3`); `isp4` = first responding hop ≥ 2 with a public IPv4 (hop 2 = AFTR never
  answers; today hop 3 `92.79.214.92`). Rediscover daily and after outages.
- **MTR** (`mtr`): 20 probes per responding hop (≤ 8 concurrent) → `TraceHop.mtr`; interpretation
  helpers in `src/lib/shared/path-analysis.ts`: `persistentLoss(i) = min(loss(i..end))`,
  `linkLoss`, `nodeLoss`, same for RTT medians (unit tests reproduce the pathping example).
- **MTU** (`mtu`): .NET Ping with `DontFragment` binary search via the RPC worker (IPv4 to 1.1.1.1:
  expected 1460 = DS-Lite; IPv6: 1500). Windows caches PMTU after the first "fragmentation needed" –
  treat PacketTooBig/local failure as "too big". Metrics `mtu.v4`/`mtu.v6`, `mtu_change` event.
- **STUN/NAT** (`stun`): binding requests from ONE udp4 socket to `stun.l.google.com:19302` and
  `stun.cloudflare.com:3478` (distinct IPs), same for udp6; XOR-MAPPED-ADDRESS; mapping
  independent/dependent/blocked; `cgnat` = router `dsLite` or public IPv4 ≠ router WAN IPv4. Also
  `o-o.myaddr.l.google.com` TXT via 8.8.8.8 (CGNAT exit IP). Snapshot `nat`; `ip_change` on change.

### 4.8 Speed test (E-speed) – methodology.md §8–9

Phases: idle `idleSec` → download `downloadSec` (`downloadStreams` × `GET
https://speed.cloudflare.com/__down?bytes=25000000`, `accept-encoding: identity`, re-issue until
the phase ends) → upload `uploadSec` (`uploadStreams` × `POST https://speed.cloudflare.com/__up`
with 10 MB bodies; measure via `node:https` + `socket.bytesWritten` or time-to-first-response-byte).
Loaded latency: UDP `id.server` probes to 1.1.1.1 every 200 ms + the pinger's 1 Hz samples of
gw/isp6/aftr (localize the queue: gw rises under download → LAN link/100 Mbit; isp6 rises under
upload → modem upstream buffer). Ignore the first 3 s of each load phase. Throughput = bytes in the
stable window / time. Grade = max(mean loaded − mean idle) on Waveform's scale (A+ < 5, A < 30,
B < 60, C < 200, D < 400, F ≥ 400 ms) in `grading.ts`. Read `colo ?? cf-meta-colo`; on HTTP 429
retry ≤ 3× honouring Retry-After. `ctx.setSpeedtestActive(true/false)`, progress on `bus 'speedtest'`
(≤ 4/s), `speedtest` event (ts, endTs, summary, `limitedByLink` when down ≥ 85 % of link Mbps).
Skip scheduled runs: quiet hours, gaming, own traffic > 5 Mbit/s in the last minute, ongoing
outage, link down, < 30 min since the last run.

### 4.9 Windows collectors (E-windows) – windows-collectors.md, environment.md §C, critique.md §4

- **PowerShell RPC worker** (`createPowerShellHost()`, protocol of `docs/research/code/ps_worker.ps1`
  + `ps_worker_client.mjs`): request line `{"id":N,"cmd":"...","depth":5}` on stdin, response line
  `@@RPC@@{"id":N,"ok":true,"data":...}` / `{"ok":false,"error","errorId"}`; raw UTF-8 streams; helpers
  loaded once as `function global:`; `$ProgressPreference='SilentlyContinue'`; dates as epoch ms;
  per-command timeout, kill + respawn. `createPowerShellHost()` may be called again for extra workers.
- **adapter**: Get-NetAdapter (use `ReceiveLinkSpeed`/`TransmitLinkSpeed` bps, string-cast enums),
  Get-NetAdapterStatistics, `MSFT_NetAdapter.MediaConnectState` (WLAN truth), Get-NetIPAddress
  (→ `addresses`), ServiceName via Win32_NetworkAdapter, advanced properties (`-AllProperties`,
  `RegistryKeyword`/`RegistryValue`) every 10 min, `Find-NetRoute` for 1.1.1.1 / 2606:4700:4700::1111
  every `routePollSec` (split by CimClass; join interface state). Metrics `nic.*` (from deltas),
  events `adapter_change` / `route_switch`, snapshot `adapters` (5 min + on change), `bus 'adapters'`, `$router6`.
- **eventlog**: `wevtutil qe <log> /f:xml /q:"<XPath with EventRecordID > N>"` (language
  independent, ~26 ms), one cursor per log in settings. Sources: Intel providers `e2fexpress`,
  `e2fnexpress` (after a driver update!), `e2f68` (IDs 27 down; 28/29 low power; 30 no autoneg;
  32 up 1G; 33 up 100M FD; 34 100M HD; 35/36 10M; 40 SmartSpeed; 41/42 driver stop/start; 50–52
  overheat; 57 up 2.5G; 62 5G); boot/resume markers EventLog 6005/6006/6008/6013,
  Kernel-Boot 27 (BootType), Kernel-General 12, Power-Troubleshooter 1, Kernel-Power 41/42/107
  (+506/507); WLAN-AutoConfig/Operational 8001/8002/8003 (ReasonCode); Tcpip 4199 (address conflict
  → identity_change critical). Classify each link-down: within 30 s of a boot/resume marker →
  `cause: 'boot'` (info, only record relink speed); −120…+60 s around Kernel-Power 42 → `'pre_sleep'`;
  internet back > 120 s with WLAN 8002 ReasonCode 229396 within 240 s or ≥ 2 more downs in 180 s →
  `'router_reboot'`; else `'runtime'` (warn). Details: `relinkMbps`, `downtimeMs` (set `endTs` at the
  matching link-up), `wlanFailover` (WLAN 8001 within 5 s). Import full history on first start.
- **wlan**: `netsh wlan show interfaces` (UTF-8; exact German labels incl. "AP BSSID", "Bereich",
  "Verschlüsselungsverfahren", "RSSI" – see `lib_netsh_wlan.mjs`) → `parseNetshWlan()` (de+en alias
  table, tolerant); connected = MediaConnectState. Metrics `wlan.*`, events connect/disconnect/roam.
- **vpn**: `C:\Program Files\Cloudflare\Cloudflare WARP\warp-cli.exe -j status` and `-j settings list`
  (`operation_mode`, `split_tunnel_mode`) + tunnel adapters → `VpnInfo`, `vpn_change`. Never control WARP.
- **system**: CPU/mem; TCP retransmissions from `Win32_PerfRawData_Tcpip_TCPv4/TCPv6`
  (Δ SegmentsRetransmittedPersec / Δ SegmentsSentPersec) every 60 s → `tcp.retrans_pct`, `tcp6.retrans_pct`.
- **identity**: gateway MAC (Get-NetNeighbor), DHCP server, DNS servers, IPv6 prefix → `identity_change`;
  game detection via `tasklist /FO CSV /NH` against `config.gaming.processNames` → `bus 'gaming'`,
  metric `pc.gaming`, `gaming` episode events.
- **secret store**: DPAPI via the RPC worker (`ConvertTo-SecureString -AsPlainText -Force |
  ConvertFrom-SecureString` and back); password passed base64 inside the command; never log
  commands containing secrets; stored as `settings['router.password'] = 'dpapi:<hex>'`.

### 4.10 Router (E-router) – router-api.md, docsis-thresholds.md

- **Only ever talk to a private IP literal** (RFC1918/link-local). Refuse hostnames: `easy.box` /
  `kabel.box` resolve to public Internet hosts (verified) – credentials must never be sent there.
- Unauthenticated poll `GET /` every `pollStatusSec` (300 s idle): `_ga.*` vars (model, firmware,
  `modemConnectionStatus`, `wanIpv4/6`, `aftrAddress`, `dsLitePlusIpv6Mode`, `gwMode`,
  `lastRebootReason`, `lockoutTimeLeft`, `isDFSEnabled`, `isBandSteeringEnabled`) + HTTP time →
  `RouterStatus`, metrics `router.reachable/http_ms`, `$aftr`.
- Authenticated (only if `loginEnabled` and a password is stored): verified login (PBKDF2 +
  AES-CCM, test vectors in `docs/research/code/testvectors.json`), `credential` cookie from
  `/base_95x.js` (harmless if absent), `POST php/ajaxSet_Session.php`; DOCSIS
  (`status_docsis_data.php`) + uptime (`status_status_data.php`) every `pollDocsisSec`, attached
  devices (`overview_data.php`, mark `isThisPc` by MAC) with the DOCSIS poll, event log
  (`status_event_log_data.php?{"eventLogRecord":{}}`) every `pollLogSec`; **log out after each poll**
  when `logoutAfterPoll` (single admin session). 400 / `SESSION_LOST` body = expired → re-login once.
- Safety: never retry a failed login automatically; `Lockout` → wait `p_waitTime` + 30 s; wrong
  password → stop until the password changes; backoff 5 s → 30 s → 60 s → 5 min for transport errors.
- DOCSIS rating (`docsis.ts`): Vodafone breakpoints from docsis-thresholds.md §3 (4 grades
  konform/toleriert/Monatsfrist/sofort → Health good/good/warn/bad), OFDM MER rated against the CNR
  required by the profile modulation (4096QAM 41 dB, 2048 37, 1024 34, 512 30.5, 256 27; +3 dB =
  good), SNR outlier (≥ 3 dB below same-modulation median), tilt, partial service vs 7-day max,
  upstream headroom. The Vodafone Station has **no codeword counters** → `null` ("nicht verfügbar").
  Identify channels by (dir, type, rounded frequency), not channel id.
- Router log categorizer (docsis-thresholds.md §6, CM-STATUS codes): `router_log` events (dedupe
  `router:<Timestamp>-<Index>`), MACs redacted in exports. Events `docsis_change` (debounced 2 polls),
  `router_reboot` (uptime decreased), `router_offline` (2 failed polls), `ip_change` (WAN IPv6/AFTR).

### 4.11 macOS (E-macos) – docs/research/macos.md

Same modules, data model and events; every module picks its raw-data source by `isMac()`:

- **PowerShell host**: not loaded on macOS (`ctx.ps.available = false`); no collector depends on it there.
- **Interfaces**: `MacInterfaceCatalog` joins `networksetup -listallhardwareports` (cached 10 min),
  `ifconfig -a`, `netstat -ibn`. `AdapterInfo.name` = hardware port name ("Ethernet", "Wi-Fi"), the BSD
  name is the extra field `device` (AdapterInfoExt). Routes via `route -n get [-inet6]`; `$router6` keeps
  the zone id macOS prints (`fe80::…%en7`). No driver version / advanced properties.
- **Pinger**: `MacPinger` (PingerLike) – fixed 1 Hz grid in Node, one `ping -n -c 1 -s 32 -W <ms>` /
  `ping6 -n -c 1 -s 32` per target and tick (killed after timeout + 500 ms), NIC ticks from the catalog,
  preventSleep = `caffeinate -i -w <engine pid>`. PingerStatus.mode is 'agent' while it runs.
- **Path/MTR**: `runTtlProbes`/`runTracert` dispatch to `engine/tasks/mac-path.ts`: one
  `traceroute(6) -n -I -q 1 -w 1 -f T -m T` per (TTL, round) → the same `HopProbe`s; fallback = one
  sequential UDP-mode traceroute. **MTU**: `ping -D` / `ping6 -D -m`, PMTU from `route -n get`.
- **identity**: `route get` + `arp -n` (short MAC octets → `padMac`), `ipconfig getpacket`,
  `scutil --dns`, autoconf IPv6 from ifconfig; games via `ps -A -o comm=` compared with
  `normalizeProcessName` (no .exe on macOS). **system**: `netstat -s -p tcp` → only `tcp.retrans_pct`.
- **wlan**: `system_profiler SPAirPortDataType -json` (≥ 30 s interval; SSID may be redacted, no BSSID).
  **vpn**: `warp-cli` from `/usr/local/bin` or the app bundle; other tunnels = routable utun/ipsec/ppp.
- **secret store**: Keychain generic password (service `netzpuls.router`) through `security -i` with the
  command on stdin; setting value `keychain:v1`.
- **eventlog** (`MacSystemLogModule`): synthetic `WinEvent`s with providers `macos-link` (link down/up
  observed from NIC ticks/adapter snapshots, history from the unified log) and `macos-power` (pmset
  sleep/wake/boot) feed the unchanged `analyzeLinkDrops` classification and NetEvent mapping.
- **UI/diagnosis**: Next runs on the same machine – the root layout passes `hostOsFrom(process.platform)`
  to `PlatformProvider` (`usePlatform()`, `useOsWording()` in `src/lib/client/platform.tsx`);
  `DiagnosisInput.os` selects the wording of the rules (macOS: no Intel/Gerätemanager advice).

## 5. Next.js API (N-api) – stack.md §4–5

- Every route handler starts with `await connection()` (`import { connection } from 'next/server'`).
  **No** `export const dynamic` / `export const runtime` (build errors if cacheComponents is ever on).
- Use `getDb()`/`all`/`get`/`run` from `src/lib/server/db.ts`; rows are null-prototype objects
  (spread before handing to React), `lastInsertRowid`/`changes` may be bigint (`Number()`).
  `stmt.setReturnArrays(true)` is available for columnar chart queries.
- Never import `server-only` in modules the engine might import.
- Routes: `/api/status`, `/api/live` (SSE proxy of engine `/live` via `fetch(…, {signal:
  request.signal})`; cleanup on `request.signal` abort; when the engine is down respond **200** with
  `retry: 3000\n\n` + `data: {"type":"offline",…}\n\n` and end – never 503), `/api/control` (POST),
  `/api/config` (GET/PUT; `routerPassword` in the PUT body → engine `router.setPassword`, never
  stored by Next; reject non-private router addresses), `/api/series`, `/api/samples`, `/api/stats`,
  `/api/seconds`, `/api/heatmap`, `/api/events` (GET + POST note), `/api/metrics`,
  `/api/speedtests`, `/api/speedtests/[id]`, `/api/traceroutes`, `/api/path`, `/api/router`
  (`?at=` = router/DOCSIS status as of that time, for reports of past tests),
  `/api/client`, `/api/sessions`, `/api/sessions/overview` (all tests with key figures),
  `DELETE /api/sessions/[id]?scope=entry|data`, `/api/diagnosis`, `/api/export`.
- Deleting a test (`src/lib/server/sessions.ts`) is the one bulk write from Next: never a running test;
  `data` removes samples, rollups, seconds, metrics, speed tests, traceroutes and events of the test
  window (not Windows event log / router log entries, not the newest snapshot per kind) in short
  transactions (≈ 40 ms budget, 25 ms pauses) so the engine's 1-s write batches never wait long.
  Response/overview types live in `src/lib/shared/sessions.ts` (api-types.ts stays unchanged).
- Stats exclude samples with the LOAD flag / minutes overlapping `speedtest` events by default.
- `POST /api/events` `{ title, ts?, details? }` → user `note` event ("Lag jetzt markieren").

## 6. Diagnosis (N-diagnosis) – critique.md §5, methodology.md §3/§11, docsis-thresholds.md §7

`runDiagnosis(from, to): DiagnosisReport` (`src/lib/server/diagnosis/index.ts`). Primary evidence
is `seconds_1m` (share of bad seconds per class → segment); rules are pure functions
`(input: DiagnosisInput) => Finding | null` with unit tests. Rule set and German texts: MESSPLAN §5.
Top cause = class with the largest share of bad seconds (confidence high at ≥ 3 days, ≥ 100 bad
seconds, ≥ 50 % share). Gaming score per methodology §11 (`src/lib/shared/scoring.ts`).

## 7. UI (U-foundation / U-pages)

Product name **Netzpuls** („Leitungsdiagnose“). German UI ("du"), dark "network operations" design
system from `docs/research/design.md` (source tree verified with next build/tsc/eslint; tokens
`docs/research/theme.css`, chart theme `docs/research/echarts-theme.ts.txt`). Pages: `/` Live,
`/verlauf` (incl. A/B session comparison), `/diagnose`, `/speedtest`, `/route`, `/router`,
`/pc-adapter`, `/langzeittests` (all tests by name: open as report/diagnosis/history, delete),
`/ereignisse`, `/bericht`, `/messplan`, `/einstellungen`. Bericht, Diagnose and Verlauf show a
`<SessionPicker>` next to the time range when „Langzeittest“ is selected (`?range=session&session=<id>`).
Dashboard KPIs: main cause (provisional) + confidence; bad seconds 1 h / 24 h by segment; segment
ladder p50/p95 (Router | CMTS | AFTR | Internet v4 | Internet v6 | Spiel); loss 24 h; Ethernet link
speed, runtime link drops 24 h / 7 d, WLAN failovers; UDP jitter/loss; DOCSIS traffic light;
bufferbloat grade; **measurement coverage** (the PC sleeps in the evening). Hooks in
`src/lib/client/`: `useLive()` (one shared EventSource, 15-min ring buffer per target, client
state, events, speed test progress), `useApi<T>(url, {refreshMs})`, `useTimeRange()`.
React lint rules that fail the build: no `ref.current = …` during render, no `Date.now()` /
`performance.now()` / `Math.random()` during render, no synchronous `setState` in an effect body.
ECharts: own wrapper on `echarts/core` (tree-shaken), hex colors only (zrender can't parse oklch),
read font families via `getComputedStyle` (canvas can't resolve CSS vars), `registerLocale('DE', …)`
with a default import.

## 8. Verification

`npm run typecheck`, `npm test`, `npm run lint`, `npm run build` must pass. Parsers, crypto,
stats, grading, DOCSIS rating, path analysis, classifier and diagnosis rules have unit tests with
real fixtures.
