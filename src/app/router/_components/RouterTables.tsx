"use client";

import { useMemo, useState } from "react";
import { ListClock, MonitorSmartphone } from "lucide-react";
import type { RouterAttachedDevice, RouterLogEntry } from "@/lib/shared/types";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { Switch } from "@/components/ui/Field";
import { HealthBadge } from "@/components/ui/HealthBadge";
import { Panel } from "@/components/ui/Panel";
import { EmptyState } from "@/components/ui/States";
import { DASH, fmtDateTime } from "@/lib/format";
import { severityToUi } from "@/lib/health";
import { Chip, Note, Num } from "./bits";

/* -------------------------------------------------------------------------- */
/* Geräteliste                                                                 */
/* -------------------------------------------------------------------------- */

/** "1000 Mbps" / "100 Mbps" / "1 Gbps" -> Mbit/s */
export function parseSpeedMbps(s: string | null): number | null {
  if (!s) return null;
  const m = /(\d+(?:[.,]\d+)?)\s*([mg])/i.exec(s);
  if (!m) return null;
  const v = Number(m[1].replace(",", "."));
  if (!Number.isFinite(v)) return null;
  return m[2].toLowerCase() === "g" ? v * 1000 : v;
}

const KIND_LABEL: Record<RouterAttachedDevice["kind"], string> = { lan: "LAN", wlan: "WLAN", guest: "Gast-WLAN" };

function isSlowLan(d: RouterAttachedDevice): boolean {
  const mbps = parseSpeedMbps(d.speed);
  return d.kind === "lan" && mbps != null && mbps <= 100;
}

const DEVICE_COLUMNS: Column<RouterAttachedDevice>[] = [
  {
    key: "name",
    header: "Gerät",
    render: (d) => (
      <span className="inline-flex flex-wrap items-center gap-2 py-1">
        <span className={d.isThisPc ? "font-medium text-fg" : undefined}>{d.hostName ?? "unbenanntes Gerät"}</span>
        {d.isThisPc && <Chip tone="fiber">Dieser PC</Chip>}
      </span>
    ),
  },
  { key: "ip", header: "IP-Adresse", render: (d) => <Num>{d.ipv4 ?? d.ipv6 ?? DASH}</Num> },
  { key: "mac", header: "MAC-Adresse", render: (d) => <Num>{d.mac ?? DASH}</Num> },
  { key: "kind", header: "Anschluss", render: (d) => KIND_LABEL[d.kind] },
  {
    key: "speed",
    header: "Geschwindigkeit",
    align: "right",
    render: (d) =>
      isSlowLan(d) ? (
        <span className="inline-flex items-center justify-end gap-2">
          <Num className="text-warn">{d.speed}</Num>
          <HealthBadge status="warn" size="sm" />
        </span>
      ) : (
        <Num>{d.speed ?? DASH}</Num>
      ),
  },
];

export function AttachedDevices({ devices, loginReady }: { devices: readonly RouterAttachedDevice[] | null; loginReady: boolean }) {
  const rows = useMemo(() => {
    const list = [...(devices ?? [])];
    list.sort((a, b) => Number(b.isThisPc) - Number(a.isThisPc) || a.kind.localeCompare(b.kind) || (a.hostName ?? "").localeCompare(b.hostName ?? "", "de"));
    return list;
  }, [devices]);
  const pc = rows.find((d) => d.isThisPc) ?? null;
  const pcSlow = pc != null && isSlowLan(pc);

  return (
    <Panel title="Geräte am Router" description="Was die Vodafone Station sieht – inklusive der Port-Geschwindigkeit dieses PCs aus Routersicht">
      {pcSlow && (
        <Note tone="warn" title="Dieser PC ist nur mit 100 Mbit/s verbunden" className="mb-4">
          Auch der Router meldet für deinen PC „<Num>{pc.speed}</Num>“. Gigabit braucht alle vier Adernpaare – typisch sind ein beschädigtes Kabel, ein
          lockerer Stecker oder ein defekter Port. Tausche zuerst das Kabel direkt zwischen PC und Station.
        </Note>
      )}
      {pc && !pcSlow && pc.kind === "lan" && parseSpeedMbps(pc.speed) != null && (
        <Note tone="info" title="Router sieht diesen PC mit Gigabit" className="mb-4">
          Port-Geschwindigkeit aus Routersicht: <Num>{pc.speed}</Num>.
        </Note>
      )}
      <DataTable
        columns={DEVICE_COLUMNS}
        rows={rows}
        rowKey={(d) => `${d.kind}:${d.mac ?? d.ipv4 ?? d.hostName ?? "?"}`}
        caption="Geräte am Router mit IP-Adresse, MAC-Adresse, Anschluss und Geschwindigkeit"
        dense
        maxHeight="26rem"
        empty={
          <EmptyState icon={MonitorSmartphone} title={loginReady ? "Noch keine Geräteliste" : "Geräteliste braucht das Router-Passwort"}>
            {loginReady
              ? "Die Liste kommt mit der nächsten DOCSIS-Abfrage."
              : "Mit Anmeldung zeigt Netzpuls alle Geräte und die Port-Geschwindigkeit deines PCs aus Routersicht."}
          </EmptyState>
        }
      />
    </Panel>
  );
}

/* -------------------------------------------------------------------------- */
/* Router-Protokoll                                                            */
/* -------------------------------------------------------------------------- */

const CATEGORY_LABEL: Record<string, string> = {
  T3: "T3-Timeout",
  T4: "T4-Timeout",
  T2: "T2-Timeout",
  ranging: "Ranging",
  sync: "Synchronisation",
  ucd: "Upstream-Beschreibung",
  partial: "Teilbetrieb",
  mdd: "MDD",
  drw: "Sendepegel-Limit",
  "cm-status": "CM-Status",
  profile: "OFDM-Profil",
  dhcp: "DHCP",
  provisioning: "Provisionierung",
  tod: "Zeitserver",
  reboot: "Neustart",
  other: "Sonstiges",
};

interface LogRow extends RouterLogEntry {
  key: string;
}

const LOG_COLUMNS: Column<LogRow>[] = [
  { key: "time", header: "Zeit", width: "11.5rem", render: (e) => <Num className="whitespace-nowrap">{e.ts != null ? fmtDateTime(e.ts) : e.timeText}</Num> },
  { key: "cat", header: "Kategorie", width: "10rem", render: (e) => CATEGORY_LABEL[e.category] ?? e.category },
  { key: "sev", header: "Schwere", width: "8rem", render: (e) => <HealthBadge status={severityToUi(e.severity)} size="sm" /> },
  { key: "msg", header: "Meldung", render: (e) => <span className="block min-w-[16rem] py-1.5 font-mono text-xs leading-5 text-fg-2">{e.message}</span> },
];

export function RouterLog({ log, loginReady }: { log: readonly RouterLogEntry[]; loginReady: boolean }) {
  const [onlyIssues, setOnlyIssues] = useState(false);
  const rows = useMemo<LogRow[]>(
    () => log.filter((e) => !onlyIssues || e.severity !== "info").map((e, i) => ({ ...e, key: `${e.ts ?? e.timeText}-${i}` })),
    [log, onlyIssues],
  );
  const counts = useMemo(() => {
    const c = { T3: 0, T4: 0, crit: 0 };
    for (const e of log) {
      if (e.category === "T3") c.T3++;
      if (e.category === "T4") c.T4++;
      if (e.severity === "critical") c.crit++;
    }
    return c;
  }, [log]);

  return (
    <Panel
      title="Router-Protokoll"
      description="Ereignisse der Kabelverbindung aus dem Protokoll der Station (neueste zuerst)"
      actions={log.length > 0 ? <Switch id="router-log-issues" label="Nur Auffälliges" checked={onlyIssues} onChange={(e) => setOnlyIssues(e.target.checked)} /> : undefined}
    >
      {log.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-2">
          <Chip>
            <Num>{log.length}</Num>&nbsp;Einträge
          </Chip>
          <Chip tone={counts.T3 > 0 ? "warn" : "neutral"}>
            T3-Timeouts:&nbsp;<Num>{counts.T3}</Num>
          </Chip>
          <Chip tone={counts.T4 > 0 ? "warn" : "neutral"}>
            T4-Timeouts:&nbsp;<Num>{counts.T4}</Num>
          </Chip>
          <Chip tone={counts.crit > 0 ? "warn" : "neutral"}>
            kritisch:&nbsp;<Num>{counts.crit}</Num>
          </Chip>
        </div>
      )}
      <DataTable
        columns={LOG_COLUMNS}
        rows={rows}
        rowKey={(e) => e.key}
        caption="Router-Protokoll mit Zeit, Kategorie, Schwere und Meldung"
        dense
        maxHeight="28rem"
        empty={
          <EmptyState icon={ListClock} title={log.length > 0 ? "Keine auffälligen Einträge" : loginReady ? "Keine Protokolleinträge im Zeitraum" : "Protokoll braucht das Router-Passwort"}>
            {log.length > 0
              ? "Im Zeitraum gibt es nur Hinweise. Schalte „Nur Auffälliges“ aus, um alle Einträge zu sehen."
              : loginReady
                ? "Die Station hat im gewählten Zeitraum nichts protokolliert. Wähle einen längeren Zeitraum."
                : "Mit Anmeldung liest Netzpuls T3/T4-Timeouts, Synchronisationsverluste und Neustarts aus dem Router-Protokoll."}
          </EmptyState>
        }
      />
      <p className="mt-3 text-xs text-fg-3">
        T3-Timeouts vereinzelt sind normal; gehäuft (ab 3 in 10 Minuten) sowie jeder T4-Timeout oder Synchronisationsverlust deuten auf Störungen im Kabelnetz.
      </p>
    </Panel>
  );
}
