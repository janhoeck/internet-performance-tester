# Netzpuls – Leitungsdiagnose

Lokales Tool für **Windows und macOS** für einen **Langzeittest deiner Internetverbindung**. Es findet heraus,
warum es in Spielen zu hohen Pings (> 200 ms) und Paketverlust kommt. Gemessen wird
**abschnittsweise und sekündlich**: PC & Netzwerkkarte → Router → Kabelnetz (DOCSIS) →
Vodafone/DS-Lite → Internet → Spieleserver. Die Diagnose zeigt, in welchem Abschnitt die
meisten gestörten Sekunden entstehen, und gibt konkrete Empfehlungen.

- **Was gemessen wird und warum:** [`docs/MESSPLAN.md`](docs/MESSPLAN.md) (auch in der App unter „Messplan“)
- **Technischer Aufbau:** [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)

## Voraussetzungen

- Windows 10/11 **oder** macOS 13 (Ventura) oder neuer (Intel und Apple Silicon), **keine Administratorrechte nötig**
- Node.js ≥ 22.5 (getestet mit 22.16) und npm
- macOS: keine Zusatzsoftware nötig (keine Xcode-Tools) – die Mess-Engine nutzt nur Bordmittel (`ping`, `traceroute`,
  `ifconfig`, `netstat`, `route`, `networksetup`, `system_profiler`, `pmset`, `caffeinate`, `security`)
- Für DOCSIS-Werte optional: Passwort deiner Vodafone Station

## Installation

```sh
npm install
```

Die Befehle sind unter Windows (PowerShell) und macOS (Terminal) gleich.

## Starten

| Zweck | Befehl | Hinweis |
|---|---|---|
| **Langzeittest (empfohlen)** | `npm run build` und danach `npm run start:all` | Produktionsmodus, startet Oberfläche und Mess-Engine; die Engine startet bei einem Absturz automatisch neu |
| Entwicklung | `npm run dev` | Oberfläche mit Hot Reload + Engine im Watch-Modus |
| Nur messen (ohne Oberfläche) | `npm run engine` | misst weiter, auch wenn kein Browser offen ist |

Danach im Browser öffnen: **http://127.0.0.1:3000**

Die Oberfläche und die Mess-Engine (Port 3901) sind nur auf deinem PC erreichbar (`127.0.0.1`).

## So führst du einen Langzeittest durch

1. **Einstellungen** öffnen: Tarif eintragen (z. B. 250/25 Mbit/s). Optional das Router-Passwort
   hinterlegen und „Login erlauben“ aktivieren – dann werden DOCSIS-Pegel, Störabstand und das
   Ereignisprotokoll der Vodafone Station mitgemessen. Das Passwort wird verschlüsselt lokal gespeichert
   (Windows: DPAPI, macOS: Schlüsselbund).
2. In der oberen Leiste **„Langzeittest starten“** – empfohlen 48–72 Stunden, mindestens 24 Stunden
   inklusive zweier Abende.
3. Während des Tests verhindert Netzpuls den automatischen Ruhezustand. Schicke den PC nicht manuell
   in den Standby, sonst entstehen Messlücken.
4. Ganz normal spielen. Bei einem Lag **„Lag markieren“** drücken – so lassen sich subjektive Lags
   mit den Messwerten abgleichen.
5. **Diagnose** öffnen: Hauptursache, Anteil gestörter Sekunden je Abschnitt, Belege, Empfehlungen.
6. **Bericht** drucken bzw. als PDF/JSON exportieren, z. B. für den Vodafone-Support. Welcher
   Langzeittest gezeigt wird, wählst du oben nach Namen (Standard: der laufende bzw. letzte Test).
7. Unter **Langzeittests** stehen alle Tests mit Namen und Kennzahlen. Von dort öffnest du einen Test
   als Bericht, Diagnose oder Verlauf – oder löschst ihn: nur den Eintrag oder samt Messdaten.
   Ein laufender Test lässt sich nicht löschen.
8. Nach einer Änderung (neues Kabel, anderer Port, Treiber, WLAN) einen neuen Test starten und unter
   **Verlauf → Vergleich zweier Tests** gegenüberstellen. Immer nur eine Änderung auf einmal.

Speedtests laufen automatisch alle 3 Stunden – nicht zwischen 18 und 23 Uhr, nicht während ein Spiel
läuft und nicht bei eigener Last (einstellbar). Ein Test überträgt bei schnellen Leitungen ca. 0,5 GB.

## Auswertung mit Claude Code (Skill `netz-auswertung`)

Im Projekt liegt ein Claude-Code-Skill (`.claude/skills/netz-auswertung/`). Er wertet die Messdaten aus und
schreibt eine verständliche Auswertung mit konkretem Maßnahmenplan. Auf Wunsch entsteht zusätzlich eine
Störungsmeldung an Vodafone (Anschreiben + Messprotokoll als PDF, Kurztext für Chat und Hotline).

- In Claude Code: `/netz-auswertung` bzw. „Werte meine Messdaten aus“. Mit Vodafone-Schreiben:
  `/netz-auswertung vodafone`. Vorher/nachher-Vergleich: `/netz-auswertung vergleich 3`.
- Die Datenbank wird nur gelesen; die Messung läuft währenddessen weiter.
- Ergebnisse landen in `berichte/<Datum_Uhrzeit>/` (`auswertung.pdf`, `vodafone-stoerungsmeldung.pdf`,
  `vodafone-kurztext.txt`). Der Ordner enthält persönliche Daten; er ist von Git ausgenommen. `daten.json`
  nicht verschicken.
- Die Skripte gehen auch ohne Claude:
  `npx tsx .claude/skills/netz-auswertung/scripts/collect.ts --liste` (Tests anzeigen),
  `… collect.ts [--session <id>] [--vergleich <id>]` (Faktenblatt `fakten.md`),
  `… render.ts <ordner> messprotokoll` (Messprotokoll als PDF).

## Daten

- Datenbank: `data/netdiag.db` (SQLite). Rohwerte 14 Tage, Minutenwerte und Ereignisse deutlich länger.
- Export: in der App (Bericht, Ereignisse) oder über `/api/export`.
- Beim ersten Start wird das Windows-Ereignisprotokoll importiert (Link-Abbrüche der Netzwerkkarte,
  Standby/Aufwachen, WLAN) – so siehst du auch die Vorgeschichte vor dem ersten Test. Unter macOS kommen
  Ruhezustand/Aufwachen aus `pmset` und – soweit macOS sie noch aufbewahrt – frühere Link-Meldungen aus dem
  Systemprotokoll.

## macOS

Netzpuls misst unter macOS dieselben Abschnitte mit demselben Datenmodell; Diagnose, Bericht und Oberfläche sind
identisch. Unterschiede (Details: [`docs/research/macos.md`](docs/research/macos.md)):

- **Pings:** Statt des PowerShell-Hintergrundprozesses startet die Mess-Engine jede Sekunde je Ziel einen `ping`-
  bzw. `ping6`-Aufruf (fester Sekundentakt, ohne Admin-Rechte). Das kostet etwas mehr CPU (≈ 1–3 % eines Kerns).
- **Link-Abbrüche:** macOS hat kein Ereignisprotokoll wie Windows. Die Mess-Engine erkennt Link-Abbrüche selbst –
  während eines Langzeittests sekündlich, sonst minütlich. Ruhezustand/Aufwachen kommen aus `pmset`.
- **Ruhezustand:** Während eines Tests verhindert `caffeinate` den automatischen Ruhezustand. Zuklappen eines
  MacBooks (ohne externen Monitor) schickt den Mac trotzdem schlafen – das erzeugt eine Messlücke.
- **WLAN:** Signal, Rauschabstand, Kanal und Senderate über `system_profiler`. Den Netzwerknamen (SSID) blenden neuere macOS-
  Versionen aus (Datenschutz), die BSSID ist ohne Administratorrechte nicht lesbar – Roaming wird nur über Kanalwechsel erkannt.
- **Adapter:** Anzeigenamen wie in den Systemeinstellungen („Ethernet“, „Wi-Fi“, „USB 10/100/1000 LAN“). Treiberversion
  und erweiterte Treiber-Eigenschaften gibt es unter macOS nicht.
- **TCP-Neuübertragungen:** macOS zählt IPv4 und IPv6 gemeinsam (nur ein Wert).
- **Router-Passwort:** im Schlüsselbund (Eintrag „Netzpuls-Router“).
- **Stand:** Die macOS-Unterstützung wurde ohne Mac entwickelt (Formate aus Dokumentation und Quelltext der
  Systemwerkzeuge, Tests mit nachgebauten Ausgaben). Die Prüfliste für den ersten echten Lauf steht in
  `docs/research/macos.md` §9.

## Wichtige Hinweise

- **Router-Adresse:** deine Vodafone Station ist unter **http://192.168.0.1** erreichbar.
  `easy.box` und `kabel.box` führen über das Internet zu **fremden Servern** – dort niemals ein
  Passwort eingeben. Netzpuls verbindet sich ausschließlich mit lokalen IP-Adressen.
- **Router-Login:** die Station erlaubt nur **eine** Admin-Sitzung. Netzpuls meldet sich nach jeder
  Abfrage (alle 5 Minuten) wieder ab. Falls du gleichzeitig in der Router-Oberfläche angemeldet bist,
  kann eine der beiden Sitzungen beendet werden. Nach einem falschen Passwort versucht Netzpuls es
  nicht erneut (Schutz vor der Sperre des Routers).
- **`fixtures/`** enthält echte Ausgaben von diesem PC (MAC- und IP-Adressen) – nicht veröffentlichen.

## Fehlerbehebung

| Problem | Lösung |
|---|---|
| „Mess-Engine nicht erreichbar“ | Läuft `npm run start:all` / `npm run dev` noch? Notfalls `npm run engine` separat starten. |
| „Engine läuft bereits (Port 3901 belegt)“ | Es läuft schon eine Engine – das ist in Ordnung. Sonst den alten Prozess im Task-Manager (macOS: Aktivitätsanzeige, Prozess „node“) beenden. |
| Keine DOCSIS-Werte | Router-Passwort in den Einstellungen hinterlegen und „Login erlauben“ aktivieren. |
| Router-Login gesperrt | Die Station sperrt nach Fehlversuchen für einige Minuten. Netzpuls wartet automatisch. |
| Messlücken über Nacht | PC wurde manuell in den Standby geschickt oder ausgeschaltet (macOS: auch Zuklappen des MacBooks). |
| macOS: kein WLAN-Name (SSID) | Neuere macOS-Versionen blenden den Namen für Programme ohne Ortungsfreigabe aus (Datenschutz) – die Funkwerte (Signal, Kanal, Rate) werden trotzdem gemessen. |

## Entwicklung

```powershell
npm test            # Unit-Tests (vitest)
npm run typecheck   # TypeScript
npm run lint        # ESLint
npx tsx scripts/seed-demo.ts   # Demo-Datenbank data/demo.db (2 Tage synthetische Daten)
$env:NETDIAG_DB = "data/demo.db"; npm run dev:web   # Oberfläche mit Demo-Daten (Engine nicht auf demo.db starten)
NETDIAG_DB=data/demo.db npm run dev:web              # dasselbe unter macOS (zsh/bash)
```

Recherche und Messgrundlagen (auf diesem PC verifiziert): `docs/research/`.
