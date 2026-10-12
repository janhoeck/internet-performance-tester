/**
 * ECharts-Options für die API-Formate – NUR im Browser bauen (Client-Komponenten), denn die
 * Options enthalten Funktionen (Tooltip-Formatter) und sind nicht serialisierbar.
 *
 *   const option = useMemo(() => latencySeriesOption(series, { targets, band: "p95", events }), [...]);
 *   <EChart option={option} ariaLabel="Latenz zu 1.1.1.1, letzte 24 Stunden" height={300} />
 *
 * Fertige Komponenten: <LatencySeriesChart/>, <LiveLatencyChart/>, <LossChart/>, <SecondsChart/>.
 *
 * Regeln (DESIGN.md §3.6, dataviz): eine y-Achse je Diagramm, Farbe folgt dem Ziel (feste Slots,
 * targets.ts), Statusfarben nur für Schwellen/Ereignisse, Lücke = keine Antwort/keine Messung
 * (nie überbrücken), Texte nie in Serienfarbe, Live-Diagramme ohne Animation.
 */
import type { EChartsCoreOption } from "echarts/core";
import type { HeatmapResponse, SecondsResponse, SeriesData, SeriesResponse } from "@/lib/shared/api-types";
import type { Band } from "@/lib/shared/config";
import { summarize } from "@/lib/shared/stats";
import { SampleStatus, type EventType, type NetEvent, type Sample, type SampleStatusCode, type SecondsRollup } from "@/lib/shared/types";
import {
  chartTokens,
  fmtAxisNumber,
  hourHeatmapOption,
  markLines,
  thresholdLine,
  withAlpha,
  type ChartTokens,
  type MarkLineItem,
} from "@/lib/echarts-theme";
import { DASH, fmtDuration, fmtLossPct, fmtMs, fmtMsValue, fmtPct } from "@/lib/format";
import { FAULT_CLASSES, FAULT_CLASS_BY_ID, FAULT_CLASS_IDS, type FaultClass } from "@/lib/segments";
import { heatmapCells, HEATMAP_METRIC, isLowCoverage, isOngoingEpisode } from "./adapters";

/* -------------------------------------------------------------------------- */
/* Gemeinsames                                                                 */
/* -------------------------------------------------------------------------- */

/** Eine Serie = ein Messziel mit Anzeigename und fester Farbe (hex, siehe seriesTargets() in targets.ts). */
export interface SeriesTarget {
  id: string;
  name: string;
  /** hex – Canvas kann keine CSS-Variablen auflösen */
  color: string;
}

/** Waagerechte Schwelle (gestrichelt). */
export interface ThresholdSpec {
  value: number;
  label: string;
  severity: "warn" | "crit";
}

/** Konfigurationsband (≤ good gut, ≤ warn auffällig, darüber kritisch) -> zwei Schwellenlinien. */
export function bandThresholds(band: Band | null | undefined, unit = "ms"): ThresholdSpec[] {
  if (!band) return [];
  const u = unit ? ` ${unit}` : "";
  const out: ThresholdSpec[] = [];
  if (band.good > 0) out.push({ value: band.good, label: `über ${fmtAxisNumber(band.good)}${u}: auffällig`, severity: "warn" });
  if (band.warn > band.good) out.push({ value: band.warn, label: `über ${fmtAxisNumber(band.warn)}${u}: kritisch`, severity: "crit" });
  return out;
}

type Point = [number, number | null, number];
type MarkAreaPair = [Record<string, unknown>, Record<string, unknown>];

const TZ = "Europe/Berlin";
const dfHead = new Intl.DateTimeFormat("de-DE", { weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: TZ });
const dfHeadSec = new Intl.DateTimeFormat("de-DE", {
  weekday: "short",
  day: "2-digit",
  month: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  timeZone: TZ,
});
const dfHm = new Intl.DateTimeFormat("de-DE", { hour: "2-digit", minute: "2-digit", timeZone: TZ });
const dfHms = new Intl.DateTimeFormat("de-DE", { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: TZ });

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] ?? ch);
}

/** Tooltip-Kopf für einen Messbucket: "Do., 08.10., 18:29–18:30" bzw. mit Sekunden. */
export function bucketLabel(ts: number, stepMs: number): string {
  if (stepMs >= 60_000) return `${dfHead.format(ts)}–${dfHm.format(ts + stepMs)}`;
  if (stepMs > 1000) return `${dfHeadSec.format(ts)}–${dfHms.format(ts + stepMs)}`;
  return dfHeadSec.format(ts);
}

function tipHead(text: string, t: ChartTokens): string {
  return `<div style="font-family:${esc(t.fontMono)};font-size:11px;color:${t.fg3};margin-bottom:4px">${esc(text)}</div>`;
}

function tipRow(t: ChartTokens, o: { color?: string; shape?: "line" | "box"; value: string; label: string; extra?: string }): string {
  const key = o.color
    ? `<span style="display:inline-block;flex:none;width:12px;height:${o.shape === "box" ? 8 : 2}px;border-radius:${o.shape === "box" ? 2 : 1}px;background:${o.color}"></span>`
    : `<span style="display:inline-block;flex:none;width:12px"></span>`;
  return (
    `<div style="display:flex;align-items:center;gap:8px;line-height:20px">${key}` +
    `<span style="font-family:${esc(t.fontMono)};font-weight:600;color:${t.fg};min-width:64px">${esc(o.value)}</span>` +
    `<span style="color:${t.fg3}">${esc(o.label)}</span>` +
    (o.extra ? `<span style="margin-left:auto;padding-left:12px;font-family:${esc(t.fontMono)};color:${t.fg3}">${esc(o.extra)}</span>` : "") +
    `</div>`
  );
}

interface AxisParam {
  seriesId?: string;
  seriesName?: string;
  color?: unknown;
  value?: unknown;
  axisValue?: unknown;
  dataIndex?: number;
}
const asList = (raw: unknown): AxisParam[] => (Array.isArray(raw) ? (raw as AxisParam[]) : raw ? [raw as AxisParam] : []);
/** Original-Index aus dem dritten Datenfeld ([ts, wert, index]); -1 = eingefügte Lücke. */
const origIndex = (p: AxisParam): number => (Array.isArray(p.value) && typeof p.value[2] === "number" ? p.value[2] : -1);
const axisTs = (p: AxisParam | undefined): number | null => (p && typeof p.axisValue === "number" ? p.axisValue : null);

/**
 * [ts, wert, index]-Punkte. Fehlende Buckets (Abstand > 1,5 Schritte) bekommen eine
 * null-Lücke, damit die Linie dort nicht durchgezogen wird.
 */
export function toPoints(ts: readonly number[], values: readonly (number | null)[], stepMs: number, gaps = true): Point[] {
  const out: Point[] = [];
  const maxGap = Math.max(1, stepMs) * 1.5;
  for (let i = 0; i < ts.length; i++) {
    if (gaps && i > 0 && ts[i] - ts[i - 1] > maxGap) out.push([ts[i - 1] + stepMs, null, -1]);
    const v = values[i];
    out.push([ts[i], typeof v === "number" && Number.isFinite(v) ? v : null, i]);
  }
  return out;
}

function grid(opts: { legend: boolean; zoom?: boolean; yName?: boolean }): Record<string, unknown> {
  return {
    left: 4,
    right: 12,
    top: opts.legend ? 44 : opts.yName === false ? 12 : 28,
    bottom: opts.zoom ? 40 : 4,
    outerBoundsMode: "same",
    outerBoundsContain: "axisLabel",
  };
}

function zoomComponents(enabled: boolean | undefined): Record<string, unknown>[] | undefined {
  if (!enabled) return undefined;
  return [
    { type: "inside", throttle: 50 },
    { type: "slider", height: 22, bottom: 0, showDetail: false },
  ];
}

/* -------------------------------------------------------------------------- */
/* Ereignis-Overlays                                                           */
/* -------------------------------------------------------------------------- */

type OverlayTone = "crit" | "warn" | "neutral" | "unknown" | "note";

interface OverlayDef {
  label: string;
  tone: OverlayTone;
  /** Beschriftung, solange die Episode noch läuft (endTs fehlt) */
  ongoing?: string;
}

/** Senkrechte Linien (Zeitpunkt). */
const LINE_EVENTS: Partial<Record<EventType, OverlayDef>> = {
  nic_link_down: { label: "Link weg", tone: "crit" },
  route_switch: { label: "Schnittstelle", tone: "warn" },
  router_reboot: { label: "Router-Neustart", tone: "warn" },
  route_change: { label: "Route", tone: "neutral" },
  ip_change: { label: "IP-Wechsel", tone: "neutral" },
  note: { label: "Notiz", tone: "note" },
};

/** Getönte Bereiche (Episoden; laufende – siehe isOngoingEpisode() – reichen bis "jetzt"). */
const AREA_EVENTS: Partial<Record<EventType, OverlayDef>> = {
  outage: { label: "Ausfall", tone: "crit", ongoing: "Ausfall läuft" },
  speedtest: { label: "Speedtest", tone: "neutral", ongoing: "Speedtest läuft" },
  router_offline: { label: "Router offline", tone: "warn", ongoing: "Router noch offline" },
  engine_gap: { label: "Messlücke", tone: "unknown" },
  standby: { label: "Standby", tone: "unknown" },
};

/** Standard: alles, was eine Linie oder einen Bereich hat. */
export const OVERLAY_EVENT_TYPES: readonly EventType[] = [
  ...(Object.keys(AREA_EVENTS) as EventType[]),
  ...(Object.keys(LINE_EVENTS) as EventType[]),
];

export interface EventOverlayOptions {
  from: number;
  to: number;
  /**
   * aktuelle Zeit: laufende Episoden (Ausfall läuft, Router noch offline, Link noch weg) reichen
   * bis min(to, now). Standard: to.
   */
  now?: number | null;
  t?: ChartTokens;
  /** nur diese Typen (Standard: OVERLAY_EVENT_TYPES) */
  types?: readonly EventType[];
  /** mehr Linien als das -> ohne Beschriftung (Standard 8) */
  maxLabels?: number;
}

export interface EventOverlays {
  /** für series.markArea.data */
  areas: MarkAreaPair[];
  /** für series.markLine.data (mit Schwellen bündeln: markLines([...])) */
  lines: MarkLineItem[];
}

function toneColor(tone: OverlayTone, t: ChartTokens): string {
  if (tone === "crit") return t.crit;
  if (tone === "warn") return t.warn;
  if (tone === "unknown") return t.unknown;
  if (tone === "note") return t.laser;
  return t.fg3;
}

function noteLabel(e: NetEvent): string {
  const d = e.details && typeof e.details === "object" ? (e.details as Record<string, unknown>) : {};
  return d.kind === "lag" ? "Lag" : "Notiz";
}

/**
 * NetEvent[] -> markArea/markLine-Einträge: Ausfall (Bereich, kritisch), Link-Abbruch (Linie,
 * plus Bereich bis zum Wiederaufbau), Speedtest-Fenster (neutral schattiert), Routenwechsel
 * (neutrale Linie), Router-Neustart/-Offline, Messlücke/Standby, Notizen ("Lag", violett).
 * Laufende Episoden (endTs fehlt noch, z. B. "Ausfall läuft") reichen bis min(to, now) – auch
 * wenn sie vor `from` begonnen haben.
 */
export function eventOverlays(events: readonly NetEvent[] | null | undefined, opts: EventOverlayOptions): EventOverlays {
  const t = opts.t ?? chartTokens();
  const allow = new Set(opts.types ?? OVERLAY_EVENT_TYPES);
  const span = Math.max(1, opts.to - opts.from);
  const openUntil = opts.now != null ? Math.min(opts.to, opts.now) : opts.to;
  const areas: MarkAreaPair[] = [];
  const lineEvents: Array<{ ts: number; def: OverlayDef; e: NetEvent }> = [];
  for (const e of events ?? []) {
    if (!allow.has(e.type)) continue;
    const ongoing = isOngoingEpisode(e) && openUntil > e.ts;
    const end = ongoing ? openUntil : e.endTs != null && e.endTs > e.ts ? e.endTs : null;
    if ((end ?? e.ts) < opts.from || e.ts > opts.to) continue;
    const areaDef = AREA_EVENTS[e.type];
    if (areaDef && end != null) {
      const a = Math.max(opts.from, e.ts);
      const b = Math.min(opts.to, end);
      const c = toneColor(areaDef.tone, t);
      const alpha = areaDef.tone === "neutral" ? 0.16 : areaDef.tone === "crit" ? (t.mode === "dark" ? 0.14 : 0.1) : 0.1;
      // laufende Episoden immer beschriften (sonst sieht man nicht, dass sie noch andauern)
      const wide = ongoing || (b - a) / span >= 0.03;
      areas.push([
        {
          name: ongoing ? (areaDef.ongoing ?? areaDef.label) : areaDef.label,
          xAxis: a,
          itemStyle: { color: withAlpha(areaDef.tone === "neutral" ? t.fg4 : c, alpha) },
          label: { show: wide, color: areaDef.tone === "neutral" ? t.fg3 : c },
        },
        { xAxis: b },
      ]);
      continue;
    }
    const lineDef = LINE_EVENTS[e.type];
    if (!lineDef) continue;
    if (e.ts >= opts.from && e.ts <= opts.to) lineEvents.push({ ts: e.ts, def: lineDef, e });
    // Link weg bis Link wieder da (bzw. bis jetzt, solange er noch weg ist): zusätzlich ein leichter Bereich
    if (e.type === "nic_link_down" && end != null && end - e.ts >= 1000) {
      const a = Math.max(opts.from, e.ts);
      const b = Math.min(opts.to, end);
      areas.push([
        {
          name: ongoing ? "Link noch weg" : "",
          xAxis: a,
          itemStyle: { color: withAlpha(t.crit, ongoing ? 0.12 : 0.08) },
          // die Linie trägt schon "Link weg" – nur beschriften, wenn der Abbruch vor dem Fenster begann
          label: { show: ongoing && e.ts < opts.from, color: t.crit },
        },
        { xAxis: b },
      ]);
    }
  }
  // Beschriftungen entzerren: dicht beieinander liegende Linien (< 2 % der Breite) nur einmal
  // beschriften – wichtigere zuerst (kritisch > auffällig > Notiz > neutral), höchstens maxLabels
  const minGap = span * 0.02;
  const labeledTs: number[] = [];
  const withLabel = new Set<number>();
  const order = lineEvents.map((le, i) => ({ ...le, i })).sort((a, b) => TONE_PRIORITY[a.def.tone] - TONE_PRIORITY[b.def.tone] || a.ts - b.ts);
  for (const le of order) {
    if (labeledTs.length >= (opts.maxLabels ?? 8)) break;
    if (labeledTs.some((x) => Math.abs(x - le.ts) < minGap)) continue;
    labeledTs.push(le.ts);
    withLabel.add(le.i);
  }
  const lines: MarkLineItem[] = lineEvents.map(({ ts, def, e }, i) => {
    const c = toneColor(def.tone, t);
    return {
      xAxis: ts,
      lineStyle: { color: c, width: 1, type: "solid", opacity: def.tone === "neutral" ? 0.7 : 0.85 },
      label: { show: withLabel.has(i), formatter: e.type === "note" ? noteLabel(e) : def.label, color: t.fg2, position: "insideEndTop" },
    } as MarkLineItem;
  });
  return { areas, lines };
}

const TONE_PRIORITY: Record<OverlayTone, number> = { crit: 0, warn: 1, note: 2, unknown: 3, neutral: 4 };

/**
 * Schwellen als markLine-Einträge. Beschriftung abwechselnd links/rechts (dicht liegende
 * Schwellen überdecken sich nicht); Schwellen, die bei dieser Achse an der Grundlinie kleben
 * würden (< 4 % des Achsenmaximums), entfallen.
 */
function thresholdItems(specs: readonly ThresholdSpec[] | undefined, t: ChartTokens, axisMax?: number | null): MarkLineItem[] {
  const list = (specs ?? []).filter((s) => !axisMax || axisMax <= 0 || s.value >= axisMax * 0.04);
  return list.map((s, i) => {
    const item = thresholdLine(s.value, s.label, s.severity, t) as Record<string, unknown>;
    const label = (item.label ?? {}) as Record<string, unknown>;
    return { ...item, label: { ...label, position: i % 2 === 0 ? "insideStartTop" : "insideEndTop" } } as MarkLineItem;
  });
}

function maxOf(...arrays: ReadonlyArray<ReadonlyArray<number | null> | undefined>): number {
  let m = 0;
  for (const arr of arrays) for (const v of arr ?? []) if (typeof v === "number" && Number.isFinite(v) && v > m) m = v;
  return m;
}

function markAreaOf(areas: readonly MarkAreaPair[]): Record<string, unknown> | undefined {
  return areas.length ? { silent: true, data: [...areas] } : undefined;
}

/** Aufeinanderfolgende Buckets ohne beantworteten Ping (gesendet > 0, avg null) -> Bereiche. */
export function totalLossRanges(d: SeriesData | undefined, stepMs: number): Array<[number, number]> {
  if (!d) return [];
  const out: Array<[number, number]> = [];
  let start: number | null = null;
  let end = 0;
  for (let i = 0; i < d.ts.length; i++) {
    const lostAll = (d.sent[i] ?? 0) > 0 && d.avg[i] == null;
    if (lostAll) {
      if (start != null && d.ts[i] - end <= stepMs * 0.5) end = d.ts[i] + stepMs;
      else {
        if (start != null) out.push([start, end]);
        start = d.ts[i];
        end = d.ts[i] + stepMs;
      }
    }
  }
  if (start != null) out.push([start, end]);
  return out;
}

function lossAreas(ranges: ReadonlyArray<[number, number]>, t: ChartTokens): MarkAreaPair[] {
  return ranges.map(([a, b]) => [
    { name: "", xAxis: a, itemStyle: { color: withAlpha(t.crit, t.mode === "dark" ? 0.12 : 0.09) }, label: { show: false } },
    { xAxis: b },
  ]);
}

/* -------------------------------------------------------------------------- */
/* Latenz-Zeitreihe (GET /api/series)                                          */
/* -------------------------------------------------------------------------- */

export interface LatencySeriesOptions {
  /** Reihenfolge = Legende; Ziele ohne Daten in der Antwort werden übersprungen */
  targets: readonly SeriesTarget[];
  /** Band um die Linie: min–max oder Ø–p95 (nur für EIN Ziel: bandTarget, Standard das erste) */
  band?: "none" | "minmax" | "p95";
  bandTarget?: string;
  /** Buckets ohne beantworteten Ping rot hinterlegen (Standard: nur bei einem Ziel) */
  lossAreas?: boolean;
  events?: readonly NetEvent[] | null;
  thresholds?: readonly ThresholdSpec[];
  /** Achsenbereich (Standard: from/to der Antwort) */
  from?: number;
  to?: number;
  /** dataZoom (Mausrad/Ziehen + Schieber) */
  zoom?: boolean;
  /** feste Obergrenze der y-Achse (ms), z. B. 300 – Ausreißer werden abgeschnitten */
  yMax?: number;
  animation?: boolean;
  t?: ChartTokens;
}

/** true, wenn mindestens ein Ziel in der Antwort Messungen hat (für Leerzustände). */
export function seriesHasData(res: SeriesResponse | null | undefined, ids?: readonly string[]): boolean {
  if (!res?.series) return false;
  const keys = ids ?? Object.keys(res.series);
  return keys.some((id) => {
    const d = res.series[id];
    return d != null && d.sent.some((n) => n > 0);
  });
}

/**
 * Ø-Latenz je Bucket als Linie (Lücke = keine Antwort oder keine Messung), optional Band
 * min–max bzw. Ø–p95, Schwellen, Ereignis-Overlays, Bereiche mit 100 % Verlust.
 */
export function latencySeriesOption(res: SeriesResponse | null | undefined, opts: LatencySeriesOptions): EChartsCoreOption {
  const t = opts.t ?? chartTokens();
  const from = opts.from ?? res?.from ?? 0;
  const to = opts.to ?? res?.to ?? 0;
  const step = res?.stepMs && res.stepMs > 0 ? res.stepMs : 60_000;
  const present = opts.targets.filter((tg) => res?.series?.[tg.id]);
  const byId = new Map(present.map((tg) => [tg.id, res!.series[tg.id]]));
  const bandMode = opts.band ?? "none";
  const bandId = bandMode !== "none" ? (opts.bandTarget ?? present[0]?.id) : undefined;
  const lossId = (opts.lossAreas ?? present.length === 1) ? (opts.bandTarget ?? present[0]?.id) : undefined;
  const overlays = eventOverlays(opts.events, { from, to, t });
  const bandHi = bandId ? (bandMode === "minmax" ? byId.get(bandId)?.max : byId.get(bandId)?.p95) : undefined;
  const axisMax = opts.yMax ?? maxOf(...present.map((tg) => byId.get(tg.id)?.avg), bandHi);
  const thresholdLines = thresholdItems(opts.thresholds, t, axisMax);
  const areas = [...overlays.areas, ...(lossId ? lossAreas(totalLossRanges(byId.get(lossId), step), t) : [])];

  const series: Record<string, unknown>[] = present.map((tg, i) => {
    const d = byId.get(tg.id)!;
    return {
      id: `lat:${tg.id}`,
      name: tg.name,
      type: "line",
      color: tg.color,
      z: 3,
      data: toPoints(d.ts, d.avg, step),
      ...(i === 0
        ? {
            markArea: markAreaOf(areas),
            markLine: thresholdLines.length + overlays.lines.length ? markLines([...thresholdLines, ...overlays.lines]) : undefined,
          }
        : {}),
    };
  });

  const bandData = bandId ? byId.get(bandId) : undefined;
  const bandTarget = bandId ? present.find((tg) => tg.id === bandId) : undefined;
  if (bandData && bandTarget) {
    const lo = bandMode === "minmax" ? bandData.min : bandData.avg;
    const hi = bandMode === "minmax" ? bandData.max : bandData.p95;
    const base: (number | null)[] = [];
    const spanV: (number | null)[] = [];
    for (let i = 0; i < bandData.ts.length; i++) {
      const a = lo[i];
      const b = hi[i];
      const ok = a != null && b != null && Number.isFinite(a) && Number.isFinite(b);
      base.push(ok ? a : null);
      spanV.push(ok ? Math.max(0, (b as number) - (a as number)) : null);
    }
    const common = {
      name: bandTarget.name,
      type: "line",
      stack: `band:${bandId}`,
      color: bandTarget.color,
      z: 1,
      silent: true,
      showSymbol: false,
      symbol: "none",
      sampling: undefined, // gleiche Punkte in beiden Band-Serien (Stapel nach Index)
      lineStyle: { width: 0, opacity: 0 },
      emphasis: { disabled: true },
      tooltip: { show: false },
    };
    series.push(
      { ...common, id: `band-base:${bandId}`, data: toPoints(bandData.ts, base, step) },
      { ...common, id: `band-span:${bandId}`, data: toPoints(bandData.ts, spanV, step), areaStyle: { color: withAlpha(bandTarget.color, 0.16) } },
    );
  }

  const legend = present.length >= 2;
  return {
    animation: opts.animation ?? true,
    legend: legend ? { data: present.map((tg) => tg.name) } : { show: false },
    grid: grid({ legend, zoom: opts.zoom }),
    dataZoom: zoomComponents(opts.zoom),
    tooltip: {
      trigger: "axis",
      formatter: (raw: unknown) => {
        const list = asList(raw);
        const ts = axisTs(list[0]);
        if (ts == null) return "";
        const rows = list
          .filter((p) => typeof p.seriesId === "string" && p.seriesId.startsWith("lat:"))
          .map((p) => {
            const id = (p.seriesId as string).slice(4);
            const d = byId.get(id);
            const i = origIndex(p);
            const tg = present.find((x) => x.id === id);
            if (!d || i < 0) return tipRow(t, { color: tg?.color, value: "keine Messung", label: tg?.name ?? id });
            const sent = d.sent[i] ?? 0;
            const avg = d.avg[i];
            const loss = d.lossPct[i];
            const value = sent === 0 ? "keine Messung" : avg == null ? "keine Antwort" : fmtMs(avg);
            const extras: string[] = [];
            if (id === bandId && avg != null) {
              if (bandMode === "minmax" && d.min[i] != null && d.max[i] != null) extras.push(`${fmtMsValue(d.min[i])}–${fmtMs(d.max[i])}`);
              if (bandMode === "p95" && d.p95[i] != null) extras.push(`p95 ${fmtMs(d.p95[i])}`);
            }
            if (loss != null && loss > 0) extras.push(`Verlust ${fmtLossPct(loss)}`);
            return tipRow(t, { color: tg?.color, value, label: tg?.name ?? id, extra: extras.join(", ") || undefined });
          })
          .join("");
        return tipHead(bucketLabel(ts, step), t) + rows;
      },
    },
    xAxis: { type: "time", min: from, max: to },
    yAxis: { type: "value", name: "ms", min: 0, max: opts.yMax },
    series,
  };
}

/* -------------------------------------------------------------------------- */
/* Live-Latenz (Ringpuffer des Live-Streams)                                   */
/* -------------------------------------------------------------------------- */

export interface LiveLatencyOptions {
  targets: readonly SeriesTarget[];
  /** aktuelle Zeit (useNow(1000)) – rechter Rand */
  now: number;
  /** sichtbares Fenster (Standard 5 min, max. 15 min = Ringpuffer) */
  windowMs?: number;
  thresholds?: readonly ThresholdSpec[];
  events?: readonly NetEvent[] | null;
  yMax?: number;
  t?: ChartTokens;
}

const STATUS_TEXT: Record<SampleStatusCode, string> = {
  [SampleStatus.OK]: "",
  [SampleStatus.TIMEOUT]: "Zeitüberschreitung",
  [SampleStatus.UNREACHABLE]: "nicht erreichbar",
  [SampleStatus.ERROR]: "Fehler",
  [SampleStatus.TTL_EXPIRED]: "TTL abgelaufen",
};

function firstAtOrAfter(arr: readonly Sample[], ts: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid].ts < ts) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Samples im Fenster [from, to] (aufsteigend), ohne Kopie wenn möglich. */
export function samplesInWindow(arr: readonly Sample[] | undefined, from: number, to = Number.POSITIVE_INFINITY): readonly Sample[] {
  if (!arr || arr.length === 0) return [];
  const a = firstAtOrAfter(arr, from);
  const b = to === Number.POSITIVE_INFINITY ? arr.length : firstAtOrAfter(arr, to + 1);
  return a === 0 && b === arr.length ? arr : arr.slice(a, b);
}

const isOk = (s: Sample): boolean => s.status === SampleStatus.OK && s.rtt != null && Number.isFinite(s.rtt);

/**
 * Live-Linien aus den Ringpuffern: verlorene Pings = Lücke (bei einem Ziel zusätzlich rot
 * hinterlegt), keine Animation. Mit useLiveSampleMap() (≤ 1 Update/s) + useNow(1000) nutzen.
 */
export function liveLatencyOption(samples: Readonly<Record<string, readonly Sample[]>>, opts: LiveLatencyOptions): EChartsCoreOption {
  const t = opts.t ?? chartTokens();
  const windowMs = Math.min(opts.windowMs ?? 5 * 60_000, 15 * 60_000);
  const to = opts.now;
  const from = to - windowMs;
  const lists = new Map(opts.targets.map((tg) => [tg.id, samplesInWindow(samples[tg.id], from, to + 1000)]));

  const series: Record<string, unknown>[] = opts.targets.map((tg) => {
    const arr = lists.get(tg.id) ?? [];
    const data: Point[] = [];
    for (let k = 0; k < arr.length; k++) {
      const s = arr[k];
      if (k > 0 && s.ts - arr[k - 1].ts > 2500) data.push([arr[k - 1].ts + 1000, null, -1]);
      data.push([s.ts, isOk(s) ? (s.rtt as number) : null, k]);
    }
    return { id: `live:${tg.id}`, name: tg.name, type: "line", color: tg.color, data, sampling: undefined, z: 3 };
  });

  // Verlust bei genau einem Ziel als Bereiche, Ereignisse + Schwellen an der ersten Serie
  const areas: MarkAreaPair[] = [];
  if (opts.targets.length === 1) {
    const arr = lists.get(opts.targets[0].id) ?? [];
    let start: number | null = null;
    let end = 0;
    for (const s of arr) {
      if (!isOk(s)) {
        if (start == null) start = s.ts;
        end = s.ts + 1000;
      } else if (start != null) {
        areas.push([{ name: "", xAxis: start, itemStyle: { color: withAlpha(t.crit, 0.14) }, label: { show: false } }, { xAxis: end }]);
        start = null;
      }
    }
    if (start != null) areas.push([{ name: "", xAxis: start, itemStyle: { color: withAlpha(t.crit, 0.14) }, label: { show: false } }, { xAxis: end }]);
  }
  const overlays = eventOverlays(opts.events, { from, to, t });
  let liveMax = 0;
  for (const arr of lists.values()) for (const s of arr) if (isOk(s) && (s.rtt as number) > liveMax) liveMax = s.rtt as number;
  const thresholdLines = thresholdItems(opts.thresholds, t, opts.yMax ?? liveMax);
  if (series[0]) {
    const allAreas = [...overlays.areas, ...areas];
    series[0].markArea = markAreaOf(allAreas);
    if (thresholdLines.length + overlays.lines.length) series[0].markLine = markLines([...thresholdLines, ...overlays.lines]);
  }

  const legend = opts.targets.length >= 2;
  return {
    animation: false,
    legend: legend ? { data: opts.targets.map((tg) => tg.name) } : { show: false },
    grid: grid({ legend }),
    tooltip: {
      trigger: "axis",
      formatter: (raw: unknown) => {
        const list = asList(raw);
        const ts = axisTs(list[0]);
        if (ts == null) return "";
        const rows = list
          .filter((p) => typeof p.seriesId === "string" && p.seriesId.startsWith("live:"))
          .map((p) => {
            const id = (p.seriesId as string).slice(5);
            const tg = opts.targets.find((x) => x.id === id);
            const arr = lists.get(id) ?? [];
            const k = origIndex(p);
            const s = k >= 0 ? arr[k] : undefined;
            const value = !s ? "keine Messung" : isOk(s) ? fmtMs(s.rtt) : "verloren";
            const extra = s && !isOk(s) ? STATUS_TEXT[s.status] || undefined : undefined;
            return tipRow(t, { color: tg?.color, value, label: tg?.name ?? id, extra });
          })
          .join("");
        return tipHead(dfHeadSec.format(ts), t) + rows;
      },
    },
    xAxis: { type: "time", min: from, max: to },
    yAxis: { type: "value", name: "ms", min: 0, max: opts.yMax },
    series,
  };
}

/* -------------------------------------------------------------------------- */
/* Paketverlust als Balken (GET /api/series -> lossPct)                        */
/* -------------------------------------------------------------------------- */

export interface LossBarsOptions {
  targets: readonly SeriesTarget[];
  from?: number;
  to?: number;
  events?: readonly NetEvent[] | null;
  thresholds?: readonly ThresholdSpec[];
  t?: ChartTokens;
}

/** Verlust je Bucket in % (eine Balkenserie je Ziel, y-Achse mindestens bis 1 %). */
export function lossBarsOption(res: SeriesResponse | null | undefined, opts: LossBarsOptions): EChartsCoreOption {
  const t = opts.t ?? chartTokens();
  const from = opts.from ?? res?.from ?? 0;
  const to = opts.to ?? res?.to ?? 0;
  const step = res?.stepMs && res.stepMs > 0 ? res.stepMs : 60_000;
  const present = opts.targets.filter((tg) => res?.series?.[tg.id]);
  const byId = new Map(present.map((tg) => [tg.id, res!.series[tg.id]]));
  const overlays = eventOverlays(opts.events, { from, to, t, types: ["outage", "speedtest", "engine_gap", "standby", "nic_link_down", "note"] });
  // Achse wie unten: mindestens 1 %, sonst aufgerundetes Maximum
  const axisMax = Math.max(1, Math.ceil(maxOf(...present.map((tg) => byId.get(tg.id)?.lossPct))));
  const thresholdLines = thresholdItems(opts.thresholds, t, axisMax);

  const series: Record<string, unknown>[] = present.map((tg, i) => {
    const d = byId.get(tg.id)!;
    return {
      id: `loss:${tg.id}`,
      name: tg.name,
      type: "bar",
      color: tg.color,
      barGap: "10%",
      data: toPoints(d.ts, d.lossPct, step, false),
      ...(i === 0
        ? {
            markArea: markAreaOf(overlays.areas),
            markLine: thresholdLines.length + overlays.lines.length ? markLines([...thresholdLines, ...overlays.lines]) : undefined,
          }
        : {}),
    };
  });

  const legend = present.length >= 2;
  return {
    animation: false,
    legend: legend ? { data: present.map((tg) => tg.name) } : { show: false },
    grid: grid({ legend }),
    tooltip: {
      trigger: "axis",
      formatter: (raw: unknown) => {
        const list = asList(raw);
        const ts = axisTs(list[0]);
        if (ts == null) return "";
        const rows = list
          .filter((p) => typeof p.seriesId === "string" && p.seriesId.startsWith("loss:"))
          .map((p) => {
            const id = (p.seriesId as string).slice(5);
            const d = byId.get(id);
            const tg = present.find((x) => x.id === id);
            const i = origIndex(p);
            if (!d || i < 0) return tipRow(t, { color: tg?.color, shape: "box", value: "keine Messung", label: tg?.name ?? id });
            const sent = d.sent[i] ?? 0;
            const loss = d.lossPct[i];
            if (sent === 0 || loss == null) return tipRow(t, { color: tg?.color, shape: "box", value: "keine Messung", label: tg?.name ?? id });
            const lost = Math.round((loss * sent) / 100);
            return tipRow(t, { color: tg?.color, shape: "box", value: fmtLossPct(loss), label: tg?.name ?? id, extra: `${lost} von ${sent} Pings` });
          })
          .join("");
        return tipHead(bucketLabel(ts, step), t) + rows;
      },
    },
    xAxis: { type: "time", min: from, max: to },
    yAxis: { type: "value", name: "%", min: 0, max: (v: { max: number }) => Math.max(1, Math.ceil(v.max)) },
    series,
  };
}

/* -------------------------------------------------------------------------- */
/* Klassifizierte Sekunden (GET /api/seconds)                                  */
/* -------------------------------------------------------------------------- */

/** Klassen-Farbe (hex) aus der Segment-Rampe bzw. "Sonstige" – nie Statusfarben. */
export function faultClassColor(id: FaultClass, t: ChartTokens = chartTokens()): string {
  const ramp = FAULT_CLASS_BY_ID[id].ramp;
  return ramp == null ? t.other : (t.seg[ramp] ?? t.other);
}

export type SecondsUnit = "s" | "min" | "pct";

export interface SecondsStackOptions {
  /** Reihenfolge = Stapel von unten (nah) nach oben (fern); Standard: alle Störungsklassen */
  classes?: readonly FaultClass[];
  /** s = Sekunden, min = Minuten, pct = Anteil an der gemessenen Zeit des Buckets */
  unit?: SecondsUnit;
  from?: number;
  to?: number;
  events?: readonly NetEvent[] | null;
  t?: ChartTokens;
}

const SECONDS_UNIT_NAME: Record<SecondsUnit, string> = { s: "s", min: "min", pct: "%" };

/** Summe der gestörten Sekunden (alle Störungsklassen) eines Rollups. */
export function badSeconds(r: SecondsRollup | null | undefined): number {
  if (!r) return 0;
  return FAULT_CLASS_IDS.reduce((sum, c) => sum + (r[c] ?? 0), 0);
}

/**
 * Gestapelte Balken: gestörte Sekunden je Bucket nach Abschnitt (PC & Kabel, Heimnetz,
 * Kabelnetz, DS-Lite, Vodafone-Netz, Weg zum Spieleserver, Unklar). Farben = ordinale
 * Segment-Rampe (nah hell -> fern dunkel), 2-px-Flächenfuge zwischen den Segmenten.
 */
export function secondsStackOption(res: SecondsResponse | null | undefined, opts: SecondsStackOptions = {}): EChartsCoreOption {
  const t = opts.t ?? chartTokens();
  const classes = opts.classes ?? FAULT_CLASS_IDS;
  const unit = opts.unit ?? "s";
  const buckets = res?.buckets ?? [];
  const step = res?.stepMs && res.stepMs > 0 ? res.stepMs : 60_000;
  const from = opts.from ?? res?.from ?? 0;
  const to = opts.to ?? res?.to ?? 0;
  const conv = (b: SecondsRollup, v: number): number | null =>
    unit === "pct" ? (b.covered > 0 ? (v / b.covered) * 100 : null) : unit === "min" ? v / 60 : v;

  // oberstes Segment je Bucket bekommt die runde Kappe
  const top: Array<FaultClass | null> = buckets.map((b) => {
    let last: FaultClass | null = null;
    for (const c of classes) if ((b[c] ?? 0) > 0) last = c;
    return last;
  });
  const thin = buckets.length > 150;

  const series = classes.map((c) => ({
    id: `sec:${c}`,
    name: FAULT_CLASS_BY_ID[c].label,
    type: "bar",
    stack: "seconds",
    color: faultClassColor(c, t),
    itemStyle: { borderRadius: 0, borderColor: t.surface, borderWidth: thin ? 0 : 1 },
    emphasis: { focus: "series" },
    data: buckets.map((b, i) => {
      const v = b[c] ?? 0;
      const value: [number, number | null, number] = [b.ts, v > 0 ? conv(b, v) : null, i];
      return top[i] === c ? { value, itemStyle: { borderRadius: [4, 4, 0, 0] } } : value;
    }),
  }));
  const overlays = eventOverlays(opts.events, { from, to, t, types: ["outage", "speedtest", "engine_gap", "standby", "note"] });
  if (series[0] && overlays.areas.length) (series[0] as Record<string, unknown>).markArea = markAreaOf(overlays.areas);
  if (series[0] && overlays.lines.length) (series[0] as Record<string, unknown>).markLine = markLines(overlays.lines);

  return {
    animation: false,
    legend: { data: classes.map((c) => FAULT_CLASS_BY_ID[c].label) },
    grid: grid({ legend: true }),
    tooltip: {
      trigger: "axis",
      formatter: (raw: unknown) => {
        const list = asList(raw);
        const ts = axisTs(list[0]);
        const p0 = list.find((p) => origIndex(p) >= 0);
        if (ts == null) return "";
        const i = p0 ? origIndex(p0) : buckets.findIndex((b) => b.ts === ts);
        const b = i >= 0 ? buckets[i] : undefined;
        const head = tipHead(bucketLabel(b?.ts ?? ts, step), t);
        if (!b || b.covered === 0) return `${head}<div style="color:${t.fg3}">keine Messung (PC aus, Standby oder kein Test)</div>`;
        const bad = badSeconds(b);
        const rows = classes
          .filter((c) => (b[c] ?? 0) > 0)
          .map((c) =>
            tipRow(t, {
              color: faultClassColor(c, t),
              shape: "box",
              value: fmtDuration(b[c]),
              label: FAULT_CLASS_BY_ID[c].label,
              extra: fmtPct((b[c] / b.covered) * 100),
            }),
          )
          .join("");
        const summary =
          `<div style="margin-top:4px;border-top:1px solid ${t.line};padding-top:4px">` +
          tipRow(t, { value: fmtDuration(bad), label: "gestört", extra: fmtPct((bad / b.covered) * 100) }) +
          tipRow(t, { value: fmtDuration(b.covered), label: "gemessen" }) +
          `</div>`;
        return head + (rows || `<div style="color:${t.fg3}">keine gestörten Sekunden</div>`) + summary;
      },
    },
    xAxis: { type: "time", min: from, max: to },
    yAxis: { type: "value", name: SECONDS_UNIT_NAME[unit], min: 0, max: unit === "pct" ? (v: { max: number }) => Math.min(100, Math.max(1, Math.ceil(v.max))) : undefined },
    series,
  };
}

export interface FaultShareItem {
  id: FaultClass;
  label: string;
  seconds: number;
  /** Anteil an allen gestörten Sekunden, 0..100 */
  share: number;
  /** Anteil an der gemessenen Zeit, 0..100 */
  ofCovered: number;
  /** CSS-Farbe (var(--np-seg-…)) für HTML/SVG */
  color: string;
}

export interface FaultBreakdown {
  covered: number;
  bad: number;
  /** gestörte Sekunden / gemessene Sekunden, 0..100 (null ohne Messung) */
  badPct: number | null;
  /** nur Klassen mit Sekunden > 0, Reihenfolge nah -> fern */
  items: FaultShareItem[];
  /** Klasse mit den meisten gestörten Sekunden */
  top: FaultShareItem | null;
}

/** Summenzeile (SecondsResponse.total) -> Anteile je Abschnitt (für <FaultShareBar/>, Tabellen, KPIs). */
export function secondsBreakdown(total: SecondsRollup | null | undefined): FaultBreakdown {
  if (!total) return { covered: 0, bad: 0, badPct: null, items: [], top: null };
  const bad = badSeconds(total);
  const items = FAULT_CLASSES.filter((c) => (total[c.id] ?? 0) > 0).map((c) => ({
    id: c.id,
    label: c.label,
    seconds: total[c.id],
    share: bad > 0 ? (total[c.id] / bad) * 100 : 0,
    ofCovered: total.covered > 0 ? (total[c.id] / total.covered) * 100 : 0,
    color: c.color,
  }));
  const top = items.reduce<FaultShareItem | null>((best, it) => (!best || it.seconds > best.seconds ? it : best), null);
  return { covered: total.covered, bad, badPct: total.covered > 0 ? (bad / total.covered) * 100 : null, items, top };
}

/* -------------------------------------------------------------------------- */
/* Heatmap (GET /api/heatmap)                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Interaktive Stunde×Tag-Heatmap (ECharts) inkl. Schraffur für Stunden ohne Messung. Stunden mit
 * wenig Messzeit (coverage < HEATMAP_LOW_COVERAGE_PCT) werden gedämpft und fein schraffiert.
 * Statisch/druckbar besser: <HourHeatmap {...heatmapCells(res)} {...HEATMAP_METRIC[res.metric]} />.
 */
export function heatmapOption(res: HeatmapResponse | null | undefined, opts: { max?: number; t?: ChartTokens } = {}): EChartsCoreOption {
  const t = opts.t ?? chartTokens();
  const meta = HEATMAP_METRIC[res?.metric ?? "loss"];
  const { cells, days } = heatmapCells(res);
  const base = hourHeatmapOption(
    cells.filter((c) => c.value != null),
    days,
    { max: opts.max ?? meta.max, unit: meta.unit, metric: meta.metric, t },
  );
  const dayIndex = new Map(days.map((d, i) => [d, i]));
  const empty = cells.filter((c) => c.value == null).map((c) => [c.hour, dayIndex.get(c.day) as number, 0]);
  const baseSeries = Array.isArray(base.series) ? (base.series as Record<string, unknown>[]) : [];
  // wenig gemessene Stunden: Farbe gedämpft + feine Schraffur, Tooltip nennt die Abdeckung
  const lowCov = new Map<string, number>();
  for (const c of cells) if (isLowCoverage(c)) lowCov.set(`${c.hour}|${dayIndex.get(c.day)}`, c.coveragePct as number);
  const lowDecal = { symbol: "rect", symbolSize: 1, color: withAlpha(t.fg, 0.28), dashArrayX: [1, 0], dashArrayY: [1, 5], rotation: -Math.PI / 4 };
  const valueSeries = baseSeries.map((s, i) => {
    if (i !== 0 || !Array.isArray(s.data) || lowCov.size === 0) return s;
    return {
      ...s,
      data: (s.data as Array<[number, number, number | null]>).map((v) =>
        lowCov.has(`${v[0]}|${v[1]}`) ? { value: v, itemStyle: { opacity: 0.5, decal: lowDecal } } : v,
      ),
    };
  });
  const baseTooltip = (base.tooltip ?? {}) as { formatter?: (p: { value: [number, number, number | null] }) => string };
  const baseFormatter = baseTooltip.formatter;
  const tooltip =
    baseFormatter && lowCov.size > 0
      ? {
          ...baseTooltip,
          formatter: (p: { value: [number, number, number | null] }) => {
            const cov = lowCov.get(`${p.value[0]}|${p.value[1]}`);
            const note =
              cov != null
                ? `<div style="color:${t.warn};font-size:11px;margin-top:2px">nur ${Math.round(cov)} % der Stunde gemessen – eingeschränkt aussagekräftig</div>`
                : "";
            return baseFormatter(p) + note;
          },
        }
      : base.tooltip;
  return {
    ...base,
    tooltip,
    // Jede Heatmap-Serie braucht eine visualMap: die Skala gilt nur für Messwerte, die zweite
    // (unsichtbare) färbt die Zellen ohne Messung in Flächenfarbe – darauf liegt die Schraffur.
    visualMap: [
      { ...(base.visualMap as Record<string, unknown>), seriesIndex: 0 },
      { type: "piecewise", show: false, seriesIndex: 1, pieces: [{ min: -1, max: 1, color: t.surface }] },
    ],
    series: [
      ...valueSeries,
      {
        id: "heat:empty",
        type: "heatmap",
        silent: false,
        data: empty,
        itemStyle: {
          color: t.surface,
          borderColor: t.surface,
          borderWidth: 2,
          borderRadius: 3,
          decal: { symbol: "rect", symbolSize: 1, color: withAlpha(t.lineStrong, 0.9), dashArrayX: [1, 0], dashArrayY: [1, 4], rotation: -Math.PI / 4 },
        },
        emphasis: { disabled: true },
        tooltip: { formatter: () => `<span style="color:${t.fg3}">keine Messung</span>` },
      },
    ],
  };
}

/* -------------------------------------------------------------------------- */
/* Sparklines (<Sparkline values={…}/>)                                        */
/* -------------------------------------------------------------------------- */

type Agg = "median" | "avg" | "max";

function aggregate(values: number[], agg: Agg): number | null {
  if (values.length === 0) return null;
  if (agg === "max") return Math.max(...values);
  if (agg === "avg") return values.reduce((a, b) => a + b, 0) / values.length;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Live-Ringpuffer -> feste Anzahl Buckets für <Sparkline/> (Median je Bucket, null = keine
 * Antwort/keine Messung). Beispiel: letzte 10 min in 40 Buckets.
 */
export function sparkFromSamples(
  samples: readonly Sample[] | undefined,
  opts: { now: number; windowMs?: number; buckets?: number; agg?: Agg },
): Array<number | null> {
  const windowMs = opts.windowMs ?? 10 * 60_000;
  const n = Math.max(2, opts.buckets ?? 40);
  const from = opts.now - windowMs;
  const width = windowMs / n;
  const groups: number[][] = Array.from({ length: n }, () => []);
  for (const s of samplesInWindow(samples, from, opts.now)) {
    if (!isOk(s)) continue;
    const i = Math.min(n - 1, Math.floor((s.ts - from) / width));
    if (i >= 0) groups[i].push(s.rtt as number);
  }
  return groups.map((g) => aggregate(g, opts.agg ?? "median"));
}

/** Lange Wertereihe auf höchstens maxPoints verdichten (Mittel je Gruppe, null bleibt null). */
export function downsample(values: ReadonlyArray<number | null>, maxPoints = 60, agg: Agg = "avg"): Array<number | null> {
  if (values.length <= maxPoints) return [...values];
  const size = values.length / maxPoints;
  const out: Array<number | null> = [];
  for (let i = 0; i < maxPoints; i++) {
    const chunk = values.slice(Math.floor(i * size), Math.floor((i + 1) * size)).filter((v): v is number => v != null && Number.isFinite(v));
    out.push(aggregate(chunk, agg));
  }
  return out;
}

/** Eine Kennzahl einer API-Serie als Sparkline-Werte. */
export function sparkFromSeries(d: SeriesData | null | undefined, key: "avg" | "p95" | "max" | "lossPct" = "avg", maxPoints = 60): Array<number | null> {
  if (!d) return [];
  return downsample(d[key], maxPoints, key === "max" ? "max" : "avg");
}

/* -------------------------------------------------------------------------- */
/* Live-Kennzahlen (für KPI-Kacheln)                                           */
/* -------------------------------------------------------------------------- */

export interface LiveStats {
  sent: number;
  lost: number;
  lossPct: number | null;
  p50: number | null;
  p95: number | null;
  avg: number | null;
  max: number | null;
  jitter: number | null;
  /** letzter Messwert (null = verloren) und dessen Zeit */
  last: number | null;
  lastTs: number | null;
}

/** Kennzahlen eines Ringpuffers im Fenster [now − windowMs, now]. */
export function liveStats(samples: readonly Sample[] | undefined, now: number, windowMs = 60_000): LiveStats {
  const list = samplesInWindow(samples, now - windowMs, now + 1000);
  const rtts = list.map((s) => (isOk(s) ? (s.rtt as number) : null));
  const sum = summarize(rtts);
  const lastS = list.length ? list[list.length - 1] : undefined;
  return {
    sent: sum.sent,
    lost: sum.lost,
    lossPct: sum.sent > 0 ? (sum.lost / sum.sent) * 100 : null,
    p50: sum.p50,
    p95: sum.p95,
    avg: sum.avg,
    max: sum.max,
    jitter: sum.jitter,
    last: lastS && isOk(lastS) ? (lastS.rtt as number) : null,
    lastTs: lastS?.ts ?? null,
  };
}

/** Kurztext für Kacheln: "19 ms (p50), 0,0 % Verlust" – oder "–" ohne Daten. */
export function liveStatsText(s: LiveStats): string {
  if (s.sent === 0) return DASH;
  return `${fmtMs(s.p50)} Median, ${fmtPct(s.lossPct)} Verlust`;
}
