"use client";

import { PlugZap, RefreshCw } from "lucide-react";
import { reconnectLive, useLiveConnection } from "@/lib/client/live-store";
import { fmtTime } from "@/lib/format";

/**
 * Hinweis unter der Statusleiste, solange die Mess-Engine (oder der Live-Stream) nicht
 * erreichbar ist. Seiten zeigen weiter die gespeicherten Daten aus der Datenbank.
 */
export function EngineNotice() {
  const conn = useLiveConnection();
  if (conn.online || conn.status === "idle" || conn.status === "connecting") return null;
  const routeMissing = conn.status === "unavailable";
  return (
    <div role="alert" className="np-no-print border-b border-warn/30 bg-warn/10">
      <div className="mx-auto flex w-full max-w-[1680px] flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5 sm:px-6 xl:px-8">
        <PlugZap aria-hidden className="size-4 shrink-0 text-warn" strokeWidth={2.25} />
        <p className="min-w-0 flex-1 text-sm text-fg-2">
          <span className="font-medium text-fg">Mess-Engine nicht erreichbar.</span>{" "}
          {routeMissing ? "Der Live-Stream antwortet nicht. " : ""}Läuft die Mess-Engine? (Start:{" "}
          <code className="text-fg">npm run dev</code> bzw. <code className="text-fg">npm run start:all</code>) Gespeicherte Messwerte bleiben
          sichtbar.
          {conn.since != null && <span className="np-num ml-2 text-xs text-fg-3">seit {fmtTime(conn.since)}</span>}
        </p>
        <button
          type="button"
          onClick={reconnectLive}
          className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md bg-raised px-2.5 text-xs font-medium text-fg ring-1 ring-inset ring-line-strong hover:bg-overlay focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fiber"
        >
          <RefreshCw aria-hidden className="size-3.5" strokeWidth={2} />
          Erneut verbinden
        </button>
      </div>
    </div>
  );
}
