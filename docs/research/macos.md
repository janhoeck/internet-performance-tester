# macOS port: plan, tool formats, decisions

Goal: the engine measures on macOS (13 Ventura or newer, Intel and Apple Silicon) with the same
data model, analysis and UI as on Windows. Every Windows-only code path gets a macOS counterpart;
everything that is already platform neutral (Node TCP/UDP/HTTP probes, egress check, STUN, speed
test, router module, analysis, SQLite, Next UI) stays untouched.

**Status of the facts below:** written without access to a Mac. The tool output formats come from
the macOS man pages and the open-source `network_cmds` / `pmset` sources as far as known; the
fixtures in `fixtures/macos/` are **synthetic** (documentation addresses, reconstructed formats).
Everything marked **[unverified]** must be checked on a real Mac (see §9). All parsers are tolerant
and every collector degrades to "nicht verfügbar" instead of failing the engine.

Legend: **[man]** = documented in the man page, **[src]** = from the open-source tool code,
**[unverified]** = plausible but not checked on a real system.

---

## 0. Decisions in brief

| Windows | macOS replacement | Why |
|---|---|---|
| ONE `powershell.exe` ICMP agent (.NET `SendPingAsync`, 1 Hz grid) | Node schedules the 1 Hz grid; **one `/sbin/ping -c 1` (IPv4) or `/sbin/ping6 -c 1` (IPv6) per target and tick**, killed after the timeout | Node cannot send ICMP. `ping` is setuid root and timestamps in the kernel, so the RTT is exact although the process start costs a few ms. A long-running `ping -i 1` drifts (`last = now` after each send) and its "Request timeout" lines are only printed on a new high-water mark [src] – unusable for a fixed grid. ~9 spawns/s with the default targets, ≈1–3 % of one core. |
| NIC link ticks from the agent (`GetIPStatistics`) | `ifconfig -a` (status, media) + `netstat -ibn` (64-bit counters) once per tick | No admin, no localisation. |
| `SetThreadExecutionState` (preventSleep) | `/usr/bin/caffeinate -i -w <engine pid>` while the probes run | Prevents idle sleep only; ends automatically when the engine dies. |
| PowerShell RPC worker | not used on macOS (`ctx.ps.available = false`); every collector has a macOS source spawning short-lived tools | |
| `Get-NetAdapter`, `Get-NetAdapterStatistics`, `Get-NetIPAddress`, `Find-NetRoute` | `networksetup -listallhardwareports` (friendly names), `ifconfig -a`, `netstat -ibn`, `route -n get [-inet6] <dst>` | |
| Interface alias ("Ethernet", "WLAN") | **Hardware port name** from `networksetup` ("Ethernet", "Wi-Fi", "USB 10/100/1000 LAN"); BSD name (`en0`) is kept as `device` | Users know the port names from the system settings; every macOS tool speaks BSD names, so the platform layer maps them in one place (`engine/collectors/macos/interfaces.ts`). Non-port interfaces (utun, bridge) keep their BSD name. |
| `Get-NetNeighbor`, `Win32_NetworkAdapterConfiguration`, `Get-DnsClientServerAddress` | `route -n get <router>` (interface), `arp -n <router>` (MAC, octets without leading zeros!), `ipconfig getpacket <dev>` (DHCP server), `scutil --dns` (resolvers), `ifconfig` (`autoconf` IPv6 addresses) | |
| `tasklist /FO CSV` | `ps -ww -A -o comm=` (full executable path → basename) | Game names compare without `.exe` / `.app`. |
| `Win32_PerfRawData_Tcpip_TCPv4/6` | `netstat -s -p tcp` ("packets sent", "data packets (… bytes) retransmitted") | macOS keeps one TCP statistic for both families → only `tcp.retrans_pct`. |
| `netsh wlan show interfaces` | `system_profiler SPAirPortDataType -json` | Only no-admin source for RSSI/noise/rate/channel (`airport` was removed in 14.4, `wdutil` needs sudo). SSID is `<redacted>` without Location Services → null; **no BSSID** → roaming only by channel change. Polled at most every 30 s (≈0.5–2 s per call). |
| `warp-cli.exe -j` | `/usr/local/bin/warp-cli -j` (or inside `/Applications/Cloudflare WARP.app`) | Same JSON. Other tunnels = `utun*`/`ipsec*`/`ppp*` with a routable address. |
| DPAPI via PowerShell | **Keychain** via `/usr/bin/security` (generic password, service `netzpuls.router`); the secret travels hex-encoded over **stdin** (`security -i`), never on a command line | `settings['router.password'] = 'keychain:v1'`. |
| Windows event log (`wevtutil`) | **Systemprotokoll** module: power markers from `pmset -g log` + `sysctl kern.boottime/sleeptime/waketime`; link down/up **observed by the engine** (1 Hz NIC ticks in a session, adapter polls otherwise); optional history import of `Link up/down on enX` kernel messages from the unified log (`log show --style ndjson`) | Same classification (`analyzeLinkDrops`) and the same `nic_link_down`/`nic_link_up`/`standby`/`resume` events. |
| TTL probes in `ttl-probe.ps1` | **`/usr/sbin/traceroute -n -I -q 1 -w 1 -f T -m T`** (`traceroute6` for IPv6), one process per (TTL, round), ≤ 8 in flight, rounds 1 s apart | Same `HopProbe` model; traceroute measures the RTT itself (exact), one probe per hop and second respects ICMP rate limits like the Windows runner. |
| `tracert` fallback | one sequential `traceroute -n -q 3 -w 1 -m N` (UDP probes) | Different probe type in case ICMP is filtered. |
| MTU via .NET `DontFragment` / `ping -f -l` | `ping -D -s <payload> -c 1` (IPv4), `ping6 -D -m -s <payload> -c 1` (IPv6, -D = no fragmentation) [man] | PMTU cache = `route -n get [-inet6] <dst>` (`mtu` column of the cloned host route). |
| `taskkill /T /F` | `SIGKILL` to the child (all macOS children are single processes; `caffeinate -w` and `ping -c 1` end by themselves if the engine dies) | |
| Edge/Chrome for the report PDF (skill) | `/Applications/Google Chrome.app/…`, `Microsoft Edge.app`, `Chromium.app`, `Brave Browser.app` | |

All macOS tools are spawned by absolute path (`/sbin`, `/usr/sbin`, `/usr/bin`) without a shell,
with `LC_ALL=C` (except `networksetup`, whose port names are shown to the user), with timeouts and
`ctx.trackChild`.

## 1. Code layout

```
engine/platform.ts                       hostPlatform(), isMac(), isWindows()  (Node only)
engine/collectors/macos/tools.ts         absolute tool paths, runTool() (ProcessRunner + LC_ALL=C)
engine/collectors/macos/interfaces.ts    interface catalog: networksetup + ifconfig + netstat → MacInterface[]
engine/collectors/macos/*.ts             sources for adapter / identity / system / wlan / vpn, keychain,
                                         system log module
engine/probes/mac-pinger.ts              PingerLike for macOS (grid scheduler, ping per tick, NIC ticks, caffeinate)
engine/tasks/mac-path.ts                 traceroute-based TTL runner + sequential fallback, DF ping probe, PMTU
src/lib/shared/parsers/macos/*.ts        pure parsers (ifconfig, netstat, route, networksetup, ping,
                                         traceroute, pmset, sysctl, system_profiler, scutil, arp,
                                         ipconfig, ps, unified log) – vitest with fixtures/macos/*
src/lib/shared/platform.ts               HostOs + German wording per OS (UI, diagnosis texts)
```

Module files and factories stay the same (`engine/modules.ts` is unchanged). Each factory or
module picks its data source by platform:

- `adapter`, `identity`, `system`, `wlan`, `vpn`: the existing module logic (diffs, events, metrics,
  snapshots) is kept; only the raw data source is injected (`NetSnapshotSource`, `IdentitySource`,
  `ProcessListSource`, `TcpCounterSource`, `WlanSource`, `WarpCli`).
- `eventlog`: `createEventLogModule()` returns `MacSystemLogModule` on macOS.
- `probes`: `DEFAULT_DEPS.createPinger` returns `MacPinger` on macOS.
- `traceroute`/`mtr`: `runTtlProbes()`/`runTracert()` dispatch to `engine/tasks/mac-path.ts`.
- `mtu`: the macOS DF probe and PMTU reader are used when the platform is macOS.
- `core/windows.ts`: on macOS the PowerShell host is not even tried (unavailable stub, info log),
  the secret store is the Keychain store.

## 2. ICMP pinger (engine/probes/mac-pinger.ts)

- Grid: `t0 = ceil(now/1000)*1000`, tick k at `t0 + k·1000` (setTimeout chain re-aligned to the wall
  clock every tick; a jump > 3 s = standby → new grid). Targets with `every = n` only on every n-th
  tick. All pings of a tick are spawned in the same event-loop turn.
- IPv4: `/sbin/ping -n -c 1 -s 32 -W <timeoutMs> <ip>`; IPv6: `/sbin/ping6 -n -c 1 -s 32 <ip>`
  (`-W` means something else in ping6 [man]). Each child is killed `timeoutMs + 500` after the
  spawn. Status from the output (`parseMacPing`), never from the exit code alone:
  - `40 bytes from 1.1.1.1: icmp_seq=0 ttl=57 time=12.345 ms` /
    `40 bytes from 2606:4700:4700::1111, icmp_seq=0 hlim=57 time=12.345 ms` → OK (rtt > timeout → TIMEOUT)
  - `… bytes from 192.168.0.1: Destination Host Unreachable` → UNREACHABLE
  - `… bytes from x: Time to live exceeded` → TTL_EXPIRED
  - `ping: sendto: No route to host` / `Host is down` / `Network is unreachable` → UNREACHABLE
    (ARP/ND failure)
  - nothing → TIMEOUT; anything else → ERROR
- NIC ticks per configured adapter (friendly name) from `ifconfig -a` + `netstat -ibn` once per tick
  (`up` = `status: active` and UP/RUNNING, `mbps` from the media line, Wi-Fi without speed).
- `hello`/`hb` equivalents: `PingerInfo.mode = 'agent'` while the scheduler runs. A ping that cannot
  even be spawned (ENOENT, EAGAIN) or rejects its arguments records **no sample** (the second is not
  measured – an ERROR sample would count as loss) and sets `lastError`; only the first failure of a
  streak is logged. `preventSleepActive` = caffeinate is running (restarted 30 s after an unexpected exit).
- NIC names: the configured names are the shown names of the adapters snapshot; when none of them
  exists (first start, Windows default names) every physical interface is reported.

## 3. Adapters, identity, system

`MacInterface` (interfaces.ts) joins:
- `networksetup -listallhardwareports` (cached 10 min): `Hardware Port: Wi-Fi` / `Device: en0` /
  `Ethernet Address: …` → friendly name, Wi-Fi flag.
- `ifconfig -a`: blocks `en0: flags=8863<UP,BROADCAST,SMART,RUNNING,SIMPLEX,MULTICAST> mtu 1500`,
  `ether …`, `inet 192.168.0.42 netmask 0xffffff00 …`, `inet6 fe80::…%en0 prefixlen 64 secured scopeid 0xb`,
  `inet6 2a02:… prefixlen 64 autoconf secured`, `media: autoselect (1000baseT <full-duplex>)`,
  `status: active|inactive`.
- `netstat -ibn`: `<Link#N>` rows → ifIndex N, Ipkts Ierrs Ibytes Opkts Oerrs Obytes Coll (64 bit);
  a trailing `*` on the name = interface down.

AdapterInfo mapping: `name` = port name (else BSD name), `description` = `"<BSD name> · <port>"`,
`status` = `Up` (UP+RUNNING+`status: active`) / `Disconnected` / `Disabled` (not UP),
`mediaConnected` from `status:`, `linkMbps` from the media subtype (`10baseT/UTP`, `100baseTX`,
`1000baseT`, `2500Base-T`, `5GBase-T`, `10GbaseT`), `isVirtual` = not a hardware port or a bridge,
`isWifi` = port name Wi-Fi/WLAN/AirPort, no driver version, no advanced properties.

Routes: `route -n get 1.1.1.1` / `route -n get -inet6 2606:4700:4700::1111` (`gateway:`, `interface:`,
`mtu` column); the source address comes from the Node egress check (UDP connect, no packet).

## 4. WLAN (system_profiler)

`system_profiler SPAirPortDataType -json` → `SPAirPortDataType[0].spairport_airport_interfaces[]`
with `_name` (BSD name), `spairport_status_information`, `spairport_current_network_information`
{ `_name` (SSID or `<redacted>`), `spairport_network_channel` ("36 (5GHz, 80MHz)"),
`spairport_network_phymode` ("802.11ax"), `spairport_network_rate` (Mbit/s),
`spairport_signal_noise` ("-54 dBm / -95 dBm") } [unverified: key names from public samples].
`signalPct` is derived from the RSSI with the same 0…100 % ↔ −100…−50 dBm mapping Windows uses.

## 5. System log (engine/collectors/macos/syslog.ts)

Synthetic `WinEvent` records feed the unchanged classification in `parsers/winevent.ts`:
- provider `macos-link`: id 27 = link down, id 32/33/34/35/36/57/62/31 = link up with the speed of
  the Intel table (same meaning, so `linkKindOf` just accepts the provider), data `p0` = adapter.
- provider `macos-power`: id 1 boot, 2 sleep, 3 wake, 4 dark wake, 5 shutdown → `markerOf` +
  `standby`/`resume` events with Mac wording.
- WLAN context: `wlan_connect`/`wlan_disconnect` events of the wlan module are mirrored as
  WLAN-AutoConfig 8001/8003 records (only for the classification, not stored twice).
Sources: `pmset -g log` lines `2026-10-12 22:10:01 +0200 Sleep  \tEntering Sleep state due to …`
(`Sleep`, `Wake`, `DarkWake`, `Start`) [unverified exact domain padding], cheap change detection
via `sysctl -n kern.boottime kern.sleeptime kern.waketime` (`{ sec = …, usec = … } …`).
Implementation details: record id = `ts_ms × 1000 + (id mod 100) × 10 + seq` (deterministic, so
re-reading pmset/unified log never duplicates; dedupe key `evtlog:<provider>:<recordId>`); dark
wakes (and the maintenance sleep that ends them) are markers for the classification only, no events;
without pmset the sysctl changes create the events (`details.observedBy = 'sysctl'`). Recent live
link/WLAN records survive an engine restart in setting `eventlog.macos.recent`.
Link events: live observation (NIC ticks / adapter snapshots, wired adapters only; NIC ticks win
while < 5 s old; a wired adapter vanishing from the snapshot – unplugged USB dongle – is a link
loss; changes while the engine is not running are not seen). History import:
`log show --style ndjson --last <days>d --predicate 'process == "kernel" AND eventMessage CONTAINS[c] "Link "'`
→ `Link down on en7` / `Link up on en7, 1-Gigabit, Full-duplex, …` [unverified: wording differs
between drivers; unrecognised lines are ignored], only before the first live observation.

## 6. Path, MTR, MTU

- TTL runner: one `traceroute` / `traceroute6` (`-n -I -q 1 -w 1 -f T -m T dst`, IPv6 without `-I`
  if it is rejected) per (TTL, round) → line ` 3  92.79.214.92  10.123 ms` (`*` = lost, `!H/!N/!P/!X…`
  = unreachable) → `HopProbe`. Rounds every `intervalMs`, ≤ `maxConc` in flight, `stopAtDest`,
  `trimSilent` as in ttl-probe.ps1.
- MTU: DF ping as above; `sendto: Message too long` / `Frag needed and DF set (MTU n)` /
  `Packet too big` → too-big; PMTU from `route -n get`.

## 7. UI / texts

`src/lib/shared/platform.ts` returns the OS-specific wording (Windows-Ereignisprotokoll ↔
macOS-Systemprotokoll, Task-Manager ↔ Aktivitätsanzeige, DPAPI ↔ Schlüsselbund, ping.exe ↔ ping,
"Windows weicht aufs WLAN aus" ↔ "macOS weicht aufs WLAN aus", .exe suffix only on Windows).
The Next server knows the OS (same machine as the engine): the root layout hands it to a client
context (`usePlatform()`), the diagnosis gets it in `DiagnosisInput.os`. Intel/Windows driver
advice is only shown on Windows.

## 8. Verification

Unit tests for every parser (synthetic fixtures) and for the scheduling/classification logic with
injected fake runners (they run on Windows CI as well). `npm run typecheck`, `npm test`,
`npm run lint`, `npm run build` must pass on Windows; the Windows code paths are unchanged.

## 9. To verify on a real Mac

1. `ifconfig -a`, `netstat -ibn`, `networksetup -listallhardwareports`, `route -n get -inet6 …` match §3
   (capture into `fixtures/macos/` and replace the synthetic files).
2. `ping -c 1 -W 2000 -s 32`, `ping6 -c 1 -s 32` reply/error lines; `ping -D -s 1473 1.1.1.1` and
   `ping6 -D -m -s 1453 …` wording.
3. `traceroute -n -I -q 1 -w 1 -f 3 -m 3 1.1.1.1` and `traceroute6 -n -I …` (option support).
4. `system_profiler SPAirPortDataType -json` key names; SSID redaction with/without Location Services.
5. `pmset -g log` line layout; kernel link messages of the actual Ethernet driver/USB adapter.
6. `security -i` with `add-generic-password … -X <hex>` (no Keychain prompt for the engine).
7. CPU load of the pinger (spawns per second) on battery.
