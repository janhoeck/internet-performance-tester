"use client";

import { useMemo } from "react";
import Link from "next/link";
import { Info, SearchX } from "lucide-react";
import type {
  DiagnosisResponse,
  RouterResponse,
  SecondsResponse,
  SpeedtestsResponse,
  StatsResponse,
} from "@/lib/shared/api-types";
import type { DiagnosisReport } from "@/lib/shared/types";
import { PageHeader } from "@/components/ui/PageHeader";
import { Panel } from "@/components/ui/Panel";
import { TimeRangePicker } from "@/components/ui/TimeRangePicker";
import { SessionPicker } from "@/components/ui/SessionPicker";
import { ChartSkeleton, DataState, EmptyState, Skeleton } from "@/components/ui/States";
import { useApi } from "@/lib/client/use-api";
import { useLiveConnection } from "@/lib/client/live-store";
import { useTargets } from "@/lib/client/targets";
import { fmtInt, fmtPct } from "@/lib/format";
import { FamilyCompare } from "./FamilyCompare";
import { FindingItem } from "./FindingItem";
import { GamingScorePanel } from "./GamingScorePanel";
import { PathAttribution } from "./PathAttribution";
import { RuleChecks } from "./RuleChecks";
import { SecondsPanel } from "./SecondsPanel";
import { SegmentTable } from "./SegmentTable";
import { VerdictPanel } from "./VerdictPanel";
import { berlinDay, berlinHour, statOf } from "./helpers";
import type { RuleDataContext } from "./rules";
import { useEffectiveRange, useRangeQuery } from "./use-effective-range";

const PRESETS = ["session", "24h", "7d", "30d"] as const;

/** Abende (19–23 Uhr) mit mindestens 30 min Messung (aus stündlichen Sekunden-Buckets). */
function countEvenings(res: SecondsResponse | null): number {
  if (!res) return 0;
  const perDay = new Map<string, number>();
  for (const b of res.buckets) {
    const h = berlinHour(b.ts);
    if (h < 19 || h >= 23) continue;
    const d = berlinDay(b.ts);
    perDay.set(d, (perDay.get(d) ?? 0) + b.covered);
  }
  let n = 0;
  for (const v of perDay.values()) if (v >= 1800) n++;
  return n;
}

const noMeasurement = (r: DiagnosisReport) => r.dataQuality.samples === 0 && (r.seconds?.covered ?? 0) === 0;

export function DiagnoseView() {
  const er = useEffectiveRange();
  const conn = useLiveConnection();
  const { config, targets } = useTargets();

  const query = useRangeQuery(er);

  const diag = useApi<DiagnosisResponse>(query ? `/api/diagnosis?${query}` : null);
  const stats = useApi<StatsResponse>(query ? `/api/stats?${query}` : null);
  const seconds = useApi<SecondsResponse>(query ? `/api/seconds?${query}&step=3600000` : null);
  const speed = useApi<SpeedtestsResponse>(query ? `/api/speedtests?${query}&limit=200` : null);
  const router = useApi<RouterResponse>(query ? `/api/router?${query}` : null);

  const gameIds = useMemo(() => targets.filter((t) => t.segment === "game").map((t) => t.id), [targets]);

  const ctx: RuleDataContext | null = useMemo(() => {
    const d = diag.data;
    if (!d) return null;
    const st = stats.data?.stats ?? null;
    const sent = (id: string) => statOf(st, id)?.sent ?? 0;
    const r = router.data;
    return {
      coveredSeconds: d.seconds?.covered ?? 0,
      evenings: countEvenings(seconds.data),
      speedtests: speed.data?.items.length ?? 0,
      tariffSet: config?.tariff.downMbps != null,
      docsisAvailable: r != null && (r.status?.docsis != null || r.docsisHistory.ts.length > 0),
      ipv6Samples: sent("cf6") + sent("g6"),
      gameSamples: gameIds.reduce((a, id) => a + sent(id), 0),
      cmtsSamples: sent("isp6"),
      badSeconds: d.seconds?.bad ?? 0,
    };
  }, [diag.data, stats.data, seconds.data, speed.data, router.data, config, gameIds]);

  const findings = useMemo(() => (diag.data ? [...diag.data.findings].sort((a, b) => b.score - a.score) : []), [diag.data]);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Diagnose"
        description="Die wahrscheinlichste Ursache der Lags – mit Belegen aus den Messungen und konkreten Empfehlungen."
        actions={
          <>
            <TimeRangePicker range={er.range} presets={PRESETS} />
            <SessionPicker range={er.range} />
          </>
        }
        className="mb-2"
      />

      {er.fallback && (
        <p className="flex items-start gap-2 text-sm text-fg-3">
          <Info aria-hidden className="mt-0.5 size-4 shrink-0 text-info" strokeWidth={2} />
          Noch kein Langzeittest vorhanden – ausgewertet werden die letzten 24 Stunden. Starte einen Langzeittest (empfohlen 72 Stunden), damit die Diagnose sicher wird.
        </p>
      )}

      <DataState
        result={diag}
        height={260}
        skeleton={
          <div className="np-panel flex flex-col gap-3 p-5" aria-busy="true" aria-label="Diagnose wird berechnet">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-7 w-2/3" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-5/6" />
            <p className="mt-2 text-xs text-fg-3">Die Diagnose wertet alle Messwerte des Zeitraums aus – das dauert einige Sekunden.</p>
          </div>
        }
      >
        {(d) => <VerdictPanel report={d} engineOnline={conn.online || conn.status === "idle" || conn.status === "connecting"} rangeLabel={er.label} />}
      </DataState>

      {diag.data && noMeasurement(diag.data) ? (
        <Panel>
          <EmptyState icon={SearchX} title="Keine Messdaten im Zeitraum">
            Im gewählten Zeitraum lief keine Messung. Starte auf dem{" "}
            <Link href="/" className="text-fiber underline-offset-4 hover:underline">
              Live-Dashboard
            </Link>{" "}
            einen Langzeittest oder wähle einen anderen Zeitraum.
          </EmptyState>
        </Panel>
      ) : (
        <>
          <Panel frame title="Leitungsweg" description="Zustand jedes Abschnitts im Zeitraum und wo die gestörten Sekunden entstehen.">
            <DataState result={diag} height={320}>
              {(d) => <PathAttribution report={d} stats={stats.data?.stats ?? null} />}
            </DataState>
          </Panel>

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-5">
            <Panel
              title="Gestörte Sekunden"
              description="Jede gemessene Sekunde wird einem Abschnitt zugeordnet – der Abschnitt mit den meisten gestörten Sekunden ist die wahrscheinlichste Ursache."
              className="xl:col-span-3"
            >
              <DataState
                result={diag}
                height={300}
                isEmpty={(d) => !d.seconds || d.seconds.covered === 0}
                emptyTitle="Keine Sekunden-Auswertung"
                emptyText="Im Zeitraum lief kein Langzeittest mit sekündlichen Pings. Die Auswertung je Sekunde gibt es nur während eines Tests."
              >
                {(d) => <SecondsPanel report={d} />}
              </DataState>
            </Panel>

            <Panel
              title="Gaming-Score"
              description="Wie gut sich die Leitung im Zeitraum für Online-Spiele eignet und welcher Faktor Punkte kostet."
              className="xl:col-span-2"
            >
              <DataState
                result={diag}
                height={300}
                isEmpty={(d) => d.gamingScore == null}
                emptyTitle="Noch kein Gaming-Score"
                emptyText="Für den Score fehlen Pings zu den Internetzielen im Zeitraum. Er erscheint, sobald ein Langzeittest Messwerte liefert."
              >
                {(d) => (d.gamingScore ? <GamingScorePanel score={d.gamingScore} /> : null)}
              </DataState>
            </Panel>
          </div>

          <section aria-labelledby="np-diag-findings" className="mt-4 flex flex-col gap-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 id="np-diag-findings" className="font-display text-xl font-semibold text-fg">
                Befunde
              </h2>
              {diag.data && (
                <p className="text-sm text-fg-3">
                  <span className="np-num text-fg-2">{findings.length}</span> Befunde, sortiert nach Relevanz
                </p>
              )}
            </div>
            {diag.data ? (
              findings.length === 0 ? (
                <Panel>
                  <EmptyState title="Keine Befunde">
                    Keine Regel hat im Zeitraum etwas Auffälliges gefunden. Läuft der Test erst kurz, erscheinen Befunde nach etwa 24 Stunden Messung.
                  </EmptyState>
                </Panel>
              ) : (
                <div className="grid grid-cols-1 items-start gap-4 2xl:grid-cols-2">
                  {findings.map((f) => (
                    <FindingItem key={f.id} finding={f} />
                  ))}
                </div>
              )
            ) : (
              <DataState result={diag} height={240}>
                {() => null}
              </DataState>
            )}
          </section>

          <Panel title="Abschnitte" description="Zustand und Kennzahlen jedes Abschnitts vom PC bis zum Spieleserver." className="mt-4">
            <DataState result={diag} height={320} isEmpty={(d) => d.segments.length === 0} emptyTitle="Keine Abschnittsdaten" emptyText="Im Zeitraum liegen keine Messwerte vor.">
              {(d) => <SegmentTable segments={d.segments} />}
            </DataState>
          </Panel>

          <Panel
            title="IPv4 gegen IPv6"
            description="Dieselben Ziele über beide Protokolle: Ist nur IPv4 schlecht, liegt es am DS-Lite-Gateway von Vodafone."
          >
            <DataState
              result={stats}
              height={220}
              isEmpty={(s) => !statOf(s.stats, "cf4") && !statOf(s.stats, "cf6") && !statOf(s.stats, "g4") && !statOf(s.stats, "g6")}
              emptyTitle="Keine Pings zu Cloudflare und Google"
              emptyText="Im Zeitraum wurden die Internetziele nicht gemessen. Der Vergleich erscheint, sobald ein Langzeittest läuft."
            >
              {(s) => <FamilyCompare stats={s.stats} />}
            </DataState>
          </Panel>

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
            <Panel title="So wurde geprüft" description="Alle 20 Regeln der Auswertung und ihr Ergebnis im Zeitraum." className="xl:col-span-2">
              <DataState result={diag} height={400}>
                {(d) => (ctx ? <RuleChecks findings={d.findings} ctx={ctx} /> : <ChartSkeleton height={400} />)}
              </DataState>
            </Panel>

            <Panel title="Datenqualität" description="Wie belastbar die Auswertung ist.">
              <DataState result={diag} height={200}>
                {(d) => <DataQuality report={d} />}
              </DataState>
            </Panel>
          </div>
        </>
      )}
    </div>
  );
}

function DataQuality({ report }: { report: DiagnosisReport }) {
  const q = report.dataQuality;
  return (
    <div className="flex flex-col gap-4">
      <dl className="grid grid-cols-3 gap-3">
        <div className="min-w-0">
          <dt className="np-label">Messwerte</dt>
          <dd className="np-num mt-0.5 text-lg font-semibold text-fg">{fmtInt(q.samples)}</dd>
        </div>
        <div className="min-w-0">
          <dt className="np-label">Abdeckung</dt>
          <dd className="np-num mt-0.5 text-lg font-semibold text-fg">{fmtPct(q.coveragePct)}</dd>
        </div>
        <div className="min-w-0">
          <dt className="np-label">Messlücken</dt>
          <dd className="np-num mt-0.5 text-lg font-semibold text-fg">{fmtInt(q.gaps)}</dd>
        </div>
      </dl>
      <div aria-hidden className="h-2 overflow-hidden rounded-full bg-sunken ring-1 ring-inset ring-line">
        <span className="block h-full rounded-full bg-fiber" style={{ width: `${Math.max(0, Math.min(100, q.coveragePct))}%` }} />
      </div>
      {q.notes.length > 0 ? (
        <ul className="flex flex-col gap-2 text-sm text-fg-2">
          {q.notes.map((n, i) => (
            <li key={i} className="flex gap-2">
              <Info aria-hidden className="mt-0.5 size-4 shrink-0 text-info" strokeWidth={2} />
              <span>{n}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-fg-3">Keine Einschränkungen – der Zeitraum ist vollständig gemessen.</p>
      )}
      <p className="text-xs text-fg-3">
        Router-Passwort und Tarif trägst du unter{" "}
        <Link href="/einstellungen" className="text-fiber underline-offset-4 hover:underline">
          Einstellungen
        </Link>{" "}
        ein. Abdeckung = gemessene Minuten im Verhältnis zum Zeitraum.
      </p>
    </div>
  );
}
