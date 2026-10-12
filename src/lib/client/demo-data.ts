/**
 * NUR DEMO/VORSCHAU (/dev/ui): deterministische Beispieldaten in den echten API-Formaten
 * (src/lib/shared/api-types.ts, types.ts) – kein Math.random, kein Date.now: Server- und
 * Client-Render liefern identische Werte. Nie in echten Seiten verwenden.
 */
import type { HeatmapResponse, SecondsResponse, SeriesData, SeriesResponse } from "@/lib/shared/api-types";
import type { ClientState, Finding, NetEvent, Sample, SecondsRollup, TestSession } from "@/lib/shared/types";
import type { SegmentTopologyProps } from "@/components/viz/SegmentTopology";

/** "Jetzt" der Demo: 09.10.2026, 18:12 Uhr (Europe/Berlin) */
export const DEMO_NOW = Date.parse("2026-10-09T16:12:00Z");
const MIN = 60_000;
const H = 60 * MIN;
/** Zeitfenster der Demo-Zeitreihe (6 h) */
export const DEMO_FROM = DEMO_NOW - 6 * H;

/** mulberry32 – kleiner deterministischer Zufall */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const round1 = (v: number) => Math.round(v * 10) / 10;

/* -------------------------------------------------------------------------- */
/* GET /api/series – 6 h, 1-min-Buckets                                        */
/* -------------------------------------------------------------------------- */

interface SeriesSpec {
  base: number;
  noise: number;
  spikeProb: number;
  spikeAmp: number;
  /** nur IPv4 durch den AFTR: vom Demo-Ausfall betroffen */
  v4: boolean;
  seed: number;
}

const SERIES_SPECS: Record<string, SeriesSpec> = {
  gw: { base: 0.8, noise: 0.4, spikeProb: 0.01, spikeAmp: 6, v4: true, seed: 11 },
  isp6: { base: 11, noise: 3, spikeProb: 0.06, spikeAmp: 90, v4: false, seed: 12 },
  aftr: { base: 13, noise: 3, spikeProb: 0.05, spikeAmp: 60, v4: false, seed: 13 },
  cf4: { base: 18, noise: 3, spikeProb: 0.05, spikeAmp: 120, v4: true, seed: 14 },
  g4: { base: 19, noise: 3, spikeProb: 0.05, spikeAmp: 110, v4: true, seed: 15 },
  cf6: { base: 17, noise: 3, spikeProb: 0.04, spikeAmp: 100, v4: false, seed: 16 },
};

function demoSeriesData(spec: SeriesSpec, from: number, n: number, stepMs: number): SeriesData {
  const r = rng(spec.seed);
  const d: SeriesData = { ts: [], avg: [], min: [], max: [], p95: [], lossPct: [], sent: [] };
  for (let i = 0; i < n; i++) {
    const ts = from + i * stepMs;
    d.ts.push(ts);
    // Standby 95–110: keine Messung
    if (i >= 95 && i <= 110) {
      d.avg.push(null);
      d.min.push(null);
      d.max.push(null);
      d.p95.push(null);
      d.lossPct.push(null);
      d.sent.push(0);
      continue;
    }
    // Ausfall IPv4 (AFTR) 250–252: alle IPv4-Pings verloren
    if (spec.v4 && spec.seed !== 11 && i >= 250 && i <= 252) {
      d.avg.push(null);
      d.min.push(null);
      d.max.push(null);
      d.p95.push(null);
      d.lossPct.push(100);
      d.sent.push(60);
      continue;
    }
    const evening = i > 240 ? 1.8 : 1; // ab 22:12 Uhr deutlich unruhiger
    const wave = Math.sin(i / 23) * spec.noise * 0.6;
    const avg = Math.max(0.3, spec.base + wave + r() * spec.noise);
    const spike = r() < spec.spikeProb * evening ? spec.spikeAmp * (0.4 + r()) : 0;
    const loss = i === 200 ? 37 : r() < 0.03 * evening ? round1(1.7 * Math.ceil(r() * 2)) : 0;
    d.avg.push(round1(avg + spike / 12));
    d.min.push(round1(Math.max(0.2, avg - spec.noise * 0.6)));
    d.max.push(round1(avg + spec.noise + spike));
    d.p95.push(round1(avg + spec.noise * 0.8 + spike * 0.6));
    d.lossPct.push(loss);
    d.sent.push(60);
  }
  return d;
}

export function demoSeries(ids: readonly string[] = ["gw", "isp6", "aftr", "cf4", "g4"]): SeriesResponse {
  const stepMs = MIN;
  const n = 361;
  const series: Record<string, SeriesData> = {};
  for (const id of ids) {
    const spec = SERIES_SPECS[id];
    if (spec) series[id] = demoSeriesData(spec, DEMO_FROM, n, stepMs);
  }
  return { from: DEMO_FROM, to: DEMO_NOW, stepMs, source: "rollup", series };
}

/* -------------------------------------------------------------------------- */
/* GET /api/seconds – 24 h, 15-min-Buckets                                     */
/* -------------------------------------------------------------------------- */

const FAULT_KEYS = ["link", "lan", "access", "aftr", "backbone", "remote", "unknown"] as const;

export function demoSeconds(): SecondsResponse {
  const stepMs = 15 * MIN;
  const to = DEMO_NOW;
  const from = to - 24 * H;
  const r = rng(77);
  const buckets: SecondsRollup[] = [];
  for (let i = 0; i < 96; i++) {
    const ts = from + i * stepMs;
    const hour = Number(new Intl.DateTimeFormat("de-DE", { hour: "numeric", hourCycle: "h23", timeZone: "Europe/Berlin" }).format(ts));
    const off = hour >= 2 && hour < 7; // PC aus
    if (off) {
      buckets.push({ ts, covered: 0, good: 0, link: 0, lan: 0, access: 0, aftr: 0, backbone: 0, remote: 0, unknown: 0, es: 0, ses: 0, selfLoad: 0 });
      continue;
    }
    const evening = hour >= 19 && hour <= 23;
    const b: SecondsRollup = {
      ts,
      covered: 900,
      good: 0,
      link: i === 30 || i === 88 ? Math.round(40 + r() * 40) : 0,
      lan: r() < 0.2 ? Math.round(r() * 4) : 0,
      access: Math.round((evening ? 8 + r() * 36 : r() * 3) * (r() < 0.8 ? 1 : 0)),
      aftr: i >= 84 && i <= 85 ? Math.round(60 + r() * 60) : r() < 0.15 ? Math.round(r() * 3) : 0,
      backbone: r() < 0.25 ? Math.round(r() * 4) : 0,
      remote: r() < 0.15 ? Math.round(r() * 3) : 0,
      unknown: r() < 0.3 ? Math.round(r() * 3) : 0,
      es: 0,
      ses: 0,
      selfLoad: r() < 0.1 ? Math.round(r() * 60) : 0,
    };
    const bad = FAULT_KEYS.reduce((s, k) => s + b[k], 0);
    b.good = b.covered - bad;
    b.es = bad;
    b.ses = Math.round(bad * 0.3);
    buckets.push(b);
  }
  const total = buckets.reduce<SecondsRollup>(
    (acc, b) => {
      for (const k of ["covered", "good", ...FAULT_KEYS, "es", "ses", "selfLoad"] as const) acc[k] += b[k];
      return acc;
    },
    { ts: from, covered: 0, good: 0, link: 0, lan: 0, access: 0, aftr: 0, backbone: 0, remote: 0, unknown: 0, es: 0, ses: 0, selfLoad: 0 },
  );
  return { from, to, stepMs, buckets, total };
}

/* -------------------------------------------------------------------------- */
/* GET /api/heatmap – 14 Tage × 24 h, Paketverlust                             */
/* -------------------------------------------------------------------------- */

export function demoHeatmap(): HeatmapResponse {
  const r = rng(99);
  const days: string[] = [];
  const values: (number | null)[][] = [];
  for (let d = 13; d >= 0; d--) {
    const day = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: "Europe/Berlin" }).format(DEMO_NOW - d * 24 * H);
    days.push(day);
    const row: (number | null)[] = [];
    for (let h = 0; h < 24; h++) {
      if (h >= 2 && h < 7 && r() < 0.85) row.push(null); // PC nachts aus
      else if (d === 0 && h > 18) row.push(null); // Zukunft
      else if (h >= 19 && h <= 23) row.push(round1(0.3 + r() * (d % 3 === 0 ? 5 : 2.5)));
      else row.push(r() < 0.6 ? 0 : round1(r() * 0.6));
    }
    values.push(row);
  }
  return { targetId: "cf4", metric: "loss", days, values };
}

/* -------------------------------------------------------------------------- */
/* Ereignisse                                                                  */
/* -------------------------------------------------------------------------- */

export function demoEvents(): NetEvent[] {
  const at = (min: number, sec = 0) => DEMO_FROM + min * MIN + sec * 1000;
  const list: NetEvent[] = [
    {
      id: 101,
      ts: at(55),
      endTs: at(56),
      type: "speedtest",
      severity: "info",
      title: "Speedtest: 482 / 47,6 Mbit/s, Bufferbloat B",
      source: "speedtest",
      details: { downMbps: 482, upMbps: 47.6, grade: "B" },
    },
    { id: 102, ts: at(95), type: "standby", severity: "info", segment: "client", title: "PC im Standby", source: "eventlog", details: { provider: "Kernel-Power", eventId: 42 } },
    { id: 103, ts: at(95, 4), endTs: at(111), type: "engine_gap", severity: "info", title: "Messlücke (PC im Standby)", source: "engine" },
    { id: 104, ts: at(111), type: "resume", severity: "info", segment: "client", title: "PC aufgewacht", source: "eventlog", details: { provider: "Kernel-Power", eventId: 107 } },
    {
      id: 105,
      ts: at(200, 5),
      endTs: at(200, 27),
      type: "nic_link_down",
      severity: "critical",
      segment: "client",
      title: "Ethernet-Verbindung getrennt",
      source: "eventlog",
      details: { cause: "runtime", relinkMbps: 100, wlanFailover: true, provider: "e2fexpress", eventId: 27, downtimeMs: 22_000 },
    },
    {
      id: 106,
      ts: at(200, 6),
      type: "route_switch",
      severity: "warn",
      segment: "client",
      title: "Internetverkehr läuft über WLAN",
      source: "route",
      details: { from: "Ethernet", to: "WLAN" },
    },
    {
      id: 107,
      ts: at(200, 27),
      type: "nic_link_up",
      severity: "warn",
      segment: "client",
      title: "Ethernet wieder verbunden",
      source: "eventlog",
      details: { speedMbps: 100, provider: "e2fexpress", eventId: 33 },
    },
    {
      id: 108,
      ts: at(250),
      endTs: at(253),
      type: "outage",
      severity: "critical",
      segment: "aftr",
      title: "Ausfall: IPv4-Internet nicht erreichbar",
      source: "icmp",
      details: { classification: "aftr", durationMs: 180_000 },
    },
    { id: 109, ts: at(262), type: "note", severity: "info", title: "Lag bemerkt", source: "user", details: { kind: "lag" } },
    { id: 110, ts: at(300), type: "route_change", severity: "info", segment: "isp", title: "Route zu 1.1.1.1 geändert", source: "traceroute" },
    {
      id: 111,
      ts: at(330),
      endTs: at(331, 20),
      type: "latency_spike",
      severity: "warn",
      segment: "docsis",
      title: "Ping-Spitzen bis 214 ms (Kopfstation)",
      source: "icmp",
    },
    { id: 112, ts: at(340), type: "router_log", severity: "warn", segment: "docsis", title: "T3-Timeout im Router-Protokoll", source: "router" },
    { id: 113, ts: at(345), type: "loss_burst", severity: "warn", segment: "docsis", title: "Verlust-Häufung: 3 von 10 Pings (Kopfstation)", source: "icmp" },
    {
      id: 114,
      ts: DEMO_NOW - 23 * H - 43 * MIN,
      endTs: DEMO_NOW - 23 * H - 39 * MIN,
      type: "router_offline",
      severity: "critical",
      segment: "router",
      title: "Vodafone Station nicht erreichbar",
      source: "router",
    },
    {
      id: 115,
      ts: DEMO_NOW - 23 * H - 39 * MIN,
      type: "router_reboot",
      severity: "warn",
      segment: "router",
      title: "Router-Neustart erkannt (Laufzeit zurückgesetzt)",
      source: "router",
    },
    {
      id: 116,
      ts: DEMO_NOW - 15 * H,
      endTs: DEMO_NOW - 15 * H + 14_000,
      type: "nic_link_down",
      severity: "critical",
      segment: "client",
      title: "Ethernet-Verbindung getrennt",
      source: "eventlog",
      details: { cause: "runtime", relinkMbps: 1000, provider: "e2fexpress", eventId: 27, downtimeMs: 14_000 },
    },
  ];
  return list.sort((a, b) => b.ts - a.ts);
}

/* -------------------------------------------------------------------------- */
/* Befunde (Diagnose)                                                          */
/* -------------------------------------------------------------------------- */

export function demoFindings(): Finding[] {
  return [
    {
      id: "nic-link-flaps",
      severity: "critical",
      confidence: "high",
      segment: "client",
      title: "Ethernet-Link bricht wiederholt ab",
      summary: "Der Netzwerkadapter verliert im laufenden Betrieb die Verbindung zum Router. Jeder Abbruch erzeugt einen Komplettausfall von 3–22 s.",
      evidence: [
        { label: "Echte Abbrüche (7 Tage)", value: "19" },
        { label: "Dauer je Abbruch", value: "3–22 s" },
        { label: "Wiederaufbau mit 100 Mbit/s", value: "8 von 19" },
      ],
      recommendations: ["Kabel direkt zwischen PC und Vodafone Station tauschen (Cat 6, ohne Dose).", "Danach einen anderen LAN-Port testen."],
      score: 92,
    },
    {
      id: "access-spikes",
      severity: "warn",
      confidence: "medium",
      segment: "docsis",
      title: "Ping-Spitzen entstehen im Kabelnetz",
      summary: "74 % der Spitzen zu Internet-Zielen treten gleichzeitig an der Kopfstation auf, während der Router-Ping ruhig bleibt.",
      evidence: [
        { label: "Gleichzeitige Spitzen (±1 s)", value: "74 %" },
        { label: "Router p99", value: "3 ms" },
      ],
      recommendations: ["Bericht exportieren und eine Störung bei Vodafone melden."],
      score: 61,
    },
    {
      id: "wlan-failover",
      severity: "info",
      confidence: "high",
      segment: "client",
      title: "Windows weicht bei Abbrüchen aufs WLAN aus",
      summary: "Bei 15 von 19 Abbrüchen lief der Verkehr kurz über das WLAN – Spielverbindungen brechen trotzdem ab.",
      evidence: [{ label: "Abbrüche mit WLAN-Ausweichen", value: "15 von 19" }],
      recommendations: ["Automatisches Verbinden mit „Vodafone-43FE“ während des Tests deaktivieren."],
      score: 35,
    },
  ];
}

/* -------------------------------------------------------------------------- */
/* Topologie-Varianten, Sitzung, Client-Zustand                                */
/* -------------------------------------------------------------------------- */

export type DemoTopology = Pick<SegmentTopologyProps, "nodes" | "links">;

/** Normalbetrieb mit Auffälligkeiten (Kabelnetz unruhig, 100 Mbit/s) */
export const DEMO_TOPOLOGY: DemoTopology = {
  nodes: {
    pc: { health: "warn", sublabel: "Ethernet, 100 Mbit/s", detail: "Eigenlast 2,1 Mbit/s" },
    router: { health: "good", sublabel: "Vodafone Station", detail: "DOCSIS Online" },
    cmts: { health: "warn", sublabel: "CMTS, 1. IPv6-Hop", detail: "DOCSIS: Auffällig" },
    aftr: { health: "good", sublabel: "DS-Lite, nur IPv4", detail: "IPv4 wie IPv6" },
    targets: { health: "good", sublabel: "Cloudflare, Google", detail: "19 ms Median" },
  },
  links: {
    lan: { health: "good", rttMs: 0.9, lossPct: 0 },
    docsis: { health: "warn", rttMs: 24, lossPct: 0.8 },
    backbone: { health: "good", rttMs: 14, lossPct: 0 },
    internet: { health: "good", rttMs: 19, lossPct: 0.1 },
  },
};

/** Ethernet getrennt, Windows nutzt WLAN */
export const DEMO_TOPOLOGY_WLAN: DemoTopology = {
  nodes: { ...DEMO_TOPOLOGY.nodes, pc: { health: "crit", sublabel: "über WLAN", detail: "Ethernet getrennt" } },
  links: { ...DEMO_TOPOLOGY.links, lan: { health: "crit", rttMs: 4.2, lossPct: 1.7, wlanFallback: true } },
};

/** Kabel gezogen, kein Ausweichen */
export const DEMO_TOPOLOGY_DOWN: DemoTopology = {
  nodes: {
    ...DEMO_TOPOLOGY.nodes,
    pc: { health: "crit", sublabel: "Ethernet: getrennt" },
    targets: { health: "unknown", sublabel: "Cloudflare, Google", detail: "keine Antwort" },
  },
  links: {
    lan: { health: "crit", rttMs: null, lossPct: 100, linkDown: true },
    docsis: { health: "unknown" },
    backbone: { health: "unknown" },
    internet: { health: "unknown" },
  },
};

export function demoSession(now: number): TestSession {
  const startedAt = now - (3 * 24 * H + 4 * H + 12 * MIN + 55_000);
  return { id: 7, startedAt, endedAt: null, plannedEndAt: startedAt + 5 * 24 * H, label: "Neues LAN-Kabel", status: "running", note: null };
}

export const DEMO_CLIENT: ClientState = {
  ts: DEMO_NOW,
  expectedIf: "Ethernet",
  egressV4If: "Ethernet",
  egressV6If: "Ethernet",
  egressV4Address: "192.168.0.23",
  egressV6Address: null,
  onExpected: true,
  linkUp: true,
  linkMbps: 1000,
  rxMbps: 1.8,
  txMbps: 0.3,
  gaming: false,
  preventSleep: true,
};

/** 15 min Live-Samples (1 Hz) für die Live-Diagramm-Vorschau. */
export function demoLiveSamples(now: number, ids: readonly string[] = ["gw", "isp6", "cf4"]): Record<string, Sample[]> {
  const out: Record<string, Sample[]> = {};
  const end = Math.floor(now / 1000) * 1000;
  ids.forEach((id, k) => {
    const spec = SERIES_SPECS[id] ?? SERIES_SPECS.cf4;
    const r = rng(500 + k);
    const list: Sample[] = [];
    for (let i = 900; i >= 0; i--) {
      const ts = end - i * 1000;
      const lost = r() < 0.006 || (id !== "gw" && i > 120 && i < 126);
      const spike = r() < spec.spikeProb / 2 ? spec.spikeAmp * r() : 0;
      list.push({ ts, targetId: id, rtt: lost ? null : round1(spec.base + r() * spec.noise + spike), status: lost ? 1 : 0 });
    }
    out[id] = list;
  });
  return out;
}
