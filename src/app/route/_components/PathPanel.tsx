"use client";

import { useMemo } from "react";
import { Info, Route as RouteIcon } from "lucide-react";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { HealthBadge } from "@/components/ui/HealthBadge";
import { Panel } from "@/components/ui/Panel";
import { EmptyState } from "@/components/ui/States";
import { DASH, fmtDateTime, fmtDurationMs, fmtLossPct, fmtMs } from "@/lib/format";
import type { AppConfig } from "@/lib/shared/config";
import type { DynamicHosts, TracerouteResult } from "@/lib/shared/types";
import { HopChain } from "./HopChain";
import { hopHealth, hopViews, ROLE_LABEL, TRIGGER_LABEL, type HopView } from "./route-utils";

interface PathPanelProps {
  family: 4 | 6;
  row: TracerouteResult | null;
  dyn: DynamicHosts | null;
  latency: AppConfig["thresholds"]["latency"];
}

function roleText(v: HopView): string {
  if (v.role === "aftr" && v.silent) return `${ROLE_LABEL.aftr} – antwortet nicht`;
  if (v.silent) return "antwortet nicht";
  return ROLE_LABEL[v.role];
}

/** Letzte Pfaderkennung einer Adressfamilie: Hop-Kette + Tabelle. */
export function PathPanel({ family, row, dyn, latency }: PathPanelProps) {
  const views = useMemo(() => (row ? hopViews(row, dyn) : []), [row, dyn]);
  const columns = useMemo<ReadonlyArray<Column<HopView>>>(
    () => [
      { key: "hop", header: "Hop", numeric: true, width: "3.5rem", render: (v) => v.hop.hop },
      {
        key: "ip",
        header: "Adresse",
        render: (v) => (v.hop.ip ? <span className="np-num break-all text-fg">{v.hop.ip}</span> : <span className="text-fg-3">* * *</span>),
      },
      { key: "role", header: "Rolle", render: (v) => <span className="whitespace-nowrap">{roleText(v)}</span> },
      { key: "min", header: "Min", numeric: true, render: (v) => fmtMs(v.rttMin) },
      { key: "med", header: "Median", numeric: true, render: (v) => fmtMs(v.rttMedian) },
      { key: "p95", header: "p95", numeric: true, render: (v) => fmtMs(v.rttP95) },
      { key: "loss", header: "Verlust", numeric: true, render: (v) => (v.lossPct === null ? DASH : fmtLossPct(v.lossPct)) },
      {
        key: "state",
        header: "Zustand",
        render: (v) => {
          const h = hopHealth(v, latency);
          return <HealthBadge size="sm" status={h} label={v.silent ? "Stumm" : undefined} />;
        },
      },
    ],
    [latency],
  );

  if (!row) {
    return (
      <Panel title={`Aktueller Pfad IPv${family}`}>
        <EmptyState icon={RouteIcon} title="Noch keine Pfaderkennung">
          Die Mess-Engine prüft den Pfad zu Beginn eines Langzeittests und danach regelmäßig. Mit „Pfad jetzt prüfen“ startest du eine
          Prüfung sofort.
        </EmptyState>
      </Panel>
    );
  }

  const silent = views.filter((v) => v.silent);
  const aftrSilent = silent.some((v) => v.role === "aftr");
  const probes = Math.max(0, ...row.hops.map((h) => h.rtts.length));
  return (
    <Panel
      frame
      title={`Aktueller Pfad IPv${family}`}
      description={
        <span className="flex flex-wrap gap-x-3">
          <span className="np-num">{fmtDateTime(row.ts)}</span>
          <span>{TRIGGER_LABEL[row.trigger]}</span>
          <span>
            Ziel <span className="np-num">{row.target}</span>
          </span>
        </span>
      }
      actions={<HealthBadge status={row.reached ? "good" : "crit"} label={row.reached ? `Ziel erreicht nach ${views.length} Hops` : "Ziel nicht erreicht"} />}
    >
      <div className="overflow-x-auto pb-1">
        <HopChain views={views} label={`Hop-Kette IPv${family} von deinem PC bis ${row.target}`} />
      </div>

      {silent.length > 0 && (
        <p className="mt-4 flex items-start gap-2 rounded-[10px] bg-info/10 px-3 py-2 text-sm text-fg-2 ring-1 ring-inset ring-info/30">
          <Info aria-hidden className="mt-0.5 size-4 shrink-0 text-info" strokeWidth={2} />
          <span>
            {aftrSilent ? (
              <>
                Hop <span className="np-num">2</span> antwortet nicht auf Ping – bei Vodafone (AFTR) normal. Das DS-Lite-Gateway tunnelt
                deinen IPv4-Verkehr, beantwortet Traceroute-Pakete aber selbst nicht.{" "}
              </>
            ) : (
              <>
                {silent.length === 1 ? "Ein Hop antwortet" : `${silent.length} Hops antworten`} nicht auf Ping – viele Provider-Router
                filtern solche Antworten.{" "}
              </>
            )}
            Solange die Hops dahinter antworten, ist das kein Paketverlust.
          </span>
        </p>
      )}

      <DataTable
        className="mt-4"
        dense
        caption={`Hops der Pfaderkennung IPv${family}`}
        columns={columns}
        rows={views}
        rowKey={(v) => String(v.hop.hop)}
      />
      <p className="mt-2 text-xs text-fg-3">
        Pfaderkennung mit <span className="np-num">{probes}</span> Proben je Hop (Dauer <span className="np-num">{fmtDurationMs(row.durationMs)}</span>).
        Laufzeiten an Zwischenhops sind nur grob – Router beantworten Traceroute-Pakete mit niedriger Priorität. Genauer ist das MTR unten.
      </p>
    </Panel>
  );
}
