"use client";

import { useMemo } from "react";
import type { ClientResponse, EventsResponse, MetricsResponse } from "@/lib/shared/api-types";
import { PageHeader } from "@/components/ui/PageHeader";
import { ChartSkeleton, DataState, KpiSkeleton } from "@/components/ui/States";
import { TimeRangePicker } from "@/components/ui/TimeRangePicker";
import { useClientState } from "@/lib/client/live-store";
import { useApi } from "@/lib/client/use-api";
import { useTimeRange } from "@/lib/client/use-time-range";
import { EthernetCard, VirtualAdapters, WifiCard } from "./AdapterCards";
import { AdvancedProps } from "./AdvancedProps";
import { LinkDaysChart, LinkEventsTable, LinkKpis } from "./LinkSection";
import { LiveContext } from "./LiveContext";
import { groupAdapters, linkDropRows, readAdvanced } from "./pc-model";
import { Recommendations } from "./Recommendations";
import { SYSTEM_METRIC_KEYS, SystemCharts } from "./SystemCharts";
import { VpnPanel, WlanPanel } from "./WlanVpn";

const PRESETS = ["24h", "7d", "30d"] as const;

function PageSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-busy="true" aria-label="Adapterdaten werden geladen">
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 2xl:grid-cols-6">
        {Array.from({ length: 6 }, (_, i) => (
          <KpiSkeleton key={i} />
        ))}
      </div>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <div className="np-panel p-5 xl:col-span-2">
          <ChartSkeleton height={260} />
        </div>
        <div className="np-panel p-5">
          <ChartSkeleton height={260} />
        </div>
      </div>
    </div>
  );
}

function ClientContent({
  data,
  metrics,
  from,
  to,
  rangeLabel,
}: {
  data: ClientResponse;
  metrics: MetricsResponse | null;
  from: number | null;
  to: number | null;
  rangeLabel: string;
}) {
  const live = useClientState();
  const groups = useMemo(() => groupAdapters(data.adapters), [data.adapters]);
  const advanced = useMemo(() => readAdvanced(data.adapters?.advanced), [data.adapters]);
  const drops = useMemo(() => linkDropRows(data.linkEvents), [data.linkEvents]);
  const linkNow = live?.linkUp === false ? null : (live?.linkMbps ?? (groups.ethernet?.status === "Up" ? groups.ethernet.linkMbps : null));

  return (
    <>
      <LinkKpis summary={data.linkSummary} linkMbps={linkNow} />

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <div className="min-w-0 xl:col-span-2">
          <EthernetCard a={groups.ethernet} />
        </div>
        <LiveContext />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-5">
        <div className="min-w-0 xl:col-span-3">
          <Recommendations summary={data.linkSummary} ethernet={groups.ethernet} drops={drops} advanced={advanced} />
        </div>
        <div className="min-w-0 xl:col-span-2">
          <LinkDaysChart days={data.linkDays} />
        </div>
      </div>

      <LinkEventsTable events={data.linkEvents} rangeLabel={rangeLabel} />

      <AdvancedProps props={advanced} adapterName={groups.ethernet?.description ?? null} />

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <WlanPanel wlan={data.wlan} metrics={metrics} from={from} to={to} />
        <VpnPanel vpn={data.vpn} />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <WifiCard a={groups.wifi} />
        <VirtualAdapters list={[...groups.otherPhysical, ...groups.virtual]} />
      </div>
    </>
  );
}

export function PcAdapterView() {
  const range = useTimeRange({ defaultPreset: "7d" });
  const q = range.query;
  const client = useApi<ClientResponse>(q ? `/api/client?${q}` : null, { refreshMs: 60_000 });
  const metrics = useApi<MetricsResponse>(q ? `/api/metrics?keys=${SYSTEM_METRIC_KEYS.join(",")}&${q}` : null, { refreshMs: 60_000 });
  const gaming = useApi<EventsResponse>(q ? `/api/events?types=gaming&limit=200&${q}` : null, { refreshMs: 60_000 });

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="PC & Adapter"
        description="Netzwerkkarte, Link-Abbrüche und Linkgeschwindigkeit dieses PCs – dazu WLAN, VPN und die Auslastung des Rechners."
        className="mb-2"
        actions={<TimeRangePicker range={range} presets={PRESETS} />}
      />
      <DataState result={client} skeleton={<PageSkeleton />} height={320}>
        {(data) => <ClientContent data={data} metrics={metrics.data} from={range.from} to={range.to} rangeLabel={range.label} />}
      </DataState>
      <SystemCharts metrics={metrics} gaming={gaming} from={range.from} to={range.to} />
    </div>
  );
}
