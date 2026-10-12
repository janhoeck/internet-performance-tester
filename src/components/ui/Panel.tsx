import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

interface PanelProps {
  title?: ReactNode;
  description?: ReactNode;
  /** Rechts im Kopf: Zeitraum-Umschalter, Buttons … */
  actions?: ReactNode;
  /** Messfenster-Ecken – nur für 1–2 Schlüssel-Panels je Seite (z. B. Leitungsweg). */
  frame?: boolean;
  as?: "section" | "article" | "div";
  className?: string;
  bodyClassName?: string;
  children: ReactNode;
}

/** Glas-Panel. Radius-Hierarchie: Panel/Kachel 16 px > innere Flächen 10 px > Controls 8 px > Chips rund. */
export function Panel({ title, description, actions, frame = false, as = "section", className, bodyClassName, children }: PanelProps) {
  const Tag = as;
  const hasHeader = title != null || actions != null;
  return (
    <Tag className={cn("np-panel min-w-0", frame && "np-frame", className)}>
      {hasHeader && (
        <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-5 pt-4">
          <div className="min-w-0">
            {title != null && <h2 className="text-lg font-medium text-fg">{title}</h2>}
            {description != null && <p className="mt-0.5 text-sm text-fg-3">{description}</p>}
          </div>
          {actions != null && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={cn("px-5 pb-5", hasHeader ? "pt-4" : "pt-5", bodyClassName)}>{children}</div>
    </Tag>
  );
}
