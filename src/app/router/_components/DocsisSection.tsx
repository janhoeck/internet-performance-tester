"use client";

import { useMemo } from "react";
import { AudioWaveform, ArrowDownToLine, ArrowUpFromLine, Ban, Gauge, Radio, Signal, Waves } from "lucide-react";
import type { RouterResponse } from "@/lib/shared/api-types";
import type { DocsisSnapshot } from "@/lib/shared/types";
import { rateLowerBound, rateSymmetric, VFKD, type Breaks3, type Breaks6, type DocsisGrade } from "@/lib/shared/docsis";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { HealthBadge, HealthDot } from "@/components/ui/HealthBadge";
import { KpiTile } from "@/components/ui/KpiTile";
import { Panel } from "@/components/ui/Panel";
import { EmptyState } from "@/components/ui/States";
import { EChart } from "@/components/viz/EChart";
import { DASH, fmtDateTime, fmtDb, fmtNumber, fmtRelative, NBSP } from "@/lib/format";
import { toUiHealth, worstKnownHealth, type Health } from "@/lib/health";
import { cn } from "@/lib/cn";
import { useNow } from "@/lib/use-now";
import { Note, Num } from "./bits";
import { aspectView, docsisKpis, dsPowerBreaks, dsSnrBreaks, toRows, type ChannelRow } from "./docsis-model";
import { axisRange, channelBarsOption, lowerBoundBands, symmetricBands, timeLinesOption, type ChannelBar } from "./router-charts";

const FAMILY_SHORT = { ds: "SC-QAM", ofdm: "OFDM", us: "SC-QAM", ofdma: "OFDMA" } as const;

function LockCell({ locked }: { locked: boolean | null }) {
  if (locked == null) return <span className="text-fg-3">{DASH}</span>;
  return (
    <span className="inline-flex items-center gap-1.5">
      <HealthDot status={locked ? "good" : "crit"} />
      {locked ? "gelockt" : "nicht gelockt"}
    </span>
  );
}

function RatingCell({ row }: { row: ChannelRow }) {
  return (
    <div className="flex min-w-[12rem] flex-col items-start gap-0.5 py-1.5">
      <HealthBadge status={row.health} size="sm" />
      {row.note && (row.health !== "good" || row.grade === "toleriert") && <span className="text-2xs leading-4 text-fg-3">{row.note}</span>}
    </div>
  );
}

const DS_COLUMNS: Column<ChannelRow>[] = [
  { key: "id", header: "Kanal", numeric: true, width: "4.5rem", render: (r) => r.ch.channelId ?? DASH },
  { key: "type", header: "Typ", width: "5rem", render: (r) => FAMILY_SHORT[r.family] },
  { key: "freq", header: "Frequenz", numeric: true, render: (r) => r.freqText },
  { key: "power", header: "Pegel", numeric: true, render: (r) => fmtDb(r.ch.powerDbmv, "dBmV") },
  {
    key: "snr",
    header: "SNR/MER",
    numeric: true,
    render: (r) => (
      <span title={r.requiredMer != null ? `benötigt für die Modulation: ${fmtDb(r.requiredMer)}` : undefined}>{fmtDb(r.ch.snrDb)}</span>
    ),
  },
  { key: "mod", header: "Modulation", render: (r) => <Num>{r.ch.modulation ?? DASH}</Num> },
  { key: "lock", header: "Lock", render: (r) => <LockCell locked={r.ch.locked} /> },
  { key: "rating", header: "Bewertung", render: (r) => <RatingCell row={r} /> },
];

const US_COLUMNS: Column<ChannelRow>[] = [
  { key: "id", header: "Kanal", numeric: true, width: "4.5rem", render: (r) => r.ch.channelId ?? DASH },
  { key: "type", header: "Typ", width: "5rem", render: (r) => FAMILY_SHORT[r.family] },
  { key: "freq", header: "Frequenz", numeric: true, render: (r) => r.freqText },
  {
    key: "power",
    header: "Pegel",
    numeric: true,
    render: (r) => (
      <span className="inline-flex flex-col items-end">
        <span>{fmtDb(r.ch.powerDbmv, "dBmV")}</span>
        {r.powerNorm != null && <span className="text-2xs text-fg-3">auf 6,4{NBSP}MHz: {fmtDb(r.powerNorm, "dBmV")}</span>}
      </span>
    ),
  },
  { key: "mod", header: "Modulation", render: (r) => <Num>{r.ch.modulation ?? DASH}</Num> },
  { key: "lock", header: "Status", render: (r) => <LockCell locked={r.ch.locked} /> },
  { key: "rating", header: "Bewertung", render: (r) => <RatingCell row={r} /> },
];

function BandLegend() {
  const items: { cls: string; label: string }[] = [
    { cls: "bg-good/35", label: "konform" },
    { cls: "bg-good/15", label: "toleriert" },
    { cls: "bg-warn/35", label: "Beseitigung binnen Monatsfrist" },
    { cls: "bg-crit/35", label: "sofortige Beseitigung" },
  ];
  return (
    <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-2xs text-fg-3" aria-label="Legende Vodafone-Richtwerte">
      {items.map((i) => (
        <li key={i.label} className="inline-flex items-center gap-1.5">
          <span aria-hidden className={cn("inline-block h-2.5 w-3.5 rounded-sm", i.cls)} />
          {i.label}
        </li>
      ))}
    </ul>
  );
}

/** Balken je Kanal; Farbe nur nach dem dargestellten Aspekt (Pegel bzw. Störabstand). */
function bars(
  rows: readonly ChannelRow[],
  pick: (r: ChannelRow) => number | null,
  dirLabel: string,
  aspects: readonly string[],
  rate: (v: number) => DocsisGrade,
): ChannelBar[] {
  return rows.map((r) => {
    const v = pick(r);
    const view = aspectView(r, aspects, v == null ? "unbekannt" : rate(v));
    return {
      label: r.start != null ? fmtNumber(r.start, 1) : String(r.ch.channelId ?? "?"),
      title: `${dirLabel} ${r.freqText}${r.ch.channelId != null ? ` (Kanal ${r.ch.channelId})` : ""}`,
      value: v,
      health: view.health,
      note: view.note,
    };
  });
}

const POWER_ASPECTS = ["power", "neighbour", "limit"] as const;
const SNR_ASPECTS = ["snr", "outlier"] as const;
const sym = (b: Breaks6) => (v: number) => rateSymmetric(v, b);
const lower = (a: Breaks3) => (v: number) => rateLowerBound(v, a);

function ChannelChart({ title, description, rows, kind }: { title: string; description: string; rows: readonly ChannelRow[]; kind: "dsPower" | "dsSnr" | "usPower" }) {
  const option = useMemo(() => {
    if (kind === "dsPower") {
      const { breaks } = dsPowerBreaks(rows);
      const values = rows.map((r) => r.ch.powerDbmv);
      const { lo, hi } = axisRange(values, breaks[0] - 2, breaks[5] + 2);
      return channelBarsOption({ bars: bars(rows, (r) => r.ch.powerDbmv, "DS", POWER_ASPECTS, sym(breaks)), unit: "dBmV", bands: symmetricBands(breaks, lo, hi), lo, hi });
    }
    if (kind === "dsSnr") {
      const { breaks } = dsSnrBreaks(rows);
      const values = rows.map((r) => r.ch.snrDb);
      const { lo, hi } = axisRange(values, breaks[0] - 4, breaks[2] + 9);
      return channelBarsOption({ bars: bars(rows, (r) => r.ch.snrDb, "DS", SNR_ASPECTS, lower(breaks)), unit: "dB", bands: lowerBoundBands(breaks, lo, hi), lo, hi });
    }
    const b = VFKD.usPowerScqam;
    const values = rows.map((r) => r.ch.powerDbmv);
    const { lo, hi } = axisRange(values, b[0] - 3, b[5] + 3);
    return channelBarsOption({ bars: bars(rows, (r) => r.ch.powerDbmv, "US", POWER_ASPECTS, sym(b)), unit: "dBmV", bands: symmetricBands(b, lo, hi), lo, hi });
  }, [rows, kind]);
  return (
    <Panel title={title} description={description}>
      {rows.length === 0 ? (
        <EmptyState icon={Signal} title="Keine Kanäle dieses Typs">
          Der Router meldet hier keine Werte.
        </EmptyState>
      ) : (
        <>
          <EChart option={option} ariaLabel={`${title}, je Kanal mit Vodafone-Richtwerten als Bänder`} height={220} />
          <BandLegend />
        </>
      )}
    </Panel>
  );
}

type History = RouterResponse["docsisHistory"];

function HistoryChart({
  title,
  history,
  kind,
  from,
  to,
}: {
  title: string;
  history: History;
  kind: "dsPower" | "dsSnr" | "usPower";
  from: number | null;
  to: number | null;
}) {
  const option = useMemo(() => {
    if (kind === "dsPower") {
      const b = VFKD.dsPower.qam256;
      const { lo, hi } = axisRange([...history.dsPowerMin, ...history.dsPowerMax], b[0] - 2, b[5] + 2);
      return timeLinesOption({
        ts: history.ts,
        lines: [
          { id: "min", name: "DS-Pegel min", values: history.dsPowerMin, slot: 0 },
          { id: "max", name: "DS-Pegel max", values: history.dsPowerMax, slot: 1 },
        ],
        unit: "dBmV",
        from,
        to,
        bands: symmetricBands(b, lo, hi),
        lo,
        hi,
      });
    }
    if (kind === "dsSnr") {
      const a = VFKD.dsSnr.qam256;
      const { lo, hi } = axisRange(history.dsSnrMin, a[0] - 4, a[2] + 9);
      return timeLinesOption({
        ts: history.ts,
        lines: [{ id: "snr", name: "DS-SNR/MER min", values: history.dsSnrMin, slot: 3 }],
        unit: "dB",
        from,
        to,
        bands: lowerBoundBands(a, lo, hi),
        lo,
        hi,
      });
    }
    const b = VFKD.usPowerScqam;
    const { lo, hi } = axisRange(history.usPowerMax, b[0] - 3, b[5] + 3);
    return timeLinesOption({
      ts: history.ts,
      lines: [{ id: "us", name: "US-Pegel max", values: history.usPowerMax, slot: 4 }],
      unit: "dBmV",
      from,
      to,
      bands: symmetricBands(b, lo, hi),
      lo,
      hi,
    });
  }, [history, kind, from, to]);
  return (
    <div className="min-w-0">
      <h3 className="mb-2 text-sm font-medium text-fg-2">{title}</h3>
      <EChart option={option} ariaLabel={`${title} im gewählten Zeitraum`} height={200} />
    </div>
  );
}

export function DocsisSection({
  docsis,
  history,
  from,
  to,
}: {
  docsis: DocsisSnapshot | null;
  history: History;
  from: number | null;
  to: number | null;
}) {
  const now = useNow(30_000);
  const ds = useMemo(() => (docsis ? toRows(docsis.ds) : []), [docsis]);
  const us = useMemo(() => (docsis ? toRows(docsis.us) : []), [docsis]);
  const k = useMemo(() => docsisKpis(ds, us), [ds, us]);
  const overall: Health = docsis ? toUiHealth(docsis.rating) : "unknown";
  const dsSc = useMemo(() => ds.filter((r) => r.family === "ds"), [ds]);
  const usSc = useMemo(() => us.filter((r) => r.family === "us"), [us]);
  const hasHistory = history.ts.length > 0;
  const issues = k.counts.crit + k.counts.warn;

  const powerHealth = worstKnownHealth(...dsSc.map((r) => r.health));
  const usHealth = worstKnownHealth(...usSc.map((r) => r.health));

  return (
    <section aria-labelledby="docsis-heading" className="flex flex-col gap-4">
      <div className="mt-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="docsis-heading" className="text-xl font-medium text-fg">
            Kabelanschluss (DOCSIS)
          </h2>
          <p className="mt-1 max-w-3xl text-sm text-fg-3">
            Signalwerte je Kanal, bewertet nach den Vodafone-Richtwerten. Kanäle mit schlechtem Störabstand oder Pegel am Limit erklären Paketverlust und
            Ping-Spitzen hinter dem Router.
          </p>
        </div>
        {docsis && (
          <p className="text-xs text-fg-3">
            Stand <Num className="text-fg-2">{fmtDateTime(docsis.ts)}</Num>
            {now != null && <span> ({fmtRelative(docsis.ts, now)})</span>}
          </p>
        )}
      </div>

      {docsis ? (
        <>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            <KpiTile
              label="Gesamtbewertung"
              value={fmtNumber(issues, 0)}
              unit={issues === 1 ? "Kanal auffällig" : "Kanäle auffällig"}
              status={overall}
              icon={AudioWaveform}
              caption={`${k.counts.good} von ${ds.length + us.length} Kanälen gut`}
            />
            <KpiTile
              label="Downstream-Kanäle"
              value={`${k.dsLocked}/${k.dsCount}`}
              unit="gelockt"
              icon={ArrowDownToLine}
              caption={k.ofdmCount > 0 ? `plus ${k.ofdmCount} OFDM-Block` : "kein OFDM-Block"}
              status={k.dsLocked < k.dsCount ? "warn" : k.dsCount > 0 ? "good" : "unknown"}
            />
            <KpiTile
              label="Upstream-Kanäle"
              value={fmtNumber(k.usCount, 0)}
              unit="SC-QAM"
              icon={ArrowUpFromLine}
              caption={k.ofdmaCount > 0 ? `plus ${k.ofdmaCount} OFDMA-Block` : "kein OFDMA-Block"}
            />
            <KpiTile
              label="DS-Pegel"
              value={k.dsPowerMin == null ? DASH : `${fmtNumber(k.dsPowerMin, 1).replace("-", "−")}–${fmtNumber(k.dsPowerMax, 1).replace("-", "−")}`}
              unit="dBmV"
              icon={Gauge}
              status={powerHealth}
              caption="SC-QAM, min. bis max."
            />
            <KpiTile label="DS-SNR min." value={fmtNumber(k.dsSnrMin, 1)} unit="dB" icon={Waves} caption="SC-QAM, schlechtester Kanal" />
            <KpiTile label="OFDM-MER min." value={fmtNumber(k.ofdmMerMin, 1)} unit="dB" icon={Radio} caption="bewertet gegen die Profil-Modulation" />
            <KpiTile label="US-Pegel max." value={fmtNumber(k.usPowerMax, 1)} unit="dBmV" icon={ArrowUpFromLine} status={usHealth} caption="SC-QAM, Sendepegel des Modems" />
            <KpiTile label="Codewort-Fehler" value="nicht verfügbar" icon={Ban} caption="Die Vodafone Station liefert keine Fehlerzähler." className="[&_.text-3xl]:text-lg" />
          </div>

          <Panel title="Bewertung der Leitung" actions={<HealthBadge status={overall} />}>
            {docsis.notes.length > 0 ? (
              <ul className="flex flex-col gap-2">
                {docsis.notes.map((n) => (
                  <li key={n}>
                    <Note tone={overall === "crit" ? "crit" : overall === "warn" ? "warn" : "info"}>{n}</Note>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-fg-2">Alle Kanäle liegen innerhalb der Vodafone-Richtwerte. Keine Auffälligkeiten bei Pegel, Störabstand, Lock oder Modulation.</p>
            )}
            <p className="mt-3 text-xs text-fg-3">
              Stufen nach der Vodafone-Servicetabelle: konform und toleriert gelten als gut, „Beseitigung binnen Monatsfrist“ als auffällig, „sofortige
              Beseitigung“ als kritisch. OFDM-MER wird gegen den Wert bewertet, den die genutzte Modulation braucht (4096QAM: 41{NBSP}dB, mit 3{NBSP}dB Reserve gut).
              Fehlerzähler (korrigierte/nicht korrigierbare Codewörter) liefert die Vodafone Station nicht – sie sind hier „nicht verfügbar“.
            </p>
          </Panel>

          <Panel title="Downstream" description={`${ds.length} Kanäle: SC-QAM (DOCSIS 3.0) und OFDM (DOCSIS 3.1)`}>
            <DataTable columns={DS_COLUMNS} rows={ds} rowKey={(r) => r.key} caption="Downstream-Kanäle mit Pegel, SNR/MER, Modulation, Lock und Bewertung" dense maxHeight="30rem" />
          </Panel>

          <Panel title="Upstream" description={`${us.length} Kanäle: SC-QAM und OFDMA`}>
            <DataTable columns={US_COLUMNS} rows={us} rowKey={(r) => r.key} caption="Upstream-Kanäle mit Pegel, Modulation und Bewertung" dense />
          </Panel>

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
            <ChannelChart
              title="Downstream-Pegel je Kanal"
              description={`SC-QAM nach Frequenz in MHz, Richtwerte ${dsPowerBreaks(dsSc).label}`}
              rows={dsSc}
              kind="dsPower"
            />
            <ChannelChart title="Downstream-SNR je Kanal" description={`SC-QAM nach Frequenz in MHz, Richtwerte ${dsSnrBreaks(dsSc).label}`} rows={dsSc} kind="dsSnr" />
            <ChannelChart title="Upstream-Pegel je Kanal" description="SC-QAM nach Frequenz in MHz; OFDMA siehe Tabelle" rows={usSc} kind="usPower" />
          </div>
        </>
      ) : (
        <Panel>
          <EmptyState icon={AudioWaveform} title="Noch keine DOCSIS-Werte">
            Die Mess-Engine fragt die Kanalwerte nach der Anmeldung am Router regelmäßig ab. Die erste Abfrage erscheint hier nach wenigen Minuten.
          </EmptyState>
        </Panel>
      )}

      <Panel title="DOCSIS-Verlauf" description="Zusammenfassung je Abfrage im gewählten Zeitraum – Sprünge zeigen Störungen oder Neueinmessungen der Leitung">
        {hasHistory ? (
          <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
            <HistoryChart title="Downstream-Pegel min./max." history={history} kind="dsPower" from={from} to={to} />
            <HistoryChart title="Downstream-SNR/MER min." history={history} kind="dsSnr" from={from} to={to} />
            <HistoryChart title="Upstream-Pegel max." history={history} kind="usPower" from={from} to={to} />
          </div>
        ) : (
          <EmptyState icon={AudioWaveform} title="Kein Verlauf im Zeitraum">
            Für diesen Zeitraum gibt es keine DOCSIS-Abfragen. Wähle einen längeren Zeitraum oder warte auf die nächste Abfrage.
          </EmptyState>
        )}
        {hasHistory && <BandLegend />}
      </Panel>
    </section>
  );
}
