"use client";

import { useState } from "react";
import { CircleStop, Flag, Gauge, LoaderCircle, Menu, PauseCircle, Play, PlugZap } from "lucide-react";
import type { TestSession } from "@/lib/shared/types";
import { addNote, errorMessage } from "@/lib/client/api";
import { pushLiveEvent, useLive, type LiveState } from "@/lib/client/live-store";
import { revalidateApi } from "@/lib/client/use-api";
import { useOverallHealth } from "@/lib/client/segment-health";
import { useTargets } from "@/lib/client/targets";
import { cn } from "@/lib/cn";
import { fmtDateTimeShort, fmtDuration, fmtRelative, fmtRuntime, fmtTime } from "@/lib/format";
import type { Health } from "@/lib/health";
import { useNow } from "@/lib/use-now";
import { Button } from "@/components/ui/Button";
import { HealthBadge } from "@/components/ui/HealthBadge";
import { toast } from "@/components/ui/Toast";
import { BrandMark } from "./Brand";
import { SessionStartDialog, SessionStopDialog } from "./SessionDialogs";
import { useShell } from "./ShellProvider";
import { NAV_TOGGLE_ID, SIDEBAR_ID } from "./Sidebar";

/**
 * running    – Langzeittest läuft ("Mess-Engine läuft")
 * ready      – Engine erreichbar, kein Test ("Mess-Engine bereit")
 * offline    – Engine bzw. Live-Stream nicht erreichbar
 * connecting – erster Verbindungsaufbau (auch Server-Render)
 */
export type EngineState = "running" | "ready" | "offline" | "connecting";

const ENGINE_TEXT: Record<EngineState, string> = {
  running: "Mess-Engine läuft",
  ready: "Mess-Engine bereit",
  offline: "Mess-Engine nicht erreichbar",
  connecting: "Mess-Engine wird verbunden …",
};
/** Kurzform für schmale Bildschirme (< 640 px) */
const ENGINE_SHORT: Record<EngineState, string> = {
  running: "Läuft",
  ready: "Bereit",
  offline: "Nicht erreichbar",
  connecting: "Verbinde …",
};

export interface StatusBarViewProps {
  engine: EngineState;
  session: TestSession | null;
  /** aktuelle Zeit (useNow) – null beim Server-Render */
  now: number | null;
  /** nächster geplanter Speedtest (status.modules → speedtest.nextRunTs) */
  nextSpeedtestTs?: number | null;
  speedtestRunning?: boolean;
  /**
   * Geplante Speedtests werden gerade übersprungen – statt "Nächster Speedtest" anzeigen,
   * z. B. "Ruhezeit bis 23:00" oder "Spiel läuft" (speedtestPauseReason()).
   */
  speedtestPausedReason?: string | null;
  /** Gesamtzustand (useOverallHealth) */
  health: Health;
  markingLag?: boolean;
  onStart?: () => void;
  onStop?: () => void;
  onMarkLag?: () => void;
  className?: string;
}

/** Darstellung der Statusleiste (ohne Datenanbindung; Vorschau: /dev/ui). Live: <LiveStatusBar/>. */
export function StatusBarView({
  engine,
  session,
  now,
  nextSpeedtestTs,
  speedtestRunning = false,
  speedtestPausedReason = null,
  health,
  markingLag = false,
  onStart,
  onStop,
  onMarkLag,
  className,
}: StatusBarViewProps) {
  const { navOpen, setNavOpen } = useShell();
  const running = engine === "running" && session != null;
  const runtime = running && now != null ? fmtRuntime(now - session.startedAt) : null;
  const remainingS = running && now != null && session.plannedEndAt != null ? (session.plannedEndAt - now) / 1000 : null;
  const showNext = nextSpeedtestTs != null && now != null && nextSpeedtestTs > now - 60_000;
  const actionsDisabled = engine === "offline" || engine === "connecting";

  return (
    <header
      data-slot="statusbar"
      className={cn(
        "sticky top-0 z-20 flex h-14 shrink-0 items-center gap-2 border-b border-line bg-(--np-glass-strong) px-4 sm:gap-3 sm:px-6 md:gap-4 xl:px-8",
        className,
      )}
    >
      <button
        type="button"
        id={NAV_TOGGLE_ID}
        onClick={() => setNavOpen(!navOpen)}
        aria-label={navOpen ? "Navigation schließen" : "Navigation öffnen"}
        aria-expanded={navOpen}
        aria-controls={SIDEBAR_ID}
        className="-ml-1.5 grid size-9 shrink-0 place-items-center rounded-lg text-fg-2 hover:bg-raised hover:text-fg md:hidden"
      >
        <Menu aria-hidden className="size-5" />
      </button>
      <BrandMark className="hidden size-7 sm:block md:hidden" />

      {/* Engine-Zustand (Statuswechsel höflich ansagen) */}
      <div className="flex min-w-0 items-center gap-2.5" role="status" aria-live="polite">
        {engine === "running" && <span aria-hidden className="np-live-dot np-anim shrink-0 text-good" />}
        {engine === "ready" && <span aria-hidden className="inline-block size-2 shrink-0 rounded-full bg-fiber" />}
        {engine === "offline" && <PlugZap aria-hidden className="size-4 shrink-0 text-crit" strokeWidth={2.25} />}
        {engine === "connecting" && <LoaderCircle aria-hidden className="size-4 shrink-0 animate-spin text-fg-3" strokeWidth={2.25} />}
        <span className="truncate text-sm text-fg-2">
          <span className="sm:hidden" aria-hidden>
            {ENGINE_SHORT[engine]}
          </span>
          <span className="max-sm:sr-only">{ENGINE_TEXT[engine]}</span>
        </span>
      </div>

      {/* Laufzeit des Langzeittests */}
      <div
        className="hidden min-w-0 items-baseline gap-2 border-l border-line pl-4 md:flex"
        title={running && session.plannedEndAt != null ? `Geplantes Ende: ${fmtDateTimeShort(session.plannedEndAt)}` : undefined}
      >
        <span className="shrink-0 text-xs text-fg-3">Langzeittest</span>
        {runtime ? (
          <>
            <span className="np-num text-sm text-fg">{runtime}</span>
            {remainingS != null && remainingS > 0 && <span className="np-num hidden text-xs text-fg-3 xl:inline">noch {fmtDuration(remainingS)}</span>}
            {session?.label && <span className="hidden max-w-48 truncate text-xs text-fg-3 2xl:inline">„{session.label}“</span>}
          </>
        ) : (
          <span className="text-sm text-fg-3">{engine === "ready" ? "nicht gestartet" : "–"}</span>
        )}
      </div>

      {/* Nächster Speedtest / laufender Speedtest */}
      {speedtestRunning ? (
        <div className="hidden items-center gap-2 border-l border-line pl-4 xl:flex">
          <Gauge aria-hidden className="size-3.5 text-fiber" strokeWidth={2.25} />
          <span className="text-sm text-fg-2">Speedtest läuft …</span>
        </div>
      ) : speedtestPausedReason && nextSpeedtestTs != null ? (
        <div
          className="hidden min-w-0 items-center gap-2 border-l border-line pl-4 xl:flex"
          title={`Geplante Speedtests werden übersprungen: ${speedtestPausedReason}`}
        >
          <PauseCircle aria-hidden className="size-3.5 shrink-0 text-fg-3" strokeWidth={2.25} />
          <span className="truncate text-sm text-fg-2">
            Speedtest pausiert <span className="text-fg-3">({speedtestPausedReason})</span>
          </span>
        </div>
      ) : (
        showNext && (
          <div className="hidden items-baseline gap-2 border-l border-line pl-4 xl:flex" title={fmtDateTimeShort(nextSpeedtestTs)}>
            <span className="text-xs text-fg-3">Nächster Speedtest</span>
            <span className="np-num text-sm text-fg-2">{fmtRelative(nextSpeedtestTs, now)}</span>
          </div>
        )
      )}

      <div className="ml-auto flex shrink-0 items-center gap-2 sm:gap-3">
        <span className="sr-only text-xs text-fg-3 lg:not-sr-only">Gesamtzustand</span>
        <HealthBadge status={health} />
        {onMarkLag && (
          <Button
            size="sm"
            variant="secondary"
            icon={Flag}
            onClick={onMarkLag}
            loading={markingLag}
            aria-label="Lag markieren"
            title="Lag markieren: Zeitpunkt merken, um ihn mit den Messwerten abzugleichen"
          >
            <span className="hidden 2xl:inline">Lag markieren</span>
          </Button>
        )}
        {running
          ? onStop && (
              <Button size="sm" variant="secondary" icon={CircleStop} onClick={onStop} aria-label="Langzeittest beenden" title="Langzeittest beenden">
                <span className="hidden 2xl:inline">Langzeittest beenden</span>
              </Button>
            )
          : onStart && (
              <Button
                size="sm"
                variant="primary"
                icon={Play}
                onClick={onStart}
                disabled={actionsDisabled}
                aria-label="Langzeittest starten"
                title={actionsDisabled ? "Mess-Engine nicht erreichbar" : "Langzeittest starten"}
              >
                <span className="hidden 2xl:inline">Langzeittest starten</span>
              </Button>
            )}
      </div>
    </header>
  );
}

/* -------------------------------------------------------------------------- */
/* Live-Anbindung                                                              */
/* -------------------------------------------------------------------------- */

interface BarSource {
  engine: EngineState;
  session: TestSession | null;
  nextSpeedtestTs: number | null;
  speedtestRunning: boolean;
  gaming: boolean;
}

const hh = (h: number): string => `${String(h % 24).padStart(2, "0")}:00`;

/** Lokale Stunde in [from, to) – über Mitternacht, wenn from > to; from === to = keine Ruhezeit (wie die Engine). */
function inQuietHours(hour: number, qh: { from: number; to: number } | null | undefined): boolean {
  if (!qh || qh.from === qh.to) return false;
  if (qh.from < qh.to) return hour >= qh.from && hour < qh.to;
  return hour >= qh.from || hour < qh.to;
}

/**
 * Warum geplante Speedtests gerade (bzw. zum nächsten Termin) übersprungen werden, oder null.
 * Spiegelt die Regeln der Engine (engine/tasks/speed-schedule.ts: Spiel läuft, Ruhezeit).
 */
export function speedtestPauseReason(opts: {
  now: number | null;
  nextRunTs: number | null;
  gaming: boolean;
  quietHours: { from: number; to: number } | null | undefined;
}): string | null {
  if (opts.gaming) return "Spiel läuft";
  if (opts.now == null || !opts.quietHours) return null;
  const at = Math.max(opts.now, opts.nextRunTs ?? opts.now);
  if (inQuietHours(new Date(at).getHours(), opts.quietHours)) return `Ruhezeit bis ${hh(opts.quietHours.to)}`;
  return null;
}

function engineState(s: LiveState): EngineState {
  const st = s.conn.status;
  if (!s.conn.online) return st === "idle" || st === "connecting" ? "connecting" : "offline";
  return s.session && s.session.status === "running" && s.session.endedAt == null ? "running" : "ready";
}

const selectBar = (s: LiveState): BarSource => {
  const speedMod = s.status?.modules?.find((m) => m.name === "speedtest");
  return {
    engine: engineState(s),
    session: s.session,
    nextSpeedtestTs: speedMod?.enabled !== false ? (speedMod?.nextRunTs ?? null) : null,
    speedtestRunning: s.speedtest?.running === true,
    gaming: s.client?.gaming === true,
  };
};

const sameBar = (a: BarSource, b: BarSource): boolean =>
  a.engine === b.engine && a.session === b.session && a.nextSpeedtestTs === b.nextSpeedtestTs && a.speedtestRunning === b.speedtestRunning && a.gaming === b.gaming;

/** Statusleiste mit Live-Daten, Start/Stopp-Dialogen und "Lag markieren". Steckt im AppShell. */
export function LiveStatusBar() {
  const bar = useLive(selectBar, { isEqual: sameBar });
  const health = useOverallHealth();
  const now = useNow(1000);
  const { config } = useTargets();
  const [dialog, setDialog] = useState<"start" | "stop" | null>(null);
  const [marking, setMarking] = useState(false);

  const markLag = async () => {
    if (marking) return;
    setMarking(true);
    const ts = Date.now(); // im Handler, nicht im Render
    try {
      const ev = await addNote("Lag bemerkt", { ts, details: { kind: "lag", origin: "lag", source: "statusbar" } });
      if (ev) pushLiveEvent(ev);
      revalidateApi("/api/events");
      revalidateApi("/api/diagnosis");
      toast({ title: `Lag markiert – ${fmtTime(ts)}`, description: "Die Markierung erscheint in Verlauf, Ereignissen und Diagnose." });
    } catch (e) {
      toast({ title: "Lag konnte nicht markiert werden", description: errorMessage(e), tone: "error" });
    } finally {
      setMarking(false);
    }
  };

  return (
    <>
      <StatusBarView
        engine={bar.engine}
        session={bar.session}
        now={now}
        nextSpeedtestTs={bar.nextSpeedtestTs}
        speedtestRunning={bar.speedtestRunning}
        speedtestPausedReason={speedtestPauseReason({
          now,
          nextRunTs: bar.nextSpeedtestTs,
          gaming: bar.gaming,
          quietHours: config?.schedules?.speedtestQuietHours,
        })}
        health={health}
        markingLag={marking}
        onMarkLag={markLag}
        onStart={() => setDialog("start")}
        onStop={() => setDialog("stop")}
      />
      {dialog === "start" && <SessionStartDialog onClose={() => setDialog(null)} preventSleep={config?.session.preventSleep ?? true} />}
      {dialog === "stop" && <SessionStopDialog onClose={() => setDialog(null)} session={bar.session} now={now} />}
    </>
  );
}
