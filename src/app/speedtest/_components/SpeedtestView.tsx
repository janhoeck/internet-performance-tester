"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Gauge } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { Panel } from "@/components/ui/Panel";
import { ChartSkeleton, EmptyState, ErrorState, KpiSkeleton } from "@/components/ui/States";
import { useClientState, useEngineStatus, useLiveConnection, useSpeedtestProgress } from "@/lib/client/live-store";
import { revalidateApi, useApi } from "@/lib/client/use-api";
import { fmtShortTime, NBSP } from "@/lib/format";
import { useNow } from "@/lib/use-now";
import type { EventsResponse, SpeedtestsResponse, StatusResponse } from "@/lib/shared/api-types";
import { DEFAULT_CONFIG } from "@/lib/shared/config";
import { DetailPanel } from "./DetailPanel";
import { HistoryChart, HistoryTable } from "./History";
import { LastResult } from "./LastResult";
import { LiveRunPanel, StartSpeedtestButton } from "./LiveRun";
import { useSpeedtestTrace } from "./live-trace";
import { SchedulePanel } from "./SchedulePanel";
import { hasThroughput, indexSpeedEvents, speedEventInfo } from "./speed-utils";

const LIST_URL = "/api/speedtests?limit=500";
const EVENTS_URL = "/api/events?types=speedtest&from=0&limit=500";

export function SpeedtestView() {
  const conn = useLiveConnection();
  const progress = useSpeedtestProgress();
  const trace = useSpeedtestTrace();
  const liveEngine = useEngineStatus();
  const client = useClientState();
  const now = useNow(30_000);

  const status = useApi<StatusResponse>("/api/status", { refreshMs: 30_000 });
  const list = useApi<SpeedtestsResponse>(LIST_URL, { refreshMs: 120_000 });
  const events = useApi<EventsResponse>(EVENTS_URL, { refreshMs: 120_000 });

  const config = status.data?.config ?? null;
  const engine = conn.online ? (liveEngine ?? status.data?.engine ?? null) : null;
  const running = progress?.running === true;

  // Nach Testende Liste + Ereignisse neu laden (kein setState – nur Cache-Invalidierung)
  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && !running) {
      revalidateApi("/api/speedtests");
      revalidateApi("/api/events");
    }
    wasRunning.current = running;
  }, [running]);

  const items = useMemo(() => list.data?.items ?? [], [list.data]);
  const eventIndex = useMemo(() => indexSpeedEvents(events.data?.events), [events.data]);
  const lastOk = useMemo(() => items.find(hasThroughput) ?? null, [items]);
  const newestFailed = items.length > 0 && !hasThroughput(items[0]) ? items[0] : null;

  const [picked, setPicked] = useState<number | null>(null);
  const selectedId = picked != null && items.some((r) => r.id === picked) ? picked : (lastOk?.id ?? null);
  const onSelect = useCallback((id: number) => setPicked(id), []);

  const tariff = config?.tariff ?? DEFAULT_CONFIG.tariff;
  const speedConfig = config?.speedtest ?? DEFAULT_CONFIG.speedtest;
  const bloatBand = config?.thresholds.bufferbloat ?? DEFAULT_CONFIG.thresholds.bufferbloat;
  const nextRun = engine?.modules.find((m) => m.name === "speedtest")?.nextRunTs ?? null;

  const header = (
    <PageHeader
      title="Speedtest"
      description="Durchsatz und Latenz unter Last (Bufferbloat) – geplante Tests und Tests auf Knopfdruck."
      actions={<StartSpeedtestButton running={running} online={conn.online} />}
    />
  );

  const schedule = (
    <SchedulePanel
      schedules={config?.schedules ?? null}
      engine={engine}
      online={conn.online}
      client={client}
      lastTestTs={items[0]?.ts ?? null}
      now={now}
    />
  );

  let content;
  if (list.data == null && list.error) {
    content = (
      <Panel>
        <ErrorState message={list.error.message} onRetry={list.reload} />
      </Panel>
    );
  } else if (list.data == null) {
    content = (
      <div className="flex flex-col gap-4" aria-busy="true">
        <div className="grid grid-cols-1 gap-3 min-[480px]:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-5">
          {Array.from({ length: 5 }, (_, i) => (
            <KpiSkeleton key={i} />
          ))}
        </div>
        <Panel>
          <ChartSkeleton height={300} />
        </Panel>
      </div>
    );
  } else if (!lastOk) {
    content = (
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Panel className="xl:col-span-2">
          <EmptyState
            icon={Gauge}
            title={newestFailed ? "Noch kein erfolgreicher Speedtest" : "Noch keine Speedtests"}
            action={<StartSpeedtestButton running={running} online={conn.online} label="Ersten Speedtest starten" />}
          >
            {newestFailed?.error ? <p className="mb-2">Letzter Versuch: {newestFailed.error}</p> : null}
            {nextRun != null ? (
              <>
                Der nächste geplante Test läuft um <span className="np-num text-fg-2">{fmtShortTime(nextRun)}{NBSP}Uhr</span>.
              </>
            ) : (
              "Geplante Tests laufen während eines Langzeittests. Du kannst jederzeit manuell testen."
            )}
          </EmptyState>
        </Panel>
        {schedule}
      </div>
    );
  } else {
    content = (
      <div className="flex flex-col gap-6">
        <LastResult
          result={lastOk}
          info={speedEventInfo(eventIndex.get(lastOk))}
          failed={newestFailed}
          tariff={tariff}
          bloatBand={bloatBand}
        />
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
          <div className="min-w-0 xl:col-span-2">
            <DetailPanel items={items} selectedId={selectedId} onSelect={onSelect} />
          </div>
          {schedule}
        </div>
        <HistoryChart items={items} tariffDown={tariff.downMbps} tariffUp={tariff.upMbps} />
        <HistoryTable items={items} events={eventIndex} selectedId={selectedId} onSelect={onSelect} />
        {list.error && <p className="text-xs text-warn">Aktualisierung fehlgeschlagen: {list.error.message} Angezeigt werden die zuletzt geladenen Daten.</p>}
      </div>
    );
  }

  return (
    <>
      {header}
      <div className="flex flex-col gap-6">
        <LiveRunPanel progress={progress} trace={trace} conn={conn} speedConfig={speedConfig} />
        {content}
      </div>
    </>
  );
}
