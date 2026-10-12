import type { SecondsRollup } from "@/lib/shared/types";
import { secondsBreakdown } from "@/lib/client/charts";
import { cn } from "@/lib/cn";
import { fmtDuration, fmtInt, fmtPct } from "@/lib/format";

interface FaultShareBarProps {
  /** Summenzeile aus GET /api/seconds (total) oder DiagnosisReport.seconds-ähnlich */
  total: SecondsRollup | null | undefined;
  /** Beschriftung über dem Balken, z. B. "Letzte 24 Stunden" */
  caption?: string;
  className?: string;
}

/**
 * Ein 100-%-Balken: Anteil der gestörten Sekunden je Abschnitt (nah -> fern) + Legende mit
 * Werten. Reines HTML (Server-tauglich). Farbe = ordinale Segment-Rampe, nie Statusfarbe.
 */
export function FaultShareBar({ total, caption, className }: FaultShareBarProps) {
  const b = secondsBreakdown(total);
  if (b.covered === 0) {
    return <p className={cn("text-sm text-fg-3", className)}>Keine Messung im Zeitraum.</p>;
  }
  return (
    <figure className={cn("flex min-w-0 flex-col gap-3", className)}>
      <figcaption className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <span className="text-sm text-fg-2">{caption ?? "Gestörte Sekunden nach Abschnitt"}</span>
        <span className="np-num text-xs text-fg-3">
          {fmtInt(b.bad)} von {fmtInt(b.covered)} s gestört ({fmtPct(b.badPct)})
        </span>
      </figcaption>
      {b.bad === 0 ? (
        <div className="h-3 rounded-full bg-good/25 ring-1 ring-inset ring-good/40" role="img" aria-label="Keine gestörten Sekunden" />
      ) : (
        <div className="flex h-3 w-full gap-0.5 overflow-hidden rounded-full" role="img" aria-label={b.items.map((it) => `${it.label}: ${fmtPct(it.share)}`).join(", ")}>
          {b.items.map((it) => (
            <span key={it.id} className="h-full first:rounded-l-full last:rounded-r-full" style={{ width: `${it.share}%`, minWidth: 3, backgroundColor: it.color }} />
          ))}
        </div>
      )}
      {b.items.length > 0 && (
        <ul className="grid grid-cols-1 gap-x-6 gap-y-1.5 text-xs sm:grid-cols-2">
          {b.items.map((it) => (
            <li key={it.id} className="flex min-w-0 items-center gap-2">
              <span aria-hidden className="size-2.5 shrink-0 rounded-[3px]" style={{ backgroundColor: it.color }} />
              <span className="truncate text-fg-2">{it.label}</span>
              <span className="np-num ml-auto shrink-0 text-fg">{fmtPct(it.share)}</span>
              <span className="np-num w-24 shrink-0 text-right text-fg-3">{fmtDuration(it.seconds)}</span>
            </li>
          ))}
        </ul>
      )}
    </figure>
  );
}
