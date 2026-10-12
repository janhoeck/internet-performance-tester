"use client";

import { useCallback, useMemo } from "react";
import { RotateCcw } from "lucide-react";
import { cn } from "@/lib/cn";
import { setUrlParams, useUrlSearch } from "@/lib/client/use-time-range";
import { resolveSeriesColors, shortTargetName, type TargetsInfo } from "@/lib/client/targets";
import { SHARED_SEGMENT_LABEL } from "@/lib/segments";
import { SEGMENTS as SHARED_SEGMENTS, type TargetConfig } from "@/lib/shared/types";

export const DEFAULT_TARGET_IDS = ["gw", "isp6", "cf4", "cf6"] as const;
/** mehr Linien sind im Diagramm nicht mehr unterscheidbar (8 Farbslots) */
export const MAX_TARGETS = 8;
const PARAM = "ziele";

export interface TargetSelection {
  /** gewählte Ziel-IDs in Konfigurationsreihenfolge */
  ids: readonly string[];
  /** Farbe (hex) je gewählter ID – identisch mit den Diagrammen */
  colors: Readonly<Record<string, string>>;
  toggle: (id: string) => void;
  reset: () => void;
  isDefault: boolean;
}

/** Zielauswahl, synchron mit dem URL-Parameter `ziele` (teilbar, bleibt beim Neuladen). */
export function useTargetSelection(info: TargetsInfo): TargetSelection {
  const sp = useUrlSearch();
  const raw = sp.get(PARAM);
  const { targets, byId } = info;

  const ids = useMemo(() => {
    const wanted = raw != null ? raw.split(",").filter(Boolean) : [...DEFAULT_TARGET_IDS];
    const set = new Set(wanted);
    // Reihenfolge der Konfiguration; unbekannte IDs fallen weg (solange die Konfiguration lädt: Wunschliste behalten)
    const ordered = targets.filter((t) => set.has(t.id)).map((t) => t.id);
    return (ordered.length ? ordered : wanted.filter((id) => byId[id] != null)).slice(0, MAX_TARGETS);
  }, [raw, targets, byId]);

  const colors = useMemo(() => resolveSeriesColors(ids, targets), [ids, targets]);

  const toggle = useCallback(
    (id: string) => {
      const set = new Set(ids);
      if (set.has(id)) set.delete(id);
      else if (set.size < MAX_TARGETS) set.add(id);
      const next = targets.filter((t) => set.has(t.id)).map((t) => t.id);
      setUrlParams({ [PARAM]: next.join(",") });
    },
    [ids, targets],
  );
  const reset = useCallback(() => setUrlParams({ [PARAM]: null }), []);

  return { ids, colors, toggle, reset, isDefault: raw == null };
}

interface TargetPickerProps {
  info: TargetsInfo;
  selection: TargetSelection;
}

/** Ziel-Chips, gruppiert nach Abschnitt des Leitungswegs; Punktfarbe = Linienfarbe im Diagramm. */
export function TargetPicker({ info, selection }: TargetPickerProps) {
  const groups = useMemo(() => {
    const visible = info.targets.filter((t) => t.enabled || selection.ids.includes(t.id));
    return SHARED_SEGMENTS.map((seg) => ({ seg, items: visible.filter((t) => t.segment === seg) })).filter((g) => g.items.length > 0);
  }, [info.targets, selection.ids]);
  const full = selection.ids.length >= MAX_TARGETS;

  return (
    <div className="np-panel flex flex-col gap-3 px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium text-fg" id="np-target-picker-label">
          Ziele <span className="np-num ml-1 text-xs font-normal text-fg-3">{selection.ids.length}</span>
          <span className="np-num text-xs font-normal text-fg-4"> von höchstens {MAX_TARGETS}</span>
        </p>
        {!selection.isDefault && (
          <button
            type="button"
            onClick={selection.reset}
            className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-fg-3 hover:bg-raised hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fiber"
          >
            <RotateCcw aria-hidden className="size-3.5" strokeWidth={2} />
            Standardauswahl
          </button>
        )}
      </div>
      <div role="group" aria-labelledby="np-target-picker-label" className="flex flex-wrap gap-x-5 gap-y-2.5">
        {groups.map(({ seg, items }) => (
          <div key={seg} className="flex min-w-0 flex-wrap items-center gap-1.5">
            <span className="mr-1 text-2xs text-fg-4">{SHARED_SEGMENT_LABEL[seg]}</span>
            {items.map((t) => (
              <TargetChip
                key={t.id}
                target={t}
                name={shortTargetName(t.id, info.targets)}
                selected={selection.ids.includes(t.id)}
                color={selection.colors[t.id]}
                disabled={full && !selection.ids.includes(t.id)}
                onToggle={selection.toggle}
              />
            ))}
          </div>
        ))}
      </div>
      {full && <p className="text-xs text-fg-3">Mehr als {MAX_TARGETS} Linien lassen sich nicht mehr unterscheiden. Wähle erst ein Ziel ab.</p>}
    </div>
  );
}

function TargetChip({
  target,
  name,
  selected,
  color,
  disabled,
  onToggle,
}: {
  target: TargetConfig;
  name: string;
  selected: boolean;
  color: string | undefined;
  disabled: boolean;
  onToggle: (id: string) => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      disabled={disabled}
      title={`${target.name}${target.enabled ? "" : " (deaktiviert)"}`}
      onClick={() => onToggle(target.id)}
      className={cn(
        "inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-xs ring-1 ring-inset transition-colors",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fiber disabled:cursor-not-allowed disabled:opacity-40",
        selected ? "bg-raised text-fg ring-line-strong" : "text-fg-3 ring-line hover:bg-raised hover:text-fg",
      )}
    >
      <span
        aria-hidden
        className={cn("size-2 shrink-0 rounded-full", !selected && "ring-1 ring-inset ring-fg-4")}
        style={selected && color ? { backgroundColor: color } : undefined}
      />
      {name}
    </button>
  );
}
