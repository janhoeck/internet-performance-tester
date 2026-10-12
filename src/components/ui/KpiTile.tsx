import type { ReactNode } from "react";
import { ArrowDownRight, ArrowUpRight, Minus, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";
import { HEALTH_COLOR, type Health } from "@/lib/health";
import { HealthBadge } from "./HealthBadge";

export interface KpiDelta {
  /** Fertiger Text, z. B. "+42 ms ggü. 7-Tage-Median" */
  text: string;
  trend: "up" | "down" | "flat";
  /** Richtung × "ist das gut?" entscheidet der Aufrufer (Latenz hoch = schlecht). */
  tone: "good" | "warn" | "bad" | "neutral";
}

interface KpiTileProps {
  label: string;
  /** Vorformatiert (deutsch): "18,4" */
  value: string;
  unit?: string;
  status?: Health;
  statusLabel?: string;
  icon?: LucideIcon;
  delta?: KpiDelta;
  /** Bezug des Werts: "Median, letzte 5 min" */
  caption?: string;
  /** Slot für <Sparkline/> oder Mini-Chart */
  children?: ReactNode;
  className?: string;
}

const TREND_ICON = { up: ArrowUpRight, down: ArrowDownRight, flat: Minus } as const;
const TONE_CLASS = { good: "text-good", warn: "text-warn", bad: "text-crit", neutral: "text-fg-3" } as const;

export function KpiTile({ label, value, unit, status, statusLabel, icon: Icon, delta, caption, children, className }: KpiTileProps) {
  const TrendIcon = delta ? TREND_ICON[delta.trend] : null;
  return (
    <article className={cn("np-panel flex min-w-0 flex-col gap-2.5 overflow-hidden p-4", className)}>
      {status && (
        /* Lichtleiste oben: leise bei "gut", leuchtend bei Abweichung */
        <span
          aria-hidden
          className={cn("absolute inset-x-5 top-0 h-0.5 rounded-b-full", status === "good" ? "opacity-40" : "opacity-90")}
          style={{
            backgroundColor: HEALTH_COLOR[status],
            boxShadow: status === "good" ? undefined : `0 0 12px 0 ${HEALTH_COLOR[status]}`,
          }}
        />
      )}
      <header className="flex min-h-6 items-start justify-between gap-2">
        <h3 className="np-label flex min-w-0 items-start gap-1.5 pt-0.5 font-sans">
          {Icon && <Icon aria-hidden className="mt-px size-3.5 shrink-0" strokeWidth={2} />}
          <span className="line-clamp-2 break-words">{label}</span>
        </h3>
        {status && <HealthBadge status={status} label={statusLabel} size="sm" />}
      </header>

      <p className="flex items-baseline gap-1.5 text-fg">
        <span className="np-num text-3xl font-semibold">{value}</span>
        {unit && <span className="np-num text-sm text-fg-3">{unit}</span>}
      </p>

      {delta && TrendIcon && (
        <p className={cn("flex items-center gap-1 text-xs", TONE_CLASS[delta.tone])}>
          <TrendIcon aria-hidden className="size-3.5" strokeWidth={2.25} />
          <span className="np-num">{delta.text}</span>
        </p>
      )}

      {children && <div className="mt-auto pt-1">{children}</div>}
      {caption && <p className="text-2xs text-fg-3">{caption}</p>}
    </article>
  );
}
