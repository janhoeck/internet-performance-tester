"use client";

import { ChevronRight, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { SHARED_SEGMENT_LABEL } from "@/lib/segments";
import { DEFAULT_CONFIG, type AppConfig, type Band } from "@/lib/shared/config";
import { GroupTitle, NumField, ProblemChip } from "./controls";
import { SEGMENT_ORDER, type IssueMap } from "./draft";

type Thresholds = AppConfig["thresholds"];

interface ThresholdsSectionProps {
  value: Thresholds;
  onChange: (v: Thresholds) => void;
  issues: IssueMap;
}

interface BandRowProps {
  id: string;
  label: string;
  unit: string;
  band: Band;
  onChange: (b: Band) => void;
  path: string;
  issues: IssueMap;
}

function BandRow({ id, label, unit, band, onChange, path, issues }: BandRowProps) {
  return (
    <fieldset className="grid min-w-0 grid-cols-2 items-start gap-3 border-b border-line py-3 last:border-b-0 sm:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)]">
      <legend className="sr-only">{label}</legend>
      <p aria-hidden className="col-span-2 pt-0 text-sm text-fg-2 sm:col-span-1 sm:pt-8">
        {label}
      </p>
      <NumField
        id={`${id}-good`}
        label="Gut bis"
        unit={unit}
        value={band.good}
        onChange={(v) => onChange({ ...band, good: v ?? Number.NaN })}
        issue={issues[`${path}.good`]}
      />
      <NumField
        id={`${id}-warn`}
        label="Auffällig bis"
        unit={unit}
        value={band.warn}
        onChange={(v) => onChange({ ...band, warn: v ?? Number.NaN })}
        issue={issues[`${path}.warn`]}
      />
    </fieldset>
  );
}

const METRIC_BANDS = [
  ["tail", "Ping-Spitzen (p99 minus Median)", "ms"],
  ["jitter", "Jitter", "ms"],
  ["loss", "Paketverlust", "%"],
  ["lagPerHour", "Pings ab 200 ms pro Stunde", "/h"],
  ["outagesPerDay", "Ausfälle pro Tag", "/Tag"],
  ["bufferbloat", "Bufferbloat (Anstieg unter Last)", "ms"],
] as const;

/** Bewertungsschwellen – standardmäßig eingeklappt, für Fortgeschrittene. */
export function ThresholdsSection({ value, onChange, issues }: ThresholdsSectionProps) {
  const errorCount = Object.entries(issues).filter(([p, i]) => p.startsWith("thresholds.") && !i.warning).length;
  const isDefault = JSON.stringify(value) === JSON.stringify(DEFAULT_CONFIG.thresholds);
  const set = <K extends keyof Thresholds>(k: K, v: Thresholds[K]) => onChange({ ...value, [k]: v });

  return (
    <details className="group">
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 rounded-[10px] px-1 py-1 text-sm text-fg-2 hover:text-fg focus-visible:outline-2 focus-visible:outline-fiber [&::-webkit-details-marker]:hidden">
        <ChevronRight aria-hidden className="size-4 text-fg-3 transition-transform group-open:rotate-90" strokeWidth={2} />
        <span className="font-medium text-fg">Schwellen anzeigen</span>
        <span className="text-fg-3">{isDefault ? "Standardwerte aktiv" : "angepasst"}</span>
        {errorCount > 0 && <ProblemChip count={errorCount} />}
      </summary>

      <div className="mt-4 flex flex-col gap-6">
        <p className="text-sm text-fg-3">
          Werte bis „gut“ gelten als Gut, bis „auffällig“ als Auffällig, darüber als Kritisch. Die Standardwerte stammen aus dem Messplan –
          ändere sie nur, wenn du weißt, warum.
        </p>

        <div>
          <GroupTitle>Latenz je Abschnitt (Median)</GroupTitle>
          <div>
            {SEGMENT_ORDER.map((seg) => (
              <BandRow
                key={seg}
                id={`th-lat-${seg}`}
                label={SHARED_SEGMENT_LABEL[seg]}
                unit="ms"
                band={value.latency[seg]}
                path={`thresholds.latency.${seg}`}
                issues={issues}
                onChange={(b) => set("latency", { ...value.latency, [seg]: b })}
              />
            ))}
          </div>
        </div>

        <div>
          <GroupTitle>Kennzahlen</GroupTitle>
          <div>
            {METRIC_BANDS.map(([k, label, unit]) => (
              <BandRow
                key={k}
                id={`th-${k}`}
                label={label}
                unit={unit}
                band={value[k]}
                path={`thresholds.${k}`}
                issues={issues}
                onChange={(b) => set(k, b)}
              />
            ))}
          </div>
        </div>

        <div>
          <GroupTitle>Ping-Spitzen erkennen</GroupTitle>
          <p className="mb-3 text-xs text-fg-3">
            Eine Ping-Spitze liegt vor, wenn ein Ping mindestens Median plus das k-Fache der Streuung (robust, MAD) und mindestens den
            Mindestabstand darüber liegt – oder die Lag-Schwelle erreicht.
          </p>
          {(
            [
              ["spikeLan", "Heimnetz (Router, PC)"],
              ["spikeWan", "Internet und Provider"],
            ] as const
          ).map(([k, label]) => (
            <fieldset key={k} className="mb-3 grid min-w-0 gap-3 sm:grid-cols-[minmax(0,1.3fr)_repeat(3,minmax(0,1fr))]">
              <legend className="sr-only">{label}</legend>
              <p aria-hidden className="text-sm text-fg-2 sm:pt-8">
                {label}
              </p>
              <NumField id={`th-${k}-k`} label="Faktor k" value={value[k].k} onChange={(v) => set(k, { ...value[k], k: v ?? Number.NaN })} issue={issues[`thresholds.${k}.k`]} />
              <NumField
                id={`th-${k}-delta`}
                label="Mindestabstand"
                unit="ms"
                value={value[k].minDeltaMs}
                onChange={(v) => set(k, { ...value[k], minDeltaMs: v ?? Number.NaN })}
                issue={issues[`thresholds.${k}.minDeltaMs`]}
              />
              <NumField
                id={`th-${k}-lag`}
                label="Lag-Schwelle"
                unit="ms"
                value={value[k].lagMs}
                onChange={(v) => set(k, { ...value[k], lagMs: v ?? Number.NaN })}
                issue={issues[`thresholds.${k}.lagMs`]}
              />
            </fieldset>
          ))}
        </div>

        <div>
          <GroupTitle>Ausfälle, Verlust-Bursts und Eigenlast</GroupTitle>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <NumField
              id="th-outage"
              label="Ausfall ab"
              unit="s"
              step={1}
              value={value.outageMinSec}
              onChange={(v) => set("outageMinSec", v ?? Number.NaN)}
              hint="ohne Antwort auf allen Internet-Zielen"
              issue={issues["thresholds.outageMinSec"]}
            />
            <NumField
              id="th-burst-n"
              label="Verlust-Burst ab"
              unit="Verluste"
              step={1}
              value={value.burstMinLosses}
              onChange={(v) => set("burstMinLosses", v ?? Number.NaN)}
              issue={issues["thresholds.burstMinLosses"]}
            />
            <NumField
              id="th-burst-win"
              label="innerhalb von"
              unit="s"
              step={1}
              value={value.burstWindowSec}
              onChange={(v) => set("burstWindowSec", v ?? Number.NaN)}
              issue={issues["thresholds.burstWindowSec"]}
            />
            <NumField
              id="th-selfload"
              label="Eigenlast ab"
              unit="%"
              value={value.selfLoadPct}
              onChange={(v) => set("selfLoadPct", v ?? Number.NaN)}
              hint="der Link- bzw. Tarifbandbreite"
              issue={issues["thresholds.selfLoadPct"]}
            />
          </div>
        </div>

        <div>
          <Button icon={RotateCcw} disabled={isDefault} onClick={() => onChange(structuredClone(DEFAULT_CONFIG.thresholds))}>
            Standardwerte wiederherstellen
          </Button>
        </div>
      </div>
    </details>
  );
}
