# Measurement-plan critique — Internet-Langzeitdiagnose (review 2026-10-09)

**Perspective:** ISP NOC, DOCSIS and Windows networking.

**Method:** Everything was read-only on the user's PC:
- System log plus the WLAN-AutoConfig and NetworkProfile operational logs, back to 2026-08-24.
- Adapter, route and counter state.
- About 500 small probe packets (ICMP, DNS, STUN) on 2026-10-09, roughly 14:00–14:40 local time.

No settings were changed, no admin rights were used, and **no requests went to the router web UI**.

**Helper scripts** (all can be re-run, in the same folder as this file):
- `events.ps1`, `resume.ps1`, `nettest.ps1`, `icmp.ps1`, `udp.mjs`, `v4v6.mjs`, `loadcorr.ps1`
- `agent-test.ps1` + `agent-run.mjs`: a verified prototype of the probe agent

---

## 0. Executive summary: what changes compared with the draft

| # | Finding | Source | Consequence |
|---|---|---|---|
| 1 | Only **16 of the 77** link-down events (e2fexpress 27) happened during normal operation. **59** are renegotiations: either within 15 s of a resume (Power-Troubleshooter 1 is logged 2–3 s *after* the link-down) or 10–15 s after a boot (Kernel-General 12). **2** are ambiguous: 09-30 15:48:44 came 156 s after a resume, and 09-08 19:40:21 came 64 s before sleep. | `resume.ps1` | A resume/boot classification of link events is **mandatory**. The draft says Kernel-Power is "not correlated". That holds only for sleep entry (KP 42). It is wrong for resume (PT 1 / KP 107) and boot. |
| 2 | Drops during operation **started on 2026-09-26**. There were none from 08-24 to 09-25. Since then: 09-26 ×3 (18:37–18:46), 09-27 ×1, 10-07 ×3 (11:24–11:26), 10-08 ×9 (15:14, plus 8 between 18:29 and 18:43). Each outage lasted 2.9–21.9 s (median ≈ 6.5 s). | `resume.ps1` | This matches the user's "seit einigen Tagen". The drops come in clusters and are getting worse. |
| 3 | **22 of the 59 (37 %)** clean renegotiations came up at **100 Mbit/s**. Between 09-02 and 09-13 that happened 13 times in a row. The link has been at 100 Mbit/s again since today's resume at 13:37. | `events.ps1` | A healthy cable and port practically always negotiate 1 Gbit/s. Gigabit needs all 4 wire pairs; 100 Mbit/s needs only 2. This points to the **physical layer**. Every resume is therefore a free daily cable test. |
| 4 | **The PC fails over to WLAN.** The WLAN profile auto-connects ("Verbindungsmodus: Automatische Verbindung mit einem Profil", 802.11ax). In 8 of the 16 in-operation drops, WLAN-AutoConfig 8001 (connected) came **0.2–0.7 s** after the Ethernet link-down. In most of the others, WLAN was still connected from the previous failover. WLAN soft-disconnects (8003) **35–46 s** after the drop. On 10-08 at 18:29, WLAN failed 4× (8002), so that drop was a real outage. | event alignment | A link drop usually does **not** show up as ping loss, because the gateway still answers over WLAN. Instead the egress IP switches 192.168.0.192 → .35 → .192, and game sessions break. Detection must use **link state and egress source address, both at 1 Hz**. Every sample must carry its egress interface. |
| 5 | **Latency spikes in the access network while the PC was idle.** The PC received 0.1–0.6 Mbit/s and sent ≤ 1.5 Mbit/s. The gateway stayed at 0–4 ms. The first provider hop on IPv6 (2a02:8101:3ff:ff89::3, presumably the CMTS/CCAP) had a per-second maximum RTT of **16–138 ms**. Cloudflare over v4 and v6 followed it, about 7 ms higher. UDP DNS over v4: p50 28 / p90 108 / max 215 ms. Over v6: p50 26 / p90 103 / max 212 ms. No loss. | `loadcorr.ps1`, `v4v6.mjs` | This is a **second, independent problem**. It sits in the DOCSIS access segment, or other devices in the household are loading the line. IPv4 and IPv6 are hit equally, so it is **not caused by DS-Lite** and not by this PC. It is the most likely cause of "Ping > 200 ms". This is anecdotal evidence (two short windows); the app has to confirm it. |
| 6 | Several causes were refuted or deprioritized. **Duplicate IP:** no Tcpip 4199 in 60 days. **NAT type:** the CGNAT mapping is endpoint-independent (the same public port towards stun.cloudflare.com and stun.l.google.com). **MTU:** a 1461-byte DF packet passes through DS-Lite; 1500 bytes returns PacketTooBig. That does not matter for small game packets. **Updates as trigger:** no network driver changed in 35 days (I225 driver 1.1.4.43 is unchanged). **Modern Standby:** the system supports only S3. | several scripts | Keep these only as cheap watchdogs. |
| 7 | NetworkProfile 4003 ("Nicht identifiziertes Netzwerk") on Ethernet: 9 times since 09-26. 4 of them had no link event. They lasted from 2 s to 3.6 h. 6 of the 9 came within 77 s after CloudflareWARP (re)connected. | query | Most likely an NLA classification artifact triggered by WARP reconnects. **Do not use it as evidence of an outage**; the probes decide. |
| 8 | The router is **192.168.0.1** (ARRIS TG6442, "Vodafone Station"). Nothing exists at 192.168.0.2: probes return TimedOut and DestinationHostUnreachable. | agent test | Use the auto-detected gateway as router IP and make it configurable. Ask the user whether an old EasyBox, a switch or a powerline adapter sits between PC and router. That device would be the link partner of the flapping network card. |

**Overall:** there are most likely **two problems at once**:

- **(A) Ethernet physical layer, plus WLAN failover on top.** This causes the disconnects and "Paketverlust".
- **(B) Latency spikes in the access network.** This causes "Ping > 200 ms". It is still open whether the cause is the Vodafone segment or other devices in the household.

The app has to separate (A) and (B) cleanly. Without a resume classification and egress tagging it will misattribute both.

---

## 1. Ranked hypotheses

Each hypothesis below lists how likely it is, the evidence so far, what to measure, and the decision rule.

### H1: The physical Ethernet link between PC and router is unstable
Possible culprits: cable, plug, wall socket or keystone, router LAN port, or an intermediate device. The NIC's PHY is less likely.

- **Likelihood:** very high.
- **Explains:** disconnects, perceived packet loss, 3–22 s outages, the 100 Mbit/s fallback.
- **Evidence so far:** summary items 1–3. Outages cluster within minutes, which fits a mechanical or intermittent contact. Ask the user whether anything changed in the setup around 25/26 September (cable re-plugged, furniture or PC moved, new device).
- **What to measure:**
  - In-operation link events, after the resume/boot classification.
  - Link state and speed at 1 Hz.
  - The speed after each resume or boot renegotiation.
  - NIC error and discard counters, as deltas around each event.
  - Topology answers from the setup questionnaire.
  - The experiment journal.
- **Decision rule:**
  - Raise "Kabelverbindung instabil" if any of these holds:
    - ≥ 3 in-operation drops in 7 days.
    - ≥ 3 drops within 30 min.
    - The 100M share is ≥ 20 % over ≥ 5 clean renegotiations.
  - **Localisation:** change one thing at a time. Count a change as **"behoben"** only if both of these hold:
    - The next ≥ 10 clean renegotiations all reach 1 Gbit/s. Under the old behaviour that would happen with p = 0.63¹⁰ ≈ 1 %.
    - No in-operation drop occurs during ≥ 9 days of normal use. Under the old rate of 4 drop-days in 14, p = (10/14)⁹ ≈ 5 %.
  - Order of tests: cable → other router port → bypass intermediate device or wall socket → second NIC (USB-Ethernet adapter) → H7.

### H2: Latency in the DOCSIS access segment, or load from other household devices
Possible causes on the ISP side: segment congestion, upstream request-grant delays, or a line or noise problem.

- **Likelihood:** high.
- **Explains:** "Ping > 200 ms" and jitter; loss if it gets severe.
- **Evidence so far:** summary item 5. The gateway was clean, the CMTS hop spiked, the end targets followed the CMTS hop, both IP families were affected, and the PC was idle.
- **What to measure:**
  - ICMP at 1 Hz to the CMTS hop (`cmts6`), the gateway (`gw4`) and the v4/v6 end targets.
  - UDP bursts.
  - Own throughput.
  - DOCSIS values and events from the router.
  - Time of day, weighted by coverage.
  - The "quiet household" experiment.
  - Loaded latency per direction.
  - The tariff.
- **Decision rules:**
  - **Access network:** over ≥ 6 h of awake coverage, ≥ 70 % of end-target spike seconds coincide (±1 s) with `cmts6` RTT > baseline + 50 ms. At the same time `gw4` p99 < 10 ms and own utilisation < 20 %.
  - **Household or ISP:** run the quiet-household experiment. All other devices go offline for ≥ 15 min; repeat at least twice, once in the evening. Then look at the share of seconds with `cmts6` RTT > 100 ms:
    - reduced by ≥ 80 % → household load;
    - reduced by ≤ 30 % → ISP;
    - anything in between → inconclusive, repeat.
  - **Line fault or congestion** (needs DOCSIS data):
    - Uncorrectable deltas, T3 or T4 timeouts, or partial-service events within ±2 min of ≥ 50 % of SES bursts → line fault.
    - DOCSIS values clean and the evening/day ratio ≥ 2 → congestion.

### H3: WLAN failover amplifies every Ethernet drop
- **Status:** the mechanism is confirmed; it is secondary to H1.
- **Explains:** session breaks even when ping shows almost nothing; extra latency while traffic runs over WLAN.
- **Evidence so far:**
  - Summary item 4.
  - Both interfaces have an IPv4 default route with RouteMetric 0.
  - Both have InterfaceMetric 35. Ethernet reports 35 at 100 Mbit/s; WLAN also reports 35.
  - So while both are connected, the route choice is a tie. Which interface Windows prefers on a tie is uncertain.
- **What to measure:**
  - Egress address for v4 and v6 at 1 Hz (UDP connect trick).
  - WLAN events 8000–8003.
  - WLAN adapter status.
  - Interface metrics, recorded on change.
- **Decision rule:** raise the finding if either holds:
  - ≥ 50 % of in-operation drops show a WLAN connect within 5 s, or an egress switch.
  - Egress is WLAN for ≥ 10 s while Ethernet is up.

### H4: The 100 Mbit/s link becomes the LAN bottleneck
This is a consequence of H1. It matters only if the tariff is above 100 Mbit/s downstream, so ask for it.

- **Mechanism:** with its own downloads, the PC fills the router's LAN egress queue. Then the **gateway RTT rises too**. That distinguishes it from WAN bufferbloat, where the gateway stays flat.
- **Decision rules:**
  - "LAN-Engpass" if `gw4` p95 during seconds with own RX ≥ 80 % of link speed is ≥ 20 ms higher than p95 at < 10 %.
  - "Eigenlast" if ≥ 60 % of internet spikes coincide with own utilisation ≥ 80 %.

### H5: Problems on the DS-Lite / AFTR path (IPv4 only)
- **Status:** currently not supported.
- **Evidence so far:** v4 ≈ v6 in both snapshots. The first packet of a new UDP flow can take longer because the CGNAT has to create a mapping. That matters when a game connects, not in steady state.
- **Decision rule:** in ≥ 30 % of 15-minute windows over ≥ 24 h of coverage, with the gateway clean, **both** provider pairs (cf4/cf6 and gg4/gg6) show either:
  - v4 loss − v6 loss ≥ 1 percentage point, or
  - v4 p95 − v6 p95 ≥ 30 ms.
  Only then conclude AFTR. Also track CGNAT egress changes (STUN, o-o.myaddr).

### H6: The router itself (ARRIS TG6442)
Possible causes: LAN switch or port, CPU, crash or reboot, firmware.

- **Decision rules:**
  - **Router/LAN problem:** `gw4` loss ≥ 0.5 % per hour, or p99 ≥ 20 ms. This only counts while the link is up, egress is Ethernet and own utilisation is < 20 %.
  - If the LAN peer ping fails at the same moment, the problem is router-wide or in the switch.
  - **Reboot suspected:** the gateway is unreachable for ≥ 30 s while the link stays up, then recovers. Confirm via router uptime if that data is available.

### H7: Network card, driver or power features
Facts: Intel I225-V B3, driver 1.1.4.43 dated 2024-02-15. `*SelectiveSuspend`=1, `*SSIdleTimeout`=5, `IdleTimeoutMs`=5000, WakeOnLink=Forced. The driver does not expose an EEE keyword, not even a hidden one.

- **Status:** cannot be separated from H1 without swaps.
- **Observer effect:** the probes at 1 Hz keep the card busy. That would hide any effect caused by Selective Suspend.
- **Decision rule:** only if drops continue after the cable swap, port swap and bypass, try in this order, ≥ 9 days each:
  1. Current I225 driver package (MSI/Intel).
  2. Selective Suspend off.
  3. USB network card A/B test.

### H8: Remote path, peering or game server
- **Decision rule:** the game target has errored seconds while Cloudflare and Google (v4 and v6) and `cmts6` are clean → the problem is on the remote side.

### H9: Very unlikely; keep as watchdogs only
- **WARP:** game traffic is not tunneled. WARP only reconnects after link events, which causes NLA flaps.
- PC CPU or DPC latency.
- **DNS:** 5× DNS-Client 1014 in 60 days.
- MTU and NAT type: both verified fine.
- **Duplicate IP or rogue DHCP:** no 4199. Keep watching the gateway MAC and the DHCP server.
- Windows and driver updates.

---

## 2. Missing metrics and tests

### P0: required for a correct diagnosis

1. **Resume/boot classification of link events.**
   - Inputs: Power-Troubleshooter 1 (TimeCreated, Properties[1] = WakeTime), Kernel-Power 107, Kernel-General 12/13, Kernel-Power 42.
   - A link-down within ±15 s of a resume, or within 0–120 s after a boot, is a **renegotiation**. It is benign, but its speed outcome counts.
   - A link-down 120 s before to 60 s after a KP 42 is "pre_sleep" (ambiguous).
   - Everything else is **in operation**.
2. **Link state at 1 Hz via .NET** in the agent.
   - `NetworkInterface.GetAllNetworkInterfaces()` takes 15 ms; `GetIPStatistics()` takes 0.1 ms (both verified).
   - It provides OperationalStatus, Speed, bytes, errors and discards.
   - That gives own throughput per second, and link loss to the second. Event-log polling lags behind.
3. **Egress source address at 1 Hz for v4 and v6.**
   - Use the UDP `connect()` trick: no packet is sent, and `socket.address()` returns the source the OS chose.
   - Verified: 192.168.0.192 and an address from the LAN prefix.
   - This detects the WLAN failover and prefix changes. Tag every probe sample with its egress interface.
4. **Event-log ingestion with bookmarks.**
   - Use `wevtutil qe <Log> "/q:*[System[... and (EventRecordID > N)]]" /f:xml /e:Events`. A query takes about 26 ms (verified).
   - Logs and providers:
     - **System:** e2fexpress, Tcpip, NDIS, Kernel-Power, Kernel-General (12/13 only; KG logs many ID 16), Power-Troubleshooter, Dhcp-Client, DHCPv6-Client, Netwtw14.
     - **Microsoft-Windows-WLAN-AutoConfig/Operational:** 8000/8001/8002/8003 and 11000–11010.
     - **Microsoft-Windows-NetworkProfile/Operational:** 4001/4002/4003/10000/10001.
   - On the first run, **backfill from log start**. That yields 46 days of history immediately.
5. **CMTS hop as a continuous target.**
   - Find the second IPv6 hop with hop-limit probes. Today it is 2a02:8101:3ff:ff89::3; it answered 80 of 80 echo requests.
   - Re-discover it daily and after every outage.
   - IPv4 hop 2 is the AFTR and never answers, so it cannot serve as a target.
6. **Engine heartbeat and coverage table.**
   - Record per minute: engine alive, system awake.
   - The PC goes into S3 every evening around 19–21 h (reason "Application API"). So normalise every rate per awake hour, and show coverage on every heatmap.
   - SetThreadExecutionState **cannot** prevent sleep that is explicitly triggered via SetSuspendState (uncertain whether an opt-in "keep awake" would help).
7. **Change journal and guided experiments with automatic before/after statistics:**
   - E1: cable swap
   - E2: other router port
   - E3: bypass intermediate device or wall socket
   - E4: quiet household
   - E5: set the WLAN profile to manual connect
   - E6: WARP off for 1–2 h
   - E7: driver update / Selective Suspend off (only after E1–E3)
8. **Setup questionnaire.**
   - Topology: direct cable, switch, powerline, old EasyBox, wall socket.
   - Cable type and length.
   - Tariff, down and up.
   - Games and servers.
   - Other devices in the household.
   - Explain the router-IP correction: 192.168.0.1, not .2.
9. **Gaming detection.**
   - Every 60 s, compare `tasklist /FO CSV /NH` (locale-independent) with a configurable list of exe names. Offer a manual toggle as well.
   - Tag incidents with gaming=1, and pause heavy tests while gaming.
10. **ICMP via .NET `Ping`** in a persistent PowerShell 5.1 agent instead of parsing ping.exe output.
    - Verified: no admin needed; Status enum; IPv6 and link-local (`%4`) work; startup is about 300 ms.
    - For TtlExpired, `RoundtripTime` is **0**. Hop RTTs therefore have to be measured with a Stopwatch around a synchronous `Send`.

### P1: strongly recommended

- **Game-like UDP bursts.**
  - Every 5 min, send 20 pps for 10 s over v4 and over v6.
  - Use persistent sockets, and discard the first sample (AFTR mapping creation).
  - Query: DNS CH TXT `id.server` to 1.1.1.1 and 2606:4700:4700::1111. Both answer `dus01` (verified).
  - Metrics: loss, maximum loss burst, RTT p50/p95/p99, IPDV and RFC 3550 jitter, reordering (via DNS ID), and PoP change.
  - Use 50 pps only for short manual tests; how much rate the resolvers tolerate is uncertain.
- **MTR-lite.**
  - Run every 15 min and on every incident.
  - Probe hops 1–8 over v4 and v6, 3 probes per hop, 1 s timeout, with synchronous `Send` plus Stopwatch.
  - Store a route hash so route changes can be detected.
- **TCP retransmissions.**
  - Read `Get-CimInstance Win32_PerfRawData_Tcpip_TCPv4` and `TCPv6` every 60 s. Use SegmentsRetransmittedPersec against SegmentsSentPersec; despite the name, both are raw cumulative counters.
  - The first call takes 1.7 s; after that it is fast.
  - Since boot: v4 0.78 %, v6 0.18 %. IPv6 carries about 3.7× more segments.
  - Note that `Get-NetTCPConnection` has no retransmission counters.
- **DOCSIS data from the router.** Values and thresholds are in §5.5.
  - Build the data source as a plug-in.
  - Start with manual import: the user copies the status text from the router UI.
  - Any automated access only with the user's own password, read-only status pages, at most every 5 min, and stop after the first failed attempt or lockout.
  - The login implementation is **out of scope** for this review.
- **Network identity, every 60 s, stored on change:**
  - gateway MAC and IPv6 router (`Get-NetNeighbor`);
  - DHCP server and lease (`Get-CimInstance Win32_NetworkAdapterConfiguration -Filter "InterfaceIndex=4"` → DHCPServer, DHCPLeaseObtained, DHCPLeaseExpires);
  - default routes and metrics (`Get-NetRoute -DestinationPrefix 0.0.0.0/0,::/0`, `Get-NetIPInterface`);
  - IPv6 prefix and lifetimes (`Get-NetIPAddress -AddressFamily IPv6 -InterfaceIndex 4`);
  - DNS servers.
- **CGNAT tracking.**
  - STUN over v4 and v6 every 30 min and after incidents (stun.cloudflare.com:3478, stun.l.google.com:19302). This gives the public IP and port and the mapping behaviour.
  - `o-o.myaddr.l.google.com` TXT via 8.8.8.8 every 15 min. It returns the ECS /24 of the AFTR egress.
- **Throughput and loaded latency**, on the adaptive schedule in §4.
  - Grade bufferbloat separately for down and up.
  - Badge results as "durch 100-Mbit/s-Link begrenzt" when the link is at 100M.
- **LAN peer ping** to a wired device the user picks that is always on. This separates a PC link problem from a router-wide LAN problem.
- **WARP state:** `warp-cli status` every 60 s. Parse defensively; the output format is uncertain.
- **Router start page status** at ≥ 5 min intervals, optional: the modem connection status shown on the page, and WAN IPv6/AFTR changes.

### P2: nice to have

- **WLAN details**, only while WLAN is connected: `netsh wlan show interfaces`. The labels are German: "SSID", "BSSID", "Funktyp", "Kanal", "Empfangsrate (MBit/s)", "Übertragungsrate (MBit/s)", "Signal".
- **Path MTU** once a day with DF probes. Today: 1460 and 1461 bytes OK, 1500 bytes PacketTooBig.
- **Router DNS proxy RTT** (192.168.0.1:53) every 10 s, and **router HTTP response time** at most every 15 min.
- **Event-loop lag** (`perf_hooks.monitorEventLoopDelay`) as a data-quality flag.
- **Periodicity analysis:** autocorrelation of errored seconds per minute.
- **Daily configuration snapshot:** driver versions, Windows build, WARP version, `Get-NetAdapterAdvancedProperty -AllProperties` (works without admin). `Get-NetAdapterPowerManagement` **fails without admin** with "Windows System Error 31".
- **Delivery Optimization upload statistics** (uncertain without admin).
- **ISP report export** (print/PDF), plus a pointer to the Bundesnetzagentur Breitbandmessung for speed disputes. Latency is not covered by §57 TKG.

---

## 3. Low-value or misleading metrics

- **Raw counts of e2fexpress 27.** They report 77 events where only 16 are real drops.
- **Gateway loss as the only link-drop detector.** The WLAN failover masks the drop.
- **Loss and RTT of intermediate hops.**
  - IPv4 hop 2 (the AFTR) never answers.
  - Hop 3 (92.79.214.92) answered during scouting but timed out in my probe.
  - The IPv6 CMTS hop answered TTL-expired after 24.5 ms; the next hop after only 14.5 ms. That is control-plane deprioritization.
  - Use hops only for agreement with the end targets.
- **Parsing ping.exe output.** It is German text; "Zielhost nicht erreichbar" counts as received; IPv6 shows no TTL; umlauts break with the code page.
- The **192.168.0.2** target.
- **UPnP IGD counters:** not available.
- **Speed tests every 30–60 min.** They disturb gaming and create the bufferbloat they measure. While the link is at 100M they are capped at about 94 Mbit/s, so they measure the LAN link, not the line.
- **DNS resolution time through the system resolver.** It mostly measures the cache.
- **HTTP or TCP:80 response time of the router as a health metric.** The PHP UI is slow and noisy, and every request opens a session.
- **Kernel-Power 42 as a correlation target.** It is only useful for coverage. Resume and boot events, on the other hand, are essential.
- **CPU load averages.**
- **Mean RTT, and standard deviation as "jitter".** Outliers distort both. Use percentiles, ES/SES, IPDV and RFC 3550 jitter instead.
- **Heatmaps without coverage normalization.** The PC sleeps every night, so empty hours are missing data, not good hours.
- **tracert.exe every 10–15 min.** It is slow and its output is localized. Replace it with hop-limit probes.
- **NetworkProfile 4003 as outage evidence:** WARP artifacts (summary item 7).
- **Sub-millisecond LAN jitter from ICMP.** ICMP has 1 ms resolution, and the gateway shows 0 ms.
- **WLAN signal values** while WLAN is not in use.

---

## 4. Sampling, durations, retention and structure

| Tier | Interval | Content |
|---|---|---|
| T0 | 1 s | ICMP to `gw4` 192.168.0.1, `gw6` fe80::de73:6ff:fe12:34df%4, `cmts6` (auto), `cf4` 1.1.1.1, `cf6` 2606:4700:4700::1111, `gg4` 8.8.8.8, `gg6` 2001:4860:4860::8888, plus game targets and the optional `lanpeer`. Timeout 2000 ms; pings may overlap. Also: NIC sample (Ethernet + WLAN), egress v4/v6, heartbeat. |
| T1 | 10 s | UDP DNS `id.server` CH TXT over v4 and v6 (persistent sockets); router DNS proxy RTT. |
| T2 | 60 s | Event-log poll (bookmarks); CIM TCP/UDP counters; neighbors; routes and metrics; IPv6 addresses; DNS servers; DHCP lease; WARP status; gaming process list. |
| T3 | 5 min | UDP burst, 20 pps × 10 s, v4 + v6; router status (if available). |
| T4 | 15 min | MTR-lite over v4 + v6 (1.1.1.1 + game target); `o-o.myaddr` lookup. STUN every 30 min. |
| T5 | every 3 h, plus nightly, plus manual | Throughput and loaded latency, down and up measured separately. **Skip it** if gaming, if own traffic was > 5 Mbit/s in the last 60 s, during an incident, or while the link is down. Not between 18 and 23 h unless started manually (configurable). |
| Event | on incident | Snapshot (NIC, routes, neighbors, egress); immediate event poll; 20 s MTR if the link is up; router status (at most once per 5 min). |
| Daily | first wake-up after 04:00 | Configuration snapshot, CMTS re-discovery, DF probes, pruning, daily report. |

**Load on the line:**
- T0 ≈ 8 pps × 70 B ≈ 4.5 kbit/s.
- A T3 burst ≈ 26 kbit/s for 10 s, once per 5 min.
- Neither disturbs gaming.

**Gaming mode:**
- T0, T1 and T3 keep running. T3 can be switched off, but it costs almost nothing.
- T4 runs only on incidents.
- T5 never runs.
- Tag all data with gaming=1.

**Durations:**
- Baseline: ≥ 7 days, with ≥ 3 evenings covered from 19 to 23 h and ≥ 1 weekend day.
- Then run the experiments one after another, one change at a time:
  - E1 to E3: ≥ 10 clean renegotiations and ≥ 9 days each.
  - E4: 15–30 min, at least 3 times, including evenings.
  - E6: 1–2 h, matched against the same hours in the baseline.
- Findings are only provisional ("vorläufig") before 24 h of coverage.

**Retention** (SQLite WAL, the engine is the only writer):

| Data | Kept for | Notes |
|---|---|---|
| `probe_raw`, 1 s | 14 days | `WITHOUT ROWID`, about 18 MB/day for about 8 targets, so ≈ 250 MB total |
| `nic_raw`, 1 s | 14 days | |
| `agg_1m` | 400 days | |
| events, incidents, findings, journal, snapshots, speed tests | unlimited | |

Set `PRAGMA auto_vacuum=INCREMENTAL` **before** the first table is created. Prune at night in batches of about 50k rows.

---

## 5. Diagnosis rule set

### 5.1 Definitions
- **Baseline (`base`)** per target: the median over the last 24 h of the per-minute RTT minima. Count awake time only.
- **Spike:**
  - Internet targets: RTT > max(100 ms, base + 50 ms).
  - `cmts6`: RTT > base + 50 ms.
  - `gw4`: RTT > 20 ms.
- **ES (errored second)** of a family group (v4 = {cf4, gg4}, v6 = {cf6, gg6}): any probe in the group is lost or spikes.
- **SES (severely errored second):** ≥ 50 % of the group's probes are lost, or any RTT > 200 ms.
- **Unavailability (UAS):** starts with 10 consecutive SES and ends with 10 consecutive non-SES. The idea follows ITU-T G.826.
- **Incident:**
  - Starts with any of: ≥ 3 consecutive ES (either family), a link-down, or an egress switch.
  - Ends after 10 s with no ES, the link up and egress on Ethernet.
  - Its segment is the majority class of its seconds.
- **Gaming quality** (for the KPI colours):

  | Metric | Good | OK | Bad |
  |---|---|---|---|
  | p95 RTT | ≤ 50 ms | ≤ 100 ms | > 100 ms |
  | IPDV p95 | ≤ 10 ms | ≤ 30 ms | > 30 ms |
  | Loss | ≤ 0.1 % | ≤ 1 % | > 1 % |

### 5.2 Segment classification per second
The first matching class wins:

| Order | Class | Condition |
|---|---|---|
| 0 | `EXCLUDED` | No heartbeat, system asleep, or engine lag > 1 s. |
| 1 | `LINK` | Ethernet is down, **or** egress ≠ Ethernet, **or** recovery window: from link-up until the WLAN disconnect, at most 60 s, at least 10 s. |
| 2 | `LAN` | `gw4` lost or > 20 ms. |
| 3 | `ACCESS` | `gw4` OK **and** `cmts6` bad **and** both families have an ES. |
| 4 | `AFTR` | `gw4` OK, v4 has an ES, v6 is clean. |
| 5 | `BACKBONE` | `gw4` OK, `cmts6` OK, both families have an ES. |
| 6 | `REMOTE` | Only the game targets are bad. |
| 7 | `UNKNOWN` | For example, an ES on v6 only. |

**Additional tag `SELF_LOAD`:** within ±2 s, own RX or TX reaches ≥ 80 % of min(link speed, measured line capacity in that direction).

**German segment names in the UI:**

| Class | UI label |
|---|---|
| `LINK` | PC-Kabel/WLAN-Umschaltung |
| `LAN` | Heimnetz/Router |
| `ACCESS` | Kabelnetz (Zugang/CMTS) |
| `AFTR` | IPv4-Tunnel (DS-Lite) |
| `BACKBONE` | Vodafone-Backbone/Internet |
| `REMOTE` | Spielserver/Route |
| `UNKNOWN` | Unklar |
| `SELF_LOAD` tag | Eigene Auslastung |

### 5.3 Rules
Each rule lists its inputs, condition and severity, followed by the German UI title, text and action.

**R01 LINK_FLAP_OPERATION**
- Inputs: in-operation link-downs, their durations, clusters.
- Condition: ≥ 3 in 7 days, or ≥ 3 within 30 min.
- Severity: high. Critical at ≥ 5 per day, or ≥ 5 within 30 min.
- Title: „Kabelverbindung PC ↔ Router bricht im laufenden Betrieb ab"
- Text: „Die Netzwerkkarte hat in den letzten {d} Tagen {n}-mal die Verbindung zum Router verloren (je {min}–{max} s, zuletzt {ts}). Abbrüche nach Standby/Neustart sind herausgerechnet. Jeder Abbruch trennt laufende Spielverbindungen."
- Action: „1) Netzwerkkabel gegen ein neues Cat-6-Kabel tauschen, Stecker auf Einrasten prüfen, Knicke vermeiden. 2) Anderen LAN-Port am Router verwenden. 3) Zwischengeräte (Switch, Powerline, alte EasyBox, Wanddose) testweise überbrücken. 4) Jede Änderung im Tagebuch eintragen – die App vergleicht automatisch vorher/nachher."

**R02 LINK_NEGOTIATION_100M**
- Condition: 100M share ≥ 20 % over the last ≥ 5 clean renegotiations, or the link has been at 100M for > 10 min.
- Severity: medium. High if the tariff is above 100 Mbit/s.
- Title: „Verbindung läuft nur mit 100 Mbit/s statt 1 Gbit/s"
- Text: „{k} von {n} Verbindungsaufbauten endeten bei 100 Mbit/s. Gigabit benötigt alle vier Adernpaare des Kabels, 100 Mbit/s nur zwei – typisch für ein beschädigtes Kabel, einen schlechten Stecker oder Port."
- Action: same as R01, steps 1–3. Plus: „Bis zur Behebung große Downloads während des Spielens pausieren."

**R03 WLAN_FAILOVER**
- Condition: ≥ 50 % of in-operation drops show a WLAN connect within ≤ 5 s or an egress switch, or egress is WLAN for ≥ 10 s while Ethernet is up.
- Severity: medium.
- Title: „Windows wechselt bei Kabelabbrüchen auf WLAN und zurück"
- Text: „Bei {k} von {n} Abbrüchen hat Windows nach {x} s auf WLAN umgeschaltet und etwa {y} s später zurück. Jede Umschaltung ändert die IP-Adresse des PCs – Spielverbindungen brechen ab, auch wenn der Ping kaum Verluste zeigt."
- Action: „Kabelproblem beheben. Optional das WLAN-Profil auf diesem PC auf „Manuell verbinden" stellen (dann sind Kabelabbrüche allerdings komplette Ausfälle)."

**R04 SELF_CONGESTION**
- Condition: as in H4.
- Severity: medium to high.
- Title: „Latenzspitzen durch eigene Auslastung"
- Text: „{p} % der Latenzspitzen traten auf, während dieser PC die Verbindung zu ≥ 80 % auslastete ({mbps} Mbit/s). Die Warteschlange im Router/Modem läuft voll (Bufferbloat)." If `LAN`, add: „Die Spitzen treten schon zum Router auf – der 100-Mbit/s-Link ist der Engpass."
- Action: „Downloads/Updates (Steam, Launcher, Windows Update) beim Spielen pausieren oder auf ca. 70 % der Leitungsgeschwindigkeit begrenzen; Link wieder auf 1 Gbit/s bringen."

**R05 GATEWAY_UNSTABLE**
- Condition: as in H6.
- Severity: high.
- Title: „Schon die Verbindung zum Router ist instabil"
- Text: „Zum Router (192.168.0.1) gingen {loss} % der Pakete verloren bzw. es gab Spitzen bis {max} ms, obwohl das Kabel verbunden war und kaum eigener Verkehr lief."
- Action: „Anderen LAN-Port testen, Router neu starten. Fällt gleichzeitig auch der LAN-Peer aus, liegt es am Router → bei Vodafone Gerätetausch anfragen. Prüfen, ob andere Geräte das Heimnetz stark belasten."

**R06 ROUTER_OUTAGE**
- Condition: gateway unreachable for ≥ 30 s while the link is up and egress is Ethernet, or the router uptime resets.
- Severity: medium.
- Title: „Router war nicht erreichbar – Neustart oder Absturz vermutet"
- Text: „Am {ts} war der Router {dur} s nicht erreichbar, obwohl das Kabel verbunden war."
- Action: „Ereignisprotokoll des Routers prüfen; bei Wiederholung Router bei Vodafone tauschen lassen."

**R07 ACCESS_LATENCY**
- Condition: as in H2, with co-occurrence ≥ 70 %, plus ES share ≥ 1 % per awake hour.
- Severity: high.
- Title: „Latenzspitzen entstehen im Kabelnetz (Zugang zu Vodafone)"
- Text: „{p} % der Spitzen über 100 ms treten bereits am ersten Vodafone-Knoten (CMTS) auf, während die Verbindung zum Router sauber ist (p99 {gw} ms) und dieser PC kaum Daten überträgt. IPv4 und IPv6 sind gleichermaßen betroffen."
- Action: „Test „Ruhiges Heimnetz" durchführen (alle anderen Geräte 15 Minuten offline). Bleiben die Spitzen: Störung bei Vodafone melden und den Bericht dieser App beilegen. Verschwinden sie: verursachendes Gerät suchen (Uploads, Streaming, Updates)."

**R08 HOUSEHOLD_LOAD**
- Condition: E4 result shows a reduction of ≥ 80 %.
- Severity: medium.
- Title: „Andere Geräte im Heimnetz verursachen die Spitzen"
- Text: „Während des Tests „Ruhiges Heimnetz" sanken die Spitzen um {p} %."
- Action: „Gerät eingrenzen (Geräte nacheinander wieder einschalten); Cloud-Backups/Uploads zeitlich verlegen oder drosseln; Konsolen-/TV-Updates nachts."

**R09 DOCSIS_LINE**
- Condition: the thresholds in §5.5 are violated, or an error correlation is found (see 5.4).
- Severity: high or critical.
- Title: „Kabelanschluss: Signalwerte oder Fehler außerhalb der Norm"
- Text: „{details} (z. B. Downstream-SNR {x} dB < 33 dB; {n} nicht korrigierbare Fehler in 1 h; {t3} T3-Timeouts heute)."
- Action: „Koaxialkabel Router ↔ Dose prüfen/tauschen (keine Verlängerung, kein Verteiler), Dose fest; Vodafone-Techniker anfordern und die Messwerte vorlegen."

**R10 EVENING_CONGESTION**
- Condition: ≥ 3 days with evening coverage. Between 19 and 23 h, p95 or ES share is ≥ 2× the 9–17 h value and at least +20 ms. Gateway clean, DOCSIS clean.
- Severity: high.
- Title: „Abends deutlich schlechter – Hinweis auf überlastetes Kabelsegment"
- Text: „Zwischen 19 und 23 Uhr liegt die Latenz (p95) bei {e} ms statt {d} ms tagsüber; Paketverlust {l} %."
- Action: „Störung bei Vodafone melden (Segmentauslastung) und Bericht beilegen. Für Geschwindigkeits-Minderung zusätzlich die offizielle Breitbandmessung der Bundesnetzagentur nutzen."

**R11 DSLITE_IPV4**
- Condition: as in H5.
- Severity: medium to high.
- Title: „Nur IPv4 betroffen (DS-Lite / Carrier-NAT von Vodafone)"
- Text: „IPv4 zeigt {d} ms höhere Spitzen bzw. {l} Prozentpunkte mehr Verlust als IPv6 zum selben Ziel. IPv4 läuft bei diesem Anschluss durch einen Tunnel zum Vodafone-Gateway (AFTR)."
- Action: „Bei Vodafone eine Umstellung auf Dual-Stack (eigene öffentliche IPv4-Adresse) erfragen – die meisten Spiele nutzen IPv4. Bericht mit IPv4/IPv6-Vergleich beilegen."

**R12 REMOTE_PATH**
- Condition: as in H8.
- Severity: medium.
- Title: „Problem auf dem Weg zum Spielserver"
- Text: „Nur {game} ist betroffen; Cloudflare, Google und das Vodafone-Netz sind unauffällig."
- Action: „Statusseite des Spiels prüfen, andere Server-Region testen; MTR-Bericht an Spielebetreiber bzw. Vodafone."

**R13 IDENTITY_CHANGE**
- Severity and condition:
  - Critical: Tcpip 4199 (address conflict).
  - High: gateway MAC changed, or DHCP server changed.
  - Info: IPv6 prefix changed, or CGNAT egress changed.
- Texts:
  - „IP-Adresskonflikt erkannt"
  - „Ein anderes Gerät antwortet als Router (MAC geändert)"
  - „IPv6-Präfix bzw. öffentliche IPv4 (Carrier-NAT) hat gewechselt – laufende Verbindungen brechen dabei ab"
- Action for the high cases: „Zweiten Router/alte EasyBox im Netz suchen und deren DHCP abschalten."

**R14 CHANGE_TRIGGER**
- Condition: the configuration snapshot changed (driver, firmware, Windows build or WARP), and the incident rate after the change is ≥ 2× the rate before (≥ 3 days on each side).
- Severity: info to medium.
- Title: „Probleme seit Änderung am {date}: {what}"
- Action: „Änderung rückgängig machen bzw. aktuelles Update einspielen; Ergebnis im Tagebuch prüfen."

**R15 WARP_EFFECT**
- Condition: E6, with ≥ 2 h on each side and matched hours.
- Severity: info.
- Text when the difference is < 20 %: „Mit und ohne Cloudflare WARP sind Latenz und Verlust gleich ({a} vs. {b} ms p95) – WARP ist nicht die Ursache."
- Otherwise: „Mit WARP deutlich schlechter …" plus the action „WARP-Einstellungen mit der IT klären".

**R16 DATA_QUALITY**
- Condition: excluded seconds, or coverage < 50 % of awake time.
- Severity: info.
- Texts: „Messlücke {dur} (Standby/PC aus) – kein Netzproblem." / „Zu wenige Messdaten für eine sichere Aussage."

**R17 TOP_CAUSE**
- Inputs: the share of bad seconds per segment over 24 h and 7 days.
- Text: „Hauptursache (vorläufig): {segment} – {p} % der schlechten Sekunden."
- Confidence: high when ≥ 3 days, ≥ 100 bad seconds and p ≥ 50 %; medium when ≥ 24 h; otherwise low.

### 5.4 Correlation analyses

- **Link alignment.**
  - Precision = share of `LINK`-class SES bursts that overlap an in-operation link event in the window [down − 2 s, up + 10 s].
  - Recall = share of link events that have a measurable effect: an SES, an egress switch, or an RTT change > 20 ms.
  - Also measure the **recovery time** from link-up to the first `gw4` success and to the first internet success, separately for v4 and v6.
- **CMTS against the end target.** Compare per-second max RTT using Spearman ρ, plus spike co-occurrence (±1 s). If ≥ 70 % co-occur, the spikes originate in the access network.
- **v4 against v6, per second as pairs.** If v4-only ES are ≥ 3× the v6-only ES, and v4-only ES make up ≥ 20 % of all v4 ES, AFTR is involved.
- **Own load.** Bin RTT by utilisation (< 10 %, 10–50, 50–80, ≥ 80 %) and compare p95 per bin:
  - Δ ≥ 50 ms → self-congestion;
  - `gw4` Δ ≥ 20 ms → it happens in the LAN.
- **Time of day.** Use hour × weekday/weekend, only hours with ≥ 30 min coverage. Compare the evening (19–23 h) with daytime (9–17 h).
- **DOCSIS.** Over 5-minute windows, correlate Δuncorrectable (sum over channels) with loss and ES. Flag it if ρ ≥ 0.5, or if T3/T4 events fall within ±2 min of ≥ 50 % of SES bursts.
- **Periodicity.** Take the autocorrelation of ES per minute over 24 h. A peak of r ≥ 0.3 at a lag of 2–120 min points to a periodic cause, such as a background job.
- **Experiments.** Compare matched hours before and after, using the decision thresholds in H1, H2 and R15.

### 5.5 DOCSIS thresholds
These are guidance values (Richtwerte). Vodafone's own limits may differ, so treat them as uncertain.

| Value | Good | Warning | Critical |
|---|---|---|---|
| DS SC-QAM power | −7 … +7 dBmV | −10…−7 / +7…+10 | < −10 or > +10 (spec range ±15) |
| DS power spread across channels | ≤ 6 dB | 6–10 dB | > 10 dB |
| DS SNR/MER, 256-QAM | ≥ 35 dB | 30–33 dB (33–35 is OK) | < 30 dB (64-QAM: < 24) |
| OFDM MER (D3.1) | ≥ 38 dB | 33–38 dB | < 33 dB (depends on profile, uncertain) |
| US transmit power, SC-QAM | 38–48 dBmV | 48–51 or 35–38 | > 51 or < 35 (the maximum drops when ≥ 4 US channels are bonded) |
| Uncorrectable codewords | Δ = 0 | Δ > 0 on ≥ 25 % of channels in 3 consecutive 15-min windows | Δ/Δtotal > 1e-4, or > 1000/h without a total counter |
| T3 timeouts | ≤ 5 per 24 h | > 5 per 24 h | > 20 per 24 h, or ≥ 3 within 10 min |
| T4 timeout, sync/ranging loss | none | — | any |
| Partial service, fewer locked channels than baseline | none | any | — |

Values to collect:
- **Per downstream channel:** ID, frequency, modulation, power, SNR/MER, lock, unerrored/correctable/uncorrectable codewords.
- **OFDM/OFDMA:** MER, power, profile.
- **Per upstream channel:** frequency, symbol rate or width, modulation, power.
- **Modem:** uptime, DOCSIS event log (time, priority, text), provisioning status, firmware.
- **Router clock offset.** Router logs carry router time; if it shows "Time Not Established", times may be in 1970. Uncertain.

---

## 6. Dashboard KPIs (minimal set)

1. **Hauptursache (vorläufig):** the segment, with confidence and the number of supporting observations (R17).
2. **Schlechte Sekunden:** ES/SES share for 1 h and 24 h, as a stacked bar by segment.
3. **Segment-Leiter (p95):** Router | Kabelnetz (CMTS) | Internet IPv4 | Internet IPv6 | Spielserver.
4. **Paketverlust 24 h:** Router / Internet v4 / Internet v6.
5. **Kabelverbindung:** current link speed (1 G/100 M); in-operation drops for 24 h and 7 days; WLAN switches.
6. **Spiel-Jitter:** IPDV p95 and loss from the UDP bursts.
7. **DOCSIS traffic light**, if available: worst SNR/MER, power OK?, Δuncorrectable over 24 h, T3/T4 count.
8. **Bufferbloat grade and last throughput**, with the badge "durch 100-Mbit/s-Link begrenzt" when that applies.

Show the coverage everywhere, for example "gemessen: 9 h 40 min der letzten 24 h".

---

## 7. Implementation notes and verified snippets

### 7.1 Probe agent (PowerShell 5.1, no admin, verified)
The working prototype is `agent-test.ps1` and `agent-run.mjs`.
- Pass the configuration as **base64 JSON** in `-ConfigB64`. Quotes in `-File` arguments are fragile.
- Output is one JSON object per line on stdout, flushed after every loop iteration:
```json
{"k":"icmp","id":"cf4","ts":1791550457020,"st":"Success","rtt":123}
{"k":"icmp","id":"nobody","ts":1791550456008,"st":"DestinationHostUnreachable","rtt":null}
{"k":"nic","ts":1791550455000,"name":"Ethernet","up":true,"mbps":100,"rx":1597841801,"tx":88375540,"inErr":0,"inDisc":0,"outErr":0,"outDisc":0}
```
- `ts` is the **scheduled send time** (UTC ms) and is aligned to the interval grid. Use it, not the Node receive time.
- Possible values of `st`: Success, TimedOut, DestinationHostUnreachable, DestinationNetworkUnreachable, TtlExpired, PacketTooBig, Error, …
- Everything except Success counts as loss.
- `rtt` comes from the ICMP reply (`RoundtripTime`, 1 ms resolution, 0 when < 1 ms). It does not depend on the agent loop.

Core loop:
```powershell
$p = New-Object System.Net.NetworkInformation.Ping
[void]$pending.Add(@{ id=$t.id; ts=$now; task=$p.SendPingAsync($t.host, $t.timeoutMs, $buf); ping=$p })
# every ~20 ms: emit + dispose completed tasks
if ($e.task.IsCompleted) { $r=$e.task.Result; $st=[string]$r.Status; $rtt= if($st -eq 'Success'){$r.RoundtripTime}else{$null} ... }
# every 1000 ms:
foreach ($n in [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()) { $s=$n.GetIPStatistics(); ... }
```
Production notes:
- Supervise the agent: restart it with backoff when it exits, and restart it daily anyway.
- Run MTR in a **second agent instance**: synchronous `Send(host, 1000, buf, New-Object PingOptions(ttl,$false))` with a `Stopwatch`. The reply address is in `Reply.Address`, and the RTT for TtlExpired is 0.
- The IPv6 gateway works with a scope suffix: `fe80::de73:6ff:fe12:34df%4`.
- Startup to the first result took about 300 ms.

### 7.2 Egress source address (Node, verified)
```ts
import dgram from 'node:dgram';
export const egress = (fam: 'udp4'|'udp6', host: string) => new Promise<string|null>((res) => {
  const s = dgram.createSocket(fam);
  s.once('error', () => { s.close(); res(null); });            // no route → null
  s.connect(53, host, () => { const a = s.address().address; s.close(); res(a); });
});
// 1 Hz: egress('udp4','1.1.1.1'), egress('udp6','2606:4700:4700::1111') → '192.168.0.192' / LAN-prefix address
```

### 7.3 Game-like UDP probe (DNS CH TXT, verified)
- Query bytes: `[id_hi,id_lo, 0x01,0x00, 0,1, 0,0, 0,0, 0,0, 2,'i','d', 6,'s','e','r','v','e','r', 0, 0x00,0x10, 0x00,0x03]`. That is TXT (16), class CH (3).
- Use one persistent socket per family, so the AFTR mapping stays stable, and discard the first sample.
- Match replies by DNS ID; reordering shows up as ID order.
- The reply TXT is the Cloudflare PoP (`dus01` today). Store PoP changes.

### 7.4 STUN (verified)
- Request: `00 01 00 00 21 12 A4 42` + 12 random bytes of transaction ID.
- Response attribute `0x0020` (XOR-MAPPED-ADDRESS): port = xport ^ 0x2112; IPv4 = xaddr ^ 0x2112A442; IPv6 = xaddr ^ (cookie ‖ TID).
- Send to both servers from the same local socket. The same mapped port means endpoint-independent mapping (EIM), which is good.

### 7.5 Event polling (verified)
```text
wevtutil qe System "/q:*[System[Provider[@Name='e2fexpress' or @Name='Microsoft-Windows-Power-Troubleshooter' or @Name='Microsoft-Windows-Kernel-Power' or @Name='Microsoft-Windows-Kernel-General' or @Name='Tcpip' or @Name='NDIS'] and (EventRecordID > 7707)]]" /f:xml /e:Events
wevtutil qe Microsoft-Windows-WLAN-AutoConfig/Operational "/q:*[System[(EventRecordID > N)]]" /f:xml /e:Events
wevtutil qe Microsoft-Windows-NetworkProfile/Operational "/q:*[System[(EventRecordID > N)]]" /f:xml /e:Events
```
Parse these fields:
- `System/TimeCreated/@SystemTime` (UTC, 100 ns)
- `EventRecordID` (the bookmark per log)
- `EventID`
- `Provider/@Name`
- `EventData/Data[@Name]`

Store the localized message only for display.

Event IDs verified on this PC:

| Source | ID | Meaning |
|---|---|---|
| e2fexpress | 27 | link down |
| e2fexpress | 32 | link up, 1 Gbit/s full duplex |
| e2fexpress | 33 | link up, 100 Mbit/s full duplex |
| Power-Troubleshooter | 1 | resume. Properties[0] = SleepTime, [1] = WakeTime |
| Kernel-Power | 42 | sleep (reason "Application API") |
| Kernel-Power | 107 | resume |
| Kernel-Power | 109 | shutdown/reboot initiated |
| Kernel-Power | 187 | SetSuspendState called by a process |
| Kernel-General | 12 / 13 | boot / shutdown |
| WLAN-AutoConfig | 8000 / 8001 / 8002 / 8003 | start / connected / failed / disconnected. 8001 contains "Verbindungsmodus" |
| NetworkProfile | 10000 / 10001 | connected / disconnected. EventData: Name, Description, Guid, Type, State, Category |
| NetworkProfile | 4001 / 4002 / 4003 | identifying / identified / unidentified. EventData: InterfaceGuid, CurrentOrNextState |

The Ethernet InterfaceGuid is `{178af0a6-93f5-4ace-ace2-2ecdf78704f2}`. Tcpip 4199 means address conflict; that ID comes from general knowledge, and none occurred here.

### 7.6 Link-event classification
```text
for each down (e2fexpress 27):
  up      = next 32|33 before the next 27; speed = 32→1000, 33→100; dur = up - down
  if |down - PT1.TimeCreated| ≤ 15 s or |down - KP107| ≤ 15 s or 0 ≤ down - KG12 ≤ 120 s → 'renegotiation'
  elif -120 s ≤ down - KP42 ≤ 60 s → 'pre_sleep'
  else → 'in_operation'
  wlan_failover = WLAN 8001 within [down, down+5 s] or egress switch observed
```

### 7.7 SQLite sketch (engine is the only writer)
```sql
PRAGMA auto_vacuum=INCREMENTAL; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;
CREATE TABLE target(id INTEGER PRIMARY KEY, key TEXT UNIQUE, host TEXT, family INT, role TEXT, interval_ms INT, enabled INT);
CREATE TABLE probe_raw(target_id INT, ts INT, kind INT, status INT, rtt_ms REAL, egress INT, PRIMARY KEY(target_id, ts, kind)) WITHOUT ROWID;
CREATE TABLE nic_raw(ifname TEXT, ts INT, up INT, mbps INT, rx_bps REAL, tx_bps REAL, in_err INT, in_disc INT, out_err INT, out_disc INT, src4 TEXT, src6 TEXT, PRIMARY KEY(ifname, ts)) WITHOUT ROWID;
CREATE TABLE agg_1m(target_id INT, kind INT, ts INT, sent INT, lost INT, rtt_min REAL, rtt_p50 REAL, rtt_p95 REAL, rtt_p99 REAL, rtt_max REAL, ipdv_p95 REAL, spikes INT, max_loss_burst INT, es INT, ses INT, PRIMARY KEY(target_id, kind, ts)) WITHOUT ROWID;
CREATE TABLE win_event(log TEXT, record_id INT, ts INT, provider TEXT, event_id INT, data_json TEXT, class TEXT, PRIMARY KEY(log, record_id));
CREATE TABLE link_event(down_ts INT PRIMARY KEY, up_ts INT, speed INT, class TEXT, wlan_failover INT);
CREATE TABLE second_class(ts INT PRIMARY KEY, segment TEXT, self_load INT, gaming INT) WITHOUT ROWID; -- 14 d
CREATE TABLE incident(id INTEGER PRIMARY KEY, start_ts INT, end_ts INT, kind TEXT, segment TEXT, severity INT, gaming INT, details_json TEXT);
CREATE TABLE snapshot(ts INT, kind TEXT, data_json TEXT);   -- routes|neighbors|docsis|stun|mtr|speedtest|config
CREATE TABLE journal(id INTEGER PRIMARY KEY, ts INT, end_ts INT, kind TEXT, experiment_key TEXT, title TEXT, details TEXT);
CREATE TABLE finding(rule_id TEXT, ts INT, severity INT, confidence REAL, title_de TEXT, text_de TEXT, action_de TEXT, evidence_json TEXT);
CREATE TABLE coverage_1m(ts INT PRIMARY KEY, engine_ok INT, sys_awake INT);
```
- Compute percentiles and IPDV in engine memory per minute; do not do it in SQL.
- Batch inserts every 1–5 s inside one transaction.

### 7.8 Engine and Next.js
- Next does **not** open SQLite. It talks to the engine API at 127.0.0.1:3901, through route-handler proxies or `rewrites()`.
- That avoids locking problems and avoids bundling `node:sqlite` with Turbopack. Whether that bundling works is uncertain.
- Silence the ExperimentalWarning with `node --disable-warning=ExperimentalWarning` (Node ≥ 21.3). With tsx, passing it through `NODE_OPTIONS` is uncertain.
- Autostart without admin: a shortcut in the user's Startup folder (`shell:startup`).

---

## 8. Uncertainties (please verify)

- **Windows auto-metric:** at 1 Gbit/s, Ethernet should report 25, which would win against WLAN's 35. Not observed, because the link is currently at 100M. Also unknown: which route Windows picks on a tie at 35/35.
- **Is the second IPv6 hop (2a02:8101:3ff:ff89::3) really the CMTS?** A strong assumption, not proven. Its ICMP may be rate-limited at > 1 pps.
- **The access spikes seen on 2026-10-09** cover only about 25 s of measurement plus 20 samples per target. They need multi-day confirmation.
- **The DOCSIS thresholds** in §5.5 are generic guidance; Vodafone's limits may differ. Whether the TG6442 shows total codewords and T3/T4 counters is unknown.
- **The bufferbloat grade bands** are Waveform-like approximations (A+ ≤ 5, A ≤ 30, B ≤ 60, C ≤ 200, D ≤ 400, F > 400 ms of extra latency).
- **The DNS rate limits** of 1.1.1.1 at 20–50 pps.
- **The rate limits and terms** of the speed-test endpoints. M-Lab ndt7 is an alternative.
- **The output format** of `warp-cli status`.
- **What Selective Suspend actually does on a PCIe I225-V.**
- **Whether user-scope WLAN profiles can be changed without admin.**
- **NetworkProfile 4003 as a WARP artifact:** this rests only on the temporal correlation.
- **The PC's activity between 09-13 and 09-25:** no link events and no updates, so the baseline "0 in-operation drops before 09-26" covers only the days the PC was in use.

---

## Appendix A: in-operation and ambiguous link drops (since 2026-08-24)

| Time | Duration | Relink | Class | WLAN |
|---|---|---|---|---|
| 09-08 19:40:21 | 10.2 s | 100M | pre_sleep (64 s before KP 42) | – |
| 09-26 18:37:04 | 6.1 s | 1G | in_operation | 8001 +0.4 s, 8003 +39.4 s |
| 09-26 18:40:34 | 6.9 s | 1G | in_operation | 8001 +0.5 s, 8003 +38.0 s |
| 09-26 18:46:29 | 5.3 s | 100M | in_operation | 8001 +0.3 s |
| 09-27 10:45:10 | 14.2 s | 100M | in_operation | 8001 +0.4 s, 8003 +45.7 s |
| 09-30 15:48:44 | 3.5 s | 1G | ambiguous (156 s after resume) | 8001 +0.2 s, 8003 +34.6 s |
| 10-07 11:24:23 | 5.4 s | 100M | in_operation | 8001 +0.5 s |
| 10-07 11:24:50 | 16.8 s | 1G | in_operation | (WLAN still connected) |
| 10-07 11:26:47 | 6.4 s | 100M | in_operation | (WLAN still connected) |
| 10-08 15:14:22 | 6.1 s | 100M | in_operation | 8001 +0.3 s |
| 10-08 18:29:13 | 11.1 s | 1G | in_operation | 4× 8002 (failed) |
| 10-08 18:30:06 | 21.9 s | 100M | in_operation | – |
| 10-08 18:31:03 | 14.0 s | 1G | in_operation | 8001 +49.5 s, 8003 +81.7 s, 8001 +86.0 s |
| 10-08 18:33:21 | 7.0 s | 1G | in_operation | 8003 +68.2 s |
| 10-08 18:33:33 | 7.9 s | 1G | in_operation | 8003 +56.4 s |
| 10-08 18:40:26 | 3.4 s | 1G | in_operation | 8001 +0.7 s, 8003 +35.3 s |
| 10-08 18:42:02 | 5.7 s | 100M | in_operation | 8001 +0.2 s |
| 10-08 18:43:03 | 2.9 s | 1G | in_operation | 8003 +34.6 s |

**Renegotiations (59):**
- Link-down 2–4 s before PT1, or 10–15 s after KG12.
- 37 at 1G and 22 at 100M.
- Run of relink speeds (G = 1G, h = 100M, chronological, all 77 events): `GhGGhGGGGGGGGGGGhGGhGhhhhhhhhhhhhGhGGGGhGhGGGhGGhGGGGGhGhGGGGhGhGhGhGhGGGGhGh`.

## Appendix B: snapshots, 2026-10-09 around 14:00–14:40

- **20 interleaved probes per target, 250 ms apart (n = 20, ms):**

  | Target | min | p50 | p90 | max | Loss |
  |---|---|---|---|---|---|
  | ICMP gw4 | 0 | 1 | 1 | 2 | 0 |
  | ICMP cmts6 | 9 | 18 | 34 | 55 | 0 |
  | ICMP 1.1.1.1 | 15 | 20 | 57 | 109 | 0 |
  | ICMP 2606:4700:4700::1111 | 13 | 21 | 62 | 76 | 0 |
  | UDP DNS v4 | 17.7 | 28.1 | 108.3 | 215.4 | 0 |
  | UDP DNS v6 | 14.7 | 25.8 | 102.6 | 211.8 | 0 |

- **20 s at 4 probes/s per target, maximum per second:** gw4 1–4 ms; cmts6 16–138; cf4 24–145; cf6 22–140. Own RX 0.08–0.62 Mbit/s, own TX 0.03–1.53 Mbit/s.
- **Agent test:** 1.1.1.1 measured 45 / 30 / 123 / 216 / 21 ms.
- **TTL probes:**
  - v4: hop 1 192.168.0.1; hop 2 timeout (AFTR); hop 3 timeout; hop 4 145.254.2.199 (30 ms).
  - v6: hop 1 router (global address); hop 2 2a02:8101:3ff:ff89::3 (24.5 ms); hop 3 2a02:908:0:4d4::1 (14.5 ms); hop 4 timeout.
- **DF probes, IPv4:** 1460 B OK, 1461 B OK, 1500 B PacketTooBig.
- **STUN v4:** mapped port identical for Cloudflare and Google (EIM). The public IPv4 is from the CGNAT pool, so the router itself has no public IPv4.
- **STUN v6:** no NAT.
- **`id.server`:** `dus01` over v4 and over v6.
- **Counters:**
  - TCPv4 retransmissions 87,869 of 11,246,630 segments (0.78 %).
  - TCPv6 retransmissions 75,439 of 41,921,760 (0.18 %), cumulative since boot.
  - Adapter errors and discards 0 since the resume at 13:37.

## Appendix C: adapter facts (read without admin)

- **Interface metrics:**
  - Ethernet: 35 for v4 and v6, NlMtu 1500.
  - WLAN: 35, disconnected.
  - CloudflareWARP: 5, MTU 1280, no default route.
- **IPv4 default routes:** one each via WLAN and via Ethernet, both to 192.168.0.1 with RouteMetric 0. `Find-NetRoute` selects Ethernet (31 ms).
- **IPv6 default route:** via fe80::de73:6ff:fe12:34df, on Ethernet only.
- **I225-V advanced properties** (including hidden ones):
  - No `*EEE`.
  - `*SelectiveSuspend`=1, `*SSIdleTimeout`=5, `IdleTimeoutMs`=5000, `*DeviceSleepOnDisconnect`=0.
  - `WakeOnLink`=2 (Forced), `EnableModernStandby`=1, `LogLinkStateEvent`=51, `WaitAutoNegComplete`=2, `MasterSlave`=0.
  - `ITR`=64 (Low), `DMACoalescing`=0.
  - `*FlowControl`=3, `*InterruptModeration`=1, LSOv2 on.
  - `MatchingDeviceId` PCI\VEN_8086&DEV_15F3&REV_03.
- **`powercfg /a`:** S3, hibernate and fast startup are available; S0 Low Power Idle is not.
- **WcmSvc policy key:** absent, so Windows uses its default minimize-connections behaviour.
- **Windows Update in the last 35 days:** no network driver. KB5124008 (09-11), KB5124010 preview (09-29, build 26200.9550), Realtek audio, Intel graphics, Store apps.
