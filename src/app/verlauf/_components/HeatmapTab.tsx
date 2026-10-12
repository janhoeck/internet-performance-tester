"use client";

import { useState } from "react";
import type { HeatmapResponse } from "@/lib/shared/api-types";
import { useApi } from "@/lib/client/use-api";
import { HEATMAP_METRIC, heatmapCells } from "@/lib/client/adapters";
import { shortTargetName, type TargetsInfo } from "@/lib/client/targets";
import { DataState } from "@/components/ui/States";
import { Field, Select } from "@/components/ui/Field";
import { HourHeatmap } from "@/components/viz/HourHeatmap";
import { Segmented } from "./Segmented";

type Metric = HeatmapResponse["metric"];

const METRIC_OPTIONS = [
  { value: "p95", label: "p95", title: "p95-Latenz: 95 % der Pings waren schneller" },
  { value: "avg", label: "Ø", title: "Durchschnittliche Latenz" },
  { value: "loss", label: "Verlust", title: "Paketverlust in Prozent" },
  { value: "spikes", label: "Ping-Spitzen", title: "Anzahl der Ping-Spitzen je Stunde" },
] as const;

const DAY_OPTIONS = [
  { value: "7", label: "7 T" },
  { value: "14", label: "14 T" },
  { value: "30", label: "30 T" },
] as const;

const METRIC_EXPLAIN: Record<Metric, string> = {
  p95: "Je Stunde: 95 % der Pings waren schneller als dieser Wert. Helle Felder am Abend deuten auf ein ausgelastetes Kabelsegment hin.",
  avg: "Je Stunde: durchschnittliche Latenz aller beantworteten Pings.",
  loss: "Je Stunde: Anteil verlorener Pings.",
  spikes: "Je Stunde: Anzahl der Ping-Spitzen über der Schwelle des Abschnitts.",
};

/** Stunde × Tag für ein Ziel; Ziel unabhängig vom Zeitraum oben (eigene Tageszahl). */
export function HeatmapTab({ info, selectedIds }: { info: TargetsInfo; selectedIds: readonly string[] }) {
  const [targetPick, setTargetPick] = useState<string | null>(null);
  const [metric, setMetric] = useState<Metric>("p95");
  const [days, setDays] = useState<"7" | "14" | "30">("7");
  const options = info.enabled.length ? info.enabled : info.targets;
  const fallback = selectedIds.find((id) => id !== "gw" && id !== "gw6") ?? selectedIds[0] ?? "cf4";
  const target = targetPick ?? fallback;
  const url = `/api/heatmap?target=${encodeURIComponent(target)}&metric=${metric}&days=${days}`;
  const res = useApi<HeatmapResponse>(url, { refreshMs: 5 * 60_000 });

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
        <Field label="Ziel" htmlFor="np-heat-target" className="w-full sm:w-80">
          <Select id="np-heat-target" value={target} onChange={(e) => setTargetPick(e.target.value)}>
            {options.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
        </Field>
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-fg-2" id="np-heat-metric">
            Kennzahl
          </span>
          <Segmented label="Kennzahl" options={METRIC_OPTIONS} value={metric} onChange={setMetric} />
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-fg-2">Tage</span>
          <Segmented label="Anzahl Tage" options={DAY_OPTIONS} value={days} onChange={setDays} />
        </div>
      </div>
      <p className="max-w-3xl text-sm text-fg-3">{METRIC_EXPLAIN[metric]} Schraffiert: keine oder nur wenig Messung in dieser Stunde.</p>
      <DataState
        result={res}
        height={360}
        isEmpty={(d) => !d.values.some((row) => row.some((v) => v != null))}
        emptyTitle="Noch keine Messwerte für dieses Ziel"
        emptyText={`Für ${shortTargetName(target, info.targets)} gibt es in den letzten ${days} Tagen keine Stundenwerte. Nach ein paar Stunden Langzeittest erscheinen hier die ersten Felder.`}
      >
        {(d) => {
          const { cells, days: dayList } = heatmapCells(d);
          return <HourHeatmap cells={cells} days={dayList} {...HEATMAP_METRIC[d.metric]} />;
        }}
      </DataState>
    </div>
  );
}
