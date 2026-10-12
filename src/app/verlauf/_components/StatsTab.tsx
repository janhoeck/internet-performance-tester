"use client";

import { useState } from "react";
import type { StatsResponse } from "@/lib/shared/api-types";
import type { TargetStats } from "@/lib/shared/types";
import { useApi } from "@/lib/client/use-api";
import type { TimeRange } from "@/lib/client/use-time-range";
import { shortTargetName, type TargetsInfo } from "@/lib/client/targets";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { DataState, EmptyState } from "@/components/ui/States";
import { Switch } from "@/components/ui/Field";
import { fmtInt, fmtLossPct, fmtMs, fmtNumber, fmtPct, NBSP } from "@/lib/format";
import { tailMs, wilsonPct } from "./stats-math";
import { NoSessionState } from "./states";

interface Row extends TargetStats {
  name: string;
  fullName: string;
  color: string | undefined;
}

function lossCell(r: Row) {
  const w = wilsonPct(r.lost, r.sent);
  return (
    <span className="inline-flex flex-col items-end leading-tight">
      <span>{fmtLossPct(r.lossPct)}</span>
      {w && r.sent > 0 && (
        <span className="text-2xs text-fg-4" title="95-%-Vertrauensbereich (Wilson): so genau ist der Wert bei dieser Anzahl Messungen">
          {fmtNumber(w.lo, w.lo < 1 ? 2 : 1)}–{fmtNumber(w.hi, w.hi < 1 ? 2 : 1)}
          {NBSP}%
        </span>
      )}
    </span>
  );
}

const COLUMNS: ReadonlyArray<Column<Row>> = [
  {
    key: "name",
    header: "Ziel",
    render: (r) => (
      <span className="inline-flex min-w-36 items-center gap-2" title={r.fullName}>
        <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ backgroundColor: r.color ?? "var(--np-chart-other)" }} />
        <span className="text-fg">{r.name}</span>
      </span>
    ),
  },
  { key: "sent", header: "Messwerte", numeric: true, render: (r) => fmtInt(r.sent) },
  { key: "loss", header: "Verlust", numeric: true, render: lossCell },
  { key: "p50", header: "p50", numeric: true, render: (r) => fmtMs(r.p50) },
  { key: "p95", header: "p95", numeric: true, render: (r) => fmtMs(r.p95) },
  { key: "p99", header: "p99", numeric: true, render: (r) => fmtMs(r.p99) },
  { key: "max", header: "Max", numeric: true, render: (r) => fmtMs(r.max) },
  { key: "jitter", header: "Jitter", numeric: true, render: (r) => fmtMs(r.jitter) },
  { key: "tail", header: "Spitzen (p99 − p50)", numeric: true, render: (r) => fmtMs(tailMs(r)) },
  { key: "sph", header: "Ping-Spitzen/h", numeric: true, render: (r) => fmtNumber(r.spikesPerHour, 1) },
  { key: "cov", header: "Abdeckung", numeric: true, render: (r) => fmtPct(r.coveragePct) },
];

/** Kennzahlen je Ziel aus /api/stats (Speedtest-Minuten standardmäßig herausgerechnet). */
export function StatsTab({
  range,
  ids,
  info,
  colors,
}: {
  range: TimeRange;
  ids: readonly string[];
  info: TargetsInfo;
  colors: Readonly<Record<string, string>>;
}) {
  const [excludeSpeedtests, setExclude] = useState(true);
  const url = range.query && ids.length ? `/api/stats?targets=${ids.join(",")}&excludeSpeedtests=${excludeSpeedtests ? 1 : 0}&${range.query}` : null;
  const res = useApi<StatsResponse>(url, { refreshMs: 60_000 });

  if (ids.length === 0) return <EmptyState title="Kein Ziel gewählt">Wähle oben mindestens ein Ziel aus.</EmptyState>;
  if (range.noSession) return <NoSessionState />;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-2xl text-sm text-fg-3">
          p50 = typischer Ping, p95/p99 = die langsamsten 5 % bzw. 1 %. Ein großer Abstand zwischen p99 und p50 bedeutet seltene, hohe Ausreißer – genau das, was im
          Spiel als Ruckler auffällt. Abdeckung = Anteil der Minuten mit Messung.
        </p>
        <Switch
          id="np-stats-exclude"
          checked={excludeSpeedtests}
          onChange={(e) => setExclude(e.target.checked)}
          label="Speedtests herausrechnen"
          hint="Während eines Speedtests ist die Leitung absichtlich voll."
        />
      </div>
      <DataState result={res} height={200} isEmpty={(d) => d.stats.every((s) => s.sent === 0)} emptyTitle="Keine Messwerte im Zeitraum" emptyText="Wähle einen anderen Zeitraum oder starte einen Langzeittest.">
        {(d) => {
          const order = new Map(ids.map((id, i) => [id, i]));
          const rows: Row[] = [...d.stats]
            .sort((a, b) => (order.get(a.targetId) ?? 99) - (order.get(b.targetId) ?? 99))
            .map((s) => ({
              ...s,
              name: shortTargetName(s.targetId, info.targets),
              fullName: info.byId[s.targetId]?.name ?? s.targetId,
              color: colors[s.targetId],
            }));
          return <DataTable caption={`Kennzahlen je Ziel, ${range.label}`} columns={COLUMNS} rows={rows} rowKey={(r) => r.targetId} />;
        }}
      </DataState>
    </div>
  );
}
