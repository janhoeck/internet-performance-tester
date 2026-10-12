"use client";

import { EthernetPort, Layers, Wifi } from "lucide-react";
import type { AdapterInfo } from "@/lib/shared/types";
import { HealthBadge, HealthDot } from "@/components/ui/HealthBadge";
import { Panel } from "@/components/ui/Panel";
import { EmptyState } from "@/components/ui/States";
import { DASH, fmtDate, fmtInt, fmtLinkSpeed } from "@/lib/format";
import { useOsWording } from "@/lib/client/platform";
import type { Health } from "@/lib/health";
import { Chip, KeyValueList, Num, type KeyValueItem } from "./bits";
import { adapterConnected, adapterStatusText, isNetAdapterDriver, sortAddresses } from "./pc-model";

function Addresses({ list }: { list: readonly string[] }) {
  const { main, local } = sortAddresses(list);
  if (list.length === 0) return <span className="text-fg-3">keine</span>;
  return (
    <span className="flex flex-col gap-0.5">
      {main.map((a) => (
        <Num key={a} className="break-all">
          {a}
        </Num>
      ))}
      {local.map((a) => (
        <Num key={a} className="break-all text-xs text-fg-3">
          {a} (lokal)
        </Num>
      ))}
    </span>
  );
}

function driverDateText(d: string | null): string {
  if (!d) return "";
  const ts = Date.parse(d);
  return Number.isFinite(ts) ? ` vom ${fmtDate(ts)}` : ` (${d})`;
}

function errorsText(a: AdapterInfo): { text: string; health: Health } {
  const vals = [a.rxErrors, a.txErrors, a.rxDiscards, a.txDiscards];
  if (vals.every((v) => v == null)) return { text: DASH, health: "unknown" };
  const sum = vals.reduce<number>((s, v) => s + (v ?? 0), 0);
  return {
    text: `${fmtInt(a.rxErrors)} / ${fmtInt(a.txErrors)} Fehler, ${fmtInt(a.rxDiscards)} / ${fmtInt(a.txDiscards)} verworfen`,
    health: sum > 0 ? "warn" : "good",
  };
}

export function EthernetCard({ a }: { a: AdapterInfo | null }) {
  const os = useOsWording();
  const mac = os.id === "macos";
  if (!a) {
    return (
      <Panel title="Ethernet">
        <EmptyState icon={EthernetPort} title="Kein Ethernet-Adapter gefunden">
          {mac
            ? "macOS meldet keinen kabelgebundenen Netzwerkanschluss. Ist der USB- oder Thunderbolt-Adapter angesteckt und unter Systemeinstellungen → Netzwerk aktiv?"
            : "Windows meldet keinen kabelgebundenen Netzwerkadapter. Ist der Adapter im Gerätemanager deaktiviert?"}
        </EmptyState>
      </Panel>
    );
  }
  const up = adapterConnected(a);
  const slow = up && a.linkMbps != null && a.linkMbps < 1000;
  const err = errorsText(a);
  const netAdapter = isNetAdapterDriver(a);
  const items: KeyValueItem[] = [
    {
      label: "Status",
      value: (
        <span className="inline-flex items-center gap-2">
          <HealthDot status={up ? "good" : "crit"} />
          {adapterStatusText(a)}
        </span>
      ),
    },
    {
      label: "Link",
      value: (
        <span className="inline-flex flex-wrap items-center gap-2">
          <Num>{up ? fmtLinkSpeed(a.linkMbps) : DASH}</Num>
          {slow && <HealthBadge status="warn" size="sm" label="unter 1 Gbit/s" />}
        </span>
      ),
      hint: slow ? "Gigabit braucht alle vier Adernpaare – Kabel, Stecker oder Port prüfen." : undefined,
    },
    {
      label: "Treiber",
      value:
        mac && !a.driverVersion ? (
          <span className="text-fg-3">von macOS verwaltet</span>
        ) : (
          <span>
            <Num>{a.driverVersion ?? DASH}</Num>
            {driverDateText(a.driverDate)}
          </span>
        ),
      hint: a.serviceName ? (
        <span className="inline-flex flex-wrap items-center gap-1.5">
          Dienst <Num>{a.serviceName}</Num>
          {netAdapter && <Chip tone="fiber">NetAdapter-Treiber (Windows 11)</Chip>}
        </span>
      ) : undefined,
    },
    { label: "MAC-Adresse", value: <Num>{a.mac ?? DASH}</Num> },
    { label: "Adressen", value: <Addresses list={a.addresses} /> },
    {
      label: "Fehlerzähler (Empfang/Senden)",
      value: <Num className={err.health === "warn" ? "text-warn" : undefined}>{err.text}</Num>,
      hint: `seit dem letzten ${os.name}-Start`,
    },
  ];
  return (
    <Panel
      title={
        <span className="inline-flex items-center gap-2">
          <EthernetPort aria-hidden className="size-5 text-fg-3" strokeWidth={1.75} />
          {a.name}
        </span>
      }
      description={a.description}
      actions={<HealthBadge status={!up ? "crit" : slow ? "warn" : "good"} label={!up ? "Getrennt" : slow ? "Langsamer Link" : "Gut"} />}
      frame
    >
      <KeyValueList items={items} columns={2} />
    </Panel>
  );
}

export function WifiCard({ a }: { a: AdapterInfo | null }) {
  const os = useOsWording();
  if (!a) {
    return (
      <Panel title="WLAN-Adapter">
        <EmptyState icon={Wifi} title="Kein WLAN-Adapter">
          {os.id === "macos" ? "Dieser Mac" : "Dieser PC"} hat keinen WLAN-Adapter – es gibt also kein WLAN-Ausweichen bei Kabelabbrüchen.
        </EmptyState>
      </Panel>
    );
  }
  const up = adapterConnected(a);
  return (
    <Panel
      title={
        <span className="inline-flex items-center gap-2">
          <Wifi aria-hidden className="size-5 text-fg-3" strokeWidth={1.75} />
          WLAN-Adapter
          {a.name !== "WLAN" && a.name !== "Wi-Fi" && <span className="text-sm font-normal text-fg-3">({a.name})</span>}
        </span>
      }
      description={a.description}
      actions={up ? <Chip tone="warn">verbunden</Chip> : <Chip>getrennt</Chip>}
    >
      <KeyValueList
        columns={2}
        items={[
          { label: "Status", value: adapterStatusText(a), hint: up ? `Leitet ${os.name} bei einem Kabelabbruch hierher um, wechselt die IP-Adresse.` : "Gut so – Spiele laufen übers Kabel." },
          { label: "Link", value: <Num>{up ? fmtLinkSpeed(a.linkMbps) : DASH}</Num> },
          {
            label: "Treiber",
            value:
              os.id === "macos" && !a.driverVersion ? (
                <span className="text-fg-3">von macOS verwaltet</span>
              ) : (
                <span>
                  <Num>{a.driverVersion ?? DASH}</Num>
                  {driverDateText(a.driverDate)}
                </span>
              ),
          },
          { label: "MAC-Adresse", value: <Num>{a.mac ?? DASH}</Num> },
          { label: "Adressen", value: <Addresses list={a.addresses} /> },
        ]}
      />
    </Panel>
  );
}

export function VirtualAdapters({ list }: { list: readonly AdapterInfo[] }) {
  return (
    <Panel
      title={
        <span className="inline-flex items-center gap-2">
          <Layers aria-hidden className="size-5 text-fg-3" strokeWidth={1.75} />
          Virtuelle Adapter
        </span>
      }
      description="VPN-Tunnel, Bluetooth und weitere – für Spieleverkehr normalerweise ohne Bedeutung"
    >
      {list.length === 0 ? (
        <p className="text-sm text-fg-3">Keine virtuellen Adapter.</p>
      ) : (
        <ul className="divide-y divide-line">
          {list.map((a) => {
            const up = adapterConnected(a);
            const { main } = sortAddresses(a.addresses);
            return (
              <li key={`${a.ifIndex}-${a.name}`} className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 py-2.5 first:pt-0 last:pb-0">
                <div className="min-w-0">
                  <p className="text-sm text-fg">{a.name}</p>
                  <p className="truncate text-xs text-fg-3">{a.description}</p>
                </div>
                <div className="flex flex-col items-end gap-0.5 text-right">
                  <span className="inline-flex items-center gap-1.5 text-xs text-fg-2">
                    <HealthDot status={up ? "info" : "unknown"} />
                    {adapterStatusText(a)}
                  </span>
                  {main[0] && <Num className="text-xs text-fg-3">{main.find((x) => !x.includes(":")) ?? main[0]}</Num>}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}
