import type { ComponentPropsWithRef, ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/cn";

/* Formular-Bausteine im Netzpuls-Stil: Rahmen in line-control (>= 3:1), Fokus = Glasfaser-Ring.
   Ohne Direktive: in Server- und Client-Komponenten nutzbar (Handler nur in Client-Komponenten). */

const CONTROL =
  "w-full rounded-lg bg-raised text-sm text-fg ring-1 ring-inset ring-line-control transition-[box-shadow,background-color] duration-150 " +
  "placeholder:text-fg-4 hover:bg-overlay focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-fiber " +
  "disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:ring-crit";

interface FieldProps {
  /** Beschriftung (Pflicht, sichtbar) */
  label: ReactNode;
  /** id des Eingabeelements (label htmlFor) */
  htmlFor: string;
  /** Hilfetext unter dem Feld */
  hint?: ReactNode;
  /** Fehlermeldung (ersetzt den Hinweis, role="alert") */
  error?: ReactNode;
  optional?: boolean;
  className?: string;
  children: ReactNode;
}

/** Label + Feld + Hinweis/Fehler. Für aria-describedby am Feld: `${htmlFor}-hint` bzw. `${htmlFor}-error`. */
export function Field({ label, htmlFor, hint, error, optional, className, children }: FieldProps) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <label htmlFor={htmlFor} className="text-xs font-medium text-fg-2">
        {label}
        {optional && <span className="ml-1.5 font-normal text-fg-3">(optional)</span>}
      </label>
      {children}
      {error ? (
        <p id={`${htmlFor}-error`} role="alert" className="text-xs text-crit">
          {error}
        </p>
      ) : (
        hint && (
          <p id={`${htmlFor}-hint`} className="text-xs text-fg-3">
            {hint}
          </p>
        )
      )}
    </div>
  );
}

/** Einzeiliges Eingabefeld (auch type="number", "datetime-local", "password"). */
export function TextInput({ className, ...rest }: ComponentPropsWithRef<"input">) {
  return <input className={cn(CONTROL, "h-9 px-3", rest.type === "number" && "np-num", className)} {...rest} />;
}

/** Native Auswahlliste im Netzpuls-Stil (Tastatur & Screenreader wie gewohnt). */
export function Select({ className, children, ...rest }: ComponentPropsWithRef<"select">) {
  return (
    <span className={cn("relative block", className)}>
      <select className={cn(CONTROL, "h-9 appearance-none pl-3 pr-9")} {...rest}>
        {children}
      </select>
      <ChevronDown aria-hidden className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-fg-3" strokeWidth={2} />
    </span>
  );
}

interface SwitchProps extends Omit<ComponentPropsWithRef<"input">, "type" | "role"> {
  /** sichtbarer Text rechts neben dem Schalter */
  label: ReactNode;
  hint?: ReactNode;
}

/** Ein/Aus-Schalter (native Checkbox mit role="switch"). */
export function Switch({ label, hint, className, id, ...rest }: SwitchProps) {
  return (
    <label htmlFor={id} className={cn("group flex cursor-pointer items-start gap-3", rest.disabled && "cursor-not-allowed opacity-50", className)}>
      <span className="relative mt-0.5 inline-flex h-5 w-9 shrink-0">
        <input id={id} type="checkbox" role="switch" className="peer sr-only" {...rest} />
        <span
          aria-hidden
          className="absolute inset-0 rounded-full bg-raised ring-1 ring-inset ring-line-control transition-colors peer-checked:bg-fiber-strong peer-checked:ring-fiber-strong peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-fiber"
        />
        <span aria-hidden className="absolute left-0.5 top-0.5 size-4 rounded-full bg-fg-3 transition-transform peer-checked:translate-x-4 peer-checked:bg-fg-invert" />
      </span>
      <span className="min-w-0">
        <span className="block text-sm text-fg">{label}</span>
        {hint && <span className="mt-0.5 block text-xs text-fg-3">{hint}</span>}
      </span>
    </label>
  );
}

export interface ChoiceOption<T extends string> {
  value: T;
  label: ReactNode;
  /** kleine Zusatzzeile, z. B. "empfohlen" */
  hint?: ReactNode;
  disabled?: boolean;
}

interface ChoiceGroupProps<T extends string> {
  /** Gruppenname (name-Attribut der Radios) */
  name: string;
  /** sichtbare Gruppenbeschriftung (legend) */
  legend: ReactNode;
  options: readonly ChoiceOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Spalten ab sm (Standard 3) */
  columns?: 2 | 3 | 4 | 6;
  className?: string;
}

const COLS = { 2: "sm:grid-cols-2", 3: "sm:grid-cols-3", 4: "sm:grid-cols-4", 6: "sm:grid-cols-6" } as const;

/**
 * Auswahl-Kacheln (Radiogruppe): native Radios -> Pfeiltasten, Formular, Screenreader funktionieren
 * ohne eigenes JS. Nur in Client-Komponenten (onChange).
 */
export function ChoiceGroup<T extends string>({ name, legend, options, value, onChange, columns = 3, className }: ChoiceGroupProps<T>) {
  return (
    <fieldset className={cn("min-w-0", className)}>
      <legend className="mb-1.5 text-xs font-medium text-fg-2">{legend}</legend>
      <div className={cn("grid grid-cols-2 gap-2", COLS[columns])}>
        {options.map((o) => {
          const id = `${name}-${o.value}`;
          return (
            <label
              key={o.value}
              htmlFor={id}
              className={cn(
                "relative flex min-h-11 cursor-pointer flex-col justify-center rounded-lg bg-raised px-3 py-2 ring-1 ring-inset ring-line-control transition-colors",
                "hover:bg-overlay has-[:checked]:bg-fiber/12 has-[:checked]:ring-2 has-[:checked]:ring-fiber",
                "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-fiber",
                o.disabled && "cursor-not-allowed opacity-50",
              )}
            >
              <input
                id={id}
                type="radio"
                name={name}
                value={o.value}
                checked={value === o.value}
                disabled={o.disabled}
                onChange={() => onChange(o.value)}
                className="sr-only"
              />
              <span className="text-sm font-medium text-fg">{o.label}</span>
              {o.hint && <span className="text-2xs text-fg-3">{o.hint}</span>}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
