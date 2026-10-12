"use client";

import { useEffect, useRef } from "react";
import * as echarts from "echarts/core";
import { BarChart, LineChart } from "echarts/charts";
import { AriaComponent, GridComponent, LegendComponent, TooltipComponent } from "echarts/components";
import { SVGRenderer } from "echarts/renderers";
import langDE from "echarts/i18n/langDE-obj.js";
import { registerNetzpulsThemes, THEME_LIGHT } from "@/lib/echarts-theme";

echarts.use([LineChart, BarChart, GridComponent, TooltipComponent, LegendComponent, AriaComponent, SVGRenderer]);
echarts.registerLocale("DE", langDE as Parameters<typeof echarts.registerLocale>[1]);

let themesReady = false;

interface PaperChartProps {
  option: echarts.EChartsCoreOption;
  ariaLabel: string;
  height?: number;
}

/**
 * Diagramm für den Bericht: immer helles Theme, SVG-Renderer (scharf im PDF/Druck, skaliert über
 * die viewBox mit der Seitenbreite), keine Animation. Der Standard-<EChart/> rendert dunkel und
 * schaltet nur beim Drucken um – auf dem hellen Papier am Bildschirm passt das nicht.
 */
export function PaperChart({ option, ariaLabel, height = 220 }: PaperChartProps) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.EChartsType | null>(null);
  const optionRef = useRef(option);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let disposed = false;
    let ro: ResizeObserver | undefined;
    const resize = () => chartRef.current?.resize();
    const init = async () => {
      await document.fonts?.ready;
      if (disposed) return;
      if (!themesReady) {
        registerNetzpulsThemes(echarts);
        themesReady = true;
      }
      const chart = echarts.init(el, THEME_LIGHT, { renderer: "svg", locale: "DE" });
      chartRef.current = chart;
      chart.setOption(optionRef.current, { notMerge: true });
      ro = new ResizeObserver(resize);
      ro.observe(el);
      window.addEventListener("beforeprint", resize);
      window.addEventListener("afterprint", resize);
    };
    void init();
    return () => {
      disposed = true;
      ro?.disconnect();
      window.removeEventListener("beforeprint", resize);
      window.removeEventListener("afterprint", resize);
      chartRef.current?.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    optionRef.current = option;
    chartRef.current?.setOption(option, { notMerge: true });
  }, [option]);

  return <div ref={ref} role="img" aria-label={ariaLabel} className="np-paper-chart w-full" style={{ height }} />;
}
