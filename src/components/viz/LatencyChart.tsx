"use client";

import { useMemo } from "react";
import {
  axisTooltipFormatter,
  chartTokens,
  eventLine,
  markLines,
  outageMarkArea,
  seriesColor,
  thresholdLine,
  type ChartEvent,
  type Outage,
} from "@/lib/echarts-theme";
import { THRESHOLDS } from "@/lib/health";
import { EChart } from "./EChart";

const REPLACE = ["series"]; // stabil (außerhalb der Komponente), sonst läuft setOption bei jedem Render

export interface LatencySeries {
  /** Anzeigename, z. B. "1.1.1.1" */
  name: string;
  /** Fester Farbslot 0–7 des Ziels (in den Einstellungen gespeichert) */
  slot: number;
  /** [Zeitstempel ms, RTT ms | null] – null = keine Antwort/keine Messung */
  points: Array<[number, number | null]>;
}

interface LatencyChartProps {
  series: LatencySeries[];
  outages?: Outage[];
  events?: ChartEvent[];
  /** Zeitfenster (ms) – fest setzen, damit Lücken am Rand sichtbar bleiben */
  from: number;
  to: number;
  height?: number;
  /** true bei Live-Ansicht: keine Animation, Updates max. 1×/s */
  live?: boolean;
}

/**
 * Beispiel für das Muster "Daten vom Server, Option im Client":
 * ECharts-Optionen enthalten Funktionen (Formatter) und sind NICHT serialisierbar –
 * Server-Komponenten übergeben nur Zahlen/Strings, die Option entsteht hier.
 */
export function LatencyChart({ series, outages = [], events = [], from, to, height = 300, live = false }: LatencyChartProps) {
  const option = useMemo(() => {
    const t = chartTokens("dark");
    return {
      animation: !live,
      legend: { data: series.map((s) => s.name) },
      tooltip: { formatter: axisTooltipFormatter({ unit: "ms", t }) },
      xAxis: { type: "time", min: from, max: to },
      yAxis: { type: "value", name: "ms" },
      series: series.map((s, i) => ({
        name: s.name,
        type: "line",
        color: seriesColor(s.slot, t),
        data: s.points,
        // Marker nur an der ersten Serie, sonst doppelt gezeichnet
        ...(i === 0
          ? {
              markArea: outageMarkArea(outages, t),
              markLine: markLines([
                thresholdLine(THRESHOLDS.rttMs.warn, `${THRESHOLDS.rttMs.warn} ms: auffällig`, "warn", t),
                thresholdLine(THRESHOLDS.rttMs.crit, `${THRESHOLDS.rttMs.crit} ms: kritisch`, "crit", t),
                ...events.map((e) => eventLine(e, t)),
              ]),
            }
          : {}),
      })),
    };
  }, [series, outages, events, from, to, live]);

  const label = `Latenz je Ziel (${series.map((s) => s.name).join(", ")})`;
  return <EChart option={option} ariaLabel={label} height={height} replaceMerge={REPLACE} />;
}
