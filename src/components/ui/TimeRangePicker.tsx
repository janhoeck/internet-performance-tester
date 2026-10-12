"use client";

import { useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { CalendarRange } from "lucide-react";
import { cn } from "@/lib/cn";
import { toDateTimeInput } from "@/lib/format";
import { RANGE_PRESET_BY_ID, type RangePreset, type TimeRange } from "@/lib/client/use-time-range";
import { Button } from "./Button";
import { Dialog } from "./Dialog";
import { Field, TextInput } from "./Field";

interface TimeRangePickerProps {
  /** Ergebnis von useTimeRange() */
  range: TimeRange;
  /** angebotene Voreinstellungen (Reihenfolge = Anzeige) */
  presets?: readonly Exclude<RangePreset, "custom">[];
  /** "Eigener Zeitraum" anbieten (Dialog mit Von/Bis) */
  allowCustom?: boolean;
  className?: string;
}

const DEFAULT_PRESETS = ["1h", "6h", "24h", "7d", "30d", "session"] as const;

/**
 * Zeitraum-Umschalter für die Filterzeile im Seitenkopf (gilt für alles darunter).
 * Segmentierte Radiogruppe (Pfeiltasten, Pos1/Ende) + optional "Eigener Zeitraum".
 *
 *   const range = useTimeRange({ defaultPreset: "24h" });
 *   <PageHeader title="Verlauf" actions={<TimeRangePicker range={range} />} />
 */
export function TimeRangePicker({ range, presets = DEFAULT_PRESETS, allowCustom = true, className }: TimeRangePickerProps) {
  const [customOpen, setCustomOpen] = useState(false);
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const ids: RangePreset[] = allowCustom ? [...presets, "custom"] : [...presets];
  const activeIndex = Math.max(0, ids.indexOf(range.preset));
  /** Roving tabIndex folgt dem Fokus innerhalb der Gruppe; verlässt der Fokus sie, wieder die Auswahl */
  const [focusIndex, setFocusIndex] = useState<number | null>(null);
  const tabStop = focusIndex != null && focusIndex < ids.length ? focusIndex : activeIndex;

  const choose = (p: RangePreset) => {
    if (p === "custom") setCustomOpen(true);
    else range.setPreset(p);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // vom fokussierten Knopf aus (nicht vom gewählten – z. B. wenn "Eigener" fokussiert, aber nicht gewählt ist)
    const focused = refs.current.findIndex((el) => el != null && el === document.activeElement);
    const i = focused >= 0 ? focused : ids.indexOf(range.preset);
    let next = i < 0 ? 0 : i;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (next + 1) % ids.length;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (next - 1 + ids.length) % ids.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = ids.length - 1;
    else return;
    e.preventDefault();
    refs.current[next]?.focus();
    // Pfeiltasten wählen direkt (wie Radios) – außer "Eigener", das öffnet erst mit Enter/Leertaste
    if (ids[next] !== "custom") choose(ids[next]);
  };

  return (
    <>
      <div
        role="radiogroup"
        aria-label="Zeitraum"
        onKeyDown={onKeyDown}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocusIndex(null);
        }}
        className={cn(
          // schmale Bildschirme: innerhalb des Containers waagerecht scrollen statt die Seite zu verbreitern
          "inline-flex h-8 max-w-full items-center gap-0.5 overflow-x-auto rounded-lg bg-sunken p-0.5 ring-1 ring-inset ring-line [scrollbar-width:none]",
          className,
        )}
      >
        {ids.map((id, i) => {
          const def = RANGE_PRESET_BY_ID[id];
          const checked = range.preset === id;
          const isCustom = id === "custom";
          return (
            <button
              key={id}
              ref={(el) => {
                refs.current[i] = el;
              }}
              type="button"
              role="radio"
              aria-checked={checked}
              tabIndex={i === tabStop ? 0 : -1}
              onFocus={() => setFocusIndex(i)}
              title={isCustom && checked ? range.label : def.label}
              onClick={() => choose(id)}
              className={cn(
                "inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 text-xs font-medium text-fg-3 transition-colors",
                "hover:text-fg focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-fiber",
                checked && "bg-raised text-fg shadow-panel ring-1 ring-inset ring-line-strong",
              )}
            >
              {isCustom && <CalendarRange aria-hidden className="size-3.5" strokeWidth={2} />}
              {isCustom && checked ? <span className="np-num">{range.label}</span> : def.short}
            </button>
          );
        })}
      </div>
      <span className="sr-only" aria-live="polite">
        {`Zeitraum: ${range.label}`}
      </span>
      {customOpen && <CustomRangeDialog range={range} onClose={() => setCustomOpen(false)} />}
    </>
  );
}

function CustomRangeDialog({ range, onClose }: { range: TimeRange; onClose: () => void }) {
  // Startwerte = aktueller Zeitraum (Dialog wird beim Öffnen frisch gerendert)
  const [from, setFrom] = useState(() => (range.from != null ? toDateTimeInput(range.from) : ""));
  const [to, setTo] = useState(() => (range.to != null ? toDateTimeInput(range.to) : ""));
  const [error, setError] = useState<string | null>(null);

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    // datetime-local = Ortszeit des Browsers (Windows: Europe/Berlin)
    const a = Date.parse(from);
    const b = Date.parse(to);
    if (!Number.isFinite(a) || !Number.isFinite(b)) {
      setError("Bitte Beginn und Ende vollständig angeben.");
      return;
    }
    if (b <= a) {
      setError("Das Ende muss nach dem Beginn liegen.");
      return;
    }
    range.setCustom(a, b);
    onClose();
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="Eigener Zeitraum"
      description="Wähle Beginn und Ende. Alle Diagramme und Tabellen dieser Seite zeigen dann genau diesen Zeitraum."
      onSubmit={submit}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Abbrechen
          </Button>
          <Button type="submit" variant="primary">
            Zeitraum übernehmen
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Beginn" htmlFor="np-range-from">
          <TextInput id="np-range-from" type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} required />
        </Field>
        <Field label="Ende" htmlFor="np-range-to" error={error}>
          <TextInput
            id="np-range-to"
            type="datetime-local"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "np-range-to-error" : undefined}
            required
          />
        </Field>
      </div>
    </Dialog>
  );
}
