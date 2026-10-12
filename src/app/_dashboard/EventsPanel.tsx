"use client";

import { useMemo } from "react";
import Link from "next/link";
import { ChevronRight, Inbox } from "lucide-react";
import type { EventsResponse } from "@/lib/shared/api-types";
import { useLiveEvents } from "@/lib/client/live-store";
import { shortTargetName, useTargets } from "@/lib/client/targets";
import type { UseApiResult } from "@/lib/client/use-api";
import { Panel } from "@/components/ui/Panel";
import { DataState } from "@/components/ui/States";
import { EventStrip } from "@/components/viz/EventStrip";
import { EventTimeline } from "@/components/viz/EventTimeline";
import { mergeEvents, toDashboardTimeline } from "./events";
import { DAY_MS } from "./use-dashboard";

/** Einträge in der kompakten Zeitleiste */
const TIMELINE_MAX = 8;

const isEmpty = (d: EventsResponse) => d.events.length === 0;

export function EventsPanel({ result, now }: { result: UseApiResult<EventsResponse>; now: number | null }) {
  const live = useLiveEvents();
  const { targets } = useTargets();
  const from = now != null ? now - DAY_MS : null;

  const timeline = useMemo(() => {
    if (from == null || !result.data) return null;
    const merged = mergeEvents(result.data.events, live, from);
    return toDashboardTimeline(merged, (id) => shortTargetName(id, targets));
  }, [result.data, live, from, targets]);

  return (
    <Panel
      title="Ereignisse"
      description="Letzte 24 Stunden, live ergänzt"
      actions={
        <Link href="/ereignisse" className="inline-flex items-center gap-1 text-sm text-fiber underline-offset-4 hover:underline">
          Alle Ereignisse
          <ChevronRight aria-hidden className="size-4" strokeWidth={2} />
        </Link>
      }
    >
      <DataState
        result={result}
        isEmpty={(d) => isEmpty(d) && live.length === 0}
        emptyIcon={Inbox}
        emptyTitle="Keine Ereignisse in den letzten 24 Stunden"
        emptyText="Link-Abbrüche, Ausfälle und Ping-Spitzen erscheinen hier, sobald sie auftreten."
        height={360}
      >
        {() =>
          timeline != null && now != null && from != null ? (
            <div className="flex flex-col gap-4">
              <EventStrip events={timeline} from={new Date(from).toISOString()} to={new Date(now).toISOString()} />
              <div className="max-h-[420px] overflow-y-auto pr-1">
                <EventTimeline events={timeline.slice(0, TIMELINE_MAX)} now={new Date(now).toISOString()} />
              </div>
              {timeline.length > TIMELINE_MAX && (
                <p className="text-xs text-fg-3">
                  <span className="np-num">{timeline.length - TIMELINE_MAX}</span> weitere Einträge auf der Seite „Ereignisse“.
                </p>
              )}
            </div>
          ) : null
        }
      </DataState>
    </Panel>
  );
}
