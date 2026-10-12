"use client";

import type { SecondsResponse } from "@/lib/shared/api-types";
import type { UseApiResult } from "@/lib/client/use-api";
import { Panel } from "@/components/ui/Panel";
import { DataState, Skeleton } from "@/components/ui/States";
import { FaultShareBar } from "@/components/viz/FaultShareBar";
import { SecondsChart } from "@/components/viz/SecondsChart";

const CHART_HEIGHT = 280;

export function SecondsPanel({ six, day }: { six: UseApiResult<SecondsResponse>; day: UseApiResult<SecondsResponse> }) {
  return (
    <Panel
      title="Gestörte Sekunden nach Abschnitt"
      description="Jede gemessene Sekunde mit Paketverlust oder Ping-Spitze wird dem Abschnitt zugeordnet, ab dem sie gestört ist: PC & Kabel (Link weg oder WLAN-Ausweichen), Heimnetz (schon der Router antwortet schlecht), Kabelnetz (schon die Kopfstation ist betroffen), DS-Lite (nur IPv4 gestört), Vodafone-Netz (Kopfstation unauffällig, Internet gestört)."
    >
      <div className="grid gap-6 xl:grid-cols-3">
        <div className="min-w-0 xl:col-span-2">
          <h3 className="mb-2 text-sm font-medium text-fg-2">Letzte 6 Stunden, je 15 Minuten</h3>
          <DataState result={six} height={CHART_HEIGHT}>
            {(d) => <SecondsChart data={d} height={CHART_HEIGHT} />}
          </DataState>
        </div>
        <div className="min-w-0">
          <h3 className="mb-2 text-sm font-medium text-fg-2">Anteile der letzten 24 Stunden</h3>
          <DataState
            result={day}
            height={120}
            skeleton={
              <div className="flex flex-col gap-3" aria-busy="true" aria-label="Anteile werden geladen">
                <Skeleton className="w-40" />
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-16 w-full" />
              </div>
            }
          >
            {(d) => <FaultShareBar total={d.total} caption="Letzte 24 Stunden" />}
          </DataState>
        </div>
      </div>
    </Panel>
  );
}
