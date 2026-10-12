"use client";

import { useMemo, type ReactNode } from "react";
import Link from "next/link";
import { Download, FileJson, FlaskConical, Info, PlugZap, Printer, type LucideIcon } from "lucide-react";
import type {
  ClientResponse,
  DiagnosisResponse,
  EventsResponse,
  RouterResponse,
  SeriesResponse,
  SessionsResponse,
  SpeedtestsResponse,
  StatsResponse,
  TraceroutesResponse,
} from "@/lib/shared/api-types";
import type { DocsisChannel, NetEvent, TargetStats, TracerouteResult } from "@/lib/shared/types";
import { PageHeader } from "@/components/ui/PageHeader";
import { Button } from "@/components/ui/Button";
import { HealthBadge } from "@/components/ui/HealthBadge";
import { TimeRangePicker } from "@/components/ui/TimeRangePicker";
import { SessionPicker } from "@/components/ui/SessionPicker";
import { useApi } from "@/lib/client/use-api";
import { useLiveConnection } from "@/lib/client/live-store";
import { useOsWording } from "@/lib/client/platform";
import { targetName, useTargets } from "@/lib/client/targets";
import { SESSION_STATUS_LABEL, sessionTitle } from "@/lib/client/sessions";
import { CONFIDENCE_LABEL, EVENT_TYPE_LABEL, OUTAGE_CLASS_LABEL } from "@/lib/client/adapters";
import { severityToUi, toUiHealth, type Health } from "@/lib/health";
import { SHARED_SEGMENT_LABEL } from "@/lib/segments";
import {
  DASH,
  fmtDate,
  fmtDateTime,
  fmtDb,
  fmtDuration,
  fmtDurationMs,
  fmtInt,
  fmtLinkSpeed,
  fmtLossPct,
  fmtMbit,
  fmtMs,
  fmtNumber,
  fmtPct,
  fmtTimeRange,
} from "@/lib/format";
import { cn } from "@/lib/cn";
import { useEffectiveRange, useRangeQuery, parseRangeQuery } from "@/app/diagnose/_components/use-effective-range";
import { isProvisional, primaryFinding, redactMacs, statOf } from "@/app/diagnose/_components/helpers";
import { HourProfileCharts, hourProfile, PROFILE_TARGETS } from "./HourProfile";
import { PAPER_PRINT_CSS, PAPER_VARS } from "./paper";
import { Fact, PaperTable, ReportData, ReportSection, type PaperColumn } from "./ReportParts";

const PRESETS = ["session", "24h", "7d", "30d"] as const;
const EVENT_TYPES = "outage,router_reboot,router_offline";
const MAX_ROWS = 40;

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const inRange = (ts: number | null | undefined, r: { from: number; to: number } | null) => ts != null && r != null && ts >= r.from && ts <= r.to;

const HEALTH_WORD: Record<Health, string> = { good: "gut", warn: "auffällig", crit: "kritisch", unknown: "unbekannt" };

/* -------------------------------------------------------------------------- */

function ExportLink({ href, icon: Icon = Download, children }: { href: string | undefined; icon?: LucideIcon; children: ReactNode }) {
  const cls =
    "inline-flex h-9 items-center gap-2 whitespace-nowrap rounded-lg bg-raised px-3.5 text-sm font-medium text-fg ring-1 ring-inset ring-line-strong transition-colors hover:bg-overlay hover:ring-line-control focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fiber";
  if (!href) {
    return (
      <span aria-disabled="true" className={cn(cls, "pointer-events-none opacity-45")}>
        <Icon aria-hidden className="size-4" strokeWidth={2} />
        {children}
      </span>
    );
  }
  return (
    <a href={href} download className={cls}>
      <Icon aria-hidden className="size-4" strokeWidth={2} />
      {children}
    </a>
  );
}

export function BerichtView() {
  const os = useOsWording();
  const er = useEffectiveRange();
  const query = useRangeQuery(er);
  const span = useMemo(() => parseRangeQuery(query), [query]);
  const conn = useLiveConnection();
  const engineDown = !(conn.online || conn.status === "idle" || conn.status === "connecting");
  const { targets, config } = useTargets();

  const diag = useApi<DiagnosisResponse>(query ? `/api/diagnosis?${query}` : null);
  const stats = useApi<StatsResponse>(query ? `/api/stats?${query}` : null);
  const series = useApi<SeriesResponse>(query ? `/api/series?targets=${PROFILE_TARGETS.map((t) => t.id).join(",")}&step=3600000&${query}` : null);
  const events = useApi<EventsResponse>(query ? `/api/events?${query}&types=${EVENT_TYPES}&limit=200` : null);
  const client = useApi<ClientResponse>(query ? `/api/client?${query}` : null);
  // abgeschlossener Zeitraum (z. B. beendeter Test): Router-/DOCSIS-Stand von damals statt von heute
  const router = useApi<RouterResponse>(query ? `/api/router?${query}${!er.live && span ? `&at=${span.to}` : ""}` : null);
  const speed = useApi<SpeedtestsResponse>(query ? `/api/speedtests?${query}&limit=50` : null);
  const tr4 = useApi<TraceroutesResponse>(query ? `/api/traceroutes?family=4&limit=1&${query}` : null);
  const tr6 = useApi<TraceroutesResponse>(query ? `/api/traceroutes?family=6&limit=1&${query}` : null);
  const sessions = useApi<SessionsResponse>("/api/sessions");
  const session = er.fallback ? null : er.range.session;

  const profile = useMemo(() => hourProfile(series.data), [series.data]);
  const statIds = useMemo(() => {
    const game = targets.filter((t) => t.segment === "game" && t.enabled).map((t) => t.id);
    return ["gw", "isp6", "aftr", "isp4", "cf4", "cf6", "g4", "g6", ...game];
  }, [targets]);

  const runtimeDrops = useMemo(
    () =>
      (client.data?.linkEvents ?? [])
        .filter((e) => e.type === "nic_link_down" && rec(e.details).cause === "runtime" && inRange(e.ts, span))
        .sort((a, b) => a.ts - b.ts),
    [client.data, span],
  );

  const exportHref = (kind: string, format: "csv" | "json") => (query ? `/api/export?kind=${kind}&format=${format}&${query}` : undefined);

  // aktuelle Link-Geschwindigkeit der IPv4-Internet-Schnittstelle
  const link = useMemo(() => {
    const a = client.data?.adapters;
    if (!a) return null;
    const alias = a.routes.find((r) => r.family === 4)?.ifAlias;
    const ad = a.adapters.find((x) => x.name === alias) ?? a.adapters.find((x) => !x.isVirtual && x.status === "Up");
    return ad ? { name: ad.name, mbps: ad.linkMbps, wifi: ad.isWifi } : null;
  }, [client.data]);

  const rangeSessions = useMemo(
    () =>
      (sessions.data?.items ?? [])
        .filter((s) => span != null && s.startedAt <= span.to && (s.endedAt ?? span.to) >= span.from)
        .sort((a, b) => a.startedAt - b.startedAt),
    [sessions.data, span],
  );

  return (
    <div className="flex flex-col gap-4">
      <style>{PAPER_PRINT_CSS}</style>

      <div className="np-no-print flex flex-col gap-3">
        <PageHeader
          title="Bericht"
          description="Zusammenfassung eines Langzeittests – wähle ihn rechts nach Namen – zum Drucken oder Weitergeben an Vodafone."
          actions={
            <>
              <TimeRangePicker range={er.range} presets={PRESETS} />
              <SessionPicker range={er.range} />
            </>
          }
          className="mb-0"
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" icon={Printer} onClick={() => window.print()}>
            Drucken / als PDF speichern
          </Button>
          <ExportLink href={exportHref("report", "json")} icon={FileJson}>
            JSON-Bericht
          </ExportLink>
          <ExportLink href={exportHref("events", "csv")}>Ereignisse (CSV)</ExportLink>
          <ExportLink href={exportHref("rollups", "csv")}>Minutenwerte (CSV)</ExportLink>
          <ExportLink href={exportHref("speedtests", "csv")}>Speedtests (CSV)</ExportLink>
          <ExportLink href={exportHref("traceroutes", "csv")}>Traceroutes (CSV)</ExportLink>
          <Link
            href="/langzeittests"
            className="inline-flex h-9 items-center gap-2 whitespace-nowrap rounded-lg px-3 text-sm font-medium text-fg-2 transition-colors hover:bg-raised hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fiber"
          >
            <FlaskConical aria-hidden className="size-4" strokeWidth={2} />
            Alle Langzeittests
          </Link>
        </div>
        {er.fallback && (
          <p className="flex items-start gap-2 text-sm text-fg-3">
            <Info aria-hidden className="mt-0.5 size-4 shrink-0 text-info" strokeWidth={2} />
            Noch kein Langzeittest vorhanden – der Bericht zeigt die letzten 24 Stunden.
          </p>
        )}
        {engineDown && (
          <p className="flex items-start gap-2 text-sm text-fg-3">
            <PlugZap aria-hidden className="mt-0.5 size-4 shrink-0 text-warn" strokeWidth={2} />
            Mess-Engine nicht erreichbar – der Bericht nutzt die gespeicherten Messwerte.
          </p>
        )}
      </div>

      <article
        aria-label="Netzpuls-Bericht"
        className="np-paper mx-auto flex w-full max-w-[980px] flex-col gap-6 rounded-2xl border border-line px-4 py-6 shadow-[0_24px_60px_-30px_rgb(0_0_0/0.7)] sm:px-8 sm:py-9 lg:px-12"
        style={PAPER_VARS}
      >
        {/* Kopf */}
        <header className="np-paper-block flex flex-col gap-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-xs font-medium tracking-wide text-fiber">Netzpuls – Leitungsdiagnose</p>
              <h1 className="mt-1 font-display text-2xl font-semibold text-fg sm:text-3xl">Netzpuls-Bericht</h1>
              {session ? (
                <>
                  <p className="mt-1 text-base font-medium text-fg">
                    {sessionTitle(session)}
                    <span className="ml-2 text-xs font-normal text-fg-3">{SESSION_STATUS_LABEL[session.status]}</span>
                  </p>
                  {session.note && <p className="mt-0.5 text-sm text-fg-2">{session.note}</p>}
                </>
              ) : (
                <p className="mt-1 text-sm text-fg-3">Langzeittest der Internetverbindung – Ursachen für hohe Pings und Paketverlust</p>
              )}
            </div>
          </div>
          <dl className="grid grid-cols-1 gap-x-8 gap-y-3 rounded-[10px] bg-sunken px-4 py-3 sm:grid-cols-2">
            <Fact label="Anschluss">
              Vodafone Kabel (DOCSIS), DS-Lite
              {router.data?.status?.aftrAddress && <span className="np-num block text-xs text-fg-3">AFTR {router.data.status.aftrAddress}</span>}
            </Fact>
            <Fact label="Router">
              {router.data?.status?.model ?? "Vodafone Station Wi-Fi 6 (ARRIS TG6442)"}
              <span className="block text-xs text-fg-3">
                Firmware <span className="np-num">{router.data?.status?.firmware ?? DASH}</span>
                {router.data?.status?.ip && (
                  <>
                    , <span className="np-num">{router.data.status.ip}</span>
                  </>
                )}
              </span>
            </Fact>
            <Fact label="Zeitraum">
              {er.label}
              {span && <span className="np-num block text-xs text-fg-3">{fmtTimeRange(span.from, Math.min(span.to, diag.data?.generatedAt ?? span.to))}</span>}
            </Fact>
            <Fact label="Erstellt am">
              <span className="np-num">{diag.data ? fmtDateTime(diag.data.generatedAt) : DASH}</span>
              {config?.tariff.downMbps != null && (
                <span className="block text-xs text-fg-3">
                  Tarif {config.tariff.name ? `„${config.tariff.name}“, ` : ""}
                  <span className="np-num">
                    {fmtMbit(config.tariff.downMbps)} / {fmtMbit(config.tariff.upMbps)}
                  </span>
                </span>
              )}
            </Fact>
          </dl>
        </header>

        {/* Zusammenfassung */}
        <ReportSection title="Zusammenfassung">
          <ReportData result={diag} empty="Keine Auswertung für diesen Zeitraum.">
            {(d) => {
              const s = d.seconds;
              const badPct = s && s.covered > 0 ? (s.bad / s.covered) * 100 : null;
              const primary = primaryFinding(d);
              return (
                <div className="flex flex-col gap-4">
                  <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:gap-8">
                    <div className="shrink-0">
                      <p className="np-num text-4xl font-semibold text-fg">{badPct != null ? fmtPct(badPct) : DASH}</p>
                      <p className="mt-1 max-w-[16rem] text-xs text-fg-3">
                        der gemessenen Sekunden gestört
                        {s && (
                          <>
                            {" "}
                            (<span className="np-num">{fmtInt(s.bad)}</span> von <span className="np-num">{fmtInt(s.covered)}</span>)
                          </>
                        )}
                      </p>
                    </div>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <HealthBadge status={severityToUi(d.verdict.severity)} size="sm" />
                        {primary && d.verdict.primarySegment != null && (
                          <span className="text-xs text-fg-3">Sicherheit: {CONFIDENCE_LABEL[primary.confidence]}</span>
                        )}
                        {isProvisional(d) && <span className="text-xs font-medium text-warn">vorläufig</span>}
                      </div>
                      <p className="mt-2 text-md font-medium text-fg">{d.verdict.title}</p>
                      <p className="mt-1 text-sm text-fg-2">{d.verdict.text}</p>
                    </div>
                  </div>
                  <p className="text-sm text-fg-2">
                    {summarySentence(d.seconds, runtimeDrops.length, events.data?.events ?? [], span)}
                  </p>
                </div>
              );
            }}
          </ReportData>
        </ReportSection>

        {/* Kennzahlen je Abschnitt */}
        <ReportSection title="Kennzahlen je Abschnitt" description="Pings im Sekundentakt; Speedtest-Zeiträume sind herausgerechnet.">
          <ReportData result={stats} isEmpty={(s) => statIds.every((id) => !statOf(s.stats, id))} empty="Keine Pings im Zeitraum – es lief kein Langzeittest.">
            {(s) => <StatsTable stats={s.stats} ids={statIds} nameOf={(id) => targetName(id, targets)} />}
          </ReportData>
        </ReportSection>

        {/* Tagesprofil */}
        <ReportSection title="Verlauf nach Tageszeit" description="Mittel je Uhrzeit über alle Tage des Zeitraums. Lücken: zu dieser Uhrzeit nicht gemessen.">
          <ReportData result={series} isEmpty={() => profile.every((r) => r.sent === 0)} empty="Für ein Tagesprofil liegen keine Messwerte vor.">
            {() => <HourProfileCharts rows={profile} />}
          </ReportData>
        </ReportSection>

        {/* Ausfälle */}
        <ReportSection title="Ausfälle und Router-Ereignisse" block={false} description="Internet nicht erreichbar (mindestens 3 s ohne Antwort von 2 Internetzielen) sowie Router-Neustarts.">
          <ReportData result={events} isEmpty={(e) => e.events.length === 0} empty="Keine Ausfälle im Zeitraum.">
            {(e) => <OutageTable events={e.events} total={e.total} />}
          </ReportData>
        </ReportSection>

        {/* Link-Abbrüche */}
        <ReportSection
          title={`Link-Abbrüche am ${os.id === "macos" ? "Mac" : "PC"} (im laufenden Betrieb)`}
          block={false}
          description={
            os.id === "macos"
              ? "Von der Mess-Engine sekündlich erkannt (macOS). Neuverbindungen beim Start oder Aufwachen sind herausgerechnet."
              : "Aus dem Windows-Ereignisprotokoll (Intel I225-V). Neuverbindungen beim Start oder Aufwachen sind herausgerechnet."
          }
        >
          <ReportData result={client} isEmpty={() => runtimeDrops.length === 0} empty="Keine Link-Abbrüche im laufenden Betrieb im Zeitraum.">
            {() => <LinkDropTable drops={runtimeDrops} />}
          </ReportData>
        </ReportSection>

        {/* DOCSIS */}
        <ReportSection title="Kabelleitung (DOCSIS)">
          <ReportData
            result={router}
            isEmpty={(r) => !r.status?.docsis}
            empty="DOCSIS-Werte nicht verfügbar – dafür braucht Netzpuls den Router-Login (Einstellungen). Die Vodafone Station liefert keine Codewort-Fehlerzähler."
          >
            {(r) => (r.status?.docsis ? <DocsisSummary ds={r.status.docsis.ds} us={r.status.docsis.us} rating={r.status.docsis.rating} notes={r.status.docsis.notes} ts={r.status.docsis.ts} /> : null)}
          </ReportData>
        </ReportSection>

        {/* Router-Protokoll */}
        <ReportSection title="Router-Ereignisprotokoll (Auszug)" block={false} description="MAC-Adressen sind unkenntlich gemacht.">
          <ReportData
            result={router}
            isEmpty={(r) => r.log.filter((l) => l.ts == null || inRange(l.ts, span)).length === 0}
            empty="Keine Einträge im Zeitraum (das Protokoll wird nur mit Router-Login gelesen)."
          >
            {(r) => {
              const rows = r.log.filter((l) => l.ts == null || inRange(l.ts, span)).slice(0, MAX_ROWS);
              return (
                <PaperTable
                  caption="Router-Ereignisprotokoll"
                  rows={rows}
                  rowKey={(l, i) => `${l.timeText}-${i}`}
                  columns={[
                    { key: "t", header: "Zeit", className: "whitespace-nowrap", render: (l) => <span className="np-num">{l.ts != null ? fmtDateTime(l.ts) : l.timeText}</span> },
                    { key: "s", header: "Stufe", render: (l) => <HealthBadge status={severityToUi(l.severity)} size="sm" /> },
                    { key: "c", header: "Art", render: (l) => <span className="np-num">{l.category}</span> },
                    { key: "m", header: "Meldung", render: (l) => <span className="np-num text-xs break-words">{redactMacs(l.message)}</span> },
                  ]}
                />
              );
            }}
          </ReportData>
        </ReportSection>

        {/* Speedtests */}
        <ReportSection title="Speedtests" block={false}>
          <ReportData result={speed} isEmpty={(s) => s.items.length === 0} empty="Keine Speedtests im Zeitraum.">
            {(s) => <SpeedTable items={s.items} />}
          </ReportData>
        </ReportSection>

        {/* Traceroutes */}
        <ReportSection title="Traceroute (jeweils die letzte im Zeitraum)" description="Hop 2 (DS-Lite-Gateway bzw. Kopfstation) antwortet bei Vodafone meist nicht – das ist normal. Verlust zählt nur, wenn er bis zum Ziel bestehen bleibt.">
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2 print:grid-cols-2">
            <ReportData result={tr4} isEmpty={(t) => t.items.length === 0} empty="Keine IPv4-Traceroute im Zeitraum.">
              {(t) => <TraceTable tr={t.items[0]} />}
            </ReportData>
            <ReportData result={tr6} isEmpty={(t) => t.items.length === 0} empty="Keine IPv6-Traceroute im Zeitraum.">
              {(t) => <TraceTable tr={t.items[0]} />}
            </ReportData>
          </div>
        </ReportSection>

        {/* Befunde */}
        <ReportSection title="Befunde und Empfehlungen" block={false}>
          <ReportData result={diag} isEmpty={(d) => d.findings.length === 0} empty="Keine Befunde – im Zeitraum war nichts auffällig.">
            {(d) => (
              <ol className="flex flex-col gap-4">
                {[...d.findings]
                  .sort((a, b) => b.score - a.score)
                  .map((f) => (
                    <li key={f.id} className="np-paper-block rounded-[10px] border border-line px-4 py-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <HealthBadge status={severityToUi(f.severity)} size="sm" />
                        <span className="text-xs text-fg-3">{SHARED_SEGMENT_LABEL[f.segment]}</span>
                        <span className="text-xs text-fg-3">Sicherheit: {CONFIDENCE_LABEL[f.confidence]}</span>
                      </div>
                      <p className="mt-1.5 font-medium text-fg">{f.title}</p>
                      <p className="mt-1 text-sm text-fg-2">{f.summary}</p>
                      {f.recommendations.length > 0 && (
                        <ul className="mt-2 list-disc space-y-0.5 pl-5 text-sm text-fg-2 marker:text-laser">
                          {f.recommendations.map((r, i) => (
                            <li key={i}>{r}</li>
                          ))}
                        </ul>
                      )}
                    </li>
                  ))}
              </ol>
            )}
          </ReportData>
        </ReportSection>

        {/* Messabdeckung */}
        <ReportSection title="Messabdeckung">
          <ReportData result={diag} empty="Keine Angaben.">
            {(d) => (
              <div className="flex flex-col gap-3">
                <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
                  <Fact label="Gemessene Zeit">
                    <span className="np-num">{d.seconds ? fmtDuration(d.seconds.covered) : DASH}</span>
                  </Fact>
                  <Fact label="Abdeckung">
                    <span className="np-num">{fmtPct(d.dataQuality.coveragePct)}</span>
                  </Fact>
                  <Fact label="Messwerte">
                    <span className="np-num">{fmtInt(d.dataQuality.samples)}</span>
                  </Fact>
                  <Fact label="Messlücken">
                    <span className="np-num">{fmtInt(d.dataQuality.gaps)}</span>
                  </Fact>
                </dl>
                {d.dataQuality.notes.length > 0 && (
                  <ul className="list-disc space-y-0.5 pl-5 text-sm text-fg-2">
                    {d.dataQuality.notes.map((n, i) => (
                      <li key={i}>{n}</li>
                    ))}
                  </ul>
                )}
                {rangeSessions.length > 0 && (
                  <PaperTable
                    caption="Langzeittests im Zeitraum"
                    rows={rangeSessions}
                    rowKey={(s) => String(s.id)}
                    columns={[
                      { key: "l", header: "Langzeittest", render: (s) => s.label ?? `Test ${s.id}` },
                      { key: "a", header: "Beginn", render: (s) => <span className="np-num">{fmtDateTime(s.startedAt)}</span> },
                      { key: "e", header: "Ende", render: (s) => <span className="np-num">{s.endedAt != null ? fmtDateTime(s.endedAt) : "läuft"}</span> },
                      { key: "d", header: "Dauer", numeric: true, render: (s) => fmtDurationMs((s.endedAt ?? d.generatedAt) - s.startedAt) },
                    ]}
                  />
                )}
              </div>
            )}
          </ReportData>
        </ReportSection>

        {/* Breitbandmessung */}
        <ReportSection title="Hinweis zur Breitbandmessung">
          <div className="flex flex-col gap-2 text-sm text-fg-2">
            <p>
              Für einen rechtsgültigen Nachweis zu geringer Bandbreite gibt es die Breitbandmessung der Bundesnetzagentur (Desktop-App, mehrere Messtage). Sie setzt eine
              Kabelverbindung (LAN) mit mindestens 1 Gbit/s zwischen PC und Router voraus – mit 100 Mbit/s oder WLAN wird die Messung nicht anerkannt.
            </p>
            <ReportData result={client} isEmpty={() => link == null} empty="Aktuelle Link-Geschwindigkeit unbekannt.">
              {() =>
                link ? (
                  <p className="flex flex-wrap items-center gap-2">
                    <span>Aktuelle Verbindung des PCs:</span>
                    <span className="np-num text-fg">
                      {link.name}, {fmtLinkSpeed(link.mbps)}
                    </span>
                    <HealthBadge
                      status={!link.wifi && (link.mbps ?? 0) >= 1000 ? "good" : "warn"}
                      label={!link.wifi && (link.mbps ?? 0) >= 1000 ? "geeignet" : "nicht geeignet"}
                      size="sm"
                    />
                  </p>
                ) : null
              }
            </ReportData>
          </div>
        </ReportSection>

        <footer className="border-t border-line pt-4 text-xs text-fg-3">
          Erstellt mit Netzpuls (lokale Langzeitmessung). Alle Zeiten in deutscher Ortszeit. Messverfahren: Ping, TCP und DNS im Sekunden- bzw. 10-Sekunden-Takt vom PC
          zu Router, Kopfstation, DS-Lite-Gateway, Cloudflare, Google und Spieleservern; Einordnung jeder Sekunde nach dem ersten auffälligen Abschnitt.
        </footer>
      </article>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function summarySentence(
  s: DiagnosisResponse["seconds"],
  drops: number,
  events: readonly NetEvent[],
  span: { from: number; to: number } | null,
): string {
  const outages = events.filter((e) => e.type === "outage" && inRange(e.ts, span));
  const reboots = events.filter((e) => e.type === "router_reboot" && inRange(e.ts, span)).length;
  const parts: string[] = [];
  if (s && s.covered > 0) parts.push(`Gemessen wurden ${fmtDuration(s.covered)}; davon waren ${fmtDuration(s.bad)} gestört, ${fmtInt(s.ses)} Sekunden davon stark.`);
  else parts.push("Im Zeitraum wurde nicht im Sekundentakt gemessen.");
  parts.push(
    `${outages.length === 1 ? "1 Ausfall" : `${fmtInt(outages.length)} Ausfälle`} des Internets, ${drops === 1 ? "1 Link-Abbruch" : `${fmtInt(drops)} Link-Abbrüche`} am PC im laufenden Betrieb${reboots > 0 ? ` und ${reboots === 1 ? "1 Router-Neustart" : `${fmtInt(reboots)} Router-Neustarts`}` : ""}.`,
  );
  return parts.join(" ");
}

function StatsTable({ stats, ids, nameOf }: { stats: readonly TargetStats[]; ids: readonly string[]; nameOf: (id: string) => string }) {
  const rows = ids.map((id) => ({ id, s: statOf(stats, id) })).filter((r) => r.s != null) as { id: string; s: TargetStats }[];
  const columns: PaperColumn<{ id: string; s: TargetStats }>[] = [
    { key: "n", header: "Messpunkt", render: (r) => <span className="text-fg">{nameOf(r.id)}</span> },
    { key: "p50", header: "p50", numeric: true, render: (r) => fmtMs(r.s.p50) },
    { key: "p95", header: "p95", numeric: true, render: (r) => fmtMs(r.s.p95) },
    { key: "p99", header: "p99", numeric: true, render: (r) => fmtMs(r.s.p99) },
    { key: "j", header: "Jitter", numeric: true, render: (r) => fmtMs(r.s.jitter) },
    { key: "l", header: "Verlust", numeric: true, render: (r) => fmtLossPct(r.s.lossPct) },
    { key: "sp", header: "Spitzen/h", numeric: true, render: (r) => fmtNumber(r.s.spikesPerHour, 1) },
    { key: "c", header: "Abdeckung", numeric: true, render: (r) => fmtPct(r.s.coveragePct) },
  ];
  return <PaperTable caption="Kennzahlen je Messpunkt" rows={rows} rowKey={(r) => r.id} columns={columns} />;
}

function OutageTable({ events, total }: { events: readonly NetEvent[]; total: number }) {
  const rows = [...events].sort((a, b) => a.ts - b.ts).slice(0, MAX_ROWS);
  return (
    <>
      <PaperTable
        caption="Ausfälle und Router-Ereignisse"
        rows={rows}
        rowKey={(e, i) => String(e.id ?? `${e.ts}-${i}`)}
        columns={[
          { key: "t", header: "Beginn", className: "whitespace-nowrap", render: (e) => <span className="np-num">{fmtDateTime(e.ts)}</span> },
          {
            key: "d",
            header: "Dauer",
            numeric: true,
            render: (e) => {
              const ms = e.endTs != null ? e.endTs - e.ts : num(rec(e.details).durationMs);
              if (ms != null) return fmtDurationMs(ms);
              return e.type === "router_reboot" ? DASH : "unbekannt";
            },
          },
          { key: "a", header: "Art", render: (e) => EVENT_TYPE_LABEL[e.type] },
          {
            key: "c",
            header: "Einordnung",
            render: (e) => {
              const c = rec(e.details).classification;
              return typeof c === "string" && c in OUTAGE_CLASS_LABEL ? OUTAGE_CLASS_LABEL[c as keyof typeof OUTAGE_CLASS_LABEL] : DASH;
            },
          },
          { key: "x", header: "Beschreibung", render: (e) => <span className="text-xs">{e.title}</span> },
        ]}
      />
      {total > rows.length && <p className="mt-2 text-xs text-fg-3">Gezeigt: {rows.length} von {fmtInt(total)} Ereignissen. Alle stehen im CSV-Export „Ereignisse“.</p>}
    </>
  );
}

function LinkDropTable({ drops }: { drops: readonly NetEvent[] }) {
  const slow = drops.filter((e) => (num(rec(e.details).relinkMbps) ?? 1000) < 1000).length;
  const wlan = drops.filter((e) => rec(e.details).wlanFailover === true).length;
  const rows = drops.slice(-MAX_ROWS);
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-fg-2">
        <span className="np-num text-fg">{drops.length}</span> Abbrüche, davon <span className="np-num text-fg">{slow}</span> mit Wiederaufbau unter 1 Gbit/s und{" "}
        <span className="np-num text-fg">{wlan}</span> mit Ausweichen aufs WLAN.
      </p>
      <PaperTable
        caption="Link-Abbrüche im laufenden Betrieb"
        rows={rows}
        rowKey={(e, i) => String(e.id ?? `${e.ts}-${i}`)}
        columns={[
          { key: "t", header: "Zeit", className: "whitespace-nowrap", render: (e) => <span className="np-num">{fmtDateTime(e.ts)}</span> },
          {
            key: "d",
            header: "Ohne Verbindung",
            numeric: true,
            render: (e) => {
              const ms = num(rec(e.details).downtimeMs) ?? (e.endTs != null ? e.endTs - e.ts : null);
              return ms != null ? fmtDurationMs(ms) : DASH;
            },
          },
          { key: "r", header: "Danach", numeric: true, render: (e) => fmtLinkSpeed(num(rec(e.details).relinkMbps)) },
          { key: "w", header: "WLAN-Ausweichen", render: (e) => (rec(e.details).wlanFailover === true ? "ja" : "nein") },
        ]}
      />
      {drops.length > rows.length && <p className="text-xs text-fg-3">Gezeigt: die letzten {rows.length} von {drops.length} Abbrüchen.</p>}
    </div>
  );
}

const RATING_RANK: Record<string, number> = { bad: 0, warn: 1, unknown: 2, good: 3 };

function range(values: (number | null)[]): string {
  const v = values.filter((x): x is number => x != null);
  if (v.length === 0) return DASH;
  return `${fmtDb(Math.min(...v), "dBmV")} bis ${fmtDb(Math.max(...v), "dBmV")}`;
}

function DocsisSummary({ ds, us, rating, notes, ts }: { ds: DocsisChannel[]; us: DocsisChannel[]; rating: DocsisChannel["rating"]; notes: string[]; ts: number }) {
  const all = [...ds, ...us];
  const worst = all.filter((c) => c.rating === "bad" || c.rating === "warn").sort((a, b) => (RATING_RANK[a.rating] ?? 9) - (RATING_RANK[b.rating] ?? 9)).slice(0, 10);
  const snr = ds.map((c) => c.snrDb).filter((x): x is number => x != null);
  const h = toUiHealth(rating);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <HealthBadge status={h} size="sm" />
        <span className="text-fg-2">Leitung insgesamt {HEALTH_WORD[h]} (Vodafone-Richtwerte), Stand</span>
        <span className="np-num text-fg-2">{fmtDateTime(ts)}</span>
      </div>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
        <Fact label="Kanäle Downstream / Upstream">
          <span className="np-num">
            {ds.length} / {us.length}
          </span>
        </Fact>
        <Fact label="Downstream-Pegel">
          <span className="np-num">{range(ds.map((c) => c.powerDbmv))}</span>
        </Fact>
        <Fact label="Kleinstes SNR/MER">
          <span className="np-num">{snr.length ? fmtDb(Math.min(...snr)) : DASH}</span>
        </Fact>
        <Fact label="Upstream-Pegel">
          <span className="np-num">{range(us.map((c) => c.powerDbmv))}</span>
        </Fact>
      </dl>
      {notes.length > 0 && (
        <ul className="list-disc space-y-0.5 pl-5 text-sm text-fg-2">
          {notes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      )}
      {worst.length === 0 ? (
        <p className="text-sm text-fg-2">Alle Kanäle liegen innerhalb der Richtwerte.</p>
      ) : (
        <PaperTable
          caption="Auffällige DOCSIS-Kanäle"
          rows={worst}
          rowKey={(c, i) => `${c.dir}-${c.type}-${c.frequencyMHz ?? c.frequencyText}-${i}`}
          columns={[
            { key: "d", header: "Richtung", render: (c) => (c.dir === "ds" ? "Downstream" : "Upstream") },
            { key: "t", header: "Typ", render: (c) => <span className="np-num">{c.type}</span> },
            { key: "f", header: "Frequenz", numeric: true, render: (c) => (c.frequencyMHz != null ? `${fmtNumber(c.frequencyMHz, 1)} MHz` : (c.frequencyText ?? DASH)) },
            { key: "p", header: "Pegel", numeric: true, render: (c) => fmtDb(c.powerDbmv, "dBmV") },
            { key: "s", header: "SNR/MER", numeric: true, render: (c) => fmtDb(c.snrDb) },
            { key: "m", header: "Modulation", render: (c) => <span className="np-num">{c.modulation ?? DASH}</span> },
            {
              key: "r",
              header: "Bewertung",
              render: (c) => (
                <span className="flex flex-col items-start gap-0.5">
                  <HealthBadge status={toUiHealth(c.rating)} size="sm" />
                  {c.ratingNote && <span className="text-xs text-fg-3">{c.ratingNote}</span>}
                </span>
              ),
            },
          ]}
        />
      )}
    </div>
  );
}

function SpeedTable({ items }: { items: SpeedtestsResponse["items"] }) {
  const rows = [...items].sort((a, b) => a.ts - b.ts);
  return (
    <PaperTable
      caption="Speedtests"
      rows={rows}
      rowKey={(s, i) => String(s.id ?? `${s.ts}-${i}`)}
      columns={[
        { key: "t", header: "Zeit", className: "whitespace-nowrap", render: (s) => <span className="np-num">{fmtDateTime(s.ts)}</span> },
        { key: "d", header: "Download", numeric: true, render: (s) => (s.error ? DASH : fmtMbit(s.downMbps)) },
        { key: "u", header: "Upload", numeric: true, render: (s) => (s.error ? DASH : fmtMbit(s.upMbps)) },
        { key: "i", header: "Latenz Ruhe", numeric: true, render: (s) => fmtMs(s.idleLatencyMs) },
        { key: "l", header: "unter Last", numeric: true, render: (s) => `${fmtMs(s.loadedDownLatencyMs)} / ${fmtMs(s.loadedUpLatencyMs)}` },
        { key: "g", header: "Note", render: (s) => <span className="np-num">{s.grade ?? DASH}</span> },
        {
          key: "k",
          header: "Link",
          numeric: true,
          render: (s) => <span className={cn((s.nicLinkMbps ?? 1000) < 1000 && "text-warn")}>{fmtLinkSpeed(s.nicLinkMbps)}</span>,
        },
        { key: "e", header: "Hinweis", render: (s) => <span className="text-xs">{s.error ?? (s.server ?? "")}</span> },
      ]}
    />
  );
}

function TraceTable({ tr }: { tr: TracerouteResult | undefined }) {
  if (!tr) return null;
  return (
    <figure className="min-w-0">
      <figcaption className="mb-1.5 text-sm text-fg-2">
        <span className="font-medium text-fg">IPv{tr.family}</span> zu <span className="np-num">{tr.target}</span>,{" "}
        <span className="np-num">{fmtDate(tr.ts)}</span> {tr.reached ? "" : "– Ziel nicht erreicht"}
      </figcaption>
      <PaperTable
        caption={`Traceroute IPv${tr.family}`}
        rows={tr.hops}
        rowKey={(h) => String(h.hop)}
        columns={[
          { key: "h", header: "Hop", numeric: true, render: (h) => h.hop },
          { key: "a", header: "Adresse", render: (h) => (h.ip ? <span className="np-num text-xs break-all">{h.ip}</span> : <span className="text-xs text-fg-3">antwortet nicht</span>) },
          { key: "r", header: "Ø RTT", numeric: true, render: (h) => fmtMs(h.mtr?.avgMs ?? h.avgMs) },
          { key: "l", header: "Verlust", numeric: true, render: (h) => (h.ip ? fmtLossPct(h.mtr?.lossPct ?? h.lossPct) : DASH) },
        ]}
      />
    </figure>
  );
}
