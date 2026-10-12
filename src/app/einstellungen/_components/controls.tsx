"use client";

import type { ReactNode } from "react";
import { OctagonAlert, TriangleAlert } from "lucide-react";
import { Field, TextInput } from "@/components/ui/Field";
import { cn } from "@/lib/cn";
import { fmtNumber } from "@/lib/format";
import type { Issue, ServerIssue } from "./draft";

function roundTo(v: number, digits = 6): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

function fmtPlain(v: number): string {
  return Number.isInteger(v) ? String(v) : fmtNumber(v, 2);
}

/** Meldung eines Problems in der Anzeigeeinheit des Felds. */
export function issueText(issue: Issue | undefined, scale = 1, unit?: string): string | undefined {
  if (!issue) return undefined;
  if (!issue.bound) return issue.message;
  const v = fmtPlain(roundTo(issue.bound.value / scale, 3));
  const u = unit ? ` ${unit}` : "";
  if (issue.bound.kind === "min") return issue.bound.inclusive ? `Mindestens ${v}${u}.` : `Muss größer als ${v}${u} sein.`;
  return issue.bound.inclusive ? `Höchstens ${v}${u}.` : `Muss kleiner als ${v}${u} sein.`;
}

interface NumFieldProps {
  id: string;
  label: ReactNode;
  value: number | null;
  onChange: (v: number | null) => void;
  /** Anzeigeeinheit, z. B. "min" */
  unit?: string;
  /** gespeicherter Wert = Anzeige × scale (z. B. 60 für Minuten bei Sekunden-Feldern) */
  scale?: number;
  step?: number;
  /** leeres Feld = null (sonst: ungültig) */
  nullable?: boolean;
  hint?: ReactNode;
  issue?: Issue;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
}

/** Zahlenfeld mit Einheit und Umrechnung (Anzeige in min/s, gespeichert in s/ms). */
export function NumField({ id, label, value, onChange, unit, scale = 1, step, nullable, hint, issue, placeholder, className, disabled }: NumFieldProps) {
  const shown = value === null || !Number.isFinite(value) ? "" : String(roundTo(value / scale, 4));
  const err = issue && !issue.warning ? issueText(issue, scale, unit) : undefined;
  const warn = issue?.warning ? issue.message : undefined;
  return (
    <Field label={label} htmlFor={id} hint={warn ?? hint} error={err} className={className}>
      <div className="relative">
        <TextInput
          id={id}
          type="number"
          inputMode="decimal"
          step={step ?? "any"}
          value={shown}
          placeholder={placeholder}
          disabled={disabled}
          aria-invalid={err ? true : undefined}
          aria-describedby={err ? `${id}-error` : hint || warn ? `${id}-hint` : undefined}
          className={cn(unit && "pr-14")}
          onChange={(e) => {
            const raw = e.target.value;
            if (raw === "") return onChange(nullable ? null : Number.NaN);
            const n = Number(raw);
            onChange(Number.isFinite(n) ? roundTo(n * scale) : Number.NaN);
          }}
        />
        {unit && (
          <span aria-hidden className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-fg-3">
            {unit}
          </span>
        )}
      </div>
    </Field>
  );
}

/** Problem eines ganzen Abschnitts/einer Gruppe (z. B. Liste) als Zeile mit Icon. */
export function IssueLine({ issue, className }: { issue: Issue | undefined; className?: string }) {
  if (!issue) return null;
  const Icon = issue.warning ? TriangleAlert : OctagonAlert;
  return (
    <p role={issue.warning ? undefined : "alert"} className={cn("flex items-start gap-1.5 text-xs", issue.warning ? "text-warn" : "text-crit", className)}>
      <Icon aria-hidden className="mt-px size-3.5 shrink-0" strokeWidth={2.25} />
      <span>{issue.message}</span>
    </p>
  );
}

/** Ablehnung durch die API (Liste der Probleme) – steht über dem betroffenen Abschnitt. */
export function ServerIssues({ issues, title = "Die API hat diese Angaben abgelehnt:" }: { issues: readonly ServerIssue[]; title?: string }) {
  if (issues.length === 0) return null;
  return (
    <div role="alert" className="mb-4 rounded-[10px] bg-crit/10 px-4 py-3 ring-1 ring-inset ring-crit/35">
      <p className="flex items-center gap-2 text-sm font-medium text-fg">
        <OctagonAlert aria-hidden className="size-4 shrink-0 text-crit" strokeWidth={2.25} />
        {title}
      </p>
      <ul className="mt-1.5 list-disc space-y-0.5 pl-10 text-sm text-fg-2">
        {issues.map((i, n) => (
          <li key={n}>
            {i.path && <code className="np-num mr-1.5 text-xs text-fg-3">{i.path}</code>}
            {i.message}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Überschrift einer Untergruppe innerhalb eines Abschnitts. */
export function GroupTitle({ children, className }: { children: ReactNode; className?: string }) {
  return <h3 className={cn("mb-3 text-sm font-medium text-fg", className)}>{children}</h3>;
}

/** Kleiner Hinweis in eingeklappten Bereichen: "2 Eingaben prüfen". */
export function ProblemChip({ count }: { count: number }) {
  return (
    <span className="ml-auto inline-flex h-5 items-center gap-1 rounded-full bg-crit/12 px-2 text-2xs font-medium text-crit ring-1 ring-inset ring-crit/40">
      <OctagonAlert aria-hidden className="size-3" strokeWidth={2.25} />
      <span className="np-num">{count}</span> {count === 1 ? "Eingabe prüfen" : "Eingaben prüfen"}
    </span>
  );
}
