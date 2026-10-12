"use client";

import { useMemo } from "react";
import { CircleCheck, MonitorOff } from "lucide-react";
import type { SecondsResponse } from "@/lib/shared/api-types";
import type { NetEvent } from "@/lib/shared/types";
import { badSeconds, secondsStackOption, type SecondsUnit } from "@/lib/client/charts";
import type { FaultClass } from "@/lib/segments";
import { ChartSkeleton, EmptyState } from "@/components/ui/States";
import { EChart } from "./EChart";

const REPLACE = ["series"];

export interface SecondsChartProps {
  /** Antwort von GET /api/seconds */
  data: SecondsResponse | null | undefined;
  /** s (Standard), min oder pct (= Anteil an der gemessenen Zeit je Bucket) */
  unit?: SecondsUnit;
  /** nur diese Klassen (Standard: alle Störungsklassen, nah -> fern) */
  classes?: readonly FaultClass[];
  events?: readonly NetEvent[] | null;
  height?: number;
  ariaLabel?: string;
}

/**
 * "Wo entstehen die gestörten Sekunden?" – gestapelte Balken je Zeitabschnitt, eine Farbe je
 * Abschnitt des Leitungswegs (PC & Kabel … Weg zum Spieleserver, Unklar).
 */
export function SecondsChart({ data, unit = "s", classes, events, height = 260, ariaLabel }: SecondsChartProps) {
  const option = useMemo(() => secondsStackOption(data, { unit, classes, events }), [data, unit, classes, events]);

  if (data == null) return <ChartSkeleton height={height} />;
  if (!data.total || data.total.covered === 0) {
    return (
      <div className="grid place-items-center" style={{ height }}>
        <EmptyState icon={MonitorOff} title="Keine Messung im Zeitraum">
          In diesem Zeitraum lief kein Langzeittest oder der PC war aus bzw. im Standby.
        </EmptyState>
      </div>
    );
  }
  if (badSeconds(data.total) === 0) {
    return (
      <div className="grid place-items-center" style={{ height }}>
        <EmptyState icon={CircleCheck} title="Keine gestörten Sekunden">
          Jede gemessene Sekunde war in diesem Zeitraum unauffällig.
        </EmptyState>
      </div>
    );
  }
  return (
    <EChart
      option={option}
      ariaLabel={ariaLabel ?? "Gestörte Sekunden je Zeitabschnitt, nach Abschnitt des Leitungswegs gestapelt"}
      height={height}
      replaceMerge={REPLACE}
    />
  );
}
