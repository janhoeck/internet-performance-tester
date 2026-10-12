"use client";

import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "@/lib/cn";

export interface TabItem {
  id: string;
  label: string;
  /** Als Element übergeben (<Gauge className="size-4" />), nicht als Komponente:
      Funktionen dürfen nicht von Server- an Client-Komponenten gereicht werden. */
  icon?: ReactNode;
  /** Zähler, z. B. Anzahl Ereignisse */
  count?: number;
}

interface TabsProps {
  items: readonly TabItem[];
  /** Inhalt je Tab – vom Server gerendert, hier nur ein-/ausgeblendet (Zustand bleibt erhalten). */
  panels: Readonly<Record<string, ReactNode>>;
  defaultValue?: string;
  /** Kontrolliert (nur aus Client-Komponenten, da Funktion) */
  value?: string;
  onValueChange?: (id: string) => void;
  /** Beschriftung der Tab-Leiste für Screenreader, z. B. "Ansicht Verlauf" */
  label: string;
  className?: string;
}

/** WAI-ARIA Tabs: Pfeiltasten, Home/End, automatische Aktivierung. Server-tauglich über `panels`. */
export function Tabs({ items, panels, defaultValue, value, onValueChange, label, className }: TabsProps) {
  const baseId = useId();
  const [inner, setInner] = useState(defaultValue ?? items[0]?.id ?? "");
  const active = value ?? inner;
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  const select = (id: string) => {
    if (value === undefined) setInner(id);
    onValueChange?.(id);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = items.findIndex((t) => t.id === active);
    let next = i;
    if (e.key === "ArrowRight") next = (i + 1) % items.length;
    else if (e.key === "ArrowLeft") next = (i - 1 + items.length) % items.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = items.length - 1;
    else return;
    e.preventDefault();
    select(items[next].id);
    refs.current[next]?.focus();
  };

  return (
    <div className={className}>
      <div role="tablist" aria-label={label} onKeyDown={onKeyDown} className="flex gap-1 overflow-x-auto border-b border-line [scrollbar-width:none]">
        {items.map((t, i) => {
          const selected = t.id === active;
          return (
            <button
              key={t.id}
              ref={(el) => {
                refs.current[i] = el;
              }}
              role="tab"
              type="button"
              id={`${baseId}-tab-${t.id}`}
              aria-selected={selected}
              aria-controls={`${baseId}-panel-${t.id}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => select(t.id)}
              className={cn(
                "relative -mb-px inline-flex h-10 shrink-0 items-center gap-2 px-3 text-sm font-medium text-fg-3 transition-colors hover:text-fg",
                "after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:bg-fiber after:opacity-0 after:transition-opacity",
                "aria-selected:text-fg aria-selected:after:opacity-100",
                "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-fiber",
              )}
            >
              {t.icon}
              {t.label}
              {t.count != null && (
                <span className="np-num rounded-full bg-raised px-1.5 text-2xs text-fg-2 ring-1 ring-inset ring-line">{t.count}</span>
              )}
            </button>
          );
        })}
      </div>
      {items.map((t) => (
        <div
          key={t.id}
          role="tabpanel"
          id={`${baseId}-panel-${t.id}`}
          aria-labelledby={`${baseId}-tab-${t.id}`}
          hidden={t.id !== active}
          tabIndex={0}
          className="pt-4 focus-visible:outline-none"
        >
          {panels[t.id]}
        </div>
      ))}
    </div>
  );
}
