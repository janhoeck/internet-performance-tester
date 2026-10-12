"use client";

import { useState } from "react";
import Link from "next/link";
import { AudioWaveform, KeyRound, ListClock, MonitorSmartphone, RefreshCw, Router as RouterIcon, Settings, Timer } from "lucide-react";
import type { RouterResponse } from "@/lib/shared/api-types";
import type { RouterStatus } from "@/lib/shared/types";
import { Button } from "@/components/ui/Button";
import { PageHeader } from "@/components/ui/PageHeader";
import { Panel } from "@/components/ui/Panel";
import { ChartSkeleton, DataState, EmptyState, KpiSkeleton } from "@/components/ui/States";
import { TimeRangePicker } from "@/components/ui/TimeRangePicker";
import { toast } from "@/components/ui/Toast";
import { control } from "@/lib/client/api";
import { useLiveConnection, useRouterLive } from "@/lib/client/live-store";
import { useTargets } from "@/lib/client/targets";
import { revalidateApi, useApi } from "@/lib/client/use-api";
import { useTimeRange } from "@/lib/client/use-time-range";
import { useNow } from "@/lib/use-now";
import { ConnectionCard } from "./ConnectionCard";
import { DocsisSection } from "./DocsisSection";
import { HttpChart, quantile } from "./HttpChart";
import { LoginPanel, SecurityNote } from "./LoginPanel";
import { AttachedDevices, RouterLog } from "./RouterTables";

const PRESETS = ["24h", "7d", "30d"] as const;

/** Neuester Stand gewinnt; fehlende Login-Daten (DOCSIS, Geräte) aus dem gespeicherten Stand ergänzen. */
function mergeStatus(stored: RouterStatus | null, live: RouterStatus | null): RouterStatus | null {
  if (!live) return stored;
  if (!stored || live.ts >= stored.ts) {
    return {
      ...live,
      docsis: live.docsis ?? stored?.docsis ?? null,
      attachedDevices: live.attachedDevices ?? stored?.attachedDevices ?? null,
      uptimeSec: live.uptimeSec ?? stored?.uptimeSec ?? null,
    };
  }
  return stored;
}

function PageSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-busy="true" aria-label="Router-Daten werden geladen">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="np-panel p-5 lg:col-span-2">
          <ChartSkeleton height={220} />
        </div>
        <div className="np-panel p-5">
          <ChartSkeleton height={220} />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <KpiSkeleton />
        <KpiSkeleton />
        <KpiSkeleton />
        <KpiSkeleton />
      </div>
    </div>
  );
}

const WITH_PASSWORD: { icon: typeof AudioWaveform; title: string; text: string }[] = [
  { icon: AudioWaveform, title: "DOCSIS-Kanalwerte", text: "Pegel, SNR/MER, Modulation und Lock je Kanal – bewertet nach den Vodafone-Richtwerten, mit Verlauf." },
  { icon: ListClock, title: "Router-Protokoll", text: "T3/T4-Timeouts, Synchronisationsverluste und Neustarts der Kabelverbindung mit Zeitstempel." },
  { icon: Timer, title: "Laufzeit", text: "Erkennt Neustarts der Station sicher – auch nachts, wenn du nicht hinschaust." },
  { icon: MonitorSmartphone, title: "Geräteliste", text: "Alle Geräte im Heimnetz und die Port-Geschwindigkeit deines PCs aus Routersicht (100 Mbit/s oder 1 Gbit/s)." },
];

function NoPasswordPanel() {
  return (
    <Panel title="Mehr Werte mit dem Router-Passwort" description="Ohne Anmeldung liest Netzpuls nur die Startseite der Vodafone Station.">
      <div className="flex flex-col gap-5">
        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {WITH_PASSWORD.map((w) => (
            <li key={w.title} className="flex gap-3 rounded-[10px] bg-raised/50 p-4 ring-1 ring-inset ring-line">
              <w.icon aria-hidden className="mt-0.5 size-5 shrink-0 text-fiber" strokeWidth={1.75} />
              <div>
                <p className="text-sm font-medium text-fg">{w.title}</p>
                <p className="mt-0.5 text-sm text-fg-3">{w.text}</p>
              </div>
            </li>
          ))}
        </ul>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="max-w-2xl text-sm text-fg-3">
            Das Passwort wird nur lokal und verschlüsselt gespeichert. Netzpuls meldet sich nach jeder Abfrage wieder ab und versucht es bei falschem
            Passwort nie automatisch erneut.
          </p>
          <Link
            href="/einstellungen"
            className="inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-lg bg-fiber-strong px-3.5 text-sm font-medium text-fg-invert hover:bg-fiber hover:shadow-glow focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fiber"
          >
            <KeyRound aria-hidden className="size-4" strokeWidth={2} />
            Router-Passwort eintragen
          </Link>
        </div>
      </div>
    </Panel>
  );
}

function RouterContent({ data, from, to }: { data: RouterResponse; from: number | null; to: number | null }) {
  const live = useRouterLive();
  const conn = useLiveConnection();
  const { config } = useTargets();
  const now = useNow(30_000);
  const status = mergeStatus(data.status, live);
  const routerCfg = config?.router ?? null;
  const engineOffline = conn.status === "offline" || conn.status === "unavailable";
  const httpMedian = quantile(data.httpHistory.ms, 0.5);

  if (!status) {
    return (
      <>
        <Panel>
          <EmptyState
            icon={RouterIcon}
            title="Noch keine Router-Daten"
            action={
              <Link href="/einstellungen" className="inline-flex items-center gap-1.5 text-sm text-fiber underline-offset-2 hover:underline">
                <Settings aria-hidden className="size-4" strokeWidth={2} />
                Router-Adresse prüfen
              </Link>
            }
          >
            {engineOffline
              ? "Die Mess-Engine ist nicht erreichbar. Läuft der Befehl npm run dev noch?"
              : `Die Mess-Engine fragt die Vodafone Station unter ${routerCfg?.ip ?? "192.168.0.1"} regelmäßig ab. Der erste Stand erscheint nach spätestens fünf Minuten.`}
          </EmptyState>
        </Panel>
        <HttpChart http={data.httpHistory} from={from} to={to} />
      </>
    );
  }

  const loginConfigured = status.loginConfigured || (routerCfg?.hasPassword ?? false);
  const loginReady = loginConfigured && status.loginEnabled;
  const hasDocsisData = status.docsis != null || data.docsisHistory.ts.length > 0;
  const showLoginData = hasDocsisData || loginConfigured;

  return (
    <>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="min-w-0 lg:col-span-2">
          <ConnectionCard status={status} httpMedianMs={httpMedian} engineOffline={engineOffline} now={now} />
        </div>
        <LoginPanel status={status} config={routerCfg} now={now} engineOffline={engineOffline} />
      </div>

      {showLoginData ? (
        <DocsisSection docsis={status.docsis} history={data.docsisHistory} from={from} to={to} />
      ) : (
        <NoPasswordPanel />
      )}

      {(showLoginData || data.log.length > 0) && (
        <div className="grid grid-cols-1 gap-4 2xl:grid-cols-2">
          <RouterLog log={data.log} loginReady={loginReady} />
          <AttachedDevices devices={status.attachedDevices} loginReady={loginReady} />
        </div>
      )}

      <HttpChart http={data.httpHistory} from={from} to={to} />
    </>
  );
}

export function RouterView() {
  const range = useTimeRange({ defaultPreset: "7d" });
  const api = useApi<RouterResponse>(range.query ? `/api/router?${range.query}` : null, { refreshMs: 60_000 });
  const conn = useLiveConnection();
  const { config } = useTargets();
  const [polling, setPolling] = useState(false);
  const engineOffline = conn.status === "offline" || conn.status === "unavailable";

  const poll = async () => {
    setPolling(true);
    const r = await control("router.poll");
    setPolling(false);
    toast({ title: r.ok ? "Router-Abfrage gestartet" : (r.error ?? "Router-Abfrage nicht möglich"), tone: r.ok ? "success" : "error" });
    if (r.ok) window.setTimeout(() => revalidateApi("/api/router"), 5_000);
  };

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Router"
        description="Vodafone Station und Kabelanschluss: Verbindungsdaten, DOCSIS-Signalwerte, Router-Protokoll und Geräte im Heimnetz."
        className="mb-2"
        actions={
          <>
            <TimeRangePicker range={range} presets={PRESETS} />
            <Button icon={RefreshCw} onClick={poll} loading={polling} disabled={engineOffline} title={engineOffline ? "Mess-Engine nicht erreichbar" : undefined}>
              Router abfragen
            </Button>
          </>
        }
      />
      <SecurityNote ip={api.data?.status?.ip ?? config?.router.ip ?? "192.168.0.1"} />
      <DataState result={api} skeleton={<PageSkeleton />} height={320}>
        {(data) => <RouterContent data={data} from={range.from} to={range.to} />}
      </DataState>
    </div>
  );
}
