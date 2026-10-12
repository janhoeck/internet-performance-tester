# Messplan – Langzeittest der Internetverbindung

**Ziel:** Die Ursache für hohe Pings (> 200 ms) und Paketverluste in Online-Spielen finden.
Dazu wird die Verbindung **abschnittsweise** vom PC bis zum Spieleserver über Stunden bis Tage
gemessen – jede Sekunde, alle Messpunkte im selben Takt. Fällt ein Abschnitt aus, sind alle
Abschnitte dahinter mitbetroffen; der **erste** auffällige Abschnitt ist der Kandidat für die Ursache.

> Stand: 09.10.2026 · PC „Jan-PC“ (Windows 11, Intel I225-V Ethernet, Intel AX211 WLAN) ·
> Vodafone-Kabelanschluss mit DS-Lite · Router: Vodafone Station Wi-Fi 6 (ARRIS TG6442) unter http://192.168.0.1

---

## 1. Ist-Analyse (Voruntersuchung vom 09.10.2026)

**Kernaussage: Es gibt sehr wahrscheinlich zwei unabhängige Probleme.**
(1) Die Netzwerkverbindung am PC bricht zeitweise ab → Verbindungsabbrüche im Spiel.
(2) Zusätzlich treten Latenzspitzen **hinter** dem Router auf → „Ping > 200 ms“.

| Befund | Bewertung |
|---|---|
| **Netzwerkadapter Intel I225-V verliert im Betrieb die Verbindung**: 78 Link-down-Einträge seit 24.08.2026 (Quelle `e2fexpress`, ID 27). **59 davon sind normal** (Treiber protokolliert bei jedem Start/Aufwachen), **19 sind echte Abbrüche im laufenden Betrieb** mit je 3–22 s Komplettausfall – erst seit 26.09., zuletzt gehäuft (07./08.10.), einer live am 09.10. um 15:00:25. | 🔴 **Problem 1** – erklärt Abbrüche im Spiel |
| Nach dem Wiederaufbau oft nur **100 Mbit/s** statt 1 Gbit/s: im Betrieb 8 von 19 (42 %), beim Start 22 von 59 (37 %). Zwischen 02. und 13.09. jedes Mal 100 Mbit/s, seit 25.09. meist 1 Gbit/s. | 🔴 Typisch für Kabel/Stecker/Port (Gigabit braucht alle 4 Adernpaare), erst danach Treiber |
| Bei jedem Abbruch wechselt Windows binnen 1 s aufs WLAN („Vodafone-43FE“, automatisch verbinden) und 30–60 s später zurück → **IP-Adresse wechselt zweimal**, neue DS-Lite-NAT-Zuordnung, Spielverbindungen brechen ab. Der Ping zum Router läuft dabei über WLAN weiter – **Abbrüche sind im Router-Ping kaum sichtbar.** | 🟠 Folge, nicht Ursache – wird über Link-Status und Ausgangsschnittstelle (sekündlich) erfasst |
| 08.10., 18:29–18:33: vermutlich **Neustart der Vodafone Station** (≈ 4 min ohne Internet, auch das WLAN-Netz verschwand) | 🟠 Router-/Leitungsereignis – wird künftig über Router-Laufzeit und -Ereignisprotokoll belegt |
| Stichprobe bei ruhendem PC: Router 0–4 ms, aber **Kopfstation (1. IPv6-Hop) 10–138 ms**, AFTR 11–48 ms, Cloudflare einzelne Spitzen 120–160 ms, UDP bis ≈ 215 ms – auf IPv4 **und** IPv6 | 🟠 **Problem 2** (vorläufig, nur Sekunden gemessen): Spitzen entstehen im Kabelzugangsnetz oder durch andere Geräte im Haushalt – nicht DS-Lite, nicht dieser PC |
| Treiber 1.1.4.43 vom 15.02.2024 = älterer Windows-10-Treiberzweig (`e2f`); für Windows 11 gibt es den NetAdapter-Treiber (`e2fn` 2.1.x, Paket 31.2.2 vom 10.07.2026). „Selective Suspend“ aktiv; EEE schaltet der Treiber bei Gigabit selbst ab. | 🟡 aktualisieren – **nach** dem Kabeltest |
| Router unter **http://192.168.0.1**: Vodafone Station Wi-Fi 6 (ARRIS TG6442), Firmware 01.05.069.14 – umgangssprachlich „EasyBox“. Ohne Login: Status, Firmware, DS-Lite-Daten; mit Login: DOCSIS-Kanalwerte, Router-Ereignisprotokoll, Laufzeit, Geräteliste (inkl. Port-Geschwindigkeit des PCs). Fehlerzähler (Codewörter) liefert die Station nicht. | ℹ️ |
| **DS-Lite**: keine eigene öffentliche IPv4 (öffentlich sichtbar: 92.208.29.229 über Vodafones AFTR `2a00:0:cff:84a0::3`). NAT-Verhalten ist günstig (endpunktunabhängiges Mapping/Filtering), Pfad-MTU IPv4 1460, IPv6 1500. | 🟢 NAT-Typ unkritisch; IPv4 ↔ IPv6 werden trotzdem getrennt gemessen |
| Cloudflare WARP (Firmen-VPN) im Split-Tunnel – Spieleverkehr läuft nicht durch den Tunnel, DNS wird nicht umgeleitet; WARP reagiert nur auf Abbrüche. | 🟢 nicht ursächlich |
| UPnP am Router deaktiviert (bei DS-Lite üblich) | ℹ️ |
| **Sicherheit:** `easy.box` und `kabel.box` lösen (auch über den Router-DNS) zu **fremden Servern im Internet** auf (45.77.92.157, 45.77.75.133, 207.246.78.75) | ⚠️ Router-Passwort nur unter http://192.168.0.1 eingeben |

---

## 2. Messprinzip: Abschnitt für Abschnitt, Sekunde für Sekunde

```
 PC ─Kabel─ Router ══DOCSIS══ Kopfstation(CMTS) ── Vodafone ── AFTR (DS-Lite, nur IPv4) ── Backbone ── Internet ── Spieleserver
 │          │                 │                                │                          │           │            │
 Link-Status Ping gw/gw6       Ping 1. IPv6-Hop                 Ping AFTR (IPv6)           1. IPv4-Hop  Cloudflare/  AWS Frankfurt/
 Ausgangs-   Router-DNS/-TCP   DOCSIS-Werte (Login)                                                     Google v4+v6 Irland (TCP)
 schnittstelle
```

Ein PowerShell-Hintergrundprozess (.NET-Ping, ohne Admin-Rechte) pingt **alle Ziele exakt im
gleichen Sekundentakt** (auch bei Zeitüberschreitungen bleibt der Takt fest) und meldet dabei
sekündlich den Link-Status der Netzwerkadapter. Daraus wird **jede Sekunde einem Abschnitt
zugeordnet** (erste zutreffende Regel gewinnt):

| Klasse | Bedingung | Abschnitt |
|---|---|---|
| ausgeschlossen | keine Messung (Standby, Lücke) | – |
| **LINK** | erwartete Verbindung (z. B. Ethernet) unterbrochen, Verkehr läuft über eine andere Schnittstelle (WLAN-Ausweichen) oder ≤ 60 s nach Wiederaufbau | PC & Adapter |
| **LAN** | Router-Ping verloren oder Spike | Heimnetz |
| gut | keine Verluste/Spikes auf den Referenzzielen | – |
| **ACCESS** | Router gut, Kopfstation schlecht, IPv4 **und** IPv6 gestört | Kabelnetz (DOCSIS) |
| **AFTR** | IPv4 gestört, IPv6 sauber | DS-Lite-Gateway |
| **BACKBONE** | Kopfstation gut, IPv4 und IPv6 gestört | Vodafone-Netz |
| **REMOTE** | nur Spieleserver gestört | Weg zum Rechenzentrum |
| unklar | gestört, keine Regel passt | – |

Zusätzlich je Sekunde: *gestörte Sekunde* (Verlust oder Spike), *stark gestörte Sekunde* (≥ die
Hälfte der Internet-Pings verloren oder ≥ 200 ms) und *Eigenlast* (eigener Datenverkehr ≥ 80 % der
Link-/Tarif-Bandbreite). **Die Diagnose zählt, in welchem Abschnitt die meisten gestörten Sekunden
entstehen** – das ist die wahrscheinlichste Ursache.

---

## 3. Messwerte im Detail

Intervall: **Test** = solange ein Langzeittest läuft; **immer** = auch ohne Test (leichtgewichtig).

### 3.1 PC & Netzwerkadapter

| Messwert | Methode | Intervall | Bewertung | Aussage |
|---|---|---|---|---|
| **Link-Status, Link-Geschwindigkeit, Byte-/Fehlerzähler** | .NET `NetworkInterface` im Ping-Prozess | 1 s (Test) | down = 🔴, < 1000 Mbit/s = 🟠 | Abbrüche sekundengenau, 100-Mbit-Rückfall |
| **Ausgangsschnittstelle** IPv4/IPv6 (Ethernet oder WLAN?) | lokale Quelladresse ohne Paketversand | 1 s (Test) | ≠ erwartete Schnittstelle = 🔴 | WLAN-Ausweichen bei Kabelabbruch |
| Link-Abbrüche aus dem Windows-Ereignisprotokoll inkl. **Einordnung** (Start/Aufwachen, vor Standby, Router-Neustart, *echter Abbruch*), Geschwindigkeit nach Wiederaufbau, Ausfalldauer, WLAN-Ausweichen | `wevtutil` (Intel `e2fexpress`/`e2fnexpress`, Kernel-Boot/-Power, WLAN-AutoConfig); Import der gesamten Historie | immer, 60 s | echter Abbruch = 🔴 | Physische Verbindung/Treiber instabil |
| Eigene Datenrate (Empfang/Senden) | Byte-Zähler-Differenz | 1 s | – | Lädt der PC selbst gerade viel? (Eigenlast) |
| Adapterfehler/verworfene Pakete (Δ) | `Get-NetAdapterStatistics` | 10 s | > 0 = 🟠 | Störungen auf dem Kabel |
| Treiber & Energiespar-Einstellungen | `Get-NetAdapterAdvancedProperty` | 10 min | Selective Suspend an = 🟡 | Bekannte Ursachen |
| WLAN (falls verbunden): SSID, BSSID, Signal %, RSSI, Kanal, Band, Raten | `netsh wlan show interfaces` | 15 s | Signal < 60 % / RSSI < −67 dBm = 🟠 | Funkqualität, Roaming |
| VPN/WARP-Status & Modus | `warp-cli -j` | 2 min | Voll-Tunnel = 🟠 | Läuft Spieleverkehr durchs VPN? |
| Identität: Gateway-MAC, DHCP-/DNS-Server, IPv6-Präfix, IP-Konflikte | PowerShell, Ereignis Tcpip 4199 | 60 s | Wechsel/Konflikt = 🔴 | Fremdes Gerät, falsche Konfiguration |
| Laufendes Spiel | Prozessliste (konfigurierbar) | 60 s | – | Speedtests pausieren, Spielzeiten markieren |
| TCP-Neuübertragungen (systemweit) | Leistungszähler TCPv4/TCPv6 | 60 s | > 1 % = 🟠 | Paketverlust im realen Verkehr |
| CPU-Last, Speicher, Messgenauigkeit (Engine-Verzögerung) | Node | 10 s | – | Qualitätskontrolle |
| Standby/Aufwachen | Ereignisprotokoll + Timer-Lücken | immer | – | wird nicht als Ausfall gewertet; **Standby wird während eines Tests verhindert** (abschaltbar) |

### 3.2 Heimnetz & Router

| Messwert | Methode | Intervall | Bewertung (p50) | Aussage |
|---|---|---|---|---|
| **Ping Router** IPv4 (`192.168.0.1`) und IPv6 (link-lokal) | .NET-Ping | 1 s | ≤ 2 ms 🟢, ≤ 5 ms 🟠, Verlust > 0 % 🔴 | Strecke PC ⇄ Router |
| Router-DNS-Antwortzeit | DNS über UDP | 10 s | – | Router-Auslastung |
| Router-Weboberfläche (TCP-Aufbau) | TCP :80 | 10 s | p95 > 50 ms = 🟠 | Router überlastet |
| Router-Status ohne Login | Startseite (`modemConnectionStatus`, Firmware, WAN-IPv6, AFTR, Neustartgrund, Sperrzeit, DFS, Band Steering) + Antwortzeit | 60 s | ≠ „DOCSIS Online“ = 🔴 | Modem offline/Resync |
| Geräte am Router inkl. **Port-Geschwindigkeit des PCs** | `overview_data.php` (Login) | 5 min | PC mit „100 Mbps“ = 🟠 | 100-Mbit-Problem aus Routersicht |

### 3.3 Kabelleitung (DOCSIS) – mit Router-Login

| Messwert | Methode | Intervall | Bewertung | Aussage |
|---|---|---|---|---|
| Downstream-Pegel und SNR/MER je Kanal (SC-QAM + OFDM) | `status_docsis_data.php` | 5 min | Vodafone-Richtwerte (§4) | Signal, Störabstand, Einstrahlung |
| Upstream-Pegel je Kanal (SC-QAM + OFDMA), Reserve bis zur Sendegrenze | dto. | 5 min | §4 | Rückkanal, Dämpfung |
| Modulation, Lock-Status, Kanalanzahl (Partial Service), Pegel-Schräglage | dto. | 5 min | Kanalverlust = 🔴 | Leitung verliert Kanäle |
| Router-Ereignisprotokoll (T3/T4-Timeouts, Sync-Verlust, Ranging, Partial Service, CM-STATUS) | `status_event_log_data.php` | 15 min | T3 vereinzelt 🟠, gehäuft/T4/Sync 🔴 | Rückkanalstörungen, Resyncs |
| Router-Laufzeit (Neustarts) | `status_status_data.php` | 5 min | Rücksprung = Neustart | Instabiler Router/Resyncs |
| **Ping Kopfstation (CMTS, 1. IPv6-Hop)** | .NET-Ping | 1 s | p50 ≤ 15 ms 🟢, ≤ 30 ms 🟠 | Kabelstrecke **ohne** DS-Lite |

Der Router erlaubt nur **eine** Admin-Sitzung: Das Tool meldet sich nach jeder Abfrage wieder ab,
fragt höchstens alle 5 Minuten ab und versucht bei falschem Passwort **nie** automatisch erneut
(Schutz vor Sperre).

### 3.4 Vodafone-Zugang, DS-Lite & Backbone

| Messwert | Methode | Intervall | Bewertung | Aussage |
|---|---|---|---|---|
| **Ping AFTR** (DS-Lite-Gateway, Adresse vom Router) | .NET-Ping IPv6 | 1 s | p50 ≤ 25 ms 🟢 | Carrier-NAT-Knoten |
| Ping 1. IPv4-Hop hinter dem AFTR | .NET-Ping | 1 s | p50 ≤ 25 ms 🟢 | Vodafone-Backbone (antwortet nicht immer – nur ergänzend) |
| **IPv4 ↔ IPv6** zu denselben Zielen | Paare Cloudflare/Google (ICMP, UDP, TCP) | 1–10 s | IPv4 deutlich schlechter = 🔴 AFTR | isoliert DS-Lite-Probleme |
| Pfaderkennung (Hops 1–8) + Routenwechsel | TTL-Pings (.NET) | 15 min + bei Ausfall | Wechsel = Hinweis | neue Wege, Hop-Adressen für die Messziele |
| MTR (20 Pings je Hop) mit korrekter Auswertung (Verlust zählt nur, wenn er bis zum Ziel bestehen bleibt) | TTL-Pings | 60 min + bei Ausfall | Verlust ab Hop X bis zum Ziel = 🔴 | wo genau Verlust beginnt |
| Pfad-MTU IPv4/IPv6 | Ping mit DF-Bit, Binärsuche | täglich | IPv4 < 1460 = Hinweis | Fragmentierung |
| NAT-Verhalten, öffentliche IPv4 (CGNAT-Ausgang) | STUN (Google, Cloudflare), `o-o.myaddr.l.google.com` | 30 min + bei Wechsel | endpunktabhängig = strikter NAT | P2P in Spielen, IP-Wechsel |

### 3.5 Internet & Spieleserver

| Messwert | Methode | Intervall | Bewertung | Aussage |
|---|---|---|---|---|
| Ping Cloudflare 1.1.1.1 / IPv6, Google 8.8.8.8 / IPv6 | .NET-Ping | 1 s | p50 ≤ 40 ms 🟢, ≤ 80 ms 🟠; Verlust < 0,1 % 🟢, < 1 % 🟠 | Grundqualität ins Internet |
| **UDP-Laufzeit wie Spieleverkehr** (DNS-Abfrage `id.server` – beantwortet der Cloudflare-Knoten direkt) IPv4/IPv6 | UDP | 5 s | dto. | UDP durch NAT/AFTR |
| UDP-Burst (20 Pakete/s für 10 s) | UDP | 5 min | Verlust > 1 % = 🔴 | Verlust/Jitter bei spieltypischer Paketrate |
| TCP-Verbindungsaufbau Cloudflare (IPv4/IPv6) | TCP :443 | 10 s | dto. | Verbindungsaufbau |
| TCP-Verbindungsaufbau AWS Frankfurt / Irland | TCP :443 | 10 s | p50 ≤ 40 ms 🟢, ≤ 80 ms 🟠 | Weg zu typischen Spiele-Rechenzentren |
| Eigene Ziele (IP des Spieleservers) | ICMP/TCP/UDP konfigurierbar | frei | – | direkt das eigene Spiel |

### 3.6 Kennzahlen je Ziel

| Kennzahl | Definition | gut | grenzwertig | schlecht |
|---|---|---|---|---|
| Latenz | Median (p50), dazu p95/p99/max | segmentabhängig (s. o.) | | |
| **Jitter** | mittlere Differenz aufeinanderfolgender erfolgreicher Pings (Verlust unterbricht die Kette) | ≤ 5 ms | ≤ 15 ms | > 15 ms |
| **Spitzen** | p99 − p50 | ≤ 20 ms | ≤ 50 ms | > 50 ms |
| **Lag-Spitzen** | Pings ≥ 200 ms pro Stunde | 0 | ≤ 2 | > 2 |
| Paketverlust | verlorene Pings (mit 95-%-Konfidenzintervall) | < 0,1 % | < 1 % | ≥ 1 % |
| Ausfälle | ≥ 3 s ohne Antwort auf ≥ 2 Internet-Zielen | 0/Tag | ≤ 1/Tag | > 1/Tag |
| Spike | Ping ≥ Median + max(5 σ, 25 ms) (LAN: 10 ms) – robust per MAD; oder ≥ 200 ms | | | |

### 3.7 Durchsatz & Bufferbloat

| Messwert | Methode | Intervall | Bewertung | Aussage |
|---|---|---|---|---|
| Download/Upload | Cloudflare, 6/4 parallele Verbindungen, je 15 s | alle 3 h, **nicht** 18–23 Uhr, nicht während eines Spiels, bei Eigenlast oder Ausfall; jederzeit manuell | < 50 % des Tarifs = 🔴 | Bandbreite, **Begrenzung durch 100-Mbit-Link** wird markiert |
| **Latenz unter Last** (Download/Upload getrennt, alle 200 ms) | UDP `id.server` + Ping Router/Kopfstation/AFTR | je Test | Anstieg A+ < 5, A < 30, B < 60, C < 200, D < 400, F ≥ 400 ms | Bufferbloat; **welcher Abschnitt puffert** (Router-Ping steigt → LAN-Link; Kopfstation steigt beim Upload → Modem-Puffer) |

### 3.8 Ereignisse (automatisch erkannt)

| Ereignis | Erkennung |
|---|---|
| Ausfall | ≥ 3 s keine Antwort von ≥ 2 Internet-Zielen; Einordnung PC / Heimnetz / Kabel / AFTR (nur IPv4) / Backbone / Internet |
| Verlust-Burst | ≥ 2 Verluste in 10 s auf einem Ziel |
| Latenz-Spike-Episode | Spikes zusammengefasst (Lücke ≤ 2 s), Schwere: leicht / deutlich (+50 ms) / schwer (≥ 200 ms oder +150 ms) |
| Periodische Spikes | Häufigkeitsanalyse der Abstände (z. B. alle 60 s → Hintergrunddienst/WLAN-Scan) |
| Link-Abbruch / WLAN-Ausweichen / Schnittstellenwechsel | Link-Status 1 s + Ereignisprotokoll |
| Routenwechsel, IP-/AFTR-Wechsel, Identitätswechsel | Pfaderkennung, STUN, Router, PowerShell |
| Router-Neustart / -Offline / DOCSIS-Ereignisse | Router-Abfragen |
| Speedtest-Fenster | werden aus den Statistiken herausgerechnet |
| Messlücke | Timer-Lücke > 5 s / Standby – kein Ausfall |
| Notiz „Lag jetzt“ | Knopf im Dashboard – subjektive Lags mit Messdaten abgleichen |

---

## 4. DOCSIS-Richtwerte (Vodafone Kabel)

Quelle: Vodafone-Kabel-Servicetabelle (17.06.2018, Grundlage der pNTP-Schnittstellenspezifikation),
siehe `docs/research/docsis-thresholds.md`. Stufen: *konform* / *toleriert* → gut,
*Monatsfrist* → grenzwertig, *sofort* → kritisch.

| Wert | konform | toleriert | Monatsfrist | sofort (kritisch) |
|---|---|---|---|---|
| Downstream-Pegel 256QAM | −4 … +13 dBmV | −6 … −4 / +13 … +18 | −8 … −6 / +18 … +20 | < −8 / > +20 |
| Downstream-Pegel 64QAM | −10 … +7 dBmV | −12 … −10 / +7 … +12 | −14 … −12 / +12 … +14 | darüber hinaus |
| Downstream-Pegel OFDM / 1024QAM | −2 … +15 dBmV | −4 … −2 / +15 … +20 | −6 … −4 / +20 … +22 | darüber hinaus |
| Downstream-SNR 256QAM | > 33 dB | 32 … 33 | 30 … 32 | ≤ 30 |
| Downstream-SNR 64QAM | > 27 dB | 26 … 27 | 24 … 26 | ≤ 24 |
| OFDM-MER | ≥ benötigter CNR der Modulation + 3 dB (4096QAM: 41 dB) | | ≥ benötigter CNR | darunter |
| Upstream-Pegel SC-QAM | 41 … 47 dBmV | 37 … 41 / 47 … 51 | 35 … 37 / 51 … 53 | < 35 / > 53 |
| Upstream-Pegel OFDMA | 44 … 47 dBmV | 40 … 44 / 47 … 48 | 38 … 40 / 48 … 50 | darüber hinaus |
| Router-Protokoll T3-Timeout | – | vereinzelt | – | ≥ 3 in 10 min oder ≥ 10/Tag |
| T4-Timeout, Sync-Verlust, „Retries exhausted“ | – | – | – | jedes Auftreten |

Zusatzprüfungen: SNR-Ausreißer (≥ 3 dB unter dem Median gleicher Modulation → Einstrahlungsverdacht,
z. B. LTE 800 MHz), Nachbarkanäle > 6 dB Unterschied, Schräglage > 10 dB, Kanalverlust gegenüber
der 7-Tage-Basis, Sendereserve des Modems. Die Vodafone Station liefert **keine Codewort-Fehlerzähler**.

---

## 5. Auswertung: Diagnose-Regeln

Grundlage ist der **Anteil gestörter Sekunden je Abschnitt** (§2). Dazu kommen Regeln, die Belege
liefern und konkrete Empfehlungen geben. Jede Regel erzeugt einen Befund mit Schweregrad,
Sicherheit, Belegen und Empfehlungen.

| ID | Auslöser (vereinfacht) | Befund / Empfehlung |
|---|---|---|
| R01 `nic-link-flaps` | ≥ 3 echte Link-Abbrüche in 7 Tagen oder ≥ 3 in 30 min | „Netzwerkverbindung am PC bricht ab“ → Kabel direkt PC↔Station tauschen (Cat 6, ohne Dose/Kupplung), anderen LAN-Port, Stecker prüfen; danach Treiber |
| R02 `nic-100m` | ≥ 20 % der Wiederaufbauten unter 1 Gbit/s (≥ 5 Fälle) oder > 10 min bei 100 Mbit/s; Router meldet „100 Mbps“ | „Kabel/Port schafft kein Gigabit“; Test: „Speed & Duplex“ kurz auf „1.0 Gbps Full Duplex“ |
| R03 `wlan-failover` | WLAN-Ausweichen bei ≥ 50 % der Abbrüche | „Windows wechselt bei Abbrüchen aufs WLAN – Spielverbindungen brechen trotzdem ab“ |
| R04 `bufferbloat-load` | p95 unter Last ≥ 50 ms höher bzw. Note ≤ C | „Lags unter Last“ → QoS/Bandbreitenbegrenzung, Downloads pausieren; LAN-Variante, wenn der Router-Ping steigt (100-Mbit-Link) |
| R05 `lan-quality` | Router-Verlust ≥ 0,5 %/h oder p99 ≥ 20 ms bei stehendem Link | „Problem zwischen PC und Router“ |
| R06 `lan-unreachable` | Router ≥ 30 s nicht erreichbar bei stehendem Link | „Router reagiert nicht“ |
| R07 `access-spikes` | ≥ 70 % der Internet-Spikes gleichzeitig (±1 s) mit Spikes der Kopfstation, Router p99 < 10 ms, Eigenlast < 20 % | „Störung/Überlastung im Kabelnetz“ → Vodafone-Störung melden (Bericht exportieren) |
| R08 `household-load` | Spikes fallen mit hoher Eigenlast/Gesamtlast zusammen; Test „ruhiger Haushalt“ halbiert die Spikes | „Andere Geräte/Downloads verursachen Lags“ |
| R09 `docsis-values` | DOCSIS-Werte außerhalb der Richtwerte, T3/T4-Häufung, Kanalverlust, Router-Neustarts | „Leitungswerte auffällig“ → Techniker (Hausverkabelung, Dose, Verstärker) |
| R10 `peak-hours` | 19–23 Uhr p50 ≥ Basis (03–17 Uhr) + 15 ms bzw. × 1,5 oder Verlust > 0,5 % an ≥ 3 Tagen, Router dabei < 3 ms | „Überlastung zu Stoßzeiten (Segment)“ |
| R11 `ipv4-vs-ipv6` | IPv4 in ≥ 30 % der 15-min-Fenster ≥ 1 %-Punkt mehr Verlust oder ≥ 30 ms höheres p95 – bei beiden Anbieter-Paaren | „DS-Lite-Gateway (AFTR) überlastet“ → Dual-Stack bei Vodafone anfragen, IPv6 nutzen |
| R12 `remote-only` | nur der Weg zum Spieleserver gestört | „Problem auf dem Weg zum Rechenzentrum, nicht an deinem Anschluss“ |
| R13 `identity-change` | IP-Adresskonflikt, Gateway-MAC-/DHCP-Server-Wechsel | „Fremdes/zweites Gerät im Netz“ |
| R14 `after-change` | Probleme begannen nach einer Konfigurationsänderung (Treiber, Kabel, Firmware) | Hinweis auf zeitlichen Zusammenhang |
| R15 `vpn-active` | VPN im Voll-Tunnel / Unterschied WARP an/aus | „VPN leitet Spieleverkehr um“ |
| R16 `data-quality` | wenig Daten, große Lücken, Abdeckung < 70 % | „Länger messen, Standby deaktivieren“ |
| R17 `top-cause` | Abschnitt mit dem größten Anteil gestörter Sekunden (hohe Sicherheit ab ≥ 3 Tagen, ≥ 100 gestörten Sekunden, ≥ 50 % Anteil) | **Hauptursache** |
| R18 `speed-below-tariff` | Download < 50 % des Tarifs (ohne Link-Begrenzung) | „Bandbreite unter Vertrag“ → Bundesnetzagentur-Breitbandmessung (nur mit 1-Gbit-Link!) |
| R19 `periodic-spikes` | Spikes in festem Abstand (Autokorrelation) | „Periodische Lag-Spitzen (Hintergrunddienst/WLAN-Scan)“ |
| R20 `router-instability` | Router-Neustarts/-Offline, langsame Oberfläche | „Router instabil“ → Störung melden, Tausch verlangen |

**Gaming-Score (0–100, Note A–F):** Produkt aus Faktoren für Latenz (p50), Jitter, Spitzen (p99−p50),
Verlust und Ausfälle pro Stunde; die Anzeige erklärt, welcher Faktor wie viele Punkte kostet.

**Nachweis einer Behebung:** Kabel/Port gilt als repariert, wenn die nächsten ≥ 10 Wiederaufbauten
alle mit 1 Gbit/s erfolgen und ≥ 7–9 Tage kein echter Abbruch auftritt. Immer **nur eine Änderung
zur Zeit** (Kabel → Port → Treiber) und als Notiz festhalten.

---

## 6. Datenhaltung

| Daten | Auflösung | Aufbewahrung |
|---|---|---|
| Rohmesswerte (jede Antwort, inkl. Kennzeichen Last/WLAN-Ausweichen) | 1 s je Ziel | 14 Tage (≈ 20 MB/Tag) |
| Minutenwerte (min/Ø/max/p50/p95/p99/Jitter/Verlust/Spikes + Histogramm) | 1 min | 400 Tage |
| Sekunden-Klassifizierung (Anzahl je Abschnitt) | 1 min | 400 Tage |
| Ereignisse | – | 10 Jahre |
| Kennzahlen (Adapter, WLAN, DOCSIS-Zusammenfassung, TCP, …) | 1–60 s | 90 Tage |
| Schnappschüsse (Router, DOCSIS-Tabellen, Adapter, NAT) | 5 min / bei Änderung | 60 Tage |
| Speedtests, Traceroutes | je Lauf | 10 Jahre (klein) |

Speicherort `data/netdiag.db` (SQLite). Export als CSV/JSON und druckbarer Bericht für Vodafone
(Zeitprofil, Ausfallliste, Traceroutes, DOCSIS-Werte, Router-Protokoll mit unkenntlich gemachten
MAC-Adressen, Link-Ereignisse, Speedtests).

---

## 7. Empfohlener Ablauf des Langzeittests

1. Tool starten (`npm run dev` bzw. `npm run start:all`), unter **Einstellungen** den Tarif und –
   für DOCSIS-Werte – das Router-Passwort eintragen (wird nur verschlüsselt lokal gespeichert).
2. **Langzeittest starten** (empfohlen 72 h, mindestens 24 h inkl. zweier Abende). Der Standby
   wird währenddessen automatisch verhindert; der PC darf nicht manuell schlafen gelegt werden.
3. Ganz normal spielen. Bei einem Lag den Knopf **„Lag jetzt markieren“** drücken.
4. Danach **Diagnose** öffnen: Hauptursache, Anteil gestörter Sekunden je Abschnitt, Belege,
   Empfehlungen. **Bericht** für Vodafone drucken/exportieren.
5. Eine Maßnahme umsetzen (z. B. neues Kabel), neuen Test starten und im **Vergleich** prüfen.

---

## 8. Hypothesen für diesen Anschluss

| # | Hypothese | Belegt durch | Widerlegt durch |
|---|---|---|---|
| 1 | **Kabel/Stecker/Port am PC** (Abbrüche, 100-Mbit-Rückfall) | echte Link-Abbrüche, LINK-Sekunden, 100-Mbit-Wiederaufbauten, Router meldet 100 Mbps | ≥ 10 Wiederaufbauten mit 1 Gbit/s, keine Abbrüche nach Kabeltausch |
| 2 | **Kabelzugangsnetz (DOCSIS/Segment)** – Ursache der Ping-Spitzen | ACCESS-Sekunden, Spikes der Kopfstation gleichzeitig mit Internet-Spikes, abends schlechter, DOCSIS-Werte/T3-T4 | Kopfstation stabil während der Lags |
| 3 | Andere Geräte/Downloads im Haushalt (Bufferbloat) | Spikes nur bei Last, schlechte Bufferbloat-Note, Test „ruhiger Haushalt“ hilft | keine Korrelation mit Last |
| 4 | Router-Instabilität (Neustarts) | Laufzeit-Rücksprünge, Router-Offline, Protokoll | Laufzeit durchgehend |
| 5 | Treiber I225-V | Abbrüche bleiben trotz neuem Kabel/Port | Abbrüche verschwinden nach Kabeltausch |
| 6 | DS-Lite/AFTR (nur IPv4) | AFTR-Sekunden, IPv4 schlechter als IPv6 | IPv4 = IPv6 |
| 7 | Vodafone-Backbone/Peering | BACKBONE-/REMOTE-Sekunden, nur bestimmte Ziele | alle Ziele gleich |
| 8 | PC-intern (CPU, VPN, Hintergrunddienste) | CPU-Spitzen, periodische Spikes | – |
