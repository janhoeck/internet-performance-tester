"use client";

import { useMemo, useState } from "react";
import { Gauge, Play, PlugZap } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { HealthBadge } from "@/components/ui/HealthBadge";
import { Panel } from "@/components/ui/Panel";
import { InlineProgress } from "@/components/ui/States";
import { toast } from "@/components/ui/Toast";
import { EChart } from "@/components/viz/EChart";
import { control } from "@/lib/client/api";
import type { LiveConnection } from "@/lib/client/live-store";
import { chartTokens } from "@/lib/echarts-theme";
import { fmtBytes, fmtMbitValue, fmtMsValue, NBSP } from "@/lib/format";
import type { AppConfig } from "@/lib/shared/config";
import type { SpeedtestProgress } from "@/lib/shared/types";
import type { LiveTrace } from "./live-trace";
import { speedRunOption } from "./speed-charts";
import { PHASE_LABEL } from "./speed-utils";

interface StartButtonProps {
  running: boolean;
  online: boolean;
  size?: "md" | "lg";
  label?: string;
}

/** "Speedtest starten" – gesperrt, solange ein Test läuft oder die Mess-Engine fehlt. */
export function StartSpeedtestButton({ running, online, size = "md", label = "Speedtest starten" }: StartButtonProps) {
  const [pending, setPending] = useState(false);
  const start = async () => {
    setPending(true);
    const r = await control("speedtest.run");
    setPending(false);
    toast(
      r.ok
        ? { title: "Speedtest gestartet", description: "Der Fortschritt erscheint unten live.", tone: "success" }
        : { title: "Speedtest nicht gestartet", description: r.error ?? "Unbekannter Fehler.", tone: "error" },
    );
  };
  return (
    <Button
      variant="primary"
      size={size}
      icon={Play}
      loading={pending}
      disabled={running || !online}
      onClick={() => void start()}
      title={!online ? "Mess-Engine nicht erreichbar" : running ? "Ein Speedtest läuft bereits" : undefined}
    >
      {running ? "Speedtest läuft …" : label}
    </Button>
  );
}

interface LiveRunPanelProps {
  progress: SpeedtestProgress | null;
  trace: LiveTrace;
  conn: LiveConnection;
  speedConfig: AppConfig["speedtest"];
}

/** Fortschritt des laufenden Tests: Phase, Balken, aktuelle Werte und Live-Minidiagramm. */
export function LiveRunPanel({ progress, trace, conn, speedConfig }: LiveRunPanelProps) {
  const running = progress?.running === true;
  const totalSec = speedConfig.idleSec + speedConfig.downloadSec + speedConfig.uploadSec;
  const option = useMemo(
    () => (trace.points.length > 0 ? speedRunOption(trace.points, { t: chartTokens(), animation: false, totalSec }) : null),
    [trace.points, totalSec],
  );
  const pct = Math.round(Math.max(0, Math.min(1, progress?.progress ?? 0)) * 100);
  const phase = progress?.phase ?? "idle";
  const finished = !running && trace.points.length > 0 && progress != null;

  let body;
  if (!conn.online && !running) {
    body = (
      <p className="flex items-start gap-2 text-sm text-fg-3">
        <PlugZap aria-hidden className="mt-0.5 size-4 shrink-0 text-warn" strokeWidth={2} />
        <span>
          Mess-Engine nicht erreichbar – ein Speedtest kann gerade nicht gestartet werden. Gespeicherte Ergebnisse bleiben unten sichtbar.
        </span>
      </p>
    );
  } else if (!running && !finished) {
    body = (
      <p className="text-sm text-fg-3">
        Kein Test läuft. Ein Test dauert etwa <span className="np-num text-fg-2">{totalSec}{NBSP}s</span>: erst{" "}
        <span className="np-num text-fg-2">{speedConfig.idleSec}{NBSP}s</span> Leerlauf (Grundlatenz), dann{" "}
        <span className="np-num text-fg-2">{speedConfig.downloadSec}{NBSP}s</span> Download mit{" "}
        <span className="np-num text-fg-2">{speedConfig.downloadStreams}</span> Verbindungen und{" "}
        <span className="np-num text-fg-2">{speedConfig.uploadSec}{NBSP}s</span> Upload mit{" "}
        <span className="np-num text-fg-2">{speedConfig.uploadStreams}</span> Verbindungen. Währenddessen misst Netzpuls die Latenz
        unter Last. Andere Downloads im Haushalt verfälschen das Ergebnis.
      </p>
    );
  } else {
    body = (
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          {running ? (
            <InlineProgress>
              Phase: <span className="font-medium text-fg">{PHASE_LABEL[phase]}</span>
            </InlineProgress>
          ) : (
            <HealthBadge
              status={phase === "error" ? "crit" : "good"}
              label={phase === "error" ? `Test fehlgeschlagen${progress?.error ? `: ${progress.error}` : ""}` : "Test abgeschlossen"}
            />
          )}
          <dl className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
            <div className="flex items-baseline gap-2">
              <dt className="text-fg-3">{running ? "Durchsatz" : "Download"}</dt>
              <dd className="np-num text-lg font-semibold text-fg">
                {running ? fmtMbitValue(progress?.currentMbps) : fmtMbitValue(progress?.result?.downMbps)}
                <span className="ml-1 text-xs font-normal text-fg-3">Mbit/s</span>
              </dd>
            </div>
            <div className="flex items-baseline gap-2">
              <dt className="text-fg-3">{running ? "Latenz" : "Upload"}</dt>
              <dd className="np-num text-lg font-semibold text-fg">
                {running ? fmtMsValue(progress?.currentRtt) : fmtMbitValue(progress?.result?.upMbps)}
                <span className="ml-1 text-xs font-normal text-fg-3">{running ? "ms" : "Mbit/s"}</span>
              </dd>
            </div>
            {!running && progress?.result?.grade && (
              <div className="flex items-baseline gap-2">
                <dt className="text-fg-3">Bufferbloat</dt>
                <dd className="np-num text-lg font-semibold text-fg">{progress.result.grade}</dd>
              </div>
            )}
          </dl>
        </div>
        <div>
          <div
            role="progressbar"
            aria-label="Fortschritt des Speedtests"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={running ? pct : 100}
            className="h-2 w-full overflow-hidden rounded-full bg-raised ring-1 ring-inset ring-line"
          >
            <div className="h-full rounded-full bg-fiber transition-[width] duration-300" style={{ width: `${running ? pct : 100}%` }} />
          </div>
          <div className="mt-1.5 flex justify-between text-2xs text-fg-3">
            <span>Leerlauf</span>
            <span>Download</span>
            <span>Upload</span>
            <span className="np-num">{running ? `${pct}${NBSP}%` : "fertig"}</span>
          </div>
        </div>
        {option && <EChart option={option} ariaLabel="Laufender Speedtest: Durchsatz und Latenz seit Teststart" height={220} />}
        {finished && (
          <p className="text-xs text-fg-3">
            Mitschnitt aus dem Live-Stream. Das gespeicherte Ergebnis mit allen Messpunkten erscheint unten unter „Letztes Ergebnis“.
          </p>
        )}
      </div>
    );
  }

  return (
    <Panel
      title={
        <span className="flex items-center gap-2">
          <Gauge aria-hidden className="size-4.5 text-fiber" strokeWidth={2} />
          Live-Fortschritt
        </span>
      }
      description={running ? "Werte aus der laufenden Messung, etwa viermal pro Sekunde." : "Startet ein Test, erscheinen hier Phase, Durchsatz und Latenz live."}
    >
      {body}
      {progress?.result && !running && progress.result.bytesDown + progress.result.bytesUp > 0 && (
        <p className="mt-3 text-xs text-fg-3">
          Übertragen: <span className="np-num text-fg-2">{fmtBytes(progress.result.bytesDown + progress.result.bytesUp)}</span>
        </p>
      )}
    </Panel>
  );
}
