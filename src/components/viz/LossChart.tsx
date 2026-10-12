"use client";

import { useMemo, type ReactNode } from "react";
import { ChartColumn } from "lucide-react";
import type { SeriesResponse } from "@/lib/shared/api-types";
import type { NetEvent } from "@/lib/shared/types";
import { bandThresholds, lossBarsOption, seriesHasData, type ThresholdSpec } from "@/lib/client/charts";
import { seriesTargets, useTargets } from "@/lib/client/targets";
import { ChartSkeleton, EmptyState } from "@/components/ui/States";
import { EChart } from "./EChart";

const REPLACE = ["series"];

export interface LossChartProps {
  /** Antwort von GET /api/series (lossPct je Bucket) */
  data: SeriesResponse | null | undefined;
  /** Ziel-IDs; für Lesbarkeit 1–3 Ziele */
  targetIds: readonly string[];
  events?: readonly NetEvent[] | null;
  /** "auto" = Verlustschwellen aus der Konfiguration; false = keine */
  thresholds?: readonly ThresholdSpec[] | "auto" | false;
  height?: number;
  ariaLabel?: string;
  emptyText?: ReactNode;
}

/** Paketverlust je Bucket als Balken (eigenes Diagramm – nie zweite Achse im Latenzdiagramm). */
export function LossChart({ data, targetIds, events, thresholds = "auto", height = 200, ariaLabel, emptyText }: LossChartProps) {
  const { targets, config } = useTargets();
  const idsKey = targetIds.join(",");
  const series = useMemo(() => seriesTargets(idsKey ? idsKey.split(",") : [], targets), [idsKey, targets]);
  const lossBand = config?.thresholds.loss;
  const thresholdSpecs = useMemo(
    () => (thresholds === false ? [] : thresholds === "auto" ? bandThresholds(lossBand, "%") : thresholds),
    [thresholds, lossBand],
  );
  const option = useMemo(() => lossBarsOption(data, { targets: series, events, thresholds: thresholdSpecs }), [data, series, events, thresholdSpecs]);

  if (data == null) return <ChartSkeleton height={height} />;
  if (!seriesHasData(data, targetIds)) {
    return (
      <div className="grid place-items-center" style={{ height }}>
        <EmptyState icon={ChartColumn} title="Keine Messwerte im Zeitraum">
          {emptyText ?? "Für diese Ziele gibt es hier noch keine Pings."}
        </EmptyState>
      </div>
    );
  }
  const label = ariaLabel ?? `Paketverlust in Prozent (${series.map((s) => s.name).join(", ")})`;
  return <EChart option={option} ariaLabel={label} height={height} replaceMerge={REPLACE} />;
}
