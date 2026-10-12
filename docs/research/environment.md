# ENV_SUSPECTS: environment-specific root-cause research (Jan-PC)

Date: 2026-10-09, about 15:15 CEST. Everything marked **[verified]** was measured or read on the user's machine today using read-only commands only: event logs, adapter properties, a few small pings, one IPv6 traceroute, STUN packets, and two unauthenticated GETs to the router (`/` on 192.168.0.1 by the scout earlier; `/` on 192.168.100.1 today). No settings were changed and no router login was attempted.
**[uncertain]** marks items that are inferred or come from community or third-party sources.

Helper scripts written during this research (scratch only):
- `research/env/stun_test.mjs`: RFC 5389 binding test against several servers from one socket (IPv4 and IPv6). Tested.
- `research/env/stun5780.mjs`: RFC 5780 mapping and filtering test. Tested against stun.gmx.net and stun.sonetel.com.
- `research/env/dump_msgtable.ps1`: dumps the message table of an event-message DLL, which is how the Intel event IDs below were obtained.
- `research/env/docsight_ref/`: downloaded reference sources (MIT). These are untrusted data and are only for reading:
  - from docsight: `vodafone_station.py`, `threshold_profiles.py`, `vodafone.py`, `segment_utilization.py`
  - from arris-tg3442de-exporter: `tg3442_*.py`

---

## 0. Executive summary

### 0.1 New facts that change the picture (all [verified])

1. **Most of the "77 link drops" are boot artefacts.** Through today there are 78 `e2fexpress` ID 27 events.
   - **59 are within 30 s of a boot or resume marker**: EventLog 6005/6013, Kernel-Boot 27, or Power-Troubleshooter 1. The driver logs link-down and link-up on every start.
   - **19 are genuine in-session drops**, each lasting 3–22 s. 12 of them happened on 2026-10-07 and 2026-10-08.
   - One drop happened live during this research, at **2026-10-09 15:00:25**: 3 s outage, relinked at 1 Gbit. No adapter-modifying command was running at the time.
2. **Abnormal 100 Mbit relinks.** A healthy Cat5e+ link with a 1 Gbit port should always come up at 1 Gbit/s.
   - At boot: 22 of 59 (37 %). Cold boot (BootType 0): 11 of 24 (46 %). Fast-Startup (BootType 1): 11 of 35 (31 %).
   - In session: 8 of 19 (42 %).
   - Between 2026-09-02 and 2026-09-13, every relink came up at 100 Mbit (12 of 12). From 2026-09-25 on, relinks are mostly at 1 Gbit, which suggests the cable or plug changed in between.
   - The link was at 100 Mbit from 13:38 today until the 15:00 flap, and is now at 1 Gbit.
   - This points first at the physical layer (cable, plug, or router port), then at the PHY/driver.
3. **Two different incident types can be told apart.**
   - **Router-reboot signature**, on 2026-10-08 between 18:29:13 and about 18:33:20:
     - three Ethernet flaps within 2 minutes;
     - WLAN could not associate because the router's SSID was not visible (WLAN 8002, ReasonCode 229396, twice);
     - Internet came back only after **about 247 s** on both Ethernet and WLAN, while the LAN was "local only" in between. That timing is typical of a Vodafone Station boot.
   - **LAN link-flap signature** (the other 15 or more drops): Internet is back 1–2 s after the relink, and WLAN failover had Internet within 1–2 s. The router and its WAN stayed up, so the cause is local: cable, port, PHY, or driver.
4. **Windows fails over to WLAN on every Ethernet loss.**
   - The WLAN profile "Vodafone-43FE" is set to "Automatisch verbinden".
   - WLAN connects within 0–1 s of the Ethernet loss (8001) and is soft-disconnected 30–60 s after Ethernet returns (8003, ReasonCode 5, "Richtlinie").
   - So every flap changes the source IP **twice** (192.168.0.192 ⇄ 192.168.0.35, plus new IPv6 temporary addresses), and IPv4 also gets a new AFTR NAT binding. Game sessions break.
   - The scout's "stale WLAN IP + default route" is this Windows soft-disconnect state: WLAN `ifOperStatus = Up` while `MediaConnectState = Disconnected`.
5. **DS-Lite NAT behaviour, measured with STUN.**
   - Public IPv4 is 92.208.29.229 (AS3209 Vodafone).
   - **Endpoint-Independent Mapping**: the same ip:port was seen from Google, Cloudflare and both stun.gmx.net IPs and ports.
   - **Endpoint-Independent Filtering**: tested per RFC 5780 against stun.gmx.net.
   - The port is not preserved. Mapped ports stayed between 19672 and 19830, which looks like port-block allocation [uncertain].
   - IPv6 has no NAT: the mapped address equals the local address and port.
   - IPv4 PMTU is 1460, and the router (192.168.0.1) returns ICMP "fragmentation needed", so PMTUD works. IPv6 PMTU is 1500.
6. **Useful in-path probe targets** [verified answering]:
   - DS-Lite **AFTR** `2a00:0:cff:84a0::3` (AS3209) answers ping6 at 15–22 ms.
   - First IPv6 ISP hop (CMTS side) `2a02:8101:3ff:ff89::3`: 12–71 ms.
   - IPv4 hop 3 `92.79.214.92`: 13–40 ms.
7. **Cloudflare WARP only reacts.** Its log shows `NetworkInfoChanged`, `Unable(NoNetwork)` and captive-portal firewall toggles at every flap, but it does not cause them. Game traffic is not tunneled, and DNS is not intercepted (tunnel-only mode). Its logs can be read without admin rights in `C:\ProgramData\Cloudflare\`.
8. **Router identity.**
   - 192.168.0.2 is unused. The router is the **Vodafone Station Wi-Fi 6 (CommScope/ARRIS TG6442)** at 192.168.0.1.
   - `http://192.168.100.1/` serves the **identical login page** (28,424 bytes), so there is no separate unauthenticated DOCSIS page.
   - **`easy.box` and `kabel.box` resolve through public DNS** (1.1.1.1 / 8.8.8.8) to Internet hosts: 45.77.92.157, 45.77.75.133 and 207.246.78.75. Credentials must never be sent to these names.
9. **Driver.**
   - 1.1.4.43 is the legacy NDIS `e2f.inf` from the Windows 10 branch (section `E15F3_3.10.0.1..17763`).
   - For Windows 11, Intel ships a **NetAdapter miniport (`e2fn.inf`, 2.1.x)** for I225. The newest Intel package is "Intel Network Adapter Driver for Windows 11" **31.2.2 (2026-07-10)**. Third-party listings show e2fn 2.1.5.12 (2026-03) and legacy 1.1.4.45 (2025-03) [uncertain].
   - Since driver 1.1.4.38 (Win10) / 2.1.3.3 (Win11), Intel disables EEE above 100 Mbit as a workaround. No `*EEE` keyword is exposed here, so EEE is unlikely to be the cause at 1 Gbit.
10. **Reference implementation for TG6442 router data.** The MIT-licensed project docsight (`vodafone_station.py`, TG variant) and arris-tg3442de-exporter show where the data lives:
    - `status_status_data.php`: `js_UptimeSinceReboot`, which gives the router uptime and therefore reboot detection.
    - `status_docsis_data.php`: `json_dsData` / `json_usData`.
    - `status_event_log_data.php`: router event log.
    - `overview_data.php`: `json_lanAttachedDevice[].Speed`, the router-side link speed per client.

### 0.2 Suspect ranking (as of today)

| # | Suspect | Evidence so far | Verdict |
|---|---|---|---|
| 1 | **LAN physical layer**: cable or plug, router LAN port, or I225 PHY negotiation | 19 in-session flaps with immediate WAN recovery; 37–42 % of relinks at 100 Mbit; 100 % at 100 Mbit for 12 days in September | **Strong.** Which side is at fault is still open. |
| 2 | **Router TG6442 instability or reboots** | 2026-10-08 18:29 reboot signature; forum reports of TG6442 LAN+WLAN dropouts; `_ga.lastRebootReason='unknown'` | **Plausible.** Confirm with router uptime and event log. |
| 3 | **I225-V driver** (legacy 1.1.4.43) | No driver stop/start (41/42), no errors, no WHEA; Intel targets NetAdapter on Win11 | Possible, secondary |
| 4 | **100 Mbit bottleneck**: loss and latency under load | Link alternates between 100M and 1G | Only matters if the tariff is above 100 Mbit and downloads run while gaming |
| 5 | DOCSIS segment congestion in the evening | Not measured yet | Measure it |
| 6 | DOCSIS line noise (upstream ingress, T3/T4) | Unknown; needs router DOCSIS data and event log | Measure it |
| 7 | DS-Lite AFTR, IPv4 only | NAT behaviour is excellent (EIM+EIF); v4 ≈ v6 right now | Measure with v4/v6 pairs |
| 8 | WARP Zero Trust | Only reacts to changes | Unlikely |
| 9 | WLAN | Used only during failover | Side effect |

---

## 1. Intel I225-V link drops and 100 Mbit fallback

### 1.1 Facts on this machine [verified]
- Device: `PCI\VEN_8086&DEV_15F3&SUBSYS_7E061462&REV_03` (MSI board), on a PCIe x1 Gen2 link. Driver `e2f.inf` 1.1.4.43 (2024-02-15), `oem25.inf`; it is the only e2f driver in the driver store.
- REV_03 is commonly called the **B3** stepping [uncertain; community claim, no Intel document found]. The known B1/B2 hardware bug is the 2.5G inter-packet-gap problem (Puget Systems). It is irrelevant here because the router ports are 1 Gbit (TG6442: 4× GbE).
- Advanced properties on this system use **English display names**, even though Windows is German, so code should key on `RegistryKeyword`:

| DisplayName | RegistryKeyword | Current | Test recommendation |
|---|---|---|---|
| Speed & Duplex | `*SpeedDuplex` | Auto Negotiation (0) | Keep Auto. For a cable test only, set "1.0 Gbps Full Duplex" temporarily. |
| Selective Suspend | `*SelectiveSuspend` | Enabled (1) | **Disabled** for the test period |
| Selective Suspend Idle Timeout | `*SSIdleTimeout` | 5 | – |
| Wait for Link | `WaitAutoNegComplete` | Auto Detect (2) | Leave it. It only affects link reporting at init. |
| Flow Control | `*FlowControl` | Rx & Tx Enabled (3) | Leave it |
| Interrupt Moderation / Rate | `*InterruptModeration` / `ITR` | Enabled / Low (64) | Leave it; this does not affect the link |
| Log Link State Event | `LogLinkStateEvent` | Enabled (51) | **Must stay enabled**; it is the data source |
| Wake on Link Settings | `WakeOnLink` | Forced (2) | Optional: Disabled [uncertain benefit] |
| Enable PME / Wake on Magic Packet / Pattern | `EnablePME` / `*WakeOnMagicPacket` / `*WakeOnPattern` | Enabled | Leave them |
| DMA Coalescing | `DMACoalescing` | Disabled | Leave it |
| (hidden) Gigabit Master Slave Mode | `MasterSlave` | 0 (auto) | Don't force it; Intel warns that forcing can cause a disconnect or a downshift to 100 Mbit |
| EEE | `*EEE` | **not present** | n/a (driver mitigation) |

- Power plan "Razer Cortex Power Plan": PCIe ASPM = **Aus** (0); WLAN power saving = Höchstleistung (0). `Get-NetAdapterPowerManagement` fails without admin ("Ein an das System angeschlossenes Gerät funktioniert nicht"), so don't rely on it.
- Adapter error and discard counters are 0. There are 0 WHEA events. None of these Intel events occur since log start: 28/29 (low power), 30 (autoneg mismatch), 40 (SmartSpeed downshift), 41/42 (driver stop/start), 50–52 (overheat).
- Registered System-log providers: `e2fexpress` (active, legacy driver), `e2fnexpress` (NetAdapter driver, 0 events) and `e2f68` (0 events). **After a driver update, events may come from `e2fnexpress`.**

### 1.2 Intel event IDs [verified from `e2fmsg.dll`, EN and DE]
Message IDs are qualifier 0x6004 for info, 0xA004 for warning and 0xE004 for error.

| ID | Level | EN | DE (as logged on this PC) |
|---|---|---|---|
| 27 | Warn | Network link is disconnected. | Netzwerkverbindung wurde unterbrochen. |
| 28 | Info | The network adapter is transitioning to a low-power state. | (EN text) |
| 29 | Info | The network adapter has exited a low-power state. | (EN text) |
| 30 | Warn | Adapter is set to auto-negotiation but the link partner is not → possible duplex mismatch | PROBLEM: Der Netzwerkadapter ist auf automatische Absprache konfiguriert, der Verbindungspartner aber nicht … |
| 32 | Info | Link established at 1 Gbps full duplex | Die Netzwerkverbindung wurde mit 1 Gbit/s Vollduplex hergestellt. |
| 33 | Info | 100 Mbps full duplex | … mit 100 Mbit/s Vollduplex … |
| 34 / 35 / 36 | Info | 100 HD / 10 FD / 10 HD | … |
| 40 | Info | **Intel SmartSpeed has downgraded the link speed from the maximum advertised.** | Intel SmartSpeed hat die Verbindungsgeschwindigkeit … heruntergestuft. |
| 41 / 42 | Info | Driver stopped / started | Der Netzwerkadaptertreiber wurde gestoppt / gestartet. |
| 50 / 52 | Error | Adapter stopped due to overheating | … überhitzt |
| 51 | Error | Link speed downshifted due to overheating | Die Geschwindigkeit … wurde verringert, da er überhitzt ist. |
| 57 | Info | 2.5 Gbps full duplex | … 2,5 Gbit/s … |
| 82 | Warn | Selected speed not supported by the media; falling back to autoneg | … |

Tcpip 4201 means "adapter connected … normal operation" and 4202 means "adapter disconnected … configuration released … may indicate malfunction". **Neither is logged on this system**, so don't depend on them. Tcpip only logged one 4227 event.

Note on ID 40 [uncertain]: it would prove a PHY downshift, but it was never logged even though 100M relinks occurred. Either the I225 PHY path doesn't log it, or the 100M came from autonegotiation, for example because the partner or the 1000BASE-T master/slave training failed. So the event log alone cannot separate a bad pair from a negotiation problem. Physical tests (§1.6) are needed.

### 1.3 Reclassification: boot artefacts vs. genuine drops [verified]
Method: for each ID 27 event, look for a boot or resume marker within ±30 s in the System log. Markers are EventLog 6005/6013, Microsoft-Windows-Kernel-Boot 27 (field `BootType`: 0 = cold boot, 1 = Fast Startup, 2 = hibernate resume [2 not observed]) and Microsoft-Windows-Power-Troubleshooter 1. The relink speed comes from the next ID 32/33/57 event.

Result: 78 link-down events in total. 59 are boot or init events (37 at 1G, 22 at 100M). 19 are in-session (11 at 1G, 8 at 100M).

In-session drops (ETH-Inet is the first NCSI 4042 event on Ethernet with Family 0 and Capability 2):

| Link down | Outage | Relink | ETH Internet after | WLAN assoc / Internet after | WLAN "no AP" | Class |
|---|---|---|---|---|---|---|
| 2026-09-08 19:40:21 | 10 s | 100M | n/a | – | 0 | Flap (PC went to standby afterwards) |
| 2026-09-26 18:37:04 | 6 s | 1G | 9 s | 0 / 1 s | 0 | Flap |
| 2026-09-26 18:40:34 | 7 s | 1G | 8 s | 0 / 1 s | 0 | Flap |
| 2026-09-26 18:46:29 | 5 s | 100M | 6 s | 0 / 2 s | 0 | Flap |
| 2026-09-27 10:45:10 | 14 s | 100M | 15 s | 0 / 1 s | 0 | Flap |
| 2026-09-30 15:48:44 | 3 s | 1G | 4 s | 0 / 1 s | 0 | Flap |
| 2026-10-07 11:24:23 | 5 s | 100M | 7 s | 0 / 1 s | 0 | Flap |
| 2026-10-07 11:24:50 | 17 s | 1G | 18 s | (WLAN still up) | 0 | Flap |
| 2026-10-07 11:26:47 | 6 s | 100M | 7 s | (WLAN still up) | 0 | Flap |
| 2026-10-08 15:14:22 | 6 s | 100M | 7 s | 0 / 2 s | 0 | Flap |
| **2026-10-08 18:29:13** | 11 s | 1G | **247 s** | 160 / **248 s** | **2** | **Router reboot (suspected)** |
| 2026-10-08 18:30:06 | 22 s | 100M | 195 s | 107 / 195 s | 0 | (same reboot) |
| 2026-10-08 18:31:03 | 14 s | 1G | 137 s | 50 / 138 s | 0 | (same reboot) |
| 2026-10-08 18:33:21 | 7 s | 1G | 8 s | – | 0 | Flap |
| 2026-10-08 18:33:33 | 8 s | 1G | 9 s | – | 0 | Flap |
| 2026-10-08 18:40:26 | 3 s | 1G | 5 s | 1 / 3 s | 0 | Flap |
| 2026-10-08 18:42:02 | 6 s | 100M | 7 s | 0 / 1 s | 0 | Flap |
| 2026-10-08 18:43:03 | 3 s | 1G | 4 s | – | 0 | Flap |
| **2026-10-09 15:00:25** | 3 s | 1G | 4 s | 0 / 1 s | 0 | Flap (observed live) |

Other observations:
- Several triple boots happened within 2–3 minutes (2026-08-31 19:34–19:36, 09-10 20:13–20:16, 09-27 20:57–21:00, 09-29 15:31–15:33). They were clean (no 41/6008), so they were probably update restarts [uncertain].
- Kernel-Power 42/107 (sleep/resume, roughly 19–21 h) do not coincide with the in-session flaps.

### 1.4 Signatures used for automatic classification
- **BOOT_INIT**: link-down within ±30 s of a boot or resume marker. Don't count it as a drop, but do count its relink speed in a "Boot-Linkqualität" KPI.
- **ROUTER_REBOOT (suspected)**: in-session, with Internet recovery over 120 s after the first link-down, plus at least one of the following:
  - WLAN 8002 with ReasonCode 229396 (no connectable AP visible) within 240 s;
  - two or more further link-downs within 180 s;
  - gateway 192.168.0.1 unreachable on all interfaces for 60 s or more;
  - the unauthenticated router page `http://192.168.0.1/` not answering.

  Confirm afterwards with the router uptime (`js_UptimeSinceReboot`, which needs login) or the router event log.
- **LAN_LINK_FLAP**: in-session, with Internet back within (outage + 15 s), and/or WLAN failover reaching Internet within a few seconds.
- **WLAN_FAILOVER**: WLAN 8001 within 5 s after an Ethernet down. Record the egress interface and source IP.

### 1.5 Known I225-V causes and how they apply here

| Cause | Source | Applies? |
|---|---|---|
| B1/B2 2.5G IPG bug | Puget Systems; Intel CN forum | No: 1G partner, REV_03 |
| EEE engaging on active links (I225/I226) | Intel workaround drivers 2.1.3.3 / 1.1.4.38 disable EEE above 100M (Club386, 2023-03) | Unlikely, because the driver mitigation is in place (1.1.4.43) |
| Driver branch / bad driver (e.g. revoked 1.0.2.6) | Intel KB 000091005: "Changing the driver … immediately resolves"; ASUS ROG forum (2.x worse for some) | Possible. Win11 should use NetAdapter e2fn 2.1.x [uncertain benefit] |
| Selective Suspend / power management | Intel user guide ("low power state when the network is idle") | Unlikely: no 28/29 events and ASPM is off. Disable for the test anyway. |
| Cable pairs (1000BASE-T needs all 4 pairs; 100BASE-TX uses 1-2/3-6) → 100M fallback | TrueNAS, Unraid, Intel community threads | **Likely**: 100M relinks are frequent and changed over time |
| Router or switch port issue | Unraid thread (port fault); Vodafone forum TG6442 dropouts ("Interface Reset, Link is Up", overheating) | **Likely or possible** |
| Gigabit Master/Slave forcing | Intel 000005593 | No (auto) |
| Forced speed vs autoneg | Intel 000091032: Auto Negotiation is the correct setting for Gigabit | Only as a diagnostic test |

### 1.6 Telling cable/port apart from driver and router: test plan

These are ready-to-use German UI texts.
1. **Kabeltausch**: kurzes, neues Cat-5e/6-Patchkabel direkt PC ↔ Vodafone Station (keine Wanddose, keine Kupplung, kein Switch). Stecker müssen hörbar einrasten; Kabel nicht knicken oder einklemmen (Stuhlrollen, Tür).
2. **Porttausch** am Router (die TG6442 hat 4 Gigabit-Ports): anderen LAN-Port verwenden und notieren, welcher Port genutzt wird.
3. **Gegenprobe 1-Gbit-Zwang**: Gerätemanager → Intel I225-V → Erweitert → „Speed & Duplex“ = „1.0 Gbps Full Duplex“. Kommt die Verbindung dann nicht oder nur instabil zustande, kann das Kabel bzw. der Port kein Gigabit (defektes Adernpaar). Danach wieder auf „Auto Negotiation“ stellen.
4. **Router-Sicht**: In der Router-Übersicht (Geräteliste LAN) prüfen, ob der PC (MAC D8:43:AE:12:34:56) mit „1 Gbps“ oder „100 Mbps“ angezeigt wird; das Router-Ereignisprotokoll zu den Abbruchzeiten prüfen.
5. **Treiber** erst danach ändern, damit die Ursache eindeutig bleibt: Intel „Network Adapter Driver for Windows 11“ 31.2.2 (installiert den NetAdapter-Treiber e2fn 2.1.x) oder MSI-Board-Treiber. Danach heißt die Ereignisquelle ggf. `e2fnexpress`.
6. **BIOS/UEFI-Update** des MSI-Boards [unsicher, ob es I225-NVM enthält].
7. **Zweite Netzwerkkarte** (USB- oder PCIe-NIC) als Gegenprobe, falls nach 1–3 weiterhin Flaps auftreten.

Decision logic:
- If flaps or 100M relinks stop after the **cable** swap, it was the cable.
- If they stop after the **port** swap, it was the router port. Tell Vodafone, because the router is their property.
- If they continue at a different port with a new cable, try the driver, then the second NIC. If the second NIC also flaps, it is the router.
- If flaps cluster in the evening and the router uptime resets, the router is rebooting.

### 1.7 KPIs to show whether a fix worked
- In-session LAN flaps per day: target 0 over 7 days.
- Relink speed share at 1 Gbit, boot and in-session: target 100 %.
- WLAN failover events per day: target 0. These follow from flaps.
- Router uptime increases monotonically, with no `ROUTER_REBOOT` incidents.

### 1.8 Short German recommendation texts
- „LAN-Verbindung instabil: Seit dem 08.09. 19 echte Verbindungsabbrüche (3–22 s), davon 12 am 07./08.10.; 42 % der Neuverbindungen nur mit 100 Mbit/s. Typisch für Kabel/Stecker/Router-Port. Bitte Kabel und Router-Port tauschen (Anleitung).“
- „Die Meldungen ‚Netzwerkverbindung wurde unterbrochen‘ beim Hochfahren (59×) sind normal. Auffällig ist nur, dass dabei in 37 % der Fälle nur 100 Mbit/s ausgehandelt wurden.“
- „Am 08.10. um 18:29 ist sehr wahrscheinlich der Router neu gestartet (LAN und WLAN gleichzeitig weg, Internet erst nach ca. 4 Minuten wieder da).“

---

## 2. DS-Lite / CGNAT on Vodafone cable

### 2.1 Measured facts [verified]
- Router start page values (unauthenticated): `_ga.wanIpv4='0.0.0.0'`, `_ga.gwMode='Ipv6'`, `_ga.dsLitePlusIpv6Mode='true'`, `_ga.aftrAddress='2a00:0:cff:84a0::3'`.
- The AFTR is in prefix 2a00::/22 (AS3209 VODANET) and **answers ping6** at 15/18/18/22 ms.
- STUN (§4):
  - IPv4 public address **92.208.29.229** (92.208.0.0/14, AS3209). The mapping was the same for Google (74.125.250.129:19302), Cloudflare (162.159.207.0:3478) and stun.gmx.net (212.227.67.33 and .34, ports 3478/3479), so it is **EIM**.
  - In the RFC 5780 filtering test, a response from a different IP and port (212.227.67.34:3479) was received, so it is **EIF**.
  - Mapped ports seen: 19830, 19679, 19744, 19699, 19672 → probably a per-subscriber **port block** [uncertain].
- STUN over IPv6: the mapped address equals the local temporary address and port, so there is **no NAT66**.
- PMTU: IPv4 `ping -f -l 1472/1452` → "Paket müsste fragmentiert werden" (1452 is answered by 192.168.0.1 with frag-needed); `-l 1432` works. So the **IPv4 MTU is 1460** (DS-Lite: 1500 − 40), and PMTUD works. IPv6 `-l 1452` works, so the IPv6 MTU is 1500.
- IPv4 traceroute (scout): hop 1 router, **hop 2 `* * *`** (plausibly the AFTR or tunnel end, which doesn't send TTL-exceeded [uncertain]), hop 3 92.79.214.92.
- IPv6 traceroute to 2606:4700:4700::1111: hop 1 router, **hop 2 `2a02:8101:3ff:ff89::3`** (AS3209, the first ISP hop behind the DOCSIS segment, i.e. CMTS side) at 17–21 ms, hop 3 `2a02:908:0:4d4::1`, hop 4 timeout, hops 5–6 Cloudflare 2400:cb00:…, hop 7 target at about 17–26 ms.

### 2.2 What this means for gaming
- The B4 (the router) does not NAT IPv4. NAT44 happens only at the AFTR (RFC 6333). So there is **no double NAT**, but **port forwarding, DMZ and UPnP for IPv4 have no effect**: incoming IPv4 connections are only possible after an outgoing packet.
- The AFTR must follow RFC 4787 (RFC 6333 §8.2). RFC 4787 REQ-1 is EIM; REQ-8 recommends EIF for transparency. The **measured EIM+EIF is the best case for P2P and NAT traversal**. A "strict" NAT type at the IPv4 level is therefore unlikely to come from the AFTR [uncertain mapping to console NAT labels].
- UDP mappings must not expire in under 2 minutes (RFC 4787 REQ-5), so the AFTR timeout is at least 2 minutes. Keepalives are not normally an issue.
- PCP (RFC 6887, draft-ietf-pcp-dslite) could in theory open ports on the AFTR. **There is no evidence that Vodafone supports it** [uncertain].
- **Dual Stack** (a public IPv4 address) is available only as a goodwill gesture ("Kulanz"), with no entitlement, according to forum reports. A paid business tariff with a fixed IP is the contractual route [uncertain, policies change].
- Platforms:
  - Xbox uses native IPv6 for P2P when both peers have it, and otherwise Teredo or IPv4 (Microsoft doc, via RIPE Labs).
  - Valve SDR relays are **IPv4 only** according to the Valve wiki (undated). The Steam networking API supports IPv6 for direct UDP.
  - Most PC game servers (Riot, Epic, Blizzard, EA, Activision) are IPv4 [not individually verified].
  - **Assume game traffic goes over IPv4 through the AFTR.**
- Under DS-Lite, a change of LAN source IP (the WLAN failover) creates a new AFTR binding with a different public port. Existing UDP game sessions die.

### 2.3 Isolation logic: IPv4 vs IPv6
Probe these targets in parallel at the same rate. Each IPv4/IPv6 pair goes to the same anycast operator.

| Name | IPv4 | IPv6 | Baseline today, 5 pings (ms) |
|---|---|---|---|
| Cloudflare DNS | 1.1.1.1 (also 1.0.0.1) | 2606:4700:4700::1111 (::1001) | v4 16–30, v6 12–39 |
| Google DNS | 8.8.8.8 (8.8.4.4) | 2001:4860:4860::8888 (::8844) | v4 15–18, v6 18–21 |
| Quad9 | 9.9.9.9 (149.112.112.112) | 2620:fe::fe (2620:fe::9) | v4 22–36, v6 22–38 |
| Gateway (LAN) | 192.168.0.1 | (fe80::de73:6ff:fe12:34df%4) | 1–2 |
| First ISP hop (DOCSIS) | – (v4 hop 2 silent) | 2a02:8101:3ff:ff89::3 | 12–71 |
| AFTR | – | 2a00:0:cff:84a0::3 | 15–22 |
| Vodafone v4 core (hop 3) | 92.79.214.92 | – | 13–40 |

Caveats:
- Anycast can land at different PoPs per address family. For example, Google STUN over v6 was 40–62 ms while Google DNS over v6 was 18–21 ms. **Compare changes over time against each pair's own baseline, not absolute v4 − v6 differences.**
- ICMP to routers (gateway, CMTS hop, AFTR) is control-plane traffic and gets deprioritized. Use medians and loss over windows, and require corroboration from end-to-end targets.
- Rediscover the hops daily (`tracert -d -4 -h 4 1.1.1.1`, `tracert -d -6 -h 3 2606:4700:4700::1111`) and read the AFTR address from the router start page, because they can change after reboots.

Decision matrix per window (e.g. 1 minute: loss %, p50/p95 RTT):

| Gateway | v6 hop2 (CMTS) | AFTR (v6) | v6 ext | v4 ext | Diagnosis |
|---|---|---|---|---|---|
| bad | * | * | * | * | LAN / PC / WLAN / router. Check link events and egress interface. |
| ok | bad | bad | bad | bad | DOCSIS access: segment congestion (evening pattern) or line noise (random; check DOCSIS values and T3/T4) |
| ok | ok | ok | ok | **bad** | **AFTR / CGNAT path (IPv4 only)** |
| ok | ok | bad | ok | bad | Path to the AFTR (Vodafone core) |
| ok | ok | ok | bad | bad | Vodafone backbone or peering. Compare traceroutes. |
| ok | ok | ok | ok | ok but game bad | Game server or route; probe the game server itself |

### 2.4 German recommendation texts
- „Ihr Anschluss nutzt DS-Lite: IPv4 läuft über ein Vodafone-Gateway (AFTR) und eine geteilte öffentliche IPv4 (92.208.29.229). Portfreigaben/UPnP für IPv4 sind dadurch wirkungslos. Gemessen: NAT-Verhalten ‚endpoint-unabhängig‘ – für Online-Spiele günstig.“
- „Sind IPv4-Latenz/-Verluste dauerhaft schlechter als IPv6 zu denselben Zielen, liegt es am DS-Lite-Gateway. Dann bei Vodafone mit den Messprotokollen eine Umstellung auf Dual Stack (öffentliche IPv4) anfragen – nur auf Kulanz, kein Rechtsanspruch.“

---

## 3. Cable segment congestion and line problems, and how to document them

### 3.1 Signs and detection logic
- **Congestion** (shared DOCSIS segment, node overloaded):
  - RTT and jitter rise **together** on the CMTS hop (v6 hop 2), the AFTR and all external targets in the evening (around 19–23 h), especially on weekends.
  - Gateway RTT stays at about 1 ms, the LAN link is stable, and DOCSIS levels are within spec.
  - Download throughput drops in the evening, often much more than upload.
  - Forum reports describe 100–250 ms pings between 20 and 23 h and normal values otherwise. Vodafone fixes this with node or segment splits; a technician can measure the node load.
  - Detection:
    - Keep at least 7 days of 1 Hz probes. Aggregate per hour of day: p50, p95, loss.
    - Baseline = median of 03–17 h.
    - Flag "Abendüberlastung" when, in the 19–23 h window, p50(CMTS hop and external) exceeds baseline + 15 ms or baseline × 1.5, and/or loss exceeds 0.5 %, while gateway p50 stays under 3 ms, on at least 3 of 7 days.
- **Line noise / upstream ingress** (Rückwegstörung):
  - Loss and spikes are **not time-of-day bound** and come in bursts.
  - The router event log shows T3/T4 timeouts and resync; there are uncorrectable codewords, upstream power is high, and upstream modulation drops (to 16QAM or QPSK).
  - Needs router data (§8).
- **Local bottleneck or bufferbloat**:
  - RTT and loss spikes coincide with high **local** throughput: Ethernet RX at 85 % or more of link speed, e.g. 85 Mbit/s or more on a 100M link.
  - Sample NIC counters every 1 s (§9.1).
  - Rough thresholds: added latency under load above 30 ms is noticeable; above 100 ms is bad [own thresholds].

### 3.2 DOCSIS thresholds (docsight "VFKD Thresholds" profile v1.1.0)
docsight says this profile is based on the Vodafone pNTP DOCSIS Interface Specification v1.06 (2021-09-13): https://www.vodafone.de/media/downloads/pdf/VF-DOCSIS-Interface-Specification-v1.06.pdf. I did not open that PDF myself [uncertain]. Conversion: dBmV = dBµV − 60.

| Metric | good | warning | critical |
|---|---|---|---|
| DS power 256QAM (dBmV) | −4 … +13 | −6 … +15 | −8 … +16 |
| DS power 64QAM | −10 … +7 | −12 … +12 | −14 … +16 |
| DS power 1024/4096QAM | −2 … +15 | −4 … +16 | −6 … +16 |
| DS power OFDM | −12 … +12 | −15 … +15 | −15 … +15 |
| US power SC-QAM (dBmV) | 41.1 … 47.0 | 37.1 … 51.0 | 35 … 53 |
| US power OFDMA | 44.1 … 47.0 | 40.1 … 48.0 | 38 … 50 |
| SNR/MER minimum (dB) 64QAM | ≥ 27 | ≥ 25 | ≥ 23 |
| SNR/MER minimum 256QAM | ≥ 33 | ≥ 31 | ≥ 29 |
| SNR/MER minimum OFDM | ≥ 27 | ≥ 25.5 | ≥ 24.5 |
| SNR/MER minimum 1024QAM / 4096QAM | 39 / 40 | 37 / 38 | 36 / 36 |
| US modulation | – | ≤ 16QAM | ≤ QPSK (4) |
| Uncorrectable % | – | 1 % | 3 % |

Forum note: the old 2018 Vodafone color tables are considered outdated for DOCSIS 3.1. DOCSIS 3.1 upstream offsets (about 6 dB) are disputed [uncertain].

### 3.3 Documentation for Vodafone, BNetzA and the law
- **BNetzA Breitbandmessung** (desktop app, the official "Nachweisverfahren"):
  - 30 measurements on 3 different calendar days within 14 days, with at least one calendar day between measurement days.
  - 10 per day, at least 5 minutes apart, and at least 3 hours between the 5th and 6th measurement of a day.
  - A shortfall ("Minderleistung", Verfügung 99/2021) exists if any of these holds: (1) on at least 2 of 3 days, 90 % of the maximum speed is never reached; (2) the normally available speed is not reached in 90 % of measurements; (3) on at least 2 of 3 days the minimum speed is undercut at least once.
  - **Only download and upload speeds count, not latency or loss.**
  - **Only measure over a 1 Gbit LAN link.** With today's 100M relinks the measurement would be invalid for tariffs above 100 Mbit. The tool must warn about this.
- **§ 58 Abs. 3 TKG compensation**:
  - Applies if a fault is not fixed within 2 calendar days after the fault report.
  - For each day of **complete** outage: day 3–4, €5 or 10 %; from day 5, €10 or 20 % of the monthly fee, whichever is higher.
  - Latency and loss are generally not a "complete outage" [legal interpretation uncertain; LG Göttingen took a broader view for mobile telephony]. Document them as a service fault anyway.
- **What to submit with a Vodafone fault report** (German checklist for the export):
  - Zeitraum, Tageszeiten-Profil (p50/p95/Verlust je Stunde), Liste der Ausfälle mit Uhrzeit/Dauer/Klassifikation;
  - Traceroutes (Problemzeit vs. Ruhezeit);
  - DOCSIS-Werte (DS/US-Pegel, SNR/MER, Modulation) mit Zeitstempel;
  - Router-Ereignisprotokoll (T3/T4, Neustarts);
  - Router-Laufzeit (Neustarts);
  - Hinweis, dass LAN-Probleme (Kabel/Port) ausgeschlossen wurden;
  - Ticketnummer und Datum notieren (Fristbeginn § 58).
  - Breitbandmessung nur für Geschwindigkeit.

### 3.4 German recommendation text
„Abends (19–23 Uhr) steigen Ping und Verluste ab dem ersten Vodafone-Knoten an, während Router und LAN unauffällig sind → Hinweis auf Überlastung des Kabelsegments. Messreihe ≥ 7 Tage laufen lassen, Bericht exportieren und Störung bei Vodafone melden (Segment-/Node-Prüfung anfragen).“

---

## 4. STUN-based NAT mapping test (verified implementation)

### 4.1 Binding request (RFC 5389/8489), exactly 20 bytes
```
00 01            Message Type = Binding Request
00 00            Message Length = 0 (no attributes)
21 12 A4 42      Magic Cookie
xx * 12          Transaction ID (random)
```
The success response type is `0x0101`. Attributes are TLVs padded to 4-byte boundaries:
- **XOR-MAPPED-ADDRESS** `0x0020`: byte 0 is reserved, byte 1 is the family (`0x01` IPv4, `0x02` IPv6), bytes 2–3 are the port XOR `0x2112`, and the address follows. For IPv4 the address is XORed with `21 12 A4 42`. For IPv6 it is XORed with (cookie ‖ transaction ID).
- `0x0001` MAPPED-ADDRESS (not XORed, legacy).
- `0x802b` RESPONSE-ORIGIN and `0x802c` OTHER-ADDRESS (RFC 5780).
- CHANGE-REQUEST `0x0003`, value 4 bytes: `0x04` change IP, `0x02` change port.

Google and Cloudflare answered with only `0x0020`. stun.gmx.net also returned 0x802b and 0x802c.

### 4.2 Servers (checked today)

| Server | Resolved | Notes |
|---|---|---|
| stun.l.google.com:19302 | 74.125.250.129 / 2001:4860:4864:5:8000::1 | **stun1.l.google.com resolved to the same IP**, so it is not a distinct server for EIM tests |
| stun.cloudflare.com:3478 | 162.159.207.0 / 2606:4700:49:: | Free and unlimited (Cloudflare docs); also 53/udp |
| stun.gmx.net:3478 | 212.227.67.33, OTHER-ADDRESS 212.227.67.34:3479 | **Full RFC 5780** (different IP and port) → filtering test works |
| stun.sonetel.com:3478 | 52.24.174.49, OTHER-ADDRESS same IP:3479 | Partial: port change only |
| List of RFC 5780 candidates | https://raw.githubusercontent.com/pradt2/always-online-stun/master/valid_nat_testing_hosts.txt (updated hourly, 58 hosts today) | OTHER-ADDRESS is not verified by the list |

### 4.3 Algorithm
1. **EIM test**: one UDP socket, a binding request to at least 2 servers with **different IPs** (Google and Cloudflare). The same mapped ip:port means EIM. A different port per destination means address- or port-dependent mapping ("symmetric").
2. **RFC 5780 mapping** (stun.gmx.net):
   - Test I goes to the primary address.
   - Test II goes to the OTHER-ADDRESS IP with the primary port. Same mapping as Test I means EIM.
   - Test III goes to the OTHER IP and port. Same as Test II means address-dependent; otherwise port-dependent.
3. **RFC 5780 filtering**, on a fresh socket:
   - Test I.
   - Test II with CHANGE-REQUEST 0x06. A response means **EIF**.
   - Otherwise Test III with 0x02. A response means address-dependent filtering; otherwise address- and port-dependent filtering.
4. IPv6: run the same against the v6 addresses. If the mapped address equals the local address, there is no NAT66.
5. Schedule: every 15–30 minutes and after every network change (link or egress change). Store the public IPv4, the mapped port and the local port, and **alert when the public IPv4 changes**, because that means a new AFTR binding or pool.

### 4.4 Today's results
- IPv4: local 0.0.0.0:53856 → **92.208.29.229:19830** from Google and Cloudflare. RTT 16–20 ms. EIM.
- gmx: EIM and EIF. sonetel: EIM; its "EIF" result is only port-change filtering, because the server cannot change IP.
- IPv6: `[3fff:8071:7ca0:c980:d8de:c10f:adb:ac10]:53857` equals local. RTT: Google v6 40–62 ms, Cloudflare v6 15 ms.
- Code: `research/env/stun_test.mjs` and `research/env/stun5780.mjs` (Node 22 ESM, no dependencies).

---

## 5. Cloudflare WARP Zero Trust (split tunnel, include mode)

### 5.1 State [verified]
- `warp-cli 2026.4.1390.0`. `warp-cli --json status` returns `{"status":"Connected","reason":"NetworkHealthy"}`.
- `warp-cli --json --listen status` streams one JSON object per status change, which suits a long-running child process.
- `warp-cli --json stats` returns counters (JSON array metrics).
- Interface `CloudflareWARP` ("Cloudflare WARP Interface Tunnel"), 100.96.0.7, `NlMtu 1280`, metric 5.
  - **ifIndex changes on reconnect** (32 → 35). Match by alias or description.
  - Routes exist only for the include CIDRs, with next hop 192.0.2.1 / 2001:db8::1. The default route stays on Ethernet.
- Mode TunnelOnly (Cloudflare: "Secure Web Gateway without DNS filtering" / "Traffic only"): **WARP performs no DNS functions**. The Ethernet DNS servers are the custom 1.1.1.1 and 8.8.8.8.
- Logs are readable without admin, with UTC timestamps and daily rotation (`.1`, `.2`, `.3`):
  - `C:\ProgramData\Cloudflare\cfwarp_service_log.txt`, with lines such as `NetworkInfoChanged(...)`, `WARP status: Unable(NoNetwork)` and `Firewall allow captive portal detection`;
  - `cfwarp_route_change_log.txt`.
  - At 2026-10-08T16:29:13Z (18:29:13 local) WARP logged the network change in the same second as the NIC link-down. It reacted; it was not the trigger.

### 5.2 Assessment
- Game traffic is not tunneled, so there is no extra latency or MTU effect (the 1280 MTU applies to tunneled traffic only).
- WARP does install an OS firewall and toggles captive-portal rules during network changes (seen in the log). Cloudflare docs say non-tunneled traffic is allowed through that firewall by the split-tunnel rules.
- Known issue from Cloudflare release notes (2025): in tunnel-only mode with a **custom DNS server set on the primary adapter**, changing that DNS while WARP is connected can break DNS until WARP reconnects. This is relevant because custom DNS is set here.
- A connection manager that reconnects at every flap doesn't affect untunneled game flows. It can make corporate access flaky during flaps.
- Verdict: **not a cause** of link drops or game lag [high confidence]. It can be confirmed with an A/B test, but only if the employer's policy allows `warp-cli disconnect`. The tool should never control WARP.

### 5.3 Detection in the tool
- Log `warp-cli --json status` every 60 s, or keep `--listen` running. Store transitions (status, reason) and mark windows where status ≠ Connected.
- Optionally tail `cfwarp_service_log.txt` for `NetworkInfoChanged` and `WARP status:` lines.
- Show the include CIDRs from the scout as information only.

### 5.4 German text
„Cloudflare WARP (Firmen-VPN) leitet nur Firmennetze durch den Tunnel. Spiele-Traffic läuft direkt. WARP reagiert auf die LAN-Abbrüche, verursacht sie aber nicht. Keine Änderung nötig.“

---

## 6. Windows Wi-Fi pitfalls if the user switches to WLAN (brief)

- **Adapter**: Intel Wi-Fi 6E AX211, driver 23.40.0.4. Advanced properties (`RegistryKeyword`, current value):
  - `RoamAggressiveness` = 3. Medium. Gaming recommendation: **1. Lowest**.
  - `MIMOPowerSaveMode` = Auto SMPS. Recommendation: **No SMPS**.
  - `*PacketCoalescing` = Enabled. Recommendation: **Disabled**.
  - `uAPSDSupport` = Disabled (fine).
  - `ThroughputBoosterEnabled` = Disabled.
  - `ChannelWidth52` = Auto.
  - `RoamingPreferredBandType` = No Preference. Recommendation: prefer 5 GHz.
  - The power plan already sets WLAN to Höchstleistung.
- **Router WLAN** (unauthenticated `_ga` variables): **`_ga.isDFSEnabled='true'`**, **`_ga.isBandSteeringEnabled='true'`**, `_ga.isSplitSSIDEnabled='false'`. The TG6442 is dual-band 2.4/5 GHz 4×4 11ax, with no 6 GHz.
  - On DFS channels, radar detection forces a channel change with a 60 s CAC (channels 52–64) or **600 s** (120–128 weather radar) → **outages of 1–10 minutes**.
  - Recommendation: a fixed channel 36–48. Disable band steering, or use separate SSIDs, for gaming tests.
- **Background scans**: periodic RTT spikes (often around 60 s) while connected, caused by apps or location services that trigger scans. This is widely reported, but I found no authoritative source [uncertain]. A community remedy is `netsh wlan set autoconfig enabled=no interface="WLAN"`; it needs admin and disables auto-connect.
  - Detection: periodicity analysis of gateway RTT spikes while on WLAN (histogram of inter-spike intervals or autocorrelation).
- **Detection sources**:
  - WLAN-AutoConfig/Operational: 8001 connected; 8002 failed (field `ReasonCode`; 229396 = no connectable AP visible, 229378 = driver disconnected during association); 8003 disconnected (ReasonCode 5 = policy soft-disconnect); 11000–11005 association and security.
  - `netsh wlan show interfaces`: German output, CP850 bytes. Keys are `Status` (getrennt/verbunden), `SSID`, `BSSID`, `Funktyp`, `Band`, `Kanal`, `Empfangsrate (MBit/s)`, `Übertragungsrate (MBit/s)`, `Signal`, `Profil`.
  - Netwtw14 driver events 6062/7021 appear at each failover.

---

## 7. "EasyBox at 192.168.0.2": explanation for the user

- Vodafone **EasyBox** (802/803/804/805) are Vodafone **DSL** routers. Their web UI is at `http://easy.box` or `http://192.168.2.1` (Vodafone help pages for the 804/805).
- The user has **Vodafone cable**. The router is a **Vodafone Station Wi-Fi 6 = CommScope (ARRIS) TG6442** with firmware 01.05.069.14.EURO.PC20, at **`http://192.168.0.1`**. The user is `admin` and the password is on the device label. 192.168.0.2 has no device (ARP failure).
- Vodafone Station models listed by the VFKD wiki:
  - Arris TG3442DE: Vodafone Station
  - CommScope TG6442: Vodafone Station Wifi 6
  - Technicolor CGA4233DE: Vodafone Station
  - Technicolor CGA6444VF: Vodafone Station Wifi 6
  - Sercomm DG4278VF: Ultra Hub 7 Kabel, 1× 2.5G and 3× 1G
  - All of them have 4× Gigabit LAN except the Ultra Hub 7.
- **Security**: with the PC's public DNS (1.1.1.1 / 8.8.8.8), `easy.box` and `kabel.box` resolve to **public Internet servers** (45.77.92.157, 45.77.75.133, 207.246.78.75). **Never type router credentials there.** The app must only accept RFC 1918 or link-local router addresses and should default to `192.168.0.1`.
- `192.168.100.1` (the cable modem management IP) reaches the same router and serves the same login page.

German text:
„Ihr Router ist keine EasyBox, sondern eine Vodafone Station (TG6442) unter http://192.168.0.1. Die Adresse 192.168.0.2 ist nicht belegt. EasyBoxen sind Vodafone-DSL-Router (192.168.2.1). Achtung: ‚easy.box‘ führt bei Ihrer DNS-Einstellung ins Internet – dort nie das Router-Passwort eingeben.“

---

## 8. Router data endpoints for the TG6442 (reference implementations; not tested here because no login was allowed)

Sources: docsight `app/drivers/vodafone_station.py` (TG variant, "TG6442VF/TG3442DE") and arris-tg3442de-exporter. Both are MIT-licensed.

1. **Unauthenticated `GET /`** returns `_ga.*` JS vars: `modemConnectionStatus` ("DOCSIS Online"), `aftrAddress`, `wanIpv6`, `lastRebootReason`, `lockoutTimeLeft`, `docsisFailoverStatus`, `isDFSEnabled`, `isBandSteeringEnabled`. Use it as a health poll with HTTP RTT, at most every 1–5 minutes. Each GET mints a new `currentSessionId` and PHPSESSID; the router-side effect is unknown [uncertain].
2. **Login**:
   - `GET /`, then parse `currentSessionId`, `myIv` (16 hex = 8-byte CCM nonce) and `mySalt` (hex).
   - key = PBKDF2-SHA256(password, hex-decode(salt), 1000, 16 bytes).
   - AES-CCM with a 16-byte tag, AAD `loginPassword`, plaintext `{"Password": "<pw>", "Nonce": "<sessionId>"}`.
   - `POST /php/ajaxSet_Password.php` with JSON `{EncryptData, Name:"admin", AuthData:"loginPassword"}`.
   - Response: `p_status` is `"Lockout"`, `"Fail"`, `"AdminMatch"` (an existing admin session) or OK. Decrypt `encryptData` with AAD `nonce`; the first 32 chars are the csrfNonce.
   - Set headers `csrfNonce`, `X-Requested-With: XMLHttpRequest`, `Origin`, `Referer`.
   - `POST /php/ajaxSet_Session.php`.
   - Set the cookie `credential` from `base_95x.js` (`createCookie("credential","…")`).
   - In Node: `crypto.createCipheriv('aes-128-ccm', key, iv, {authTagLength:16})` with `setAAD(aad, {plaintextLength})`, and `crypto.pbkdf2Sync`.
3. **Data**:
   - `GET /php/status_status_data.php` returns `js_UptimeSinceReboot = 'd,hh,mm'` (uptime → reboot detection), `js_FWVersion`, `js_HWTypeVersion`, `js_SerialNumber`, `js_ipv4addr` and `js_ipv6addr`.
   - `GET /php/status_docsis_data.php` returns `json_dsData = [...]` and `json_usData = [...]`. Rows contain ChannelID, ChannelType (SC-QAM/OFDM/OFDMA), Frequency, Modulation, PowerLevel ("-1.2 dBmV/58.8 dBuV") and SNRLevel. There are no codeword counters in the TG payload [per docsight parser].
   - `GET /php/status_event_log_data.php?{%22eventLogRecord%22:{}}` returns JSON `{eventLog:[{Timestamp, Index, …}]}`. Deduplicate by Timestamp-Index.
   - `GET /php/overview_data.php` returns `json_lanAttachedDevice` with `Speed` ("1 Gbps"/"100 Mbps"), MAC, IPv4 and HostName (the router-side PC link speed), plus `json_primaryWlanAttachedDevice` with `LinkRate`.
4. **Logout**: `POST /php/logout.php`.
5. **Cautions**:
   - Only one admin session at a time ("AdminMatch"), so log out after each poll.
   - On `Fail`, never retry automatically. Check `_ga.lockoutTimeLeft` before logging in.
   - Poll every 5–10 minutes or more.
   - Store the password locally only (DPAPI or an environment variable), and only for `192.168.0.1`.
6. **Segment utilization**: docsight reads it only from FRITZ!Box (`/api/v0/monitor/segment/0`). The **Vodafone Station doesn't expose it** [per docsight], so congestion must be inferred from latency and throughput.

---

## 9. Implementation snippets for the probe engine

### 9.1 Persistent PowerShell poller for link state, speed and counters
This takes about 5–7 ms per iteration after warm-up [verified].
```powershell
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$names = @('Ethernet','WLAN')
while ($true) {
  $ifs = [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces() |
    Where-Object { $names -contains $_.Name } | ForEach-Object {
      $s = $_.GetIPStatistics()
      [ordered]@{ name=$_.Name; op="$($_.OperationalStatus)"; speed=$_.Speed;
        rxB=$s.BytesReceived; txB=$s.BytesSent; rxErr=$s.IncomingPacketsWithErrors;
        rxDisc=$s.IncomingPacketsDiscarded; txErr=$s.OutgoingPacketsWithErrors } }
  [Console]::Out.WriteLine((ConvertTo-Json -Compress -Depth 3 ([ordered]@{ t=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); ifs=@($ifs) })))
  [Console]::Out.Flush(); Start-Sleep -Milliseconds 1000
}
```
Start it with `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File poller.ps1`.

**WLAN `op` stays "Up" while soft-disconnected.** For WLAN, use `Get-CimInstance -Namespace root/StandardCimv2 -ClassName MSFT_NetAdapter` and read `MediaConnectState` (1 = connected, 2 = disconnected), `Speed`, `ReceiveLinkSpeed` and `FullDuplex` every 10–30 s, or rely on the WLAN events. For Ethernet, `op=Down` and `speed` are reliable.

`os.networkInterfaces()` lists the soft-disconnected WLAN with its IPs, so it is **not usable for WLAN state**.

### 9.2 Event log queries (wevtutil, XML output, language-independent, no admin needed) [verified]
```
wevtutil qe System /f:xml /q:"*[System[Provider[@Name='e2fexpress' or @Name='e2fnexpress' or @Name='e2f68'] and (EventID=27 or EventID=28 or EventID=29 or EventID=30 or EventID=32 or EventID=33 or EventID=34 or EventID=35 or EventID=36 or EventID=40 or EventID=41 or EventID=42 or EventID=50 or EventID=51 or EventID=52 or EventID=57) and (EventRecordID > LAST_ID)]]"

wevtutil qe System /f:xml /rd:true /c:200 /q:"*[System[(Provider[@Name='EventLog'] and (EventID=6005 or EventID=6006 or EventID=6008 or EventID=6013)) or (Provider[@Name='Microsoft-Windows-Kernel-Boot'] and EventID=27) or (Provider[@Name='Microsoft-Windows-Power-Troubleshooter'] and EventID=1) or (Provider[@Name='Microsoft-Windows-Kernel-Power'] and (EventID=41 or EventID=42 or EventID=107))]]"

wevtutil qe Microsoft-Windows-WLAN-AutoConfig/Operational /f:xml /q:"*[System[(EventID=8001 or EventID=8002 or EventID=8003)]]"

wevtutil qe Microsoft-Windows-NCSI/Operational /f:xml /q:"*[System[(EventID=4042)]]"
```
Fields:
- `TimeCreated/@SystemTime` (UTC ISO) and `EventRecordID` for incremental reads.
- Kernel-Boot 27: `BootType` (0 = cold, 1 = Fast Startup).
- WLAN: `SSID`, `ReasonCode`, `PHYType`.
- NCSI 4042: `InterfaceGuid`, `Family` (0 = v4, 1 = v6), `Capability` (0 = none, 1 = local, 2 = internet), `CapabilityChangeReason` (4 = ActiveHttpProbeSucceeded, 13 = PassivePacketHops, 14 = CapabilityReset).

Interface GUIDs: Ethernet `{178af0a6-93f5-4ace-ace2-2ecdf78704f2}`, WLAN `{1cdb0ef5-cb64-4b03-9b8d-3de53ab40921}`, WARP `{db484304-db04-6aa0-a33d-7236836b364d}`. Resolve these at runtime from `Get-NetAdapter | Select Name, InterfaceGuid`.

The ID-to-speed map: 32→1000, 33→100 (FD), 34→100 (HD), 35→10, 36→10 (HD), 57→2500.

### 9.3 Parsing ping.exe output (German, CP850) [verified]
A ping.exe spawned from Node writes **CP850** (the child codepage is 850, not 65001). For example, "Zeitüberschreitung" arrives with ü = 0x81. Decode with `latin1` and match only ASCII fragments, or use iconv-lite `cp850`.
```js
const ok      = /^(?:Antwort von|Reply from) ([0-9a-fA-F:.]+): .*?(?:Zeit|time)([=<])(\d+)ms/;  // IPv6 lines have no TTL
const unreach = /nicht erreichbar|unreachable/i;      // "Antwort von 192.168.0.192: Zielhost nicht erreichbar." = LOSS
const timeout = /berschreitung der Anforderung|timed out/i;
const general = /Allgemeiner Fehler|General failure|Fehler bei der/i;
const fragDF  = /fragmentiert werden|needs to be fragmented/i;
// success only if reply address == target; "Zeit<1ms" -> 0.5 ms; resolution is 1 ms
```

### 9.4 Egress interface detection without sending packets [verified]
```js
const s = dgram.createSocket('udp4');
s.connect(53, '1.1.1.1', () => { const local = s.address().address; s.close(); /* 192.168.0.192=Ethernet, 192.168.0.35=WLAN */ });
```
For IPv6, the same with `udp6` returns the temporary address. Run it every second together with the probes, and attach the egress IP to every probe sample.

For LAN-only probes such as SSDP, bind explicitly to the Ethernet IPv4 address, because the host is multi-homed.

### 9.5 Incident classification pseudo-code
```
onLinkDown(t0):
  if exists bootMarker within ±30s: type=BOOT_INIT; record relinkSpeed; return
  up        = next linkUp after t0 (event 32/33/57 or poller op=Up)
  inetBack  = first success of external probe (any egress) after t0  [or NCSI Family0 Capability2 on Ethernet]
  noAP      = WLAN 8002 ReasonCode 229396 in [t0, t0+240s]
  flaps     = linkDowns in [t0, t0+180s] (excluding t0)
  gwDown    = gateway lost on all egresses >= 60s
  if inetBack - t0 > 120s and (noAP or flaps>=2 or gwDown or routerPageDown): ROUTER_REBOOT_SUSPECT (merge later flaps into it)
  else: LAN_LINK_FLAP {outage=up-t0, relinkMbps, wlanFailover = WLAN 8001 within 5s}
daily KPIs: flapsPerDay, pct100MRelink(boot|session), outageSum, failovers, routerReboots, publicIPv4Changes
```

### 9.6 Ping baselines today (5 samples, around 14:50, link at 100M)
- Gateway: 1–2 ms
- 1.1.1.1: 16–30 ms. 2606:4700:4700::1111: 12–39 ms.
- 8.8.8.8: 15–18 ms. 2001:4860:4860::8888: 18–21 ms.
- 9.9.9.9: 22–36 ms. 2620:fe::fe: 22–38 ms.
- 92.79.214.92: 13–40 ms. 2a02:8101:3ff:ff89::3: 12–71 ms. AFTR: 15–22 ms.

---

## 10. Uncertainties (explicit)
- REV_03 = B3 is a community claim, not confirmed by an Intel document.
- The latest Intel I225 component versions (e2fn 2.1.5.12, legacy 1.1.4.45) come from Treexy. Exactly which version is inside Intel package 31.2.2 is not verified. Whether 2.1.x improves stability is unknown, and reports are mixed.
- Why no ID 40 (SmartSpeed) event appears despite 100M relinks is unknown.
- The router-reboot classification for 2026-10-08 18:29 is inferred, without router uptime or log. Confirm it with `js_UptimeSinceReboot` after login.
- AFTR port-block allocation is inferred from five samples. Vodafone PCP support is unknown.
- The TG6442 endpoints `status_event_log_data.php` and `overview_data.php` are proven on the TG3442DE (exporter). docsight claims the TG flow for the TG6442VF. Not tested here.
- The DOCSIS thresholds come from docsight's VFKD profile; I did not read the Vodafone PDF itself.
- The 60 s Wi-Fi background-scan spikes are folklore without an authoritative source.
- The legal assessment of latency and loss under § 58 TKG is not legal advice.
- The IPv4 traceroute hop 2 being the AFTR is plausible but unproven.

## 11. Sources
- Intel KB 000091005, I225-V intermittent disconnects on Win11: https://www.intel.com/content/www/us/en/support/articles/000091005/ethernet-products/gigabit-ethernet-controllers-up-to-2-5gbe.html
- Intel KB 000005593, advanced settings (Wait for Link, Gigabit Master Slave, ITR, Flow Control, Log Link State): https://www.intel.com/content/www/us/en/support/articles/000005593/ethernet-products.html
- Intel KB 000091032, Auto Negotiation for Gigabit: https://www.intel.com/content/www/us/en/support/articles/000091032/ethernet-products.html
- Intel user guide, Wait for Link: https://edc.intel.com/content/www/us/en/design/products/ethernet/adapters-and-devices-user-guide/wait-for-link ; Speed and Duplex: https://edc.intel.com/content/www/us/en/design/products/ethernet/adapters-and-devices-user-guide/setting-speed-and-duplex
- Intel Network Adapter Driver for Windows 11, 31.2.2 (2026-07-10): https://www.intel.com/content/www/us/en/download/727998/intel-network-adapter-driver-for-microsoft-windows-11.html
- Intel Complete Driver Pack 31.2.2: https://www.intel.com/content/www/us/en/download/15084/intel-ethernet-adapter-complete-driver-pack.html ; NetAdapter note for I225 on Win11: https://www.intel.com/content/www/us/en/content-details/727979/intel-ethernet-adapter-complete-driver-pack.html
- Treexy I225-V driver list: https://treexy.com/products/driver-fusion/database/network-adapters/intel/ethernet-controller-i225-v/
- Club386, Intel EEE workaround (2.1.3.3 / 1.1.4.38): https://www.club386.com/intel-issues-workaround-for-sporadic-2-5gbe-connection-drops-on-700-series-motherboards/
- Puget Systems, I225 IPG issue: https://www.pugetsystems.com/labs/support-hardware/Intel-i225-V-and-Z490-Chipset---Network-Connection-Issues-1981/
- Unraid, I225-V negotiation: https://forums.unraid.net/topic/129322-intel-i225-v-nic-speed-negotiation-issues/ ; TrueNAS downshift and cabling: https://forums.truenas.com/t/downshift-occured-from-negotiated-sped-1gpbs-to-actual-speed-100mbps-check-cabling/12016
- RFC 6333 (DS-Lite): https://www.rfc-editor.org/rfc/rfc6333.txt ; RFC 4787: https://www.rfc-editor.org/rfc/rfc4787.txt ; RFC 8489 (STUN) / RFC 5780 (NAT behaviour discovery); PCP over DS-Lite draft: https://www.ietf.org/archive/id/draft-dupont-pcp-dslite-05.txt
- Vodafone forum, Dual Stack: https://forum.vodafone.de/t5/Kabel-Tarife-Rechnung/Dual-Stack-statt-DS-Lite/td-p/3035049 and https://forum.vodafone.de/t5/Ger%C3%A4te/Dual-Stack-oder-eine-IPv4-Adresse/td-p/3215539 ; DS-Lite IPv4 problems: https://forum.vodafone.de/t5/Kabel-Tarife-Rechnung/IPv4-Websites-gehen-oft-nicht-DS-Lite-Probleme/td-p/2476295 ; Vodafone NAT type guide: https://www.vodafone.de/featured/article/vodafone-nat-typ-aendern-179527
- Xbox Teredo/IPv6 P2P (RIPE Labs): https://labs.ripe.net/Members/mirjam/usage-of-teredo-and-ipv6-for-p2p-on-windows-10-and-xbox-one ; Valve SDR: https://developer.valvesoftware.com/wiki/Steam_Datagram_Relay ; Steamworks ISteamNetworkingSockets: https://partner.steamgames.com/doc/api/ISteamNetworkingSockets
- Vodafone forum "Hoher Ping am Abend": https://forum.vodafone.de/t5/St%C3%B6rungen-im-Kabel-Netz/Hoher-Ping-am-Abend/td-p/3246069 ; ComputerBase segment overload / node split: https://www.computerbase.de/forum/threads/kabel-internet-ex-unitymedia-nrw-segment-ueberlastung-nodesplit.2167775/
- BNetzA Nachweisverfahren: https://www.bundesnetzagentur.de/DE/Vportal/TK/InternetTelefon/Internetgeschwindigkeit/artikel.html ; § 58 TKG: https://www.gesetze-im-internet.de/tkg_2021/__58.html
- docsight (MIT): https://github.com/itsDNNS/docsight (`app/drivers/vodafone_station.py`, `app/threshold_profiles.py`) ; arris-tg3442de-exporter: https://github.com/fsck-block/arris-tg3442de-exporter ; vodafone-station-cli: https://github.com/totev/vodafone-station-cli
- VFKD wiki, Vodafone provider devices: https://helpdesk.vodafonekabelforum.de/wiki/Providerger%C3%A4te_bei_Internetprodukten_(Vodafone_Kabel_Deutschland) ; CommScope TG6442 datasheet: https://ru.commscope.com/globalassets/digizuite/907415-tg6442-ds.pdf ; Vodafone forum TG6442 LAN/WLAN dropouts: https://forum.vodafone.de/t5/Ger%C3%A4te/Vodafone-Station-Problem-LAN-WLAN-Clients-disconnected-Zugriff/td-p/3089977
- Cloudflare STUN/TURN: https://developers.cloudflare.com/realtime/turn/ ; always-online-stun: https://github.com/pradt2/always-online-stun
- Cloudflare One client, split tunnels: https://developers.cloudflare.com/cloudflare-one/team-and-resources/devices/cloudflare-one-client/configure/route-traffic/split-tunnels/ ; client architecture: https://developers.cloudflare.com/cloudflare-one/team-and-resources/devices/cloudflare-one-client/configure/route-traffic/client-architecture/ ; VPN / traffic-only mode: https://developers.cloudflare.com/cloudflare-one/team-and-resources/devices/cloudflare-one-client/deployment/vpn ; Windows release notes: https://developers.cloudflare.com/changelog/post/2025-10-07-warp-windows-ga/
- DFS behaviour: https://www.cisco.com/c/en/us/support/docs/wireless-mobility/80211/213882-radar-detection-in-dynamic-frequency-sel.html ; https://support.keenetic.com/peak/kn-2710/en/43659-dfs.html ; AX211 ping fluctuation: https://community.intel.com/t5/Wireless/AX211-Ping-Fluctuations-and-Spikes-Issue/m-p/1465889
- Windows "Minimize simultaneous connections" (fMinimizeConnections): https://www.stigviewer.com/stigs/microsoft_windows_10/2025-02-25/finding/V-220806 ; https://winaero.com/minimize-number-of-simultaneous-connections-to-internet-in-windows-10
- EasyBox: https://www.vodafone.de/hilfe/router/easybox-805.html ; https://www.vodafone.de/hilfe/easybox/804.html ; Vodafone router IP (GIGA): https://www.giga.de/tech/vodafone-router-ip-zugriff-und-login-oberflaeche--01J5QNHE2AF42Y9FKJEYRYCKTD
