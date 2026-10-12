"use client";

import { useMemo, useState } from "react";
import { SlidersHorizontal } from "lucide-react";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { Switch } from "@/components/ui/Field";
import { HealthBadge } from "@/components/ui/HealthBadge";
import { Panel } from "@/components/ui/Panel";
import { EmptyState } from "@/components/ui/States";
import { DASH } from "@/lib/format";
import { Num } from "./bits";
import { adviceRank, adviseProp, type AdvancedProp, type PropAdvice } from "./pc-model";

interface Row extends PropAdvice {
  key: string;
  keyword: string | null;
}

const COLUMNS: Column<Row>[] = [
  {
    key: "name",
    header: "Eigenschaft",
    render: (r) => (
      <span className="flex flex-col py-1">
        <span className="text-fg">{r.label}</span>
        {r.keyword && r.keyword !== r.label && <Num className="text-2xs text-fg-3">{r.keyword}</Num>}
      </span>
    ),
  },
  { key: "value", header: "Wert", render: (r) => <Num>{r.valueText || DASH}</Num> },
  {
    key: "status",
    header: "Bewertung",
    width: "8.5rem",
    render: (r) => (r.status ? <HealthBadge status={r.status} size="sm" /> : <span className="text-fg-3">{DASH}</span>),
  },
  { key: "advice", header: "Empfehlung", render: (r) => <span className="block min-w-[14rem] py-1 text-fg-2">{r.advice}</span> },
];

export function AdvancedProps({ props, adapterName }: { props: readonly AdvancedProp[]; adapterName: string | null }) {
  const [all, setAll] = useState(false);
  const rows = useMemo<Row[]>(() => {
    const list = props.map((p, i) => ({ ...adviseProp(p), key: `${p.keyword ?? p.name}-${i}`, keyword: p.keyword }));
    list.sort((a, b) => adviceRank(a) - adviceRank(b) || a.label.localeCompare(b.label, "de"));
    return list;
  }, [props]);
  const relevant = rows.filter((r) => r.status != null);
  const shown = all ? rows : relevant;
  const issues = rows.filter((r) => r.status === "warn" || r.status === "crit").length;

  return (
    <Panel
      title={
        <span className="inline-flex items-center gap-2">
          <SlidersHorizontal aria-hidden className="size-5 text-fg-3" strokeWidth={1.75} />
          Erweiterte Adapter-Eigenschaften
        </span>
      }
      description={`${adapterName ?? "Ethernet-Adapter"} – Einstellungen aus dem Gerätemanager (Reiter „Erweitert“), nur gelesen. Netzpuls ändert nichts.`}
      actions={
        rows.length > relevant.length ? <Switch id="adv-all" label={`Alle anzeigen (${rows.length})`} checked={all} onChange={(e) => setAll(e.target.checked)} /> : undefined
      }
    >
      {issues > 0 && (
        <p className="mb-3 text-sm text-fg-2">
          <Num className="text-warn">{issues}</Num> {issues === 1 ? "Einstellung sollte" : "Einstellungen sollten"} für den Test angepasst werden.
        </p>
      )}
      <DataTable
        columns={COLUMNS}
        rows={shown}
        rowKey={(r) => r.key}
        caption="Erweiterte Eigenschaften des Ethernet-Adapters mit Bewertung und Empfehlung"
        dense
        maxHeight="30rem"
        empty={
          <EmptyState icon={SlidersHorizontal} title="Keine Eigenschaften gelesen">
            Die Mess-Engine liest die erweiterten Eigenschaften alle 10 Minuten. Sie erscheinen nach der nächsten Abfrage.
          </EmptyState>
        }
      />
    </Panel>
  );
}
