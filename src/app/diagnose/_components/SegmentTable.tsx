"use client";

import type { SegmentHealth } from "@/lib/shared/types";
import { HealthBadge } from "@/components/ui/HealthBadge";
import { HEALTH_ICON, HEALTH_LABEL, HEALTH_TEXT, toUiHealth } from "@/lib/health";
import { cn } from "@/lib/cn";
import { SEGMENT_BY_ID, segmentFromShared } from "@/lib/segments";

/** „Abschnitte“: Zustand und Kennzahlen je Abschnitt des Leitungswegs (aus der Diagnose). */
export function SegmentTable({ segments }: { segments: readonly SegmentHealth[] }) {
  return (
    <div className="relative overflow-x-auto rounded-[10px] ring-1 ring-line">
      <table className="w-full min-w-[640px] border-separate border-spacing-0 text-sm">
        <caption className="sr-only">Zustand und Kennzahlen je Abschnitt</caption>
        <thead>
          <tr className="text-xs text-fg-3 font-stretch-semi-condensed">
            <th scope="col" className="h-9 w-[30%] border-b border-line-strong bg-raised px-3 text-left font-medium">
              Abschnitt
            </th>
            <th scope="col" className="h-9 border-b border-line-strong bg-raised px-3 text-left font-medium">
              Kennzahlen
            </th>
          </tr>
        </thead>
        <tbody>
          {segments.map((s) => {
            const segId = segmentFromShared(s.segment);
            const def = segId ? SEGMENT_BY_ID[segId] : undefined;
            const status = toUiHealth(s.status);
            return (
              <tr key={s.segment}>
                <th scope="row" className="border-b border-line px-3 py-3 text-left align-top font-normal">
                  <span className="flex items-center gap-2 font-medium text-fg">
                    {def && <def.icon aria-hidden className="size-4 shrink-0 text-fg-3" strokeWidth={2} />}
                    {s.label}
                  </span>
                  <span className="mt-1.5 block">
                    <HealthBadge status={status} size="sm" />
                  </span>
                  <span className="mt-1.5 block text-xs text-fg-3">{s.summary}</span>
                </th>
                <td className="border-b border-line px-3 py-3 align-top">
                  {s.kpis.length === 0 ? (
                    <span className="text-fg-3">Keine Kennzahlen im Zeitraum.</span>
                  ) : (
                    <dl className="grid grid-cols-1 gap-x-8 gap-y-1.5 2xl:grid-cols-2">
                      {s.kpis.map((k, i) => {
                        const ks = k.status ? toUiHealth(k.status) : null;
                        const Icon = ks ? HEALTH_ICON[ks] : null;
                        return (
                          <div key={i} className="flex min-w-0 items-baseline justify-between gap-3">
                            <dt className="min-w-0 text-fg-3">{k.label}</dt>
                            <dd className="flex shrink-0 items-center gap-1.5 text-right">
                              <span className="np-num text-fg">{k.value}</span>
                              {ks && Icon && (
                                <span className={cn("inline-flex items-center", HEALTH_TEXT[ks])} title={HEALTH_LABEL[ks]}>
                                  <Icon aria-hidden className="size-3.5" strokeWidth={2.25} />
                                  <span className="sr-only">{HEALTH_LABEL[ks]}</span>
                                </span>
                              )}
                            </dd>
                          </div>
                        );
                      })}
                    </dl>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
