/**
 * NETZPULS – ECharts-6-Theme + Options-Helfer
 * ------------------------------------------------------------------
 * Ablage im Projekt: src/lib/echarts-theme.ts
 *
 * Verwendung (nur im Browser, z. B. in components/viz/EChart.tsx):
 *   import * as echarts from "echarts/core";
 *   import { registerNetzpulsThemes, THEME_DARK } from "@/lib/echarts-theme";
 *   registerNetzpulsThemes(echarts);                       // einmalig
 *   echarts.init(el, THEME_DARK, { renderer: "canvas", useDirtyRect: true, locale: "DE" });
 *
 * Farben sind 1:1 aus theme.css gespiegelt (dunkel = zweites Argument von light-dark()).
 * registerNetzpulsThemes() liest im Browser zusätzlich die echten CSS-Variablen
 * (inkl. der von next/font erzeugten Schriftnamen) und überschreibt damit die Fallbacks.
 *
 * Regeln (dataviz):
 * - Linien 2 px, Marker >= 8 px mit 2-px-Ring in Flächenfarbe, Flächen 10 % Deckkraft
 * - Balken max. 24 px, 4 px Rundung am Datenende, eckig an der Basis
 * - Gitter: durchgezogene Haarlinien; gestrichelt NUR für Schwellen/Referenzen
 * - Kategoriale Farben in fester Reihenfolge, nie zyklisch: Serie 9+ -> "Sonstige"
 * - Statusfarben (good/warn/crit) nie als Serienfarbe; Texte nie in Serienfarbe
 * - Keine zweite y-Achse: zwei Größen = zwei Diagramme
 */
import type {
  MarkAreaComponentOption,
  MarkLineComponentOption,
  TooltipComponentFormatterCallbackParams,
  VisualMapComponentOption,
} from "echarts";

export type ChartSeverity = "good" | "warn" | "crit" | "unknown" | "info";

export interface ChartTokens {
  mode: "dark" | "light";
  surface: string; // Chart-Fläche (= Panel)
  raised: string;
  overlay: string;
  fg: string;
  fg2: string;
  fg3: string;
  fg4: string;
  fgInvert: string;
  line: string;
  lineStrong: string;
  grid: string;
  axis: string;
  fiber: string;
  laser: string;
  good: string;
  warn: string;
  crit: string;
  unknown: string;
  info: string;
  /** 8 kategoriale Farben, feste Reihenfolge */
  series: readonly string[];
  other: string;
  ref: string;
  solo: string;
  /** 7 Stufen Heatmap (0 = ruhig) */
  heat: readonly string[];
  /** 7 Segmentfarben (Nah -> Fern) */
  seg: readonly string[];
  fontSans: string;
  fontMono: string;
  fontDisplay: string;
}

const FONT_SANS = '"IBM Plex Sans", "Segoe UI", system-ui, sans-serif';
const FONT_MONO = '"JetBrains Mono", "Cascadia Mono", Consolas, monospace';
const FONT_DISPLAY = '"Space Grotesk", "Segoe UI", system-ui, sans-serif';

export const CHART_TOKENS_DARK: ChartTokens = {
  mode: "dark",
  surface: "#0A1627",
  raised: "#121E31",
  overlay: "#19263A",
  fg: "#EAF1F8",
  fg2: "#BDCADA",
  fg3: "#97A4B6",
  fg4: "#6E7A8B",
  fgInvert: "#00141E",
  line: "#243144",
  lineStrong: "#404E63",
  grid: "#182334",
  axis: "#323E50",
  fiber: "#2EEBFC",
  laser: "#B09CFF",
  good: "#54DD7D",
  warn: "#FFBD4A",
  crit: "#FF6367",
  unknown: "#8E99A8",
  info: "#63B9FE",
  series: ["#00A5C4", "#9264EF", "#CA358B", "#217BF4", "#D16100", "#008777", "#AE9200", "#BF64E4"],
  other: "#6E7A8B",
  ref: "#BDCADA",
  solo: "#2EEBFC",
  heat: ["#1C263A", "#3F316C", "#76338A", "#BC3181", "#EC5258", "#FD923E", "#FFDB68"],
  seg: ["#C2F2F8", "#86E2F2", "#48CEEA", "#09B7DC", "#009EC9", "#0085B4", "#006E9F"],
  fontSans: FONT_SANS,
  fontMono: FONT_MONO,
  fontDisplay: FONT_DISPLAY,
};

export const CHART_TOKENS_LIGHT: ChartTokens = {
  mode: "light",
  surface: "#FFFFFF",
  raised: "#F0F4F9",
  overlay: "#FFFFFF",
  fg: "#0E1624",
  fg2: "#394353",
  fg3: "#586475",
  fg4: "#828D9C",
  fgInvert: "#FFFFFF",
  line: "#DCE2E9",
  lineStrong: "#C0C8D3",
  grid: "#E6EBF1",
  axis: "#C0C8D3",
  fiber: "#00758D",
  laser: "#653CBD",
  good: "#087736",
  warn: "#965800",
  crit: "#C2272D",
  unknown: "#5F6A77",
  info: "#1F68BC",
  series: ["#0095B5", "#7544CD", "#9E0067", "#0062D4", "#CB5A00", "#008779", "#9E8400", "#9C40BF"],
  other: "#9AA4B2",
  ref: "#394353",
  solo: "#00758D",
  heat: ["#F0F4F9", "#F5DFAC", "#F9B96C", "#F47F46", "#DB4241", "#A02262", "#591E66"],
  seg: ["#45C1D4", "#03ACC7", "#0096B3", "#007FA0", "#006A8D", "#005579", "#004166"],
  fontSans: FONT_SANS,
  fontMono: FONT_MONO,
  fontDisplay: FONT_DISPLAY,
};

export const THEME_DARK = "netzpuls-dark";
export const THEME_LIGHT = "netzpuls-light";

/* ------------------------------------------------------------------ */
/* Farb-Hilfen                                                         */
/* ------------------------------------------------------------------ */

/** "#RRGGBB" | "rgb(r, g, b)" | "rgba(...)" -> "rgba(r,g,b,a)" */
export function withAlpha(color: string, alpha: number): string {
  const c = color.trim();
  let r = 0;
  let g = 0;
  let b = 0;
  if (c.startsWith("#") && (c.length === 7 || c.length === 4)) {
    const hex = c.length === 4 ? c.slice(1).split("").map((x) => x + x).join("") : c.slice(1);
    r = parseInt(hex.slice(0, 2), 16);
    g = parseInt(hex.slice(2, 4), 16);
    b = parseInt(hex.slice(4, 6), 16);
  } else {
    const m = c.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i);
    if (!m) return c;
    r = Number(m[1]);
    g = Number(m[2]);
    b = Number(m[3]);
  }
  return `rgba(${r},${g},${b},${alpha})`;
}

/**
 * Serienfarbe für einen festen Slot (0–7). Farbe folgt der ENTITÄT, nicht dem Rang:
 * Slot beim Anlegen eines Ziels vergeben, speichern, nie neu verteilen. Ab Slot 8 -> "Sonstige".
 */
export function seriesColor(slot: number, t: ChartTokens = chartTokens()): string {
  return slot >= 0 && slot < t.series.length ? t.series[slot] : t.other;
}

/** Statusfarbe nach Schwere */
export function severityColor(sev: ChartSeverity, t: ChartTokens = CHART_TOKENS_DARK): string {
  return { good: t.good, warn: t.warn, crit: t.crit, unknown: t.unknown, info: t.info }[sev];
}

/* ------------------------------------------------------------------ */
/* Deutsche Formate                                                    */
/* ------------------------------------------------------------------ */
const nf0 = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 1 });
const nf2 = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 2 });
const dfTooltip = new Intl.DateTimeFormat("de-DE", {
  weekday: "short",
  day: "2-digit",
  month: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  timeZone: "Europe/Berlin",
});

export function fmtAxisNumber(v: number): string {
  const a = Math.abs(v);
  return (a >= 100 ? nf0 : a >= 1 ? nf1 : nf2).format(v);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] ?? ch);
}

/* ------------------------------------------------------------------ */
/* Theme                                                               */
/* ------------------------------------------------------------------ */

export function createNetzpulsTheme(t: ChartTokens): Record<string, unknown> {
  const axisCommon = () => ({
    axisLine: { show: true, lineStyle: { color: t.axis, width: 1 } },
    axisTick: { show: false, lineStyle: { color: t.axis } },
    axisLabel: { color: t.fg3, fontFamily: t.fontMono, fontSize: 11, margin: 10, hideOverlap: true },
    splitLine: { show: true, lineStyle: { color: t.grid, width: 1, type: "solid" } },
    splitArea: { show: false },
    minorTick: { lineStyle: { color: t.axis } },
    minorSplitLine: { lineStyle: { color: withAlpha(t.grid, 0.5), type: "solid" } },
    nameTextStyle: { color: t.fg3, fontFamily: t.fontSans, fontSize: 11 },
  });

  return {
    darkMode: t.mode === "dark",
    // 8 kategorial + "Sonstige" + "Referenz" (nie eine 11. Farbe erzeugen)
    color: [...t.series, t.other, t.ref],
    backgroundColor: "transparent",
    textStyle: { color: t.fg2, fontFamily: t.fontSans, fontSize: 12 },

    animation: true,
    animationDuration: 400,
    animationDurationUpdate: 250,
    animationEasing: "cubicOut",
    animationEasingUpdate: "cubicOut",
    animationThreshold: 2000,

    title: {
      left: 0,
      top: 0,
      padding: [0, 0, 8, 0],
      textStyle: { color: t.fg, fontFamily: t.fontDisplay, fontSize: 14, fontWeight: 500 },
      subtextStyle: { color: t.fg3, fontFamily: t.fontSans, fontSize: 12 },
    },

    // ECharts 6: containLabel ist veraltet -> outerBounds
    grid: {
      left: 4,
      right: 12,
      top: 44, // Platz für Legende (oben) + Achsenname
      bottom: 4,
      outerBoundsMode: "same",
      outerBoundsContain: "axisLabel",
      borderColor: t.line,
    },

    legend: {
      type: "scroll",
      top: 0,
      left: 0, // oben links, bündig mit der y-Achse (ECharts-Default wäre zentriert)
      itemWidth: 14,
      itemHeight: 8,
      itemGap: 16,
      textStyle: { color: t.fg2, fontFamily: t.fontSans, fontSize: 12 },
      inactiveColor: t.fg4,
      inactiveBorderColor: t.fg4,
      pageIconColor: t.fg2,
      pageIconInactiveColor: t.fg4,
      pageTextStyle: { color: t.fg3, fontFamily: t.fontMono, fontSize: 11 },
    },

    tooltip: {
      trigger: "axis",
      confine: true,
      transitionDuration: 0,
      backgroundColor: t.overlay,
      borderColor: t.lineStrong,
      borderWidth: 1,
      padding: [8, 12],
      textStyle: { color: t.fg, fontFamily: t.fontSans, fontSize: 12 },
      extraCssText: `border-radius:8px;box-shadow:0 18px 48px -12px ${withAlpha("#000000", t.mode === "dark" ? 0.7 : 0.2)};`,
      axisPointer: {
        type: "line",
        lineStyle: { color: t.fg3, width: 1, type: "solid" },
        crossStyle: { color: t.fg3, width: 1 },
        shadowStyle: { color: withAlpha(t.fiber, 0.06) },
      },
    },

    axisPointer: {
      lineStyle: { color: t.fg3, width: 1 },
      crossStyle: { color: t.fg3, width: 1 },
      label: {
        backgroundColor: t.raised,
        borderColor: t.lineStrong,
        borderWidth: 1,
        color: t.fg,
        fontFamily: t.fontMono,
        fontSize: 11,
        padding: [3, 6],
        borderRadius: 4,
      },
    },

    timeAxis: {
      ...axisCommon(),
      splitLine: { show: false },
      axisLabel: {
        ...axisCommon().axisLabel,
        // Deutsche Stufen-Formate; {MMM} kommt aus Locale "DE"
        formatter: {
          year: "{yyyy}",
          month: "{MMM}",
          day: "{d}. {MMM}",
          hour: "{HH}:{mm}",
          minute: "{HH}:{mm}",
          second: "{HH}:{mm}:{ss}",
          millisecond: "{HH}:{mm}:{ss}",
          none: "{dd}.{MM}.{yyyy} {HH}:{mm}",
        },
      },
    },
    valueAxis: {
      ...axisCommon(),
      axisLine: { show: false },
      axisLabel: { ...axisCommon().axisLabel, formatter: (v: number) => fmtAxisNumber(v) },
    },
    logAxis: { ...axisCommon(), axisLine: { show: false } },
    categoryAxis: { ...axisCommon(), splitLine: { show: false }, axisTick: { show: false } },

    // Serien
    line: {
      symbol: "circle",
      symbolSize: 8,
      showSymbol: false,
      smooth: false,
      connectNulls: false, // Lücke = keine Messung, nie überbrücken
      sampling: "lttb",
      lineStyle: { width: 2, cap: "round", join: "round" },
      itemStyle: { borderColor: t.surface, borderWidth: 2 },
      emphasis: { focus: "series", lineStyle: { width: 2 } },
      blur: { lineStyle: { opacity: 0.25 }, itemStyle: { opacity: 0.25 } },
    },
    bar: {
      barMaxWidth: 24,
      barGap: "20%",
      itemStyle: { borderRadius: [4, 4, 0, 0] },
      emphasis: { itemStyle: { opacity: 0.9 } },
    },
    scatter: {
      symbolSize: 8,
      itemStyle: { borderColor: t.surface, borderWidth: 2 },
    },
    heatmap: {
      itemStyle: { borderColor: t.surface, borderWidth: 2, borderRadius: 3 },
      emphasis: { itemStyle: { borderColor: t.fg, borderWidth: 1 } },
    },

    // Zoom
    dataZoom: {
      backgroundColor: "transparent",
      borderColor: t.line,
      fillerColor: withAlpha(t.fiber, 0.1),
      height: 22,
      bottom: 0,
      dataBackground: {
        lineStyle: { color: t.fg4, width: 1 },
        areaStyle: { color: t.fg4, opacity: 0.12 },
      },
      selectedDataBackground: {
        lineStyle: { color: t.fiber, width: 1 },
        areaStyle: { color: t.fiber, opacity: 0.12 },
      },
      handleStyle: { color: t.raised, borderColor: t.fiber, borderWidth: 1 },
      moveHandleStyle: { color: t.fg4, opacity: 0.4 },
      brushStyle: { color: withAlpha(t.fiber, 0.12) },
      textStyle: { color: t.fg3, fontFamily: t.fontMono, fontSize: 11 },
      emphasis: {
        handleStyle: { borderColor: t.fiber, color: t.overlay },
        moveHandleStyle: { color: t.fiber, opacity: 0.6 },
      },
    },

    visualMap: {
      textStyle: { color: t.fg3, fontFamily: t.fontMono, fontSize: 11 },
      inRange: { color: [...t.heat] },
      itemWidth: 12,
      itemHeight: 140,
    },

    // Marker: Schwellen (gestrichelt), Ereignisse, Ausfälle
    markLine: {
      silent: true,
      animation: false,
      symbol: ["none", "none"],
      lineStyle: { color: t.warn, width: 1, type: [4, 4] },
      label: { color: t.fg2, fontFamily: t.fontMono, fontSize: 11, position: "insideEndTop", distance: 4 },
      emphasis: { disabled: true },
    },
    markArea: {
      silent: true,
      animation: false,
      itemStyle: { color: withAlpha(t.crit, t.mode === "dark" ? 0.12 : 0.1), borderWidth: 0 },
      label: { color: t.crit, fontFamily: t.fontSans, fontSize: 11, position: "insideTop", distance: 6 },
      emphasis: { disabled: true },
    },
    markPoint: {
      label: { color: t.fgInvert, fontFamily: t.fontMono, fontSize: 11 },
    },

    // Screenreader-Beschreibung; Muster (decal) per aria.decal.show = true zuschaltbar
    aria: { enabled: true },
  };
}

/* ------------------------------------------------------------------ */
/* Registrierung + Abgleich mit CSS-Variablen                          */
/* ------------------------------------------------------------------ */

interface EChartsThemeRegistry {
  registerTheme: (name: string, theme: Record<string, unknown>) => void;
}

/** Aktives Farbschema der Seite (data-theme auf <html>, Standard dunkel). */
export function activeMode(): "dark" | "light" {
  if (typeof document === "undefined") return "dark";
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

/**
 * Liest die aufgelösten Farben und Schriftnamen aus dem DOM (CSS bleibt Quelle der Wahrheit).
 * Farben nur für das AKTIVE Schema: In Produktion ersetzt Lightning CSS light-dark() durch
 * Variablen, die schon auf :root aufgelöst werden – das andere Schema ist per Probe nicht
 * lesbar. Für das inaktive Schema gelten die gespiegelten Konstanten oben.
 * Schriftnamen (von next/font erzeugt) werden immer gelesen.
 */
export function readChartTokensFromCss(base: ChartTokens): ChartTokens {
  if (typeof document === "undefined") return base;
  const font = (cssVar: string, fallback: string): string => {
    const v = getComputedStyle(document.documentElement).getPropertyValue(cssVar).trim();
    return v || fallback;
  };
  const fonts = {
    fontSans: font("--np-font-sans", base.fontSans),
    fontMono: font("--np-font-mono", base.fontMono),
    fontDisplay: font("--np-font-display", base.fontDisplay),
  };
  if (base.mode !== activeMode()) return { ...base, ...fonts };
  const probe = document.createElement("span");
  probe.style.cssText = "position:absolute;visibility:hidden;pointer-events:none;";
  document.body.appendChild(probe);
  const color = (cssVar: string, fallback: string): string => {
    probe.style.color = "";
    probe.style.color = `var(${cssVar})`;
    const v = getComputedStyle(probe).color;
    return v && v !== "rgba(0, 0, 0, 0)" ? v : fallback;
  };
  const tokens: ChartTokens = {
    ...base,
    surface: color("--np-panel", base.surface),
    raised: color("--np-raised", base.raised),
    overlay: color("--np-overlay", base.overlay),
    fg: color("--np-fg", base.fg),
    fg2: color("--np-fg-2", base.fg2),
    fg3: color("--np-fg-3", base.fg3),
    fg4: color("--np-fg-4", base.fg4),
    fgInvert: color("--np-fg-invert", base.fgInvert),
    line: color("--np-line", base.line),
    lineStrong: color("--np-line-strong", base.lineStrong),
    grid: color("--np-chart-grid", base.grid),
    axis: color("--np-chart-axis", base.axis),
    fiber: color("--np-fiber", base.fiber),
    laser: color("--np-laser", base.laser),
    good: color("--np-good", base.good),
    warn: color("--np-warn", base.warn),
    crit: color("--np-crit", base.crit),
    unknown: color("--np-unknown", base.unknown),
    info: color("--np-info", base.info),
    series: base.series.map((c, i) => color(`--np-chart-${i + 1}`, c)),
    other: color("--np-chart-other", base.other),
    ref: color("--np-chart-ref", base.ref),
    solo: color("--np-chart-solo", base.solo),
    heat: base.heat.map((c, i) => color(`--np-heat-${i}`, c)),
    seg: base.seg,
    ...fonts,
  };
  probe.remove();
  return tokens;
}

let activeTokens: Record<"dark" | "light", ChartTokens> = { dark: CHART_TOKENS_DARK, light: CHART_TOKENS_LIGHT };

/** Tokens, mit denen zuletzt registriert wurde (für Helfer/Tooltip-Formatter). */
export function chartTokens(mode: "dark" | "light" = "dark"): ChartTokens {
  return activeTokens[mode];
}

/**
 * Registriert "netzpuls-dark" und "netzpuls-light". Im Browser vorher mit den echten
 * CSS-Werten abgleichen (Schriftnamen von next/font!). Nach Theme-Änderungen erneut
 * aufrufen und chart.setTheme(...) ausführen.
 */
export function registerNetzpulsThemes(echarts: EChartsThemeRegistry, opts: { syncWithCss?: boolean } = {}): void {
  const sync = opts.syncWithCss ?? typeof document !== "undefined";
  activeTokens = sync
    ? { dark: readChartTokensFromCss(CHART_TOKENS_DARK), light: readChartTokensFromCss(CHART_TOKENS_LIGHT) }
    : { dark: CHART_TOKENS_DARK, light: CHART_TOKENS_LIGHT };
  echarts.registerTheme(THEME_DARK, createNetzpulsTheme(activeTokens.dark));
  echarts.registerTheme(THEME_LIGHT, createNetzpulsTheme(activeTokens.light));
}

/* ------------------------------------------------------------------ */
/* Options-Helfer                                                      */
/* ------------------------------------------------------------------ */

type TimeValue = number | string | Date;
const ts = (v: TimeValue): number => (v instanceof Date ? v.getTime() : typeof v === "string" ? new Date(v).getTime() : v);

export interface Outage {
  from: TimeValue;
  to: TimeValue;
  /** Kurzlabel im Diagramm, z. B. "Link weg" – sparsam, nur breite Bereiche beschriften */
  label?: string;
  severity?: "crit" | "warn" | "unknown";
}

/** Ausfälle/Störungen als getönte Bereiche (in die betroffene Serie hängen: series[i].markArea). */
export function outageMarkArea(outages: readonly Outage[], t: ChartTokens = chartTokens()): MarkAreaComponentOption {
  return {
    silent: true,
    data: outages.map((o) => {
      const c = severityColor(o.severity ?? "crit", t);
      return [
        {
          name: o.label ?? "",
          xAxis: ts(o.from),
          itemStyle: { color: withAlpha(c, t.mode === "dark" ? 0.12 : 0.1) },
          label: { show: Boolean(o.label), color: c },
        },
        { xAxis: ts(o.to) },
      ];
    }),
  } as MarkAreaComponentOption;
}

export interface ChartEvent {
  at: TimeValue;
  /** sehr kurz: "Link 100 Mbit/s", "Router-Neustart" */
  label?: string;
  severity: ChartSeverity;
}

/** Ein Eintrag für markLine.data – mehrere Einträge mit markLines() bündeln. */
export type MarkLineItem = NonNullable<MarkLineComponentOption["data"]>[number];

/** Senkrechte Linie für ein Ereignis (Linkabbruch, Neustart, Standby). "info" bleibt neutral
    (fg3), damit es nicht mit der blauen Serienfarbe verwechselt wird. */
export function eventLine(e: ChartEvent, t: ChartTokens = chartTokens()): MarkLineItem {
  const c = e.severity === "info" ? t.fg3 : severityColor(e.severity, t);
  return {
    xAxis: ts(e.at),
    lineStyle: { color: c, width: 1, type: "solid", opacity: 0.8 },
    label: { show: Boolean(e.label), formatter: e.label ?? "", color: t.fg2, position: "insideEndTop" },
  } as MarkLineItem;
}

/** Waagerechte, gestrichelte Schwelle, z. B. 60 ms "auffällig". */
export function thresholdLine(
  value: number,
  label: string,
  severity: "warn" | "crit" = "warn",
  t: ChartTokens = chartTokens(),
): MarkLineItem {
  const c = severityColor(severity, t);
  return {
    yAxis: value,
    lineStyle: { color: c, width: 1, type: [4, 4] },
    // links oben: kollidiert seltener mit Ausfall-Bereichen und Legende am rechten Rand
    label: { formatter: label, color: t.fg2, position: "insideStartTop" },
  } as MarkLineItem;
}

/** Bündelt Schwellen und Ereignisse für series[i].markLine. */
export function markLines(items: readonly MarkLineItem[]): MarkLineComponentOption {
  return { silent: true, symbol: ["none", "none"], data: [...items] } as MarkLineComponentOption;
}

/** Kurzform: nur Ereignisse */
export function eventMarkLine(events: readonly ChartEvent[], t: ChartTokens = chartTokens()): MarkLineComponentOption {
  return markLines(events.map((e) => eventLine(e, t)));
}

/** Kurzform: eine Schwelle */
export function thresholdMarkLine(
  value: number,
  label: string,
  severity: "warn" | "crit" = "warn",
  t: ChartTokens = chartTokens(),
): MarkLineComponentOption {
  return markLines([thresholdLine(value, label, severity, t)]);
}

/** Kontinuierliche Skala für Heatmaps (immer mit sichtbarer Legende). */
export function heatVisualMap(
  min: number,
  max: number,
  t: ChartTokens = chartTokens(),
  opts: { unit?: string; orient?: "horizontal" | "vertical" } = {},
): VisualMapComponentOption {
  return {
    type: "continuous",
    min,
    max,
    calculable: false,
    orient: opts.orient ?? "horizontal",
    left: 0,
    bottom: 0,
    itemWidth: 10,
    itemHeight: 160,
    inRange: { color: [...t.heat] },
    text: [`${fmtAxisNumber(max)}${opts.unit ? ` ${opts.unit}` : ""}`, fmtAxisNumber(min)],
    textStyle: { color: t.fg3, fontFamily: t.fontMono, fontSize: 11 },
  } as VisualMapComponentOption;
}

/**
 * Achsen-Tooltip "Wert zuerst": Zeitkopf (Mono), dann je Serie: Linien-Schlüssel,
 * Wert (fett, Mono) + Einheit, Serienname (gedämpft). null -> "keine Messung".
 */
export function axisTooltipFormatter(opts: { unit?: string; digits?: number; t?: ChartTokens } = {}) {
  const t = opts.t ?? chartTokens();
  const nf = new Intl.NumberFormat("de-DE", { maximumFractionDigits: opts.digits ?? 1 });
  const unit = opts.unit ? `&nbsp;${escapeHtml(opts.unit)}` : "";
  return (raw: TooltipComponentFormatterCallbackParams): string => {
    const list = Array.isArray(raw) ? raw : [raw];
    if (list.length === 0) return "";
    const first = list[0] as { axisValue?: unknown; axisValueLabel?: string };
    const av = first.axisValue;
    const head =
      typeof av === "number" || av instanceof Date ? dfTooltip.format(av) : escapeHtml(String(first.axisValueLabel ?? av ?? ""));
    const rows = list
      .map((p) => {
        const item = p as { seriesName?: string; color?: unknown; value?: unknown };
        const v = Array.isArray(item.value) ? item.value[item.value.length - 1] : item.value;
        const num = typeof v === "number" && Number.isFinite(v) ? `${nf.format(v)}${unit}` : "keine Messung";
        const key = typeof item.color === "string" ? item.color : t.fg3;
        return (
          `<div style="display:flex;align-items:center;gap:8px;line-height:20px">` +
          `<span style="display:inline-block;width:12px;height:2px;border-radius:1px;background:${key}"></span>` +
          `<span style="font-family:${escapeHtml(t.fontMono)};font-weight:600;color:${t.fg};min-width:64px">${num}</span>` +
          `<span style="color:${t.fg3}">${escapeHtml(item.seriesName ?? "")}</span>` +
          `</div>`
        );
      })
      .join("");
    return `<div style="font-family:${escapeHtml(t.fontMono)};font-size:11px;color:${t.fg3};margin-bottom:4px">${head}</div>${rows}`;
  };
}

export interface HourHeatDatum {
  day: string; // "YYYY-MM-DD"
  hour: number; // 0–23
  value: number | null;
}

/** Interaktive Stunde×Tag-Heatmap (Alternative zur CSS-Variante <HourHeatmap/>). */
export function hourHeatmapOption(
  data: readonly HourHeatDatum[],
  days: readonly string[],
  opts: { max: number; unit: string; metric: string; t?: ChartTokens },
): Record<string, unknown> {
  const t = opts.t ?? chartTokens();
  const dayIndex = new Map(days.map((d, i) => [d, i]));
  const dfDay = new Intl.DateTimeFormat("de-DE", { weekday: "short", day: "numeric", month: "numeric", timeZone: "Europe/Berlin" });
  return {
    animation: false,
    grid: { left: 4, right: 8, top: 8, bottom: 44, outerBoundsMode: "same", outerBoundsContain: "axisLabel" },
    tooltip: {
      trigger: "item",
      formatter: (p: { value: [number, number, number | null] }) => {
        const [h, d, v] = p.value;
        const day = dfDay.format(new Date(`${days[d]}T12:00:00Z`));
        const val = v == null ? "keine Messung" : `${fmtAxisNumber(v)} ${escapeHtml(opts.unit)}`;
        return `<div style="font-family:${escapeHtml(t.fontMono)};font-size:11px;color:${t.fg3}">${day}, ${h}–${h + 1} Uhr</div><div><b style="font-family:${escapeHtml(t.fontMono)}">${val}</b> <span style="color:${t.fg3}">${escapeHtml(opts.metric)}</span></div>`;
      },
    },
    xAxis: {
      type: "category",
      data: Array.from({ length: 24 }, (_, h) => String(h).padStart(2, "0")),
      splitLine: { show: false },
      axisLine: { show: false },
      axisLabel: { interval: 2 },
    },
    yAxis: {
      type: "category",
      data: days.map((d) => dfDay.format(new Date(`${d}T12:00:00Z`))),
      inverse: true,
      splitLine: { show: false },
      axisLine: { show: false },
    },
    visualMap: heatVisualMap(0, opts.max, t, { unit: opts.unit }),
    series: [
      {
        type: "heatmap",
        data: data
          .filter((d) => dayIndex.has(d.day))
          .map((d) => [d.hour, dayIndex.get(d.day) as number, d.value]),
        progressive: 0,
      },
    ],
  };
}
