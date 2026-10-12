"use client";

import { useMemo } from "react";
import { Activity, LoaderCircle, PlugZap } from "lucide-react";
import { bandThresholds, liveLatencyOption, type ThresholdSpec } from "@/lib/client/charts";
import { useLiveConnection, useLiveEvents, useLiveSampleMap, useSession } from "@/lib/client/live-store";
import { commonSegment, seriesTargets, useTargets } from "@/lib/client/targets";
import { useNow } from "@/lib/use-now";
import { ChartSkeleton, EmptyState } from "@/components/ui/States";
import { EChart } from "./EChart";

const REPLACE = ["series"];
const DEFAULT_TARGETS = ["gw", "isp6", "cf4"] as const;

export interface LiveLatencyChartProps {
  /** Ziel-IDs (Standard: Router, Kopfstation, 1.1.1.1) */
  targetIds?: readonly string[];
  /** sichtbares Fenster in ms (Standard 5 min, höchstens 15 min) */
  windowMs?: number;
  /** "auto" = Latenzschwellen aus der Konfiguration, wenn alle Ziele im selben Abschnitt liegen; false = keine */
  thresholds?: readonly ThresholdSpec[] | "auto" | false;
  /** Live-Ereignisse (Link weg, Notizen …) einzeichnen */
  showEvents?: boolean;
  height?: number;
  yMax?: number;
  ariaLabel?: string;
}

/**
 * Live-Latenz aus den Ringpuffern des Live-Streams: höchstens 1 Update/s, keine Animation,
 * verlorene Pings = Lücke. Ohne Langzeittest gibt es keine Pings -> Leerzustand mit Hinweis.
 */
export function LiveLatencyChart({
  targetIds = DEFAULT_TARGETS,
  windowMs = 5 * 60_000,
  thresholds = "auto",
  showEvents = true,
  height = 260,
  yMax,
  ariaLabel,
}: LiveLatencyChartProps) {
  const samples = useLiveSampleMap();
  const events = useLiveEvents();
  const conn = useLiveConnection();
  const session = useSession();
  const sessionRunning = session != null && session.status === "running" && session.endedAt == null;
  const now = useNow(1000);
  const { targets, byId, config } = useTargets();
  const idsKey = targetIds.join(",");
  const series = useMemo(() => seriesTargets(idsKey ? idsKey.split(",") : [], targets), [idsKey, targets]);
  const segment = commonSegment(targetIds, byId);
  const latencyBand = segment ? config?.thresholds.latency[segment] : undefined;
  const thresholdSpecs = useMemo(
    () => (thresholds === false ? [] : thresholds === "auto" ? bandThresholds(latencyBand) : thresholds),
    [thresholds, latencyBand],
  );

  const hasAny = series.some((s) => (samples[s.id]?.length ?? 0) > 0);
  const option = useMemo(
    () =>
      now == null
        ? null
        : liveLatencyOption(samples, { targets: series, now, windowMs, thresholds: thresholdSpecs, events: showEvents ? events : null, yMax }),
    [samples, series, now, windowMs, thresholdSpecs, events, showEvents, yMax],
  );

  if (now == null || (conn.status === "idle" || conn.status === "connecting")) return <ChartSkeleton height={height} />;
  if (!hasAny || option == null) {
    return (
      <div className="grid place-items-center" style={{ height }}>
        {conn.online && sessionRunning ? (
          <EmptyState icon={LoaderCircle} title="Warte auf Messwerte …">
            Der Langzeittest läuft – die ersten Live-Pings erscheinen in wenigen Sekunden.
          </EmptyState>
        ) : conn.online ? (
          <EmptyState icon={Activity} title="Noch keine Live-Werte">
            Live-Pings laufen nur während eines Langzeittests. Starte oben einen Test – die Linien erscheinen nach wenigen Sekunden.
          </EmptyState>
        ) : (
          <EmptyState icon={PlugZap} title="Mess-Engine nicht erreichbar">
            Läuft die Mess-Engine? (Start: npm run dev bzw. npm run start:all) Die Verbindung wird automatisch wiederhergestellt.
          </EmptyState>
        )}
      </div>
    );
  }
  const label = ariaLabel ?? `Live-Latenz der letzten ${Math.round(windowMs / 60_000)} Minuten (${series.map((s) => s.name).join(", ")})`;
  return <EChart option={option} ariaLabel={label} height={height} replaceMerge={REPLACE} />;
}
