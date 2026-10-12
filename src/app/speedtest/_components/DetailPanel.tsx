"use client";

import { useMemo } from "react";
import { ChartNoAxesCombined } from "lucide-react";
import { Panel } from "@/components/ui/Panel";
import { DataState } from "@/components/ui/States";
import { Field, Select } from "@/components/ui/Field";
import { EChart } from "@/components/viz/EChart";
import { useApi } from "@/lib/client/use-api";
import { chartTokens } from "@/lib/echarts-theme";
import { fmtDateTimeShort, fmtMbit } from "@/lib/format";
import type { SpeedtestDetailResponse } from "@/lib/shared/api-types";
import type { SpeedtestResult } from "@/lib/shared/types";
import { speedRunOption } from "./speed-charts";
import { hasThroughput } from "./speed-utils";

interface DetailPanelProps {
  items: readonly SpeedtestResult[];
  selectedId: number | null;
  onSelect: (id: number) => void;
}

function DetailChart({ data }: { data: SpeedtestDetailResponse }) {
  const option = useMemo(() => speedRunOption(data.series, { t: chartTokens(), animation: true }), [data.series]);
  return (
    <EChart
      option={option}
      notMerge
      ariaLabel={`Speedtest vom ${fmtDateTimeShort(data.ts)}: Durchsatz und Latenz über die Testdauer, Phasen hinterlegt`}
      height={340}
    />
  );
}

/** Verlauf eines ausgewählten Tests aus /api/speedtests/[id]. */
export function DetailPanel({ items, selectedId, onSelect }: DetailPanelProps) {
  const detail = useApi<SpeedtestDetailResponse>(selectedId != null ? `/api/speedtests/${selectedId}` : null);
  const options = useMemo(() => items.filter((r) => r.id != null && hasThroughput(r)).slice(0, 100), [items]);
  return (
    <Panel
      title="Testverlauf"
      description="Durchsatz und Latenz über die Testdauer. Steigt die Latenz im Download- oder Upload-Abschnitt, puffert die Leitung."
      actions={
        options.length > 1 ? (
          <Field label="Test auswählen" htmlFor="speedtest-select" className="w-56 max-w-full">
            <Select id="speedtest-select" value={selectedId ?? ""} onChange={(e) => onSelect(Number(e.target.value))}>
              {options.map((r) => (
                <option key={r.id} value={r.id}>
                  {fmtDateTimeShort(r.ts)} – {fmtMbit(r.downMbps)}
                </option>
              ))}
            </Select>
          </Field>
        ) : undefined
      }
    >
      <DataState
        result={detail}
        height={340}
        isEmpty={(d) => d.series.length === 0}
        emptyIcon={ChartNoAxesCombined}
        emptyTitle="Keine Messpunkte gespeichert"
        emptyText="Für diesen Test liegen keine Einzelwerte vor (z. B. abgebrochen, bevor gemessen wurde)."
      >
        {(d) => <DetailChart data={d} />}
      </DataState>
    </Panel>
  );
}
