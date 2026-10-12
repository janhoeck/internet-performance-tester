"use client";

import { Fragment, useMemo, useState, type ReactNode } from "react";
import { ArrowLeftRight, CircleCheck, FlaskConical, Waypoints } from "lucide-react";
import type { DiagnosisResponse, EventsResponse, SecondsResponse, SessionsResponse, StatsResponse } from "@/lib/shared/api-types";
import type { SecondsRollup, TargetStats, TestSession } from "@/lib/shared/types";
import { useApi, type UseApiResult } from "@/lib/client/use-api";
import { sessionName } from "@/lib/client/sessions";
import type { TimeRange } from "@/lib/client/use-time-range";
import { shortTargetName, type TargetsInfo } from "@/lib/client/targets";
import { secondsBreakdown } from "@/lib/client/charts";
import { FAULT_CLASSES } from "@/lib/segments";
import { severityToUi } from "@/lib/health";
import { useNow } from "@/lib/use-now";
import { cn } from "@/lib/cn";
import { DASH, fmtDateTimeShort, fmtDurationMs, fmtLinkSpeed, fmtLossPct, fmtMs, fmtNumber, fmtPct, NBSP } from "@/lib/format";
import { Panel } from "@/components/ui/Panel";
import { Field, Select } from "@/components/ui/Field";
import { HealthBadge } from "@/components/ui/HealthBadge";
import { Button } from "@/components/ui/Button";
import { ChartSkeleton, EmptyState, ErrorState, Skeleton } from "@/components/ui/States";
import { FaultShareBar } from "@/components/viz/FaultShareBar";
import { betterOf } from "./stats-math";

type Side = "a" | "b";

interface SessionRange {
  session: TestSession;
  from: number;
  to: number;
  running: boolean;
}

function sessionRange(s: TestSession, now: number | null): SessionRange | null {
  const running = s.status === "running" && s.endedAt == null;
  const to = running ? now : (s.endedAt ?? s.plannedEndAt ?? now);
  if (to == null) return null;
  return { session: s, from: s.startedAt, to: Math.max(s.startedAt + 1000, to), running };
}

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

interface SideData {
  range: SessionRange | null;
  stats: UseApiResult<StatsResponse>;
  seconds: UseApiResult<SecondsResponse>;
  diagnosis: UseApiResult<DiagnosisResponse>;
}

function useSideData(range: SessionRange | null, ids: readonly string[]): SideData {
  const q = range ? `from=${range.from}&to=${range.to}` : null;
  const span = range ? range.to - range.from : 0;
  // eine Summe genügt: Schritt = ganzer Zeitraum (Vielfaches von 60 s)
  const step = Math.max(60_000, Math.ceil(span / 60_000) * 60_000);
  const refreshMs = range?.running ? 60_000 : 0;
  const stats = useApi<StatsResponse>(q && ids.length ? `/api/stats?targets=${ids.join(",")}&${q}` : null, { refreshMs });
  const seconds = useApi<SecondsResponse>(q ? `/api/seconds?step=${step}&${q}` : null, { refreshMs });
  const diagnosis = useApi<DiagnosisResponse>(q ? `/api/diagnosis?${q}` : null, { refreshMs: range?.running ? 5 * 60_000 : 0 });
  return { range, stats, seconds, diagnosis };
}

/** A/B-Vergleich zweier Langzeittests, z. B. altes gegen neues LAN-Kabel oder Kabel gegen WLAN. */
export function SessionCompare({ info, ids, range }: { info: TargetsInfo; ids: readonly string[]; range: TimeRange }) {
  const sessions = useApi<SessionsResponse>("/api/sessions", { refreshMs: 60_000 });
  const starts = useApi<EventsResponse>("/api/events?types=session_start&from=0&limit=500", { refreshMs: 5 * 60_000 });
  const now = useNow(60_000);
  const [pickA, setPickA] = useState<number | null>(null);
  const [pickB, setPickB] = useState<number | null>(null);

  const list = useMemo(() => {
    const items = [...(sessions.data?.items ?? [])];
    const active = sessions.data?.active;
    if (active && !items.some((s) => s.id === active.id)) items.push(active);
    return items.sort((x, y) => y.startedAt - x.startedAt);
  }, [sessions.data]);

  const byId = useMemo(() => new Map(list.map((s) => [s.id, s])), [list]);
  const sessA = (pickA != null ? byId.get(pickA) : undefined) ?? list[1] ?? null;
  const sessB = (pickB != null ? byId.get(pickB) : undefined) ?? list[0] ?? null;
  const rangeA = sessA ? sessionRange(sessA, now) : null;
  const rangeB = sessB ? sessionRange(sessB, now) : null;
  const a = useSideData(list.length >= 2 ? rangeA : null, ids);
  const b = useSideData(list.length >= 2 ? rangeB : null, ids);

  const contextOf = useMemo(() => {
    const m = new Map<number, Record<string, unknown>>();
    for (const e of starts.data?.events ?? []) {
      const d = rec(e.details);
      const id = num(d.sessionId);
      // bei fortgesetzten Tests zählt der erste Start
      if (id != null && (!m.has(id) || d.resumed !== true)) m.set(id, d);
    }
    return m;
  }, [starts.data]);

  const showInChart = (id: number) => {
    range.setSession(id);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const swap = () => {
    if (!sessA || !sessB) return;
    setPickA(sessB.id);
    setPickB(sessA.id);
  };

  // höhere Gaming-Punktzahl = besser (betterOf vergleicht "kleiner = besser")
  const scoreA = a.diagnosis.data?.gamingScore?.score;
  const scoreB = b.diagnosis.data?.gamingScore?.score;
  const scoreBetter = betterOf(scoreA != null ? -scoreA : null, scoreB != null ? -scoreB : null, 0.03, 1);

  let body: ReactNode;
  if (sessions.data == null && sessions.error) body = <ErrorState message={sessions.error.message} onRetry={sessions.reload} />;
  else if (sessions.data == null) body = <ChartSkeleton height={220} />;
  else if (list.length < 2)
    body = (
      <EmptyState icon={FlaskConical} title={list.length === 0 ? "Noch kein Langzeittest" : "Erst ein Langzeittest vorhanden"}>
        Für einen Vergleich brauchst du zwei Langzeittests – zum Beispiel einen mit dem alten und einen mit einem neuen LAN-Kabel. Starte den nächsten Test über die
        Statusleiste.
      </EmptyState>
    );
  else
    body = (
      <div className="flex flex-col gap-6">
        <div className="grid grid-cols-1 items-end gap-3 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
          <SessionSelect side="a" list={list} value={sessA?.id ?? null} onChange={setPickA} />
          <Button size="sm" variant="ghost" icon={ArrowLeftRight} onClick={swap} className="justify-self-start md:mb-1" aria-label="Test A und Test B tauschen">
            <span className="md:sr-only">Tauschen</span>
          </Button>
          <SessionSelect side="b" list={list} value={sessB?.id ?? null} onChange={setPickB} />
        </div>
        {sessA && sessB && sessA.id === sessB.id && <p className="text-sm text-warn">Du vergleichst denselben Test mit sich selbst. Wähle für A oder B einen anderen Test.</p>}

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <SessionCard side="a" data={a} context={sessA ? contextOf.get(sessA.id) : undefined} contextLoading={starts.data == null && starts.loading} onShow={showInChart} />
          <SessionCard side="b" data={b} context={sessB ? contextOf.get(sessB.id) : undefined} contextLoading={starts.data == null && starts.loading} onShow={showInChart} />
        </div>

        <CompareSection title="Kennzahlen je Ziel" description="Speedtest-Minuten sind herausgerechnet. Der bessere Wert ist grün mit Haken markiert (Abweichung unter 5 % gilt als gleich).">
          <TargetCompareTable a={a} b={b} ids={ids} info={info} />
        </CompareSection>

        <CompareSection title="Gestörte Sekunden" description="Anteil an der gemessenen Zeit, nach Abschnitt des Leitungswegs.">
          <SecondsCompare a={a} b={b} />
        </CompareSection>

        <CompareSection title="Einschätzung je Test" description="Ergebnis der Diagnose für den jeweiligen Testzeitraum. Die höhere Gaming-Note ist markiert.">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <VerdictCard side="a" result={a.diagnosis} better={scoreBetter === "a"} />
            <VerdictCard side="b" result={b.diagnosis} better={scoreBetter === "b"} />
          </div>
        </CompareSection>
      </div>
    );

  return (
    <Panel
      title="Vergleich zweier Tests (A/B)"
      description="Stelle zwei Langzeittests nebeneinander, zum Beispiel altes gegen neues LAN-Kabel oder Kabel gegen WLAN."
    >
      {body}
    </Panel>
  );
}

const SIDE_LABEL: Record<Side, string> = { a: "Test A", b: "Test B" };
const SIDE_TAG: Record<Side, string> = { a: "A", b: "B" };

function SideTag({ side }: { side: Side }) {
  return (
    <span
      aria-hidden
      className={cn(
        "grid size-5 shrink-0 place-items-center rounded-full font-mono text-2xs font-semibold ring-1 ring-inset",
        side === "a" ? "text-fiber ring-fiber/50" : "text-laser ring-laser/50",
      )}
    >
      {SIDE_TAG[side]}
    </span>
  );
}

function SessionSelect({ side, list, value, onChange }: { side: Side; list: readonly TestSession[]; value: number | null; onChange: (id: number) => void }) {
  const id = `np-ab-${side}`;
  return (
    <Field label={SIDE_LABEL[side]} htmlFor={id}>
      <Select id={id} value={value ?? ""} onChange={(e) => onChange(Number(e.target.value))}>
        {list.map((s) => {
          const running = s.status === "running" && s.endedAt == null;
          const dur = running ? "läuft" : fmtDurationMs((s.endedAt ?? s.plannedEndAt ?? s.startedAt) - s.startedAt);
          return (
            <option key={s.id} value={s.id}>
              {`${sessionName(s)} – ab ${fmtDateTimeShort(s.startedAt)}, ${dur}`}
            </option>
          );
        })}
      </Select>
    </Field>
  );
}

function CompareSection({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-3">
      <div>
        <h3 className="text-base font-medium text-fg">{title}</h3>
        {description && <p className="mt-0.5 text-xs text-fg-3">{description}</p>}
      </div>
      {children}
    </section>
  );
}

function KeyValue({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-3 border-b border-line py-1.5 last:border-b-0">
      <dt className="shrink-0 text-xs text-fg-3">{label}</dt>
      <dd className="min-w-0 text-right text-sm text-fg">{children}</dd>
    </div>
  );
}

function SessionCard({
  side,
  data,
  context,
  contextLoading,
  onShow,
}: {
  side: Side;
  data: SideData;
  context: Record<string, unknown> | undefined;
  contextLoading: boolean;
  onShow: (sessionId: number) => void;
}) {
  const r = data.range;
  if (!r) return <Skeleton className="h-40 w-full" />;
  const s = r.session;
  const coverage = data.stats.data?.stats.length ? Math.max(...data.stats.data.stats.map((x) => x.coveragePct)) : null;
  const isWifi = context ? context.isWifi === true : null;
  const iface = context ? (str(context.expectedIf) ?? str(context.primaryAdapter)) : null;
  const ssid = context ? str(context.ssid) : null;
  const band = context ? str(context.band) : null;
  const channel = context ? num(context.channel) : null;
  const signal = context ? num(context.signalPct) : null;
  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-[10px] bg-sunken/60 p-4 ring-1 ring-inset ring-line">
      <div className="flex min-w-0 items-center gap-2">
        <SideTag side={side} />
        <p className="truncate text-sm font-medium text-fg" title={sessionName(s)}>
          {sessionName(s)}
        </p>
        {r.running && <HealthBadge status="info" label="läuft" size="sm" className="ml-auto" />}
      </div>
      <dl className="flex flex-col">
        <KeyValue label="Zeitraum">
          <span className="np-num">
            {fmtDateTimeShort(r.from)} – {r.running ? "jetzt" : fmtDateTimeShort(r.to)}
          </span>
        </KeyValue>
        <KeyValue label="Dauer">
          <span className="np-num">{fmtDurationMs(r.to - r.from)}</span>
        </KeyValue>
        <KeyValue label="Abdeckung">
          <span className="np-num">{coverage != null ? fmtPct(coverage) : DASH}</span>
        </KeyValue>
        {contextLoading ? (
          <Skeleton className="my-2 h-4 w-full" />
        ) : context ? (
          <>
            <KeyValue label="Schnittstelle">
              <span className="np-num">{iface ?? DASH}</span>
              {isWifi != null && <span className="ml-1.5 text-xs text-fg-3">{isWifi ? "(WLAN)" : "(Kabel)"}</span>}
            </KeyValue>
            <KeyValue label="Link">
              <span className="np-num">{fmtLinkSpeed(num(context.linkMbps))}</span>
            </KeyValue>
            {(isWifi || ssid) && (
              <KeyValue label="WLAN">
                <span className="np-num">
                  {[ssid, band, channel != null ? `Kanal ${channel}` : null, signal != null ? `Signal ${fmtNumber(signal, 0)}${NBSP}%` : null]
                    .filter(Boolean)
                    .join(", ") || DASH}
                </span>
              </KeyValue>
            )}
          </>
        ) : (
          <p className="pt-1.5 text-xs text-fg-3">Keine Verbindungsdaten zum Start dieses Tests gespeichert.</p>
        )}
      </dl>
      <div className="mt-auto pt-1">
        <Button size="sm" variant="ghost" icon={Waypoints} onClick={() => onShow(s.id)}>
          Im Verlauf zeigen
        </Button>
      </div>
    </div>
  );
}

/** Wert mit Markierung, falls er der bessere ist. */
function Cell({ text, better }: { text: string; better: boolean }) {
  return (
    <span className={cn("inline-flex items-center justify-end gap-1", better ? "text-good" : "text-fg")}>
      {better && <CircleCheck aria-hidden className="size-3.5" strokeWidth={2.25} />}
      <span className="np-num">{text}</span>
      {better && <span className="sr-only">(besser)</span>}
    </span>
  );
}

interface MetricDef {
  key: string;
  label: string;
  value: (s: TargetStats) => number | null;
  fmt: (v: number | null) => string;
  eps: number;
}

const METRICS: readonly MetricDef[] = [
  { key: "p50", label: "p50", value: (s) => s.p50, fmt: fmtMs, eps: 0.2 },
  { key: "p95", label: "p95", value: (s) => s.p95, fmt: fmtMs, eps: 0.2 },
  { key: "p99", label: "p99", value: (s) => s.p99, fmt: fmtMs, eps: 0.2 },
  { key: "loss", label: "Verlust", value: (s) => s.lossPct, fmt: fmtLossPct, eps: 0.01 },
  { key: "jitter", label: "Jitter", value: (s) => s.jitter, fmt: fmtMs, eps: 0.2 },
];

function TableShell({ children }: { children: ReactNode }) {
  return (
    <div className="relative overflow-x-auto rounded-[10px] ring-1 ring-line">
      <table className="w-full min-w-[320px] border-separate border-spacing-0 text-sm">{children}</table>
    </div>
  );
}

function Th({ children, align = "right" }: { children: ReactNode; align?: "left" | "right" }) {
  return (
    <th
      scope="col"
      className={cn(
        "h-9 border-b border-line-strong bg-raised px-3 text-xs font-medium text-fg-3 font-stretch-semi-condensed",
        align === "left" ? "text-left" : "text-right",
      )}
    >
      {children}
    </th>
  );
}

function SideHeader({ side }: { side: Side }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <SideTag side={side} />
      {SIDE_LABEL[side]}
    </span>
  );
}

function TargetCompareTable({ a, b, ids, info }: { a: SideData; b: SideData; ids: readonly string[]; info: TargetsInfo }) {
  if (ids.length === 0) return <p className="text-sm text-fg-3">Wähle oben mindestens ein Ziel aus.</p>;
  const err = a.stats.error ?? b.stats.error;
  if ((a.stats.data == null || b.stats.data == null) && err) return <ErrorState message={err.message} onRetry={a.stats.error ? a.stats.reload : b.stats.reload} />;
  if (a.stats.data == null || b.stats.data == null) return <ChartSkeleton height={200} />;
  const mapA = new Map(a.stats.data.stats.map((s) => [s.targetId, s]));
  const mapB = new Map(b.stats.data.stats.map((s) => [s.targetId, s]));
  return (
    <TableShell>
      <caption className="sr-only">Kennzahlen je Ziel für Test A und Test B</caption>
      <thead>
        <tr>
          <Th align="left">Kennzahl</Th>
          <Th>
            <SideHeader side="a" />
          </Th>
          <Th>
            <SideHeader side="b" />
          </Th>
        </tr>
      </thead>
      <tbody>
        {ids.map((id) => {
          const sa = mapA.get(id);
          const sb = mapB.get(id);
          const noData = (!sa || sa.sent === 0) && (!sb || sb.sent === 0);
          return (
            <Fragment key={id}>
              <tr>
                <th scope="rowgroup" colSpan={3} className="border-b border-line bg-sunken/50 px-3 py-1.5 text-left text-xs font-medium text-fg-2">
                  {shortTargetName(id, info.targets)}
                  {noData && <span className="ml-2 font-normal text-fg-4">keine Messwerte in beiden Tests</span>}
                </th>
              </tr>
              {!noData &&
                METRICS.map((m) => {
                  const va = sa && sa.sent > 0 ? m.value(sa) : null;
                  const vb = sb && sb.sent > 0 ? m.value(sb) : null;
                  const better = betterOf(va, vb, 0.05, m.eps);
                  return (
                    <tr key={m.key} className="hover:bg-raised/60">
                      <th scope="row" className="h-8 border-b border-line px-3 text-left text-xs font-normal text-fg-3">
                        {m.label}
                      </th>
                      <td className="h-8 border-b border-line px-3 text-right">
                        <Cell text={m.fmt(va)} better={better === "a"} />
                      </td>
                      <td className="h-8 border-b border-line px-3 text-right">
                        <Cell text={m.fmt(vb)} better={better === "b"} />
                      </td>
                    </tr>
                  );
                })}
            </Fragment>
          );
        })}
      </tbody>
    </TableShell>
  );
}

function share(part: number, covered: number): number | null {
  return covered > 0 ? (part / covered) * 100 : null;
}

function SecondsCompare({ a, b }: { a: SideData; b: SideData }) {
  const err = a.seconds.error ?? b.seconds.error;
  if ((a.seconds.data == null || b.seconds.data == null) && err)
    return <ErrorState message={err.message} onRetry={a.seconds.error ? a.seconds.reload : b.seconds.reload} />;
  if (a.seconds.data == null || b.seconds.data == null) return <ChartSkeleton height={200} />;
  const ta: SecondsRollup = a.seconds.data.total;
  const tb: SecondsRollup = b.seconds.data.total;
  const ba = secondsBreakdown(ta);
  const bb = secondsBreakdown(tb);
  const rows: Array<{ key: string; label: string; va: number | null; vb: number | null; color?: string }> = [
    { key: "bad", label: "Gestört gesamt", va: ba.covered ? ba.badPct : null, vb: bb.covered ? bb.badPct : null },
    { key: "ses", label: "Stark gestört", va: share(ta.ses, ta.covered), vb: share(tb.ses, tb.covered) },
    ...FAULT_CLASSES.map((c) => ({ key: c.id, label: c.label, va: share(ta[c.id], ta.covered), vb: share(tb[c.id], tb.covered), color: c.color })),
  ];
  return (
    <div className="flex flex-col gap-4">
      <TableShell>
        <caption className="sr-only">Gestörte Sekunden in Prozent der gemessenen Zeit für Test A und Test B</caption>
        <thead>
          <tr>
            <Th align="left">Abschnitt</Th>
            <Th>
              <SideHeader side="a" />
            </Th>
            <Th>
              <SideHeader side="b" />
            </Th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row" className="h-8 border-b border-line px-3 text-left text-xs font-normal text-fg-3">
              Gemessene Zeit
            </th>
            <td className="h-8 border-b border-line px-3 text-right">
              <span className="np-num text-fg">{fmtDurationMs(ta.covered * 1000)}</span>
            </td>
            <td className="h-8 border-b border-line px-3 text-right">
              <span className="np-num text-fg">{fmtDurationMs(tb.covered * 1000)}</span>
            </td>
          </tr>
          {rows.map((r) => {
            const better = betterOf(r.va, r.vb, 0.05, 0.05);
            return (
              <tr key={r.key} className="hover:bg-raised/60">
                <th scope="row" className="h-8 border-b border-line px-3 text-left text-xs font-normal text-fg-3">
                  <span className="inline-flex items-center gap-2">
                    {r.color && <span aria-hidden className="size-2.5 shrink-0 rounded-[3px]" style={{ backgroundColor: r.color }} />}
                    {r.label}
                  </span>
                </th>
                <td className="h-8 border-b border-line px-3 text-right">
                  <Cell text={fmtPct(r.va)} better={better === "a"} />
                </td>
                <td className="h-8 border-b border-line px-3 text-right">
                  <Cell text={fmtPct(r.vb)} better={better === "b"} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </TableShell>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <FaultShareBar total={ta} caption="Test A" />
        <FaultShareBar total={tb} caption="Test B" />
      </div>
    </div>
  );
}

function VerdictCard({ side, result, better }: { side: Side; result: UseApiResult<DiagnosisResponse>; better: boolean }) {
  const d = result.data;
  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-[10px] bg-sunken/60 p-4 ring-1 ring-inset ring-line">
      <div className="flex items-center gap-2">
        <SideTag side={side} />
        <span className="text-xs text-fg-3">{SIDE_LABEL[side]}</span>
        {d && <HealthBadge status={severityToUi(d.verdict.severity)} size="sm" className="ml-auto" />}
      </div>
      {d ? (
        <>
          <p className="text-sm font-medium text-fg">{d.verdict.title}</p>
          <p className="text-xs leading-relaxed text-fg-3">{d.verdict.text}</p>
          {d.gamingScore && (
            <p className={cn("inline-flex flex-wrap items-center gap-x-1.5 text-xs", better ? "text-good" : "text-fg-3")}>
              {better && <CircleCheck aria-hidden className="size-3.5" strokeWidth={2.25} />}
              Gaming-Note <span className={cn("np-num font-medium", better ? "text-good" : "text-fg")}>{d.gamingScore.grade}</span>
              <span className="np-num text-fg-4">({fmtNumber(d.gamingScore.score, 0)} von 100 Punkten)</span>
              {better && <span className="sr-only">(besser)</span>}
            </p>
          )}
        </>
      ) : result.error ? (
        <ErrorState message={result.error.message} onRetry={result.reload} className="py-4" />
      ) : (
        <div className="flex flex-col gap-2">
          <Skeleton className="w-3/4" />
          <Skeleton className="w-full" />
          <Skeleton className="w-2/3" />
        </div>
      )}
    </div>
  );
}
