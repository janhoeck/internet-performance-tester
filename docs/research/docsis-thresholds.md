# DOCSIS 3.0/3.1 thresholds & error interpretation – Vodafone Kabel Deutschland / ARRIS TG6442 ("Vodafone Station Wi‑Fi 6")

Research date: 2026-10-09 · Scope: automatic rating ("gut / grenzwertig / kritisch") of the cable line values the TG6442 web UI exposes, plus event-log interpretation, causes, evidence and time-series evaluation for the internet-performance-tester app.

Confidence legend used everywhere:
- **[H]** normative/official: CableLabs DOCSIS spec text, Vodafone pNTP interface spec, or the verbatim Vodafone (VFKD) service table.
- **[M]** consistent community practice (Vodafone-community SuperUsers, vodafonekabelforum Co-Admin), established open-source tools, or arithmetic derived from [H].
- **[L]** a single forum claim, or my own synthesis/heuristic. Treat as tunable defaults.

---

## 0. Key decisions (TL;DR)

1. **Primary scale = Vodafone Kabel Deutschland service table of 17.06.2018** ("20180617_Pegelwerte.pdf", transcribed by forum Co-Admin DerSarde, vodafonekabelforum FAQ t=39941). It uses 4 grades: *regel-/vorgabenkonform, tolerierte Abweichung, Beseitigung binnen Monatsfrist, sofortige Beseitigung*. Its "konform" bands match the official **Vodafone pNTP Interface Specification** nominal values exactly (DS 256QAM 56–73 dBµV, 64QAM 50–67 dBµV, MER ≥ 33 / ≥ 27 dB), so it's **[H]** for SC-QAM. A SuperUser on 05.01.2026 confirmed it's still the reference, with the caveat that its DOCSIS 3.1 values were ideal values ("Idealwerte") from 2018.
2. **Store 4 grades, show 3 UI levels.** konform → **gut**, toleriert → **gut** (with a "toleriert" hint), Monatsfrist → **grenzwertig**, sofort → **kritisch**. vodafone-station-cli maps them the same way: tolerated shows green, "fix within one month" yellow, "fix immediately" red.
3. **The TG6442 exposes no codeword counters** (corrected or uncorrectable), no T3/T4 counters and no pre-eq data. Confirmed in DOCSight PR #329: "Modems without DOCSIS error counter support (e.g. Vodafone Station…)". The UI must show **"nicht verfügbar"**, never "0 % Fehler". The proxies for FEC trouble are event-log CM-STATUS codes 2/16/20/21, lock status, OFDM profile downgrades and uptime resets.
4. **OFDM (DS 3.1) MER has no binding Vodafone value.** Use a synthesized scale (gut ≥ 40, toleriert 38–40, grenzwertig 35–38, kritisch < 35 dB) **[L/M]**. Also show a "supportable modulation" helper built from the DOCSIS 3.1 PHY CNR table **[H]**. For OFDM power, use the VFKD 1024QAM row. It agrees with the PHY minimum of −6 dBmV for 4096QAM **[M]**.
5. **The TG6442's OFDMA upstream power display is unreliable or ambiguous.** Forum examples show it both ~6–8 dB below SC-QAM (as if P1.6) and ~7 dB above (as if total power over 35 MHz). Normalize to a 6.4 MHz equivalent with an auto-detect heuristic plus a manual override, then rate on the VFKD DOCSIS 3.1 upstream scale **[L/M]**. Treat the displayed OFDMA *modulation* as informational only: a forum claim says it shows "16QAM" because of a firmware bug.
6. **Upstream headroom check (derived, [M]):** with OFDMA active, a D3.1 modem's SC-QAM channels top out at ~55 dBmV (Pmax 65 dBmV total spread at equal PSD). SC-QAM ≥ ~54 dBmV with OFDMA active means the modem is at its power limit, so treat it as kritisch even before the table says so.
7. **Event log:** classify by regex on the normalized message text (catalogue in §11). The OSSI priority (Critical/Error/Warning/Notice) is not enough on its own. T3 *clusters*, "Retries exhausted", T4, SYNC loss, MDD timeouts, partial service and CM-STATUS 2/6/7/16/20/21 are the signals that explain ping spikes and packet loss.
8. **Time series:** key channels by (direction, type, frequency), not channel ID. Keep a rolling 7-day baseline per channel and use detectors for steps, swings, outliers and diurnal patterns. Correlate everything with ping/loss and with the PC's LAN link events (the e2fexpress link drops found by scouting are a strong competing root cause).
9. **Polling:** DOCSIS page every 5 min (one scrape takes ~5 s), event log every 15 min (~12 s with logs, per the exporter README), unauthenticated start page (`_ga.modemConnectionStatus`) every 60 s for outage detection. Keep one session. Never auto-retry a failed login (lockout).

---

## 1. Sources and how they relate

| Source | What it gives | Conf. |
|---|---|---|
| Vodafone **pNTP Interface Specification** (PDF named v1.06; title page says "Version 1.05, 13.09.2021") | Official RF characteristics at the customer outlet: DS level/MER per modulation, OFDM MER, US level range, channel counts, tilt | [H] |
| **VFKD service table 17.06.2018** (vodafonekabelforum FAQ t=39941, Co-Admin DerSarde, 17.11.2018) | 4-grade ranges for DS power (64/256/1024QAM), DS MSE/SNR, US power (EuroDOCSIS 3.0 and DOCSIS 3.1) | [H] verbatim, [M] for D3.1 parts |
| CableLabs **CM-SP-PHYv3.0-I09** (EuroDOCSIS Annex B) | CM DS input range, BER/CER requirements, US Pmax by channel count | [H] |
| CableLabs **CM-SP-PHYv3.1-I08** | OFDM level range, CNR per QAM, minimum P6AVG per QAM, US Pmax 65 dBmV, P1.6 definitions | [H] |
| CableLabs **CM-SP-MULPIv3.1-I10** | Timers T1–T6, retries, Lost SYNC/MDD, CM-STATUS event type codes table 10-4 | [H] |
| CableLabs **CM-SP-OSSIv3.0-I30** | Event IDs, texts and CM priorities (Annex D); priority semantics; RangingState enum | [H] |
| Vodafone community threads 2019–2026 + Vodafone community blog (24.07.2026) | Practical interpretation, OFDMA quirks, what moderators ask for, return-path impairment | [M]/[L] |
| DOCSight, vodafone-station-cli, arris-tg3442de-exporter (open source) | TG data formats and endpoints, threshold implementations, event-log endpoint | [M] |

Local copies (scratch): `research/docsis/dl_pntp/pntp_v106.{pdf,txt}`, `dl_phy/phy30_i09.pdf`, `dl_phy/phy31_i08.pdf`, `dl_mulpi/mulpi31_i10.pdf`, `dl_ossi/ossi30_i30.pdf`, `dl_forum/*.html`, `src/docsight/*`, `src/vsc/*`, `src/ate/*`.

---

## 2. What the TG6442 delivers (and what it doesn't)

### 2.1 Endpoints (from DOCSight driver, vodafone-station-cli, arris-tg3442de-exporter; tested there on TG3442DE/TG6442VF; firmware here is 01.05.069.14 → **verify**)
| Purpose | Request | Auth | Notes |
|---|---|---|---|
| Login page / crypto vars | `GET /` | no | `currentSessionId`, `myIv`, `mySalt` (scouting verified) |
| Session init (some FW) | `POST /php/ajaxSet_Session.php` | after login | DOCSight does this after login |
| Credential cookie | `GET /base_95x.js` → regex `createCookie\(\s*"credential"\s*,\s*["'](.+?)["']` → cookie `credential=<value>` | – | Required by TG for data requests (DOCSight, vsc) |
| **DOCSIS status** | `GET /php/status_docsis_data.php` with headers `csrfNonce`, `X-Requested-With: XMLHttpRequest`, `Referer: http://192.168.0.1/?status_docsis&mid=StatusDocsis` | yes | HTML with JS vars `js_dsNums`, `js_usNums`, `js_ofdmNums`, `json_dsData = [...]`, `json_usData = [...]` |
| **Event log** | `GET /php/status_event_log_data.php?{%22eventLogRecord%22:{}}` | yes | JSON `{"eventLog":[{"Timestamp":…,"Index":…, …}]}`. The other field names are **unknown**, so log the first response. The exporter README says scraping the event log "takes a bit too long to be scraped every minute" |
| Device status | `GET /php/status_status_data.php` | yes | `js_FWVersion`, `js_HWTypeVersion`, `js_UptimeSinceReboot = 'D,H,M'`, `js_ipv4addr`, `js_ipv6addr` |
| Start page | `GET /` (also `/?status_status`) | **no** | `_ga.modemConnectionStatus` ('DOCSIS Online'/'DOCSIS Offline'), `_ga.lastRebootReason` (scouting verified) |
| Logout | `POST /php/logout.php` | – | Do this on shutdown |

The page menu ids (from local `index.html`) are `status_docsis` (StatusDocsis) and `status_event_log` (StatusEventLog), which fits the endpoint names above.

### 2.2 Data format of `json_dsData` / `json_usData` [M]
Real TG3442 sample (vodafone-station-cli fixture):
```json
{"ChannelType":"OFDM","Modulation":"1024QAM","Frequency":"151~324","ChannelID":"33","PowerLevel":"-3.5/56.5","SNRLevel":"40","LockStatus":"Locked"}
{"ChannelType":"SC-QAM","Frequency":602,"PowerLevel":"-3/57","SNRLevel":38.60000000000000142,"Modulation":"256QAM","ChannelID":"5","LockStatus":"Locked"}
{"Frequency":36,"PowerLevel":"49/109","ChannelType":"SC-QAM","ChannelID":"4","Modulation":"64QAM","LockStatus":"ACTIVE"}   // upstream
```
- `PowerLevel` is `"dBmV/dBµV"` (sometimes `"-1.5 dBmV/58.5 dBuV"`, sometimes a bare number). Take the first float before `/`.
- `SNRLevel` is a number for SC-QAM and a string for OFDM (DOCSight issue #835). Round to 0.1 because of float noise.
- `Frequency` for SC-QAM is MHz (some samples are Hz: if > 1e5 divide by 1e6). OFDM/OFDMA use `"start~end"` in MHz.
- Lock values: DS `"Locked"`; US `"ACTIVE"` or `"SUCCESS"` (exporter treats both as OK). The German UI shows DS "Lock Status: JA/NEIN" and US "Ranging Status: Erfolgreich".
- Unlocked channels can appear as a row with ChannelID `0` and no frequency (forum example "0 SC-QAM 64QAM NEIN").
- German UI column names (forum post 06.08.2026, Vodafone Station): DS "Kanal ID | Kanaltyp | Frequenz (MHz) | Modulation | Empf. Signalstärke (dBmV/dBµV) | SNR/MER (dB) | Lock Status"; US "… | Send. Signalstärke (dBmV/dBµV) | Ranging Status".
- Typical Vodafone layout (same post): DS SC-QAM IDs 1–17 at 114–690 MHz in 256QAM, IDs 65–79 at 698–810 MHz in 64QAM (Vodafone deliberately runs 64QAM in the upper band), OFDM ID 193 at "135~324" MHz, US SC-QAM 4× at 31/37/45/51 MHz in 64QAM, OFDMA ID 41 at "29~64" MHz.

### 2.3 Not available on the TG6442
- Corrected/uncorrectable codewords: DOCSight #329 says the Vodafone Station has no error counters, and both the TG parsers and the exporter only read power, SNR and lock.
- T3/T4 counters, pre-equalizer taps, per-subcarrier RxMER, and segment utilization (DOCSight reads segment load only from FRITZ!Box `/api/v0/monitor/segment/0`).

---

## 3. Rating model

```
grade ∈ {konform, toleriert, monatsfrist, sofort, unbekannt}
UI:     konform|toleriert → "gut" (toleriert = small badge/tooltip)
        monatsfrist       → "grenzwertig"
        sofort            → "kritisch"
```
- **Boundary semantics** (the VFKD table uses 0.1 steps, e.g. "-7,9 bis -6,0 → Monatsfrist"): for symmetric scales with breakpoints b0…b5, `v ≤ b0 → sofort; ≤ b1 → monatsfrist; ≤ b2 → toleriert; ≤ b3 → konform; ≤ b4 → toleriert; ≤ b5 → monatsfrist; else sofort`. For lower-bound scales (SNR) a0…a2: `v ≤ a0 → sofort; ≤ a1 → monatsfrist; ≤ a2 → toleriert; else konform`.
- **Channel grade** = worst of power, SNR/MER, lock and modulation grades. **Direction/family grade** = worst channel, but also report counts per grade. One bad channel matters, especially an outlier.
- **Hysteresis for state changes and alerts** [L]: a grade change needs 2 consecutive polls, or a margin of 0.5 dB past the boundary, before it counts as an event. Keep raw grades for statistics.
- **"Anteil kritisch"** = share of samples per day in each grade. This is better evidence than single snapshots.

---

## 4. Downstream SC-QAM power level

### 4.1 Rating table (VFKD 2018) [H]
| Modulation | sofort | Monatsfrist | toleriert | **konform** | toleriert | Monatsfrist | sofort |
|---|---|---|---|---|---|---|---|
| **256QAM** dBmV | ≤ −8.0 | −7.9…−6.0 | −5.9…−4.0 | **−3.9…+13.0** | +13.1…+18.0 | +18.1…+20.0 | > +20.0 |
| 256QAM dBµV | ≤ 52 | 52.1–54 | 54.1–56 | **56.1–73** | 73.1–78 | 78.1–80 | > 80 |
| **64QAM** dBmV | ≤ −14.0 | −13.9…−12.0 | −11.9…−10.0 | **−9.9…+7.0** | +7.1…+12.0 | +12.1…+14.0 | > +14.0 |
| 64QAM dBµV | ≤ 46 | 46.1–48 | 48.1–50 | **50.1–67** | 67.1–72 | 72.1–74 | > 74 |
| **1024QAM** (D3.1) dBmV | ≤ −6.0 | −5.9…−4.0 | −3.9…−2.0 | **−1.9…+15.0** | +15.1…+20.0 | +20.1…+22.0 | > +22.0 |

dBµV = dBmV + 60 (75 Ω). Breakpoints: 256QAM `[-8,-6,-4,13,18,20]`, 64QAM `[-14,-12,-10,7,12,14]`, 1024QAM `[-6,-4,-2,15,20,22]`.

### 4.2 Cross-checks
- pNTP nominal at the outlet: 64QAM **50–67 dBµV**, 256QAM **56–73 dBµV** (type 1/2 networks), absolute maximum 76 dBµV (+16 dBmV). Type 3 networks: 64QAM 47–67 dBµV, 256QAM 54–74 dBµV. Total input power < 93 dBµV (type 3) or abs ≤ 94 dBµV (type 1). [H] (≥/≤ signs are lost in PDF extraction and were reconstructed from context.)
- EuroDOCSIS 3.0 CM operating range per channel: **64QAM −17…+13 dBmV, 256QAM −13…+17 dBmV**; total input power < 33 dBmV (PHYv3.0 Table B-16). Outside this range the modem may fail to lock. [H]
- Vodafone sends 64QAM channels ~6 dB lower than 256QAM, which is why the 64QAM scale is 6 dB lower. Never flag 64QAM in the 698–862 MHz range as a "degradation". [H/M]

### 4.3 Extra plausibility checks (derived) [M]
- **Adjacent-channel level difference** > 6 dB is abnormal. pNTP: "carrier level backoff between adjacent SC-QAM channels ≤ 6 dB" (type 1/2). Grade it **grenzwertig** and point to a suck-out/reflection or a filter.
- **Tilt** = level at the highest-frequency SC-QAM minus level at the lowest, normalized for the 6 dB 64QAM offset. If |tilt| > 10 dB, grade **grenzwertig** (pNTP: 122/826 MHz tilt abs ≤ 10 dB for type 2, nominal ≤ 12 dB for type 3, ≤ 16 dB "full range" for type 1).
- **Power variation**: a daily range > 3 dB on a channel, or a step ≥ 2 dB on most channels between polls, is notable (see §14).

---

## 5. Downstream SC-QAM SNR/MER

### 5.1 Rating table (VFKD 2018; the FRITZ!Box shows MSE as a negative number, the TG shows positive dB) [H]
| Modulation | sofort | Monatsfrist | toleriert | **konform** |
|---|---|---|---|---|
| **256QAM** | ≤ 30.0 | 30.1–32.0 | 32.1–33.0 | **> 33.0 dB** |
| **64QAM** | ≤ 24.0 | 24.1–26.0 | 26.1–27.0 | **> 27.0 dB** |
| **1024QAM** (D3.1) | ≤ 36.0 | 36.1–38.0 | 38.1–39.0 | **> 39.0 dB** |

Breakpoints: 256QAM `[30,32,33]`, 64QAM `[24,26,27]`, 1024QAM `[36,38,39]`.

### 5.2 Cross-checks [H]
- pNTP MER nominal: 64QAM ≥ 27.1 dB, 256QAM ≥ 32.7 dB (type 1) or ≥ 33.1 dB (type 2) or ≥ 32 dB (type 3). Absolute minimum during operation: 64QAM ≥ 23 dB, 256QAM ≥ 29 dB. Pre-FEC BER nominal < 1e-6 (type 3: < 1e-7 for 64QAM), absolute 1e-4.
- EuroDOCSIS CM must reach post-FEC BER ≤ 1e-8 / CER ≤ 9×10⁻⁷ at Es/No ≥ 25.5 dB (64QAM). For 256QAM: ≥ 34.5 dB at input −13…−6 dBmV, ≥ 31.5 dB at −6…+17 dBmV. At low DS power the MER margin therefore shrinks.
- Practice [M]: SuperUser Kurtler (05.01.2026) says that at 24 dB (64QAM) or 30 dB (256QAM) "läuft … gar nichts mehr störungsfrei". So "sofort" really is the failure floor, and Monatsfrist values already cause intermittent errors.

### 5.3 Outlier and ingress rule (derived) [M]
- For each poll, compute the median SNR of all locked channels with the same modulation. A channel ≥ **3 dB below** that median gets an **"Einstrahlungsverdacht"** flag (grenzwertig even if the table says toleriert). Example from the forum post: 770 MHz at 26.9 dB while its neighbours were ~34 dB. That channel is "toleriert" on the table, but it's an obvious outlier.
- Map the frequency to German mobile bands [H, 3GPP]: **Band 28 (700 MHz)** DL 758–788, UL 703–733 MHz; **Band 20 (800 MHz)** DL 791–821, UL 832–862 MHz; **Band 8 (900 MHz)** UL 880–915, DL 925–960 (relevant for 1 GHz+ OFDM). Phones transmitting (UL) close to poorly shielded in-house coax are the classic source. If the dip depends on time of day, ingress is very likely.

---

## 6. Downstream OFDM (DOCSIS 3.1)

### 6.1 Power
- Use the **VFKD 1024QAM row** (§4.1) for OFDM channels whatever profile modulation is shown. **[M]**
- PHYv3.1 Table 7-40: equivalent PSD range **−15…+15 dBmV per 6 MHz**; total input < 40 dBmV. **[H]**
- PHYv3.1 Table 7-41 "Min P6AVG": **4096QAM ≥ −6 dBmV, 2048QAM ≥ −9, 1024QAM/512QAM ≥ −12, ≤ 256QAM ≥ −15 dBmV**. **[H]** The VFKD 1024QAM "sofort" boundary (≤ −6.0) coincides with the 4096QAM minimum.
- The TG OFDM power looks PSD-normalized (forum example: OFDM −1.7 dBmV next to SC-QAM ~0 dBmV), so it's comparable to SC-QAM. Whether it's per 6 or 8 MHz is **unknown**; the difference is ≤ 1.25 dB. [L]

### 6.2 MER (TG "SNR/MER" = average RxMER)
Inputs that disagree with each other:
| Source | Values |
|---|---|
| PHYv3.1 Table 7-41 CNR for PER ≤ 1e-6 (1500 B packets), up to 1 GHz / 1–1.2 GHz | 4096QAM **41.0/41.5**, 2048 **37.0/37.5**, 1024 **34.0**, 512 **30.5**, 256 **27.0**, 128 **24.0**, 64 **21.0**, 16 **15.0** dB [H] |
| pNTP (type 2) "OFDM MER (256QAM)" | nominal ≥ 27 dB, absolute ≥ 24.5 dB (TBD) [H] |
| VFKD 2018 1024QAM row | konform > 39, toleriert 38.1–39, Monatsfrist 36.1–38, sofort ≤ 36 [H, but called "Idealwerte" by DerSarde] |
| DerSarde (05.01.2026) | "In der Praxis funktioniert der OFDM auch mit niedrigeren SNR-Werten"; ex-Unitymedia region reportedly uses 35 dB as its OFDM SNR limit [L] |
| Unitymedia forum host (2019) | "MER … im OFDM-Bereich ab 774 MHz minimal 28 dB" [L] |
| DOCSight (VFKD profile) | 4096QAM good ≥ 40, warn ≥ 38, crit ≥ 36; aggregate OFDM good ≥ 27 [M] |

**Recommended app scale for OFDM MER [L/M]:** `gut ≥ 40 · toleriert 38–40 · grenzwertig 35–38 · kritisch < 35` (breakpoints `[35,38,40]`), shown next to:
- **Supportable modulation** (PHY Table 7-41; use the 1–1.2 GHz column if the channel's upper edge is > 1000 MHz): MER ≥ 41 → 4096; ≥ 37 → 2048; ≥ 34 → 1024; ≥ 30.5 → 512; ≥ 27 → 256; ≥ 24 → 128; ≥ 21 → 64; else ≤ 16QAM.
- **Profile status**: the TG shows the current profile modulation (4096QAM normal; forum TG6442 user saw 256 ↔ 1024 ↔ 4096 switching and "Unsupported"). Grade a displayed modulation below 4096QAM as **grenzwertig** (fewer Mbit/s; CMTS profile downgrade). Grade "Unsupported", unlocked or missing as **kritisch**.

### 6.3 Forum evidence that OFDM profile failures cause loss [M]
2019 (Unitymedia): the log flooded with `CM-STATUS message sent. Event Type Code: 16; Chan ID: 32; … OFDM/OFDMA Profile ID: 2` (16 = DS OFDM profile failure) and 24 (recovery). The user saw "alle paar Minuten minimal Packetloss" and uncorrectables on OFDM. The problems disappeared at night when OFDM power rose above +6 dBmV.

---

## 7. Upstream SC-QAM transmit power

### 7.1 Rating table (VFKD 2018, EuroDOCSIS 3.0) [H]
| sofort | Monatsfrist | toleriert | **konform** | toleriert | Monatsfrist | sofort |
|---|---|---|---|---|---|---|
| ≤ 35.0 dBmV (≤ 95 dBµV) | 35.1–37.0 | 37.1–41.0 | **41.1–47.0 dBmV (101.1–107 dBµV)** | 47.1–51.0 | 51.1–53.0 | > 53.0 (> 113 dBµV) |

Breakpoints `[35,37,41,47,51,53]`. pNTP cross-check: "single upstream level range" nominal **98.1–110 dBµV (38.1–50 dBmV)** at installation, absolute max **≤ 114 dBµV (54 dBmV)**, reference bandwidth 3.2 MHz; usable US range 15–65 MHz, with 3.2 and 6.4 MHz channels. [H]

### 7.2 Spec maximum transmit power (why "too high" matters) [H]
EuroDOCSIS 3.0 PHY Tables B-4…B-6, per channel, TDMA/ATDMA (S-CDMA in brackets):
| Channels in TCS | QPSK | 8/16QAM | 32/64QAM |
|---|---|---|---|
| 1 | 61 (56) | 58 (56) | **57** (56) |
| 2 | 58 (53) | 55 (53) | **54** (53) |
| 3–4 | 55 (53) | 52 (53) | **51** (53) |
P_min = 17/20/23 dBmV for 1.28/2.56/5.12 MSym/s. A CM may advertise an "Extended Upstream Transmit Power" capability of 51.25–61 dBmV.

DOCSIS 3.1 CM (the TG6442): **P_max ≥ 65 dBmV total**. Per-channel ceiling `P1.6hi = Pmax − 10·log10(Neq)`, where Neq = Σ(channel bandwidth)/1.6 MHz. A 6.4 MHz SC-QAM channel has actual power P1.6 + 6 dB. The CMTS caps P1.6hi at 53.2 dBmV (+ Pmax − 65) if the modulated spectrum is ≤ 24 MHz. Resulting per-channel SC-QAM maximum (6.4 MHz channels, Pmax 65) [M, derived]:
| Config | Neq | P1.6hi | Max SC-QAM channel power |
|---|---|---|---|
| 4× SC-QAM, no OFDMA | 16 | 53.0 | ≈ **59 dBmV** |
| 5× SC-QAM, no OFDMA | 20 | 52.0 | ≈ **58 dBmV** |
| 4× SC-QAM + OFDMA 35 MHz (29–64) | 37.9 | 49.2 | ≈ **55.2 dBmV** |
| 5× SC-QAM + OFDMA 35 MHz | 41.9 | 48.8 | ≈ **54.8 dBmV** |

Forum example (06.08.2026, Vodafone Station): SC-QAM 55/55/54.5/51 dBmV with OFDMA active, i.e. three channels sitting exactly at the computed ceiling. The SuperUser verdict was "alle einen zu hohen Signalpegel" and a technician was ordered.

### 7.3 Headroom metric (derived) [M]
`headroom = P1.6hi − max_i(P1.6_i)` with SC-QAM `P1.6 = P_disp − 10·log10(bw/1.6)` (assume bw = 6.4 MHz unless known) and OFDMA `P1.6 = P6.4eq − 6.02`. Grade: **≥ 6 dB gut, 3–6 dB grenzwertig, < 3 dB kritisch** [L thresholds]. If the modem has no headroom left, rising attenuation (temperature, evening) leads to T3 timeouts, partial service (CMTS drops a channel) or lower modulation.

### 7.4 Interpretation [M]
- **Too high** (> 47 tolerated, > 51 Monatsfrist, > 53 sofort): too much attenuation between modem and CMTS on the return path. Typical causes: long or poor cable, too many splitters, a misadjusted or defective house amplifier return path, corroded connectors. Symptoms: T3 timeouts, upload problems, partial service.
- **Too low** (≤ 41 tolerated, ≤ 37 Monatsfrist, ≤ 35 sofort): too little attenuation or too much return-path gain. Noise funneling and overdrive are possible, and Vodafone flags it too.
- **Upward drift over days** means increasing attenuation (water/corrosion in connectors, failing amplifier).

---

## 8. Upstream OFDMA (DOCSIS 3.1) power

### 8.1 Rating table (VFKD 2018, "DOCSIS 3.1") [H text, M applicability]
| sofort | Monatsfrist | toleriert | **konform** | toleriert | Monatsfrist | sofort |
|---|---|---|---|---|---|---|
| ≤ 38.0 dBmV | 38.1–40.0 | 40.1–44.0 | **44.1–47.0** | 47.1–48.0 | 48.1–50.0 | > 50.0 |
Breakpoints `[38,40,44,47,48,50]`. The FAQ says: "Falls bereits ein Upstreamkanal mit DOCSIS 3.1 genutzt wird, ist der Wert … noch etwas strenger zu beurteilen" and "FRITZ!Boxen zeigen den Wert … beim DOCSIS 3.1-Upstream um 6 dB geringer an … Skala … um 6 dB vermindert". Community practice (SuperUser Sigi-DD, 2025) applies this scale to the **OFDMA channel**, e.g. "52,8 dBmV … darf eigentlich nur im Bereich von 40,1 bis 48,0 dBmV liegen". SC-QAM channels keep the D3.0 scale. Follow that convention. The FAQ wording is ambiguous.

### 8.2 What the TG6442 displays is ambiguous [L]
- PHYv3.1: OFDMA reported power = **P1.6r_n** (normalized to 1.6 MHz), so a "true" 6.4 MHz equivalent is +6 dB. That's why FRITZ!Boxes read 6 dB low (DerSarde confirmed with a 6690 on 05.01.2026).
- Vodafone Station forum examples conflict: **62/122 dBmV** for OFDMA 29~64 MHz next to SC-QAM 51–55 (higher, consistent with *total* power: 49 dBmV P1.6 + 10·log10(35/1.6) ≈ 62). Another table shows **43.3** next to SC-QAM 51.5 (lower, consistent with P1.6). A SuperUser claims Vodafone Station OFDMA values are "immer 6 dB unter" SC-QAM.
- **Recommendation:** normalize to a 6.4 MHz equivalent:
  - candidates: `P1.6 → P+6.02`, `total → P − 10·log10(BW_MHz/6.4)` (BW from "start~end"), `already P6.4 → P`;
  - auto-pick the candidate closest to the median SC-QAM power. The equal-PSD assumption is from PHY §7.4.12.2 ("distributed … based on equal power spectral density"). Use confidence "medium" if within ±3 dB, else "low";
  - persist the chosen mode and let the user override it in settings. Show the raw value and the normalized value side by side.
- Displayed OFDMA **modulation** (e.g. "16QAM"/"256QAM") is informational only. Kurtler (Jan 2026) calls "16QAM" a Vodafone Station firmware bug; Sigi-DD says it can be real ingress around 30 MHz. A *change* relative to baseline is still worth logging.

---

## 9. Status checks

### 9.1 Lock and ranging [H/M]
- DS OK iff `LockStatus ∈ {Locked, JA, yes, true, 1}` (case-insensitive); otherwise **kritisch** for that channel.
- US OK iff `∈ {ACTIVE, SUCCESS, Erfolgreich, 1}`. DOCSIS RangingState enum (DOCS-IF3-MIB): `other(1) aborted(2) retriesExceeded(3) success(4) continue(5) timeoutT4(6)`. "continue" is transient, so **grenzwertig**. aborted, retriesExceeded and timeoutT4 are **kritisch**. Unknown strings: grenzwertig, and log the raw value.

### 9.2 Channel counts / partial service [H for counts, M for logic]
- pNTP nominal counts: DS SC-QAM min 16 (type 1), 20 (type 2) or 32 (type 3), max 32. DS OFDM ≥ 1 (types 2/3), max 2. US SC-QAM min 4, max 4 (type 1) or 5 (types 2/3). US OFDMA ≥ 1 (types 2/3), max 2.
- **Baseline** = the maximum number of locked channels per family seen in the last 7 days (or the first 24 h).
- Fewer locked channels than baseline, or rows with Lock NEIN, means **partial service**. Grade **grenzwertig** while ≤ 2 polls, **kritisch** if it lasts ≥ 15 min or affects US or OFDM. Log start and end times. Also look for "RCS Partial Service"/"TCS Partial Service" events (§11).

### 9.3 Modulation [M]
- DS SC-QAM: 256QAM and 64QAM are both normal (Vodafone design). A switch away from the channel's baseline modulation is a finding.
- US SC-QAM: 64QAM = gut, 32QAM = info/grenzwertig (low-frequency channels can be configured that way; compare to baseline), 16QAM = grenzwertig, QPSK/8QAM = kritisch. DOCSight: ≤ 4 critical, ≤ 16 warning.
- OFDM DS: see §6.2. OFDMA: informational only (§8.2).

---

## 10. Corrected vs uncorrectable codewords (generic; NOT available on TG6442)

Implement only if another modem or firmware delivers counters. Otherwise show "nicht verfügbar".
- **Spec formula** (EuroDOCSIS PHYv3.0 B.6.3.3.1.1) [H]: `CER = ΔEu / (ΔEu + ΔEc + ΔC)`, where Eu = uncorrectable, Ec = corrected, C = unerrored codewords, as interval deltas. CM requirement: CER ≤ 9×10⁻⁷ at the specified CNR. DOCSIS 3.1 downstream target: post-FEC **PER ≤ 1e-6** (1500-byte packets).
- **Interval deltas**: compute per poll interval (5 min) and per hour/day. If any counter decreases, treat it as a reset (reboot/re-registration): start a new baseline and don't create a negative delta. 32-bit counters can wrap: if prev > 3.9e9 and cur < prev, use `cur + 2^32 − prev`. DOCSight tests "counter unwrap".
- **If only Ec/Eu are shown** (FRITZ!Box style), estimate the total. EuroDOCSIS (ITU-T J.83 Annex A, RS(204,188)) at 6.952 MSym/s carries ≈ **34,080 codewords/s per 256QAM channel** and ≈ 25,560 per 64QAM channel [M, arithmetic]. So `CER ≈ ΔEu / (Δt·rate)`. A 1500-byte packet spans ~8 codewords, so PER ≈ 8·CER.
- **Operational thresholds** [L/M]: CER < 1e-5 → gut; 1e-5…1e-3 → grenzwertig; > 1e-3 (≈ ≥ 1 % packet loss) → kritisch. Volpe Firm: "not to exceed 1 % uncorrectable codeword errors" for VoIP, and "a correctable error rate of over 5 % seems high". DOCSight uses `uncorr/(corr+uncorr)` with ≥ 1 % warning and ≥ 3 % critical, minimum 1000 codewords, and a 48 h spike-expiry. That's a ratio among errored codewords, not a CER; don't copy it.
- Rising **correctables** without uncorrectables means the FEC is still coping. Use it as an early warning (trend), not as a failure.

---

## 11. Event log interpretation

### 11.1 Format and normalization
Entries look like `No Ranging Response received - T3 time-out;CM-MAC=xx:..;CMTS-MAC=xx:..;CM-QOS=1.1;CM-VER=3.1;`. Before matching:
- strip the `;CM-MAC=…` tail and keep the MACs separately (redact them in exports);
- normalize dashes (– — soft hyphen) to "-";
- collapse whitespace and lower-case.

Dedupe on (Timestamp, Index), as the exporter does. The router's log is a ring buffer, so persist new entries every 15 min.
OSSI priority semantics (§8.1.2.3) [H]: 1 Emergency, 2 Alert, **3 Critical** ("prevents the device from transmitting data"), **4 Error** ("could interrupt the normal data flow, but will not cause the modem to re-register"), **5 Warning**, 6 Notice, 7 Informational, 8 Debug. TG field names and labels are unverified, so parse the number or the word (en/de: Kritisch, Fehler, Warnung, Hinweis, Information).

### 11.2 Timers (MULPI 3.1 Annex B) [H]
| Timer | Meaning | Value |
|---|---|---|
| Lost SYNC | no SYNC (sent ≤ 200 ms) | 600 ms |
| T1 | wait for UCD | 5 × UCD interval (max 2 s) ≈ 10 s |
| T2 | wait for broadcast ranging opportunity | 5 × ranging interval (2 s) ≈ 10 s |
| T3 | wait for ranging response | 200 ms; retries: 16 (contention and invited) |
| T4 | wait for unicast ranging opportunity | 30 s (× T4 multiplier ≤ 10 → 300 s) |
| T6 | wait for REG-RSP | 3 s, 3 retries |
| Lost MDD | MDD sent every ≤ 2 s | 3 × 2 s = 6 s |

### 11.3 Message catalogue (OSSIv3.0 Annex D IDs and CM priorities [H]; app severity and symptom [M])
| Regex (on normalized text) | OSSI code / ID / prio | Dir. | Meaning | App severity | Typical symptom |
|---|---|---|---|---|---|
| `no ranging response received - t3 time-out` | R02.0 / 82000200 / Critical | US | No RNG-RSP within 200 ms (station maintenance) | single: info/grenzwertig; ≥ 3 in 10 min or ≥ 10/day: **kritisch** | latency spikes, short loss bursts, upload stalls |
| `started unicast maintenance ranging - no response received - t3 time-out` | R05.0 / 82000500 / Critical | US | same, during unicast maintenance | as above | as above |
| `unicast maintenance ranging attempted - no response - retries exhausted` | R06.0 / 82000600 / Critical | US | 16 retries failed; channel unusable | **kritisch** | partial service or reinit, seconds to minutes of outage |
| `ranging request retries exhausted` | R03.0 / 82000300 / Critical | US | ranging failed, MAC reinit | **kritisch** | reconnect (≈ 30 s – minutes) |
| `16 consecutive t3 timeouts while trying to range on upstream channel` | R08.0 / 82000800 / Critical | US | same, per channel | **kritisch** | as above |
| `t4 time ?out` (`…no unicast maintenance opportunities received - t4 time out`) | R04.0 / 82000400 / Critical | US/CMTS | CMTS stopped polling the CM for ≥ 30 s | **kritisch** | outage ≥ 30 s, re-registration |
| `unicast ranging received abort response` | R07.0 / 82000700 / Critical | US | CMTS aborted ranging | **kritisch** | reinit |
| `b-init-rng failure` | R09.0 / 82000900 / Warning | US | bonded init ranging failed | grenzwertig | – |
| `t2 time-out` (`no maintenance broadcasts for ranging opportunities`) | R01.0 / 82000100 / Critical | DS | no broadcast ranging in ≈ 10 s | **kritisch** | (re)init failure |
| `no ucds received` | U01.0 / 85000100 / Critical | DS | T1 expired (≈ 10 s) | **kritisch** | (re)init failure |
| `ucd invalid or channel unusable` · `ucd & sync valid - no maps` | U02.0 · U04.0 / Critical | US cfg | – | **kritisch** | – |
| `sync timing synchronization failure` (`failed to acquire qam/qpsk symbol timing` T01.0 84000100 · `fec framing` T02.0 · `mpeg2 sync` T02.1 · `mac framing` T03.0 · `mac sync frame` T04.0 · **`loss of sync`** T05.0 84000500) | Critical | DS | DS lock or timing lost | **kritisch** | dropout, rescan, seconds to minutes |
| `rcs primary ds failure` | T06.0 / 84000600 / Error | DS | primary DS lost | **kritisch** | outage |
| `rcs partial service` | T07.0 / 84000700 / Warning | DS | some DS channels lost | grenzwertig, **kritisch** if persistent | reduced capacity, loss bursts |
| `tcs partial service` | U102.0 / 85010200 / Warning | US | some US channels lost | grenzwertig/**kritisch** | upload issues, latency |
| `tcs fail on all upstream channels` | U101.0 / 85010100 / Error | US | all US lost | **kritisch** | outage |
| `lost mdd timeout` | T202.0 / 84020200 / Warning | DS | MDD missing ≥ 6 s | grenzwertig; ≥ 3/h **kritisch** | partial service, reinit |
| `mdd message timeout` | T203.0 / 84020300 / Warning | DS | MDD timeout | grenzwertig | – |
| `missing mandatory mdd tlv` | T201.0 / 84020100 / Error | DS | – | grenzwertig | – |
| `cm-status message sent\. event type code: (\d+)` | see §11.4 | – | CM reported a status event to the CMTS | by code | – |
| `dhcp renew sent - no response for (ipv4\|ipv6)` · `dhcp rebind sent - no response` | D101.0 / 68010100 · D102.0 / Error | – | CM management lease renewal failed (often a consequence of US/DS trouble) | grenzwertig | – |
| `dhcp failed` (`discover sent, no offer` D01.0 · `request sent, no response` D02.0 · `rs sent, no ra` D12.0 · `solicit sent, no dhcp advertise` D12.2 · `request sent, no dhcp reply` D12.3) | Critical | – | provisioning failed (during init) | **kritisch** | no service |
| `tod request sent - no response received` · `tod response received - invalid data format` | D04.1 · D04.2 / Warning | – | Time-of-Day server not answering (common after boot) | info | none |
| `tftp failed` · `tftp file complete - but` | D05.0–D11.0 / Critical | – | config download failed | **kritisch** | no service |
| `reg rsp not received` · `registration rsp rejected` · `t6 timeout and retries exceeded` | I02.0 / Critical · I251.x / Critical · I271.0 / Error | – | registration failed | **kritisch** | reinit loop |
| `dynamic range window violation` · `rng-rsp ccap commanded power exceeds value corresponding to the top of the drw` · `…in excess of 6 db below…` | D3.1 OSSI, Warning (ID unverified) | US | US power at limit or spread > 12 dB DRW | grenzwertig; frequent: **kritisch** | upload issues; pairs with high US power |
| `ds profile assignment change` · `us profile assignment change` | D3.1, Notice (unverified) | DS/US | OFDM/OFDMA profile changed by CMTS | info; > 6/h grenzwertig | throughput swings |
| `honoring mdd; ip provisioning mode` · `cold start` · `reboot` · `tlv-11 - unrecognized oid` (I401.0 Notice) | Notice | – | boot or provisioning markers | info (boot marker) | – |

Sequence patterns [M]: `T3 time-out` (×n) → `Unicast Maintenance … Retries exhausted` / `Ranging Request Retries exhausted` → `CM-STATUS 7` → (re)ranging, sometimes followed by `SYNC … Loss of Sync`. That's the upstream-impairment signature, seen in the Vodafone forum 2019 log. A burst of `CM-STATUS 16`/`24` means OFDM profile flapping.

### 11.4 CM-STATUS event type codes (MULPI 3.1 Table 10-4; Wireshark dissector) [H; app severity M]
| Code | Event | Trigger | App severity |
|---|---|---|---|
| 1 | Secondary channel MDD timeout | Lost MDD timer on a secondary DS | grenzwertig |
| **2** | **QAM/FEC lock failure** | loss of QAM/FEC lock on a DS channel | **kritisch** |
| 3 | Sequence out-of-range | bonding resequencing (DSID) | grenzwertig |
| 4 | Secondary channel MDD recovery | – | info (closes 1) |
| 5 | QAM/FEC lock recovery | – | info (closes 2; duration = 5 − 2) |
| **6** | **T4 timeout** | per US channel | **kritisch** |
| **7** | **T3 re-tries exceeded** | per US channel | **kritisch** |
| 8 | Successful ranging after T3 re-tries exceeded | – | info (closes 7) |
| 9/10 | CM on battery / back on AC | – | info |
| 11 | MAC removal | CMCI port ifOperStatus UP→DOWN | info (LAN side; in an eRouter gateway probably internal, [L]) |
| **16** | **DS OFDM profile failure** | "FEC errors were over limit on one of the assigned downstream OFDM profiles" | grenzwertig; > 3/h **kritisch** |
| 17 | Primary DS change | – | grenzwertig |
| 18 | DPD mismatch | – | grenzwertig |
| **20** | **NCP profile failure** | FEC errors over limit on NCP | **kritisch** |
| **21** | **PLC failure** | FEC errors over limit on PLC | **kritisch** |
| 22/23/24 | NCP / PLC / OFDM profile recovery | – | info (closes 20/21/16) |
| 25 | OFDMA profile failure | profile beyond CM capability | grenzwertig |
| 26/27 | MAP storage overflow / almost full | – | grenzwertig / info |

---

## 12. Common causes, signatures and fixes

| Signature in data | Likely cause | Evidence to collect | Fix / owner |
|---|---|---|---|
| Several DS channels low (< −4 dBmV / 256QAM) and/or US high (> 47–51), MER OK | too much attenuation: long or cheap coax, splitters, old outlet, misadjusted house amp ("Einpegelung") | DOCSIS table snapshots, stable over days | Vodafone technician: level adjustment, outlet/cable swap; user: direct connection with good cable (class A+, ≥ 120–125 dB screening, metal F-connectors) [M] |
| Single-channel or narrow-band MER dips, often time-of-day dependent; 758–821 MHz | LTE/5G 700/800 ingress into poorly shielded in-house cabling | per-channel SNR vs median, hour-of-day heatmap | replace patch cables, tighten F-connectors, terminate open outlets [M] |
| US: T3 clusters, US modulation drops, TCS partial service, intermittent, also at neighbours | **return-path impairment (RPI / Rückwegstörer)** in the segment: damaged cables, defective house amps, devices, unused open cables, construction damage. Vodafone blog 24.07.2026: symptoms include "hohe Ping-Zeiten beim Gaming", "Verbindungsabbrüche", "langsame Uploads"; often only active "nur morgens / an bestimmten Tagen" | event-log T3/T4 timeline, US power/modulation history, neighbours affected, Störungsfinder status | Vodafone must locate it, so the disturbance must be active during the measurement. User: remove unused coax leads, keep router ≥ 1 m from other electronics, no changes to the house distribution [H: Vodafone blog] |
| Powerline/dLAN adapters in use plus US problems | PLC (2–68/86 MHz) overlaps DOCSIS US 5–65 MHz | test with PLC unplugged | remove PLC [M] |
| RF values fine and stable, latency/loss only in the evening (≈ 18–23 h) and at weekends | **segment congestion** ("Lastproblem"). Vodafone moderator (ERFD, 01.03.2022): "Sollte die Verbindung am Morgen und um die Mittagszeit in Ordnung sein, schaut es nach einem Lastproblem aus." | hour-of-day latency/loss heatmap over ≥ 7 days, morning vs evening, LAN speed tests | Vodafone segment split / capacity upgrade (slow); documentation strengthens the ticket [M] |
| OFDM shows < 4096QAM, CM-STATUS 16/24, throughput swings | OFDM MER too low or frequency-dependent impairment; network change (e.g. TV frequency re-plan: forum 10/2025 "Störung am Knotenpunkt wegen der TV-Frequenzumstellung") | OFDM MER/modulation timeline, event log | technician / network fix [M] |
| T4, SYNC loss, MDD timeouts across all channels, uptime resets | DS outage, plant fault or power issue; occasionally a modem fault | event log, `_ga.modemConnectionStatus` polling, uptime | Vodafone ticket; router swap if only this modem is affected |
| IPv4-only latency/loss, IPv6 to the same anycast provider fine | **DS-Lite AFTR/CGNAT path** (games mostly use IPv4). No DOCSIS signature | paired IPv4/IPv6 pings (1.1.1.1 vs 2606:4700:4700::1111), traceroute | ISP side; evidence = paired measurements [M, context] |
| Loss to the gateway 192.168.0.1 itself, Windows e2fexpress 27/32/33 link down/up, re-link at 100 Mbit/s | **LAN side** (PC NIC/cable/port), not DOCSIS | Windows System log timestamps vs ping loss | cable/port/NIC/driver; outside Vodafone's responsibility |

---

## 13. Evidence Vodafone support and technicians want

From Vodafone community moderator replies (2020–2026) [M]:
- **Time pattern:** "Sind die Einschränkungen 24/7 oder nur zu bestimmten Tageszeiten?", "nur zu Stoßzeiten wie z.B. von 18-22 Uhr … oder auch morgens?"
- **Ping measurements via LAN:** "schicke bitte Pingplottermessungen vom Abend wenn es zu Pingproblemen und Packetloss kommt … auch Messungen am Morgen … direkte LAN-Verbindung mit 2,4 Sekunden Intervall und 10 Minuten Fokus" (moderator Claudia, 03.03.2022; PingPlotter's default is 2.5 s). Also "Die Kollegen brauchen aber aktuellere Beispiele": network-side data is only available for recent periods, so keep the evidence current.
- **Router log:** "Sind Abbrüche im Routerlog ersichtlich?" **Speed test via LAN:** "Kriegst Du die volle Bandbreite bei einem Speedtest (bitte mit direkter LAN-Verbindung)".
- **Signal values:** for a rented Vodafone Station, Vodafone can read them remotely; for customer-owned boxes "Signale am Modem können wir leider … nicht messen". So the DOCSIS tables still help, and SuperUsers judge on the VFKD table.
- **Ticket template fields:** contract, modem/router (rented or own), connection (LAN/WLAN/extra router/PowerLAN), OS/browser, start and period of the problem ("seit … / nur am Abend"), what the hotline already did.
- **Technician visit:** access to basement / house transfer point (HÜP) / amplifier / other flats. The technician measures the line ("durchmessen") and adjusts levels. For RPI the disturbance must be active during the measurement.
- **Official speed evidence (not latency):** BNetzA "Breitbandmessung" desktop app via LAN; a campaign is 30 measurements on 3 measuring days within 14 days; the protocol supports a §57 TKG reduction claim. Verify the current Handreichung at bundesnetzagentur.de/internetgeschwindigkeit [M].

**App export recommendation:** one "Störungsnachweis" bundle (PDF/CSV) per period containing:
1. a summary (time pattern, worst grades, minutes kritisch per day);
2. DOCSIS DS/US tables at the worst moments plus min/avg/max per channel per day;
3. an event-log excerpt with severity, MACs redacted;
4. latency/loss plots morning vs evening (LAN, gateway vs internet, IPv4 vs IPv6);
5. LAN-link events;
6. LAN speed tests;
7. household setup notes (outlet type, amplifier, cable).

---

## 14. Evaluating time series over days

### 14.1 Sampling and storage [M]
- DOCSIS page every **5 min** (allow 2 min while "Diagnosemodus" is on); event log every **15 min**; start page every **60 s** (offline detection without login); `js_UptimeSinceReboot` every 5 min (reboot detection = uptime decreased).
- Store raw rows per poll: `ts, dir, ch_type, ch_id, freq_mhz | freq_start..freq_end, modulation, power_dbmv, snr_db, lock_raw, lock_ok, grade_power, grade_snr, grade_total`. Add per-poll aggregates per family: count_locked, min/avg/max power, min SNR, worst grade, headroom_us.
- **Channel identity** = (dir, type, rounded frequency). IDs can change after re-registration.

### 14.2 Baselines [M]
Per channel: rolling **7-day median** and p05/p95 of power and SNR, plus the baseline channel count and modulation per family. Use the first 24–72 h as a bootstrap; flag "Baseline noch nicht stabil".

### 14.3 Detectors (defaults; [L] numbers unless noted)
| Detector | Rule | Grade |
|---|---|---|
| Threshold crossing | grade change persisting ≥ 2 polls | per table |
| Step change | mean DS or US power shifts > **2 dB** between consecutive polls (DOCSight POWER_SHIFT_THRESHOLD = 2.0) on ≥ 50 % of channels | info; ≥ 4 dB grenzwertig (plant/maintenance/re-ranging) |
| Swing / instability | per-channel daily range > **3 dB** (power) or SNR range > **3 dB** | grenzwertig (loose connector, thermal, amp AGC) |
| SNR outlier | channel ≥ **3 dB** below same-modulation median | grenzwertig + ingress hint (§5.3) |
| US creep | US power 7-day median rising ≥ 2 dB vs the previous week, or headroom < 6 dB | grenzwertig |
| Partial service | locked count < baseline (§9.2) | grenzwertig → kritisch |
| Modulation change | DS/US/OFDM below baseline; DOCSight treats a drop of ≥ 3 QAM steps (e.g. 256→16) as critical | grenzwertig / kritisch |
| Event bursts | ≥ 3 T3 in 10 min; any Retries-exhausted / T4 / SYNC loss; ≥ 3 CM-STATUS 16 per hour | kritisch |
| Reboot | uptime reset or offline seen on the start page | info, kritisch if ≥ 2/day |

### 14.4 Diurnal and correlation analysis [M]
- **Hour-of-day × day heatmaps** (≥ 7 days) for: ping p50/p95 and loss % (gateway vs first public hop vs target; IPv4 vs IPv6), DS min SNR, US max power, event counts.
  - Evening-only latency/loss with flat RF → congestion.
  - RF dips at recurring times → ingress or RPI (devices switched on).
  - Afternoon drift → temperature.
- **Event ↔ loss correlation:** for each loss burst (e.g. ≥ 3 lost pings in 30 s) look for DOCSIS events within ±60 s and LAN link events within ±10 s. Report the shares "erklärt durch DOCSIS", "erklärt durch LAN" and "ungeklärt" (→ congestion/AFTR/remote). Compare P(burst | event) with the base rate.
- **Gateway test:** loss on ping to 192.168.0.1 means the problem is LAN-side by definition.
- **Daily verdict:** the worst of (RF grade time-share: kritisch if ≥ 5 % of polls are kritisch or any partial service ≥ 15 min; grenzwertig if ≥ 10 % grenzwertig), event severity, outages. Show the top-3 contributing findings in German.

### 14.5 Caveats [M]
Snapshots miss short dips; the event log is the transient detector. The router log is volatile and gets lost on reboot, so persist it promptly. Polling must not disturb the user: the TG allows one admin session, so a browser login can kick the engine's session (and vice versa). Re-login on 401/403 once, then back off.

---

## 15. Implementation snippets (TypeScript)

```ts
// docsis/thresholds.ts
export type Grade = 'konform' | 'toleriert' | 'monatsfrist' | 'sofort' | 'unbekannt';
export type UiLevel = 'gut' | 'grenzwertig' | 'kritisch' | 'unbekannt';
export const toUi = (g: Grade): UiLevel =>
  g === 'konform' || g === 'toleriert' ? 'gut' : g === 'monatsfrist' ? 'grenzwertig' : g === 'sofort' ? 'kritisch' : 'unbekannt';
export const worst = (gs: Grade[]): Grade => {
  const r: Record<Grade, number> = { unbekannt: -1, konform: 0, toleriert: 1, monatsfrist: 2, sofort: 3 };
  return gs.reduce<Grade>((a, b) => (r[b] > r[a] ? b : a), 'unbekannt');
};
type B6 = readonly [number, number, number, number, number, number];
type B3 = readonly [number, number, number];
export const rate7 = (v: number, b: B6): Grade =>
  v <= b[0] ? 'sofort' : v <= b[1] ? 'monatsfrist' : v <= b[2] ? 'toleriert' :
  v <= b[3] ? 'konform' : v <= b[4] ? 'toleriert' : v <= b[5] ? 'monatsfrist' : 'sofort';
export const rateMin = (v: number, a: B3): Grade =>
  v <= a[0] ? 'sofort' : v <= a[1] ? 'monatsfrist' : v <= a[2] ? 'toleriert' : 'konform';

export const VFKD = {                       // source: VFKD table 17.06.2018 (vodafonekabelforum t=39941) [H]
  dsPower: { '64QAM': [-14, -12, -10, 7, 12, 14], '256QAM': [-8, -6, -4, 13, 18, 20], '1024QAM': [-6, -4, -2, 15, 20, 22] } as Record<string, B6>,
  dsSnr:   { '64QAM': [24, 26, 27], '256QAM': [30, 32, 33], '1024QAM': [36, 38, 39], OFDM: [35, 38, 40] /* synthesized [L/M] */ } as Record<string, B3>,
  usPower: { scqam: [35, 37, 41, 47, 51, 53] as B6, ofdma: [38, 40, 44, 47, 48, 50] as B6 },  // ofdma: apply to P6.4-equivalent
};
// D3.1 PHY Table 7-41: min CNR (≤1 GHz / 1–1.2 GHz) and min P6AVG (dBmV) [H]
export const OFDM_REQ = [
  { qam: 4096, cnr: 41.0, cnrHi: 41.5, minP6: -6 }, { qam: 2048, cnr: 37.0, cnrHi: 37.5, minP6: -9 },
  { qam: 1024, cnr: 34.0, cnrHi: 34.0, minP6: -12 }, { qam: 512, cnr: 30.5, cnrHi: 30.5, minP6: -12 },
  { qam: 256, cnr: 27.0, cnrHi: 27.0, minP6: -15 },  { qam: 128, cnr: 24.0, cnrHi: 24.0, minP6: -15 },
  { qam: 64, cnr: 21.0, cnrHi: 21.0, minP6: -15 },   { qam: 16, cnr: 15.0, cnrHi: 15.0, minP6: -15 },
];
export const supportableQam = (mer: number, upperEdgeMHz = 1000) =>
  OFDM_REQ.find(r => mer >= (upperEdgeMHz > 1000 ? r.cnrHi : r.cnr))?.qam ?? 0;
```

```ts
// docsis/parse-tg.ts – robust TG value parsing
export const num = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const m = v.split('/')[0].replace(',', '.').match(/-?\d+(?:\.\d+)?/);
  return m ? Math.round(parseFloat(m[0]) * 10) / 10 : null;
};
export const freq = (v: unknown): { center: number | null; start?: number; end?: number } => {
  const toMHz = (x: number) => (x > 1e5 ? x / 1e6 : x);
  if (typeof v === 'string' && v.includes('~')) {
    const [a, b] = v.split('~').map(s => toMHz(parseFloat(s)));
    return { center: (a + b) / 2, start: a, end: b };
  }
  const n = num(v); return { center: n == null ? null : toMHz(n) };
};
export const dsLocked = (s: unknown) => /^(locked|ja|yes|true|1)$/i.test(String(s ?? '').trim());
export const usLocked = (s: unknown) => /^(active|success|erfolgreich|true|1)$/i.test(String(s ?? '').trim());
export const extractJsonVar = (html: string, name: string) => {
  const m = html.match(new RegExp(`${name}\\s*=\\s*(\\[[\\s\\S]*?\\])\\s*;`)); return m ? JSON.parse(m[1]) : [];
};
```

```ts
// docsis/upstream.ts – OFDMA normalization + headroom [L/M]
const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
export type OfdmaMode = 'auto' | 'p1.6' | 'total' | 'p6.4';
export function normalizeOfdma(pDisp: number, bwMHz: number | null, scqam: number[], mode: OfdmaMode = 'auto') {
  const cand: Record<Exclude<OfdmaMode, 'auto'>, number> = {
    'p1.6': pDisp + 6.02, 'p6.4': pDisp, total: bwMHz ? pDisp - 10 * Math.log10(bwMHz / 6.4) : NaN,
  };
  if (mode !== 'auto') return { p64: cand[mode], mode, confidence: 'manuell' as const };
  if (!scqam.length) return { p64: pDisp, mode: 'p6.4' as const, confidence: 'niedrig' as const };
  const ref = median(scqam);
  const [best, err] = (Object.entries(cand) as [Exclude<OfdmaMode, 'auto'>, number][])
    .filter(([, v]) => Number.isFinite(v)).map(([k, v]) => [k, Math.abs(v - ref)] as const)
    .sort((a, b) => a[1] - b[1])[0];
  return { p64: cand[best], mode: best, confidence: err <= 3 ? ('mittel' as const) : ('niedrig' as const) };
}
/** dB headroom of the highest-loaded US channel vs Pmax (default 65 dBmV, D3.1 PHY §7.4.12.2) */
export function usHeadroom(sc: { p: number; bwMHz?: number }[], of: { p64: number; bwMHz: number }[], pmax = 65) {
  const p16 = [...sc.map(c => c.p - 10 * Math.log10((c.bwMHz ?? 6.4) / 1.6)), ...of.map(c => c.p64 - 6.02)];
  const neq = sc.reduce((s, c) => s + (c.bwMHz ?? 6.4) / 1.6, 0) + of.reduce((s, c) => s + c.bwMHz / 1.6, 0);
  if (!p16.length || !neq) return null;
  return pmax - 10 * Math.log10(neq) - Math.max(...p16);   // ≥6 gut, 3–6 grenzwertig, <3 kritisch [L]
}
```

```ts
// docsis/events.ts – event classifier (normalize first)
export const normalizeMsg = (s: string) => s.replace(/;CM-MAC=.*$/i, '').replace(/[‐-―­]/g, '-')
  .replace(/\s+/g, ' ').trim().toLowerCase();
type Sev = 'kritisch' | 'grenzwertig' | 'info';
export const EVENT_RULES: { key: string; re: RegExp; dir: 'US' | 'DS' | '-'; sev: Sev; ossi?: string }[] = [
  { key: 'us_ranging_retries_exhausted', re: /retries exhausted|16 consecutive t3 timeouts/, dir: 'US', sev: 'kritisch', ossi: 'R03.0/R06.0/R08.0' },
  { key: 'us_t4_timeout', re: /t4 time ?-?out/, dir: 'US', sev: 'kritisch', ossi: 'R04.0' },
  { key: 'us_t3_timeout', re: /t3 time-?out/, dir: 'US', sev: 'grenzwertig', ossi: 'R02.0/R05.0' },     // burst rule escalates
  { key: 'us_ranging_abort', re: /unicast ranging received abort response/, dir: 'US', sev: 'kritisch', ossi: 'R07.0' },
  { key: 'ds_t2_timeout', re: /t2 time-?out/, dir: 'DS', sev: 'kritisch', ossi: 'R01.0' },
  { key: 'ds_no_ucd', re: /no ucds received|ucd invalid or channel unusable|no maps for this channel/, dir: 'DS', sev: 'kritisch', ossi: 'U01.0/U02.0/U04.0' },
  { key: 'ds_sync_loss', re: /sync timing synchronization failure/, dir: 'DS', sev: 'kritisch', ossi: 'T01.0–T05.0' },
  { key: 'ds_primary_fail', re: /rcs primary ds failure/, dir: 'DS', sev: 'kritisch', ossi: 'T06.0' },
  { key: 'ds_partial', re: /rcs partial service/, dir: 'DS', sev: 'grenzwertig', ossi: 'T07.0' },
  { key: 'us_all_fail', re: /tcs fail on all upstream channels/, dir: 'US', sev: 'kritisch', ossi: 'U101.0' },
  { key: 'us_partial', re: /tcs partial service/, dir: 'US', sev: 'grenzwertig', ossi: 'U102.0' },
  { key: 'ds_mdd', re: /lost mdd timeout|mdd message timeout|missing mandatory mdd tlv/, dir: 'DS', sev: 'grenzwertig', ossi: 'T201.0–T203.0' },
  { key: 'us_drw', re: /dynamic range window|top of the drw/, dir: 'US', sev: 'grenzwertig' },
  { key: 'dhcp_renew_fail', re: /dhcp (renew|rebind) sent - no response/, dir: '-', sev: 'grenzwertig', ossi: 'D101.0/D102.0' },
  { key: 'provisioning_fail', re: /dhcp failed|tftp failed|tftp file complete - but|reg rsp not received|registration rsp rejected|t6 timeout and retries exceeded/, dir: '-', sev: 'kritisch' },
  { key: 'tod', re: /tod (request sent|response received)/, dir: '-', sev: 'info', ossi: 'D04.x' },
  { key: 'profile_change', re: /(ds|us) profile assignment change/, dir: '-', sev: 'info' },
  { key: 'boot', re: /honoring mdd|cold start|warm start|reboot|tlv-11 - unrecognized oid/, dir: '-', sev: 'info' },
];
export const CM_STATUS_SEV: Record<number, Sev> = { 1: 'grenzwertig', 2: 'kritisch', 3: 'grenzwertig', 4: 'info', 5: 'info',
  6: 'kritisch', 7: 'kritisch', 8: 'info', 9: 'info', 10: 'info', 11: 'info', 16: 'grenzwertig', 17: 'grenzwertig',
  18: 'grenzwertig', 20: 'kritisch', 21: 'kritisch', 22: 'info', 23: 'info', 24: 'info', 25: 'grenzwertig', 26: 'grenzwertig', 27: 'info' };
export function classify(raw: string) {
  const m = normalizeMsg(raw);
  const cs = m.match(/cm-status message sent\. event type code: (\d+)/);
  if (cs) return { key: `cm_status_${cs[1]}`, sev: CM_STATUS_SEV[+cs[1]] ?? 'grenzwertig', dir: '-' as const };
  return EVENT_RULES.find(r => r.re.test(m)) ?? { key: 'other', sev: 'info' as Sev, dir: '-' as const };
}
```
Order matters: "retries exhausted" must be checked before "t3 time-out" because some messages contain both.

---

## 16. Open items to verify on the real TG6442 (after login, browser devtools)
1. Exact `status_docsis_data.php` field names and values on firmware 01.05.069.14: LockStatus strings for unlocked DS rows and non-success ranging; any extra fields such as codewords (expected none).
2. Event-log JSON field names (priority, message) and the timestamp format/timezone of `status_event_log_data.php`.
3. OFDMA power semantics on this unit: compare the OFDMA value with the SC-QAM values; if a Vodafone technician measures, compare with their meter.
4. Whether the TG shows OFDM modulation as the current profile or the maximum profile; whether "Unsupported" appears in JSON.
5. Login side effects: does polling log out a concurrent browser session? Session lifetime? Is `_n=<5 digits>` needed on GETs (scouting saw it in UI JS; open-source clients don't send it)?
6. Whether `status_status_data.php` (uptime) is reachable with the same session headers.

---

## 17. Sources
- Vodafone pNTP Interface Specification: https://www.vodafone.de/media/downloads/pdf/VF-DOCSIS-Interface-Specification-v1.06.pdf
- VFKD FAQ (DerSarde, 17.11.2018; based on "20180617_Pegelwerte.pdf"): https://vodafonekabelforum.de/viewtopic.php?t=39941
- CableLabs CM-SP-PHYv3.0-I09-101008: https://account.cablelabs.com/server/alfresco/887e1bcb-0bf0-40d1-aaae-65f254078670
- CableLabs CM-SP-PHYv3.1-I08-151210 (copy): https://volpefirm.com/wp-content/uploads/2017/01/CM-SP-PHYv3.1-I08-151210.pdf
- CableLabs CM-SP-MULPIv3.1-I10-170111 (copy): https://volpefirm.com/wp-content/uploads/2017/01/CM-SP-MULPIv3.1-I10-170111.pdf
- CableLabs CM-SP-OSSIv3.0-I30-170111 (copy): https://volpefirm.com/wp-content/uploads/2017/01/CM-SP-OSSIv3.0-I30-170111.pdf
- Wireshark DOCSIS MAC-mgmt dissector (CM-STATUS codes): https://github.com/wireshark/wireshark/blob/master/epan/dissectors/packet-docsis-macmgmt.c
- DOCS-IF3-MIB RangingState: https://mibs.observium.org/mib/DOCS-IF3-MIB/
- Vodafone community "Interpretation der Signalwerte des Kabelnetzes" (05.01.2026): https://forum.vodafone.de/t5/Plauderecke/Interpretation-der-Signalwerte-des-Kabelnetzes/td-p/3309347
- Vodafone community "Kabel Pegelwerte" (06.08.2026): https://forum.vodafone.de/t5/St%C3%B6rungen-im-Kabel-Netz/Kabel-Pegelwerte/td-p/3348749
- Vodafone community "OFDM SNR/MER DOCSIS 3.1" (2019): https://forum.vodafone.de/t5/Archiv-St%C3%B6rungsmeldungen/OFDM-SNR-MER-DOCSIS-3-1/m-p/2295908
- Vodafone community "Download sehr langsam" (2025): https://forum.vodafone.de/t5/St%C3%B6rungen-im-Kabel-Netz/Download-sehr-langsam/td-p/3302833
- Vodafone community "Internet zu langsam und hoher ping" (2025): https://forum.vodafone.de/t5/St%C3%B6rungen-im-Kabel-Netz/Internet-zu-langsam-und-hoher-ping/m-p/3294773
- Vodafone community "Ping Spike / Packet Loss" (2022): https://forum.vodafone.de/t5/St%C3%B6rungen-im-Kabel-Netz/Ping-Spike-Packet-Loss/td-p/2866906
- Vodafone community "Package Loss" (2020): https://forum.vodafone.de/t5/Internet-Ger%C3%A4te/Package-Loss/m-p/2196580
- Vodafone Community Blog "Was ist eine Rückwegstörung?" (24.07.2026): https://forum.vodafone.de/t5/Community-Blog/Was-ist-eine-R%C3%BCckwegst%C3%B6rung/ba-p/2417129
- Vodafone article on Rückwegstörer: https://www.vodafone.de/featured/article/stoerung-im-kabelnetz-warum-ein-rueckwegstoerer-hunderte-haushalte-lahmlegen-kann-178756
- DOCSight (thresholds, Vodafone Station driver, PR #329, issue #835): https://github.com/itsDNNS/docsight · community profile: https://github.com/itsDNNS/docsight-modules
- vodafone-station-cli (diagnose, ARRIS fixtures): https://github.com/totev/vodafone-station-cli
- arris-tg3442de-exporter (event-log endpoint): https://github.com/fsck-block/arris-tg3442de-exporter
- Volpe Firm: codeword errors https://volpefirm.com/docsis-codeword-errors/ · T1–T4 https://volpefirm.com/docsis_timeout_descriptions/ · US power https://volpefirm.com/speeding-upstream-part-ii/
- SpeedGuide T1–T4: https://speedguide.net/faq/docsis-t1-t2-t3-t4-timeout-errors-515
- Cox community on DRW violations: https://forums.cox.com/discussions/internet/dynamic-range-window-violation/141404
- BNetzA Internetgeschwindigkeit: https://www.bundesnetzagentur.de/internetgeschwindigkeit
