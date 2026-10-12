/**
 * ECharts-Options der Speedtest-Seite (nur im Browser bauen – enthalten Formatter-Funktionen).
 * Eine y-Achse je Raster: oben Durchsatz (Mbit/s), unten Latenz (ms), gemeinsame Zeitachse.
 */
import type { EChartsCoreOption } from "echarts/core";
import { fmtAxisNumber, withAlpha, type ChartTokens } from "@/lib/echarts-theme";
import { fmtDateTimeShort, fmtLinkSpeed, fmtMbit, fmtMs } from "@/lib/format";
import type { SpeedPhase, SpeedSeriesPoint, SpeedtestResult } from "@/lib/shared/types";
import { PHASE_LABEL } from "./speed-utils";

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] ?? ch);
}

function tipRow(t: ChartTokens, color: string | null, value: string, label: string): string {
  const key = color
    ? `<span style="display:inline-block;flex:none;width:12px;height:2px;border-radius:1px;background:${color}"></span>`
    : `<span style="display:inline-block;flex:none;width:12px"></span>`;
  return (
    `<div style="display:flex;align-items:center;gap:8px;line-height:20px">${key}` +
    `<span style="font-family:${esc(t.fontMono)};font-weight:600;color:${t.fg};min-width:72px">${esc(value)}</span>` +
    `<span style="color:${t.fg3}">${esc(label)}</span></div>`
  );
}

function tipHead(t: ChartTokens, text: string): string {
  return `<div style="font-family:${esc(t.fontMono)};font-size:11px;color:${t.fg3};margin-bottom:4px">${esc(text)}</div>`;
}

interface AxisParam {
  seriesId?: string;
  seriesName?: string;
  color?: unknown;
  value?: unknown;
  axisValue?: unknown;
}
const asList = (raw: unknown): AxisParam[] => (Array.isArray(raw) ? (raw as AxisParam[]) : raw ? [raw as AxisParam] : []);
const pointValue = (p: AxisParam): number | null => {
  const v = Array.isArray(p.value) ? p.value[1] : p.value;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
};

/** Zusammenhängende Phasen-Abschnitte (Sekunden seit Start). */
export function phaseRanges(points: readonly SpeedSeriesPoint[]): { phase: SpeedPhase; from: number; to: number }[] {
  const out: { phase: SpeedPhase; from: number; to: number }[] = [];
  for (const p of points) {
    if (p.phase !== "idle" && p.phase !== "download" && p.phase !== "upload") continue;
    const s = p.t / 1000;
    const last = out[out.length - 1];
    if (last && last.phase === p.phase) last.to = s;
    else {
      if (last) last.to = Math.max(last.to, s);
      out.push({ phase: p.phase, from: s, to: s });
    }
  }
  return out;
}

const fmtSec = (v: number) => `${fmtAxisNumber(v)} s`;

export interface SpeedRunOptions {
  t: ChartTokens;
  animation?: boolean;
  /** geplante Gesamtdauer in Sekunden (Live: x-Achse steht von Anfang an fest) */
  totalSec?: number | null;
}

/**
 * Verlauf eines Tests: Durchsatz je Phase (Download/Upload getrennt eingefärbt) und Latenz-Proben,
 * Phasen hinterlegt. Verlorene Proben (rtt = null) unterbrechen die Linie.
 */
export function speedRunOption(points: readonly SpeedSeriesPoint[], opts: SpeedRunOptions): EChartsCoreOption {
  const { t } = opts;
  const sorted = [...points].sort((a, b) => a.t - b.t);
  const down: [number, number][] = [];
  const up: [number, number][] = [];
  const rtt: [number, number | null][] = [];
  for (const p of sorted) {
    const x = p.t / 1000;
    if (typeof p.mbps === "number" && Number.isFinite(p.mbps)) {
      if (p.phase === "download") down.push([x, p.mbps]);
      else if (p.phase === "upload") up.push([x, p.mbps]);
    }
    if (typeof p.rtt === "number" && Number.isFinite(p.rtt)) rtt.push([x, p.rtt]);
    else if (p.rtt === null) rtt.push([x, null]);
  }
  const lastX = sorted.length ? sorted[sorted.length - 1].t / 1000 : 0;
  const maxX = Math.max(opts.totalSec ?? 0, lastX, 1);
  const cDown = t.series[0];
  const cUp = t.series[1];
  const cRtt = t.series[4];

  const areas = phaseRanges(sorted).map((r) => {
    const color = r.phase === "download" ? withAlpha(cDown, 0.1) : r.phase === "upload" ? withAlpha(cUp, 0.1) : withAlpha(t.fg3, 0.05);
    return [
      { xAxis: r.from, itemStyle: { color }, label: { show: true, formatter: PHASE_LABEL[r.phase], color: t.fg3, position: "insideTop", fontSize: 11 } },
      { xAxis: Math.max(r.to, r.from + 0.25) },
    ];
  });
  const areasNoLabel = areas.map(([a, b]) => [{ ...a, label: { show: false } }, b]);

  const common = { type: "line", showSymbol: false, symbol: "none", connectNulls: false, emphasis: { disabled: true }, sampling: "lttb" };
  return {
    animation: opts.animation ?? false,
    legend: { data: ["Download", "Upload", "Latenz"], top: 0 },
    axisPointer: { link: [{ xAxisIndex: "all" }] },
    grid: [
      { left: 4, right: 12, top: 40, height: "40%", outerBoundsMode: "same", outerBoundsContain: "axisLabel" },
      { left: 4, right: 12, top: "62%", bottom: 4, outerBoundsMode: "same", outerBoundsContain: "axisLabel" },
    ],
    xAxis: [
      { type: "value", gridIndex: 0, min: 0, max: maxX, axisLabel: { show: false } },
      { type: "value", gridIndex: 1, min: 0, max: maxX, axisLabel: { formatter: fmtSec } },
    ],
    yAxis: [
      { type: "value", gridIndex: 0, name: "Mbit/s", min: 0 },
      { type: "value", gridIndex: 1, name: "ms", min: 0 },
    ],
    tooltip: {
      trigger: "axis",
      formatter: (raw: unknown) => {
        const list = asList(raw);
        const x = typeof list[0]?.axisValue === "number" ? list[0].axisValue : null;
        if (x === null) return "";
        const rows = list
          .map((p) => {
            const v = pointValue(p);
            if (p.seriesId === "rtt") return tipRow(t, cRtt, v === null ? "verloren" : fmtMs(v), "Latenz");
            if (v === null) return "";
            return tipRow(t, p.seriesId === "up" ? cUp : cDown, fmtMbit(v), p.seriesId === "up" ? "Upload" : "Download");
          })
          .join("");
        return tipHead(t, `${fmtAxisNumber(x)} s nach Start`) + rows;
      },
    },
    series: [
      { ...common, id: "down", name: "Download", color: cDown, xAxisIndex: 0, yAxisIndex: 0, data: down, areaStyle: { color: withAlpha(cDown, 0.14) }, markArea: areas.length ? { silent: true, data: areas } : undefined },
      { ...common, id: "up", name: "Upload", color: cUp, xAxisIndex: 0, yAxisIndex: 0, data: up, areaStyle: { color: withAlpha(cUp, 0.14) } },
      { ...common, id: "rtt", name: "Latenz", color: cRtt, xAxisIndex: 1, yAxisIndex: 1, data: rtt, markArea: areasNoLabel.length ? { silent: true, data: areasNoLabel } : undefined },
    ],
  };
}

export interface HistoryOptions {
  t: ChartTokens;
  tariffDown: number | null;
  tariffUp: number | null;
}

/** Verlauf aller Tests: Download/Upload, Tarif als Linie, Linkgeschwindigkeit der Netzwerkkarte als Stufenlinie. */
export function speedHistoryOption(items: readonly SpeedtestResult[], opts: HistoryOptions): EChartsCoreOption {
  const { t } = opts;
  const asc = [...items].sort((a, b) => a.ts - b.ts);
  const down = asc.filter((r) => r.downMbps !== null).map((r) => [r.ts, r.downMbps as number]);
  const up = asc.filter((r) => r.upMbps !== null).map((r) => [r.ts, r.upMbps as number]);
  const link = asc.filter((r) => r.nicLinkMbps !== null).map((r) => [r.ts, r.nicLinkMbps as number]);
  const cDown = t.series[0];
  const cUp = t.series[1];
  const marks: Record<string, unknown>[] = [];
  const tariffLine = (value: number, label: string) => ({
    yAxis: value,
    lineStyle: { color: t.fg3, width: 1, type: [4, 4] },
    label: { formatter: label, color: t.fg2, position: "insideStartTop" },
  });
  if (opts.tariffDown) marks.push(tariffLine(opts.tariffDown, `Tarif Download ${fmtAxisNumber(opts.tariffDown)} Mbit/s`));
  if (opts.tariffUp) marks.push(tariffLine(opts.tariffUp, `Tarif Upload ${fmtAxisNumber(opts.tariffUp)} Mbit/s`));
  const minTs = asc.length ? asc[0].ts : 0;
  const maxTs = asc.length ? asc[asc.length - 1].ts : 1;
  const pad = Math.max(30 * 60_000, (maxTs - minTs) * 0.03);
  const point = { type: "line", showSymbol: true, symbol: "circle", symbolSize: 6, connectNulls: true };

  return {
    animation: true,
    legend: { data: ["Download", "Upload", "LAN-Link (Netzwerkkarte)"], top: 0 },
    grid: { left: 4, right: 12, top: 44, bottom: 4, outerBoundsMode: "same", outerBoundsContain: "axisLabel" },
    xAxis: { type: "time", min: minTs - pad, max: maxTs + pad },
    yAxis: { type: "value", name: "Mbit/s", min: 0 },
    tooltip: {
      trigger: "axis",
      formatter: (raw: unknown) => {
        const list = asList(raw);
        const x = typeof list[0]?.axisValue === "number" ? list[0].axisValue : null;
        if (x === null) return "";
        const rows = list
          .map((p) => {
            const v = pointValue(p);
            if (v === null) return "";
            if (p.seriesId === "link") return tipRow(t, t.fg3, fmtLinkSpeed(v), "LAN-Link");
            return tipRow(t, p.seriesId === "up" ? cUp : cDown, fmtMbit(v), p.seriesId === "up" ? "Upload" : "Download");
          })
          .join("");
        return tipHead(t, fmtDateTimeShort(x)) + rows;
      },
    },
    series: [
      { ...point, id: "down", name: "Download", color: cDown, data: down, markLine: marks.length ? { silent: true, symbol: ["none", "none"], data: marks } : undefined },
      { ...point, id: "up", name: "Upload", color: cUp, data: up },
      {
        id: "link",
        name: "LAN-Link (Netzwerkkarte)",
        type: "line",
        step: "end",
        showSymbol: false,
        symbol: "none",
        color: t.fg3,
        lineStyle: { type: [6, 4], width: 1.5 },
        emphasis: { disabled: true },
        data: link,
      },
    ],
  };
}
