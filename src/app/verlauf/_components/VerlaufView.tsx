"use client";

import { useMemo, useState, type ReactNode } from "react";
import { ChartColumn, ChartSpline, Clock, Table2, Waves } from "lucide-react";
import type { EventsResponse, SecondsResponse, SeriesResponse } from "@/lib/shared/api-types";
import type { NetEvent } from "@/lib/shared/types";
import { useApi, type UseApiResult } from "@/lib/client/use-api";
import { setUrlParams, useTimeRange, useUrlSearch, type TimeRange } from "@/lib/client/use-time-range";
import { useTargets } from "@/lib/client/targets";
import { PageHeader } from "@/components/ui/PageHeader";
import { Panel } from "@/components/ui/Panel";
import { Tabs } from "@/components/ui/Tabs";
import { DataState, EmptyState } from "@/components/ui/States";
import { TimeRangePicker } from "@/components/ui/TimeRangePicker";
import { SessionPicker } from "@/components/ui/SessionPicker";
import { LatencySeriesChart } from "@/components/viz/LatencySeriesChart";
import { LossChart } from "@/components/viz/LossChart";
import { SecondsChart } from "@/components/viz/SecondsChart";
import { FaultShareBar } from "@/components/viz/FaultShareBar";
import type { SecondsUnit } from "@/lib/client/charts";
import { Segmented } from "./Segmented";
import { TargetPicker, useTargetSelection } from "./TargetPicker";
import { HeatmapTab } from "./HeatmapTab";
import { StatsTab } from "./StatsTab";
import { SessionCompare } from "./SessionCompare";
import { EngineHint, NoSessionState, useEngineOffline } from "./states";

const PRESETS = ["1h", "6h", "24h", "7d", "30d", "session"] as const;

/** Ereignisse, die als Bereich/Linie im Latenz- und Verlustdiagramm erscheinen. */
const OVERLAY_TYPES = ["outage", "nic_link_down", "speedtest", "route_change", "note"] as const;

const TAB_IDS = ["latenz", "verlust", "sekunden", "tageszeit", "tabelle"] as const;
type TabId = (typeof TAB_IDS)[number];
const isTabId = (v: string | null): v is TabId => v != null && (TAB_IDS as readonly string[]).includes(v);

/** Nur Link-Abbrüche im Betrieb zeigen – Neuaufbau beim Start/Aufwachen ist normal. */
function overlayEvents(events: readonly NetEvent[] | undefined): NetEvent[] {
  if (!events) return [];
  return events.filter((e) => {
    if (e.type !== "nic_link_down") return true;
    const cause = e.details && typeof e.details === "object" ? (e.details as Record<string, unknown>).cause : undefined;
    return cause === "runtime" || cause == null;
  });
}

export function VerlaufView() {
  const range = useTimeRange({ defaultPreset: "24h" });
  const info = useTargets();
  const selection = useTargetSelection(info);
  const sp = useUrlSearch();
  const rawTab = sp.get("ansicht");
  const tab: TabId = isTabId(rawTab) ? rawTab : "latenz";
  const setTab = (id: string) => setUrlParams({ ansicht: id === "latenz" ? null : id });
  const ids = selection.ids;
  const idsParam = ids.join(",");

  const needsSeries = tab === "latenz" || tab === "verlust";
  const seriesUrl = needsSeries && range.query && ids.length ? `/api/series?targets=${idsParam}&${range.query}` : null;
  const series = useApi<SeriesResponse>(seriesUrl, { refreshMs: 60_000 });
  const eventsUrl =
    (needsSeries || tab === "sekunden") && range.query ? `/api/events?types=${OVERLAY_TYPES.join(",")}&limit=2000&${range.query}` : null;
  const events = useApi<EventsResponse>(eventsUrl, { refreshMs: 60_000 });
  const overlays = useMemo(() => overlayEvents(events.data?.events), [events.data]);

  const items = [
    { id: "latenz", label: "Latenz", icon: <ChartSpline aria-hidden className="size-4" /> },
    { id: "verlust", label: "Paketverlust", icon: <ChartColumn aria-hidden className="size-4" /> },
    { id: "sekunden", label: "Gestörte Sekunden", icon: <Waves aria-hidden className="size-4" /> },
    { id: "tageszeit", label: "Tageszeit", icon: <Clock aria-hidden className="size-4" /> },
    { id: "tabelle", label: "Tabelle", icon: <Table2 aria-hidden className="size-4" /> },
  ] as const;

  const noTargets = ids.length === 0;
  const noTargetsState = (
    <EmptyState title="Kein Ziel gewählt">Wähle oben mindestens ein Ziel aus, zum Beispiel den Router und 1.1.1.1.</EmptyState>
  );

  const panels: Record<string, ReactNode> = {
    latenz:
      tab === "latenz" ? (
        noTargets ? (
          noTargetsState
        ) : (
          <SeriesBlock range={range} result={series} height={380}>
            {(d) => <LatencySeriesChart data={d} targetIds={ids} band="p95" events={overlays} zoom height={380} />}
          </SeriesBlock>
        )
      ) : null,
    verlust:
      tab === "verlust" ? (
        noTargets ? (
          noTargetsState
        ) : (
          <SeriesBlock range={range} result={series} height={320}>
            {(d) => <LossChart data={d} targetIds={ids} events={overlays} height={320} />}
          </SeriesBlock>
        )
      ) : null,
    sekunden: tab === "sekunden" ? <SecondsTab range={range} events={overlays} /> : null,
    tageszeit: tab === "tageszeit" ? <HeatmapTab info={info} selectedIds={ids} /> : null,
    tabelle: tab === "tabelle" ? <StatsTab range={range} ids={ids} info={info} colors={selection.colors} /> : null,
  };

  return (
    <>
      <PageHeader
        title="Verlauf"
        description="Messwerte über Stunden und Tage: Latenz, Paketverlust, gestörte Sekunden und der Vergleich zweier Langzeittests."
        actions={
          <>
            <TimeRangePicker range={range} presets={PRESETS} />
            <SessionPicker range={range} />
          </>
        }
      />
      <div className="flex flex-col gap-6">
        <TargetPicker info={info} selection={selection} />
        <Panel>
          <Tabs label="Ansicht Verlauf" items={items} panels={panels} value={tab} onValueChange={setTab} />
          <RangeFootnote range={range} tab={tab} />
        </Panel>
        <SessionCompare info={info} ids={ids} range={range} />
      </div>
    </>
  );
}

function RangeFootnote({ range, tab }: { range: TimeRange; tab: TabId }) {
  if (tab === "tageszeit") return null;
  return (
    <div className="mt-3 flex flex-col gap-0.5 text-2xs text-fg-4">
      <p>
        Zeitraum: <span className="np-num">{range.label}</span>
      </p>
      {tab === "latenz" && (
        <p>
          Linie = Durchschnitt je Zeitabschnitt, Band bis p95 für das erste Ziel. Markiert sind Ausfälle, Link-Abbrüche im Betrieb, Speedtests,
          Routenwechsel und Notizen. Zoomen mit Mausrad oder Schieber.
        </p>
      )}
      {tab === "verlust" && <p>Verlorene Pings je Zeitabschnitt in Prozent.</p>}
    </div>
  );
}

/** Lade-/Fehlerzustand für /api/series inkl. "kein Langzeittest" und "Mess-Engine nicht erreichbar". */
function SeriesBlock({
  range,
  result,
  height,
  children,
}: {
  range: TimeRange;
  result: UseApiResult<SeriesResponse>;
  height: number;
  children: (d: SeriesResponse) => ReactNode;
}) {
  const offline = useEngineOffline();
  if (range.noSession) return <NoSessionState height={height} />;
  return (
    <DataState result={result} height={height} emptyTitle="Keine Messwerte im Zeitraum" emptyText={<EngineHint offline={offline} />}>
      {children}
    </DataState>
  );
}

const UNIT_OPTIONS = [
  { value: "s", label: "Sekunden" },
  { value: "min", label: "Minuten" },
  { value: "pct", label: "Anteil in %" },
] as const;

function SecondsTab({ range, events }: { range: TimeRange; events: readonly NetEvent[] }) {
  const [unit, setUnit] = useState<SecondsUnit>("s");
  const url = range.query ? `/api/seconds?${range.query}` : null;
  const seconds = useApi<SecondsResponse>(url, { refreshMs: 60_000 });
  if (range.noSession) return <NoSessionState height={300} />;
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-sm text-fg-3">
          Jede gemessene Sekunde wird dem ersten auffälligen Abschnitt zugeordnet. Der Abschnitt mit den meisten gestörten Sekunden ist der wahrscheinlichste
          Verursacher.
        </p>
        <Segmented label="Einheit" options={UNIT_OPTIONS} value={unit} onChange={setUnit} />
      </div>
      <DataState result={seconds} height={300}>
        {(d) => (
          <div className="flex flex-col gap-6">
            <SecondsChart data={d} unit={unit} events={events} height={300} />
            <FaultShareBar total={d.total} caption={`Summe: ${range.label}`} />
          </div>
        )}
      </DataState>
    </div>
  );
}
