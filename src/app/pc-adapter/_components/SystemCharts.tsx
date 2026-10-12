"use client";

import { useMemo } from "react";
import { Cpu, Gamepad2, Network, RotateCcw } from "lucide-react";
import type { EventsResponse, MetricsResponse } from "@/lib/shared/api-types";
import type { NetEvent } from "@/lib/shared/types";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { Panel } from "@/components/ui/Panel";
import { DataState, EmptyState } from "@/components/ui/States";
import type { UseApiResult } from "@/lib/client/use-api";
import { EChart } from "@/components/viz/EChart";
import { DASH, fmtDateTime, fmtDurationMs, fmtTimeRange } from "@/lib/format";
import { useNow } from "@/lib/use-now";
import { Chip, Num } from "./bits";
import { metricLinesOption, type MetricLine } from "./pc-charts";

export const SYSTEM_METRIC_KEYS = ["nic.rx_mbps", "nic.tx_mbps", "tcp.retrans_pct", "tcp6.retrans_pct", "sys.cpu_pct", "wlan.signal_pct", "wlan.rssi_dbm"] as const;

interface LineSpec {
  key: string;
  name: string;
  slot: number;
}

function linesOf(m: MetricsResponse, specs: readonly LineSpec[]): MetricLine[] {
  const out: MetricLine[] = [];
  for (const sp of specs) {
    const s = m.series[sp.key];
    if (s && s.value.some((v) => v != null)) out.push({ id: sp.key, name: sp.name, ts: s.ts, values: s.value, slot: sp.slot });
  }
  return out;
}

const THROUGHPUT: readonly LineSpec[] = [
  { key: "nic.rx_mbps", name: "Empfangen", slot: 0 },
  { key: "nic.tx_mbps", name: "Gesendet", slot: 1 },
];
const RETRANS: readonly LineSpec[] = [
  { key: "tcp.retrans_pct", name: "IPv4", slot: 2 },
  { key: "tcp6.retrans_pct", name: "IPv6", slot: 4 },
];
const CPU: readonly LineSpec[] = [{ key: "sys.cpu_pct", name: "CPU-Last", slot: 5 }];

interface Episode {
  key: string;
  ts: number;
  endTs: number | null;
  process: string;
}

function toEpisodes(events: readonly NetEvent[]): Episode[] {
  return events
    .filter((e) => e.type === "gaming")
    .map((e, i) => ({
      key: `${e.id ?? i}-${e.ts}`,
      ts: e.ts,
      endTs: e.endTs ?? null,
      process: typeof e.details?.process === "string" ? e.details.process : e.title.replace(/^Spiel läuft:\s*/, ""),
    }))
    .sort((a, b) => b.ts - a.ts);
}

function MetricChart({
  title,
  description,
  icon: Icon,
  specs,
  metrics,
  unit,
  digits,
  from,
  to,
  episodes,
  threshold,
  yMax,
  emptyText,
}: {
  title: string;
  description: string;
  icon: typeof Cpu;
  specs: readonly LineSpec[];
  metrics: MetricsResponse;
  unit: string;
  digits: number;
  from: number | null;
  to: number | null;
  episodes: readonly [number, number][];
  threshold?: { value: number; label: string };
  yMax?: number;
  emptyText: string;
}) {
  const present = useMemo(() => linesOf(metrics, specs), [metrics, specs]);
  const option = useMemo(
    () => metricLinesOption({ lines: present, stepMs: metrics.stepMs, unit, digits, from, to, episodes, threshold, yMax }),
    [present, metrics.stepMs, unit, digits, from, to, episodes, threshold, yMax],
  );
  return (
    <Panel
      title={
        <span className="inline-flex items-center gap-2">
          <Icon aria-hidden className="size-5 text-fg-3" strokeWidth={1.75} />
          {title}
        </span>
      }
      description={description}
    >
      {present.length === 0 ? (
        <EmptyState icon={Icon} title="Keine Messwerte im Zeitraum">
          {emptyText}
        </EmptyState>
      ) : (
        <EChart option={option} ariaLabel={`${title} im gewählten Zeitraum`} height={220} />
      )}
    </Panel>
  );
}

const EPISODE_COLUMNS: Column<Episode & { now: number | null }>[] = [
  { key: "time", header: "Zeitraum", render: (e) => <Num className="whitespace-nowrap">{e.endTs != null ? fmtTimeRange(e.ts, e.endTs) : `ab ${fmtDateTime(e.ts)}`}</Num> },
  {
    key: "dur",
    header: "Dauer",
    numeric: true,
    render: (e) => (e.endTs != null ? fmtDurationMs(e.endTs - e.ts) : e.now != null ? <span>{fmtDurationMs(e.now - e.ts)} (läuft)</span> : DASH),
  },
  { key: "proc", header: "Spiel (Prozess)", render: (e) => <Num>{e.process}</Num> },
];

export function SystemCharts({
  metrics,
  gaming,
  from,
  to,
}: {
  metrics: UseApiResult<MetricsResponse>;
  gaming: UseApiResult<EventsResponse>;
  from: number | null;
  to: number | null;
}) {
  const now = useNow(60_000);
  const episodes = useMemo(() => toEpisodes(gaming.data?.events ?? []), [gaming.data]);
  // offene Episode bis zum Ende des Zeitraums zeichnen (kein Date.now() im Render)
  const areas = useMemo<[number, number][]>(() => episodes.map((e) => [e.ts, e.endTs ?? to ?? e.ts]), [episodes, to]);
  const episodeRows = useMemo(() => episodes.map((e) => ({ ...e, now })), [episodes, now]);

  return (
    <section aria-labelledby="pc-system-heading" className="flex flex-col gap-4">
      <div className="mt-4">
        <h2 id="pc-system-heading" className="text-xl font-medium text-fg">
          PC-Auslastung und Spielzeiten
        </h2>
        <p className="mt-1 max-w-3xl text-sm text-fg-3">
          Lädt der PC selbst viel, ist die CPU ausgelastet oder muss TCP oft neu senden? Violette Bereiche markieren Zeiten, in denen ein Spiel lief.
        </p>
      </div>
      <DataState result={metrics} height={220}>
        {(m) => (
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
            <MetricChart
              title="Eigener Durchsatz"
              description="Datenrate des Ethernet-Adapters"
              icon={Network}
              specs={THROUGHPUT}
              metrics={m}
              unit="Mbit/s"
              digits={2}
              from={from}
              to={to}
              episodes={areas}
              emptyText="Der Durchsatz wird gemessen, solange ein Langzeittest läuft."
            />
            <MetricChart
              title="TCP-Neuübertragungen"
              description="Anteil neu gesendeter TCP-Segmente – Hinweis auf Paketverlust im echten Verkehr"
              icon={RotateCcw}
              specs={RETRANS}
              metrics={m}
              unit="%"
              digits={2}
              from={from}
              to={to}
              episodes={areas}
              threshold={TCP_THRESHOLD}
              emptyText="Die Neuübertragungen werden während eines Langzeittests minütlich gemessen."
            />
            <MetricChart
              title="CPU-Last"
              description="Auslastung des Prozessors"
              icon={Cpu}
              specs={CPU}
              metrics={m}
              unit="%"
              digits={0}
              from={from}
              to={to}
              episodes={areas}
              yMax={100}
              emptyText="Die CPU-Last wird gemessen, solange ein Langzeittest läuft."
            />
          </div>
        )}
      </DataState>

      <Panel
        title={
          <span className="inline-flex items-center gap-2">
            <Gamepad2 aria-hidden className="size-5 text-fg-3" strokeWidth={1.75} />
            Spielzeiten
          </span>
        }
        description="Erkannt an laufenden Spielprozessen (Liste unter Einstellungen). In diesen Zeiten werden keine Speedtests gestartet."
        actions={episodes.length > 0 ? <Chip><Num>{episodes.length}</Num>&nbsp;{episodes.length === 1 ? "Episode" : "Episoden"}</Chip> : undefined}
      >
        <DataState
          result={gaming}
          height={120}
          isEmpty={(d) => d.events.length === 0}
          emptyIcon={Gamepad2}
          emptyTitle="Keine Spielzeiten im Zeitraum"
          emptyText="Sobald ein eingetragenes Spiel läuft, erscheint es hier – mit den Messwerten aus dieser Zeit im Verlauf."
        >
          {() => (
            <DataTable columns={EPISODE_COLUMNS} rows={episodeRows} rowKey={(e) => e.key} caption="Spielzeiten mit Zeitraum, Dauer und Prozess" dense maxHeight="20rem" />
          )}
        </DataState>
      </Panel>
    </section>
  );
}

const TCP_THRESHOLD = { value: 1, label: "über 1 %: auffällig" };
