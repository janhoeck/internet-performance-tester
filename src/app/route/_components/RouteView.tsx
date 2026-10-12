"use client";

import { useEffect, useMemo, useState } from "react";
import { Activity, Route as RouteIcon } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { PageHeader } from "@/components/ui/PageHeader";
import { Panel } from "@/components/ui/Panel";
import { ChartSkeleton, ErrorState } from "@/components/ui/States";
import { Tabs } from "@/components/ui/Tabs";
import { toast } from "@/components/ui/Toast";
import { control } from "@/lib/client/api";
import { useEngineStatus, useLastTraceroute, useLiveConnection } from "@/lib/client/live-store";
import { revalidateApi, useApi, type UseApiResult } from "@/lib/client/use-api";
import type { PathResponse, StatusResponse, TraceroutesResponse } from "@/lib/shared/api-types";
import { DEFAULT_CONFIG, type AppConfig } from "@/lib/shared/config";
import type { DynamicHosts, IpFamily } from "@/lib/shared/types";
import { MtrPanel } from "./MtrPanel";
import { PathCards } from "./PathCards";
import { PathPanel } from "./PathPanel";
import { RouteChanges } from "./RouteChanges";
import { isMtrRow, routeChanges } from "./route-utils";

const URL_V4 = "/api/traceroutes?family=4&limit=400";
const URL_V6 = "/api/traceroutes?family=6&limit=400";

interface FamilyViewProps {
  family: IpFamily;
  result: UseApiResult<TraceroutesResponse>;
  dyn: DynamicHosts | null;
  latency: AppConfig["thresholds"]["latency"];
}

function FamilyView({ family, result, dyn, latency }: FamilyViewProps) {
  const derived = useMemo(() => {
    const items = result.data?.items ?? [];
    const sorted = [...items].sort((a, b) => b.ts - a.ts);
    const discovery = sorted.filter((r) => !isMtrRow(r));
    return {
      discovery: discovery[0] ?? null,
      mtr: sorted.find(isMtrRow) ?? null,
      changes: routeChanges(sorted, family),
      since: discovery.length ? discovery[discovery.length - 1].ts : null,
    };
  }, [result.data, family]);

  if (result.data == null) {
    if (result.error) {
      return (
        <Panel>
          <ErrorState message={result.error.message} onRetry={result.reload} />
        </Panel>
      );
    }
    return (
      <Panel>
        <ChartSkeleton height={320} />
      </Panel>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <PathPanel family={family} row={derived.discovery} dyn={dyn} latency={latency} />
      <div className="grid grid-cols-1 gap-4 2xl:grid-cols-3">
        <div className="min-w-0 2xl:col-span-2">
          <MtrPanel family={family} row={derived.mtr} dyn={dyn} />
        </div>
        <RouteChanges family={family} changes={derived.changes} since={derived.since} />
      </div>
      {result.error && <p className="text-xs text-warn">Aktualisierung fehlgeschlagen: {result.error.message} Angezeigt werden die zuletzt geladenen Daten.</p>}
    </div>
  );
}

export function RouteView() {
  const conn = useLiveConnection();
  const liveEngine = useEngineStatus();
  const lastTrace = useLastTraceroute();
  const status = useApi<StatusResponse>("/api/status", { refreshMs: 30_000 });
  const v4 = useApi<TraceroutesResponse>(URL_V4, { refreshMs: 120_000 });
  const v6 = useApi<TraceroutesResponse>(URL_V6, { refreshMs: 120_000 });
  const path = useApi<PathResponse>("/api/path", { refreshMs: 300_000 });
  const [tab, setTab] = useState<"v4" | "v6">("v4");
  const [busy, setBusy] = useState<"trace" | "mtr" | null>(null);

  // Neues Ergebnis im Live-Stream -> Listen neu laden (nur Cache-Invalidierung)
  const lastTraceTs = lastTrace?.ts ?? null;
  useEffect(() => {
    if (lastTraceTs !== null) revalidateApi("/api/traceroutes");
  }, [lastTraceTs]);

  const engine = liveEngine ?? status.data?.engine ?? null;
  const dyn = engine?.dynamicHosts ?? (status.data?.config ? { gateway: status.data.config.router.ip, isp4: null, isp6: null, aftr: null, router6: null } : null);
  const latency = status.data?.config.thresholds.latency ?? DEFAULT_CONFIG.thresholds.latency;
  const family: IpFamily = tab === "v4" ? 4 : 6;
  const traceBusy = engine?.modules.find((m) => m.name === "traceroute")?.busy === true;
  const mtrBusy = engine?.modules.find((m) => m.name === "mtr")?.busy === true;
  const offlineTitle = conn.online ? undefined : "Mess-Engine nicht erreichbar";

  const runTrace = async () => {
    setBusy("trace");
    const r = await control("traceroute.run", { family });
    setBusy(null);
    toast(
      r.ok
        ? { title: "Pfadprüfung gestartet", description: `IPv${family} bis 30 Hops – das Ergebnis erscheint in etwa einer Minute.`, tone: "success" }
        : { title: "Pfadprüfung nicht gestartet", description: r.error ?? "Unbekannter Fehler.", tone: "error" },
    );
  };
  const runMtr = async () => {
    setBusy("mtr");
    const r = await control("mtr.run");
    setBusy(null);
    toast(
      r.ok
        ? { title: "MTR gestartet", description: "20 Pings je Hop für IPv4 und IPv6 – das Ergebnis erscheint gleich hier.", tone: "success" }
        : { title: "MTR nicht gestartet", description: r.error ?? "Unbekannter Fehler.", tone: "error" },
    );
  };

  return (
    <>
      <PageHeader
        title="Route"
        description="Der Weg deiner Pakete Hop für Hop – mit Laufzeit und Verlust je Knoten, getrennt für IPv4 (DS-Lite) und IPv6."
        actions={
          <>
            <Button
              icon={RouteIcon}
              loading={busy === "trace"}
              disabled={!conn.online || traceBusy}
              title={offlineTitle ?? (traceBusy ? "Eine Pfadprüfung läuft bereits" : undefined)}
              onClick={() => void runTrace()}
            >
              {traceBusy ? "Pfadprüfung läuft …" : "Pfad jetzt prüfen"}
            </Button>
            <Button
              icon={Activity}
              loading={busy === "mtr"}
              disabled={!conn.online || mtrBusy}
              title={offlineTitle ?? (mtrBusy ? "Ein MTR läuft bereits" : undefined)}
              onClick={() => void runMtr()}
            >
              {mtrBusy ? "MTR läuft …" : "MTR jetzt"}
            </Button>
          </>
        }
      />
      <div className="flex flex-col gap-6">
        <Tabs
          label="Adressfamilie"
          value={tab}
          onValueChange={(id) => setTab(id === "v6" ? "v6" : "v4")}
          items={[
            { id: "v4", label: "IPv4 (DS-Lite)" },
            { id: "v6", label: "IPv6" },
          ]}
          panels={{
            v4: <FamilyView family={4} result={v4} dyn={dyn} latency={latency} />,
            v6: <FamilyView family={6} result={v6} dyn={dyn} latency={latency} />,
          }}
        />
        <PathCards path={path} />
      </div>
    </>
  );
}
