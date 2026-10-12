"use client";

import type { ReactNode } from "react";
import { Activity, ArrowDown, ArrowUp, Gamepad2, Moon, PlugZap } from "lucide-react";
import { HealthBadge } from "@/components/ui/HealthBadge";
import { Panel } from "@/components/ui/Panel";
import { EmptyState, Skeleton } from "@/components/ui/States";
import { useClientState, useLiveConnection, useSession } from "@/lib/client/live-store";
import { DASH, fmtLinkSpeed, fmtMbit, fmtTime } from "@/lib/format";
import type { Health } from "@/lib/health";
import { Num } from "./bits";

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 border-b border-line py-2 last:border-b-0">
      <dt className="text-sm text-fg-3">{label}</dt>
      <dd className="min-w-0 text-right text-sm text-fg">{children}</dd>
    </div>
  );
}

/** Verbindungskontext live (1 Hz): erwartete vs. tatsächliche Schnittstelle, Link, eigener Durchsatz. */
export function LiveContext() {
  const conn = useLiveConnection();
  const client = useClientState();
  const session = useSession();
  const offline = conn.status === "offline" || conn.status === "unavailable";

  const title = (
    <span className="inline-flex items-center gap-2">
      <Activity aria-hidden className="size-5 text-fg-3" strokeWidth={1.75} />
      Verbindung jetzt
    </span>
  );

  if (offline) {
    return (
      <Panel title={title}>
        <EmptyState icon={PlugZap} title="Mess-Engine nicht erreichbar">
          Live-Werte kommen von der Mess-Engine. Läuft der Befehl <code className="text-fg">npm run dev</code> noch?
        </EmptyState>
      </Panel>
    );
  }
  if (!client) {
    if (conn.status === "connecting" || conn.status === "idle") {
      return (
        <Panel title={title}>
          <div className="flex flex-col gap-3" aria-busy="true" aria-label="Live-Werte werden geladen">
            <Skeleton className="h-5 w-2/3" />
            <Skeleton className="h-5 w-1/2" />
            <Skeleton className="h-5 w-3/5" />
          </div>
        </Panel>
      );
    }
    return (
      <Panel title={title}>
        <EmptyState icon={Activity} title={session ? "Warte auf den ersten Messtakt" : "Kein Langzeittest aktiv"}>
          {session
            ? "Die Mess-Engine meldet Link und Ausgangsschnittstelle jede Sekunde – gleich geht es los."
            : "Link-Status, Ausgangsschnittstelle und eigener Durchsatz werden sekündlich gemessen, solange ein Langzeittest läuft. Starte ihn über die Statusleiste."}
        </EmptyState>
      </Panel>
    );
  }

  const wlanFallback = client.onExpected === false;
  const state: Health = client.onExpected == null ? "unknown" : wlanFallback ? "crit" : "good";
  const linkHealth: Health = client.linkUp === false ? "crit" : client.linkMbps != null && client.linkMbps < 1000 ? "warn" : client.linkUp ? "good" : "unknown";

  return (
    <Panel title={title} description="Sekündlich aus dem Messtakt – zeigt sofort, ob Windows aufs WLAN ausweicht" actions={<HealthBadge status={state} label={wlanFallback ? "WLAN-Ausweichen" : undefined} />}>
      <dl>
        <Row label="Erwartete Schnittstelle">
          <Num>{client.expectedIf ?? DASH}</Num>
        </Row>
        <Row label="Tatsächlich (IPv4)">
          <span className="inline-flex flex-col items-end">
            <Num className={wlanFallback ? "text-crit" : undefined}>{client.egressV4If ?? DASH}</Num>
            {client.egressV4Address && <Num className="text-xs text-fg-3">{client.egressV4Address}</Num>}
          </span>
        </Row>
        <Row label="Tatsächlich (IPv6)">
          <span className="inline-flex flex-col items-end">
            <Num>{client.egressV6If ?? DASH}</Num>
            {client.egressV6Address && <Num className="break-all text-xs text-fg-3">{client.egressV6Address}</Num>}
          </span>
        </Row>
        <Row label="Link">
          <span className="inline-flex items-center gap-2">
            <Num>{client.linkUp === false ? "getrennt" : fmtLinkSpeed(client.linkMbps)}</Num>
            {linkHealth !== "good" && linkHealth !== "unknown" && <HealthBadge status={linkHealth} size="sm" />}
          </span>
        </Row>
        <Row label="Eigener Durchsatz">
          <span className="inline-flex flex-wrap justify-end gap-x-3">
            <span className="inline-flex items-center gap-1">
              <ArrowDown aria-hidden className="size-3.5 text-fg-3" strokeWidth={2} />
              <Num>{fmtMbit(client.rxMbps)}</Num>
              <span className="sr-only">Empfang</span>
            </span>
            <span className="inline-flex items-center gap-1">
              <ArrowUp aria-hidden className="size-3.5 text-fg-3" strokeWidth={2} />
              <Num>{fmtMbit(client.txMbps)}</Num>
              <span className="sr-only">Senden</span>
            </span>
          </span>
        </Row>
        <Row label="Spiel läuft">
          <span className="inline-flex items-center gap-1.5">
            {client.gaming && <Gamepad2 aria-hidden className="size-4 text-laser" strokeWidth={2} />}
            {client.gaming ? "ja" : "nein"}
          </span>
        </Row>
        <Row label="Standby verhindert">
          <span className="inline-flex items-center gap-1.5">
            <Moon aria-hidden className="size-3.5 text-fg-3" strokeWidth={2} />
            {client.preventSleep ? "ja, während des Tests" : "nein"}
          </span>
        </Row>
      </dl>
      {wlanFallback && (
        <p className="mt-3 text-sm text-crit">
          Der Internetverkehr läuft gerade nicht über {client.expectedIf ?? "die erwartete Schnittstelle"}. Spielverbindungen brechen dabei ab, weil sich die
          IP-Adresse ändert.
        </p>
      )}
      <p className="mt-3 text-xs text-fg-3">
        Stand <Num>{fmtTime(client.ts)}</Num>
      </p>
    </Panel>
  );
}
