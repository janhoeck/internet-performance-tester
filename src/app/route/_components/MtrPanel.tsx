"use client";

import { useMemo } from "react";
import { Activity, BookOpen } from "lucide-react";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { HealthBadge } from "@/components/ui/HealthBadge";
import { Panel } from "@/components/ui/Panel";
import { EmptyState } from "@/components/ui/States";
import { DASH, fmtDateTime, fmtLossPct, fmtMs } from "@/lib/format";
import type { Severity } from "@/lib/health";
import { hopPropagation, interpretPath, type HopAttribution, type HopPropagation, type Propagation } from "@/lib/shared/path-analysis";
import type { DynamicHosts, TraceHop, TracerouteResult } from "@/lib/shared/types";
import { hopRoles, ROLE_LABEL, TRIGGER_LABEL, type HopRole } from "./route-utils";

interface MtrPanelProps {
  family: 4 | 6;
  row: TracerouteResult | null;
  dyn: DynamicHosts | null;
}

interface MtrRow {
  hop: TraceHop;
  role: HopRole;
  attr: HopAttribution | undefined;
  prop: HopPropagation | undefined;
}

const PROP_LABEL: Record<Propagation, string> = {
  real: "setzt sich fort",
  cosmetic: "bleibt am Hop",
  inconclusive: "unklar",
};

const MIN_LOSS = 10;

function verdict(r: MtrRow): { status: Severity; label: string } {
  const a = r.attr;
  if (r.hop.ip === null) return { status: "info", label: "Stumm" };
  if (!a) return { status: "unknown", label: "Unbekannt" };
  if (a.linkLoss !== null && a.linkLoss >= MIN_LOSS) return { status: "crit", label: "Echter Verlust" };
  if (a.addedRtt !== null && a.addedRtt >= 20 && r.hop.hop > 1) return { status: "warn", label: "Laufzeit steigt" };
  if (a.nodeLoss !== null && a.nodeLoss >= MIN_LOSS) return { status: "info", label: "Kosmetisch" };
  if (a.nodeRtt !== null && a.nodeRtt >= 30) return { status: "info", label: "Kosmetisch" };
  return { status: "good", label: "Gut" };
}

/** Letztes MTR (20 Pings je Hop) mit pathping-Auswertung: echter vs. kosmetischer Verlust. */
export function MtrPanel({ family, row, dyn }: MtrPanelProps) {
  const data = useMemo(() => {
    if (!row) return null;
    const hops = [...row.hops].sort((a, b) => a.hop - b.hop);
    const interp = interpretPath(hops, row.reached);
    const props = hopPropagation(hops);
    const roles = hopRoles(row, dyn);
    const rows: MtrRow[] = hops.map((h, i) => ({
      hop: h,
      role: roles[i],
      attr: interp.attribution.find((a) => a.hop === h.hop),
      prop: props.find((p) => p.hop === h.hop),
    }));
    return { interp, rows };
  }, [row, dyn]);

  const columns = useMemo<ReadonlyArray<Column<MtrRow>>>(
    () => [
      { key: "hop", header: "Hop", numeric: true, width: "3.5rem", render: (r) => r.hop.hop },
      {
        key: "ip",
        header: "Adresse",
        render: (r) => (r.hop.ip ? <span className="np-num break-all text-fg">{r.hop.ip}</span> : <span className="text-fg-3">* * *</span>),
      },
      { key: "role", header: "Rolle", render: (r) => <span className="whitespace-nowrap">{r.hop.ip === null ? "antwortet nicht" : ROLE_LABEL[r.role]}</span> },
      {
        key: "loss",
        header: "Verlust gemessen",
        numeric: true,
        render: (r) => (r.hop.mtr && r.hop.mtr.sent > 0 ? fmtLossPct(r.hop.mtr.lossPct) : DASH),
      },
      {
        key: "real",
        header: "Davon echt",
        numeric: true,
        render: (r) => (r.attr?.persistentLoss != null ? fmtLossPct(r.attr.persistentLoss) : DASH),
      },
      { key: "med", header: "Median", numeric: true, render: (r) => fmtMs(r.attr?.rttMs) },
      { key: "jit", header: "Jitter", numeric: true, render: (r) => fmtMs(r.hop.mtr?.jitterMs) },
      {
        key: "prop",
        header: "Spitzen",
        render: (r) => <span className="whitespace-nowrap text-fg-3">{r.prop?.verdict ? PROP_LABEL[r.prop.verdict] : DASH}</span>,
      },
      {
        key: "state",
        header: "Bewertung",
        render: (r) => {
          const v = verdict(r);
          return <HealthBadge size="sm" status={v.status} label={v.label} />;
        },
      },
    ],
    [],
  );

  if (!row || !data) {
    return (
      <Panel title={`MTR IPv${family}`}>
        <EmptyState icon={Activity} title="Noch kein MTR">
          Das MTR schickt 20 Pings an jeden Hop und zeigt, wo Verlust wirklich beginnt. Es läuft stündlich während eines Langzeittests und
          nach Ausfällen. Mit „MTR jetzt“ startest du es sofort.
        </EmptyState>
      </Panel>
    );
  }

  const { interp, rows } = data;
  const real = interp.lossStartsAt !== null;
  const cosmetic = interp.findings.filter((f) => f.kind === "node-loss" || f.kind === "node-latency");
  const added = interp.findings.filter((f) => f.kind === "added-latency");
  const status: Severity = real ? "crit" : !row.reached ? "warn" : added.length > 0 ? "warn" : "good";
  const statusLabel = real ? "Echter Paketverlust" : !row.reached ? "Ziel nicht erreicht" : added.length > 0 ? "Laufzeit steigt" : cosmetic.length > 0 ? "Nur kosmetisch" : "Unauffällig";

  return (
    <Panel
      title={`MTR IPv${family}`}
      description={
        <span className="flex flex-wrap gap-x-3">
          <span className="np-num">{fmtDateTime(row.ts)}</span>
          <span>{TRIGGER_LABEL[row.trigger]}</span>
          <span>
            <span className="np-num">{Math.max(0, ...row.hops.map((h) => h.mtr?.sent ?? 0))}</span> Pings je Hop
          </span>
        </span>
      }
      actions={<HealthBadge status={status} label={statusLabel} />}
    >
      <p className="text-sm text-fg">{interp.summary}</p>
      {interp.findings.length > 0 && (
        <ul className="mt-3 flex flex-col gap-1.5">
          {interp.findings.map((f) => (
            <li key={`${f.hop}-${f.kind}`} className="flex items-start gap-2 text-sm text-fg-2">
              <HealthBadge
                size="sm"
                status={f.kind === "link-loss" ? "crit" : f.kind === "added-latency" ? "warn" : "info"}
                label={f.kind === "link-loss" ? "Echt" : f.kind === "added-latency" ? "Laufzeit" : "Kosmetisch"}
                className="mt-0.5 shrink-0"
              />
              <span>{f.text}</span>
            </li>
          ))}
        </ul>
      )}

      <DataTable className="mt-4" dense caption={`MTR-Auswertung IPv${family} je Hop`} columns={columns} rows={rows} rowKey={(r) => String(r.hop.hop)} />

      <div className="mt-4 rounded-[10px] bg-raised/60 p-3 ring-1 ring-inset ring-line">
        <p className="flex items-center gap-2 text-sm font-medium text-fg">
          <BookOpen aria-hidden className="size-4 text-fiber" strokeWidth={2} />
          So liest du das MTR
        </p>
        <ul className="mt-2 flex list-disc flex-col gap-1 pl-5 text-xs text-fg-3">
          <li>
            Verlust an einem Zwischenhop zählt nur, wenn er bis zum Ziel bestehen bleibt („Davon echt“). Zeigt ein Hop Verlust, die Hops
            dahinter aber nicht, drosselt dieser Router nur seine Ping-Antworten – kosmetisch, deine Spielpakete leitet er normal weiter.
          </li>
          <li>
            Gleiches gilt für die Laufzeit: Ist ein Hop langsamer als die Hops dahinter, antwortet er nur träge. Echt ist eine Erhöhung erst,
            wenn sie sich bis zum Ziel fortsetzt.
          </li>
          <li>
            „Spitzen“: Treten Ausreißer eines Hops in denselben Runden auch am Ziel auf, setzen sie sich fort (echt). Bleiben sie am Hop,
            sind sie kosmetisch.
          </li>
          <li>
            Bei <span className="np-num">20</span> Pings entspricht ein verlorener Ping <span className="np-num">5&nbsp;%</span> – erst ab
            zwei verlorenen Pings wertet Netzpuls Verlust.
          </li>
        </ul>
      </div>
    </Panel>
  );
}
