"use client";

import { ArrowDownToLine, ArrowUpFromLine, Cable, Hourglass, Search, TriangleAlert, Waves } from "lucide-react";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { HealthBadge } from "@/components/ui/HealthBadge";
import { KpiTile } from "@/components/ui/KpiTile";
import { Panel } from "@/components/ui/Panel";
import { cn } from "@/lib/cn";
import { DASH, fmtDateTime, fmtMbit, fmtMbitValue, fmtMs, fmtMsValue, fmtPctValue, NBSP } from "@/lib/format";
import { toUiHealth } from "@/lib/health";
import { rateUi } from "@/lib/client/segment-health";
import type { Band } from "@/lib/shared/config";
import { BUFFERBLOAT_SCALE, GRADE_INFO, gradeHealth, gradeLabel, isLimitedByLink, linkLimitText } from "@/lib/shared/grading";
import type { SpeedtestResult } from "@/lib/shared/types";
import { PHASE_LABEL, rateTariff, tariffPct, TRIGGER_LABEL, type LayerRow, type SpeedEventInfo } from "./speed-utils";

interface LastResultProps {
  result: SpeedtestResult;
  info: SpeedEventInfo | null;
  /** neuester Test, falls dieser fehlgeschlagen ist (result = letzter erfolgreicher) */
  failed: SpeedtestResult | null;
  tariff: { name: string | null; downMbps: number | null; upMbps: number | null };
  bloatBand: Band;
}

function tariffCaption(pct: number | null, tariff: number | null): string {
  if (pct === null) return "Kein Tarif hinterlegt – in den Einstellungen eintragen, dann siehst du den Anteil.";
  return `${fmtPctValue(pct)}${NBSP}% des Tarifs (${fmtMbit(tariff)})`;
}

function plus(v: number | null): string {
  if (v === null) return DASH;
  return `${v >= 0 ? "+" : "−"}${fmtMsValue(Math.abs(v))}${NBSP}ms`;
}

const LAYER_COLUMNS: ReadonlyArray<Column<LayerRow>> = [
  { key: "label", header: "Messstelle", render: (r) => <span className="text-fg">{r.label}</span> },
  { key: "idle", header: "Leerlauf", numeric: true, render: (r) => fmtMs(r.idleMs) },
  { key: "down", header: "Download", numeric: true, render: (r) => <LayerCell base={r.idleMs} value={r.downloadMs} /> },
  { key: "up", header: "Upload", numeric: true, render: (r) => <LayerCell base={r.idleMs} value={r.uploadMs} /> },
];

function LayerCell({ base, value }: { base: number | null; value: number | null }) {
  if (value === null) return <>{DASH}</>;
  const rise = base !== null ? value - base : null;
  return (
    <span className="inline-flex flex-col items-end leading-tight">
      <span>{fmtMs(value)}</span>
      {rise !== null && <span className={cn("text-2xs", rise >= 15 ? "text-warn" : "text-fg-3")}>{plus(rise)}</span>}
    </span>
  );
}

/** Kennzahlen des letzten Tests + Bufferbloat-Note + Engpass. */
export function LastResult({ result: r, info, failed, tariff, bloatBand }: LastResultProps) {
  const downPct = tariffPct(r.downMbps, tariff.downMbps);
  const upPct = tariffPct(r.upMbps, tariff.upMbps);
  const limited = info?.limitedByLink ?? isLimitedByLink(r.downMbps, r.nicLinkMbps);
  const grade = r.grade;
  const gradeInfo = grade ? GRADE_INFO[grade] : null;
  const gradeStatus = toUiHealth(gradeHealth(grade));
  const bloatDownStatus = rateUi(r.bloatDownMs, bloatBand);
  const bloatUpStatus = rateUi(r.bloatUpMs, bloatBand);
  const bn = info?.bottleneck ?? null;

  return (
    <section aria-labelledby="last-result-title" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id="last-result-title" className="text-xl font-medium text-fg">
          Letztes Ergebnis
        </h2>
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-fg-3">
          <span className="np-num text-fg-2">{fmtDateTime(r.ts)}</span>
          {r.server && <span>{r.server}</span>}
          {info?.pop && <span className="np-num">Standort {info.pop}</span>}
          <span>{TRIGGER_LABEL[r.trigger]}</span>
        </p>
      </div>

      {failed && (
        <p role="status" className="flex items-start gap-2 rounded-[10px] bg-warn/10 px-3 py-2 text-sm text-fg-2 ring-1 ring-inset ring-warn/30">
          <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-warn" strokeWidth={2} />
          <span>
            Der neueste Test vom <span className="np-num">{fmtDateTime(failed.ts)}</span> ist fehlgeschlagen
            {failed.error ? <>: {failed.error}</> : null}. Angezeigt wird der letzte erfolgreiche Test.
          </span>
        </p>
      )}

      <div className="grid grid-cols-1 gap-3 min-[480px]:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-5">
        <KpiTile
          label="Download"
          icon={ArrowDownToLine}
          value={fmtMbitValue(r.downMbps)}
          unit="Mbit/s"
          status={rateTariff(downPct)}
          statusLabel={downPct === null ? "Kein Tarif" : undefined}
          caption={tariffCaption(downPct, tariff.downMbps)}
        >
          {limited && <HealthBadge status="warn" size="sm" label={linkLimitText(r.nicLinkMbps)} className="max-w-full" />}
        </KpiTile>
        <KpiTile
          label="Upload"
          icon={ArrowUpFromLine}
          value={fmtMbitValue(r.upMbps)}
          unit="Mbit/s"
          status={rateTariff(upPct)}
          statusLabel={upPct === null ? "Kein Tarif" : undefined}
          caption={tariffCaption(upPct, tariff.upMbps)}
        />
        <KpiTile
          label="Latenz im Leerlauf"
          icon={Hourglass}
          value={fmtMsValue(r.idleLatencyMs)}
          unit="ms"
          caption={r.idleJitterMs !== null ? `Jitter ${fmtMs(r.idleJitterMs)} – Grundwert ohne Last` : "Grundwert ohne Last"}
        />
        <KpiTile
          label="Latenz unter Last: Download"
          icon={ArrowDownToLine}
          value={fmtMsValue(r.loadedDownLatencyMs)}
          unit="ms"
          status={bloatDownStatus}
          caption={`${plus(r.bloatDownMs)} ggü. Leerlauf${r.loadedDownP95Ms !== null ? `, p95 ${fmtMs(r.loadedDownP95Ms)}` : ""}`}
        />
        <KpiTile
          label="Latenz unter Last: Upload"
          icon={ArrowUpFromLine}
          value={fmtMsValue(r.loadedUpLatencyMs)}
          unit="ms"
          status={bloatUpStatus}
          caption={`${plus(r.bloatUpMs)} ggü. Leerlauf${r.loadedUpP95Ms !== null ? `, p95 ${fmtMs(r.loadedUpP95Ms)}` : ""}`}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Panel
          title={
            <span className="flex items-center gap-2">
              <Waves aria-hidden className="size-4.5 text-fiber" strokeWidth={2} />
              Bufferbloat-Note
            </span>
          }
          description="Wie stark steigt die Latenz, wenn die Leitung voll ausgelastet ist?"
        >
          <div className="flex flex-wrap items-center gap-4">
            <span
              className={cn(
                "np-num grid size-20 shrink-0 place-items-center rounded-2xl text-4xl font-semibold ring-1 ring-inset",
                gradeStatus === "good" ? "bg-good/12 text-good ring-good/30" : gradeStatus === "warn" ? "bg-warn/12 text-warn ring-warn/30" : gradeStatus === "crit" ? "bg-crit/14 text-crit ring-crit/40" : "bg-unknown/12 text-unknown ring-unknown/25",
              )}
              aria-label={grade ? `Note ${grade}` : "Keine Note"}
            >
              {grade ?? DASH}
            </span>
            <div className="min-w-0 flex-1">
              <HealthBadge status={gradeStatus} label={grade ? gradeLabel(grade) : "Unbekannt"} />
              <p className="mt-2 text-sm text-fg-2">
                {gradeInfo ? gradeInfo.text : "Für diesen Test liegt keine Note vor – zu wenige Latenzproben unter Last."}
              </p>
              {info?.gradeIncreaseMs != null && (
                <p className="mt-1 text-xs text-fg-3">
                  Ausschlaggebend: <span className="np-num text-fg-2">{plus(info.gradeIncreaseMs)}</span> im Mittel beim{" "}
                  {info.gradePhase ? PHASE_LABEL[info.gradePhase] : "Test"}
                </p>
              )}
            </div>
          </div>
          <ul className="mt-4 grid grid-cols-3 gap-1.5 sm:grid-cols-6" aria-label="Notenskala">
            {BUFFERBLOAT_SCALE.map((s, i) => {
              const prev = i > 0 ? BUFFERBLOAT_SCALE[i - 1].belowMs : 0;
              const active = s.grade === grade;
              return (
                <li
                  key={s.grade}
                  className={cn(
                    "rounded-md px-2 py-1.5 text-center ring-1 ring-inset",
                    active ? "bg-fiber/15 text-fg ring-fiber/50" : "bg-raised/60 text-fg-3 ring-line",
                  )}
                  aria-current={active || undefined}
                >
                  <span className="np-num block text-sm font-semibold">{s.grade}</span>
                  <span className="np-num block text-2xs">
                    {Number.isFinite(s.belowMs) ? `${prev}–${s.belowMs}${NBSP}ms` : `ab ${prev}${NBSP}ms`}
                  </span>
                </li>
              );
            })}
          </ul>
          <p className="mt-3 text-xs text-fg-3">
            Bewertet wird der Anstieg der Latenz unter Last gegenüber dem Leerlauf (schlechtere Phase zählt). Puffern Router oder Kabelmodem
            zu viele Pakete, warten Spielpakete hinter Downloads – das spürst du als Lag, sobald jemand im Haushalt lädt oder hochlädt.
          </p>
        </Panel>

        <Panel
          title={
            <span className="flex items-center gap-2">
              <Search aria-hidden className="size-4.5 text-fiber" strokeWidth={2} />
              Engpass
            </span>
          }
          description="Wo staut sich der Verkehr unter Last? Ermittelt aus den Pings zu Router, Kopfstation und Zielen."
        >
          {info === null || !info.hasBottleneckField ? (
            <p className="text-sm text-fg-3">Zu diesem Test ist keine Engpass-Auswertung gespeichert.</p>
          ) : bn ? (
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <HealthBadge status="warn" label={bn.label} />
                {bn.phase && <span className="text-xs text-fg-3">beim {PHASE_LABEL[bn.phase]}</span>}
                {bn.riseMs !== null && <span className="np-num text-xs text-fg-2">{plus(bn.riseMs)}</span>}
              </div>
              {bn.text && <p className="text-sm text-fg-2">{bn.text}</p>}
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <HealthBadge status="good" label="Kein Engpass erkennbar" />
              <p className="text-sm text-fg-2">
                Keine Messstelle stieg unter Last deutlich an (mindestens <span className="np-num">15{NBSP}ms</span>). Die Leitung puffert
                kaum.
              </p>
            </div>
          )}
          {limited && (
            <p className="mt-3 flex items-start gap-2 text-sm text-fg-2">
              <Cable aria-hidden className="mt-0.5 size-4 shrink-0 text-warn" strokeWidth={2} />
              <span>
                Der Download erreicht fast die Linkgeschwindigkeit der Netzwerkkarte ({linkLimitText(r.nicLinkMbps)}). Prüfe Kabel und
                Stecker – ein Gigabit-Link sollte mit 1.000{NBSP}Mbit/s verbinden.
              </span>
            </p>
          )}
          {info && info.layers.length > 0 && (
            <DataTable
              className="mt-4"
              dense
              caption="Median der Latenz je Messstelle im Leerlauf und unter Last"
              columns={LAYER_COLUMNS}
              rows={info.layers}
              rowKey={(l) => l.id}
            />
          )}
        </Panel>
      </div>
    </section>
  );
}
