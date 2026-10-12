/**
 * Live-Zustand je Abschnitt des Leitungswegs – abgeleitet aus den Ringpuffern des Live-Streams
 * (letzte 60 s: Median-RTT + Verlust je Ziel), bewertet mit den Schwellen aus der
 * Konfiguration (/api/status -> config.thresholds, rateBand aus src/lib/shared/config.ts).
 *
 *   const topo = useLiveTopology();            // { nodes, links, overall, hasData, stats }
 *   <SegmentTopology nodes={topo.nodes} links={topo.links} />   // fertig: <LiveTopology/>
 *   const health = useOverallHealth();         // "Gesamtzustand" (Statusleiste)
 *
 * Zuordnung (Ziel-Segmente aus der Konfiguration, Standardziele in Klammern):
 *   LAN-Kabel        PC -> Router           lan-Ziele (gw, gw6)   + Link-Status/WLAN-Ausweichen
 *   Kabelnetz        Router -> Kopfstation  docsis-Ziele (isp6)
 *   Vodafone-Netz    Kopfstation -> AFTR    aftr-Ziele (aftr)
 *   Internet         AFTR -> Ziele          internet-ICMP-Ziele (cf4, cf6, g4, g6)
 * RTT = Median bis zum Abschnittsende (kumuliert wie bei traceroute), Verlust = Zuwachs
 * gegenüber dem vorherigen Abschnitt (der Abschnitt, in dem der Verlust entsteht).
 */
import { useMemo } from "react";
import { DEFAULT_CONFIG, rateBand, type AppConfig, type Band } from "@/lib/shared/config";
import type { ClientState, EngineStatus, RouterStatus, Sample, Segment, TargetConfig } from "@/lib/shared/types";
import type { TopologyLinkId, TopologyLinkState, TopologyNodeId, TopologyNodeState } from "@/components/viz/SegmentTopology";
import { fmtLinkSpeed, fmtMbitValue, fmtMs, NBSP } from "@/lib/format";
import { HEALTH_LABEL, toUiHealth, worstHealth, worstKnownHealth, type Health } from "@/lib/health";
import { useNow } from "@/lib/use-now";
import { liveStats, type LiveStats } from "./charts";
import { useLive, type LiveState } from "./live-store";
import { useTargets } from "./targets";

/** Fenster für den Live-Zustand */
export const HEALTH_WINDOW_MS = 60_000;
/** ohne neues Sample so lange -> Daten gelten als veraltet ("keine Daten") */
const STALE_MS = 15_000;

/* -------------------------------------------------------------------------- */
/* Bewertung                                                                   */
/* -------------------------------------------------------------------------- */

/** Wert gegen ein Konfigurationsband bewerten -> Design-Health (gut/auffällig/kritisch/unbekannt). */
export function rateUi(value: number | null | undefined, band: Band): Health {
  return toUiHealth(rateBand(value, band));
}

/**
 * Verlust bewerten (thresholds.loss). Ein einzelner verlorener Ping im Fenster ist höchstens
 * "auffällig" – sonst würde ein Abschnitt bei 60 Pings schon mit 1,7 % "kritisch" flackern.
 */
export function rateLoss(lossPct: number | null, lostCount: number, band: Band): Health {
  if (lossPct == null) return "unknown";
  const h = rateUi(lossPct, band);
  return h === "crit" && lostCount <= 1 ? "warn" : h;
}

/* -------------------------------------------------------------------------- */
/* Ableitung (reine Funktion – testbar, auch für Vorschau/Demo)                */
/* -------------------------------------------------------------------------- */

export interface LiveTopologyInput {
  samples: Readonly<Record<string, readonly Sample[]>>;
  targets: readonly TargetConfig[];
  thresholds: AppConfig["thresholds"];
  client: ClientState | null;
  status: EngineStatus | null;
  router: RouterStatus | null;
  /** Engine erreichbar */
  online: boolean;
  now: number;
  windowMs?: number;
}

export interface LiveTopology {
  nodes: Record<TopologyNodeId, TopologyNodeState>;
  links: Record<TopologyLinkId, TopologyLinkState>;
  /** schlechtester bekannter Zustand aller Knoten und Abschnitte ("Gesamtzustand") */
  overall: Health;
  /** es gibt aktuelle Live-Messwerte (läuft nur während eines Langzeittests) */
  hasData: boolean;
  /** Kennzahlen je Ziel im Fenster (für Kacheln/Tooltips) */
  stats: Readonly<Record<string, LiveStats>>;
}

const UNKNOWN_LINK: TopologyLinkState = { health: "unknown", rttMs: null, lossPct: null };

function emptyTopology(detail?: string): LiveTopology {
  const node = (sublabel: string): TopologyNodeState => ({ health: "unknown", sublabel, detail });
  return {
    nodes: {
      pc: node("Netzwerkadapter"),
      router: node("Vodafone Station"),
      cmts: node("CMTS, 1. IPv6-Hop"),
      aftr: node("DS-Lite, nur IPv4"),
      targets: node("Cloudflare, Google"),
    },
    links: { lan: UNKNOWN_LINK, docsis: UNKNOWN_LINK, backbone: UNKNOWN_LINK, internet: UNKNOWN_LINK },
    overall: "unknown",
    hasData: false,
    stats: {},
  };
}

/** Topologie ohne Daten (Server-Render, Engine nicht erreichbar). */
export const EMPTY_TOPOLOGY: LiveTopology = emptyTopology();

/** Samples mehrerer Ziele zu einem Puffer zusammenführen (aufsteigend). */
function pooled(samples: LiveTopologyInput["samples"], ids: readonly string[]): Sample[] {
  const out: Sample[] = [];
  for (const id of ids) for (const s of samples[id] ?? []) out.push(s);
  return out.sort((a, b) => a.ts - b.ts);
}

const icmpIds = (targets: readonly TargetConfig[], segment: Segment, family?: 4 | 6): string[] =>
  targets.filter((t) => t.enabled && t.kind === "icmp" && t.segment === segment && (family == null || t.family === family)).map((t) => t.id);

const hasSamples = (s: LiveStats | undefined): s is LiveStats => s != null && s.sent > 0;
const lossDelta = (end: LiveStats, prev: LiveStats | undefined): number | null =>
  end.lossPct == null ? null : Math.max(0, end.lossPct - (hasSamples(prev) && prev.lossPct != null ? prev.lossPct : 0));
const lostDelta = (end: LiveStats, prev: LiveStats | undefined): number => Math.max(0, end.lost - (hasSamples(prev) ? prev.lost : 0));

export function deriveLiveTopology(input: LiveTopologyInput): LiveTopology {
  const { samples, targets, thresholds: th, client, status, router, online, now } = input;
  // Hinweis steht in der Bildunterschrift (<LiveTopology/>) – Knotentexte bleiben kurz
  if (!online) return EMPTY_TOPOLOGY;
  const windowMs = input.windowMs ?? HEALTH_WINDOW_MS;
  const statsOf = (ids: readonly string[]): LiveStats | undefined => {
    if (ids.length === 0) return undefined;
    const buf = ids.length === 1 ? samples[ids[0]] : pooled(samples, ids);
    const st = liveStats(buf, now, windowMs);
    return st.lastTs != null && now - st.lastTs > STALE_MS ? { ...st, sent: 0 } : st;
  };

  // Zielgruppen
  const lanIds = icmpIds(targets, "lan");
  const gwId = lanIds.includes("gw") ? ["gw"] : lanIds.slice(0, 1);
  const docsisIds = icmpIds(targets, "docsis");
  const aftrIds = icmpIds(targets, "aftr");
  const internetIds = icmpIds(targets, "internet");
  const routerIds = targets.filter((t) => t.enabled && t.segment === "router").map((t) => t.id);

  const stats: Record<string, LiveStats> = {};
  for (const t of targets) if (t.enabled && samples[t.id]?.length) stats[t.id] = liveStats(samples[t.id], now, windowMs);

  const gw = statsOf(gwId);
  const cmts = statsOf(docsisIds);
  const aftr = statsOf(aftrIds);
  const internet = statsOf(internetIds);
  const v4 = statsOf(icmpIds(targets, "internet", 4));
  const v6 = statsOf(icmpIds(targets, "internet", 6));
  const routerStats = statsOf(routerIds);
  const hasData = [gw, cmts, aftr, internet].some(hasSamples);

  const linkOf = (end: LiveStats | undefined, prev: LiveStats | undefined, band: Band): TopologyLinkState => {
    if (!hasSamples(end)) return UNKNOWN_LINK;
    const inc = lossDelta(end, prev);
    const health = worstKnownHealth(rateUi(end.p50, band), rateLoss(inc, lostDelta(end, prev), th.loss));
    return { health, rttMs: end.p50, lossPct: inc };
  };

  /* ---- Abschnitte ---- */
  const linkDown = client?.linkUp === false;
  const wlanFallback = client?.onExpected === false;
  const lanBase = linkOf(gw, undefined, th.latency.lan);
  const lan: TopologyLinkState = {
    ...lanBase,
    // erwartete Verbindung weg oder Verkehr über eine andere Schnittstelle = kritisch (MESSPLAN 3.1)
    health: linkDown || wlanFallback ? "crit" : lanBase.health,
    linkDown,
    wlanFallback,
  };
  const docsis = linkOf(cmts, gw, th.latency.docsis);
  const backbone = linkOf(aftr, hasSamples(cmts) ? cmts : gw, th.latency.aftr);
  const internetLink = linkOf(internet, [aftr, cmts, gw].find(hasSamples), th.latency.internet);

  /* ---- Knoten ---- */
  // PC & Adapter
  let pc: TopologyNodeState;
  if (!client) pc = { health: "unknown", sublabel: "Netzwerkadapter", detail: "keine Daten" };
  else {
    const ifName = client.expectedIf ?? client.egressV4If ?? "Netzwerk";
    const health: Health = linkDown || wlanFallback ? "crit" : client.linkMbps != null && client.linkMbps < 1000 ? "warn" : client.linkUp == null ? "unknown" : "good";
    const sublabel = linkDown
      ? `${ifName}: getrennt`
      : wlanFallback
        ? `über ${client.egressV4If ?? "andere Schnittstelle"}`
        : client.linkMbps != null
          ? `${ifName}, ${fmtLinkSpeed(client.linkMbps)}`
          : ifName;
    // Zeile 3 nur, wenn sie etwas erklärt (max. ca. 20 Zeichen): laufendes Spiel oder spürbare Eigenlast
    const own = (client.rxMbps ?? 0) + (client.txMbps ?? 0);
    const detail = client.gaming ? "Spiel läuft" : own >= 1 ? `Eigenlast ${fmtMbitValue(own)}${NBSP}Mbit/s` : undefined;
    pc = { health, sublabel, detail };
  }

  // Router (Gerät): erreichbar? Weboberfläche/DNS schnell? Modem online?
  const routerParts: Health[] = [];
  if (router?.reachable === false) routerParts.push("crit");
  else if (router?.reachable === true || (hasSamples(gw) && (gw.lossPct ?? 100) < 100)) routerParts.push("good");
  if (hasSamples(gw) && gw.lossPct === 100) routerParts.push("crit");
  if (hasSamples(routerStats)) routerParts.push(rateUi(routerStats.p50, th.latency.router));
  if (router?.connectionStatus && !/online/i.test(router.connectionStatus)) routerParts.push("warn");
  const routerNode: TopologyNodeState = {
    health: routerParts.length ? worstKnownHealth(...routerParts) : "unknown",
    sublabel: "Vodafone Station",
    detail: router?.connectionStatus ?? (hasSamples(routerStats) ? `Web ${fmtMs(routerStats.p50)}` : undefined),
  };

  // Kopfstation: DOCSIS-Werte (Router-Login) + Erreichbarkeit des 1. IPv6-Hops
  const docsisRating = router?.docsis ? toUiHealth(router.docsis.rating) : "unknown";
  const cmtsParts: Health[] = [docsisRating];
  if (hasSamples(cmts)) cmtsParts.push(cmts.lossPct === 100 ? "crit" : "good");
  const cmtsResolved = status?.dynamicHosts?.isp6 != null || hasSamples(cmts);
  const cmtsNode: TopologyNodeState = {
    health: worstKnownHealth(...cmtsParts),
    sublabel: "CMTS, 1. IPv6-Hop",
    detail: router?.docsis ? `DOCSIS: ${HEALTH_LABEL[docsisRating]}` : cmtsResolved ? undefined : "noch nicht ermittelt",
  };

  // AFTR (DS-Lite): IPv4 (durch den AFTR) im Vergleich zu IPv6 (ohne AFTR)
  let aftrHealth: Health = "unknown";
  let aftrDetail: string | undefined = status?.dynamicHosts?.aftr ? undefined : "noch nicht ermittelt";
  if (hasSamples(v4) && hasSamples(v6)) {
    const lossDiff = (v4.lossPct ?? 0) - (v6.lossPct ?? 0);
    const latDiff = v4.p50 != null && v6.p50 != null ? v4.p50 - v6.p50 : 0;
    aftrHealth = lossDiff >= 2 || latDiff >= 30 ? "crit" : lossDiff >= 1 || latDiff >= 15 ? "warn" : "good";
    aftrDetail = aftrHealth === "good" ? "IPv4 wie IPv6" : `IPv4 ${latDiff >= 15 ? `+${fmtMs(latDiff)}` : "mit mehr Verlust"}`;
  }
  if (hasSamples(aftr) && aftr.lossPct === 100) aftrHealth = "crit";
  const aftrNode: TopologyNodeState = { health: aftrHealth, sublabel: "DS-Lite, nur IPv4", detail: aftrDetail };

  // Ziele: Ende-zu-Ende-Qualität (absoluter Verlust, Median)
  const targetsNode: TopologyNodeState = hasSamples(internet)
    ? {
        health: worstKnownHealth(rateUi(internet.p50, th.latency.internet), rateLoss(internet.lossPct, internet.lost, th.loss)),
        sublabel: "Cloudflare, Google",
        detail: `${fmtMs(internet.p50)} Median`,
      }
    : { health: "unknown", sublabel: "Cloudflare, Google", detail: hasData ? undefined : "keine Daten" };

  const nodes = { pc, router: routerNode, cmts: cmtsNode, aftr: aftrNode, targets: targetsNode };
  const links = { lan, docsis, backbone, internet: internetLink };
  const all = [...Object.values(nodes).map((n) => n.health), ...Object.values(links).map((l) => l.health)];
  // Ohne Ping-Daten (kein Langzeittest) nie "Gut" melden – nur echte Auffälligkeiten (z. B. Link weg)
  const overall = hasData ? worstKnownHealth(...all) : all.some((h) => h === "warn" || h === "crit") ? worstHealth(...all) : "unknown";
  return { nodes, links, overall, hasData, stats };
}

/* -------------------------------------------------------------------------- */
/* Hooks                                                                       */
/* -------------------------------------------------------------------------- */

interface TopologySource {
  samples: LiveState["samples"];
  client: ClientState | null;
  status: EngineStatus | null;
  router: RouterStatus | null;
  online: boolean;
}

const selectTopologySource = (s: LiveState): TopologySource => ({
  samples: s.samples,
  client: s.client,
  status: s.status,
  router: s.router,
  online: s.conn.online,
});

const sameSource = (a: TopologySource, b: TopologySource): boolean =>
  a.samples === b.samples && a.client === b.client && a.status === b.status && a.router === b.router && a.online === b.online;

/**
 * Live-Topologie (≤ 1 Neuberechnung/s). Schwellen aus /api/status (Fallback: Standardwerte).
 * Ohne laufenden Langzeittest gibt es keine Ping-Daten -> Abschnitte "keine Daten".
 */
export function useLiveTopology(windowMs = HEALTH_WINDOW_MS): LiveTopology {
  const src = useLive(selectTopologySource, { rate: "slow", isEqual: sameSource });
  const { targets, config } = useTargets();
  const thresholds = config?.thresholds ?? DEFAULT_CONFIG.thresholds;
  const now = useNow(1000);
  return useMemo(() => {
    if (now == null) return EMPTY_TOPOLOGY;
    return deriveLiveTopology({ ...src, targets, thresholds, now, windowMs });
  }, [src, targets, thresholds, now, windowMs]);
}

/** "Gesamtzustand" = schlechtester bekannter Live-Zustand (unbekannt ohne Daten/Engine). */
export function useOverallHealth(): Health {
  return useLiveTopology().overall;
}
