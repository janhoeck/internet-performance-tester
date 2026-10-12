"use client";

import type { ReactNode } from "react";
import { LoaderCircle } from "lucide-react";
import type { DataStateResult } from "@/components/ui/States";
import { cn } from "@/lib/cn";

/** Abschnitt des Berichts: Überschrift + Inhalt, druckt möglichst ohne Seitenumbruch. */
export function ReportSection({
  title,
  description,
  children,
  block = true,
  className,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  /** false für lange Tabellen (dürfen über Seiten laufen) */
  block?: boolean;
  className?: string;
}) {
  return (
    <section className={cn("border-t border-line pt-5", block && "np-paper-block", className)}>
      <h2 className="font-display text-lg font-semibold text-fg">{title}</h2>
      {description && <p className="mt-0.5 text-sm text-fg-3">{description}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}

/** Kompakter Lade-/Fehler-/Leerzustand für Berichtsabschnitte (Papier: ruhig, ohne große Icons). */
export function ReportData<T>({
  result,
  isEmpty,
  empty,
  children,
}: {
  result: DataStateResult<T>;
  isEmpty?: (data: T) => boolean;
  empty: ReactNode;
  children: (data: T) => ReactNode;
}) {
  const { data, error, loading } = result;
  if (data == null) {
    if (error) {
      return (
        <p role="alert" className="text-sm text-crit">
          Konnte nicht geladen werden: {error.message}
          {result.reload && (
            <button type="button" onClick={result.reload} className="np-no-print ml-2 text-fiber underline-offset-4 hover:underline">
              Erneut versuchen
            </button>
          )}
        </p>
      );
    }
    if (loading) {
      return (
        <p className="flex items-center gap-2 text-sm text-fg-3" aria-busy="true">
          <LoaderCircle aria-hidden className="size-4 animate-spin" />
          Wird geladen …
        </p>
      );
    }
    return <p className="text-sm text-fg-3">{empty}</p>;
  }
  if (isEmpty?.(data)) return <p className="text-sm text-fg-3">{empty}</p>;
  return <>{children(data)}</>;
}

/** Schlichte Tabelle für Papier/Druck (keine Sticky-Köpfe, kein Hover). */
export interface PaperColumn<T> {
  key: string;
  header: ReactNode;
  numeric?: boolean;
  className?: string;
  render: (row: T) => ReactNode;
}

export function PaperTable<T>({
  columns,
  rows,
  rowKey,
  caption,
}: {
  columns: ReadonlyArray<PaperColumn<T>>;
  rows: readonly T[];
  rowKey: (row: T, i: number) => string;
  caption: string;
}) {
  return (
    <div className="relative overflow-x-auto print:overflow-visible">
      <table className="w-full border-collapse text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            {columns.map((c) => (
              <th
                key={c.key}
                scope="col"
                className={cn(
                  "border-b border-line-strong px-2 py-1.5 text-xs font-medium text-fg-3 font-stretch-semi-condensed first:pl-0 last:pr-0",
                  c.numeric ? "text-right" : "text-left",
                  c.className,
                )}
              >
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={rowKey(r, i)} className="break-inside-avoid">
              {columns.map((c) => (
                <td
                  key={c.key}
                  className={cn(
                    "border-b border-line px-2 py-1.5 align-top text-fg-2 first:pl-0 last:pr-0",
                    c.numeric && "np-num text-right text-fg",
                    c.className,
                  )}
                >
                  {c.render(r)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Kennzahl im Kopf des Berichts. */
export function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="np-label">{label}</dt>
      <dd className="mt-0.5 text-sm text-fg">{children}</dd>
    </div>
  );
}
