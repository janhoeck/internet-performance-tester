"use client";

import { useEffect, useRef } from "react";
import * as echarts from "echarts/core";
import { BarChart, HeatmapChart, LineChart, ScatterChart } from "echarts/charts";
import {
  AriaComponent,
  DataZoomComponent,
  DatasetComponent,
  GridComponent,
  LegendComponent,
  MarkAreaComponent,
  MarkLineComponent,
  TitleComponent,
  TooltipComponent,
  VisualMapComponent,
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import langDE from "echarts/i18n/langDE-obj.js";
import { cn } from "@/lib/cn";
import { registerNetzpulsThemes, THEME_DARK, THEME_LIGHT } from "@/lib/echarts-theme";

echarts.use([
  LineChart,
  BarChart,
  HeatmapChart,
  ScatterChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomComponent,
  MarkLineComponent,
  MarkAreaComponent,
  VisualMapComponent,
  TitleComponent,
  DatasetComponent,
  AriaComponent,
  CanvasRenderer,
]);
echarts.registerLocale("DE", langDE as Parameters<typeof echarts.registerLocale>[1]);

let themesReady = false;
function ensureThemes() {
  if (!themesReady) {
    registerNetzpulsThemes(echarts);
    themesReady = true;
  }
}

interface EChartProps {
  option: echarts.EChartsCoreOption;
  /** Pflicht: worum geht es? z. B. "Latenz zu 1.1.1.1, letzte 24 Stunden" */
  ariaLabel: string;
  /** Höhe INKLUSIVE Achsenbeschriftung (kein innerer Scrollbalken) */
  height?: number;
  /** true: Option komplett ersetzen (setzt Zoom/Legende zurück) */
  notMerge?: boolean;
  /** Nur diese Komponenten ersetzen, Rest mergen – z. B. ["series"] bei Serien-Filter;
      Zoom und Legendenauswahl bleiben erhalten. */
  replaceMerge?: string[];
  /**
   * Updates nur animieren, wenn sich dieser Schlüssel ändert (z. B. Zeitraum- oder Zielwechsel).
   * Gleicher Schlüssel = Datenaktualisierung ohne Animation. Ohne Angabe: wie in der Option.
   */
  animationKey?: string;
  className?: string;
}

/**
 * Eigene Beschreibung für Screenreader: Die aria-Komponente von ECharts schreibt sonst einen
 * automatischen Text ("Dies ist ein Diagramm …") in das aria-label des Containers.
 */
function withAria(option: echarts.EChartsCoreOption, label: string): echarts.EChartsCoreOption {
  const aria = (option.aria && typeof option.aria === "object" ? option.aria : {}) as Record<string, unknown>;
  const lbl = (aria.label && typeof aria.label === "object" ? aria.label : {}) as Record<string, unknown>;
  return { ...option, aria: { ...aria, enabled: true, label: { ...lbl, enabled: true, description: label } } };
}

/**
 * Schlanker ECharts-Wrapper:
 * - wartet auf Webfonts (Canvas misst Text nur einmal) und auf eine Größe (verborgene Tabs)
 * - ResizeObserver, deutsche Locale, aria-label = ariaLabel
 * - druckt automatisch im hellen Theme (beforeprint/afterprint)
 * Live-Diagramme: option.animation = false und Updates höchstens 1×/s.
 */
export function EChart({ option, ariaLabel, height = 280, notMerge = false, replaceMerge, animationKey, className }: EChartProps) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.EChartsType | null>(null);
  const optionRef = useRef(option);
  const labelRef = useRef(ariaLabel);
  const animKeyRef = useRef(animationKey);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let disposed = false;
    let ro: ResizeObserver | undefined;
    const toLight = () => chartRef.current?.setTheme(THEME_LIGHT);
    const toDark = () => chartRef.current?.setTheme(THEME_DARK);

    const start = () => {
      ensureThemes();
      // Kein useDirtyRect: führte bei mehreren Serien + Animation zu ungezeichneten Bereichen (geprüft)
      const chart = echarts.init(el, THEME_DARK, { renderer: "canvas", locale: "DE" });
      chartRef.current = chart;
      // nur Entwicklung: Instanz am Element für Tests/Debugging (DevTools: $0.__npChart.getOption())
      if (process.env.NODE_ENV === "development") (el as HTMLDivElement & { __npChart?: echarts.EChartsType }).__npChart = chart;
      chart.setOption(withAria(optionRef.current, labelRef.current), { notMerge: true });
      window.addEventListener("beforeprint", toLight);
      window.addEventListener("afterprint", toDark);
    };
    const init = async () => {
      await document.fonts?.ready;
      if (disposed) return;
      // Erst initialisieren, wenn das Element eine Größe hat (z. B. in verborgenen Tabs erst beim Zeigen)
      const hasSize = () => el.clientWidth > 0 && el.clientHeight > 0;
      if (hasSize()) start();
      ro = new ResizeObserver(() => {
        if (disposed) return;
        if (chartRef.current) chartRef.current.resize();
        else if (hasSize()) start();
      });
      ro.observe(el);
    };
    void init();

    return () => {
      disposed = true;
      ro?.disconnect();
      window.removeEventListener("beforeprint", toLight);
      window.removeEventListener("afterprint", toDark);
      chartRef.current?.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    optionRef.current = option;
    labelRef.current = ariaLabel;
    let next = option;
    if (animationKey !== undefined) {
      const animate = animKeyRef.current !== animationKey;
      animKeyRef.current = animationKey;
      // explizit setzen: beim Mergen bliebe ein einmal gesetztes animation:false sonst stehen
      next = { ...option, animation: animate ? (option.animation ?? true) : false };
    }
    chartRef.current?.setOption(withAria(next, ariaLabel), { notMerge, replaceMerge, lazyUpdate: true });
  }, [option, ariaLabel, notMerge, replaceMerge, animationKey]);

  return <div ref={ref} role="img" aria-label={ariaLabel} className={cn("w-full", className)} style={{ height }} />;
}
