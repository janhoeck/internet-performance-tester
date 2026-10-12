/**
 * ECharts-Optionen der Router-Seite (nur im Browser bauen – enthalten Formatter-Funktionen).
 * DOCSIS-Richtwerte als farbige Bänder (Vodafone-Servicetabelle, src/lib/shared/docsis.ts).
 */
import type { EChartsCoreOption } from "echarts/core";
import type { Breaks3, Breaks6, DocsisGrade } from "@/lib/shared/docsis";
import { chartTokens, fmtAxisNumber, withAlpha, type ChartTokens } from "@/lib/echarts-theme";
import type { Health } from "@/lib/health";

const TZ = "Europe/Berlin";
const dfTip = new Intl.DateTimeFormat("de-DE", { weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: TZ });
const nf1 = new Intl.NumberFormat("de-DE", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const nf0 = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 0 });

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] ?? ch);
}

const fmtVal = (v: number, digits: number): string => (digits === 0 ? nf0 : nf1).format(v).replace("-", "−");

function tipHead(text: string, t: ChartTokens): string {
  return `<div style="font-family:${esc(t.fontMono)};font-size:11px;color:${t.fg3};margin-bottom:4px">${esc(text)}</div>`;
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

const GRID = { left: 4, right: 12, top: 28, bottom: 4, outerBoundsMode: "same", outerBoundsContain: "axisLabel" };

/* -------------------------------------------------------------------------- */
/* Richtwert-Bänder                                                            */
/* -------------------------------------------------------------------------- */

export interface GradeBand {
  from: number;
  to: number;
  grade: Exclude<DocsisGrade, "unbekannt">;
}

/** Symmetrische Skala b0…b5 (Pegel) -> Bänder von lo bis hi. */
export function symmetricBands(b: Breaks6, lo: number, hi: number): GradeBand[] {
  const raw: GradeBand[] = [
    { from: lo, to: b[0], grade: "sofort" },
    { from: b[0], to: b[1], grade: "monatsfrist" },
    { from: b[1], to: b[2], grade: "toleriert" },
    { from: b[2], to: b[3], grade: "konform" },
    { from: b[3], to: b[4], grade: "toleriert" },
    { from: b[4], to: b[5], grade: "monatsfrist" },
    { from: b[5], to: hi, grade: "sofort" },
  ];
  return raw.filter((x) => x.to > x.from);
}

/** Untergrenzen-Skala a0…a2 (SNR/MER) -> Bänder von lo bis hi. */
export function lowerBoundBands(a: Breaks3, lo: number, hi: number): GradeBand[] {
  const raw: GradeBand[] = [
    { from: lo, to: a[0], grade: "sofort" },
    { from: a[0], to: a[1], grade: "monatsfrist" },
    { from: a[1], to: a[2], grade: "toleriert" },
    { from: a[2], to: hi, grade: "konform" },
  ];
  return raw.filter((x) => x.to > x.from);
}

function bandColor(g: GradeBand["grade"], t: ChartTokens): string {
  if (g === "konform") return withAlpha(t.good, 0.11);
  if (g === "toleriert") return withAlpha(t.good, 0.045);
  if (g === "monatsfrist") return withAlpha(t.warn, 0.1);
  return withAlpha(t.crit, 0.1);
}

function bandMarkArea(bands: readonly GradeBand[], t: ChartTokens): Record<string, unknown> | undefined {
  if (bands.length === 0) return undefined;
  return {
    silent: true,
    data: bands.map((b) => [{ yAxis: b.from, itemStyle: { color: bandColor(b.grade, t) } }, { yAxis: b.to }]),
  };
}

/** Achsenbereich so, dass die Bänder sichtbar sind und alle Werte passen. */
export function axisRange(values: readonly (number | null)[], minLo: number, minHi: number): { lo: number; hi: number } {
  let lo = minLo;
  let hi = minHi;
  for (const v of values) {
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    if (v - 1 < lo) lo = Math.floor(v - 1);
    if (v + 1 > hi) hi = Math.ceil(v + 1);
  }
  return { lo, hi };
}

/* -------------------------------------------------------------------------- */
/* Kanal-Balken                                                                */
/* -------------------------------------------------------------------------- */

export interface ChannelBar {
  /** Achsenbeschriftung, z. B. "602" (MHz) */
  label: string;
  /** Tooltip-Kopf, z. B. "DS 602 MHz (Kanal 12)" */
  title: string;
  value: number | null;
  health: Health;
  /** Bewertungstext für den Tooltip */
  note: string;
}

export interface ChannelBarsOptions {
  bars: readonly ChannelBar[];
  unit: string;
  bands: readonly GradeBand[];
  lo: number;
  hi: number;
  t?: ChartTokens;
}

function healthColor(h: Health, t: ChartTokens): string {
  if (h === "crit") return t.crit;
  if (h === "warn") return t.warn;
  if (h === "unknown") return t.unknown;
  return t.solo;
}

export function channelBarsOption(o: ChannelBarsOptions): EChartsCoreOption {
  const t = o.t ?? chartTokens();
  const data = o.bars.map((b) => ({
    value: b.value,
    // gute Kanäle etwas zurückgenommen ("leise wenn gesund"), Abweichungen in voller Statusfarbe
    itemStyle: { color: b.health === "good" ? withAlpha(t.solo, 0.7) : healthColor(b.health, t), borderRadius: [2, 2, 0, 0] },
  }));
  return {
    animation: false,
    grid: GRID,
    tooltip: {
      trigger: "axis",
      axisPointer: { type: "shadow" },
      formatter: (raw: unknown) => {
        const list = Array.isArray(raw) ? (raw as { dataIndex?: number }[]) : [raw as { dataIndex?: number }];
        const i = list[0]?.dataIndex;
        if (typeof i !== "number") return "";
        const b = o.bars[i];
        if (!b) return "";
        const v = b.value == null ? "kein Wert" : `${fmtVal(b.value, 1)} ${o.unit}`;
        return tipHead(b.title, t) + tipRow(t, healthColor(b.health, t), v, b.note);
      },
    },
    xAxis: {
      type: "category",
      data: o.bars.map((b) => b.label),
      axisLabel: { hideOverlap: true },
      axisTick: { show: false },
    },
    yAxis: { type: "value", name: o.unit, min: o.lo, max: o.hi },
    series: [
      {
        id: "bars",
        type: "bar",
        barMaxWidth: 22,
        data,
        markArea: bandMarkArea(o.bands, t),
      },
    ],
  };
}

/* -------------------------------------------------------------------------- */
/* Zeitreihen                                                                  */
/* -------------------------------------------------------------------------- */

export interface TimeLine {
  id: string;
  name: string;
  values: readonly (number | null)[];
  /** Slot der Kategorienpalette (feste Farbe je Größe) */
  slot: number;
}

export interface TimeLinesOptions {
  ts: readonly number[];
  lines: readonly TimeLine[];
  unit: string;
  digits?: number;
  from?: number | null;
  to?: number | null;
  bands?: readonly GradeBand[];
  lo?: number;
  hi?: number;
  /** Bereiche, in denen der Router nicht erreichbar war [start, ende] */
  outages?: readonly [number, number][];
  t?: ChartTokens;
}

/** Abstand, ab dem zwischen zwei Messpunkten eine Lücke gezeichnet wird (3 × Median-Abstand, min. 2 min). */
function gapThreshold(ts: readonly number[]): number {
  if (ts.length < 3) return Number.POSITIVE_INFINITY;
  const d: number[] = [];
  for (let i = 1; i < ts.length; i++) d.push(ts[i] - ts[i - 1]);
  d.sort((a, b) => a - b);
  return Math.max(120_000, d[d.length >> 1] * 3);
}

function withGaps(ts: readonly number[], values: readonly (number | null)[], maxGap: number): [number, number | null][] {
  const out: [number, number | null][] = [];
  for (let i = 0; i < ts.length; i++) {
    if (i > 0 && ts[i] - ts[i - 1] > maxGap) out.push([ts[i - 1] + 1, null]);
    const v = values[i];
    out.push([ts[i], typeof v === "number" && Number.isFinite(v) ? v : null]);
  }
  return out;
}

export function timeLinesOption(o: TimeLinesOptions): EChartsCoreOption {
  const t = o.t ?? chartTokens();
  const digits = o.digits ?? 1;
  const maxGap = gapThreshold(o.ts);
  const colors = o.lines.map((l) => t.series[l.slot] ?? t.other);
  const areas: Record<string, unknown>[][] = [];
  const bandArea = o.bands ? bandMarkArea(o.bands, t) : undefined;
  if (bandArea) areas.push(...(bandArea.data as Record<string, unknown>[][]));
  for (const [a, b] of o.outages ?? []) {
    areas.push([{ xAxis: a, itemStyle: { color: withAlpha(t.crit, 0.14) } }, { xAxis: b }]);
  }
  const legend = o.lines.length >= 2;
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
            const txt = typeof v === "number" ? `${fmtVal(v, digits)} ${o.unit}` : "kein Wert";
            return tipRow(t, colors[i], txt, line.name);
          })
          .join("");
        return tipHead(dfTip.format(ts), t) + rows;
      },
    },
    xAxis: { type: "time", min: o.from ?? undefined, max: o.to ?? undefined },
    yAxis: {
      type: "value",
      name: o.unit,
      min: o.lo ?? undefined,
      max: o.hi ?? undefined,
      scale: o.lo == null,
      axisLabel: { formatter: (v: number) => fmtAxisNumber(v) },
    },
    series: o.lines.map((l, i) => ({
      id: l.id,
      name: l.name,
      type: "line",
      color: colors[i],
      showSymbol: false,
      connectNulls: false,
      lineStyle: { width: 1.5 },
      data: withGaps(o.ts, l.values, maxGap),
      ...(i === 0 && areas.length ? { markArea: { silent: true, data: areas } } : {}),
    })),
  };
}
