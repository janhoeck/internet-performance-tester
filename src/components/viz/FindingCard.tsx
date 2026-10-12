import type { ReactNode } from "react";
import { Lightbulb } from "lucide-react";
import { cn } from "@/lib/cn";
import { HEALTH_COLOR, type Severity } from "@/lib/health";
import { SEGMENT_BY_ID, type SegmentId } from "@/lib/segments";
import { HealthBadge } from "@/components/ui/HealthBadge";

export interface FindingEvidence {
  /** Beobachtung in Worten */
  label: string;
  /** Messwert, Mono: "77", "3–22 s", "30 von 77" */
  value?: string;
}

export interface Finding {
  id: string;
  severity: Severity;
  /** Aussage, nicht Kategorie: "Ethernet-Link bricht wiederholt ab" */
  title: string;
  summary: string;
  segment?: SegmentId;
  confidence?: "niedrig" | "mittel" | "hoch";
  evidence: readonly FindingEvidence[];
  /** Konkreter nächster Schritt */
  recommendation?: string;
}

interface FindingCardProps {
  finding: Finding;
  /** Buttons, z. B. "Im Verlauf zeigen", "Als erledigt markieren" */
  actions?: ReactNode;
  className?: string;
}

/** Befund = Schwere + Segment + Belege + Empfehlung. Die linke Schiene trägt die Schwere. */
export function FindingCard({ finding: f, actions, className }: FindingCardProps) {
  const seg = f.segment ? SEGMENT_BY_ID[f.segment] : undefined;
  return (
    <article className={cn("np-panel overflow-hidden", className)}>
      <span aria-hidden className="absolute inset-y-0 left-0 w-0.5" style={{ backgroundColor: HEALTH_COLOR[f.severity] }} />
      <div className="flex flex-col gap-3 p-5 pl-6">
        <header className="flex flex-wrap items-center gap-2">
          <HealthBadge status={f.severity} />
          {seg && (
            <span className="inline-flex h-6 items-center gap-1.5 rounded-full px-2.5 text-xs text-fg-2 ring-1 ring-inset ring-line">
              <seg.icon aria-hidden className="size-3.5 text-fg-3" strokeWidth={2} />
              {seg.label}
            </span>
          )}
          {f.confidence && <span className="ml-auto text-xs text-fg-3">Sicherheit: {f.confidence}</span>}
        </header>

        <div>
          <h3 className="text-lg font-medium text-fg">{f.title}</h3>
          <p className="mt-1 max-w-prose text-sm text-fg-2">{f.summary}</p>
        </div>

        {f.evidence.length > 0 && (
          <dl className="divide-y divide-line/70 rounded-[10px] bg-sunken/60 px-4 ring-1 ring-inset ring-line">
            {f.evidence.map((e, i) => (
              <div key={i} className="flex items-baseline justify-between gap-6 py-2">
                <dt className="text-sm text-fg-3">{e.label}</dt>
                <dd className="np-num shrink-0 text-right text-sm text-fg">{e.value ?? ""}</dd>
              </div>
            ))}
          </dl>
        )}

        {f.recommendation && (
          <p className="flex gap-2.5 text-sm text-fg-2">
            <Lightbulb aria-hidden className="mt-0.5 size-4 shrink-0 text-laser" strokeWidth={2} />
            <span>
              <span className="font-medium text-fg">Empfehlung: </span>
              {f.recommendation}
            </span>
          </p>
        )}

        {actions && <footer className="flex flex-wrap gap-2 pt-1">{actions}</footer>}
      </div>
    </article>
  );
}
