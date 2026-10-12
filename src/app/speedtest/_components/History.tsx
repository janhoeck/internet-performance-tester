"use client";

import { useMemo } from "react";
import { ChartSpline, Eye } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { HealthBadge } from "@/components/ui/HealthBadge";
import { Panel } from "@/components/ui/Panel";
import { EmptyState } from "@/components/ui/States";
import { EChart } from "@/components/viz/EChart";
import { chartTokens } from "@/lib/echarts-theme";
import { DASH, fmtDateTimeShort, fmtLinkSpeed, fmtMbitValue, fmtMsValue } from "@/lib/format";
import { toUiHealth } from "@/lib/health";
import { gradeHealth, gradeLabel } from "@/lib/shared/grading";
import type { SpeedtestResult } from "@/lib/shared/types";
import { speedHistoryOption } from "./speed-charts";
import { hasThroughput, TRIGGER_LABEL, type SpeedEventIndex, speedEventInfo } from "./speed-utils";

interface HistoryChartProps {
  items: readonly SpeedtestResult[];
  tariffDown: number | null;
  tariffUp: number | null;
}

export function HistoryChart({ items, tariffDown, tariffUp }: HistoryChartProps) {
  const ok = useMemo(() => items.filter(hasThroughput), [items]);
  const option = useMemo(() => speedHistoryOption(ok, { t: chartTokens(), tariffDown, tariffUp }), [ok, tariffDown, tariffUp]);
  const links = useMemo(() => [...new Set(ok.map((r) => r.nicLinkMbps).filter((v): v is number => v !== null))], [ok]);
  return (
    <Panel
      title="Verlauf"
      description="Download und Upload aller Tests. Gestrichelt: Tarif und die Linkgeschwindigkeit der Netzwerkkarte – mehr geht über das Kabel nicht."
    >
      {ok.length < 2 ? (
        <EmptyState icon={ChartSpline} title="Noch zu wenige Tests für einen Verlauf">
          Ab zwei erfolgreichen Tests erscheint hier die Entwicklung über die Zeit. Geplante Tests laufen während eines Langzeittests
          automatisch.
        </EmptyState>
      ) : (
        <>
          <EChart option={option} ariaLabel={`Download und Upload von ${ok.length} Speedtests im Zeitverlauf`} height={300} />
          {links.length > 1 && (
            <p className="mt-2 text-xs text-warn">
              Die Netzwerkkarte war bei den Tests unterschiedlich schnell verbunden ({links.map((l) => fmtLinkSpeed(l)).join(", ")}). Ein
              100-Mbit/s-Link begrenzt den Download hart.
            </p>
          )}
        </>
      )}
    </Panel>
  );
}

interface HistoryTableProps {
  items: readonly SpeedtestResult[];
  events: SpeedEventIndex;
  selectedId: number | null;
  onSelect: (id: number) => void;
}

interface Row {
  r: SpeedtestResult;
  pop: string | null;
}

export function HistoryTable({ items, events, selectedId, onSelect }: HistoryTableProps) {
  const rows = useMemo<Row[]>(() => items.map((r) => ({ r, pop: speedEventInfo(events.get(r))?.pop ?? null })), [items, events]);
  const columns = useMemo<ReadonlyArray<Column<Row>>>(
    () => [
      {
        key: "ts",
        header: "Zeitpunkt",
        render: ({ r }) => (
          <span className="flex flex-col leading-tight">
            <span className="np-num whitespace-nowrap text-fg">{fmtDateTimeShort(r.ts)}</span>
            <span className="text-2xs text-fg-3">{TRIGGER_LABEL[r.trigger]}</span>
          </span>
        ),
      },
      {
        key: "server",
        header: "Server/Standort",
        render: ({ r, pop }) => (
          <span className="flex flex-col leading-tight">
            <span className="whitespace-nowrap">{r.server ?? DASH}</span>
            {pop && <span className="np-num text-2xs text-fg-3">{pop}</span>}
          </span>
        ),
      },
      { key: "down", header: "Download (Mbit/s)", numeric: true, render: ({ r }) => fmtMbitValue(r.downMbps) },
      { key: "up", header: "Upload (Mbit/s)", numeric: true, render: ({ r }) => fmtMbitValue(r.upMbps) },
      { key: "idle", header: "Leerlauf (ms)", numeric: true, render: ({ r }) => fmtMsValue(r.idleLatencyMs) },
      {
        key: "loaded",
        header: "Last D/U (ms)",
        numeric: true,
        render: ({ r }) => (
          <span className="whitespace-nowrap">
            {fmtMsValue(r.loadedDownLatencyMs)} / {fmtMsValue(r.loadedUpLatencyMs)}
          </span>
        ),
      },
      {
        key: "grade",
        header: "Note",
        render: ({ r }) =>
          hasThroughput(r) ? (
            <HealthBadge size="sm" status={toUiHealth(gradeHealth(r.grade))} label={r.grade ? `${r.grade} ${gradeLabel(r.grade)}` : "Keine Note"} />
          ) : (
            <HealthBadge size="sm" status="crit" label="Fehlgeschlagen" />
          ),
      },
      {
        key: "action",
        header: <span className="sr-only">Aktion</span>,
        align: "right",
        render: ({ r }) =>
          r.id != null && hasThroughput(r) ? (
            <Button
              size="sm"
              variant={r.id === selectedId ? "secondary" : "ghost"}
              icon={Eye}
              aria-pressed={r.id === selectedId}
              onClick={() => onSelect(r.id as number)}
            >
              {r.id === selectedId ? "Angezeigt" : "Anzeigen"}
            </Button>
          ) : r.error ? (
            <span className="block max-w-56 truncate text-2xs text-fg-3" title={r.error}>
              {r.error}
            </span>
          ) : null,
      },
    ],
    [selectedId, onSelect],
  );
  return (
    <Panel title="Alle Tests" description="Neueste zuerst. „Anzeigen“ öffnet den Testverlauf im Diagramm oben.">
      <DataTable caption="Speedtests" columns={columns} rows={rows} rowKey={({ r }) => String(r.id ?? r.ts)} maxHeight="440px" dense />
    </Panel>
  );
}
