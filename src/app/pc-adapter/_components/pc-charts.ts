/** ECharts-Optionen der Seite „PC & Adapter“ (nur im Browser bauen – enthalten Formatter). */
import type { EChartsCoreOption } from "echarts/core";
import type { LinkEventDay } from "@/lib/shared/types";
import { chartTokens, fmtAxisNumber, withAlpha, type ChartTokens } from "@/lib/echarts-theme";

const TZ = "Europe/Berlin";
const dfTip = new Intl.DateTimeFormat("de-DE", { weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: TZ });
const dfDay = new Intl.DateTimeFormat("de-DE", { weekday: "short", day: "numeric", month: "numeric", timeZone: TZ });
const dfDayLong = new Intl.DateTimeFormat("de-DE", { weekday: "long", day: "numeric", month: "long", timeZone: TZ });

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] ?? ch);
}

function fmtVal(v: number, digits: number): string {
  return new Intl.NumberFormat("de-DE", { minimumFractionDigits: 0, maximumFractionDigits: digits }).format(v).replace("-", "−");
}

function tipHead(text: string, t: ChartTokens): string {
  return `<div style="font-family:${esc(t.fontMono)};font-size:11px;color:${t.fg3};margin-bottom:4px">${esc(text)}</div>`;
}

function tipRow(t: ChartTokens, color: string | null, value: string, label: string, box = false): string {
  const key = color
    ? `<span style="display:inline-block;flex:none;width:12px;height:${box ? 8 : 2}px;border-radius:${box ? 2 : 1}px;background:${color}"></span>`
    : `<span style="display:inline-block;flex:none;width:12px"></span>`;
  return (
    `<div style="display:flex;align-items:center;gap:8px;line-height:20px">${key}` +
    `<span style="font-family:${esc(t.fontMono)};font-weight:600;color:${t.fg};min-width:64px">${esc(value)}</span>` +
    `<span style="color:${t.fg3}">${esc(label)}</span></div>`
  );
}

const GRID = { left: 4, right: 12, bottom: 4, outerBoundsMode: "same", outerBoundsContain: "axisLabel" };

/* -------------------------------------------------------------------------- */
/* Kennzahl-Zeitreihen (GET /api/metrics)                                      */
/* -------------------------------------------------------------------------- */

export interface MetricLine {
  id: string;
  name: string;
  ts: readonly number[];
  values: readonly (number | null)[];
  slot: number;
}

export interface MetricLinesOptions {
  lines: readonly MetricLine[];
  stepMs: number;
  unit: string;
  digits?: number;
  from: number | null;
  to: number | null;
  yMin?: number;
  yMax?: number;
  /** waagerechte Schwelle (gestrichelt, Statusfarbe "auffällig") */
  threshold?: { value: number; label: string } | null;
  /** Spiel-Episoden als Hintergrundbereiche */
  episodes?: readonly [number, number][];
  t?: ChartTokens;
}

function points(ts: readonly number[], values: readonly (number | null)[], stepMs: number): [number, number | null][] {
  const out: [number, number | null][] = [];
  const maxGap = Math.max(1000, stepMs) * 1.5;
  for (let i = 0; i < ts.length; i++) {
    if (i > 0 && ts[i] - ts[i - 1] > maxGap) out.push([ts[i - 1] + stepMs, null]);
    const v = values[i];
    out.push([ts[i], typeof v === "number" && Number.isFinite(v) ? v : null]);
  }
  return out;
}

export function metricLinesOption(o: MetricLinesOptions): EChartsCoreOption {
  const t = o.t ?? chartTokens();
  const digits = o.digits ?? 1;
  const colors = o.lines.map((l) => t.series[l.slot] ?? t.other);
  const legend = o.lines.length >= 2;
  const areas = (o.episodes ?? []).map(([a, b]) => [{ xAxis: a, itemStyle: { color: withAlpha(t.laser, 0.1) } }, { xAxis: b }]);
  const marks = o.threshold
    ? {
        silent: true,
        symbol: "none",
        lineStyle: { color: t.warn, type: [4, 4], width: 1 },
        label: { color: t.warn, formatter: o.threshold.label, position: "insideEndTop", fontFamily: t.fontSans, fontSize: 11 },
        data: [{ yAxis: o.threshold.value }],
      }
    : undefined;
  return {
    animation: false,
    legend: legend ? { data: o.lines.map((l) => l.name) } : { show: false },
    grid: { ...GRID, top: legend ? 44 : 28 },
    tooltip: {
      trigger: "axis",
      formatter: (raw: unknown) => {
        const list = (Array.isArray(raw) ? raw : [raw]) as { seriesIndex?: number; value?: unknown; axisValue?: unknown }[];
        const ts = typeof list[0]?.axisValue === "number" ? list[0].axisValue : null;
        if (ts == null) return "";
        const rows = list
          .map((p) => {
            const i = p.seriesIndex ?? -1;
            const line = o.lines[i];
            if (!line) return "";
            const v = Array.isArray(p.value) ? p.value[1] : null;
            return tipRow(t, colors[i], typeof v === "number" ? `${fmtVal(v, digits)} ${o.unit}` : "kein Wert", line.name);
          })
          .join("");
        return tipHead(dfTip.format(ts), t) + rows;
      },
    },
    xAxis: { type: "time", min: o.from ?? undefined, max: o.to ?? undefined },
    yAxis: {
      type: "value",
      name: o.unit,
      min: o.yMin ?? 0,
      max: o.yMax ?? ((v: { max: number }) => (o.threshold ? Math.max(v.max, o.threshold.value * 1.25) : v.max)),
      axisLabel: { formatter: (v: number) => fmtAxisNumber(v) },
    },
    series: o.lines.map((l, i) => ({
      id: l.id,
      name: l.name,
      type: "line",
      color: colors[i],
      // wenige Messpunkte (z. B. kurze WLAN-Phasen): Punkte zeigen, sonst wären Einzelwerte unsichtbar
      showSymbol: l.values.filter((v) => v != null).length < 60,
      symbolSize: 5,
      connectNulls: false,
      lineStyle: { width: 1.5 },
      data: points(l.ts, l.values, o.stepMs),
      ...(i === 0 && areas.length ? { markArea: { silent: true, data: areas } } : {}),
      ...(i === 0 && marks ? { markLine: marks } : {}),
    })),
  };
}

/* -------------------------------------------------------------------------- */
/* Link-Ereignisse je Tag                                                      */
/* -------------------------------------------------------------------------- */

/** "YYYY-MM-DD" -> Mittag dieses Tages in Berlin (für Formatierung) */
const dayTs = (day: string): number => Date.parse(`${day}T12:00:00`);

export function linkDaysOption(days: readonly LinkEventDay[], t: ChartTokens = chartTokens()): EChartsCoreOption {
  const labels = days.map((d) => dfDay.format(dayTs(d.day)));
  const c = { down: t.series[2], up1g: t.series[0], up100m: t.warn, other: t.other };
  const defs = [
    { id: "down", name: "Link-Abbrüche (alle)", key: "down" as const, stack: "down", color: c.down },
    { id: "up1g", name: "Wiederaufbau mit 1 Gbit/s", key: "up1g" as const, stack: "up", color: c.up1g },
    { id: "up100m", name: "Wiederaufbau mit 100 Mbit/s", key: "up100m" as const, stack: "up", color: c.up100m },
    { id: "upOther", name: "Wiederaufbau mit anderer Geschwindigkeit", key: "upOther" as const, stack: "up", color: c.other },
  ];
  const withOther = days.some((d) => d.upOther > 0);
  const used = defs.filter((d) => d.key !== "upOther" || withOther);
  return {
    animation: false,
    legend: { data: used.map((d) => d.name) },
    grid: { ...GRID, top: 52 },
    tooltip: {
      trigger: "axis",
      axisPointer: { type: "shadow" },
      formatter: (raw: unknown) => {
        const list = (Array.isArray(raw) ? raw : [raw]) as { dataIndex?: number }[];
        const i = list[0]?.dataIndex;
        if (typeof i !== "number" || !days[i]) return "";
        const d = days[i];
        return (
          tipHead(dfDayLong.format(dayTs(d.day)), t) +
          used.map((def) => tipRow(t, def.color, fmtVal(d[def.key], 0), def.name, true)).join("")
        );
      },
    },
    xAxis: { type: "category", data: labels, axisTick: { show: false }, axisLabel: { hideOverlap: true } },
    yAxis: { type: "value", name: "Anzahl", minInterval: 1 },
    series: used.map((def) => ({
      id: def.id,
      name: def.name,
      type: "bar",
      stack: def.stack,
      color: def.color,
      barMaxWidth: 14,
      barGap: "15%",
      data: days.map((d) => d[def.key]),
    })),
  };
}
