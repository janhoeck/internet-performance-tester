"use client";

import { useMemo } from "react";
import { ChevronDown } from "lucide-react";
import type { SessionsResponse } from "@/lib/shared/api-types";
import type { TestSession } from "@/lib/shared/types";
import { isRunningSession } from "@/lib/shared/sessions";
import { useApi } from "@/lib/client/use-api";
import type { TimeRange } from "@/lib/client/use-time-range";
import { sessionName } from "@/lib/client/sessions";
import { fmtDate, fmtDurationMs } from "@/lib/format";
import { cn } from "@/lib/cn";

interface SessionPickerProps {
  /** Ergebnis von useTimeRange(); die Auswahl erscheint nur bei Zeitraum „Langzeittest“ */
  range: TimeRange;
  className?: string;
}

function optionText(s: TestSession): string {
  const running = isRunningSession(s);
  const end = s.endedAt ?? s.plannedEndAt;
  const dur = running ? "läuft" : end != null ? fmtDurationMs(end - s.startedAt) : "";
  return `${sessionName(s)} – ${fmtDate(s.startedAt)}${dur ? `, ${dur}` : ""}`;
}

/**
 * Auswahl des Langzeittests (nach Namen) neben dem <TimeRangePicker>. Ohne Auswahl gilt der
 * laufende bzw. zuletzt beendete Test; die Wahl steht in der URL (`?range=session&session=<id>`).
 */
export function SessionPicker({ range, className }: SessionPickerProps) {
  const enabled = range.preset === "session";
  const sessions = useApi<SessionsResponse>("/api/sessions", { refreshMs: 60_000, enabled });
  const list = useMemo(() => {
    const items = [...(sessions.data?.items ?? [])];
    const active = sessions.data?.active;
    if (active && !items.some((s) => s.id === active.id)) items.push(active);
    return items.sort((a, b) => b.startedAt - a.startedAt);
  }, [sessions.data]);

  if (!enabled || list.length === 0) return null;
  const value = range.session?.id ?? "";
  return (
    <span className={cn("relative inline-block max-w-full", className)}>
      <select
        aria-label="Langzeittest auswählen"
        title={range.session ? optionText(range.session) : undefined}
        value={value}
        onChange={(e) => range.setSession(Number(e.target.value))}
        className={cn(
          "h-8 w-full max-w-[22rem] appearance-none truncate rounded-lg bg-sunken pl-2.5 pr-8 text-xs font-medium text-fg ring-1 ring-inset ring-line-control",
          "transition-colors hover:bg-raised focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-fiber",
        )}
      >
        {value === "" && <option value="">Langzeittest wählen …</option>}
        {list.map((s) => (
          <option key={s.id} value={s.id}>
            {optionText(s)}
          </option>
        ))}
      </select>
      <ChevronDown aria-hidden className="pointer-events-none absolute right-2.5 top-1/2 size-3.5 -translate-y-1/2 text-fg-3" strokeWidth={2} />
    </span>
  );
}
