import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export interface Column<T> {
  key: string;
  header: ReactNode;
  /** Zahlen rechtsbündig + Mono + feste Ziffernbreite */
  numeric?: boolean;
  align?: "left" | "right" | "center";
  /** CSS-Breite, z. B. "8rem" */
  width?: string;
  render: (row: T) => ReactNode;
}

interface DataTableProps<T> {
  columns: ReadonlyArray<Column<T>>;
  rows: readonly T[];
  rowKey: (row: T) => string;
  /** Sichtbarer oder sr-only Tabellentitel */
  caption: string;
  captionVisible?: boolean;
  /** Inhalt bei 0 Zeilen (z. B. <EmptyState/>) */
  empty?: ReactNode;
  dense?: boolean;
  /** Feste Höhe mit scrollendem Körper, Kopf bleibt stehen */
  maxHeight?: string;
  className?: string;
}

/**
 * Datentabelle: Haarlinien statt Zebra, Kopf in schmaler Plex-Breite (lange Komposita),
 * Zahlen in Mono. Auch die Tabellen-Alternative zu jedem Diagramm nutzt diese Komponente.
 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  caption,
  captionVisible = false,
  empty,
  dense = false,
  maxHeight,
  className,
}: DataTableProps<T>) {
  if (rows.length === 0 && empty) return <>{empty}</>;
  const alignClass = (c: Column<T>) =>
    c.align === "center" ? "text-center" : c.align === "right" || c.numeric ? "text-right" : "text-left";

  return (
    <div
      className={cn("relative overflow-auto rounded-[10px] ring-1 ring-line", className)}
      style={maxHeight ? { maxHeight } : undefined}
      tabIndex={maxHeight ? 0 : undefined}
    >
      <table className="w-full border-separate border-spacing-0 text-sm">
        <caption className={cn(captionVisible ? "px-3 py-2 text-left text-sm text-fg-2" : "sr-only")}>{caption}</caption>
        <thead>
          <tr>
            {columns.map((c) => (
              <th
                key={c.key}
                scope="col"
                style={c.width ? { width: c.width } : undefined}
                className={cn(
                  "sticky top-0 z-10 h-9 border-b border-line-strong bg-raised px-3 text-xs font-medium text-fg-3 font-stretch-semi-condensed",
                  alignClass(c),
                )}
              >
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={rowKey(row)} className="group transition-colors hover:bg-raised/60">
              {columns.map((c) => (
                <td
                  key={c.key}
                  className={cn(
                    "border-b border-line px-3 text-fg-2 group-last:border-b-0",
                    dense ? "h-8" : "h-10",
                    c.numeric && "np-num text-fg",
                    alignClass(c),
                  )}
                >
                  {c.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
