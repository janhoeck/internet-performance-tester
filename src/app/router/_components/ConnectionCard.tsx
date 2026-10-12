"use client";

import { ExternalLink, Router as RouterIcon } from "lucide-react";
import type { RouterStatus } from "@/lib/shared/types";
import { HealthBadge } from "@/components/ui/HealthBadge";
import { Panel } from "@/components/ui/Panel";
import { DASH, fmtDateTime, fmtDuration, fmtMs, fmtRelative } from "@/lib/format";
import type { Health } from "@/lib/health";
import { Chip, KeyValueList, Note, Num, type KeyValueItem } from "./bits";

function rebootReasonText(raw: string | null): { text: string; raw: string | null } {
  if (raw == null || raw.trim() === "") return { text: DASH, raw: null };
  const s = raw.trim();
  const l = s.toLowerCase();
  if (l === "unknown" || l === "unbekannt") return { text: "unbekannt (vom Router nicht gemeldet)", raw: null };
  if (l.includes("power on") || l.includes("power-on")) return { text: "Stromunterbrechung", raw: s };
  if (l.includes("gui") || l.includes("user") || l.includes("web")) return { text: "Neustart über die Weboberfläche", raw: s };
  if (l.includes("factory")) return { text: "Werkseinstellungen", raw: s };
  return { text: s, raw: null };
}

function connectionHealth(s: RouterStatus): Health {
  if (!s.reachable) return "crit";
  if (s.connectionStatus == null) return "unknown";
  return /docsis\s*online|^online$|operational/i.test(s.connectionStatus) ? "good" : "crit";
}

function flag(v: string | number | boolean | null | undefined): boolean | null {
  if (typeof v === "boolean") return v;
  if (v === "true" || v === 1 || v === "1") return true;
  if (v === "false" || v === 0 || v === "0") return false;
  return null;
}

export function ConnectionCard({
  status,
  httpMedianMs,
  engineOffline,
  now,
}: {
  status: RouterStatus;
  httpMedianMs: number | null;
  engineOffline: boolean;
  now: number | null;
}) {
  const conn = connectionHealth(status);
  const reboot = rebootReasonText(status.lastRebootReason);
  const bandSteering = flag(status.extra?.isBandSteeringEnabled);
  const dfs = flag(status.extra?.isDFSEnabled);
  const failover = typeof status.extra?.docsisFailoverStatus === "string" ? status.extra.docsisFailoverStatus : null;
  const hasPublicV4 = status.wanIpv4 != null && status.wanIpv4 !== "0.0.0.0";

  const items: KeyValueItem[] = [
    { label: "Modell", value: status.model ?? DASH, hint: status.vendor ? `Hersteller: ${status.vendor}` : undefined },
    { label: "Firmware", value: <Num>{status.firmware ?? DASH}</Num> },
    {
      label: "IP-Adresse",
      value: (
        <a
          href={`http://${status.ip}`}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-fiber underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fiber"
        >
          <Num>http://{status.ip}</Num>
          <ExternalLink aria-hidden className="size-3.5" strokeWidth={2} />
          <span className="sr-only">(Weboberfläche in neuem Tab öffnen)</span>
        </a>
      ),
    },
    {
      label: "DOCSIS-Status",
      value: (
        <span className="inline-flex flex-wrap items-center gap-2">
          <Num>{status.connectionStatus ?? DASH}</Num>
          <HealthBadge status={conn} size="sm" />
        </span>
      ),
    },
    {
      label: "DS-Lite",
      value: status.dsLite == null ? DASH : status.dsLite ? "aktiv (IPv4 über Vodafone-AFTR)" : "nicht aktiv (Dual-Stack)",
      hint: status.dsLite ? "Keine eigene öffentliche IPv4-Adresse – IPv4 läuft getunnelt über das DS-Lite-Gateway (AFTR)." : undefined,
    },
    { label: "AFTR (DS-Lite-Gateway)", value: <Num>{status.aftrAddress ?? DASH}</Num> },
    { label: "WAN-IPv6", value: <Num>{status.wanIpv6 ?? DASH}</Num> },
    {
      label: "WAN-IPv4",
      value: hasPublicV4 ? <Num>{status.wanIpv4}</Num> : status.dsLite ? "keine eigene (DS-Lite)" : DASH,
    },
    {
      label: "Laufzeit",
      value: status.uptimeSec != null ? <Num>{fmtDuration(status.uptimeSec)}</Num> : <span className="text-fg-3">nur mit Router-Passwort</span>,
    },
    {
      label: "Letzter Neustartgrund",
      value: reboot.text,
      hint: reboot.raw ? (
        <>
          Router meldet „<Num>{reboot.raw}</Num>“
        </>
      ) : undefined,
    },
    {
      label: "Antwortzeit der Weboberfläche",
      value: <Num>{status.reachable ? fmtMs(status.httpMs) : "keine Antwort"}</Num>,
      hint: httpMedianMs != null ? <>Median im Zeitraum: <Num>{fmtMs(httpMedianMs)}</Num></> : undefined,
    },
    {
      label: "Stand",
      value: <Num>{fmtDateTime(status.ts)}</Num>,
      hint: now != null ? fmtRelative(status.ts, now) : undefined,
    },
  ];

  return (
    <Panel
      title={
        <span className="inline-flex items-center gap-2">
          <RouterIcon aria-hidden className="size-5 text-fg-3" strokeWidth={1.75} />
          Vodafone Station
        </span>
      }
      description="Verbindungsdaten der Startseite – ohne Anmeldung abgefragt"
      actions={<HealthBadge status={status.reachable ? "good" : "crit"} label={status.reachable ? "Erreichbar" : "Nicht erreichbar"} />}
      frame
    >
      {!status.reachable && (
        <Note tone="crit" title={`Router nicht erreichbar (${status.ip})`} className="mb-4">
          Prüfe das LAN-Kabel und ob die Vodafone Station eingeschaltet ist. Angezeigt werden die zuletzt gelesenen Werte.
        </Note>
      )}
      {engineOffline && (
        <Note tone="warn" title="Mess-Engine nicht erreichbar" className="mb-4">
          Angezeigt wird der zuletzt gespeicherte Stand. Läuft der Befehl <code className="text-fg">npm run dev</code> noch?
        </Note>
      )}
      <KeyValueList items={items} columns={3} />
      {(bandSteering != null || dfs != null || failover != null) && (
        <div className="mt-4 flex flex-wrap gap-2">
          {bandSteering != null && <Chip>Band Steering {bandSteering ? "an" : "aus"}</Chip>}
          {dfs != null && <Chip>DFS-Kanäle {dfs ? "an" : "aus"}</Chip>}
          {failover != null && failover !== "none" && <Chip tone="warn">Mobilfunk-Ausweichbetrieb: {failover}</Chip>}
        </div>
      )}
    </Panel>
  );
}
