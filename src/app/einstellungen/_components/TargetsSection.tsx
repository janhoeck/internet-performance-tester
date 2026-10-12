"use client";

import { useState } from "react";
import { Lock, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { Select, Switch, TextInput } from "@/components/ui/Field";
import { targetCssColor } from "@/lib/client/targets";
import { fmtNumber } from "@/lib/format";
import { SHARED_SEGMENT_LABEL } from "@/lib/segments";
import type { Segment, TargetConfig } from "@/lib/shared/types";
import { AddTargetDialog } from "./AddTargetDialog";
import { issueText } from "./controls";
import { DYNAMIC_HOST_LABEL, KIND_LABEL, SEGMENT_ORDER, issuesUnder, type IssueMap } from "./draft";

interface TargetsSectionProps {
  value: TargetConfig[];
  onChange: (v: TargetConfig[]) => void;
  issues: IssueMap;
}

interface Row {
  t: TargetConfig;
  index: number;
}

const MAX_TARGETS = 64;

function intervalText(ms: number): string {
  return ms >= 60_000 ? `${fmtNumber(ms / 60_000, ms % 60_000 === 0 ? 0 : 1)} min` : `${fmtNumber(ms / 1000, ms % 1000 === 0 ? 0 : 2)} s`;
}

export function TargetsSection({ value, onChange, issues }: TargetsSectionProps) {
  const [adding, setAdding] = useState(false);
  const patch = (index: number, p: Partial<TargetConfig>) => onChange(value.map((t, i) => (i === index ? { ...t, ...p } : t)));
  const rows: Row[] = value.map((t, index) => ({ t, index }));
  const activeCount = value.filter((t) => t.enabled).length;
  const customCount = value.filter((t) => !t.builtin).length;

  const columns: Column<Row>[] = [
    {
      key: "on",
      header: "Aktiv",
      width: "4.5rem",
      render: ({ t, index }) => (
        <Switch
          id={`tg-on-${t.id}`}
          checked={t.enabled}
          onChange={(e) => patch(index, { enabled: e.target.checked })}
          label={<span className="sr-only">{t.name} messen</span>}
        />
      ),
    },
    {
      key: "name",
      header: "Ziel",
      render: ({ t, index }) => {
        const rowIssues = issuesUnder(issues, [`targets.${index}`]).filter(([p]) => !p.endsWith(".intervalMs") && !p.endsWith(".segment"));
        return (
          <div className="min-w-[13rem] py-1.5">
            <div className="flex items-center gap-2">
              <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: targetCssColor(t.id) }} />
              <span className="font-medium text-fg">{t.name}</span>
            </div>
            <div className="mt-0.5 pl-4 text-xs text-fg-3">
              {t.host.startsWith("$") ? (
                DYNAMIC_HOST_LABEL[t.host] ?? t.host
              ) : (
                <span className="np-num break-all">{t.host}</span>
              )}
            </div>
            {rowIssues.map(([p, i]) => (
              <p key={p} role="alert" className="mt-0.5 pl-4 text-xs text-crit">
                {i.message}
              </p>
            ))}
          </div>
        );
      },
    },
    {
      key: "segment",
      header: "Abschnitt",
      width: "12rem",
      render: ({ t, index }) =>
        t.builtin ? (
          <span className="whitespace-nowrap">{SHARED_SEGMENT_LABEL[t.segment]}</span>
        ) : (
          <Select
            aria-label={`Abschnitt für ${t.name}`}
            value={t.segment}
            onChange={(e) => patch(index, { segment: e.target.value as Segment })}
            className="min-w-[10rem]"
          >
            {SEGMENT_ORDER.map((s) => (
              <option key={s} value={s}>
                {SHARED_SEGMENT_LABEL[s]}
              </option>
            ))}
          </Select>
        ),
    },
    {
      key: "kind",
      header: "Methode",
      render: ({ t }) => (
        <span className="whitespace-nowrap">
          {KIND_LABEL[t.kind]}
          {t.port !== undefined && <span className="np-num text-fg-3"> :{t.port}</span>}
          <span className="np-num ml-1.5 text-xs text-fg-3">IPv{t.family}</span>
        </span>
      ),
    },
    {
      key: "interval",
      header: "Intervall",
      width: "8.5rem",
      align: "right",
      render: ({ t, index }) => {
        if (t.builtin) return <span className="np-num whitespace-nowrap text-fg">{intervalText(t.intervalMs)}</span>;
        const issue = issues[`targets.${index}.intervalMs`];
        const id = `tg-int-${t.id}`;
        return (
          <div className="flex flex-col items-end gap-0.5 py-1">
            <div className="relative w-28">
              <TextInput
                id={id}
                type="number"
                step="any"
                aria-label={`Intervall für ${t.name} in Sekunden`}
                aria-invalid={issue ? true : undefined}
                value={Number.isFinite(t.intervalMs) ? String(t.intervalMs / 1000) : ""}
                onChange={(e) => {
                  const n = e.target.value === "" ? Number.NaN : Number(e.target.value);
                  patch(index, { intervalMs: Number.isFinite(n) ? Math.round(n * 1000) : Number.NaN });
                }}
                className="h-8 pr-7 text-right"
              />
              <span aria-hidden className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-fg-3">
                s
              </span>
            </div>
            {issue && (
              <span role="alert" className="max-w-[10rem] text-right text-2xs text-crit">
                {issueText(issue, 1000, "s")}
              </span>
            )}
          </div>
        );
      },
    },
    {
      key: "actions",
      header: <span className="sr-only">Aktionen</span>,
      width: "3.5rem",
      align: "right",
      render: ({ t, index }) =>
        t.builtin ? (
          <span className="inline-grid size-7 place-items-center text-fg-4" title="Eingebautes Ziel – kann nur deaktiviert werden">
            <Lock aria-hidden className="size-3.5" strokeWidth={2} />
            <span className="sr-only">Eingebautes Ziel, kann nur deaktiviert werden</span>
          </span>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            icon={Trash2}
            aria-label={`${t.name} löschen`}
            onClick={() => onChange(value.filter((_, i) => i !== index))}
            className="text-crit hover:text-crit"
          />
        ),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-fg-3">
          <span className="np-num text-fg">{activeCount}</span> von <span className="np-num text-fg">{value.length}</span> Zielen aktiv
          {customCount > 0 && (
            <>
              , davon <span className="np-num text-fg">{customCount}</span> eigene
            </>
          )}
          . Eingebaute Ziele lassen sich nur deaktivieren.
        </p>
        <Button icon={Plus} onClick={() => setAdding(true)} disabled={value.length >= MAX_TARGETS}>
          Ziel hinzufügen
        </Button>
      </div>
      <DataTable columns={columns} rows={rows} rowKey={(r) => `${r.t.id}-${r.index}`} caption="Messziele" dense />
      <p className="text-xs text-fg-3">
        Tipp: Trage die IP-Adresse deines Spieleservers als eigenes Ziel ein (Methode passend zum Spiel, oft UDP oder TCP), dann misst Netzpuls
        direkt den Weg dorthin.
      </p>
      {adding && (
        <AddTargetDialog
          existingIds={value.map((t) => t.id)}
          onClose={() => setAdding(false)}
          onAdd={(t) => {
            onChange([...value, t]);
            setAdding(false);
          }}
        />
      )}
    </div>
  );
}
