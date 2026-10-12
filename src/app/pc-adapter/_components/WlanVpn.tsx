"use client";

import { useMemo } from "react";
import { ShieldCheck, Wifi, WifiOff } from "lucide-react";
import type { MetricsResponse } from "@/lib/shared/api-types";
import type { VpnInfo, WlanInfo } from "@/lib/shared/types";
import { HealthBadge } from "@/components/ui/HealthBadge";
import { Panel } from "@/components/ui/Panel";
import { EmptyState } from "@/components/ui/States";
import { EChart } from "@/components/viz/EChart";
import { DASH, fmtDateTime, fmtInt, fmtMbit } from "@/lib/format";
import type { Health } from "@/lib/health";
import { Chip, KeyValueList, Note, Num } from "./bits";
import { metricLinesOption } from "./pc-charts";

function hasValues(m: MetricsResponse | null, key: string): boolean {
  return (m?.series[key]?.value ?? []).some((v) => v != null);
}

export function WlanPanel({ wlan, metrics, from, to }: { wlan: WlanInfo | null; metrics: MetricsResponse | null; from: number | null; to: number | null }) {
  const hasHistory = hasValues(metrics, "wlan.signal_pct");
  const option = useMemo(() => {
    const s = metrics?.series["wlan.signal_pct"];
    if (!metrics || !s) return null;
    return metricLinesOption({
      lines: [{ id: "signal", name: "WLAN-Signal", ts: s.ts, values: s.value, slot: 3 }],
      stepMs: metrics.stepMs,
      unit: "%",
      digits: 0,
      from,
      to,
      yMin: 0,
      yMax: 100,
      threshold: { value: 60, label: "unter 60 %: auffällig" },
    });
  }, [metrics, from, to]);

  const title = (
    <span className="inline-flex items-center gap-2">
      <Wifi aria-hidden className="size-5 text-fg-3" strokeWidth={1.75} />
      WLAN-Verbindung
    </span>
  );

  if (!wlan || !wlan.present) {
    return (
      <Panel title={title}>
        <EmptyState icon={WifiOff} title="Kein WLAN-Adapter erkannt">
          Ohne WLAN gibt es auch kein Ausweichen bei Kabelabbrüchen.
        </EmptyState>
      </Panel>
    );
  }

  const signalHealth: Health =
    wlan.signalPct == null ? "unknown" : wlan.signalPct < 60 || (wlan.rssiDbm != null && wlan.rssiDbm < -67) ? "warn" : "good";

  return (
    <Panel
      title={title}
      description={wlan.connected ? "Funkverbindung der Vodafone Station zu diesem PC" : "Der PC ist nicht mit einem WLAN verbunden"}
      actions={wlan.connected ? <HealthBadge status={signalHealth} label={signalHealth === "good" ? "Signal gut" : signalHealth === "warn" ? "Signal schwach" : undefined} /> : <Chip>getrennt</Chip>}
    >
      {wlan.connected ? (
        <>
          <Note tone="warn" title="WLAN ist verbunden" className="mb-4">
            Läuft gleichzeitig das Kabel, ist das harmlos. Wechselt Windows bei einem Kabelabbruch hierher, ändert sich die IP-Adresse und Spielverbindungen
            brechen ab. Für den Test kannst du „Automatisch verbinden“ für dieses WLAN ausschalten.
          </Note>
          <KeyValueList
            columns={3}
            items={[
              { label: "Netzwerk (SSID)", value: <Num>{wlan.ssid ?? DASH}</Num> },
              { label: "Access Point (BSSID)", value: <Num>{wlan.bssid ?? DASH}</Num> },
              { label: "Standard", value: wlan.radioType ?? DASH },
              { label: "Band und Kanal", value: <Num>{[wlan.band, wlan.channel != null ? `Kanal ${wlan.channel}` : null].filter(Boolean).join(", ") || DASH}</Num> },
              {
                label: "Signal",
                value: (
                  <Num>
                    {wlan.signalPct != null ? `${fmtInt(wlan.signalPct)} %` : DASH}
                    {wlan.rssiDbm != null ? ` (${String(wlan.rssiDbm).replace("-", "−")} dBm)` : ""}
                  </Num>
                ),
                hint: "auffällig unter 60 % bzw. −67 dBm",
              },
              { label: "Empfangs-/Senderate", value: <Num>{`${fmtMbit(wlan.rxMbps)} / ${fmtMbit(wlan.txMbps)}`}</Num> },
            ]}
          />
        </>
      ) : (
        <p className="text-sm text-fg-2">Gut so: Spieleverkehr läuft übers Kabel. Stand {<Num>{fmtDateTime(wlan.ts)}</Num>}.</p>
      )}
      {hasHistory && option && (
        <div className="mt-5">
          <h3 className="mb-2 text-sm font-medium text-fg-2">Signalverlauf im Zeitraum</h3>
          <EChart option={option} ariaLabel="WLAN-Signal in Prozent im gewählten Zeitraum" height={200} />
        </div>
      )}
    </Panel>
  );
}

const SPLIT_TEXT = {
  include:
    "Split-Tunnel im Einschluss-Modus: Nur die in WARP eingetragenen (Firmen-)Netze laufen durch den Tunnel. Spiele und alles andere gehen direkt ins Internet – WARP ist für Lags nicht verantwortlich.",
  exclude:
    "Split-Tunnel im Ausschluss-Modus: Alles außer den eingetragenen Ausnahmen läuft durch den Tunnel – auch Spieleverkehr. Das kann Ping und Paketverlust verschlechtern.",
} as const;

export function VpnPanel({ vpn }: { vpn: VpnInfo | null }) {
  const title = (
    <span className="inline-flex items-center gap-2">
      <ShieldCheck aria-hidden className="size-5 text-fg-3" strokeWidth={1.75} />
      VPN / Cloudflare WARP
    </span>
  );
  if (!vpn) {
    return (
      <Panel title={title}>
        <EmptyState icon={ShieldCheck} title="Noch kein VPN-Status">
          Die Mess-Engine prüft alle zwei Minuten, ob WARP oder ein anderes VPN aktiv ist.
        </EmptyState>
      </Panel>
    );
  }
  const w = vpn.warp;
  const fullTunnel = w?.connected === true && w.splitTunnel === "exclude";
  const status: Health = !w || !w.installed ? "good" : fullTunnel ? "warn" : "good";
  return (
    <Panel
      title={title}
      description="Läuft Spieleverkehr durch einen VPN-Tunnel? Netzpuls liest den Status nur und steuert WARP nie."
      actions={<HealthBadge status={status} label={fullTunnel ? "Spiele im Tunnel" : "Spiele direkt"} />}
    >
      {w && w.installed ? (
        <>
          <KeyValueList
            columns={3}
            items={[
              { label: "WARP-Status", value: <Num>{w.status ?? (w.connected ? "verbunden" : "getrennt")}</Num> },
              { label: "Modus", value: <Num>{w.mode ?? DASH}</Num> },
              { label: "Split-Tunnel", value: w.splitTunnel === "include" ? "Einschluss (nur eingetragene Netze)" : w.splitTunnel === "exclude" ? "Ausschluss (alles außer Ausnahmen)" : DASH },
            ]}
          />
          {w.splitTunnel && (
            <Note tone={w.splitTunnel === "exclude" ? "warn" : "info"} className="mt-4">
              {SPLIT_TEXT[w.splitTunnel]}
            </Note>
          )}
        </>
      ) : (
        <p className="text-sm text-fg-2">Cloudflare WARP ist nicht installiert.</p>
      )}
      {vpn.otherTunnels.length > 0 && (
        <div className="mt-4">
          <p className="text-xs text-fg-3">Weitere aktive Tunnel-Adapter</p>
          <div className="mt-1.5 flex flex-wrap gap-2">
            {vpn.otherTunnels.map((n) => (
              <Chip key={n} tone="warn">
                {n}
              </Chip>
            ))}
          </div>
        </div>
      )}
    </Panel>
  );
}
