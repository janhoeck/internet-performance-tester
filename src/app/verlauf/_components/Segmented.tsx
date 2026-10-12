"use client";

import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "@/lib/cn";

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  /** Tooltip / längere Beschriftung */
  title?: string;
}

interface SegmentedProps<T extends string> {
  /** Beschriftung der Gruppe für Screenreader */
  label: string;
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  className?: string;
}

/**
 * Kleiner Umschalter (Radiogruppe) im Stil des Zeitraum-Umschalters: Pfeiltasten, Pos1/Ende.
 * Lokal für Verlauf/Ereignisse – Kandidat für src/components/ui.
 */
export function Segmented<T extends string>({ label, options, value, onChange, className }: SegmentedProps<T>) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const activeIndex = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    let next = activeIndex;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (activeIndex + 1) % options.length;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (activeIndex - 1 + options.length) % options.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = options.length - 1;
    else return;
    e.preventDefault();
    refs.current[next]?.focus();
    onChange(options[next].value);
  };

  return (
    <div
      role="radiogroup"
      aria-label={label}
      onKeyDown={onKeyDown}
      className={cn(
        "inline-flex h-8 max-w-full items-center gap-0.5 overflow-x-auto rounded-lg bg-sunken p-0.5 ring-1 ring-inset ring-line [scrollbar-width:none]",
        className,
      )}
    >
      {options.map((o, i) => {
        const checked = o.value === value;
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={i === activeIndex ? 0 : -1}
            title={o.title}
            onClick={() => onChange(o.value)}
            className={cn(
              "inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 text-xs font-medium text-fg-3 transition-colors",
              "hover:text-fg focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-fiber",
              checked && "bg-raised text-fg shadow-panel ring-1 ring-inset ring-line-strong",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
