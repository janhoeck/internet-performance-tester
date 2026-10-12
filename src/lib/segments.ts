import { AudioWaveform, Cable, Globe, Monitor, Router, Server, Target, type LucideIcon } from "lucide-react";
import type { SecondClass, Segment } from "@/lib/shared/types";

/**
 * Der Leitungsweg in fester Reihenfolge (Nah -> Fern) für Chips, Spuren und Legenden.
 * (Die Topologie-Grafik hat eigene Knoten: PC, Router, Kopfstation, AFTR, Ziele – siehe SegmentTopology.)
 */
export type SegmentId = "pc" | "lan" | "router" | "docsis" | "provider" | "internet" | "targets";

export interface SegmentDef {
  id: SegmentId;
  kind: "node" | "link";
  label: string;
  short: string;
  /** Was hier typischerweise geprüft wird – für Tooltips/Diagnose. */
  scope: string;
  icon: LucideIcon;
  /** Ordinale Rampe (CSS-Variable), nur für Legenden/Charts – Zustand kommt aus Health. */
  color: string;
  colorClass: string;
}

export const SEGMENTS: readonly SegmentDef[] = [
  { id: "pc", kind: "node", label: "PC & Adapter", short: "PC", scope: "Intel I225-V, Treiber, Energiesparen, Linkgeschwindigkeit", icon: Monitor, color: "var(--np-seg-pc)", colorClass: "bg-seg-pc" },
  { id: "lan", kind: "link", label: "LAN-Kabel", short: "LAN", scope: "Kabel, Stecker, Router-Port", icon: Cable, color: "var(--np-seg-lan)", colorClass: "bg-seg-lan" },
  { id: "router", kind: "node", label: "Router", short: "Router", scope: "Vodafone Station (ARRIS TG6442)", icon: Router, color: "var(--np-seg-router)", colorClass: "bg-seg-router" },
  { id: "docsis", kind: "link", label: "Kabelnetz (DOCSIS)", short: "DOCSIS", scope: "Koax-Hausverteilung, Pegel, SNR, Kopfstation (CMTS)", icon: AudioWaveform, color: "var(--np-seg-docsis)", colorClass: "bg-seg-docsis" },
  { id: "provider", kind: "node", label: "Vodafone & AFTR", short: "Provider", scope: "DS-Lite-Gateway (CGNAT), Vodafone-Netz", icon: Server, color: "var(--np-seg-provider)", colorClass: "bg-seg-provider" },
  { id: "internet", kind: "link", label: "Internet", short: "Internet", scope: "Backbone, Peering, Transit", icon: Globe, color: "var(--np-seg-internet)", colorClass: "bg-seg-internet" },
  { id: "targets", kind: "node", label: "Ziele", short: "Ziele", scope: "1.1.1.1, 8.8.8.8, Spieleserver", icon: Target, color: "var(--np-seg-targets)", colorClass: "bg-seg-targets" },
] as const;

export const SEGMENT_BY_ID: Record<SegmentId, SegmentDef> = Object.fromEntries(
  SEGMENTS.map((s) => [s.id, s]),
) as Record<SegmentId, SegmentDef>;

/** Gemeinsame Segmente (API/Engine) -> Design-Segment für Chips/Spuren. */
export const SEGMENT_OF_SHARED: Record<Segment, SegmentId> = {
  client: "pc",
  lan: "lan",
  router: "router",
  docsis: "docsis",
  aftr: "provider",
  isp: "provider",
  internet: "internet",
  game: "targets",
};

export function segmentFromShared(s: Segment | null | undefined): SegmentId | undefined {
  return s ? SEGMENT_OF_SHARED[s] : undefined;
}

/** Deutsche Namen der gemeinsamen Segmente (genauer als die 7 Design-Segmente). */
export const SHARED_SEGMENT_LABEL: Record<Segment, string> = {
  client: "PC & Adapter",
  lan: "Heimnetz (LAN)",
  router: "Router",
  docsis: "Kabelnetz (DOCSIS)",
  aftr: "DS-Lite-Gateway (AFTR)",
  isp: "Vodafone-Netz",
  internet: "Internet",
  game: "Spieleserver",
};

/* -------------------------------------------------------------------------- */
/* Sekunden-Klassen (Klassifizierung je Sekunde, Tabelle seconds_1m)          */
/* -------------------------------------------------------------------------- */

/** Gestörte Klassen (ohne "excluded" und "good"). */
export type FaultClass = Exclude<SecondClass, "excluded" | "good">;

export interface FaultClassDef {
  id: FaultClass;
  /** Deutscher Name (Legenden, Tooltips) */
  label: string;
  /** Design-Segment für Icon/Chip; null = keinem Abschnitt zuordenbar */
  segment: SegmentId | null;
  /** Index in der Segment-Rampe (0 = nah … 6 = fern), null = neutral ("Sonstige"-Grau) */
  ramp: number | null;
  /** CSS-Farbe (für HTML/SVG) */
  color: string;
  colorClass: string;
}

/**
 * Reihenfolge = Nah -> Fern (Stapel von unten nach oben). Farben aus der ordinalen
 * Segment-Rampe, NIE Statusfarben. "unknown" ist neutral grau.
 */
export const FAULT_CLASSES: readonly FaultClassDef[] = [
  { id: "link", label: "PC & Kabel", segment: "pc", ramp: 0, color: "var(--np-seg-pc)", colorClass: "bg-seg-pc" },
  { id: "lan", label: "Heimnetz", segment: "lan", ramp: 1, color: "var(--np-seg-lan)", colorClass: "bg-seg-lan" },
  { id: "access", label: "Kabelnetz (DOCSIS)", segment: "docsis", ramp: 3, color: "var(--np-seg-docsis)", colorClass: "bg-seg-docsis" },
  { id: "aftr", label: "DS-Lite (AFTR)", segment: "provider", ramp: 4, color: "var(--np-seg-provider)", colorClass: "bg-seg-provider" },
  { id: "backbone", label: "Vodafone-Netz", segment: "provider", ramp: 5, color: "var(--np-seg-internet)", colorClass: "bg-seg-internet" },
  { id: "remote", label: "Weg zum Spieleserver", segment: "targets", ramp: 6, color: "var(--np-seg-targets)", colorClass: "bg-seg-targets" },
  { id: "unknown", label: "Unklar", segment: null, ramp: null, color: "var(--np-chart-other)", colorClass: "bg-chart-other" },
] as const;

export const FAULT_CLASS_BY_ID: Record<FaultClass, FaultClassDef> = Object.fromEntries(
  FAULT_CLASSES.map((c) => [c.id, c]),
) as Record<FaultClass, FaultClassDef>;

export const FAULT_CLASS_IDS: readonly FaultClass[] = FAULT_CLASSES.map((c) => c.id);
