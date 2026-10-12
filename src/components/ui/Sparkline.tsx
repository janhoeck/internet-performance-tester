import { cn } from "@/lib/cn";

interface SparklineProps {
  /** Werte in zeitlicher Reihenfolge; null = keine Messung (Lücke in der Linie). */
  values: ReadonlyArray<number | null>;
  /** Linienfarbe (CSS). Standard: Einzelserien-Farbe (Glasfaser-Cyan). */
  color?: string;
  /** Optionale Schwelle als gestrichelte Linie (z. B. 60 ms). */
  threshold?: number;
  thresholdColor?: string;
  /** Fester Wertebereich, sonst automatisch. */
  min?: number;
  max?: number;
  className?: string;
  /** Kurze Beschreibung für Screenreader, z. B. "Latenz der letzten 60 Minuten". */
  label?: string;
}

const W = 120;
const H = 32;
const PAD = 3;

/**
 * Reines SVG, keine Abhängigkeit, Server-tauglich. Das SVG dehnt sich per
 * preserveAspectRatio="none" auf die Containerbreite, vector-effect hält die Linie
 * 1,5 px dick; der Endpunkt ist ein HTML-Element, damit er rund bleibt.
 */
export function Sparkline({
  values,
  color = "var(--np-chart-solo)",
  threshold,
  thresholdColor = "var(--np-warn)",
  min,
  max,
  className,
  label,
}: SparklineProps) {
  const nums = values.filter((v): v is number => v != null && Number.isFinite(v));
  if (nums.length < 2) {
    return (
      <div className={cn("np-hatch h-8 w-full rounded opacity-60", className)} role="img" aria-label="Noch zu wenige Messwerte" />
    );
  }
  const lo = min ?? Math.min(...nums, threshold ?? Infinity);
  const hi = max ?? Math.max(...nums, threshold ?? -Infinity);
  const span = hi - lo || 1;
  const step = (W - PAD * 2) / Math.max(1, values.length - 1);
  const x = (i: number) => PAD + i * step;
  const y = (v: number) => H - PAD - ((v - lo) / span) * (H - PAD * 2);

  let line = "";
  let area = "";
  let segStart = -1;
  const closeArea = (end: number) => {
    area += `L${x(end).toFixed(1)},${H - PAD}L${x(segStart).toFixed(1)},${H - PAD}Z`;
  };
  values.forEach((v, i) => {
    if (v == null || !Number.isFinite(v)) {
      if (segStart >= 0) closeArea(i - 1);
      segStart = -1;
      return;
    }
    const cmd = segStart < 0 ? "M" : "L";
    if (segStart < 0) segStart = i;
    const pt = `${cmd}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
    line += pt;
    area += pt;
  });
  if (segStart >= 0) closeArea(values.length - 1);

  const lastIndex = values.length - 1;
  const last = values[lastIndex];

  return (
    <div className={cn("relative h-8 w-full", className)} role={label ? "img" : undefined} aria-label={label}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden className="absolute inset-0 size-full overflow-visible">
        <path d={area} style={{ fill: color }} fillOpacity={0.1} />
        {threshold != null && (
          <line
            x1={0}
            x2={W}
            y1={y(threshold)}
            y2={y(threshold)}
            style={{ stroke: thresholdColor }}
            strokeWidth={1}
            strokeDasharray="3 3"
            vectorEffect="non-scaling-stroke"
            opacity={0.7}
          />
        )}
        <path
          d={line}
          fill="none"
          style={{ stroke: color }}
          strokeWidth={1.5}
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      {last != null && Number.isFinite(last) && (
        <span
          aria-hidden
          className="absolute size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-panel"
          style={{ left: `${(x(lastIndex) / W) * 100}%`, top: `${(y(last) / H) * 100}%`, backgroundColor: color }}
        />
      )}
    </div>
  );
}
