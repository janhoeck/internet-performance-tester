import {
  Activity,
  CalendarClock,
  ChartSpline,
  EthernetPort,
  FileText,
  FlaskConical,
  Gauge,
  ListClock,
  Route,
  Router,
  Settings,
  Stethoscope,
  type LucideIcon,
} from "lucide-react";

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Kurzbeschreibung für Tooltip in der eingeklappten Leiste */
  hint: string;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

/** Routen deutsch, kleingeschrieben, ohne Umlaute. Reihenfolge = Arbeitsablauf. */
export const NAV: NavGroup[] = [
  {
    label: "Überblick",
    items: [
      { href: "/", label: "Live-Dashboard", icon: Activity, hint: "Aktueller Zustand der Leitung" },
      { href: "/verlauf", label: "Verlauf", icon: ChartSpline, hint: "Messwerte über Stunden und Tage" },
      { href: "/diagnose", label: "Diagnose", icon: Stethoscope, hint: "Befunde und wahrscheinliche Ursache" },
    ],
  },
  {
    label: "Messungen",
    items: [
      { href: "/speedtest", label: "Speedtest", icon: Gauge, hint: "Durchsatz und Latenz unter Last" },
      { href: "/route", label: "Route", icon: Route, hint: "Traceroute Hop für Hop" },
      { href: "/router", label: "Router", icon: Router, hint: "Vodafone Station und DOCSIS-Werte" },
      { href: "/pc-adapter", label: "PC & Adapter", icon: EthernetPort, hint: "Netzwerkkarte, Link, Treiber" },
    ],
  },
  {
    label: "Auswertung",
    items: [
      { href: "/langzeittests", label: "Langzeittests", icon: FlaskConical, hint: "Alle Tests nach Namen – öffnen oder löschen" },
      { href: "/ereignisse", label: "Ereignisse", icon: ListClock, hint: "Abbrüche, Ausfälle, Neustarts" },
      { href: "/bericht", label: "Bericht", icon: FileText, hint: "Zusammenfassung zum Teilen oder Drucken" },
    ],
  },
  {
    label: "System",
    items: [
      { href: "/messplan", label: "Messplan", icon: CalendarClock, hint: "Was wann gemessen wird" },
      { href: "/einstellungen", label: "Einstellungen", icon: Settings, hint: "Ziele, Schwellen, Router-Zugang" },
    ],
  },
];

export function isActive(href: string, pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}
