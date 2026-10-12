"use client";

import { useMemo, useState } from "react";
import { Cable, ChartColumn, Clock, Gauge, Unplug, Wifi } from "lucide-react";
import type { ClientResponse } from "@/lib/shared/api-types";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { Switch } from "@/components/ui/Field";
import { HealthBadge, HealthDot } from "@/components/ui/HealthBadge";
import { KpiTile } from "@/components/ui/KpiTile";
import { Panel } from "@/components/ui/Panel";
import { EmptyState } from "@/components/ui/States";
import { EChart } from "@/components/viz/EChart";
import { DASH, fmtDateTime, fmtDurationMs, fmtInt, fmtLinkSpeed, fmtPctValue, fmtRelative } from "@/lib/format";
import type { Health } from "@/lib/health";
import { useNow } from "@/lib/use-now";
import { Num } from "./bits";
import { linkDaysOption } from "./pc-charts";
import { CAUSE_LABEL, linkDropRows, type LinkDropRow } from "./pc-model";

function dropsHealth(n: number, crit: number): Health {
  if (n <= 0) return "good";
  return n >= crit ? "crit" : "warn";
}

const COLUMNS: Column<LinkDropRow>[] = [
  { key: "ts", header: "Zeit", width: "11.5rem", render: (r) => <Num className="whitespace-nowrap">{fmtDateTime(r.ts)}</Num> },
  {
    key: "cause",
    header: "Ursache",
    render: (r) => (
      <span className="inline-flex items-center gap-2 whitespace-nowrap">
        <HealthDot status={r.severity} />
        <span className={r.cause === "runtime" ? "font-medium text-fg" : undefined}>{CAUSE_LABEL[r.cause]}</span>
      </span>
    ),
  },
  { key: "down", header: "Ausfalldauer", numeric: true, render: (r) => fmtDurationMs(r.downtimeMs) },
  {
    key: "relink",
    header: "Wiederaufbau mit",
    align: "right",
    render: (r) =>
      r.relinkMbps == null ? (
        <span className="text-fg-3">{DASH}</span>
      ) : r.relinkMbps < 1000 ? (
        <span className="inline-flex items-center justify-end gap-2">
          <Num className="text-warn">{fmtLinkSpeed(r.relinkMbps)}</Num>
          <HealthBadge status="warn" size="sm" />
        </span>
      ) : (
        <Num>{fmtLinkSpeed(r.relinkMbps)}</Num>
      ),
  },
  {
    key: "wlan",
    header: "WLAN-Ausweichen",
    render: (r) => (r.wlanFailover == null ? <span className="text-fg-3">{DASH}</span> : r.wlanFailover ? <span className="text-warn">ja</span> : "nein"),
  },
  { key: "src", header: "Quelle", render: (r) => <Num className="text-xs text-fg-3">{r.provider ?? DASH}</Num> },
];

export function LinkKpis({ summary, linkMbps }: { summary: ClientResponse["linkSummary"]; linkMbps: number | null }) {
  const now = useNow(60_000);
  const pct = summary.relinkBelow1gPct;
  return (
    <div className="grid grid-cols-2 gap-4 md:grid-cols-3 2xl:grid-cols-6">
      <KpiTile label="Abbrüche im Betrieb (24 h)" value={fmtInt(summary.runtimeDrops24h)} icon={Unplug} status={dropsHealth(summary.runtimeDrops24h, 3)} caption="ohne Start/Aufwachen" />
      <KpiTile label="Abbrüche im Betrieb (7 T)" value={fmtInt(summary.runtimeDrops7d)} icon={Unplug} status={dropsHealth(summary.runtimeDrops7d, 3)} caption="ab 3 gilt der Link als instabil" />
      <KpiTile
        label="Wiederaufbau unter 1 Gbit/s"
        value={pct == null ? DASH : fmtPctValue(pct)}
        unit={pct == null ? undefined : "%"}
        icon={Gauge}
        status={pct == null ? "unknown" : pct >= 20 ? "crit" : pct > 0 ? "warn" : "good"}
        caption={`Start und Betrieb, davon ${fmtInt(summary.bootRelinks)} beim Start`}
      />
      <KpiTile label="WLAN-Ausweichen (24 h)" value={fmtInt(summary.wlanFailovers24h)} icon={Wifi} status={summary.wlanFailovers24h > 0 ? "warn" : "good"} caption="Windows wechselte aufs WLAN" />
      <KpiTile
        label="Letzter Abbruch im Betrieb"
        value={summary.lastDropTs == null ? "keiner" : now != null ? fmtRelative(summary.lastDropTs, now) : DASH}
        icon={Clock}
        caption={summary.lastDropTs != null ? fmtDateTime(summary.lastDropTs) : "im gesamten Protokoll"}
        className="[&_.text-3xl]:text-xl"
      />
      <KpiTile
        label="Link jetzt"
        value={linkMbps == null ? DASH : fmtLinkSpeed(linkMbps)}
        icon={Cable}
        status={linkMbps == null ? "unknown" : linkMbps < 1000 ? "warn" : "good"}
        caption="Ethernet-Adapter"
        className="[&_.text-3xl]:text-2xl"
      />
    </div>
  );
}

export function LinkDaysChart({ days }: { days: ClientResponse["linkDays"] }) {
  const shown = useMemo(() => days.slice(-90), [days]);
  const option = useMemo(() => linkDaysOption(shown), [shown]);
  const total = useMemo(() => shown.reduce((s, d) => s + d.down, 0), [shown]);
  return (
    <Panel
      title="Link-Ereignisse je Tag"
      description="Aus dem Windows-Ereignisprotokoll (gesamte Historie). Wiederaufbau mit 100 Mbit/s spricht für Kabel, Stecker oder Port."
    >
      {shown.length === 0 || total === 0 ? (
        <EmptyState icon={ChartColumn} title="Keine Link-Ereignisse">
          Im Windows-Ereignisprotokoll gibt es keine Link-Abbrüche des Ethernet-Adapters. Das ist gut so.
        </EmptyState>
      ) : (
        <EChart option={option} ariaLabel="Link-Abbrüche und Wiederaufbauten mit 1 Gbit/s bzw. 100 Mbit/s je Tag" height={260} />
      )}
    </Panel>
  );
}

export function LinkEventsTable({ events, rangeLabel }: { events: ClientResponse["linkEvents"]; rangeLabel: string }) {
  const [onlyRuntime, setOnlyRuntime] = useState(false);
  const all = useMemo(() => linkDropRows(events), [events]);
  const rows = useMemo(() => (onlyRuntime ? all.filter((r) => r.cause === "runtime") : all), [all, onlyRuntime]);
  return (
    <Panel
      title="Link-Abbrüche"
      description={`${rangeLabel}: jeder Link-Verlust mit Einordnung. Nur „im Betrieb“ zählt als Störung – beim Start, Aufwachen oder Router-Neustart ist ein Neuaufbau normal.`}
      actions={<Switch id="link-only-runtime" label="Nur im Betrieb" checked={onlyRuntime} onChange={(e) => setOnlyRuntime(e.target.checked)} />}
    >
      <DataTable
        columns={COLUMNS}
        rows={rows}
        rowKey={(r) => r.key}
        caption="Link-Abbrüche mit Zeit, Ursache, Ausfalldauer, Geschwindigkeit nach dem Wiederaufbau und WLAN-Ausweichen"
        dense
        maxHeight="28rem"
        empty={
          <EmptyState icon={Unplug} title={all.length > 0 ? "Keine Abbrüche im Betrieb" : "Keine Link-Abbrüche im Zeitraum"}>
            {all.length > 0
              ? "Im Zeitraum gab es nur normale Neuaufbauten (Start, Aufwachen, Router-Neustart)."
              : "Wähle einen längeren Zeitraum, um ältere Ereignisse aus dem Windows-Protokoll zu sehen."}
          </EmptyState>
        }
      />
    </Panel>
  );
}
