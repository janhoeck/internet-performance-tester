"use client";

import { useMemo } from "react";
import type { EChartsCoreOption } from "echarts/core";
import type { SeriesResponse } from "@/lib/shared/api-types";
import { CHART_TOKENS_LIGHT } from "@/lib/echarts-theme";
import { fmtLossPct, fmtMs } from "@/lib/format";
import { berlinHour } from "@/app/diagnose/_components/helpers";
import { PaperChart } from "./PaperChart";

const HOURS = Array.from({ length: 24 }, (_, h) => String(h).padStart(2, "0"));

export const PROFILE_TARGETS = [
  { id: "gw", label: "Router", slot: 0 },
  { id: "isp6", label: "Kopfstation (CMTS)", slot: 1 },
  { id: "cf4", label: "Cloudflare IPv4", slot: 3 },
] as const;

export interface HourRow {
  hour: number;
  /** p95 je Ziel (gewichtetes Mittel der Stunden-p95 über alle Tage), ms */
  p95: Record<string, number | null>;
  /** Verlust je Ziel in % */
  loss: Record<string, number | null>;
  /** gesendete Pings (Cloudflare IPv4) */
  sent: number;
}

/** Stündliche Buckets (step 1 h) -> Profil nach Tageszeit (Europe/Berlin). */
export function hourProfile(res: SeriesResponse | null): HourRow[] {
  const acc = HOURS.map(() => ({ p95: new Map<string, [number, number]>(), loss: new Map<string, [number, number]>(), sent: 0 }));
  if (res) {
    for (const t of PROFILE_TARGETS) {
      const d = res.series[t.id];
      if (!d) continue;
      d.ts.forEach((ts, i) => {
        const n = d.sent[i] ?? 0;
        if (n <= 0) return;
        const h = berlinHour(ts);
        const a = acc[h];
        const p = d.p95[i];
        if (p != null) {
          const [s, w] = a.p95.get(t.id) ?? [0, 0];
          a.p95.set(t.id, [s + p * n, w + n]);
        }
        const l = d.lossPct[i];
        if (l != null) {
          const [s, w] = a.loss.get(t.id) ?? [0, 0];
          a.loss.set(t.id, [s + l * n, w + n]);
        }
        if (t.id === "cf4") a.sent += n;
      });
    }
  }
  return acc.map((a, hour) => {
    const p95: Record<string, number | null> = {};
    const loss: Record<string, number | null> = {};
    for (const t of PROFILE_TARGETS) {
      const pp = a.p95.get(t.id);
      const ll = a.loss.get(t.id);
      p95[t.id] = pp && pp[1] > 0 ? pp[0] / pp[1] : null;
      loss[t.id] = ll && ll[1] > 0 ? ll[0] / ll[1] : null;
    }
    return { hour, p95, loss, sent: a.sent };
  });
}

const T = CHART_TOKENS_LIGHT;

function baseOption(): EChartsCoreOption {
  return {
    animation: false,
    grid: { left: 44, right: 12, top: 48, bottom: 28, containLabel: false },
    xAxis: {
      type: "category",
      data: HOURS,
      name: "Uhr",
      nameLocation: "end",
      nameGap: 4,
      nameTextStyle: { color: T.fg3, fontSize: 10, align: "right", verticalAlign: "top", padding: [8, 0, 0, 0] },
      axisLabel: { color: T.fg3, fontSize: 10, interval: 1 },
      axisLine: { lineStyle: { color: T.axis } },
      axisTick: { show: false },
    },
    tooltip: { trigger: "axis" },
  };
}

export function HourProfileCharts({ rows }: { rows: HourRow[] }) {
  const latency = useMemo<EChartsCoreOption>(
    () => ({
      ...baseOption(),
      legend: { top: 0, left: 0, itemWidth: 14, itemHeight: 3, textStyle: { color: T.fg2, fontSize: 11 } },
      yAxis: {
        type: "value",
        name: "ms",
        nameTextStyle: { color: T.fg3, fontSize: 10 },
        min: 0,
        axisLabel: { color: T.fg3, fontSize: 10 },
        splitLine: { lineStyle: { color: T.grid } },
      },
      series: PROFILE_TARGETS.map((t) => ({
        name: t.label,
        type: "line",
        connectNulls: false,
        showSymbol: true,
        symbolSize: 4,
        lineStyle: { width: 2 },
        color: T.series[t.slot],
        data: rows.map((r) => (r.p95[t.id] != null ? Math.round((r.p95[t.id] as number) * 10) / 10 : null)),
        tooltip: { valueFormatter: (v: unknown) => (typeof v === "number" ? fmtMs(v) : "keine Messung") },
      })),
    }),
    [rows],
  );

  const loss = useMemo<EChartsCoreOption>(
    () => ({
      ...baseOption(),
      legend: { top: 0, left: 0, itemWidth: 10, itemHeight: 10, textStyle: { color: T.fg2, fontSize: 11 } },
      yAxis: {
        type: "value",
        name: "%",
        nameTextStyle: { color: T.fg3, fontSize: 10 },
        min: 0,
        max: (v: { max: number }) => Math.max(1, Math.ceil(v.max)),
        axisLabel: { color: T.fg3, fontSize: 10 },
        splitLine: { lineStyle: { color: T.grid } },
      },
      series: [
        {
          name: "Paketverlust Cloudflare IPv4",
          type: "bar",
          barMaxWidth: 14,
          color: T.series[3],
          itemStyle: { borderRadius: [3, 3, 0, 0] },
          data: rows.map((r) => (r.loss.cf4 != null ? Math.round((r.loss.cf4 as number) * 100) / 100 : null)),
          tooltip: { valueFormatter: (v: unknown) => (typeof v === "number" ? fmtLossPct(v) : "keine Messung") },
        },
      ],
    }),
    [rows],
  );

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 print:grid-cols-2">
      <figure className="min-w-0">
        <figcaption className="mb-1 text-sm font-medium text-fg">p95-Latenz nach Tageszeit</figcaption>
        <PaperChart option={latency} ariaLabel="p95-Latenz von Router, Kopfstation und Cloudflare IPv4 je Stunde des Tages" height={220} />
      </figure>
      <figure className="min-w-0">
        <figcaption className="mb-1 text-sm font-medium text-fg">Paketverlust nach Tageszeit</figcaption>
        <PaperChart option={loss} ariaLabel="Paketverlust zu Cloudflare IPv4 je Stunde des Tages" height={220} />
      </figure>
    </div>
  );
}
