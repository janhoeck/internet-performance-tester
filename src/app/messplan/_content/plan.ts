/**
 * Inhalt des Messplans (docs/MESSPLAN.md) als typisierte Daten für die Seite /messplan.
 * Hinweis Schriftsatz: nur Glyphen aus dem Latin-Subset (keine Pfeile, kein ≥/≤/≈/Δ/σ).
 */
import type { Severity } from "@/lib/health";
import type { HostOs } from "@/lib/shared/platform";

export interface Rating {
  status?: Severity;
  text: string;
}

export interface PlanFinding {
  lead: string;
  text: string;
  status: Severity;
  verdict: string;
}

export const PLAN_META = {
  asOf: "09.10.2026",
  pc: "Jan-PC (Windows 11, Intel I225-V Ethernet, Intel AX211 WLAN)",
  line: "Vodafone-Kabelanschluss mit DS-Lite",
  router: "Vodafone Station Wi-Fi 6 (ARRIS TG6442)",
  routerIp: "192.168.0.1",
};

export const GOAL = {
  title: "Die Ursache für hohe Pings (über 200 ms) und Paketverluste in Online-Spielen finden.",
  text:
    "Dazu wird die Verbindung abschnittsweise vom PC bis zum Spieleserver über Stunden bis Tage gemessen – jede Sekunde, alle Messpunkte im selben Takt. Fällt ein Abschnitt aus, sind alle Abschnitte dahinter mitbetroffen; der erste auffällige Abschnitt ist der Kandidat für die Ursache.",
};

export const ANALYSIS_SUMMARY = {
  title: "Es gibt sehr wahrscheinlich zwei unabhängige Probleme.",
  problems: [
    { n: 1, text: "Die Netzwerkverbindung am PC bricht zeitweise ab – das erklärt Verbindungsabbrüche im Spiel." },
    { n: 2, text: "Zusätzlich treten Latenzspitzen hinter dem Router auf – das erklärt „Ping über 200 ms“." },
  ],
};

export const FINDINGS: readonly PlanFinding[] = [
  {
    lead: "Netzwerkadapter Intel I225-V verliert im Betrieb die Verbindung.",
    text:
      "78 Link-down-Einträge seit 24.08.2026 (Quelle e2fexpress, ID 27). 59 davon sind normal (Treiber protokolliert bei jedem Start/Aufwachen), 19 sind echte Abbrüche im laufenden Betrieb mit je 3–22 s Komplettausfall – erst seit 26.09., zuletzt gehäuft (07./08.10.), einer live am 09.10. um 15:00:25.",
    status: "crit",
    verdict: "Problem 1 – erklärt Abbrüche im Spiel",
  },
  {
    lead: "Nach dem Wiederaufbau oft nur 100 Mbit/s statt 1 Gbit/s.",
    text:
      "Im Betrieb 8 von 19 (42 %), beim Start 22 von 59 (37 %). Zwischen 02. und 13.09. jedes Mal 100 Mbit/s, seit 25.09. meist 1 Gbit/s.",
    status: "crit",
    verdict: "Typisch für Kabel, Stecker oder Port (Gigabit braucht alle 4 Adernpaare), erst danach Treiber",
  },
  {
    lead: "Bei jedem Abbruch wechselt Windows binnen 1 s aufs WLAN.",
    text:
      "WLAN „Vodafone-43FE“ verbindet automatisch, 30–60 s später geht es zurück. Die IP-Adresse wechselt zweimal, es entsteht eine neue DS-Lite-NAT-Zuordnung und Spielverbindungen brechen ab. Der Ping zum Router läuft dabei über WLAN weiter – Abbrüche sind im Router-Ping kaum sichtbar.",
    status: "warn",
    verdict: "Folge, nicht Ursache – wird über Link-Status und Ausgangsschnittstelle sekündlich erfasst",
  },
  {
    lead: "08.10., 18:29–18:33: vermutlich Neustart der Vodafone Station.",
    text: "Ca. 4 min ohne Internet, auch das WLAN-Netz verschwand.",
    status: "warn",
    verdict: "Router- oder Leitungsereignis – wird künftig über Router-Laufzeit und -Ereignisprotokoll belegt",
  },
  {
    lead: "Stichprobe bei ruhendem PC: Spitzen hinter dem Router.",
    text:
      "Router 0–4 ms, aber Kopfstation (1. IPv6-Hop) 10–138 ms, AFTR 11–48 ms, Cloudflare einzelne Spitzen 120–160 ms, UDP bis ca. 215 ms – auf IPv4 und IPv6.",
    status: "warn",
    verdict: "Problem 2 (vorläufig, nur Sekunden gemessen): Spitzen entstehen im Kabelzugangsnetz oder durch andere Geräte im Haushalt – nicht DS-Lite, nicht dieser PC",
  },
  {
    lead: "Treiber 1.1.4.43 vom 15.02.2024 ist der ältere Windows-10-Treiberzweig (e2f).",
    text:
      "Für Windows 11 gibt es den NetAdapter-Treiber (e2fn 2.1.x, Paket 31.2.2 vom 10.07.2026). „Selective Suspend“ ist aktiv; EEE schaltet der Treiber bei Gigabit selbst ab.",
    status: "info",
    verdict: "Aktualisieren – nach dem Kabeltest",
  },
  {
    lead: "Router unter 192.168.0.1: Vodafone Station Wi-Fi 6 (ARRIS TG6442), Firmware 01.05.069.14.",
    text:
      "Umgangssprachlich „EasyBox“. Ohne Login: Status, Firmware, DS-Lite-Daten; mit Login: DOCSIS-Kanalwerte, Router-Ereignisprotokoll, Laufzeit, Geräteliste (inkl. Port-Geschwindigkeit des PCs). Fehlerzähler (Codewörter) liefert die Station nicht.",
    status: "info",
    verdict: "Information",
  },
  {
    lead: "DS-Lite: keine eigene öffentliche IPv4.",
    text:
      "Öffentlich sichtbar: 92.208.29.229 über Vodafones AFTR 2a00:0:cff:84a0::3. Das NAT-Verhalten ist günstig (endpunktunabhängiges Mapping und Filtering), Pfad-MTU IPv4 1460, IPv6 1500.",
    status: "good",
    verdict: "NAT-Typ unkritisch; IPv4 und IPv6 werden trotzdem getrennt gemessen",
  },
  {
    lead: "Cloudflare WARP (Firmen-VPN) im Split-Tunnel.",
    text: "Spieleverkehr läuft nicht durch den Tunnel, DNS wird nicht umgeleitet; WARP reagiert nur auf Abbrüche.",
    status: "good",
    verdict: "Nicht ursächlich",
  },
  {
    lead: "UPnP am Router deaktiviert.",
    text: "Bei DS-Lite üblich.",
    status: "info",
    verdict: "Information",
  },
  {
    lead: "Sicherheit: „easy.box“ und „kabel.box“ zeigen auf fremde Server.",
    text: "Beide Namen lösen (auch über den Router-DNS) zu Servern im Internet auf: 45.77.92.157, 45.77.75.133, 207.246.78.75.",
    status: "warn",
    verdict: "Router-Passwort nur unter http://192.168.0.1 eingeben",
  },
];

/** macOS: Messprinzip ohne PowerShell (jede Sekunde ein ping-Aufruf je Ziel). */
export const PRINCIPLE_TEXT_MAC =
  "Die Mess-Engine startet jede Sekunde für alle Ziele gleichzeitig einen Ping (macOS-Bordmittel, ohne Admin-Rechte) – auch bei Zeitüberschreitungen bleibt der Takt fest – und liest dabei sekündlich den Link-Status der Netzwerkanschlüsse. Daraus wird jede Sekunde einem Abschnitt zugeordnet; die erste zutreffende Regel gewinnt.";

export const PRINCIPLE = {
  text:
    "Ein PowerShell-Hintergrundprozess (.NET-Ping, ohne Admin-Rechte) pingt alle Ziele exakt im gleichen Sekundentakt – auch bei Zeitüberschreitungen bleibt der Takt fest – und meldet dabei sekündlich den Link-Status der Netzwerkadapter. Daraus wird jede Sekunde einem Abschnitt zugeordnet; die erste zutreffende Regel gewinnt.",
  after:
    "Zusätzlich je Sekunde: gestörte Sekunde (Verlust oder Ping-Spitze), stark gestörte Sekunde (mindestens die Hälfte der Internet-Pings verloren oder ab 200 ms) und Eigenlast (eigener Datenverkehr ab 80 % der Link- bzw. Tarifbandbreite). Die Diagnose zählt, in welchem Abschnitt die meisten gestörten Sekunden entstehen – das ist die wahrscheinlichste Ursache.",
};

export interface SecondClassRow {
  cls: string;
  /** FaultClass-ID für die Farbe aus der Segment-Rampe (null = neutral) */
  faultId: "link" | "lan" | "access" | "aftr" | "backbone" | "remote" | "unknown" | null;
  condition: string;
  segment: string;
}

export const SECOND_CLASSES: readonly SecondClassRow[] = [
  { cls: "ausgeschlossen", faultId: null, condition: "Keine Messung (Standby, Lücke)", segment: "–" },
  {
    cls: "LINK",
    faultId: "link",
    condition: "Erwartete Verbindung (z. B. Ethernet) unterbrochen, Verkehr läuft über eine andere Schnittstelle (WLAN-Ausweichen) oder bis 60 s nach Wiederaufbau",
    segment: "PC & Adapter",
  },
  { cls: "LAN", faultId: "lan", condition: "Router-Ping verloren oder Ping-Spitze", segment: "Heimnetz" },
  { cls: "gut", faultId: null, condition: "Keine Verluste oder Ping-Spitzen auf den Referenzzielen", segment: "–" },
  { cls: "ACCESS", faultId: "access", condition: "Router gut, Kopfstation schlecht, IPv4 und IPv6 gestört", segment: "Kabelnetz (DOCSIS)" },
  { cls: "AFTR", faultId: "aftr", condition: "IPv4 gestört, IPv6 sauber", segment: "DS-Lite-Gateway" },
  { cls: "BACKBONE", faultId: "backbone", condition: "Kopfstation gut, IPv4 und IPv6 gestört", segment: "Vodafone-Netz" },
  { cls: "REMOTE", faultId: "remote", condition: "Nur Spieleserver gestört", segment: "Weg zum Rechenzentrum" },
  { cls: "unklar", faultId: "unknown", condition: "Gestört, aber keine Regel passt", segment: "–" },
];

export interface MeasureRow {
  metric: string;
  key?: boolean;
  method: string;
  interval: string;
  rating: readonly Rating[];
  purpose: string;
}

/**
 * macOS: Messmethoden der Mess-Engine unter macOS (docs/research/macos.md). Schlüssel = Windows-Angabe
 * in den Tabellen unten; Zeilen, die es unter macOS nicht gibt, stehen in MAC_HIDDEN_METRICS.
 */
const MAC_METHODS: Readonly<Record<string, string>> = {
  ".NET NetworkInterface im Ping-Prozess": "ifconfig und netstat in jedem Messtakt",
  "wevtutil (Intel e2fexpress/e2fnexpress, Kernel-Boot/-Power, WLAN-AutoConfig); Import der gesamten Historie":
    "Sekündliche Link-Überwachung im Test, pmset-Protokoll (Ruhezustand), Import früherer Link-Meldungen aus dem Systemprotokoll",
  "Get-NetAdapterStatistics": "netstat -ibn",
  "netsh wlan show interfaces": "system_profiler (SSID oft ausgeblendet, ohne BSSID)",
  "PowerShell, Ereignis Tcpip 4199": "route, arp, ipconfig, scutil",
  "Leistungszähler TCPv4/TCPv6": "netstat -s (TCP gesamt)",
  "Ereignisprotokoll und Timer-Lücken": "pmset-Protokoll und Timer-Lücken",
  ".NET-Ping": "ping im Sekundentakt",
  ".NET-Ping IPv6": "ping6 im Sekundentakt",
  "TTL-Pings (.NET)": "traceroute (TTL-Proben)",
  "TTL-Pings; Verlust zählt nur, wenn er bis zum Ziel bestehen bleibt": "traceroute-TTL-Proben; Verlust zählt nur, wenn er bis zum Ziel bestehen bleibt",
};

const MAC_METRICS: Readonly<Record<string, string>> = {
  "Link-Abbrüche aus dem Windows-Ereignisprotokoll inkl. Einordnung (Start/Aufwachen, vor Standby, Router-Neustart, echter Abbruch), Geschwindigkeit nach Wiederaufbau, Ausfalldauer, WLAN-Ausweichen":
    "Link-Abbrüche inkl. Einordnung (Start/Aufwachen, vor dem Ruhezustand, Router-Neustart, echter Abbruch), Geschwindigkeit nach Wiederaufbau, Ausfalldauer, WLAN-Ausweichen",
  "Identität: Gateway-MAC, DHCP- und DNS-Server, IPv6-Präfix, IP-Konflikte": "Identität: Gateway-MAC, DHCP- und DNS-Server, IPv6-Präfix",
  "WLAN (falls verbunden): SSID, BSSID, Signal %, RSSI, Kanal, Band, Raten": "WLAN (falls verbunden): SSID, Signal %, RSSI, Kanal, Band, Senderate",
};

/** Zeilen ohne macOS-Entsprechung (Treiber-Eigenschaften aus dem Gerätemanager). */
const MAC_HIDDEN_METRICS: ReadonlySet<string> = new Set(["Treiber und Energiespar-Einstellungen"]);

/** Tabellenzeilen mit den Messmethoden des Betriebssystems, auf dem die Mess-Engine läuft. */
export function measureRowsFor(rows: readonly MeasureRow[], os: HostOs): readonly MeasureRow[] {
  if (os !== "macos") return rows;
  return rows
    .filter((r) => !MAC_HIDDEN_METRICS.has(r.metric))
    .map((r) => ({ ...r, metric: MAC_METRICS[r.metric] ?? r.metric, method: MAC_METHODS[r.method] ?? r.method }));
}

export interface MeasureGroup {
  id: string;
  num: string;
  title: string;
  ratingHeader?: string;
  rows: readonly MeasureRow[];
  note?: string;
}

const C = (text: string): Rating => ({ status: "crit", text });
const W = (text: string): Rating => ({ status: "warn", text });
const G = (text: string): Rating => ({ status: "good", text });
const I = (text: string): Rating => ({ status: "info", text });
const T = (text: string): Rating => ({ text });

export const MEASURE_GROUPS: readonly MeasureGroup[] = [
  {
    id: "pc",
    num: "3.1",
    title: "PC & Netzwerkadapter",
    rows: [
      {
        metric: "Link-Status, Link-Geschwindigkeit, Byte- und Fehlerzähler",
        key: true,
        method: ".NET NetworkInterface im Ping-Prozess",
        interval: "1 s (Test)",
        rating: [C("Link getrennt"), W("unter 1000 Mbit/s")],
        purpose: "Abbrüche sekundengenau, 100-Mbit-Rückfall",
      },
      {
        metric: "Ausgangsschnittstelle IPv4/IPv6 (Ethernet oder WLAN?)",
        key: true,
        method: "Lokale Quelladresse ohne Paketversand",
        interval: "1 s (Test)",
        rating: [C("andere als die erwartete Schnittstelle")],
        purpose: "WLAN-Ausweichen bei Kabelabbruch",
      },
      {
        metric: "Link-Abbrüche aus dem Windows-Ereignisprotokoll inkl. Einordnung (Start/Aufwachen, vor Standby, Router-Neustart, echter Abbruch), Geschwindigkeit nach Wiederaufbau, Ausfalldauer, WLAN-Ausweichen",
        method: "wevtutil (Intel e2fexpress/e2fnexpress, Kernel-Boot/-Power, WLAN-AutoConfig); Import der gesamten Historie",
        interval: "immer, 60 s",
        rating: [C("echter Abbruch")],
        purpose: "Physische Verbindung oder Treiber instabil",
      },
      { metric: "Eigene Datenrate (Empfang/Senden)", method: "Differenz der Byte-Zähler", interval: "1 s", rating: [T("–")], purpose: "Lädt der PC selbst gerade viel? (Eigenlast)" },
      { metric: "Adapterfehler, verworfene Pakete (Zuwachs)", method: "Get-NetAdapterStatistics", interval: "10 s", rating: [W("über 0")], purpose: "Störungen auf dem Kabel" },
      { metric: "Treiber und Energiespar-Einstellungen", method: "Get-NetAdapterAdvancedProperty", interval: "10 min", rating: [I("Selective Suspend an")], purpose: "Bekannte Ursachen" },
      {
        metric: "WLAN (falls verbunden): SSID, BSSID, Signal %, RSSI, Kanal, Band, Raten",
        method: "netsh wlan show interfaces",
        interval: "15 s",
        rating: [W("Signal unter 60 % bzw. RSSI unter −67 dBm")],
        purpose: "Funkqualität, Roaming",
      },
      { metric: "VPN/WARP-Status und Modus", method: "warp-cli -j", interval: "2 min", rating: [W("Voll-Tunnel")], purpose: "Läuft Spieleverkehr durchs VPN?" },
      {
        metric: "Identität: Gateway-MAC, DHCP- und DNS-Server, IPv6-Präfix, IP-Konflikte",
        method: "PowerShell, Ereignis Tcpip 4199",
        interval: "60 s",
        rating: [C("Wechsel oder Konflikt")],
        purpose: "Fremdes Gerät, falsche Konfiguration",
      },
      { metric: "Laufendes Spiel", method: "Prozessliste (konfigurierbar)", interval: "60 s", rating: [T("–")], purpose: "Speedtests pausieren, Spielzeiten markieren" },
      { metric: "TCP-Neuübertragungen (systemweit)", method: "Leistungszähler TCPv4/TCPv6", interval: "60 s", rating: [W("über 1 %")], purpose: "Paketverlust im realen Verkehr" },
      { metric: "CPU-Last, Speicher, Messgenauigkeit (Engine-Verzögerung)", method: "Node", interval: "10 s", rating: [T("–")], purpose: "Qualitätskontrolle" },
      {
        metric: "Standby und Aufwachen",
        method: "Ereignisprotokoll und Timer-Lücken",
        interval: "immer",
        rating: [T("–")],
        purpose: "Zählt nicht als Ausfall; Standby wird während eines Tests verhindert (abschaltbar)",
      },
    ],
  },
  {
    id: "heimnetz",
    num: "3.2",
    title: "Heimnetz & Router",
    ratingHeader: "Bewertung (Median)",
    rows: [
      {
        metric: "Ping Router IPv4 (192.168.0.1) und IPv6 (link-lokal)",
        key: true,
        method: ".NET-Ping",
        interval: "1 s",
        rating: [G("bis 2 ms"), W("bis 5 ms"), C("Verlust über 0 %")],
        purpose: "Strecke PC und Router",
      },
      { metric: "Router-DNS-Antwortzeit", method: "DNS über UDP", interval: "10 s", rating: [T("–")], purpose: "Router-Auslastung" },
      { metric: "Router-Weboberfläche (TCP-Aufbau)", method: "TCP :80", interval: "10 s", rating: [W("p95 über 50 ms")], purpose: "Router überlastet" },
      {
        metric: "Router-Status ohne Login",
        method: "Startseite (modemConnectionStatus, Firmware, WAN-IPv6, AFTR, Neustartgrund, Sperrzeit, DFS, Band Steering) und Antwortzeit",
        interval: "60 s",
        rating: [C("nicht „DOCSIS Online“")],
        purpose: "Modem offline oder Resync",
      },
      {
        metric: "Geräte am Router inkl. Port-Geschwindigkeit des PCs",
        method: "overview_data.php (Login)",
        interval: "5 min",
        rating: [W("PC mit „100 Mbps“")],
        purpose: "100-Mbit-Problem aus Routersicht",
      },
    ],
  },
  {
    id: "docsis",
    num: "3.3",
    title: "Kabelleitung (DOCSIS) – mit Router-Login",
    rows: [
      { metric: "Downstream-Pegel und SNR/MER je Kanal (SC-QAM und OFDM)", method: "status_docsis_data.php", interval: "5 min", rating: [T("Vodafone-Richtwerte (siehe unten)")], purpose: "Signal, Störabstand, Einstrahlung" },
      { metric: "Upstream-Pegel je Kanal (SC-QAM und OFDMA), Reserve bis zur Sendegrenze", method: "status_docsis_data.php", interval: "5 min", rating: [T("Vodafone-Richtwerte")], purpose: "Rückkanal, Dämpfung" },
      { metric: "Modulation, Lock-Status, Kanalanzahl (Partial Service), Pegel-Schräglage", method: "status_docsis_data.php", interval: "5 min", rating: [C("Kanalverlust")], purpose: "Leitung verliert Kanäle" },
      {
        metric: "Router-Ereignisprotokoll (T3/T4-Timeouts, Sync-Verlust, Ranging, Partial Service, CM-STATUS)",
        method: "status_event_log_data.php",
        interval: "15 min",
        rating: [W("T3 vereinzelt"), C("gehäuft, T4 oder Sync-Verlust")],
        purpose: "Rückkanalstörungen, Resyncs",
      },
      { metric: "Router-Laufzeit (Neustarts)", method: "status_status_data.php", interval: "5 min", rating: [C("Rücksprung = Neustart")], purpose: "Instabiler Router, Resyncs" },
      {
        metric: "Ping Kopfstation (CMTS, 1. IPv6-Hop)",
        key: true,
        method: ".NET-Ping",
        interval: "1 s",
        rating: [G("Median bis 15 ms"), W("bis 30 ms")],
        purpose: "Kabelstrecke ohne DS-Lite",
      },
    ],
    note:
      "Der Router erlaubt nur eine Admin-Sitzung: Netzpuls meldet sich nach jeder Abfrage wieder ab, fragt höchstens alle 5 Minuten ab und versucht es bei falschem Passwort nie automatisch erneut (Schutz vor Sperre).",
  },
  {
    id: "zugang",
    num: "3.4",
    title: "Vodafone-Zugang, DS-Lite & Backbone",
    rows: [
      { metric: "Ping AFTR (DS-Lite-Gateway, Adresse vom Router)", key: true, method: ".NET-Ping IPv6", interval: "1 s", rating: [G("Median bis 25 ms")], purpose: "Carrier-NAT-Knoten" },
      {
        metric: "Ping 1. IPv4-Hop hinter dem AFTR",
        method: ".NET-Ping",
        interval: "1 s",
        rating: [G("Median bis 25 ms")],
        purpose: "Vodafone-Backbone (antwortet nicht immer – nur ergänzend)",
      },
      {
        metric: "IPv4 und IPv6 zu denselben Zielen",
        key: true,
        method: "Paare Cloudflare/Google (ICMP, UDP, TCP)",
        interval: "1–10 s",
        rating: [C("IPv4 deutlich schlechter: AFTR")],
        purpose: "Isoliert DS-Lite-Probleme",
      },
      { metric: "Pfaderkennung (Hops 1–8) und Routenwechsel", method: "TTL-Pings (.NET)", interval: "15 min und bei Ausfall", rating: [I("Wechsel")], purpose: "Neue Wege, Hop-Adressen für die Messziele" },
      {
        metric: "MTR (20 Pings je Hop) mit korrekter Auswertung",
        method: "TTL-Pings; Verlust zählt nur, wenn er bis zum Ziel bestehen bleibt",
        interval: "60 min und bei Ausfall",
        rating: [C("Verlust ab Hop X bis zum Ziel")],
        purpose: "Wo genau Verlust beginnt",
      },
      { metric: "Pfad-MTU IPv4/IPv6", method: "Ping mit DF-Bit, Binärsuche", interval: "täglich", rating: [I("IPv4 unter 1460")], purpose: "Fragmentierung" },
      {
        metric: "NAT-Verhalten, öffentliche IPv4 (CGNAT-Ausgang)",
        method: "STUN (Google, Cloudflare), o-o.myaddr.l.google.com",
        interval: "30 min und bei Wechsel",
        rating: [W("endpunktabhängig = strikter NAT")],
        purpose: "P2P in Spielen, IP-Wechsel",
      },
    ],
  },
  {
    id: "internet",
    num: "3.5",
    title: "Internet & Spieleserver",
    rows: [
      {
        metric: "Ping Cloudflare 1.1.1.1 / IPv6, Google 8.8.8.8 / IPv6",
        key: true,
        method: ".NET-Ping",
        interval: "1 s",
        rating: [G("Median bis 40 ms, Verlust unter 0,1 %"), W("bis 80 ms, Verlust unter 1 %")],
        purpose: "Grundqualität ins Internet",
      },
      {
        metric: "UDP-Laufzeit wie Spieleverkehr (DNS-Abfrage „id.server“ – beantwortet der Cloudflare-Knoten direkt) IPv4/IPv6",
        key: true,
        method: "UDP",
        interval: "5 s",
        rating: [T("wie Ping Internet")],
        purpose: "UDP durch NAT und AFTR",
      },
      { metric: "UDP-Burst (20 Pakete/s für 10 s)", method: "UDP", interval: "5 min", rating: [C("Verlust über 1 %")], purpose: "Verlust und Jitter bei spieltypischer Paketrate" },
      { metric: "TCP-Verbindungsaufbau Cloudflare (IPv4/IPv6)", method: "TCP :443", interval: "10 s", rating: [T("wie Ping Internet")], purpose: "Verbindungsaufbau" },
      {
        metric: "TCP-Verbindungsaufbau AWS Frankfurt / Irland",
        method: "TCP :443",
        interval: "10 s",
        rating: [G("Median bis 40 ms"), W("bis 80 ms")],
        purpose: "Weg zu typischen Spiele-Rechenzentren",
      },
      { metric: "Eigene Ziele (IP des Spieleservers)", method: "ICMP, TCP oder UDP konfigurierbar", interval: "frei", rating: [T("–")], purpose: "Direkt das eigene Spiel" },
    ],
  },
];

export interface KpiRow {
  name: string;
  definition: string;
  good: string;
  warn: string;
  bad: string;
}

export const KPI_ROWS: readonly KpiRow[] = [
  { name: "Latenz", definition: "Median (p50), dazu p95, p99 und Maximum", good: "je Abschnitt (siehe oben)", warn: "", bad: "" },
  { name: "Jitter", definition: "Mittlere Differenz aufeinanderfolgender erfolgreicher Pings (Verlust unterbricht die Kette)", good: "bis 5 ms", warn: "bis 15 ms", bad: "über 15 ms" },
  { name: "Ping-Spitzen", definition: "p99 minus Median", good: "bis 20 ms", warn: "bis 50 ms", bad: "über 50 ms" },
  { name: "Lag-Spitzen", definition: "Pings ab 200 ms pro Stunde", good: "0", warn: "bis 2", bad: "über 2" },
  { name: "Paketverlust", definition: "Verlorene Pings (mit 95-%-Konfidenzintervall)", good: "unter 0,1 %", warn: "unter 1 %", bad: "ab 1 %" },
  { name: "Ausfälle", definition: "Mindestens 3 s ohne Antwort auf mindestens 2 Internet-Zielen", good: "0 pro Tag", warn: "bis 1 pro Tag", bad: "über 1 pro Tag" },
  {
    name: "Ping-Spitze (Einzelwert)",
    definition: "Ping ab Median + max(5-fache robuste Streuung, 25 ms) – im Heimnetz 10 ms –, Streuung per MAD; oder ab 200 ms",
    good: "",
    warn: "",
    bad: "",
  },
];

export const THROUGHPUT_ROWS: readonly MeasureRow[] = [
  {
    metric: "Download/Upload",
    method: "Cloudflare, 6/4 parallele Verbindungen, je 15 s",
    interval: "Alle 3 h, nicht 18–23 Uhr, nicht während eines Spiels, bei Eigenlast oder Ausfall; jederzeit manuell",
    rating: [C("unter 50 % des Tarifs")],
    purpose: "Bandbreite; Begrenzung durch einen 100-Mbit-Link wird markiert",
  },
  {
    metric: "Latenz unter Last (Download/Upload getrennt, alle 200 ms)",
    key: true,
    method: "UDP „id.server“ und Ping Router/Kopfstation/AFTR",
    interval: "je Test",
    rating: [T("Anstieg: A+ unter 5, A unter 30, B unter 60, C unter 200, D unter 400, F ab 400 ms")],
    purpose: "Bufferbloat; welcher Abschnitt puffert (Router-Ping steigt: LAN-Link; Kopfstation steigt beim Upload: Modem-Puffer)",
  },
];

/** Ereignis-Erkennung mit den Werkzeugen des Betriebssystems (macOS ohne PowerShell). */
export function eventRowsFor(os: HostOs): readonly { event: string; detection: string }[] {
  if (os !== "macos") return EVENT_ROWS;
  return EVENT_ROWS.map((r) => ({ ...r, detection: r.detection.replace("PowerShell", "Systemwerkzeuge (route, arp, scutil)") }));
}

export const EVENT_ROWS: readonly { event: string; detection: string }[] = [
  { event: "Ausfall", detection: "Mindestens 3 s keine Antwort von mindestens 2 Internet-Zielen; Einordnung PC, Heimnetz, Kabel, AFTR (nur IPv4), Backbone oder Internet" },
  { event: "Verlust-Burst", detection: "Mindestens 2 Verluste in 10 s auf einem Ziel" },
  { event: "Ping-Spitzen-Episode", detection: "Ping-Spitzen zusammengefasst (Lücke bis 2 s), Schwere: leicht, deutlich (+50 ms), schwer (ab 200 ms oder +150 ms)" },
  { event: "Periodische Ping-Spitzen", detection: "Häufigkeitsanalyse der Abstände (z. B. alle 60 s: Hintergrunddienst oder WLAN-Scan)" },
  { event: "Link-Abbruch, WLAN-Ausweichen, Schnittstellenwechsel", detection: "Link-Status jede Sekunde und Ereignisprotokoll" },
  { event: "Routenwechsel, IP-/AFTR-Wechsel, Identitätswechsel", detection: "Pfaderkennung, STUN, Router, PowerShell" },
  { event: "Router-Neustart, Router offline, DOCSIS-Ereignisse", detection: "Router-Abfragen" },
  { event: "Speedtest-Fenster", detection: "Werden aus den Statistiken herausgerechnet" },
  { event: "Messlücke", detection: "Timer-Lücke über 5 s oder Standby – kein Ausfall" },
  { event: "Notiz „Lag jetzt“", detection: "Knopf im Dashboard – subjektive Lags mit Messdaten abgleichen" },
];

export interface DocsisRow {
  value: string;
  conform: string;
  tolerated: string;
  month: string;
  critical: string;
}

export const DOCSIS_ROWS: readonly DocsisRow[] = [
  { value: "Downstream-Pegel 256QAM", conform: "−4 bis +13 dBmV", tolerated: "−6 bis −4 / +13 bis +18", month: "−8 bis −6 / +18 bis +20", critical: "unter −8 / über +20" },
  { value: "Downstream-Pegel 64QAM", conform: "−10 bis +7 dBmV", tolerated: "−12 bis −10 / +7 bis +12", month: "−14 bis −12 / +12 bis +14", critical: "darüber hinaus" },
  { value: "Downstream-Pegel OFDM / 1024QAM", conform: "−2 bis +15 dBmV", tolerated: "−4 bis −2 / +15 bis +20", month: "−6 bis −4 / +20 bis +22", critical: "darüber hinaus" },
  { value: "Downstream-SNR 256QAM", conform: "über 33 dB", tolerated: "32 bis 33", month: "30 bis 32", critical: "bis 30" },
  { value: "Downstream-SNR 64QAM", conform: "über 27 dB", tolerated: "26 bis 27", month: "24 bis 26", critical: "bis 24" },
  { value: "OFDM-MER", conform: "mind. benötigter CNR der Modulation + 3 dB (4096QAM: 41 dB)", tolerated: "", month: "mind. benötigter CNR", critical: "darunter" },
  { value: "Upstream-Pegel SC-QAM", conform: "41 bis 47 dBmV", tolerated: "37 bis 41 / 47 bis 51", month: "35 bis 37 / 51 bis 53", critical: "unter 35 / über 53" },
  { value: "Upstream-Pegel OFDMA", conform: "44 bis 47 dBmV", tolerated: "40 bis 44 / 47 bis 48", month: "38 bis 40 / 48 bis 50", critical: "darüber hinaus" },
  { value: "Router-Protokoll T3-Timeout", conform: "–", tolerated: "vereinzelt", month: "–", critical: "mind. 3 in 10 min oder mind. 10 pro Tag" },
  { value: "T4-Timeout, Sync-Verlust, „Retries exhausted“", conform: "–", tolerated: "–", month: "–", critical: "jedes Auftreten" },
];

export const DOCSIS_NOTE =
  "Zusatzprüfungen: SNR-Ausreißer (mind. 3 dB unter dem Median gleicher Modulation – Einstrahlungsverdacht, z. B. LTE 800 MHz), Nachbarkanäle mit über 6 dB Unterschied, Schräglage über 10 dB, Kanalverlust gegenüber der 7-Tage-Basis, Sendereserve des Modems. Die Vodafone Station liefert keine Codewort-Fehlerzähler.";

export const DOCSIS_SOURCE =
  "Quelle: Vodafone-Kabel-Servicetabelle (17.06.2018, Grundlage der pNTP-Schnittstellenspezifikation). Stufen: konform und toleriert gelten als Gut, Monatsfrist als Auffällig, sofort als Kritisch.";

export interface RuleRow {
  id: string;
  slug: string;
  trigger: string;
  finding: string;
}

export const RULES: readonly RuleRow[] = [
  { id: "R01", slug: "nic-link-flaps", trigger: "Mind. 3 echte Link-Abbrüche in 7 Tagen oder mind. 3 in 30 min", finding: "„Netzwerkverbindung am PC bricht ab“ – Kabel direkt PC und Station tauschen (Cat 6, ohne Dose/Kupplung), anderen LAN-Port nehmen, Stecker prüfen; danach Treiber" },
  { id: "R02", slug: "nic-100m", trigger: "Mind. 20 % der Wiederaufbauten unter 1 Gbit/s (mind. 5 Fälle) oder über 10 min bei 100 Mbit/s; Router meldet „100 Mbps“", finding: "„Kabel/Port schafft kein Gigabit“; Test: „Speed & Duplex“ kurz auf „1.0 Gbps Full Duplex“" },
  { id: "R03", slug: "wlan-failover", trigger: "WLAN-Ausweichen bei mind. 50 % der Abbrüche", finding: "„Windows wechselt bei Abbrüchen aufs WLAN – Spielverbindungen brechen trotzdem ab“" },
  { id: "R04", slug: "bufferbloat-load", trigger: "p95 unter Last mind. 50 ms höher bzw. Note C oder schlechter", finding: "„Lags unter Last“ – QoS oder Bandbreitenbegrenzung, Downloads pausieren; LAN-Variante, wenn der Router-Ping steigt (100-Mbit-Link)" },
  { id: "R05", slug: "lan-quality", trigger: "Router-Verlust mind. 0,5 % pro Stunde oder p99 mind. 20 ms bei stehendem Link", finding: "„Problem zwischen PC und Router“" },
  { id: "R06", slug: "lan-unreachable", trigger: "Router mind. 30 s nicht erreichbar bei stehendem Link", finding: "„Router reagiert nicht“" },
  { id: "R07", slug: "access-spikes", trigger: "Mind. 70 % der Internet-Spitzen gleichzeitig (±1 s) mit Spitzen der Kopfstation, Router p99 unter 10 ms, Eigenlast unter 20 %", finding: "„Störung/Überlastung im Kabelnetz“ – Vodafone-Störung melden (Bericht exportieren)" },
  { id: "R08", slug: "household-load", trigger: "Spitzen fallen mit hoher Eigen- oder Gesamtlast zusammen; Test „ruhiger Haushalt“ halbiert die Spitzen", finding: "„Andere Geräte/Downloads verursachen Lags“" },
  { id: "R09", slug: "docsis-values", trigger: "DOCSIS-Werte außerhalb der Richtwerte, T3/T4-Häufung, Kanalverlust, Router-Neustarts", finding: "„Leitungswerte auffällig“ – Techniker (Hausverkabelung, Dose, Verstärker)" },
  { id: "R10", slug: "peak-hours", trigger: "19–23 Uhr Median mind. Basis (03–17 Uhr) + 15 ms bzw. × 1,5 oder Verlust über 0,5 % an mind. 3 Tagen, Router dabei unter 3 ms", finding: "„Überlastung zu Stoßzeiten (Segment)“" },
  { id: "R11", slug: "ipv4-vs-ipv6", trigger: "IPv4 in mind. 30 % der 15-min-Fenster mind. 1 Prozentpunkt mehr Verlust oder mind. 30 ms höheres p95 – bei beiden Anbieter-Paaren", finding: "„DS-Lite-Gateway (AFTR) überlastet“ – Dual-Stack bei Vodafone anfragen, IPv6 nutzen" },
  { id: "R12", slug: "remote-only", trigger: "Nur der Weg zum Spieleserver gestört", finding: "„Problem auf dem Weg zum Rechenzentrum, nicht an deinem Anschluss“" },
  { id: "R13", slug: "identity-change", trigger: "IP-Adresskonflikt, Wechsel von Gateway-MAC oder DHCP-Server", finding: "„Fremdes/zweites Gerät im Netz“" },
  { id: "R14", slug: "after-change", trigger: "Probleme begannen nach einer Konfigurationsänderung (Treiber, Kabel, Firmware)", finding: "Hinweis auf zeitlichen Zusammenhang" },
  { id: "R15", slug: "vpn-active", trigger: "VPN im Voll-Tunnel bzw. Unterschied WARP an/aus", finding: "„VPN leitet Spieleverkehr um“" },
  { id: "R16", slug: "data-quality", trigger: "Wenig Daten, große Lücken, Abdeckung unter 70 %", finding: "„Länger messen, Standby deaktivieren“" },
  { id: "R17", slug: "top-cause", trigger: "Abschnitt mit dem größten Anteil gestörter Sekunden (hohe Sicherheit ab 3 Tagen, 100 gestörten Sekunden und 50 % Anteil)", finding: "Hauptursache" },
  { id: "R18", slug: "speed-below-tariff", trigger: "Download unter 50 % des Tarifs (ohne Link-Begrenzung)", finding: "„Bandbreite unter Vertrag“ – Breitbandmessung der Bundesnetzagentur (nur mit 1-Gbit-Link)" },
  { id: "R19", slug: "periodic-spikes", trigger: "Spitzen in festem Abstand (Autokorrelation)", finding: "„Periodische Lag-Spitzen (Hintergrunddienst/WLAN-Scan)“" },
  { id: "R20", slug: "router-instability", trigger: "Router-Neustarts oder -Offline, langsame Oberfläche", finding: "„Router instabil“ – Störung melden, Tausch verlangen" },
];

export const SCORE_TEXT =
  "Gaming-Score (0–100, Note A–F): Produkt aus Faktoren für Latenz (Median), Jitter, Ping-Spitzen (p99 minus Median), Verlust und Ausfälle pro Stunde; die Anzeige erklärt, welcher Faktor wie viele Punkte kostet.";

export const FIX_PROOF_TEXT =
  "Nachweis einer Behebung: Kabel/Port gilt als repariert, wenn die nächsten mind. 10 Wiederaufbauten alle mit 1 Gbit/s erfolgen und 7–9 Tage lang kein echter Abbruch auftritt. Immer nur eine Änderung zur Zeit (Kabel, dann Port, dann Treiber) und als Notiz festhalten.";

export const RETENTION_ROWS: readonly { data: string; resolution: string; keep: string }[] = [
  { data: "Rohmesswerte (jede Antwort, inkl. Kennzeichen Last/WLAN-Ausweichen)", resolution: "1 s je Ziel", keep: "14 Tage (ca. 20 MB pro Tag)" },
  { data: "Minutenwerte (min/Ø/max/p50/p95/p99/Jitter/Verlust/Spitzen und Histogramm)", resolution: "1 min", keep: "400 Tage" },
  { data: "Sekunden-Klassifizierung (Anzahl je Abschnitt)", resolution: "1 min", keep: "400 Tage" },
  { data: "Ereignisse", resolution: "–", keep: "10 Jahre" },
  { data: "Kennzahlen (Adapter, WLAN, DOCSIS-Zusammenfassung, TCP …)", resolution: "1–60 s", keep: "90 Tage" },
  { data: "Schnappschüsse (Router, DOCSIS-Tabellen, Adapter, NAT)", resolution: "5 min bzw. bei Änderung", keep: "60 Tage" },
  { data: "Speedtests, Traceroutes", resolution: "je Lauf", keep: "10 Jahre (klein)" },
];

export const RETENTION_NOTE =
  "Speicherort data/netdiag.db (SQLite). Export als CSV/JSON und druckbarer Bericht für Vodafone (Zeitprofil, Ausfallliste, Traceroutes, DOCSIS-Werte, Router-Protokoll mit unkenntlich gemachten MAC-Adressen, Link-Ereignisse, Speedtests).";

export interface ProcedureStep {
  title: string;
  text: string;
  href?: string;
  linkLabel?: string;
}

export const PROCEDURE: readonly ProcedureStep[] = [
  {
    title: "Einrichten",
    text: "Netzpuls starten (npm run dev bzw. npm run start:all) und unter Einstellungen den Tarif und – für DOCSIS-Werte – das Router-Passwort eintragen. Es wird nur verschlüsselt lokal gespeichert.",
    href: "/einstellungen",
    linkLabel: "Einstellungen öffnen",
  },
  {
    title: "Langzeittest starten",
    text: "Empfohlen 72 h, mindestens 24 h inklusive zweier Abende. Der Standby wird währenddessen automatisch verhindert; lege den PC nicht manuell schlafen.",
    href: "/",
    linkLabel: "Zum Live-Dashboard",
  },
  {
    title: "Ganz normal spielen",
    text: "Bei einem Lag den Knopf „Lag jetzt markieren“ drücken – so lassen sich subjektive Lags mit den Messdaten abgleichen.",
  },
  {
    title: "Diagnose lesen",
    text: "Hauptursache, Anteil gestörter Sekunden je Abschnitt, Belege und Empfehlungen. Den Bericht für Vodafone drucken oder exportieren.",
    href: "/diagnose",
    linkLabel: "Diagnose öffnen",
  },
  {
    title: "Eine Maßnahme umsetzen",
    text: "Zum Beispiel ein neues Kabel. Danach einen neuen Test starten und die Ergebnisse vergleichen.",
  },
];

export interface HypothesisRow {
  n: number;
  hypothesis: string;
  key?: boolean;
  confirmedBy: string;
  refutedBy: string;
}

export const HYPOTHESES: readonly HypothesisRow[] = [
  { n: 1, hypothesis: "Kabel, Stecker oder Port am PC (Abbrüche, 100-Mbit-Rückfall)", key: true, confirmedBy: "Echte Link-Abbrüche, LINK-Sekunden, 100-Mbit-Wiederaufbauten, Router meldet 100 Mbps", refutedBy: "Mind. 10 Wiederaufbauten mit 1 Gbit/s, keine Abbrüche nach Kabeltausch" },
  { n: 2, hypothesis: "Kabelzugangsnetz (DOCSIS/Segment) – Ursache der Ping-Spitzen", key: true, confirmedBy: "ACCESS-Sekunden, Spitzen der Kopfstation gleichzeitig mit Internet-Spitzen, abends schlechter, DOCSIS-Werte, T3/T4", refutedBy: "Kopfstation stabil während der Lags" },
  { n: 3, hypothesis: "Andere Geräte oder Downloads im Haushalt (Bufferbloat)", confirmedBy: "Spitzen nur bei Last, schlechte Bufferbloat-Note, Test „ruhiger Haushalt“ hilft", refutedBy: "Keine Korrelation mit Last" },
  { n: 4, hypothesis: "Router-Instabilität (Neustarts)", confirmedBy: "Laufzeit-Rücksprünge, Router offline, Protokoll", refutedBy: "Laufzeit durchgehend" },
  { n: 5, hypothesis: "Treiber I225-V", confirmedBy: "Abbrüche bleiben trotz neuem Kabel und Port", refutedBy: "Abbrüche verschwinden nach Kabeltausch" },
  { n: 6, hypothesis: "DS-Lite/AFTR (nur IPv4)", confirmedBy: "AFTR-Sekunden, IPv4 schlechter als IPv6", refutedBy: "IPv4 gleich IPv6" },
  { n: 7, hypothesis: "Vodafone-Backbone oder Peering", confirmedBy: "BACKBONE- und REMOTE-Sekunden, nur bestimmte Ziele", refutedBy: "Alle Ziele gleich" },
  { n: 8, hypothesis: "PC-intern (CPU, VPN, Hintergrunddienste)", confirmedBy: "CPU-Spitzen, periodische Ping-Spitzen", refutedBy: "–" },
];

export const TOC: readonly { id: string; label: string }[] = [
  { id: "status", label: "Messplan-Status" },
  { id: "ziel", label: "Ziel" },
  { id: "ist-analyse", label: "Ist-Analyse" },
  { id: "messprinzip", label: "Messprinzip" },
  { id: "messwerte", label: "Messwerte" },
  { id: "docsis", label: "DOCSIS-Richtwerte" },
  { id: "diagnose-regeln", label: "Diagnose-Regeln" },
  { id: "datenhaltung", label: "Datenhaltung" },
  { id: "ablauf", label: "Ablauf" },
  { id: "hypothesen", label: "Hypothesen" },
];
