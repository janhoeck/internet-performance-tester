import type { ReactNode } from "react";
import { Info, TriangleAlert, OctagonAlert, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";

export interface KeyValueItem {
  label: string;
  value: ReactNode;
  /** kleine Zusatzzeile unter dem Wert */
  hint?: ReactNode;
}

/** Definitionsliste für Stammdaten (Label links/oben, Wert in Mono). */
export function KeyValueList({ items, columns = 2, className }: { items: readonly KeyValueItem[]; columns?: 1 | 2 | 3; className?: string }) {
  return (
    <dl
      className={cn(
        "grid grid-cols-1 gap-x-6 gap-y-3",
        columns === 2 && "sm:grid-cols-2",
        columns === 3 && "sm:grid-cols-2 xl:grid-cols-3",
        className,
      )}
    >
      {items.map((it) => (
        <div key={it.label} className="min-w-0">
          <dt className="text-xs text-fg-3">{it.label}</dt>
          <dd className="mt-0.5 min-w-0 break-words text-sm text-fg">{it.value}</dd>
          {it.hint != null && <dd className="mt-0.5 text-xs text-fg-3">{it.hint}</dd>}
        </div>
      ))}
    </dl>
  );
}

const NOTE_TONE = {
  info: { icon: Info, box: "bg-info/8 ring-info/25", icon_: "text-info" },
  warn: { icon: TriangleAlert, box: "bg-warn/8 ring-warn/30", icon_: "text-warn" },
  crit: { icon: OctagonAlert, box: "bg-crit/8 ring-crit/35", icon_: "text-crit" },
} as const;

/** Hinweisbox innerhalb eines Panels (Icon + Text, nie nur Farbe). */
export function Note({
  tone = "info",
  title,
  icon,
  children,
  className,
}: {
  tone?: keyof typeof NOTE_TONE;
  title?: ReactNode;
  icon?: LucideIcon;
  children?: ReactNode;
  className?: string;
}) {
  const t = NOTE_TONE[tone];
  const Icon = icon ?? t.icon;
  return (
    <div className={cn("flex gap-3 rounded-[10px] px-4 py-3 ring-1 ring-inset", t.box, className)}>
      <Icon aria-hidden className={cn("mt-0.5 size-4 shrink-0", t.icon_)} strokeWidth={2.25} />
      <div className="min-w-0 text-sm text-fg-2">
        {title != null && <p className="font-medium text-fg">{title}</p>}
        {children != null && <div className={cn(title != null && "mt-0.5")}>{children}</div>}
      </div>
    </div>
  );
}

/** Messwert in Mono (IP, MAC, Zahl, Zeit). */
export function Num({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("np-num", className)}>{children}</span>;
}

/** Kleiner neutraler Chip, z. B. „Dieser PC“ oder „LAN“. */
export function Chip({ children, tone = "neutral", className }: { children: ReactNode; tone?: "neutral" | "fiber" | "warn"; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center whitespace-nowrap rounded-full px-2 text-2xs font-medium ring-1 ring-inset",
        tone === "neutral" && "bg-raised text-fg-2 ring-line-strong",
        tone === "fiber" && "bg-fiber/12 text-fiber ring-fiber/35",
        tone === "warn" && "bg-warn/12 text-warn ring-warn/30",
        className,
      )}
    >
      {children}
    </span>
  );
}
