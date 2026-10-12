import type { CSSProperties } from "react";

/**
 * Helles „Papier“-Theme für einen Teilbaum. data-theme="light" geht nur auf <html> (Lightning CSS
 * löst light-dark() in Produktion auf :root auf) – daher werden hier die Roh-Tokens direkt mit den
 * hellen Werten aus src/styles/theme.css überschrieben. Alle Tailwind-Utilities (bg-panel,
 * text-fg-3, ring-line, bg-good/12 …) verweisen auf diese Variablen und werden damit hell.
 * Beim Drucken schaltet theme.css ohnehin die ganze Seite hell.
 */
export const PAPER_VARS: CSSProperties & Record<`--${string}`, string> = {
  colorScheme: "light",
  "--np-void": "#E9EEF4",
  "--np-canvas": "#F6F8FB",
  "--np-sunken": "#EEF2F7",
  "--np-panel": "#FFFFFF",
  "--np-raised": "#F0F4F9",
  "--np-overlay": "#FFFFFF",
  "--np-glass": "#FFFFFF",
  "--np-glass-strong": "rgb(248 250 253 / 0.94)",
  "--np-line": "#DCE2E9",
  "--np-line-strong": "#C0C8D3",
  "--np-line-control": "#828D9C",
  "--np-fg": "#0E1624",
  "--np-fg-2": "#394353",
  "--np-fg-3": "#586475",
  "--np-fg-4": "#828D9C",
  "--np-fg-invert": "#FFFFFF",
  "--np-fiber": "#00758D",
  "--np-fiber-strong": "#006F87",
  "--np-fiber-deep": "#005A6E",
  "--np-laser": "#653CBD",
  "--np-laser-strong": "#5530A8",
  "--np-aqua": "#00806F",
  "--np-good": "#087736",
  "--np-warn": "#965800",
  "--np-crit": "#C2272D",
  "--np-unknown": "#5F6A77",
  "--np-info": "#1F68BC",
  "--np-seg-pc": "#45C1D4",
  "--np-seg-lan": "#03ACC7",
  "--np-seg-router": "#0096B3",
  "--np-seg-docsis": "#007FA0",
  "--np-seg-provider": "#006A8D",
  "--np-seg-internet": "#005579",
  "--np-seg-targets": "#004166",
  "--np-chart-1": "#0095B5",
  "--np-chart-2": "#7544CD",
  "--np-chart-3": "#9E0067",
  "--np-chart-4": "#0062D4",
  "--np-chart-5": "#CB5A00",
  "--np-chart-6": "#008779",
  "--np-chart-7": "#9E8400",
  "--np-chart-8": "#9C40BF",
  "--np-chart-other": "#9AA4B2",
  "--np-chart-ref": "#394353",
  "--np-chart-grid": "#E6EBF1",
  "--np-chart-axis": "#C0C8D3",
  "--np-heat-0": "#F0F4F9",
  "--np-heat-1": "#F5DFAC",
  "--np-heat-2": "#F9B96C",
  "--np-heat-3": "#F47F46",
  "--np-heat-4": "#DB4241",
  "--np-heat-5": "#A02262",
  "--np-heat-6": "#591E66",
  "--np-shadow-panel": "none",
  "--np-frame-color": "color-mix(in oklab, #00758D 55%, transparent)",
  backgroundColor: "var(--np-panel)",
  color: "var(--np-fg)",
};

/** Druck-Regeln nur für den Bericht (A4, ohne Bildschirm-Rahmen, Abschnitte nicht zerreißen). */
export const PAPER_PRINT_CSS = `
@page { size: A4; margin: 14mm 12mm; }
@media print {
  .np-paper { box-shadow: none !important; border: 0 !important; border-radius: 0 !important; padding: 0 !important; max-width: none !important; }
  .np-paper-block { break-inside: avoid; }
  .np-paper h2 { break-after: avoid; }
  .np-paper-chart svg { width: 100% !important; height: auto !important; }
  .np-paper a { color: inherit !important; text-decoration: none !important; }
  main { padding: 0 !important; }
}
`;
