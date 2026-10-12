import { CircleCheck, CircleQuestionMark, Info, OctagonAlert, TriangleAlert, type LucideIcon } from "lucide-react";
import type { Health as SharedHealth, Severity as SharedSeverity } from "@/lib/shared/types";

/** Zustand eines Segments/Werts. Reihenfolge = Schwere. */
export type Health = "good" | "warn" | "crit" | "unknown";
/** Für Befunde und Ereignisse zusätzlich "info". */
export type Severity = Health | "info";

export const HEALTH_LABEL: Record<Severity, string> = {
  good: "Gut",
  warn: "Auffällig",
  crit: "Kritisch",
  unknown: "Unbekannt",
  info: "Hinweis",
};

export const HEALTH_ICON: Record<Severity, LucideIcon> = {
  good: CircleCheck,
  warn: TriangleAlert,
  crit: OctagonAlert,
  unknown: CircleQuestionMark,
  info: Info,
};

/** CSS-Farbe (für SVG-style, Canvas über readChartTokensFromCss). */
export const HEALTH_COLOR: Record<Severity, string> = {
  good: "var(--np-good)",
  warn: "var(--np-warn)",
  crit: "var(--np-crit)",
  unknown: "var(--np-unknown)",
  info: "var(--np-info)",
};

/** Vollständige Klassen-Strings (Tailwind findet nur statische Klassen). */
export const HEALTH_TEXT: Record<Severity, string> = {
  good: "text-good",
  warn: "text-warn",
  crit: "text-crit",
  unknown: "text-unknown",
  info: "text-info",
};

export const HEALTH_SOFT: Record<Severity, string> = {
  good: "bg-good/12 ring-good/30",
  warn: "bg-warn/12 ring-warn/30",
  crit: "bg-crit/14 ring-crit/40",
  unknown: "bg-unknown/12 ring-unknown/25",
  info: "bg-info/12 ring-info/30",
};

const RANK: Record<Health, number> = { good: 0, unknown: 1, warn: 2, crit: 3 };

/** Schlechtester Zustand gewinnt (für Gesamtzustand). */
export function worstHealth(...states: Health[]): Health {
  return states.reduce<Health>((acc, s) => (RANK[s] > RANK[acc] ? s : acc), "good");
}

/**
 * Wie worstHealth, aber "unknown" nur, wenn ALLE Werte unbekannt sind
 * (ein fehlender Messpunkt soll einen sonst guten Abschnitt nicht grau färben).
 */
export function worstKnownHealth(...states: Health[]): Health {
  const known = states.filter((s) => s !== "unknown");
  return known.length === 0 ? "unknown" : worstHealth(...known);
}

/**
 * Gemeinsamer Health-Typ (API/Engine: 'good' | 'warn' | 'bad' | 'unknown') -> Design-Token.
 * DIE eine Stelle für die Abbildung bad -> crit.
 */
export function toUiHealth(h: SharedHealth | null | undefined): Health {
  if (h === "bad") return "crit";
  if (h === "good" || h === "warn") return h;
  return "unknown";
}

/** Gemeinsame Ereignis-/Befund-Schwere ('info' | 'warn' | 'critical') -> Design-Token. */
export function severityToUi(s: SharedSeverity | null | undefined): Severity {
  if (s === "critical") return "crit";
  if (s === "warn") return "warn";
  return "info";
}

/** Schwellen für Gaming (Design-Vorschlag; echte Schwellen kommen aus der Konfiguration). */
export const THRESHOLDS = {
  rttMs: { warn: 60, crit: 150 },
  jitterMs: { warn: 10, crit: 30 },
  lossPct: { warn: 0.5, crit: 2 },
} as const;

export function rate(value: number | null | undefined, t: { warn: number; crit: number }): Health {
  if (value == null || Number.isNaN(value)) return "unknown";
  if (value >= t.crit) return "crit";
  if (value >= t.warn) return "warn";
  return "good";
}
