# Messdaten richtig deuten

Grundlage: `docs/research/methodology.md` (Schwellen, gestörte Sekunden), `docs/research/docsis-thresholds.md`
(Vodafone-Pegeltabelle, Ursachen-Signaturen §12, was Vodafone sehen will §13). Hier steht die Kurzfassung für die
Auswertung. Bei Zweifeln dort nachlesen, nicht raten.

## 1. Der Weg eines Pakets und wer zuständig ist

```
PC ──Kabel── Router ──Koax── Kabelnetz/CMTS ──── DS-Lite-Gateway (nur IPv4) ──── Vodafone-Netz ──── Internet ──── Spieleserver
 du           du/Router       Vodafone            Vodafone                         Vodafone           Dritte         Spieleanbieter
 gw (Router-Ping)            isp6 (1. IPv6-Hop)   aftr / isp4                      isp4               cf*/g*         aws-*
```

**Grundregel:** Die Störung beginnt am ersten Messpunkt, der schlecht ist, wenn alle Punkte davor gut sind.
Router sauber und erster Vodafone-Knoten (`isp6`) mit Spitzen heißt: Das Kabelnetz ist schuld, nicht das Heimnetz.
Darauf beruht die Klassifizierung der gestörten Sekunden (Abschnitt 2 in `fakten.md`).

| Klasse | Bedeutung | zuständig |
|---|---|---|
| link | Link-Abbruch der Netzwerkkarte bzw. WLAN-Umschaltung | du (Kabel, Port, Treiber) |
| lan | Router antwortet nicht oder langsam (Router-Ping gestört) | du / Router |
| access | Router ok, ab dem 1. Vodafone-Knoten (CMTS) gestört | **Vodafone** (Leitung, Hausverteilung, Segment) |
| aftr | IPv6 ok, nur IPv4 gestört | **Vodafone** (DS-Lite-Gateway) |
| backbone | CMTS ok, beide IP-Versionen weiter hinten gestört | Vodafone bzw. Übergang ins Internet |
| remote | nur einzelne Ziele (AWS) gestört, Cloudflare/Google sauber | Ziel bzw. Route, nicht der Anschluss |
| unknown | Muster passt in keine Klasse | – |

`selfLoad`-Sekunden (eigene Volllast) und Speedtest-Minuten sind schon herausgerechnet.

## 2. Was ist gut für Spiele? (methodology.md §2.2)

| Kennzahl | gut | ok | schlecht | kritisch |
|---|---|---|---|---|
| Ping Internet/Spiel p50 | ≤ 40 ms | ≤ 80 | > 80 | > 150 |
| Router p50 (Kabel) | ≤ 2 ms | ≤ 5 | > 5 | > 20 |
| 1. Vodafone-Knoten (CMTS) p50 | ≤ 15 ms | ≤ 30 | > 30 | > 60 |
| Jitter | ≤ 5 ms | ≤ 15 | > 15 | > 30 |
| Spitzen p99 − p50 | ≤ 20 ms | ≤ 50 | > 50 | > 150 |
| Lag-Spitzen ≥ 200 ms pro Stunde | 0 | ≤ 2 | > 2 | > 10 |
| Paketverlust | < 0,1 % | < 1 % | ≥ 1 % | ≥ 3 % |
| Bufferbloat (Latenz-Zuwachs unter Last) | < 30 ms | < 60 | ≥ 60 | ≥ 200 |
| Gestörte Sekunden | < 0,1 % | < 1 % | ≥ 1 % | ≥ 5 % |

Spieler merken vor allem **Spitzen und Verlust**, kaum den Median. Ein p50 von 25 ms mit p99 von 220 ms
fühlt sich schlecht an.

## 3. Muster → Ursache → Lösung

Die erste passende Zeile gilt. Mehrere Muster können gleichzeitig vorliegen; dann nach Anteil der gestörten
Sekunden priorisieren und Ursachen auf deiner Seite zuerst beheben (sie sind schnell erledigt und Vodafone fragt danach).

| Muster in `fakten.md` | Ursache | Was tun | Wer | Erfolgskontrolle |
|---|---|---|---|---|
| Link-Abbrüche (`nic-link-flaps`), Neuaufbau mit 100 Mbit/s (`nic-100m`) | Netzwerkkabel, Stecker, Router-Port oder Netzwerkkarte | neues Cat-6-Kabel direkt PC ↔ Station (ohne Dose, Kupplung oder Switch), anderen LAN-Port nehmen; danach Intel-Treiber; immer nur eine Änderung | du | neuer Langzeittest, `--vergleich`: 0 Link-Abbrüche, immer 1 Gbit/s |
| WLAN-Umschaltung bei Abbrüchen | Folge der Link-Abbrüche; jede Umschaltung trennt Spielverbindungen | Kabelproblem beheben; optional WLAN-Profil auf „Manuell verbinden“ | du | `wlanFailovers` = 0 |
| `lan`-Sekunden, Router-Ping p99 > 5 ms, Router-HTTP langsam | Router überlastet oder fehlerhaft | Router neu starten (einmal, notieren); bei Neustarts bzw. `router-instability`: Router-Tausch über Vodafone | du → Vodafone | Router-p99 < 3 ms |
| `access` hoch **und** DOCSIS kritisch/grenzwertig (Pegel, MER/SNR, Upstream-Modulation 16QAM, T3/T4 im Router-Log) | Leitungsproblem: Hausverkabelung, Dose, Verstärker oder Rückwegstörer im Segment | selbst: Koaxkabel Station ↔ Dose prüfen bzw. tauschen (kurz, gut geschirmt, F-Stecker fest), keine Verteiler, ungenutzte Koaxkabel entfernen, Powerline testweise abziehen; dann **Störung bei Vodafone melden, Techniker anfordern** | du (Kabel) → **Vodafone** | DOCSIS „gut“, `access` < 1 % |
| `access` hoch, DOCSIS gut, Störungen vor allem abends (18–23 Uhr) bzw. am Wochenende, morgens sauber | Überlastung des Kabelsegments („Lastproblem“) | Störung melden mit Tageszeit-Profil; Vodafone muss das Segment entlasten (Segmentsplit) – dauert oft | **Vodafone** | Abend-p95 ≈ Tages-p95 |
| `access` hoch, DOCSIS gut, rund um die Uhr | Störung im Netz (Knoten, CMTS, Rückweg) | Störung melden; Messung muss laufen, während die Störung aktiv ist | **Vodafone** | `access` < 1 % |
| `aftr` hoch (IPv4 schlechter als IPv6) | DS-Lite-Gateway (CGNAT) von Vodafone | Störung melden mit IPv4/IPv6-Vergleich; nach Dual-Stack (eigene öffentliche IPv4) fragen – Vodafone bietet das nicht überall bzw. garantiert an | **Vodafone** | IPv4 ≈ IPv6 |
| `backbone` hoch | Vodafone-Netz bzw. Übergabe ins Internet (Peering) | mit Traceroute an Vodafone melden | **Vodafone** | – |
| `remote` hoch, nur `aws-*` betroffen | Route zum Rechenzentrum oder Ziel antwortet ICMP nachrangig | andere Server-Region testen; prüfen, ob TCP/UDP-Ziele dasselbe zeigen. Spitzen nur bei ICMP zu AWS bei sauberem Cloudflare/Google sind **kein** Anschlussproblem und gehören nicht ins Vodafone-Schreiben | Spieleanbieter | – |
| Speedtest Upload-Bloat ≥ 60 ms (Note C–F) | Upload-Puffer im Modem; jeder Upload im Haushalt (Cloud-Backup, OneDrive, Steam, Stream, Videocall) treibt den Ping hoch | Uploads beim Spielen pausieren oder in den Apps begrenzen; Vodafone Station hat kein SQM bzw. Bufferbloat-Schutz; langfristig eigener Router mit SQM (FRITZ!Box/OpenWrt) hinter der Station | du | Bloat ↑ < 60 ms |
| Speed dauerhaft deutlich unter Tarif (per LAN, 1-Gbit/s-Link) | Leitung oder Segment | offizielle **Breitbandmessung** (Desktop-App der BNetzA, 30 Messungen an 3 Tagen innerhalb von 14 Tagen), dann Minderung nach § 57 Abs. 4 TKG | **Vodafone** | Protokoll „vertragskonform“ |
| `periodic-spikes` | Hintergrunddienst (Windows Update, OneDrive, Virenscanner, Launcher; macOS: Updates, iCloud, Time Machine, Spotlight) | genannten Takt mit Task-Manager/Aufgabenplanung (macOS: Aktivitätsanzeige) abgleichen | du | Spitzen weg |
| `vpn-active` mit vollem Tunnel | VPN leitet Spielverkehr um | VPN fürs Spielen aus bzw. Split-Tunnel | du | – |
| Router-Neustarts (`router-instability`) | Firmware oder Hardware | Neustartzeiten notieren, Vodafone-Router-Tausch verlangen | **Vodafone** | keine Neustarts |

## 4. DOCSIS-Werte lesen (docsis-thresholds.md)

- Bewertung nach **Vodafone-Servicetabelle (VFKD 17.06.2018)**: konform/toleriert ⇒ gut, „Beseitigung binnen
  Monatsfrist“ ⇒ grenzwertig, „sofortige Beseitigung“ ⇒ kritisch. Die App rechnet das schon (`rating`, `ratingNote`).
- Downstream SC-QAM 256QAM: Pegel −4 … +13 dBmV konform, MER ≥ 33 dB. OFDM (DOCSIS 3.1): für 4096QAM braucht
  es ≈ 41 dB MER, unter 35 dB ist kritisch. Pegel unter −6 dBmV ist zu schwach.
- Pegel-Schräglage über 10 dB zwischen niedrigen und hohen Frequenzen deutet auf Dämpfung oder Verstärker hin
  (Techniker: Einpegelung).
- Upstream: Sendepegel bis ≈ 47 (51) dBmV unkritisch; ab ≈ 54 dBmV mit OFDMA am Limit. **Upstream-Modulation
  16QAM statt 64QAM** heißt: Vodafone hat den Rückkanal wegen Störungen heruntergeschaltet, typisch für
  Rückwegstörer. Die OFDMA-Modulationsanzeige ist unzuverlässig (Firmware), dort nur als Hinweis werten.
- Die TG6442 liefert **keine Codewort-Zähler** („korrigiert/nicht korrigierbar“ = „–“). Das ist normal und
  kein Fehler; nie als „0 Fehler“ darstellen.
- Router-Log: T3-Häufungen, T4, SYNC-Verlust, „Ranging“ und Partial Service erklären Spitzen und Abbrüche.
  Kategorie `other` mit Meldung „info“ bedeutet: Meldungstext nicht lesbar, nicht interpretieren.

## 5. Aussagekraft ehrlich angeben

- **< 24 h gemessen:** „vorläufig“. Ohne Abend (18–23 Uhr) lässt sich Überlastung nicht beurteilen.
- **Sicherheit** der Regeln (gering, mittel, hoch) übernehmen; nichts als sicher darstellen, was die App als gering einstuft.
- Prozentwerte aus wenigen Messungen (z. B. ein Verlust von 3 % an einem Ziel durch einen einzelnen Burst, siehe
  `loss_burst` in Abschnitt 13) nicht verallgemeinern. Prüfen, ob andere Ziele zur selben Zeit betroffen waren.
- Link-Abbruch-Zahlen der letzten 7 Tage stammen aus dem Windows-Ereignisprotokoll (macOS: sekündliche Link-Überwachung der Mess-Engine, nur während Tests) und können **vor** einer
  Änderung (z. B. Kabeltausch) liegen. Immer mit „im Zeitraum“ vergleichen und das Datum des letzten Abbruchs nennen.
- Ein Befund der App ist nur eine Hypothese, wenn die Zahlen in `fakten.md` ihm widersprechen. Den Widerspruch
  offen benennen.
