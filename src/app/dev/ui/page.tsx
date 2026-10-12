import type { ReactNode } from "react";
import type { Metadata } from "next";
import { Activity, Cable, ChartColumn, ChartSpline, Gauge, Inbox, Table2, Unplug, Waves } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { HealthBadge, HealthDot } from "@/components/ui/HealthBadge";
import { KpiTile } from "@/components/ui/KpiTile";
import { PageHeader } from "@/components/ui/PageHeader";
import { Panel } from "@/components/ui/Panel";
import { Sparkline } from "@/components/ui/Sparkline";
import { ChartSkeleton, EmptyState, ErrorState, InlineProgress, KpiSkeleton, Refetching, Skeleton } from "@/components/ui/States";
import { Tabs } from "@/components/ui/Tabs";
import { EventStrip } from "@/components/viz/EventStrip";
import { EventTimeline } from "@/components/viz/EventTimeline";
import { FaultShareBar } from "@/components/viz/FaultShareBar";
import { FindingCard } from "@/components/viz/FindingCard";
import { HourHeatmap } from "@/components/viz/HourHeatmap";
import { LatencyChart } from "@/components/viz/LatencyChart";
import { LatencySeriesChart } from "@/components/viz/LatencySeriesChart";
import { LiveLatencyChart } from "@/components/viz/LiveLatencyChart";
import { LiveTopology } from "@/components/viz/LiveTopology";
import { LossChart } from "@/components/viz/LossChart";
import { SecondsChart } from "@/components/viz/SecondsChart";
import { SegmentTopology } from "@/components/viz/SegmentTopology";
import { HEATMAP_METRIC, heatmapCells, toChartEvent, toFindingView, toOutage, toTimelineEvent } from "@/lib/client/adapters";
import { secondsBreakdown, sparkFromSeries } from "@/lib/client/charts";
import {
  ConnectionProbe,
  DataStatePreview,
  HeatmapEChartDemo,
  InteractivePreview,
  LiveDemoChart,
  StatusBarPreview,
} from "@/lib/client/dev-preview";
import {
  DEMO_FROM,
  DEMO_NOW,
  DEMO_TOPOLOGY,
  DEMO_TOPOLOGY_DOWN,
  DEMO_TOPOLOGY_WLAN,
  demoEvents,
  demoFindings,
  demoHeatmap,
  demoSeconds,
  demoSeries,
} from "@/lib/client/demo-data";
import { fmtLinkSpeed, fmtLossPct, fmtMs, fmtMsValue, fmtNumber, fmtPctValue } from "@/lib/format";
import { rate, THRESHOLDS, type Severity } from "@/lib/health";

export const metadata: Metadata = {
  title: "Komponenten-Vorschau",
  robots: { index: false, follow: false },
};

function Section({ id, title, description, children }: { id: string; title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="flex scroll-mt-20 flex-col gap-4">
      <div>
        <h2 id={id} className="text-xl font-medium text-fg">
          {title}
        </h2>
        {description && <p className="mt-1 max-w-3xl text-sm text-fg-3">{description}</p>}
      </div>
      {children}
    </section>
  );
}

interface TargetRow {
  id: string;
  name: string;
  status: Severity;
  p50: number | null;
  p95: number | null;
  loss: number | null;
}

const TARGET_ROWS: TargetRow[] = [
  { id: "gw", name: "Router (Gateway)", status: "good", p50: 0.9, p95: 2.4, loss: 0 },
  { id: "isp6", name: "Kopfstation (CMTS)", status: "warn", p50: 12, p95: 61, loss: 0.8 },
  { id: "aftr", name: "DS-Lite-Gateway (AFTR)", status: "good", p50: 14, p95: 22, loss: 0.05 },
  { id: "cf4", name: "Cloudflare 1.1.1.1", status: "crit", p50: 19, p95: 140, loss: 1.6 },
];

const TARGET_COLUMNS: ReadonlyArray<Column<TargetRow>> = [
  {
    key: "name",
    header: "Ziel",
    render: (r) => (
      <span className="inline-flex items-center gap-2">
        <HealthDot status={r.status} />
        {r.name}
      </span>
    ),
  },
  { key: "p50", header: "Median", numeric: true, render: (r) => fmtMs(r.p50) },
  { key: "p95", header: "p95", numeric: true, render: (r) => fmtMs(r.p95) },
  { key: "loss", header: "Paketverlust", numeric: true, render: (r) => fmtLossPct(r.loss) },
  { key: "state", header: "Zustand", align: "right", render: (r) => <HealthBadge status={r.status} size="sm" /> },
];

const NAV_LINKS = [
  ["status", "Status"],
  ["statusleiste", "Statusleiste"],
  ["leitungsweg", "Leitungsweg"],
  ["kennzahlen", "Kennzahlen"],
  ["diagramme", "Diagramme"],
  ["heatmap", "Heatmap"],
  ["ereignisse", "Ereignisse"],
  ["befunde", "Befunde"],
  ["tabellen", "Tabellen & Tabs"],
  ["zustaende", "Zustände"],
  ["interaktion", "Formulare & Dialoge"],
] as const;

/** Interne Vorschau aller UI-/Viz-Bausteine mit Demodaten (für die visuelle Prüfung, nicht verlinkt). */
export default function UiPreviewPage() {
  const series = demoSeries();
  const seconds = demoSeconds();
  const heat = demoHeatmap();
  const events = demoEvents();
  const timeline = events.map(toTimelineEvent);
  const findings = demoFindings().map(toFindingView);
  const heatProps = heatmapCells(heat);
  const breakdown = secondsBreakdown(seconds.total);
  const nowIso = new Date(DEMO_NOW).toISOString();
  const dayFromIso = new Date(DEMO_NOW - 24 * 3_600_000).toISOString();
  const cf4 = series.series.cf4;
  const chartEvents = events.filter((e) => e.ts >= DEMO_FROM);
  const legacySeries = [
    { name: "Router", slot: 0, points: series.series.gw.ts.map((t, i) => [t, series.series.gw.avg[i]] as [number, number | null]) },
    { name: "1.1.1.1", slot: 1, points: cf4.ts.map((t, i) => [t, cf4.avg[i]] as [number, number | null]) },
  ];
  const legacyOutages = chartEvents.map(toOutage).filter((o) => o != null);
  const legacyEvents = chartEvents.filter((e) => e.type === "nic_link_down" || e.type === "note").map(toChartEvent);

  return (
    <>
      <PageHeader
        title="Komponenten-Vorschau"
        description="Alle Bausteine des Netzpuls-Designs mit Demodaten – zum visuellen Prüfen. Live-Bausteine nutzen die echte Mess-Engine."
        actions={
          <Button size="sm" variant="primary" icon={Gauge}>
            Speedtest starten
          </Button>
        }
      />
      <nav aria-label="Abschnitte der Vorschau" className="mb-8 flex flex-wrap gap-2">
        {NAV_LINKS.map(([id, label]) => (
          <a key={id} href={`#${id}`} className="rounded-full px-3 py-1 text-xs text-fg-2 ring-1 ring-inset ring-line hover:bg-raised hover:text-fg">
            {label}
          </a>
        ))}
      </nav>

      <div className="flex flex-col gap-12">
        <Section id="status" title="Status & Aktionen" description="Status immer mit Icon und Wort. Buttons: Verb + Objekt.">
          <Panel>
            <div className="flex flex-col gap-5">
              <div className="flex flex-wrap items-center gap-2">
                {(["good", "warn", "crit", "unknown", "info"] as const).map((s) => (
                  <HealthBadge key={s} status={s} />
                ))}
                {(["good", "warn", "crit", "unknown", "info"] as const).map((s) => (
                  <HealthBadge key={`sm-${s}`} status={s} size="sm" />
                ))}
                <HealthBadge status="warn" label="Link 100 Mbit/s" />
                <span className="inline-flex items-center gap-2 text-sm text-fg-2">
                  <HealthDot status="crit" /> Kritisch (Punkt + Text)
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="primary" icon={Gauge}>
                  Speedtest starten
                </Button>
                <Button>Bericht exportieren</Button>
                <Button variant="ghost">Abbrechen</Button>
                <Button variant="danger">Messdaten löschen</Button>
                <Button loading>Speichern</Button>
                <Button disabled>Deaktiviert</Button>
                <Button size="sm" icon={Activity}>
                  Klein
                </Button>
                <Button size="lg" variant="primary">
                  Groß
                </Button>
                <Button size="sm" icon={Unplug} aria-label="Nur Icon" />
              </div>
              <InlineProgress>Speedtest läuft … Download 312 Mbit/s</InlineProgress>
            </div>
          </Panel>
        </Section>

        <Section id="statusleiste" title="Statusleiste" description="Oben im Layout ist die Live-Variante eingebaut; hier alle Zustände mit Demodaten. Die Knöpfe zeigen nur eine Meldung.">
          <StatusBarPreview />
        </Section>

        <Section
          id="leitungsweg"
          title="Leitungsweg"
          description="Fünf Knoten: PC & Adapter – Router – Kopfstation (CMTS) – DS-Lite-Gateway (AFTR) – Ziele. Unter 48rem Containerbreite vertikal."
        >
          <Panel title="Live" description="Echte Live-Daten (letzte 60 s). Ohne laufenden Langzeittest: keine Daten." frame>
            <LiveTopology id="np-preview-live" />
          </Panel>
          <Panel title="Demo: Kabelnetz auffällig, Link nur 100 Mbit/s">
            <SegmentTopology id="np-demo-1" nodes={DEMO_TOPOLOGY.nodes} links={DEMO_TOPOLOGY.links} />
          </Panel>
          <Panel title="Demo: WLAN-Ausweichen" description="Ethernet-Link weg, Windows leitet den Verkehr über das WLAN.">
            <SegmentTopology id="np-demo-2" nodes={DEMO_TOPOLOGY_WLAN.nodes} links={DEMO_TOPOLOGY_WLAN.links} />
          </Panel>
          <Panel title="Demo: Link getrennt" description="Kabel gezogen, kein Ausweichen – dahinter keine Daten.">
            <SegmentTopology id="np-demo-3" nodes={DEMO_TOPOLOGY_DOWN.nodes} links={DEMO_TOPOLOGY_DOWN.links} showTunnel={false} />
          </Panel>
          <div className="grid max-w-3xl gap-4 sm:grid-cols-2">
            <Panel title="Schmal: WLAN-Ausweichen">
              <SegmentTopology id="np-demo-4" nodes={DEMO_TOPOLOGY_WLAN.nodes} links={DEMO_TOPOLOGY_WLAN.links} />
            </Panel>
            <Panel title="Schmal: Link getrennt">
              <SegmentTopology id="np-demo-5" nodes={DEMO_TOPOLOGY_DOWN.nodes} links={DEMO_TOPOLOGY_DOWN.links} showTunnel={false} />
            </Panel>
          </div>
        </Section>

        <Section id="kennzahlen" title="Kennzahlen">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
            <KpiTile label="Latenz zu 1.1.1.1" value={fmtMsValue(19)} unit="ms" status={rate(19, THRESHOLDS.rttMs)} icon={Activity} caption="Median, letzte 5 min">
              <Sparkline values={sparkFromSeries(cf4, "avg", 48)} label="Latenz der letzten 6 Stunden" />
            </KpiTile>
            <KpiTile label="Jitter" value={fmtNumber(3.1)} unit="ms" status="good" caption="letzte 5 min" delta={{ text: "+0,8 ms ggü. 7-Tage-Median", trend: "up", tone: "neutral" }} />
            <KpiTile label="Paketverlust" value={fmtPctValue(1.6)} unit="%" status="crit" caption="letzte 24 Stunden">
              <Sparkline values={sparkFromSeries(cf4, "lossPct", 48)} color="var(--np-chart-2)" label="Paketverlust der letzten 6 Stunden" />
            </KpiTile>
            <KpiTile label="Gestörte Sekunden" value={fmtNumber(breakdown.badPct, 1)} unit="%" status="warn" icon={Waves} caption="letzte 24 Stunden" />
            <KpiTile label="Link-Abbrüche Ethernet" value="2" status="crit" icon={Unplug} caption="heute, im Betrieb" />
            <KpiTile label="Linkgeschwindigkeit" value="100" unit="Mbit/s" status="warn" statusLabel="Zu langsam" icon={Cable} caption={`erwartet ${fmtLinkSpeed(1000)}`} />
          </div>
          <Panel title="Wo entstehen die gestörten Sekunden?" description="Summe der letzten 24 Stunden (Demo).">
            <FaultShareBar total={seconds.total} caption="Letzte 24 Stunden" />
          </Panel>
        </Section>

        <Section id="diagramme" title="Diagramme" description="Optionen entstehen im Browser aus den API-Formaten (charts.ts). Eine Größe je Diagramm, Farbe folgt dem Ziel.">
          <Panel
            title="Latenz je Ziel"
            description="LatencySeriesChart: Ø je Minute, Band Ø–p95 für den Router, Ereignisse, Zoom. Ziele aus verschiedenen Abschnitten: keine automatischen Schwellen."
          >
            <LatencySeriesChart data={series} targetIds={["gw", "isp6", "cf4"]} band="p95" events={chartEvents} zoom height={340} />
          </Panel>
          <div className="grid gap-4 xl:grid-cols-2">
            <Panel title="Latenz 1.1.1.1 mit Band min–max" description="Ein Ziel: Bereiche ohne Antwort rot hinterlegt (IPv4-Ausfall 22:22 Uhr).">
              <LatencySeriesChart data={series} targetIds={["cf4"]} band="minmax" events={chartEvents} yMax={160} height={280} />
            </Panel>
            <Panel title="Paketverlust" description="LossChart: Verlust je Minute in %, Schwellen aus der Konfiguration.">
              <LossChart data={series} targetIds={["cf4", "g4"]} events={chartEvents} height={280} />
            </Panel>
          </div>
          <Panel title="Gestörte Sekunden nach Abschnitt" description="SecondsChart: 15-min-Buckets, Farben = ordinale Segment-Rampe (nah hell, fern dunkel).">
            <SecondsChart data={seconds} height={300} />
          </Panel>
          <div className="grid gap-4 xl:grid-cols-2">
            <Panel title="Live-Latenz (echt)" description="LiveLatencyChart: Ringpuffer des Live-Streams, 1 Update/s.">
              <LiveLatencyChart height={240} />
            </Panel>
            <Panel title="Live-Latenz (Demo-Ringpuffer)" description="liveLatencyOption() mit erzeugten Samples – verlorene Pings als Lücke.">
              <LiveDemoChart />
            </Panel>
          </div>
          <Panel title="Design-Referenz: LatencyChart" description="Original-Komponente aus dem Designsystem, gespeist über toOutage()/toChartEvent().">
            <LatencyChart series={legacySeries} outages={legacyOutages} events={legacyEvents} from={DEMO_FROM} to={DEMO_NOW} height={260} />
          </Panel>
        </Section>

        <Section id="heatmap" title="Heatmap" description="Stunde × Tag aus /api/heatmap. Schraffur = keine Messung.">
          <Panel title="Paketverlust nach Tageszeit" description="HourHeatmap (CSS, druckbar) via heatmapCells() + HEATMAP_METRIC.">
            <HourHeatmap cells={heatProps.cells} days={heatProps.days} {...HEATMAP_METRIC[heat.metric]} />
          </Panel>
          <Panel title="ECharts-Variante" description="heatmapOption(): interaktiv, gleiche Skala.">
            <HeatmapEChartDemo />
          </Panel>
        </Section>

        <Section id="ereignisse" title="Ereignisse" description="NetEvent -> toTimelineEvent(): Abschnitt, Dauer, Beleg und Quelle werden aus den Details abgeleitet.">
          <div className="grid gap-4 xl:grid-cols-3">
            <Panel className="xl:col-span-2" title="24-Stunden-Streifen">
              <EventStrip events={timeline} from={dayFromIso} to={nowIso} />
            </Panel>
            <Panel title="Zeitleiste" bodyClassName="max-h-[420px] overflow-y-auto">
              <EventTimeline events={timeline} now={nowIso} />
            </Panel>
          </div>
        </Section>

        <Section id="befunde" title="Befunde" description="Diagnose-Befund (API) -> toFindingView().">
          <div className="grid gap-4 lg:grid-cols-3">
            {findings.map((f) => (
              <FindingCard key={f.id} finding={f} />
            ))}
          </div>
        </Section>

        <Section id="tabellen" title="Tabellen & Tabs">
          <Panel>
            <Tabs
              label="Ansicht"
              items={[
                { id: "tabelle", label: "Tabelle", icon: <Table2 aria-hidden className="size-4" />, count: TARGET_ROWS.length },
                { id: "latenz", label: "Latenz", icon: <ChartSpline aria-hidden className="size-4" /> },
                { id: "verlust", label: "Paketverlust", icon: <ChartColumn aria-hidden className="size-4" /> },
              ]}
              panels={{
                tabelle: <DataTable caption="Ziele mit Median, p95 und Paketverlust" columns={TARGET_COLUMNS} rows={TARGET_ROWS} rowKey={(r) => r.id} />,
                latenz: <LatencySeriesChart data={series} targetIds={["aftr", "g4"]} height={260} />,
                verlust: <LossChart data={series} targetIds={["g4"]} height={220} />,
              }}
            />
          </Panel>
        </Section>

        <Section id="zustaende" title="Zustände" description="Erstes Laden: Skeleton. Nachladen: altes Bild gedimmt. Leer: was fehlt + nächster Schritt. Fehler: Ursache + Lösung.">
          <DataStatePreview />
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <Panel>
              <EmptyState icon={Inbox} title="Noch keine Speedtests">
                Der erste geplante Test läuft um 21:12 Uhr.
              </EmptyState>
            </Panel>
            <Panel>
              <ErrorState message="Router nicht erreichbar (192.168.0.1). Prüfe das LAN-Kabel und versuche es erneut." />
            </Panel>
            <KpiSkeleton />
            <Panel>
              <div className="flex flex-col gap-3">
                <Skeleton className="w-40" />
                <ChartSkeleton height={120} />
                <Refetching active>
                  <p className="text-sm text-fg-2">Nachladen: Inhalt bleibt sichtbar (60 %).</p>
                </Refetching>
              </div>
            </Panel>
          </div>
        </Section>

        <Section id="interaktion" title="Formulare, Dialog & Meldungen">
          <InteractivePreview />
          <Panel title="Verbindung zur Mess-Engine" description="useLive() und useApi() gegen die echte API.">
            <ConnectionProbe />
          </Panel>
        </Section>
      </div>
    </>
  );
}
