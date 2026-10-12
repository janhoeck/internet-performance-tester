"use client";

import { useId, useState } from "react";
import Link from "next/link";
import { Check, ChevronDown, FileSearch, Lightbulb, Waypoints } from "lucide-react";
import type { Finding } from "@/lib/shared/types";
import { HealthBadge } from "@/components/ui/HealthBadge";
import { CONFIDENCE_LABEL } from "@/lib/client/adapters";
import { HEALTH_COLOR, severityToUi } from "@/lib/health";
import { SEGMENT_BY_ID, SHARED_SEGMENT_LABEL, segmentFromShared } from "@/lib/segments";
import { fmtDateTimeShort, fmtTimeRange } from "@/lib/format";
import { cn } from "@/lib/cn";
import { verlaufHref } from "./helpers";
import { RULE_BY_ID } from "./rules";
import { checklistKey, useChecklist } from "./use-checklist";

const EVIDENCE_PREVIEW = 6;

/**
 * Befund der Diagnose: Schwere, Abschnitt, Sicherheit, Belege (mit Sprung in den Verlauf)
 * und Empfehlungen als abhakbare Liste. Variante der <FindingCard/> mit allen API-Feldern.
 */
export function FindingItem({ finding: f }: { finding: Finding }) {
  const sev = severityToUi(f.severity);
  const segId = segmentFromShared(f.segment);
  const seg = segId ? SEGMENT_BY_ID[segId] : undefined;
  const rule = RULE_BY_ID[f.id];
  const [showAll, setShowAll] = useState(false);
  const { done, toggle } = useChecklist();
  const listId = useId();
  const evidence = showAll ? f.evidence : f.evidence.slice(0, EVIDENCE_PREVIEW);
  const hidden = f.evidence.length - evidence.length;
  const doneCount = f.recommendations.filter((r) => done.has(checklistKey(f.id, r))).length;

  return (
    <article className="np-panel overflow-hidden" aria-labelledby={`${listId}-title`}>
      <span aria-hidden className="absolute inset-y-0 left-0 w-0.5" style={{ backgroundColor: HEALTH_COLOR[sev] }} />
      <div className="flex flex-col gap-4 p-5 pl-6">
        <header className="flex flex-wrap items-center gap-2">
          <HealthBadge status={sev} />
          {seg && (
            <span className="inline-flex h-6 items-center gap-1.5 rounded-full px-2.5 text-xs text-fg-2 ring-1 ring-inset ring-line">
              <seg.icon aria-hidden className="size-3.5 text-fg-3" strokeWidth={2} />
              {SHARED_SEGMENT_LABEL[f.segment]}
            </span>
          )}
          <span className="inline-flex h-6 items-center rounded-full px-2.5 text-xs text-fg-2 ring-1 ring-inset ring-line">
            Sicherheit: {CONFIDENCE_LABEL[f.confidence]}
          </span>
          <span className="ml-auto flex items-center gap-3 text-xs text-fg-3">
            {rule && <span className="np-num">{rule.code}</span>}
            <span>
              Relevanz <span className="np-num text-fg-2">{Math.round(f.score)}</span>
            </span>
          </span>
        </header>

        <div>
          <h3 id={`${listId}-title`} className="text-lg font-medium text-fg">
            {f.title}
          </h3>
          <p className="mt-1 max-w-prose text-sm text-fg-2">{f.summary}</p>
        </div>

        {f.evidence.length > 0 && (
          <section aria-label="Belege">
            <h4 className="mb-2 flex items-center gap-1.5 text-xs font-medium text-fg-3">
              <FileSearch aria-hidden className="size-3.5" strokeWidth={2} />
              Belege
            </h4>
            <dl className="divide-y divide-line/70 rounded-[10px] bg-sunken/60 px-4 ring-1 ring-inset ring-line">
              {evidence.map((e, i) => (
                <div key={i} className="flex flex-col gap-1 py-2 sm:flex-row sm:items-baseline sm:justify-between sm:gap-6">
                  <dt className="min-w-0 text-sm text-fg-3">{e.label}</dt>
                  <dd className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1 sm:justify-end sm:text-right">
                    <span className="np-num text-sm text-fg">{e.value}</span>
                    {e.ts != null && (
                      <Link
                        href={verlaufHref(e.ts, e.tsEnd)}
                        className="inline-flex items-center gap-1 text-xs text-fiber underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fiber"
                        title="Diesen Zeitraum im Verlauf zeigen"
                      >
                        <Waypoints aria-hidden className="size-3.5" strokeWidth={2} />
                        <span className="np-num">{e.tsEnd != null && e.tsEnd > e.ts ? fmtTimeRange(e.ts, e.tsEnd) : fmtDateTimeShort(e.ts)}</span>
                        <span className="sr-only"> im Verlauf zeigen</span>
                      </Link>
                    )}
                  </dd>
                </div>
              ))}
            </dl>
            {(hidden > 0 || showAll) && f.evidence.length > EVIDENCE_PREVIEW && (
              <button
                type="button"
                onClick={() => setShowAll((v) => !v)}
                aria-expanded={showAll}
                className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-fiber hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fiber"
              >
                <ChevronDown aria-hidden className={cn("size-3.5 transition-transform", showAll && "rotate-180")} strokeWidth={2} />
                {showAll ? "Weniger Belege zeigen" : `Alle ${f.evidence.length} Belege zeigen`}
              </button>
            )}
          </section>
        )}

        {f.recommendations.length > 0 && (
          <section aria-label="Empfehlungen">
            <h4 className="mb-2 flex items-center gap-1.5 text-xs font-medium text-fg-3">
              <Lightbulb aria-hidden className="size-3.5 text-laser" strokeWidth={2} />
              Empfehlungen
              <span className="np-num ml-auto font-normal">
                {doneCount} von {f.recommendations.length} erledigt
              </span>
            </h4>
            <ul className="flex flex-col gap-1">
              {f.recommendations.map((r, i) => {
                const key = checklistKey(f.id, r);
                const checked = done.has(key);
                const id = `${listId}-rec-${i}`;
                return (
                  <li key={i}>
                    <label htmlFor={id} className="flex cursor-pointer gap-2.5 rounded-lg px-2 py-1.5 text-sm hover:bg-raised/60">
                      <input id={id} type="checkbox" checked={checked} onChange={() => toggle(key)} className="peer sr-only" />
                      <span
                        aria-hidden
                        className={cn(
                          "mt-0.5 grid size-4 shrink-0 place-items-center rounded-[4px] ring-1 ring-inset peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-fiber",
                          checked ? "bg-fiber-strong text-fg-invert ring-fiber-strong" : "ring-line-control",
                        )}
                      >
                        {checked && <Check className="size-3" strokeWidth={3} />}
                      </span>
                      <span className={cn(checked ? "text-fg-3 line-through decoration-fg-4" : "text-fg-2")}>{r}</span>
                    </label>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
      </div>
    </article>
  );
}
