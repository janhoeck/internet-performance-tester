import Link from "next/link";
import type { ReactNode } from "react";
import { ChevronRight, Crosshair, Lightbulb, ShieldCheck } from "lucide-react";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { HealthBadge } from "@/components/ui/HealthBadge";
import { Panel } from "@/components/ui/Panel";
import { SegmentTopology, type SegmentTopologyProps } from "@/components/viz/SegmentTopology";
import { cn } from "@/lib/cn";
import { HEALTH_ICON, HEALTH_LABEL, HEALTH_TEXT } from "@/lib/health";
import { FAULT_CLASS_BY_ID } from "@/lib/segments";
import { hostOsFrom } from "@/lib/shared/platform";
import {
  ANALYSIS_SUMMARY,
  DOCSIS_NOTE,
  DOCSIS_ROWS,
  DOCSIS_SOURCE,
  eventRowsFor,
  FINDINGS,
  FIX_PROOF_TEXT,
  GOAL,
  HYPOTHESES,
  KPI_ROWS,
  MEASURE_GROUPS,
  measureRowsFor,
  PLAN_META,
  PRINCIPLE,
  PRINCIPLE_TEXT_MAC,
  PROCEDURE,
  RETENTION_NOTE,
  RETENTION_ROWS,
  RULES,
  SCORE_TEXT,
  SECOND_CLASSES,
  THROUGHPUT_ROWS,
  type DocsisRow,
  type HypothesisRow,
  type KpiRow,
  type MeasureRow,
  type PlanFinding,
  type Rating,
  type RuleRow,
  type SecondClassRow,
} from "../_content/plan";

/* Server-Komponenten: reine Darstellung der Inhalte aus _content/plan.ts. */

export function PlanSection({ id, title, description, children }: { id: string; title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <div id={id} className="scroll-mt-20">
      <Panel title={title} description={description}>
        {children}
      </Panel>
    </div>
  );
}

function Ratings({ items }: { items: readonly Rating[] }) {
  return (
    <ul className="flex min-w-[9rem] flex-col gap-0.5 py-1.5">
      {items.map((r, i) => {
        if (!r.status) return <li key={i} className="text-fg-3">{r.text}</li>;
        const Icon = HEALTH_ICON[r.status];
        return (
          <li key={i} className="flex items-start gap-1.5">
            <Icon aria-hidden className={cn("mt-0.5 size-3.5 shrink-0", HEALTH_TEXT[r.status])} strokeWidth={2.25} />
            <span>
              <span className="sr-only">{HEALTH_LABEL[r.status]}: </span>
              {r.text}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

const cell = "py-1.5 leading-snug";

// ─── Ziel ──────────────────────────────────────────────────────────────────

export function GoalSection() {
  return (
    <PlanSection id="ziel" title="Ziel">
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:gap-6">
        <span className="grid size-11 shrink-0 place-items-center rounded-full bg-fiber/12 text-fiber ring-1 ring-inset ring-fiber/30">
          <Crosshair aria-hidden className="size-5" strokeWidth={2} />
        </span>
        <div className="min-w-0 max-w-3xl">
          <p className="font-display text-lg font-medium text-fg">{GOAL.title}</p>
          <p className="mt-2 text-sm text-fg-2">{GOAL.text}</p>
          <dl className="mt-4 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-xs text-fg-3">Stand</dt>
              <dd className="np-num text-fg">{PLAN_META.asOf}</dd>
            </div>
            <div>
              <dt className="text-xs text-fg-3">PC</dt>
              <dd className="text-fg">{PLAN_META.pc}</dd>
            </div>
            <div>
              <dt className="text-xs text-fg-3">Anschluss</dt>
              <dd className="text-fg">{PLAN_META.line}</dd>
            </div>
            <div>
              <dt className="text-xs text-fg-3">Router</dt>
              <dd className="text-fg">
                {PLAN_META.router} unter <span className="np-num">{PLAN_META.routerIp}</span>
              </dd>
            </div>
          </dl>
        </div>
      </div>
    </PlanSection>
  );
}

// ─── Ist-Analyse ───────────────────────────────────────────────────────────

const findingColumns: Column<PlanFinding>[] = [
  {
    key: "status",
    header: "Bewertung",
    width: "8.5rem",
    render: (f) => <HealthBadge status={f.status} size="sm" />,
  },
  {
    key: "finding",
    header: "Befund",
    render: (f) => (
      <div className={cn(cell, "min-w-[16rem]")}>
        <p className="font-medium text-fg">{f.lead}</p>
        <p className="mt-0.5 text-fg-2">{f.text}</p>
      </div>
    ),
  },
  {
    key: "verdict",
    header: "Einordnung",
    render: (f) => <p className={cn(cell, "min-w-[12rem] text-fg-2")}>{f.verdict}</p>,
  },
];

export function AnalysisSection() {
  return (
    <PlanSection id="ist-analyse" title="Ist-Analyse" description={`Voruntersuchung vom ${PLAN_META.asOf} – Ausgangslage für den Langzeittest.`}>
      <div className="mb-5 rounded-[10px] bg-raised/50 px-4 py-4 ring-1 ring-inset ring-line">
        <p className="font-medium text-fg">Kernaussage: {ANALYSIS_SUMMARY.title}</p>
        <ol className="mt-2 grid gap-2 md:grid-cols-2">
          {ANALYSIS_SUMMARY.problems.map((p) => (
            <li key={p.n} className="flex items-start gap-3 text-sm text-fg-2">
              <span className="np-num grid size-6 shrink-0 place-items-center rounded-full bg-crit/12 text-xs font-semibold text-crit ring-1 ring-inset ring-crit/35">
                {p.n}
              </span>
              <span className="pt-0.5">{p.text}</span>
            </li>
          ))}
        </ol>
      </div>
      <DataTable columns={findingColumns} rows={FINDINGS} rowKey={(f) => f.lead} caption="Befunde der Voruntersuchung" />
    </PlanSection>
  );
}

// ─── Messprinzip ───────────────────────────────────────────────────────────

const SCHEMA: Pick<SegmentTopologyProps, "nodes" | "links"> = {
  nodes: {
    pc: { health: "good", sublabel: "Link-Status", detail: "Ausgangsschnittstelle" },
    router: { health: "good", sublabel: "Ping IPv4 und IPv6", detail: "Router-DNS, TCP 80" },
    cmts: { health: "good", sublabel: "Ping 1. IPv6-Hop", detail: "DOCSIS-Werte" },
    aftr: { health: "good", sublabel: "Ping AFTR (IPv6)", detail: "1. IPv4-Hop" },
    targets: { health: "good", sublabel: "Cloudflare, Google", detail: "AWS (TCP)" },
  },
  links: {
    lan: { health: "good", rttMs: 2, lossPct: 0 },
    docsis: { health: "good", rttMs: 15, lossPct: 0.1 },
    backbone: { health: "good", rttMs: 25, lossPct: 0.1 },
    internet: { health: "good", rttMs: 40, lossPct: 0.1 },
  },
};

const classColumns: Column<SecondClassRow>[] = [
  {
    key: "cls",
    header: "Klasse",
    width: "9rem",
    render: (r) => {
      const def = r.faultId ? FAULT_CLASS_BY_ID[r.faultId] : null;
      return (
        <span className="flex items-center gap-2 whitespace-nowrap">
          <span aria-hidden className={cn("size-2.5 shrink-0 rounded-sm", !def && "ring-1 ring-inset ring-line-control")} style={def ? { background: def.color } : undefined} />
          <span className={cn("font-medium", r.faultId ? "text-fg" : "text-fg-3")}>{r.cls}</span>
        </span>
      );
    },
  },
  { key: "cond", header: "Bedingung", render: (r) => <p className={cn(cell, "min-w-[16rem]")}>{r.condition}</p> },
  { key: "seg", header: "Abschnitt", render: (r) => <span className="whitespace-nowrap">{r.segment}</span> },
];

export function PrincipleSection() {
  return (
    <PlanSection id="messprinzip" title="Messprinzip" description="Abschnitt für Abschnitt, Sekunde für Sekunde.">
      <div className="flex flex-col gap-5">
        <SegmentTopology
          id="np-messplan"
          nodes={SCHEMA.nodes}
          links={SCHEMA.links}
          caption="Schema: an den Kacheln steht, was gemessen wird; an den Abschnitten die Richtwerte für Gut (Median bis Abschnittsende, maximaler Verlust)."
        />
        <p className="max-w-4xl text-sm text-fg-2">{hostOsFrom(process.platform) === "macos" ? PRINCIPLE_TEXT_MAC : PRINCIPLE.text}</p>
        <DataTable columns={classColumns} rows={SECOND_CLASSES} rowKey={(r) => r.cls} caption="Klassen der Sekunden-Zuordnung" dense />
        <p className="max-w-4xl text-sm text-fg-2">{PRINCIPLE.after}</p>
      </div>
    </PlanSection>
  );
}

// ─── Messwerte ─────────────────────────────────────────────────────────────

function measureColumns(ratingHeader = "Bewertung"): Column<MeasureRow>[] {
  return [
    {
      key: "metric",
      header: "Messwert",
      render: (r) => <p className={cn(cell, "min-w-[14rem]", r.key ? "font-medium text-fg" : "text-fg-2")}>{r.metric}</p>,
    },
    { key: "method", header: "Methode", render: (r) => <p className={cn(cell, "min-w-[11rem]")}>{r.method}</p> },
    { key: "interval", header: "Intervall", render: (r) => <p className={cn(cell, "np-num min-w-[6rem]")}>{r.interval}</p> },
    { key: "rating", header: ratingHeader, render: (r) => <Ratings items={r.rating} /> },
    { key: "purpose", header: "Aussage", render: (r) => <p className={cn(cell, "min-w-[11rem]")}>{r.purpose}</p> },
  ];
}

const kpiColumns: Column<KpiRow>[] = [
  { key: "name", header: "Kennzahl", render: (r) => <span className="whitespace-nowrap font-medium text-fg">{r.name}</span> },
  { key: "def", header: "Definition", render: (r) => <p className={cn(cell, "min-w-[16rem]")}>{r.definition}</p> },
  { key: "good", header: <Head status="good" />, render: (r) => <span className="np-num whitespace-nowrap">{r.good || "–"}</span> },
  { key: "warn", header: <Head status="warn" />, render: (r) => <span className="np-num whitespace-nowrap">{r.warn || "–"}</span> },
  { key: "bad", header: <Head status="crit" />, render: (r) => <span className="np-num whitespace-nowrap">{r.bad || "–"}</span> },
];

function Head({ status, label }: { status: "good" | "warn" | "crit"; label?: string }) {
  const Icon = HEALTH_ICON[status];
  return (
    <span className="inline-flex items-center gap-1">
      <Icon aria-hidden className={cn("size-3.5", HEALTH_TEXT[status])} strokeWidth={2.25} />
      {label ?? HEALTH_LABEL[status]}
      {label && <span className="sr-only"> ({HEALTH_LABEL[status]})</span>}
    </span>
  );
}

const eventColumns: Column<{ event: string; detection: string }>[] = [
  { key: "ev", header: "Ereignis", render: (r) => <p className={cn(cell, "min-w-[11rem] font-medium text-fg")}>{r.event}</p> },
  { key: "det", header: "Erkennung", render: (r) => <p className={cn(cell, "min-w-[16rem]")}>{r.detection}</p> },
];

function SubHeading({ num, children }: { num: string; children: ReactNode }) {
  return (
    <h3 className="mb-3 flex items-baseline gap-2 text-base font-medium text-fg">
      <span className="np-num text-sm text-fg-3">{num}</span>
      {children}
    </h3>
  );
}

export function MeasurementsSection() {
  return (
    <PlanSection
      id="messwerte"
      title="Messwerte im Detail"
      description="Intervall „Test“ = solange ein Langzeittest läuft; „immer“ = auch ohne Test (leichtgewichtig). Hervorgehoben sind die Kernmessungen."
    >
      <div className="flex flex-col gap-8">
        {MEASURE_GROUPS.map((g) => (
          <section key={g.id} aria-labelledby={`mw-${g.id}`}>
            <SubHeading num={g.num}>
              <span id={`mw-${g.id}`}>{g.title}</span>
            </SubHeading>
            <DataTable columns={measureColumns(g.ratingHeader)} rows={measureRowsFor(g.rows, hostOsFrom(process.platform))} rowKey={(r) => r.metric} caption={g.title} dense />
            {g.note && (
              <p className="mt-3 flex max-w-4xl items-start gap-2 text-sm text-fg-2">
                <ShieldCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-good" strokeWidth={2} />
                {g.note}
              </p>
            )}
          </section>
        ))}
        <section aria-labelledby="mw-kpi">
          <SubHeading num="3.6">
            <span id="mw-kpi">Kennzahlen je Ziel</span>
          </SubHeading>
          <DataTable columns={kpiColumns} rows={KPI_ROWS} rowKey={(r) => r.name} caption="Kennzahlen je Ziel" dense />
        </section>
        <section aria-labelledby="mw-durchsatz">
          <SubHeading num="3.7">
            <span id="mw-durchsatz">Durchsatz & Bufferbloat</span>
          </SubHeading>
          <DataTable columns={measureColumns()} rows={measureRowsFor(THROUGHPUT_ROWS, hostOsFrom(process.platform))} rowKey={(r) => r.metric} caption="Durchsatz und Bufferbloat" dense />
        </section>
        <section aria-labelledby="mw-ereignisse">
          <SubHeading num="3.8">
            <span id="mw-ereignisse">Ereignisse (automatisch erkannt)</span>
          </SubHeading>
          <DataTable columns={eventColumns} rows={eventRowsFor(hostOsFrom(process.platform))} rowKey={(r) => r.event} caption="Automatisch erkannte Ereignisse" dense />
        </section>
      </div>
    </PlanSection>
  );
}

// ─── DOCSIS ────────────────────────────────────────────────────────────────

const docsisColumns: Column<DocsisRow>[] = [
  { key: "v", header: "Wert", render: (r) => <p className={cn(cell, "min-w-[11rem] font-medium text-fg")}>{r.value}</p> },
  { key: "c", header: <Head status="good" label="Konform" />, render: (r) => <p className={cn(cell, "np-num min-w-[8rem]")}>{r.conform || "–"}</p> },
  { key: "t", header: <Head status="good" label="Toleriert" />, render: (r) => <p className={cn(cell, "np-num min-w-[8rem]")}>{r.tolerated || "–"}</p> },
  { key: "m", header: <Head status="warn" label="Monatsfrist" />, render: (r) => <p className={cn(cell, "np-num min-w-[8rem]")}>{r.month || "–"}</p> },
  { key: "k", header: <Head status="crit" label="Sofort" />, render: (r) => <p className={cn(cell, "np-num min-w-[8rem]")}>{r.critical || "–"}</p> },
];

export function DocsisSection() {
  return (
    <PlanSection id="docsis" title="DOCSIS-Richtwerte (Vodafone Kabel)" description={DOCSIS_SOURCE}>
      <DataTable columns={docsisColumns} rows={DOCSIS_ROWS} rowKey={(r) => r.value} caption="DOCSIS-Richtwerte" dense />
      <p className="mt-3 max-w-4xl text-sm text-fg-2">{DOCSIS_NOTE}</p>
      <p className="mt-2 text-sm">
        <Link href="/router" className="inline-flex items-center gap-1 text-fiber underline-offset-2 hover:underline">
          Aktuelle DOCSIS-Werte ansehen
          <ChevronRight aria-hidden className="size-3.5" strokeWidth={2} />
        </Link>
      </p>
    </PlanSection>
  );
}

// ─── Diagnose-Regeln ───────────────────────────────────────────────────────

const ruleColumns: Column<RuleRow>[] = [
  {
    key: "id",
    header: "Regel",
    width: "9.5rem",
    render: (r) => (
      <span className="flex flex-col py-1.5">
        <span className="np-num font-medium text-fg">{r.id}</span>
        <code className="np-num text-2xs text-fg-3">{r.slug}</code>
      </span>
    ),
  },
  { key: "trigger", header: "Auslöser (vereinfacht)", render: (r) => <p className={cn(cell, "min-w-[15rem]")}>{r.trigger}</p> },
  { key: "finding", header: "Befund und Empfehlung", render: (r) => <p className={cn(cell, "min-w-[15rem]", r.id === "R17" && "font-medium text-fg")}>{r.finding}</p> },
];

export function RulesSection() {
  return (
    <PlanSection
      id="diagnose-regeln"
      title="Diagnose-Regeln"
      description="Grundlage ist der Anteil gestörter Sekunden je Abschnitt. Jede Regel erzeugt einen Befund mit Schweregrad, Sicherheit, Belegen und Empfehlungen."
    >
      <DataTable columns={ruleColumns} rows={RULES} rowKey={(r) => r.id} caption="Diagnose-Regeln R01 bis R20" dense maxHeight="40rem" />
      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <p className="rounded-[10px] bg-raised/50 px-4 py-3 text-sm text-fg-2 ring-1 ring-inset ring-line">{SCORE_TEXT}</p>
        <p className="flex items-start gap-2 rounded-[10px] bg-raised/50 px-4 py-3 text-sm text-fg-2 ring-1 ring-inset ring-line">
          <Lightbulb aria-hidden className="mt-0.5 size-4 shrink-0 text-fiber" strokeWidth={2} />
          {FIX_PROOF_TEXT}
        </p>
      </div>
    </PlanSection>
  );
}

// ─── Datenhaltung ──────────────────────────────────────────────────────────

const retentionColumns: Column<{ data: string; resolution: string; keep: string }>[] = [
  { key: "d", header: "Daten", render: (r) => <p className={cn(cell, "min-w-[16rem]")}>{r.data}</p> },
  { key: "r", header: "Auflösung", render: (r) => <span className="np-num whitespace-nowrap">{r.resolution}</span> },
  { key: "k", header: "Aufbewahrung", render: (r) => <span className="np-num whitespace-nowrap text-fg">{r.keep}</span> },
];

export function RetentionPlanSection() {
  return (
    <PlanSection id="datenhaltung" title="Datenhaltung" description="Standardwerte – anpassbar unter Einstellungen, Datenhaltung.">
      <DataTable columns={retentionColumns} rows={RETENTION_ROWS} rowKey={(r) => r.data} caption="Datenhaltung" dense />
      <p className="mt-3 max-w-4xl text-sm text-fg-2">{RETENTION_NOTE}</p>
    </PlanSection>
  );
}

// ─── Ablauf ────────────────────────────────────────────────────────────────

export function ProcedureSection() {
  return (
    <PlanSection id="ablauf" title="Empfohlener Ablauf des Langzeittests">
      <ol className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
        {PROCEDURE.map((s, i) => (
          <li key={s.title} className="flex flex-col gap-2 rounded-[10px] bg-raised/50 p-4 ring-1 ring-inset ring-line">
            <span className="np-num grid size-7 place-items-center rounded-full bg-fiber/12 text-sm font-semibold text-fiber ring-1 ring-inset ring-fiber/30">{i + 1}</span>
            <p className="font-medium text-fg">{s.title}</p>
            <p className="text-sm text-fg-2">{s.text}</p>
            {s.href && (
              <Link href={s.href} className="mt-auto inline-flex items-center gap-1 pt-1 text-sm text-fiber underline-offset-2 hover:underline">
                {s.linkLabel}
                <ChevronRight aria-hidden className="size-3.5" strokeWidth={2} />
              </Link>
            )}
          </li>
        ))}
      </ol>
    </PlanSection>
  );
}

// ─── Hypothesen ────────────────────────────────────────────────────────────

const hypothesisColumns: Column<HypothesisRow>[] = [
  { key: "n", header: "Nr.", width: "3rem", numeric: true, render: (r) => r.n },
  { key: "h", header: "Hypothese", render: (r) => <p className={cn(cell, "min-w-[13rem]", r.key ? "font-medium text-fg" : "text-fg-2")}>{r.hypothesis}</p> },
  { key: "c", header: "Belegt durch", render: (r) => <p className={cn(cell, "min-w-[14rem]")}>{r.confirmedBy}</p> },
  { key: "r", header: "Widerlegt durch", render: (r) => <p className={cn(cell, "min-w-[12rem]")}>{r.refutedBy}</p> },
];

export function HypothesesSection() {
  return (
    <PlanSection id="hypothesen" title="Hypothesen für diesen Anschluss" description="Der Langzeittest soll jede dieser Annahmen belegen oder widerlegen. Hervorgehoben: die beiden Hauptverdächtigen.">
      <DataTable columns={hypothesisColumns} rows={HYPOTHESES} rowKey={(r) => String(r.n)} caption="Hypothesen" dense />
      <p className="mt-3 text-sm">
        <Link href="/diagnose" className="inline-flex items-center gap-1 text-fiber underline-offset-2 hover:underline">
          Zum aktuellen Stand in der Diagnose
          <ChevronRight aria-hidden className="size-3.5" strokeWidth={2} />
        </Link>
      </p>
    </PlanSection>
  );
}
