/**
 * Die 20 Diagnose-Regeln (MESSPLAN §5) mit deutschem Namen und vereinfachtem Auslöser.
 * `id` = Finding.id der Diagnose-API (src/lib/server/diagnosis/rules/*).
 * Wird von /diagnose („So wurde geprüft“) und /bericht genutzt.
 */
import type { HostOs } from "@/lib/shared/platform";

export type RuleNeed =
  /** braucht Messzeit im Langzeittest (Pings im Sekundentakt) */
  | "coverage"
  /** braucht mehrere gemessene Abende (19–23 Uhr) */
  | "evenings"
  /** braucht Speedtests im Zeitraum */
  | "speedtests"
  /** braucht den Tarif in den Einstellungen */
  | "tariff"
  /** braucht DOCSIS-Werte (Router-Login) */
  | "docsis"
  /** braucht IPv6-Messwerte (cf6/g6) */
  | "ipv6"
  /** braucht Messwerte der Spieleserver-Ziele */
  | "game"
  /** braucht Messwerte der Kopfstation (isp6) */
  | "cmts"
  /** braucht gestörte Sekunden in ausreichender Zahl */
  | "badSeconds";

export interface RuleCheck {
  code: string;
  id: string;
  /** Befund-Titel laut Messplan */
  name: string;
  /** Auslöser in Worten (ohne Sonderzeichen außerhalb des Schrift-Subsets) */
  trigger: string;
  needs: readonly RuleNeed[];
}

export const RULE_CHECKS: readonly RuleCheck[] = [
  {
    code: "R01",
    id: "nic-link-flaps",
    name: "Netzwerkverbindung am PC bricht ab",
    trigger: "Mindestens 3 echte Link-Abbrüche in 7 Tagen oder 3 innerhalb von 30 Minuten (Windows-Ereignisprotokoll).",
    needs: [],
  },
  {
    code: "R02",
    id: "nic-100m",
    name: "Kabel/Port schafft kein Gigabit",
    trigger: "Mindestens 20 % der Verbindungsaufbauten unter 1 Gbit/s (ab 5 Fällen) oder länger als 10 Minuten mit 100 Mbit/s.",
    needs: [],
  },
  {
    code: "R03",
    id: "wlan-failover",
    name: "Windows wechselt bei Abbrüchen aufs WLAN",
    trigger: "WLAN-Ausweichen bei mindestens der Hälfte der Link-Abbrüche.",
    needs: [],
  },
  {
    code: "R04",
    id: "bufferbloat-load",
    name: "Lags unter Last (Bufferbloat)",
    trigger: "Latenz unter Last mindestens 50 ms höher als im Leerlauf bzw. Bufferbloat-Note C oder schlechter.",
    needs: ["speedtests"],
  },
  {
    code: "R05",
    id: "lan-quality",
    name: "Problem zwischen PC und Router",
    trigger: "Router-Verlust ab 0,5 % pro Stunde oder p99 ab 20 ms bei stehendem Link.",
    needs: ["coverage"],
  },
  {
    code: "R06",
    id: "lan-unreachable",
    name: "Router reagiert nicht",
    trigger: "Router mindestens 30 s nicht erreichbar, obwohl der Link steht.",
    needs: ["coverage"],
  },
  {
    code: "R07",
    id: "access-spikes",
    name: "Störung/Überlastung im Kabelnetz",
    trigger: "Mindestens 70 % der Internet-Ping-Spitzen gleichzeitig mit Spitzen der Kopfstation, Router dabei unauffällig.",
    needs: ["coverage", "cmts"],
  },
  {
    code: "R08",
    id: "household-load",
    name: "Andere Geräte/Downloads verursachen Lags",
    trigger: "Ping-Spitzen fallen mit hoher Eigen- oder Gesamtlast zusammen.",
    needs: ["coverage"],
  },
  {
    code: "R09",
    id: "docsis-values",
    name: "Leitungswerte auffällig",
    trigger: "DOCSIS-Werte außerhalb der Vodafone-Richtwerte, T3/T4-Häufung, Kanalverlust oder Router-Neustarts.",
    needs: ["docsis"],
  },
  {
    code: "R10",
    id: "peak-hours",
    name: "Überlastung zu Stoßzeiten",
    trigger: "Abends (19–23 Uhr) deutlich höhere Latenz oder mehr Verlust als tagsüber – an mindestens 3 Tagen.",
    needs: ["evenings"],
  },
  {
    code: "R11",
    id: "ipv4-vs-ipv6",
    name: "DS-Lite-Gateway (AFTR) überlastet",
    trigger: "IPv4 in mindestens 30 % der 15-Minuten-Fenster deutlich schlechter als IPv6 – bei Cloudflare und Google.",
    needs: ["coverage", "ipv6"],
  },
  {
    code: "R12",
    id: "remote-only",
    name: "Problem auf dem Weg zum Rechenzentrum",
    trigger: "Nur der Weg zum Spieleserver ist gestört, die eigene Leitung nicht.",
    needs: ["coverage", "game"],
  },
  {
    code: "R13",
    id: "identity-change",
    name: "Fremdes oder zweites Gerät im Netz",
    trigger: "IP-Adresskonflikt, Wechsel der Gateway-MAC-Adresse oder des DHCP-Servers.",
    needs: [],
  },
  {
    code: "R14",
    id: "after-change",
    name: "Probleme nach einer Änderung",
    trigger: "Störungen begannen nach einer Änderung (Treiber, Kabel, Firmware, Einstellungen).",
    needs: ["coverage"],
  },
  {
    code: "R15",
    id: "vpn-active",
    name: "VPN leitet Spieleverkehr um",
    trigger: "VPN im Voll-Tunnel oder messbarer Unterschied mit und ohne WARP.",
    needs: [],
  },
  {
    code: "R16",
    id: "data-quality",
    name: "Zu wenige Messdaten",
    trigger: "Wenig Messzeit, große Lücken oder Abdeckung unter 70 %.",
    needs: [],
  },
  {
    code: "R17",
    id: "top-cause",
    name: "Hauptursache nach gestörten Sekunden",
    trigger: "Abschnitt mit dem größten Anteil gestörter Sekunden (hohe Sicherheit ab 3 Tagen, 100 gestörten Sekunden und 50 % Anteil).",
    needs: ["coverage", "badSeconds"],
  },
  {
    code: "R18",
    id: "speed-below-tariff",
    name: "Bandbreite unter Vertrag",
    trigger: "Download unter 50 % des Tarifs, ohne Begrenzung durch den LAN-Link.",
    needs: ["speedtests", "tariff"],
  },
  {
    code: "R19",
    id: "periodic-spikes",
    name: "Periodische Ping-Spitzen",
    trigger: "Ping-Spitzen in festem Abstand (z. B. Hintergrunddienst oder WLAN-Suche).",
    needs: ["coverage"],
  },
  {
    code: "R20",
    id: "router-instability",
    name: "Router instabil",
    trigger: "Router-Neustarts, Router nicht erreichbar oder langsame Oberfläche.",
    needs: [],
  },
];

export const RULE_BY_ID: Readonly<Record<string, RuleCheck>> = Object.fromEntries(RULE_CHECKS.map((r) => [r.id, r]));

/** Name und Auslöser mit betriebssystemabhängigem Wortlaut (die Liste oben ist für Windows formuliert). */
export function ruleText(r: RuleCheck, os: HostOs): { name: string; trigger: string } {
  if (os !== "macos") return { name: r.name, trigger: r.trigger };
  if (r.id === "nic-link-flaps") {
    return { name: "Netzwerkverbindung am Mac bricht ab", trigger: "Mindestens 3 echte Link-Abbrüche in 7 Tagen oder 3 innerhalb von 30 Minuten (sekündliche Link-Überwachung)." };
  }
  if (r.id === "wlan-failover") return { name: "macOS wechselt bei Abbrüchen aufs WLAN", trigger: r.trigger };
  return { name: r.name, trigger: r.trigger };
}

/** Was im Zeitraum an Daten vorhanden ist – Grundlage für die Hinweise „zu wenige Daten“. */
export interface RuleDataContext {
  coveredSeconds: number;
  /** Abende (19–23 Uhr) mit mindestens 30 min Messung */
  evenings: number;
  speedtests: number;
  tariffSet: boolean;
  docsisAvailable: boolean;
  ipv6Samples: number;
  gameSamples: number;
  cmtsSamples: number;
  badSeconds: number;
}

const MIN_COVERED_S = 3600;

/** Hinweistext, wenn die Daten für eine Regel nicht reichen (sonst null). */
export function insufficientNote(rule: RuleCheck, ctx: RuleDataContext): string | null {
  const notes: string[] = [];
  for (const need of rule.needs) {
    switch (need) {
      case "coverage":
        if (ctx.coveredSeconds < MIN_COVERED_S) notes.push("weniger als 1 h Messzeit im Zeitraum");
        break;
      case "evenings":
        if (ctx.evenings < 3) notes.push(`erst ${ctx.evenings} von 3 nötigen Abenden gemessen`);
        break;
      case "speedtests":
        if (ctx.speedtests === 0) notes.push("kein Speedtest im Zeitraum");
        break;
      case "tariff":
        if (!ctx.tariffSet) notes.push("Tarif nicht in den Einstellungen hinterlegt");
        break;
      case "docsis":
        if (!ctx.docsisAvailable) notes.push("keine DOCSIS-Werte (Router-Login nicht eingerichtet)");
        break;
      case "ipv6":
        if (ctx.ipv6Samples === 0) notes.push("keine IPv6-Messwerte");
        break;
      case "game":
        if (ctx.gameSamples === 0) notes.push("keine Messwerte der Spieleserver");
        break;
      case "cmts":
        if (ctx.cmtsSamples === 0) notes.push("keine Messwerte der Kopfstation");
        break;
      case "badSeconds":
        if (ctx.badSeconds < 100) notes.push("weniger als 100 gestörte Sekunden");
        break;
    }
  }
  if (notes.length === 0) return null;
  const text = notes.join(", ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}
