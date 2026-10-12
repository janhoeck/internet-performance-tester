import { cn } from "@/lib/cn";
import { fmtDayShort, fmtNumber } from "@/lib/format";

export interface HeatCell {
  /** Kalendertag "YYYY-MM-DD" (Europe/Berlin) */
  day: string;
  /** Stunde 0–23 */
  hour: number;
  /** null = keine Messung in dieser Stunde */
  value: number | null;
  samples?: number;
  /** gemessene Minuten der Stunde in % (null/fehlend = unbekannt, gilt als voll gemessen) */
  coveragePct?: number | null;
}

interface HourHeatmapProps {
  cells: readonly HeatCell[];
  /** Tage in Anzeige-Reihenfolge (oben -> unten), "YYYY-MM-DD" */
  days: readonly string[];
  /** Messgröße für Tooltip/Legende: "Paketverlust", "p95-Latenz" */
  metric: string;
  unit: string;
  /** Oberes Ende der Skala (Werte darüber = Stufe 6), z. B. 5 (%) oder 200 (ms) */
  max: number;
  digits?: number;
  /** unter diesem Anteil gemessener Minuten (%) wird eine Zelle schraffiert (Standard 50) */
  lowCoveragePct?: number;
  className?: string;
}

const STEPS = ["bg-heat-0", "bg-heat-1", "bg-heat-2", "bg-heat-3", "bg-heat-4", "bg-heat-5", "bg-heat-6"] as const;

/** 0 = exakt 0; 1–5 = gleich breite Klassen bis max; 6 = ab max. */
function stepFor(v: number, max: number): number {
  if (v <= 0) return 0;
  if (v >= max) return 6;
  return 1 + Math.floor(v / (max / 5));
}

/**
 * Stunde × Tag – zeigt Tageszeit-Muster (z. B. Abend-Auslastung im Kabelsegment).
 * Reines CSS-Grid: scharf, druckbar, ohne Canvas. Für Zoom/Brush: heatmapOption() (ECharts).
 * Stunden ohne Messung sind schraffiert; Stunden, in denen nur ein kleiner Teil gemessen wurde
 * (coveragePct < lowCoveragePct), zeigen ihre Farbe gedämpft unter einer Schraffur.
 */
export function HourHeatmap({ cells, days, metric, unit, max, digits = 1, lowCoveragePct = 50, className }: HourHeatmapProps) {
  const map = new Map(cells.map((c) => [`${c.day}|${c.hour}`, c]));
  const hours = Array.from({ length: 24 }, (_, h) => h);
  const legend = STEPS.map((cls, i) => ({
    cls,
    text: i === 0 ? "0" : i === 1 ? `über 0` : `ab ${fmtNumber(((i - 1) * max) / 5, digits)}`,
  }));
  const anyLow = cells.some((c) => c.value != null && c.coveragePct != null && c.coveragePct < lowCoveragePct);

  return (
    <figure className={cn("min-w-0", className)}>
      {/* relative: sr-only-Elemente (absolut) bleiben im Scroll-Container und dehnen die Seite nicht */}
      <div className="relative overflow-x-auto pb-1">
        <div
          className="grid min-w-[640px] gap-[3px]"
          style={{ gridTemplateColumns: "5.5rem repeat(24, minmax(0, 1fr))" }}
          role="table"
          aria-label={`${metric} je Stunde und Tag`}
        >
          <div role="row" className="contents">
            <span role="columnheader">
              <span className="sr-only">Tag</span>
            </span>
            {hours.map((h) => (
              <span key={h} role="columnheader" className="np-num text-center text-2xs text-fg-4">
                {h % 3 === 0 ? String(h).padStart(2, "0") : ""}
                <span className="sr-only">{`${h} Uhr`}</span>
              </span>
            ))}
          </div>
          {days.map((day) => (
            <div key={day} role="row" className="contents">
              <span role="rowheader" className="truncate pr-2 text-right text-xs leading-5 text-fg-3">
                {fmtDayShort(`${day}T12:00:00Z`)}
              </span>
              {hours.map((h) => {
                const c = map.get(`${day}|${h}`);
                const has = c != null && c.value != null;
                const low = has && c.coveragePct != null && c.coveragePct < lowCoveragePct;
                const when = `${fmtDayShort(`${day}T12:00:00Z`)}, ${h}–${h + 1} Uhr`;
                const label = has
                  ? `${when}: ${fmtNumber(c.value, digits)} ${unit} ${metric}${c.samples ? ` (${c.samples} Messungen)` : ""}${
                      low ? ` – nur ${fmtNumber(c.coveragePct, 0)} % der Stunde gemessen` : ""
                    }`
                  : `${when}: keine Messung`;
                return (
                  <span
                    key={h}
                    role="cell"
                    title={label}
                    aria-label={label}
                    className={cn(
                      "h-5 rounded-[3px] transition-[outline-color] hover:outline hover:outline-1 hover:outline-fg",
                      has ? STEPS[stepFor(c.value as number, max)] : "np-hatch",
                      low && "np-hatch-over",
                    )}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>
      <figcaption className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-2xs text-fg-3">
        <span className="text-fg-2">
          {metric} ({unit})
        </span>
        {legend.map((l) => (
          <span key={l.cls} className="inline-flex items-center gap-1">
            <span aria-hidden className={cn("h-3 w-4 rounded-[3px]", l.cls)} />
            <span className="np-num">{l.text}</span>
          </span>
        ))}
        <span className="inline-flex items-center gap-1">
          <span aria-hidden className="np-hatch h-3 w-4 rounded-[3px] ring-1 ring-inset ring-line" />
          keine Messung
        </span>
        {anyLow && (
          <span className="inline-flex items-center gap-1">
            <span aria-hidden className="np-hatch-over h-3 w-4 rounded-[3px] bg-heat-3" />
            {`wenig gemessen (unter ${lowCoveragePct} % der Stunde)`}
          </span>
        )}
      </figcaption>
    </figure>
  );
}
