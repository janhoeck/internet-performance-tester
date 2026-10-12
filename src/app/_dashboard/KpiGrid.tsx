"use client";

import { useMemo, type ReactNode } from "react";
import Link from "next/link";
import { Activity, AudioWaveform, Cable, CalendarClock, Gamepad2, Gauge, PackageX, Timer, Unplug, Waves, Wifi, type LucideIcon } from "lucide-react";
import type {
  ClientResponse,
  DiagnosisResponse,
  RouterResponse,
  SecondsResponse,
  SpeedtestsResponse,
  StatsResponse,
} from "@/lib/shared/api-types";
import type { AdapterInfo, ClientState } from "@/lib/shared/types";
import { DEFAULT_CONFIG } from "@/lib/shared/config";
import { gradeHealth, gradeLabel } from "@/lib/shared/grading";
import { useClientState, useLiveSampleMap } from "@/lib/client/live-store";
import { rateLoss, rateUi } from "@/lib/client/segment-health";
import { useTargets } from "@/lib/client/targets";
import type { UseApiResult } from "@/lib/client/use-api";
import { DASH, NBSP, fmtDateTimeShort, fmtDuration, fmtInt, fmtLinkSpeed, fmtLossPct, fmtMbit, fmtMs, fmtMsValue, fmtNumber, fmtPct, fmtPctValue } from "@/lib/format";
import { toUiHealth, type Health } from "@/lib/health";
import { useNow } from "@/lib/use-now";
import { HealthBadge } from "@/components/ui/HealthBadge";
import { KpiTile } from "@/components/ui/KpiTile";
import { Sparkline } from "@/components/ui/Sparkline";
import { KpiSkeleton } from "@/components/ui/States";
import { pooledSpark, pooledStats } from "./live-kpis";
import { INTERNET_IDS, LIVE_HINT, type LiveMode } from "./use-dashboard";

const FIVE_MIN = 5 * 60_000;
const FIFTEEN_MIN = 15 * 60_000;

export interface KpiSources {
  diagnosis: UseApiResult<DiagnosisResponse>;
  seconds24: UseApiResult<SecondsResponse>;
  stats24: UseApiResult<StatsResponse>;
  client: UseApiResult<ClientResponse>;
  router: UseApiResult<RouterResponse>;
  speedtests: UseApiResult<SpeedtestsResponse>;
}

/* -------------------------------------------------------------------------- */
/* Kleine Bausteine                                                            */
/* -------------------------------------------------------------------------- */

/** Zusatzzeile in einer Kachel: Text + Messwert (np-num). */
function Line({ label, value, children }: { label?: string; value?: ReactNode; children?: ReactNode }) {
  return (
    <p className="text-xs text-fg-3">
      {label}
      {label && value != null ? " " : null}
      {value != null && <span className="np-num text-fg-2">{value}</span>}
      {children}
    </p>
  );
}

/** Kachel, deren Daten aus useApi stammen: Skeleton beim ersten Laden, Fehler mit Hinweis. */
function ApiTile<T>({
  result,
  label,
  icon,
  render,
}: {
  result: UseApiResult<T>;
  label: string;
  icon: LucideIcon;
  render: (data: T) => ReactNode;
}) {
  if (result.data == null) {
    if (result.error) {
      return (
        <KpiTile label={label} icon={icon} value={DASH} status="unknown">
          <Line>Laden fehlgeschlagen: {result.error.message}</Line>
        </KpiTile>
      );
    }
    return <KpiSkeleton />;
  }
  return <>{render(result.data)}</>;
}

function physicalAdapter(adapters: readonly AdapterInfo[] | undefined, name?: string | null): AdapterInfo | undefined {
  if (!adapters) return undefined;
  if (name) {
    const byName = adapters.find((a) => a.name === name);
    if (byName) return byName;
  }
  const real = adapters.filter((a) => !a.isVirtual && a.status === "Up");
  return real.find((a) => !a.isWifi) ?? real[0];
}

const looksLikeWifi = (name: string | null | undefined): boolean => !!name && /wlan|wi-?fi|wireless/i.test(name);

function shareHealth(sharePct: number | null, covered: number): Health {
  if (covered === 0 || sharePct == null) return "unknown";
  if (sharePct >= 1) return "crit";
  if (sharePct >= 0.1) return "warn";
  return "good";
}

const GAMING_HEALTH: Record<"A" | "B" | "C" | "D" | "F", Health> = { A: "good", B: "good", C: "warn", D: "crit", F: "crit" };

/* -------------------------------------------------------------------------- */
/* Live-Kacheln (Ringpuffer des Live-Streams)                                  */
/* -------------------------------------------------------------------------- */

function LiveTiles({ mode, stats24 }: { mode: LiveMode; stats24: UseApiResult<StatsResponse> }) {
  const samples = useLiveSampleMap();
  const now = useNow(2000);
  const { config, enabled } = useTargets();
  const thresholds = (config ?? DEFAULT_CONFIG).thresholds;
  const ids = useMemo(() => {
    const on = new Set(enabled.map((t) => t.id));
    const list = INTERNET_IDS.filter((id) => on.has(id));
    return list.length ? list : [...INTERNET_IDS];
  }, [enabled]);

  const live = useMemo(() => {
    if (now == null) return null;
    return {
      lat: pooledStats(samples, ids, now - FIVE_MIN, now + 1000),
      loss: pooledStats(samples, ids, now - FIFTEEN_MIN, now + 1000),
      spark: pooledSpark(samples, ids, now, FIFTEEN_MIN, 30),
    };
  }, [samples, ids, now]);

  const loss24 = useMemo(() => {
    const list = stats24.data?.stats.filter((s) => (ids as readonly string[]).includes(s.targetId)) ?? [];
    const sent = list.reduce((a, s) => a + s.sent, 0);
    const lost = list.reduce((a, s) => a + s.lost, 0);
    return sent > 0 ? (lost / sent) * 100 : null;
  }, [stats24.data, ids]);

  if (mode === "connecting" || live == null) {
    return (
      <>
        <KpiSkeleton />
        <KpiSkeleton />
        <KpiSkeleton />
      </>
    );
  }

  const hasData = mode === "running" && live.lat.sent > 0;
  const hint = mode === "running" ? "Warte auf Messwerte …" : LIVE_HINT[mode];
  const loss24Line = (
    <Line label="Letzte 24 Stunden:" value={stats24.data ? fmtLossPct(loss24) : stats24.error ? "nicht verfügbar" : "wird geladen …"} />
  );

  return (
    <>
      <KpiTile
        label="Internet-Latenz"
        icon={Activity}
        value={hasData ? fmtMsValue(live.lat.p50) : DASH}
        unit={hasData ? "ms" : undefined}
        status={hasData ? rateUi(live.lat.p50, thresholds.latency.internet) : "unknown"}
        caption={hasData ? "Median der letzten 5 min, 1.1.1.1 und 8.8.8.8 (IPv4 + IPv6)" : hint}
      >
        {hasData && <Sparkline values={live.spark} label="Latenz zu den Internetzielen, letzte 15 Minuten" threshold={thresholds.latency.internet.warn} />}
      </KpiTile>
      <KpiTile
        label="Jitter"
        icon={Waves}
        value={hasData && live.lat.jitter != null ? fmtNumber(live.lat.jitter) : DASH}
        unit={hasData && live.lat.jitter != null ? "ms" : undefined}
        status={hasData ? rateUi(live.lat.jitter, thresholds.jitter) : "unknown"}
        caption={hasData ? "Mittlere Schwankung von Ping zu Ping, letzte 5 min" : hint}
      >
        {hasData && <Line label="Auffällig über" value={fmtMs(thresholds.jitter.good)} />}
      </KpiTile>
      <KpiTile
        label="Paketverlust"
        icon={PackageX}
        value={hasData ? fmtPctValue(live.loss.lossPct) : DASH}
        unit={hasData ? "%" : undefined}
        status={hasData ? rateLoss(live.loss.lossPct, live.loss.lost, thresholds.loss) : "unknown"}
        caption={hasData ? "Letzte 15 min, alle Internetziele" : hint}
      >
        <div className="flex flex-col gap-0.5">
          {hasData && <Line label="Verlorene Pings:" value={`${fmtInt(live.loss.lost)} von ${fmtInt(live.loss.sent)}`} />}
          {loss24Line}
        </div>
      </KpiTile>
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Verbindung (Live-Kontext, sonst letzter Adapter-Snapshot)                   */
/* -------------------------------------------------------------------------- */

function ConnectionTile({ mode, client }: { mode: LiveMode; client: UseApiResult<ClientResponse> }) {
  const live: ClientState | null = useClientState();
  const useLiveCtx = mode === "running" && live != null;
  const adapters = client.data?.adapters?.adapters;

  if (!useLiveCtx && client.data == null) {
    if (client.error) {
      return (
        <KpiTile label="Verbindung" icon={Cable} value={DASH} status="unknown">
          <Line>Laden fehlgeschlagen: {client.error.message}</Line>
        </KpiTile>
      );
    }
    if (mode === "connecting" || client.loading) return <KpiSkeleton />;
  }

  let ifName: string | null;
  let wifi: boolean;
  let linkUp: boolean | null;
  let mbps: number | null;
  let failover = false;
  if (useLiveCtx) {
    ifName = live.egressV4If ?? live.expectedIf;
    const a = physicalAdapter(adapters, ifName);
    wifi = a ? a.isWifi : looksLikeWifi(ifName);
    linkUp = live.linkUp;
    mbps = live.linkMbps;
    failover = live.onExpected === false;
  } else {
    const a = physicalAdapter(adapters);
    ifName = a?.name ?? null;
    wifi = a?.isWifi ?? false;
    linkUp = a ? a.status === "Up" : null;
    mbps = a?.linkMbps ?? null;
  }

  const kind = ifName == null ? DASH : wifi ? "WLAN" : "Ethernet";
  let status: Health = "unknown";
  if (linkUp === false) status = "crit";
  else if (failover) status = "warn";
  else if (ifName != null && !wifi && mbps != null) status = mbps < 1000 ? "warn" : "good";
  else if (ifName != null && wifi) status = "warn";

  return (
    <KpiTile
      label="Verbindung"
      icon={wifi ? Wifi : Cable}
      value={kind}
      status={status}
      caption={useLiveCtx ? "Live-Zustand des PCs" : client.data?.adapters ? `Stand ${fmtDateTimeShort(client.data.adapters.ts)}` : "Kein Adapter-Snapshot vorhanden"}
    >
      <div className="flex flex-col gap-1">
        {ifName && <Line label={ifName} value={linkUp === false ? "getrennt" : mbps != null ? fmtLinkSpeed(mbps) : undefined} />}
        {!wifi && mbps != null && mbps < 1000 && linkUp !== false && <Line>Erwartet sind 1 Gbit/s – Kabel oder Port prüfen.</Line>}
        {failover && (
          <span>
            <HealthBadge status="warn" label="WLAN-Ausweichen" size="sm" />
          </span>
        )}
      </div>
    </KpiTile>
  );
}

/* -------------------------------------------------------------------------- */
/* Gitter                                                                      */
/* -------------------------------------------------------------------------- */

export function KpiGrid({ mode, sources }: { mode: LiveMode; sources: KpiSources }) {
  const { diagnosis, seconds24, stats24, client, router, speedtests } = sources;
  return (
    <section aria-label="Kennzahlen" className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      <LiveTiles mode={mode} stats24={stats24} />

      <ApiTile
        result={seconds24}
        label="Stark gestörte Sekunden"
        icon={Timer}
        render={(d) => {
          const covered = d.total.covered;
          const share = covered > 0 ? (d.total.ses / covered) * 100 : null;
          return (
            <KpiTile
              label="Stark gestörte Sekunden"
              icon={Timer}
              value={covered > 0 ? fmtInt(d.total.ses) : DASH}
              unit={covered > 0 ? "s" : undefined}
              status={shareHealth(share, covered)}
              caption={covered > 0 ? "Letzte 24 Stunden: halbe Pings verloren oder Ping ab 200 ms" : "Keine Messung in den letzten 24 Stunden"}
            >
              {covered > 0 && (
                <div className="flex flex-col gap-0.5">
                  <Line label="Anteil der Messzeit:" value={fmtPct(share)} />
                  <Line label="Gestört insgesamt:" value={`${fmtInt(d.total.es)}${NBSP}s`} />
                </div>
              )}
            </KpiTile>
          );
        }}
      />

      <ApiTile
        result={client}
        label="Link-Abbrüche im Betrieb"
        icon={Unplug}
        render={(d) => {
          const s = d.linkSummary;
          const status: Health = s.runtimeDrops24h >= 2 ? "crit" : s.runtimeDrops24h === 1 || s.runtimeDrops7d > 0 ? "warn" : "good";
          return (
            <KpiTile label="Link-Abbrüche im Betrieb" icon={Unplug} value={fmtInt(s.runtimeDrops24h)} status={status} caption="Letzte 24 Stunden, ohne Start/Standby">
              <div className="flex flex-col gap-0.5">
                <Line label="Letzte 7 Tage:" value={fmtInt(s.runtimeDrops7d)} />
                <Line label="WLAN-Ausweichen (24 h):" value={fmtInt(s.wlanFailovers24h)} />
                {s.lastDropTs != null && <Line label="Zuletzt:" value={fmtDateTimeShort(s.lastDropTs)} />}
              </div>
            </KpiTile>
          );
        }}
      />

      <ConnectionTile mode={mode} client={client} />

      <ApiTile
        result={router}
        label="DOCSIS"
        icon={AudioWaveform}
        render={(d) => {
          const st = d.status;
          if (st == null) {
            return (
              <KpiTile label="DOCSIS" icon={AudioWaveform} value={DASH} status="unknown" caption="Noch keine Router-Daten">
                <Line>Die Mess-Engine fragt die Vodafone Station alle paar Minuten ab.</Line>
              </KpiTile>
            );
          }
          if (st.docsis == null) {
            const noLogin = !st.loginConfigured || !st.loginEnabled;
            return (
              <KpiTile label="DOCSIS" icon={AudioWaveform} value={DASH} status="unknown" caption={noLogin ? "Router-Login fehlt" : (st.loginError ?? "Noch keine Kanalwerte")}>
                {noLogin ? (
                  <Line>
                    Pegel und SNR brauchen das Router-Passwort.{" "}
                    <Link href="/einstellungen" className="text-fiber underline-offset-4 hover:underline">
                      Router-Zugang einrichten
                    </Link>
                  </Line>
                ) : (
                  <Line label="Status:" value={st.connectionStatus ?? DASH} />
                )}
              </KpiTile>
            );
          }
          const ds = st.docsis.ds.length;
          const us = st.docsis.us.length;
          return (
            <KpiTile
              label="DOCSIS"
              icon={AudioWaveform}
              value={`${fmtInt(ds)}/${fmtInt(us)}`}
              unit="Kanäle"
              status={toUiHealth(st.docsis.rating)}
              caption={`Downstream/Upstream, Stand ${fmtDateTimeShort(st.docsis.ts)}`}
            >
              {st.docsis.notes[0] && <Line>{st.docsis.notes[0]}</Line>}
            </KpiTile>
          );
        }}
      />

      <ApiTile
        result={speedtests}
        label="Bufferbloat-Note"
        icon={Gauge}
        render={(d) => {
          const t = d.items[0];
          if (!t) {
            return (
              <KpiTile label="Bufferbloat-Note" icon={Gauge} value={DASH} status="unknown" caption="Noch kein Speedtest">
                <Line>Geplante Speedtests laufen während des Langzeittests automatisch.</Line>
              </KpiTile>
            );
          }
          if (t.grade == null) {
            return (
              <KpiTile label="Bufferbloat-Note" icon={Gauge} value={DASH} status="unknown" caption={`Speedtest vom ${fmtDateTimeShort(t.ts)}`}>
                <Line>{t.error ?? "Keine Note ermittelt."}</Line>
              </KpiTile>
            );
          }
          return (
            <KpiTile
              label="Bufferbloat-Note"
              icon={Gauge}
              value={t.grade}
              status={toUiHealth(gradeHealth(t.grade))}
              caption={`${gradeLabel(t.grade)}, Speedtest vom ${fmtDateTimeShort(t.ts)}`}
            >
              <div className="flex flex-col gap-0.5">
                <Line label="Download:" value={fmtMbit(t.downMbps)} />
                <Line label="Upload:" value={fmtMbit(t.upMbps)} />
              </div>
            </KpiTile>
          );
        }}
      />

      <ApiTile
        result={diagnosis}
        label="Gaming-Score"
        icon={Gamepad2}
        render={(d) => {
          const g = d.gamingScore;
          if (!g) {
            return (
              <KpiTile label="Gaming-Score" icon={Gamepad2} value={DASH} status="unknown" caption="Noch zu wenige Messwerte">
                <Line>Erscheint nach mindestens 15 Minuten Messung der Internetziele.</Line>
              </KpiTile>
            );
          }
          const limiting = g.limiting ? g.parts.find((p) => p.key === g.limiting) : undefined;
          return (
            <KpiTile label="Gaming-Score" icon={Gamepad2} value={fmtInt(g.score)} unit="von 100" status={GAMING_HEALTH[g.grade]} caption="Letzte 24 Stunden, IPv4-Internetziele">
              <div className="flex flex-col gap-0.5">
                <Line label="Note:" value={g.grade} />
                {limiting && <Line label={`Begrenzt durch ${limiting.label}:`} value={limiting.value} />}
              </div>
            </KpiTile>
          );
        }}
      />

      <ApiTile
        result={diagnosis}
        label="Messabdeckung"
        icon={CalendarClock}
        render={(d) => {
          const pct = d.dataQuality.coveragePct;
          const covered = seconds24.data?.total.covered ?? d.seconds?.covered ?? null;
          const status: Health = pct <= 0 ? "unknown" : pct >= 80 ? "good" : "warn";
          return (
            <KpiTile label="Messabdeckung" icon={CalendarClock} value={fmtPctValue(pct)} unit="%" status={status} caption="Anteil der letzten 24 Stunden mit Messwerten">
              <div className="flex flex-col gap-0.5">
                {covered != null && <Line label="Gemessen:" value={fmtDuration(covered)} />}
                {d.dataQuality.gaps > 0 && <Line label="Lücken (Standby, PC aus):" value={fmtInt(d.dataQuality.gaps)} />}
                {pct < 80 && <Line>Der PC sollte während des Tests nicht in den Standby gehen.</Line>}
              </div>
            </KpiTile>
          );
        }}
      />
    </section>
  );
}
