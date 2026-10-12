"use client";

import { useMemo, type ReactNode } from "react";
import { ChartSpline } from "lucide-react";
import type { SeriesResponse } from "@/lib/shared/api-types";
import type { NetEvent } from "@/lib/shared/types";
import { bandThresholds, latencySeriesOption, seriesHasData, type ThresholdSpec } from "@/lib/client/charts";
import { commonSegment, seriesTargets, useTargets } from "@/lib/client/targets";
import { ChartSkeleton, EmptyState } from "@/components/ui/States";
import { EChart } from "./EChart";

const REPLACE = ["series"]; // stabil: Serien ersetzen, Zoom/Legende behalten

export interface LatencySeriesChartProps {
  /** Antwort von GET /api/series (null = lädt) */
  data: SeriesResponse | null | undefined;
  /** Ziel-IDs in Legendenreihenfolge, z. B. ["gw", "isp6", "cf4"] */
  targetIds: readonly string[];
  /** Band um die Linie (nur für das erste Ziel): min–max oder Ø–p95 */
  band?: "none" | "minmax" | "p95";
  /** Ereignisse für Overlays (Ausfall, Link weg, Speedtest, Route, Notiz …) */
  events?: readonly NetEvent[] | null;
  /** "auto" = Latenzschwellen aus der Konfiguration, wenn alle Ziele im selben Abschnitt liegen; false = keine */
  thresholds?: readonly ThresholdSpec[] | "auto" | false;
  /** Zoom per Mausrad/Ziehen + Schieber */
  zoom?: boolean;
  /** feste Obergrenze in ms (Ausreißer abschneiden) */
  yMax?: number;
  /** Höhe inkl. Achsen (px) */
  height?: number;
  ariaLabel?: string;
  emptyText?: ReactNode;
  /**
   * Animation nur bei Änderung dieses Schlüssels (z. B. `range.rangeKey`); Datenaktualisierungen
   * (weiterrückende Zeiträume, Intervall) werden ohne Animation gezeichnet. Standard: Ziel-IDs.
   */
  animationKey?: string;
}

/**
 * Latenz-Zeitreihe aus /api/series: Ø je Bucket als Linie, Lücke = keine Antwort/keine Messung,
 * optional Band, Schwellen und Ereignis-Overlays. Farben fest je Ziel (targets.ts).
 */
export function LatencySeriesChart({
  data,
  targetIds,
  band = "none",
  events,
  thresholds = "auto",
  zoom = false,
  yMax,
  height = 300,
  ariaLabel,
  emptyText,
  animationKey,
}: LatencySeriesChartProps) {
  const { targets, byId, config } = useTargets();
  const idsKey = targetIds.join(",");
  const series = useMemo(() => seriesTargets(idsKey ? idsKey.split(",") : [], targets), [idsKey, targets]);
  const segment = commonSegment(targetIds, byId);
  const latencyBand = segment ? config?.thresholds.latency[segment] : undefined;
  const thresholdSpecs = useMemo(
    () => (thresholds === false ? [] : thresholds === "auto" ? bandThresholds(latencyBand) : thresholds),
    [thresholds, latencyBand],
  );

  const option = useMemo(
    () => latencySeriesOption(data, { targets: series, band, events, thresholds: thresholdSpecs, zoom, yMax }),
    [data, series, band, events, thresholdSpecs, zoom, yMax],
  );

  if (data == null) return <ChartSkeleton height={height} />;
  if (!seriesHasData(data, targetIds)) {
    return (
      <div className="grid place-items-center" style={{ height }}>
        <EmptyState icon={ChartSpline} title="Keine Messwerte im Zeitraum">
          {emptyText ?? "Für diese Ziele gibt es hier noch keine Pings. Läuft ein Langzeittest?"}
        </EmptyState>
      </div>
    );
  }
  const label = ariaLabel ?? `Latenz (${series.map((s) => s.name).join(", ")})`;
  return <EChart option={option} ariaLabel={label} height={height} replaceMerge={REPLACE} animationKey={`${idsKey}|${animationKey ?? ""}`} />;
}
