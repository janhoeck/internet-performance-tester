"use client";

import { useState } from "react";
import { ChevronRight } from "lucide-react";
import type { NetEvent, TargetConfig } from "@/lib/shared/types";
import { eventKey, toTimelineEvent } from "@/lib/client/adapters";
import { cn } from "@/lib/cn";
import { dayKey, fmtDayLong, fmtDuration, fmtTime } from "@/lib/format";
import { HEALTH_ICON, HEALTH_LABEL, HEALTH_TEXT } from "@/lib/health";
import { SEGMENT_BY_ID } from "@/lib/segments";
import { eventDetailRows } from "./event-details";

interface EventListProps {
  events: readonly NetEvent[];
  targets: readonly TargetConfig[];
  /** "jetzt" (epoch ms, aus useNow) für "Heute"/"Gestern" */
  now: number | null;
  /** Abstand der klebenden Tagesüberschrift (Höhe der Statusleiste) */
  stickyOffset?: number;
}

function dayHeading(key: string, now: number | null): string {
  const long = fmtDayLong(`${key}T12:00:00Z`);
  if (now != null) {
    if (key === dayKey(now)) return `Heute, ${long}`;
    if (key === dayKey(now - 86_400_000)) return `Gestern, ${long}`;
  }
  return long;
}

/**
 * Ereignis-Zeitleiste wie <EventTimeline/>, aber jeder Eintrag lässt sich aufklappen und zeigt
 * die Details des Ereignistyps (Ursache, Dauer, Wiederaufbau …). Neueste zuerst, je Tag gruppiert.
 */
export function EventList({ events, targets, now, stickyOffset = 56 }: EventListProps) {
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const sorted = [...events].sort((a, b) => b.ts - a.ts);
  const groups = new Map<string, NetEvent[]>();
  for (const e of sorted) {
    const k = dayKey(e.ts);
    const list = groups.get(k);
    if (list) list.push(e);
    else groups.set(k, [e]);
  }

  return (
    <div className="flex flex-col gap-6">
      {[...groups.entries()].map(([key, list]) => (
        <section key={key} aria-label={dayHeading(key, now)}>
          <h3 className="sticky z-10 mb-1 bg-panel py-1.5 font-sans text-xs font-medium text-fg-3" style={{ top: stickyOffset }}>
            {dayHeading(key, now)}
            <span className="np-num ml-2 text-fg-4">{list.length}</span>
          </h3>
          <ol className="flex flex-col">
            {list.map((e) => {
              const t = toTimelineEvent(e);
              const id = eventKey(e);
              const expanded = open.has(id);
              const Icon = HEALTH_ICON[t.severity];
              const seg = t.segment ? SEGMENT_BY_ID[t.segment] : undefined;
              const panelId = `np-ev-${id}`;
              return (
                <li key={id} className="group grid grid-cols-[4.25rem_1.5rem_minmax(0,1fr)] gap-x-2 sm:grid-cols-[4.75rem_1.5rem_minmax(0,1fr)] sm:gap-x-3">
                  <time dateTime={t.at} className="np-num pt-2.5 text-xs text-fg-3">
                    {fmtTime(e.ts)}
                  </time>
                  <span className="relative flex justify-center">
                    <span aria-hidden className="absolute bottom-0 top-0 w-px bg-line group-first:top-4 group-last:bottom-auto group-last:h-4" />
                    <span className={cn("relative mt-2 grid size-6 place-items-center rounded-full bg-panel ring-1 ring-line", HEALTH_TEXT[t.severity])}>
                      <Icon aria-hidden className="size-3.5" strokeWidth={2.25} />
                      <span className="sr-only">{HEALTH_LABEL[t.severity]}</span>
                    </span>
                  </span>
                  <div className="min-w-0 py-1">
                    <button
                      type="button"
                      aria-expanded={expanded}
                      aria-controls={panelId}
                      onClick={() => toggle(id)}
                      className="group/btn -mx-2 flex w-[calc(100%+1rem)] min-w-0 items-start gap-2 rounded-md px-2 py-1 text-left hover:bg-raised/60 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-fiber"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                          <span className="text-sm font-medium text-fg">{t.title}</span>
                          {t.durationS != null && (
                            <span className="np-num rounded-md bg-raised px-1.5 text-2xs leading-5 text-fg-2 ring-1 ring-inset ring-line">{fmtDuration(t.durationS)}</span>
                          )}
                          {seg && (
                            <span className="inline-flex items-center gap-1.5 rounded-full px-2 text-2xs leading-5 text-fg-3 ring-1 ring-inset ring-line">
                              <span aria-hidden className={cn("size-1.5 rounded-full", seg.colorClass)} />
                              {seg.label}
                            </span>
                          )}
                        </span>
                        {t.detail && <span className="mt-0.5 block text-xs text-fg-3">{t.detail}</span>}
                      </span>
                      <ChevronRight
                        aria-hidden
                        className={cn("mt-0.5 size-4 shrink-0 text-fg-4 transition-transform group-hover/btn:text-fg-2", expanded && "rotate-90")}
                        strokeWidth={2}
                      />
                      <span className="sr-only">{expanded ? "Details ausblenden" : "Details anzeigen"}</span>
                    </button>
                    {expanded && (
                      <dl id={panelId} className="mb-2 mt-1 grid grid-cols-1 gap-x-4 rounded-[10px] bg-sunken/60 px-3 py-2 ring-1 ring-inset ring-line sm:grid-cols-[minmax(9rem,auto)_minmax(0,1fr)]">
                        {eventDetailRows(e, targets).map((r, i) => (
                          <div key={`${r.label}-${i}`} className="contents">
                            <dt className="pt-1.5 text-xs text-fg-3 sm:pb-1.5">{r.label}</dt>
                            <dd className={cn("break-words pb-1.5 text-sm text-fg sm:pt-1.5", r.numeric && "np-num")}>{r.value}</dd>
                          </div>
                        ))}
                      </dl>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
        </section>
      ))}
    </div>
  );
}
