"use client";

import Link from "next/link";
import { CircleCheck, CirclePause, CircleStop, Info, LoaderCircle, OctagonAlert, PlugZap } from "lucide-react";
import type { ReactNode } from "react";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { HealthBadge } from "@/components/ui/HealthBadge";
import { Panel } from "@/components/ui/Panel";
import { ErrorState, Skeleton } from "@/components/ui/States";
import { useEngineStatus, useLiveConnection } from "@/lib/client/live-store";
import { targetCssColor } from "@/lib/client/targets";
import { useApi } from "@/lib/client/use-api";
import { cn } from "@/lib/cn";
import { DASH, fmtDateTimeShort, fmtMs, fmtNumber, fmtRelative, fmtShortTime } from "@/lib/format";
import { SHARED_SEGMENT_LABEL } from "@/lib/segments";
import type { StatusResponse } from "@/lib/shared/api-types";
import type { AppConfig } from "@/lib/shared/config";
import { SampleStatus, type EngineStatus, type ModuleState, type ProbeKind, type ProbeState, type TargetConfig } from "@/lib/shared/types";
import { useNow } from "@/lib/use-now";

const KIND_LABEL: Record<ProbeKind, string> = { icmp: "Ping (ICMP)", tcp: "TCP-Aufbau", "udp-dns": "UDP (DNS)", http: "HTTP" };

const DYNAMIC_HOST: Record<string, keyof EngineStatus["dynamicHosts"]> = {
  $gateway: "gateway",
  $isp4: "isp4",
  $isp6: "isp6",
  $aftr: "aftr",
  $router6: "router6",
};

const STATUS_TEXT: Record<number, string> = {
  [SampleStatus.TIMEOUT]: "Zeitüberschreitung",
  [SampleStatus.UNREACHABLE]: "nicht erreichbar",
  [SampleStatus.ERROR]: "Fehler",
  [SampleStatus.TTL_EXPIRED]: "TTL abgelaufen",
};

interface TaskDef {
  module: string;
  label: string;
  every: (c: AppConfig) => number | null;
  extra?: (c: AppConfig) => string | null;
}

const TASKS: readonly TaskDef[] = [
  {
    module: "speedtest",
    label: "Speedtest",
    every: (c) => (c.schedules.speedtestEnabled ? c.schedules.speedtestEveryMin : null),
    extra: (c) =>
      !c.schedules.speedtestEnabled
        ? "geplante Tests aus"
        : c.schedules.speedtestQuietHours
          ? `nicht ${c.schedules.speedtestQuietHours.from}–${c.schedules.speedtestQuietHours.to} Uhr`
          : null,
  },
  { module: "traceroute", label: "Pfaderkennung", every: (c) => c.schedules.tracerouteEveryMin },
  { module: "mtr", label: "MTR", every: (c) => c.schedules.mtrEveryMin },
  { module: "mtu", label: "Pfad-MTU", every: (c) => c.schedules.mtuEveryMin },
  { module: "stun", label: "NAT-Test (STUN)", every: (c) => c.schedules.stunEveryMin },
  { module: "udpburst", label: "UDP-Burst", every: (c) => c.schedules.udpBurstEveryMin },
];

function everyText(min: number | null): string {
  if (min === null || !Number.isFinite(min)) return DASH;
  if (min < 60) return `alle ${fmtNumber(min, 0)} min`;
  if (min < 1440) return `alle ${fmtNumber(min / 60, min % 60 === 0 ? 0 : 1)} h`;
  return min === 1440 ? "täglich" : `alle ${fmtNumber(min / 1440, 1)} Tage`;
}

function intervalText(ms: number): string {
  return ms >= 60_000 ? `${fmtNumber(ms / 60_000, 0)} min` : `${fmtNumber(ms / 1000, ms % 1000 === 0 ? 0 : 2)} s`;
}

/** Zustand mit Icon + Wort (nie nur Farbe). */
function StateWord({ tone, icon, children }: { tone: "good" | "warn" | "crit" | "muted" | "fiber"; icon: ReactNode; children: ReactNode }) {
  const color = { good: "text-good", warn: "text-warn", crit: "text-crit", muted: "text-fg-3", fiber: "text-fiber" }[tone];
  return <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap text-sm", color)}>{icon}<span className={tone === "muted" ? "text-fg-3" : "text-fg-2"}>{children}</span></span>;
}

const ICON = "size-3.5 shrink-0";

interface ProbeRow {
  t: TargetConfig;
  p: ProbeState | undefined;
}

export function PlanStatus() {
  const status = useApi<StatusResponse>("/api/status", { refreshMs: 30_000 });
  const live = useEngineStatus();
  const conn = useLiveConnection();
  const now = useNow(5000);

  if (!status.data) {
    if (status.error) {
      return (
        <Panel title="Messplan-Status">
          <ErrorState message={status.error.message} onRetry={status.reload} />
        </Panel>
      );
    }
    return (
      <Panel title="Messplan-Status" description="Was die Mess-Engine gerade misst und wann die nächsten Aufgaben laufen.">
        <div className="flex flex-col gap-2" aria-busy="true" aria-label="Status wird geladen">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-8" />
          ))}
        </div>
      </Panel>
    );
  }

  const config = status.data.config;
  const engineOnline = conn.online || (conn.status === "idle" || conn.status === "connecting" ? status.data.engineOnline : false);
  const engine: EngineStatus | null = live ?? status.data.engine;
  const probesById = new Map((engine?.probes ?? []).map((p) => [p.targetId, p]));
  const modulesByName = new Map((engine?.modules ?? []).map((m) => [m.name, m]));
  const session = engine?.session ?? null;
  const probesModule = modulesByName.get("probes");
  const rows: ProbeRow[] = config.targets.map((t) => ({ t, p: probesById.get(t.id) }));
  const enabledCount = config.targets.filter((t) => t.enabled).length;
  const runningCount = rows.filter((r) => r.p?.running).length;

  const resolved = (t: TargetConfig, p: ProbeState | undefined): ReactNode => {
    if (!t.host.startsWith("$")) return <span className="np-num break-all">{t.host}</span>;
    const key = DYNAMIC_HOST[t.host];
    const ip = p?.resolvedHost ?? (key ? engine?.dynamicHosts[key] : null);
    return ip ? <span className="np-num break-all">{ip}</span> : <span>wird ermittelt</span>;
  };

  const columns: Column<ProbeRow>[] = [
    {
      key: "name",
      header: "Ziel",
      render: ({ t, p }) => (
        <div className="min-w-[12rem] py-1.5">
          <div className="flex items-center gap-2">
            <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: targetCssColor(t.id) }} />
            <span className={cn("font-medium", t.enabled ? "text-fg" : "text-fg-3")}>{t.name}</span>
          </div>
          <div className="mt-0.5 pl-4 text-xs text-fg-3">{resolved(t, p)}</div>
        </div>
      ),
    },
    { key: "seg", header: "Abschnitt", render: ({ t }) => <span className="whitespace-nowrap">{SHARED_SEGMENT_LABEL[t.segment]}</span> },
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
    { key: "int", header: "Intervall", numeric: true, render: ({ t }) => intervalText(t.intervalMs) },
    {
      key: "on",
      header: "Aktiv",
      render: ({ t }) =>
        t.enabled ? (
          <StateWord tone="good" icon={<CircleCheck aria-hidden className={ICON} strokeWidth={2.25} />}>
            aktiv
          </StateWord>
        ) : (
          <StateWord tone="muted" icon={<CircleStop aria-hidden className={ICON} strokeWidth={2.25} />}>
            aus
          </StateWord>
        ),
    },
    {
      key: "run",
      header: "Läuft",
      render: ({ t, p }) => {
        if (!engineOnline) return <span className="text-fg-3">{DASH}</span>;
        if (p?.error) {
          return (
            <span className="flex flex-col">
              <StateWord tone="crit" icon={<OctagonAlert aria-hidden className={ICON} strokeWidth={2.25} />}>
                Fehler
              </StateWord>
              <span className="max-w-[16rem] text-xs text-fg-3">{p.error}</span>
            </span>
          );
        }
        if (p?.running) {
          return (
            <StateWord tone="fiber" icon={<span aria-hidden className="np-live-dot" />}>
              läuft
            </StateWord>
          );
        }
        return (
          <StateWord tone="muted" icon={<CirclePause aria-hidden className={ICON} strokeWidth={2.25} />}>
            {t.enabled ? "pausiert" : "gestoppt"}
          </StateWord>
        );
      },
    },
    {
      key: "last",
      header: "Letzter Wert",
      align: "right",
      render: ({ p }) => {
        if (!p || p.lastTs === null) return <span className="text-fg-3">{DASH}</span>;
        const ok = p.lastStatus === SampleStatus.OK && p.lastRtt !== null;
        return (
          <span className="flex flex-col items-end">
            <span className={cn("np-num whitespace-nowrap", ok ? "text-fg" : "text-crit")}>
              {ok ? fmtMs(p.lastRtt) : (STATUS_TEXT[p.lastStatus ?? SampleStatus.ERROR] ?? "verloren")}
            </span>
            <span className="np-num text-2xs text-fg-3">{now !== null ? fmtRelative(p.lastTs, now) : fmtShortTime(p.lastTs)}</span>
          </span>
        );
      },
    },
  ];

  const taskRows = TASKS.map((d) => ({ d, m: modulesByName.get(d.module) }));
  const taskColumns: Column<{ d: TaskDef; m: ModuleState | undefined }>[] = [
    {
      key: "task",
      header: "Aufgabe",
      render: ({ d }) => {
        const extra = d.extra?.(config);
        return (
          <div className="py-1.5">
            <div className="font-medium text-fg">{d.label}</div>
            {extra && <div className="text-xs text-fg-3">{extra}</div>}
          </div>
        );
      },
    },
    { key: "every", header: "Plan", render: ({ d }) => <span className="np-num whitespace-nowrap">{everyText(d.every(config))}</span> },
    {
      key: "state",
      header: "Zustand",
      render: ({ m }) => {
        if (!engineOnline) return <span className="text-fg-3">{DASH}</span>;
        if (!m) return <span className="text-fg-3">unbekannt</span>;
        if (m.busy)
          return (
            <StateWord tone="fiber" icon={<LoaderCircle aria-hidden className={cn(ICON, "animate-spin")} strokeWidth={2.25} />}>
              läuft gerade
            </StateWord>
          );
        if (!m.enabled)
          return (
            <StateWord tone="muted" icon={<CircleStop aria-hidden className={ICON} strokeWidth={2.25} />}>
              deaktiviert
            </StateWord>
          );
        if (m.running)
          return (
            <StateWord tone="good" icon={<CircleCheck aria-hidden className={ICON} strokeWidth={2.25} />}>
              geplant
            </StateWord>
          );
        return (
          <StateWord tone="muted" icon={<CirclePause aria-hidden className={ICON} strokeWidth={2.25} />}>
            pausiert
          </StateWord>
        );
      },
    },
    {
      key: "lastRun",
      header: "Letzter Lauf",
      render: ({ m }) =>
        m?.lastRunTs ? (
          <span className="flex flex-col">
            <span className="np-num whitespace-nowrap text-fg">{fmtDateTimeShort(m.lastRunTs)}</span>
            {now !== null && <span className="np-num text-2xs text-fg-3">{fmtRelative(m.lastRunTs, now)}</span>}
          </span>
        ) : (
          <span className="text-fg-3">{DASH}</span>
        ),
    },
    {
      key: "nextRun",
      header: "Nächster Lauf",
      render: ({ m }) =>
        m?.nextRunTs ? (
          <span className="flex flex-col">
            <span className="np-num whitespace-nowrap text-fg">{fmtDateTimeShort(m.nextRunTs)}</span>
            {now !== null && <span className="np-num text-2xs text-fg-3">{fmtRelative(m.nextRunTs, now)}</span>}
          </span>
        ) : (
          <span className="text-xs text-fg-3">{session ? "nicht geplant" : "mit dem nächsten Langzeittest"}</span>
        ),
    },
    {
      key: "err",
      header: "Fehler",
      render: ({ m }) =>
        m?.lastError ? (
          <span className="flex max-w-[18rem] items-start gap-1.5 text-xs text-crit">
            <OctagonAlert aria-hidden className="mt-px size-3.5 shrink-0" strokeWidth={2.25} />
            <span className="text-fg-2">{m.lastError}</span>
          </span>
        ) : (
          <span className="text-fg-3">{DASH}</span>
        ),
    },
  ];

  return (
    <Panel
      title="Messplan-Status"
      description="Was die Mess-Engine gerade misst und wann die nächsten Aufgaben laufen."
      actions={
        engineOnline ? (
          session ? (
            <HealthBadge status="good" label="Langzeittest läuft" />
          ) : (
            <HealthBadge status="info" label="Kein Langzeittest aktiv" />
          )
        ) : (
          <HealthBadge status="unknown" label="Mess-Engine nicht erreichbar" />
        )
      }
      frame
    >
      <div className="flex flex-col gap-6">
        {!engineOnline ? (
          <Banner tone="warn" icon={<PlugZap aria-hidden className="size-4 shrink-0 text-warn" strokeWidth={2.25} />}>
            Mess-Engine nicht erreichbar. Läuft der Befehl <code className="text-fg">npm run dev</code> noch? Angezeigt wird der konfigurierte Plan
            ohne aktuellen Zustand.
          </Banner>
        ) : !session ? (
          <Banner tone="info" icon={<Info aria-hidden className="size-4 shrink-0 text-info" strokeWidth={2.25} />}>
            Die sekündlichen Pings und die geplanten Pfadmessungen laufen nur während eines Langzeittests. Leichtgewichtige Abfragen (Adapter,
            Ereignisprotokoll, Router-Status) laufen immer.{" "}
            <Link href="/" className="font-medium text-fiber underline-offset-2 hover:underline">
              Langzeittest im Live-Dashboard starten
            </Link>
          </Banner>
        ) : (
          <p className="text-sm text-fg-3">
            Langzeittest{session.label ? <> „{session.label}“</> : null} seit <span className="np-num text-fg">{fmtDateTimeShort(session.startedAt)}</span>
            {session.plannedEndAt !== null && (
              <>
                , geplantes Ende <span className="np-num text-fg">{fmtDateTimeShort(session.plannedEndAt)}</span>
              </>
            )}
            .
          </p>
        )}

        <div>
          <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="text-sm font-medium text-fg">Messziele</h3>
            <p className="text-xs text-fg-3">
              <span className="np-num text-fg-2">{enabledCount}</span> von <span className="np-num text-fg-2">{config.targets.length}</span> aktiv
              {engineOnline && (
                <>
                  , <span className="np-num text-fg-2">{runningCount}</span> laufen
                </>
              )}
              {probesModule?.lastError && <span className="text-crit">; Ping-Modul meldet: {probesModule.lastError}</span>}
            </p>
          </div>
          <DataTable columns={columns} rows={rows} rowKey={(r) => r.t.id} caption="Konfigurierte Messziele und ihr aktueller Zustand" dense maxHeight="34rem" />
        </div>

        <div>
          <h3 className="mb-2 text-sm font-medium text-fg">Geplante Aufgaben</h3>
          <DataTable columns={taskColumns} rows={taskRows} rowKey={(r) => r.d.module} caption="Geplante Aufgaben der Mess-Engine" dense />
          <p className="mt-2 text-xs text-fg-3">
            Intervalle änderst du unter{" "}
            <Link href="/einstellungen#zeitplaene" className="text-fiber underline-offset-2 hover:underline">
              Einstellungen, Zeitpläne
            </Link>
            .
          </p>
        </div>
      </div>
    </Panel>
  );
}

function Banner({ tone, icon, children }: { tone: "warn" | "info"; icon: ReactNode; children: ReactNode }) {
  return (
    <div className={cn("flex items-start gap-3 rounded-[10px] px-4 py-3 ring-1 ring-inset", tone === "warn" ? "bg-warn/10 ring-warn/30" : "bg-info/10 ring-info/30")}>
      <span className="mt-0.5">{icon}</span>
      <p className="min-w-0 text-sm text-fg-2">{children}</p>
    </div>
  );
}
