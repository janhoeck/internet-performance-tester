import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

interface PageHeaderProps {
  title: string;
  /** Ein Satz: was diese Seite beantwortet */
  description?: ReactNode;
  /** Filterzeile rechts: Zeitraum zuerst, dann weitere Filter */
  actions?: ReactNode;
  className?: string;
}

/** Seitenkopf. Filter stehen hier in EINER Zeile und gelten für alles darunter. */
export function PageHeader({ title, description, actions, className }: PageHeaderProps) {
  return (
    <div className={cn("mb-6 flex flex-wrap items-end justify-between gap-x-6 gap-y-3", className)}>
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold text-fg">{title}</h1>
        {description && <p className="mt-1 max-w-2xl text-sm text-fg-3">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
