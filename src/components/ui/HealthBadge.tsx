import { cn } from "@/lib/cn";
import { HEALTH_ICON, HEALTH_LABEL, HEALTH_SOFT, HEALTH_TEXT, type Severity } from "@/lib/health";

interface HealthBadgeProps {
  status: Severity;
  /** Eigener Text, z. B. "Link 100 Mbit/s". Standard: "Gut", "Auffällig", … */
  label?: string;
  size?: "sm" | "md";
  className?: string;
}

/** Status nie nur über Farbe: Icon + Text + Farbe. */
export function HealthBadge({ status, label, size = "md", className }: HealthBadgeProps) {
  const Icon = HEALTH_ICON[status];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full font-medium ring-1 ring-inset",
        size === "sm" ? "h-5 px-2 text-2xs" : "h-6 px-2.5 text-xs",
        HEALTH_TEXT[status],
        HEALTH_SOFT[status],
        className,
      )}
    >
      <Icon aria-hidden className={size === "sm" ? "size-3" : "size-3.5"} strokeWidth={2.25} />
      {label ?? HEALTH_LABEL[status]}
    </span>
  );
}

/** Kompakter Punkt für Tabellen/Listen – immer mit sichtbarem Text daneben verwenden. */
export function HealthDot({ status, className }: { status: Severity; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("inline-block size-2 shrink-0 rounded-full bg-current ring-2 ring-panel", HEALTH_TEXT[status], className)}
    />
  );
}
