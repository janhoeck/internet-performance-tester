"use client";

import { Gauge } from "lucide-react";
import type {
  ClientResponse,
  DiagnosisResponse,
  EventsResponse,
  RouterResponse,
  SecondsResponse,
  SpeedtestsResponse,
  StatsResponse,
} from "@/lib/shared/api-types";
import { control, qs } from "@/lib/client/api";
import { useSpeedtestProgress } from "@/lib/client/live-store";
import { useApi } from "@/lib/client/use-api";
import { useNow } from "@/lib/use-now";
import { Button } from "@/components/ui/Button";
import { PageHeader } from "@/components/ui/PageHeader";
import { Panel } from "@/components/ui/Panel";
import { toast } from "@/components/ui/Toast";
import { LiveLatencyChart } from "@/components/viz/LiveLatencyChart";
import { LiveTopology } from "@/components/viz/LiveTopology";
import { EventsPanel } from "./EventsPanel";
import { FindingsPanel } from "./FindingsPanel";
import { KpiGrid } from "./KpiGrid";
import { NoSessionPanel } from "./NoSessionPanel";
import { SecondsPanel } from "./SecondsPanel";
import { VerdictBanner } from "./VerdictBanner";
import { CHART_IDS, DAY_MS, HOUR_MS, INTERNET_IDS, useLiveMode } from "./use-dashboard";

const MINUTE = 60_000;
const FIVE_MIN = 5 * MINUTE;

function SpeedtestButton({ disabled }: { disabled: boolean }) {
  const progress = useSpeedtestProgress();
  const running = progress?.running === true;
  const start = async () => {
    const r = await control("speedtest.run");
    toast(r.ok ? { title: "Speedtest gestartet", description: "Ergebnis in etwa einer Minute auf der Seite „Speedtest“." } : { title: "Speedtest nicht gestartet", description: r.error, tone: "error" });
  };
  return (
    <Button
      size="sm"
      icon={Gauge}
      onClick={start}
      loading={running}
      disabled={disabled || running}
      title={disabled ? "Mess-Engine nicht erreichbar" : running ? "Speedtest läuft" : undefined}
    >
      {running ? "Speedtest läuft …" : "Speedtest starten"}
    </Button>
  );
}

/** Live-Dashboard: Urteil, Leitungsweg, Kennzahlen, Live-Latenz, Ereignisse, gestörte Sekunden, Befunde. */
export function Dashboard() {
  const mode = useLiveMode();
  // Zeitfenster minutengenau (stabile URLs, ein Abruf je Minute), Diagnose alle 5 min
  const now = useNow(MINUTE);
  const now5 = useNow(FIVE_MIN);
  const dayFrom = now != null ? now - DAY_MS : null;

  const diagnosis = useApi<DiagnosisResponse>(now5 != null ? `/api/diagnosis${qs({ from: now5 - DAY_MS, to: now5 })}` : null, { refreshMs: FIVE_MIN });
  const seconds24 = useApi<SecondsResponse>(now != null ? `/api/seconds${qs({ from: dayFrom, to: now, step: HOUR_MS })}` : null);
  const seconds6 = useApi<SecondsResponse>(now != null ? `/api/seconds${qs({ from: now - 6 * HOUR_MS, to: now, step: 15 * MINUTE })}` : null);
  const stats24 = useApi<StatsResponse>(now != null ? `/api/stats${qs({ from: dayFrom, to: now, targets: [...INTERNET_IDS] })}` : null);
  const client = useApi<ClientResponse>(now != null ? `/api/client${qs({ from: dayFrom, to: now })}` : null);
  const router = useApi<RouterResponse>(now5 != null ? `/api/router${qs({ from: now5 - HOUR_MS, to: now5 })}` : null, { refreshMs: FIVE_MIN });
  const speedtests = useApi<SpeedtestsResponse>("/api/speedtests?limit=1", { refreshMs: FIVE_MIN });
  const events = useApi<EventsResponse>(now != null ? `/api/events${qs({ from: dayFrom, to: now, limit: 300 })}` : null);

  return (
    <>
      <PageHeader
        title="Live-Dashboard"
        description="Zustand der Leitung jetzt und in den letzten 24 Stunden – aus der laufenden Langzeitmessung."
        actions={<SpeedtestButton disabled={mode === "offline" || mode === "connecting"} />}
      />
      <div className="flex flex-col gap-4">
        <VerdictBanner result={diagnosis} />

        {mode === "idle" && <NoSessionPanel />}

        <Panel title="Leitungsweg" description="Live-Zustand je Abschnitt, letzte 60 Sekunden" frame>
          <LiveTopology id="np-dash-topo" />
        </Panel>

        <KpiGrid mode={mode} sources={{ diagnosis, seconds24, stats24, client, router, speedtests }} />

        <div className="grid gap-4 xl:grid-cols-3">
          <Panel
            className="xl:col-span-2"
            title="Latenz je Ziel"
            description="Live, letzte 15 Minuten: Router, Kopfstation (CMTS), DS-Lite-Gateway (AFTR), Cloudflare IPv4 und IPv6. Lücken = Ping verloren."
          >
            <LiveLatencyChart targetIds={CHART_IDS} windowMs={15 * MINUTE} thresholds={false} height={340} />
          </Panel>
          <EventsPanel result={events} now={now} />
        </div>

        <SecondsPanel six={seconds6} day={seconds24} />

        <div className="mt-4">
          <FindingsPanel result={diagnosis} />
        </div>
      </div>
    </>
  );
}
