import type { CSSProperties, ReactNode } from "react";
import { Monitor, RadioTower, Router, Server, Target, Unplug, Wifi, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";
import { fmtMs, fmtPct } from "@/lib/format";
import { HEALTH_COLOR, HEALTH_ICON, HEALTH_LABEL, type Health } from "@/lib/health";

/**
 * Knoten und Abschnitte des echten Leitungswegs (DS-Lite-Kabelanschluss):
 *   PC & Adapter ─LAN-Kabel─ Router ∿Kabelnetz (DOCSIS)∿ Kopfstation (CMTS) ─Vodafone-Netz─ AFTR (DS-Lite, nur IPv4) ─Internet─ Ziele
 */
export type TopologyNodeId = "pc" | "router" | "cmts" | "aftr" | "targets";
export type TopologyLinkId = "lan" | "docsis" | "backbone" | "internet";
type CSSVars = CSSProperties & Record<`--${string}`, string>;

export interface TopologyNodeState {
  health: Health;
  /** Zeile 2, kurz halten (max. ca. 22 Zeichen), z. B. "Ethernet, 1 Gbit/s" */
  sublabel?: string;
  /** Zeile 3 (Mono), z. B. "1 Abbruch heute" */
  detail?: string;
}

export interface TopologyLinkState {
  health: Health;
  /** RTT vom PC bis zum Ende dieses Abschnitts (Median, kumuliert wie bei traceroute) */
  rttMs?: number | null;
  /** Paketverlust, der DIESEM Abschnitt zugeordnet ist (Zuwachs ggü. dem vorherigen) */
  lossPct?: number | null;
  /** nur LAN: erwartete Kabelverbindung ist getrennt ("Link getrennt") */
  linkDown?: boolean;
  /** nur LAN: Verkehr läuft über eine andere Schnittstelle (Windows weicht aufs WLAN aus) */
  wlanFallback?: boolean;
}

export interface SegmentTopologyProps {
  nodes: Record<TopologyNodeId, TopologyNodeState>;
  links: Record<TopologyLinkId, TopologyLinkState>;
  /** DS-Lite-Tunnel (IPv4 in IPv6) zwischen Router und AFTR einzeichnen */
  showTunnel?: boolean;
  /** Eindeutiger Präfix für SVG-IDs, falls mehrere Diagramme auf einer Seite stehen */
  id?: string;
  /** Zusatz unter der Legende; Standard erklärt RTT/Verlust */
  caption?: ReactNode;
  className?: string;
}

export const TOPOLOGY_NODE_ORDER: readonly TopologyNodeId[] = ["pc", "router", "cmts", "aftr", "targets"];
export const TOPOLOGY_LINK_ORDER: readonly TopologyLinkId[] = ["lan", "docsis", "backbone", "internet"];
export const TOPOLOGY_NODE_LABEL: Record<TopologyNodeId, string> = {
  pc: "PC & Adapter",
  router: "Router",
  cmts: "Kopfstation",
  aftr: "DS-Lite-Gateway",
  targets: "Ziele",
};
export const TOPOLOGY_LINK_LABEL: Record<TopologyLinkId, string> = {
  lan: "LAN-Kabel",
  docsis: "Kabelnetz (DOCSIS)",
  backbone: "Vodafone-Netz",
  internet: "Internet",
};
const NODE_ICON: Record<TopologyNodeId, LucideIcon> = { pc: Monitor, router: Router, cmts: RadioTower, aftr: Server, targets: Target };
const TRAVEL_S = 2.8; // muss zu --travel in theme.css passen

type Orientation = "h" | "v";
interface LinkGeo {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}
interface Geometry {
  w: number;
  h: number;
  tile: number;
  r: number;
  nodes: Array<{ x: number; y: number }>;
  links: LinkGeo[];
}

/* Horizontal ab Containerbreite 48rem, darunter vertikal. Schriftgrößen in viewBox-Einheiten so
   gewählt, dass sie im Zielbereich (768–1120 px bzw. 320–420 px) mindestens ca. 11 px bleiben. */
function geometry(o: Orientation): Geometry {
  if (o === "h") {
    // Randknoten etwas eingerückt: Texte unter PC/Ziele (bis ca. 20 Zeichen Mono) bleiben im Panel
    const xs = [62, 236, 410, 584, 758];
    const y = 104;
    const gap = 36; // halbe Kachel + Luft
    return {
      w: 820,
      h: 200,
      tile: 56,
      r: 16,
      nodes: xs.map((x) => ({ x, y })),
      links: [0, 1, 2, 3].map((i) => ({ x1: xs[i] + gap, y1: y, x2: xs[i + 1] - gap, y2: y })),
    };
  }
  const ys = [40, 180, 320, 460, 600];
  const x = 44;
  const gap = 34;
  return {
    w: 360,
    h: 640,
    tile: 52,
    r: 15,
    nodes: ys.map((y) => ({ x, y })),
    links: [0, 1, 2, 3].map((i) => ({ x1: x, y1: ys[i] + gap, x2: x, y2: ys[i + 1] - gap })),
  };
}

/** Koax (DOCSIS) = Welle, Ethernet/Backbone = gerade. Pakete folgen exakt diesem Pfad. */
function linkPath(id: TopologyLinkId, l: LinkGeo): string {
  if (id !== "docsis") return `M${l.x1} ${l.y1}L${l.x2} ${l.y2}`;
  const horizontal = l.y1 === l.y2;
  const len = horizontal ? l.x2 - l.x1 : l.y2 - l.y1;
  const n = Math.max(2, Math.round(len / 12));
  const s = +(len / n).toFixed(2);
  const a = 6;
  let d = `M${l.x1} ${l.y1}`;
  d += horizontal ? `q${s / 2} ${-a} ${s} 0` : `q${-a} ${s / 2} 0 ${s}`;
  for (let i = 1; i < n; i++) d += horizontal ? `t${s} 0` : `t0 ${s}`;
  return d;
}

/** WLAN-Ausweichweg: Bogen über (horizontal) bzw. links neben (vertikal) dem Kabel. */
function wlanPath(l: LinkGeo, o: Orientation): string {
  if (o === "h") {
    const mx = (l.x1 + l.x2) / 2;
    return `M${l.x1} ${l.y1}Q${mx} ${l.y1 - 100} ${l.x2} ${l.y2}`;
  }
  const my = (l.y1 + l.y2) / 2;
  return `M${l.x1} ${l.y1}Q${l.x1 - 64} ${my} ${l.x2} ${l.y2}`;
}

/** Getrenntes Kabel: zwei Stücke mit Lücke in der Mitte. */
function brokenPath(l: LinkGeo, gapHalf = 11): string {
  if (l.y1 === l.y2) {
    const mx = (l.x1 + l.x2) / 2;
    return `M${l.x1} ${l.y1}L${mx - gapHalf} ${l.y1}M${mx + gapHalf} ${l.y1}L${l.x2} ${l.y2}`;
  }
  const my = (l.y1 + l.y2) / 2;
  return `M${l.x1} ${l.y1}L${l.x1} ${my - gapHalf}M${l.x1} ${my + gapHalf}L${l.x2} ${l.y2}`;
}

function describe(nodes: SegmentTopologyProps["nodes"], links: SegmentTopologyProps["links"]): string {
  const parts: string[] = [];
  TOPOLOGY_NODE_ORDER.forEach((n, i) => {
    const s = nodes[n];
    parts.push(`${TOPOLOGY_NODE_LABEL[n]}: ${HEALTH_LABEL[s.health]}${s.detail ? ` (${s.detail})` : ""}`);
    const l = TOPOLOGY_LINK_ORDER[i];
    if (l) {
      const st = links[l];
      const extra = [st.linkDown ? "Link getrennt" : null, st.wlanFallback ? "Verkehr läuft über WLAN" : null].filter(Boolean).join(", ");
      parts.push(
        `${TOPOLOGY_LINK_LABEL[l]}: ${HEALTH_LABEL[st.health]}, ${fmtMs(st.rttMs)}, ${fmtPct(st.lossPct)} Verlust${extra ? `, ${extra}` : ""}`,
      );
    }
  });
  return `${parts.join(". ")}.`;
}

function Packets({ d, drop, count = 3 }: { d: string; drop: boolean; count?: number }) {
  return (
    <>
      {Array.from({ length: count }, (_, p) => {
        const style: CSSVars = { offsetPath: `path('${d}')`, "--delay": `${((-p * TRAVEL_S) / count).toFixed(2)}s` };
        return (
          <g key={p} className={cn("np-anim np-packet", drop && p === 1 && "np-packet--drop")} style={style}>
            <circle r={6.5} fill="currentColor" fillOpacity={0.22} />
            <circle r={2.6} style={{ fill: "color-mix(in oklab, currentColor 45%, var(--np-fg))" }} />
          </g>
        );
      })}
    </>
  );
}

interface DiagramProps {
  o: Orientation;
  uid: string;
  desc: string;
  nodes: SegmentTopologyProps["nodes"];
  links: SegmentTopologyProps["links"];
  showTunnel: boolean;
}

function Diagram({ o, uid, desc, nodes, links, showTunnel }: DiagramProps) {
  const g = geometry(o);
  const t = g.tile;
  const titleId = `${uid}-${o}-title`;
  const descId = `${uid}-${o}-desc`;
  const router = g.nodes[1];
  const aftr = g.nodes[3];
  return (
    <svg viewBox={`0 0 ${g.w} ${g.h}`} role="img" aria-labelledby={`${titleId} ${descId}`} className="block h-auto w-full overflow-visible">
      <title id={titleId}>Leitungsweg vom PC zu den Zielen</title>
      <desc id={descId}>{desc}</desc>

      {/* DS-Lite: IPv4 reist in IPv6 verpackt vom Router bis zum AFTR (Vodafone) */}
      {showTunnel &&
        (o === "h" ? (
          <g style={{ color: "var(--np-fg-4)" }}>
            <path d={`M${router.x} 40V30H${aftr.x}V40`} fill="none" stroke="currentColor" strokeWidth={1} strokeDasharray="2 4" />
            <text x={(router.x + aftr.x) / 2} y={22} textAnchor="middle" className="fill-fg-3 text-[12px]">
              DS-Lite-Tunnel (IPv4 in IPv6)
            </text>
          </g>
        ) : (
          <g style={{ color: "var(--np-fg-4)" }}>
            <path d={`M320 ${router.y}H332V${aftr.y}H320`} fill="none" stroke="currentColor" strokeWidth={1} strokeDasharray="2 4" />
            <text
              transform={`translate(346 ${(router.y + aftr.y) / 2}) rotate(90)`}
              textAnchor="middle"
              className="fill-fg-3 text-[12px]"
            >
              DS-Lite-Tunnel (IPv4 in IPv6)
            </text>
          </g>
        ))}

      {/* Links: Glow (breit, transparent) + Kern (2 px) + Pakete */}
      {TOPOLOGY_LINK_ORDER.map((id, i) => {
        const s = links[id];
        const l = g.links[i];
        const d = linkPath(id, l);
        const unknown = s.health === "unknown";
        const down = id === "lan" && s.linkDown === true;
        const wlan = id === "lan" && s.wlanFallback === true;
        const drop = s.health === "crit" || (s.lossPct ?? 0) >= 0.5;
        const mx = (l.x1 + l.x2) / 2;
        const my = (l.y1 + l.y2) / 2;
        const pos =
          o === "h"
            ? { x: mx, yLabel: my - 31, yValue: my + 26, anchor: "middle" as const } // Label über den Kacheln: frei von Statuspunkten
            : { x: 90, yLabel: my - 6, yValue: my + 13, anchor: "start" as const };
        const cableColor = down ? HEALTH_COLOR.crit : wlan ? "var(--np-fg-4)" : HEALTH_COLOR[s.health];
        const wd = wlan ? wlanPath(l, o) : "";
        return (
          <g key={id}>
            {/* Kabel */}
            <g style={{ color: cableColor }}>
              {down ? (
                <>
                  <path d={brokenPath(l)} fill="none" stroke="currentColor" strokeWidth={10} strokeOpacity={0.2} strokeLinecap="round" />
                  <path d={brokenPath(l)} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
                  <circle cx={o === "h" ? mx : l.x1} cy={my} r={10} style={{ fill: "var(--np-panel)" }} />
                  <Unplug x={(o === "h" ? mx : l.x1) - 7} y={my - 7} width={14} height={14} strokeWidth={2} style={{ color: HEALTH_COLOR.crit }} />
                </>
              ) : (
                <>
                  {!wlan && (
                    <path d={d} fill="none" stroke="currentColor" strokeWidth={10} strokeOpacity={s.health === "crit" ? 0.2 : 0.12} strokeLinecap="round" />
                  )}
                  <path
                    d={d}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={wlan ? 1.5 : 2}
                    strokeLinecap="round"
                    strokeDasharray={unknown || wlan ? "3 5" : undefined}
                  />
                  {!unknown && !wlan && <Packets d={d} drop={drop} />}
                </>
              )}
            </g>

            {/* WLAN-Ausweichweg */}
            {wlan && (
              <g style={{ color: HEALTH_COLOR[s.health === "good" || s.health === "unknown" ? "warn" : s.health] }}>
                <path d={wd} fill="none" stroke="currentColor" strokeWidth={8} strokeOpacity={0.14} strokeLinecap="round" />
                <path d={wd} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeDasharray="6 4" />
                <Packets d={wd} drop={drop} />
                {o === "h" && (
                  <g>
                    <Wifi x={mx - 58} y={30} width={14} height={14} strokeWidth={2} />
                    <text x={mx - 40} y={41} className="text-[12px] font-medium" style={{ fill: "currentColor" }}>
                      WLAN-Ausweichen
                    </text>
                  </g>
                )}
              </g>
            )}

            {/* horizontal mit WLAN-Bogen: der Bogen kreuzt sonst das Label – "WLAN-Ausweichen" ersetzt es */}
            {!(o === "h" && wlan) && (
              <text x={pos.x} y={pos.yLabel} textAnchor={pos.anchor} className="fill-fg-3 text-[12.5px]">
                {TOPOLOGY_LINK_LABEL[id]}
              </text>
            )}
            <text x={pos.x} y={pos.yValue} textAnchor={pos.anchor} className="np-num text-[13.5px]">
              {down ? (
                <tspan style={{ fill: HEALTH_COLOR.crit }}>Link getrennt</tspan>
              ) : unknown ? (
                <tspan className="fill-fg-3">keine Daten</tspan>
              ) : (
                <>
                  {/* Zustand nicht nur über die Farbe: Wort vor dem Wert (farbenblind-tauglich).
                      Horizontal reicht der Platz zwischen den Knoten nicht – dort eigene Zeile darunter. */}
                  {o === "v" && (s.health === "warn" || s.health === "crit") && (
                    <tspan className="font-sans text-[12.5px] font-medium" style={{ fill: HEALTH_COLOR[s.health] }}>
                      {HEALTH_LABEL[s.health]}
                      {" "}
                    </tspan>
                  )}
                  <tspan className="fill-fg">{fmtMs(s.rttMs)}</tspan>
                  <tspan className="fill-fg-3" dx={10}>
                    {fmtPct(s.lossPct)}
                  </tspan>
                </>
              )}
            </text>
            {o === "h" && !down && !unknown && (s.health === "warn" || s.health === "crit") && (
              <text
                x={pos.x}
                y={pos.yValue + 17}
                textAnchor={pos.anchor}
                className="font-sans text-[12.5px] font-medium"
                style={{ fill: HEALTH_COLOR[s.health] }}
              >
                {HEALTH_LABEL[s.health]}
              </text>
            )}
            {o === "v" && wlan && (
              <g style={{ color: HEALTH_COLOR.warn }}>
                <Wifi x={pos.x} y={my + 20} width={13} height={13} strokeWidth={2} />
                <text x={pos.x + 18} y={my + 31} className="text-[12px] font-medium" style={{ fill: "currentColor" }}>
                  WLAN-Ausweichen
                </text>
              </g>
            )}
          </g>
        );
      })}

      {/* Knoten: ruhig wenn gut, laut wenn auffällig/kritisch */}
      {TOPOLOGY_NODE_ORDER.map((id, i) => {
        const s = nodes[id];
        const { x, y } = g.nodes[i];
        const Icon = NODE_ICON[id];
        const StatusIcon = HEALTH_ICON[s.health];
        const loud = s.health === "warn" || s.health === "crit";
        const color = HEALTH_COLOR[s.health];
        const txt =
          o === "h"
            ? { x, y1: y + t / 2 + 20, y2: y + t / 2 + 37, y3: y + t / 2 + 54, anchor: "middle" as const }
            : { x: 90, y1: y - 8, y2: y + 10, y3: y + 28, anchor: "start" as const };
        return (
          <g key={id}>
            {loud && (
              <rect x={x - t / 2 - 5} y={y - t / 2 - 5} width={t + 10} height={t + 10} rx={g.r + 5} style={{ fill: color }} fillOpacity={0.1} />
            )}
            <rect
              x={x - t / 2}
              y={y - t / 2}
              width={t}
              height={t}
              rx={g.r}
              style={{ fill: "var(--np-panel)", stroke: loud ? color : "var(--np-line-strong)" }}
              strokeWidth={loud ? 1.5 : 1}
              strokeDasharray={s.health === "unknown" ? "3 4" : undefined}
            />
            <Icon x={x - 11} y={y - 11} width={22} height={22} strokeWidth={1.75} style={{ color: "var(--np-fg-2)" }} />
            {/* Zustands-Abzeichen: Form + Farbe (Häkchen / Dreieck / Achteck / Fragezeichen) */}
            <g aria-hidden>
              <circle cx={x + t / 2 - 4} cy={y - t / 2 + 4} r={9} style={{ fill: "var(--np-panel)", stroke: color }} strokeWidth={1.25} />
              <StatusIcon x={x + t / 2 - 11} y={y - t / 2 - 3} width={14} height={14} strokeWidth={2.25} style={{ color }} />
            </g>
            <text x={txt.x} y={txt.y1} textAnchor={txt.anchor} className="fill-fg font-display text-[15px] font-medium">
              {TOPOLOGY_NODE_LABEL[id]}
            </text>
            {s.sublabel && (
              <text x={txt.x} y={txt.y2} textAnchor={txt.anchor} className="fill-fg-3 text-[12.5px]">
                {s.sublabel}
              </text>
            )}
            {s.detail && (
              <text x={txt.x} y={txt.y3} textAnchor={txt.anchor} className="np-num text-[12px]" style={{ fill: loud ? color : "var(--np-fg-3)" }}>
                {s.detail}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

/**
 * Leitungsweg PC -> LAN-Kabel -> Router -> Kabelnetz (DOCSIS) -> Kopfstation -> Vodafone-Netz ->
 * DS-Lite-Gateway (AFTR) -> Internet -> Ziele. Linkfarbe = Zustand. Pakete laufen per CSS
 * offset-path und pausieren automatisch (Tab verborgen, 90 s Inaktivität, reduzierte Bewegung).
 * Bei Verlust fällt ein Paket sichtbar aus der Leitung; bei WLAN-Ausweichen laufen die Pakete
 * über einen gestrichelten Bogen, bei getrenntem Kabel ist die Leitung unterbrochen.
 * Server-Komponente: keine Hooks, kein eigenes JS. Live-Variante: <LiveTopology/>.
 */
export function SegmentTopology({ nodes, links, showTunnel = true, id = "np-topo", caption, className }: SegmentTopologyProps) {
  const desc = describe(nodes, links);
  return (
    <figure className={cn("@container", className)}>
      <div className="mx-auto hidden max-w-[1120px] @3xl:block">
        <Diagram o="h" uid={id} desc={desc} nodes={nodes} links={links} showTunnel={showTunnel} />
      </div>
      <div className="mx-auto max-w-[420px] @3xl:hidden">
        <Diagram o="v" uid={id} desc={desc} nodes={nodes} links={links} showTunnel={showTunnel} />
      </div>
      <figcaption className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-fg-3">
        {(["good", "warn", "crit", "unknown"] as const).map((h) => {
          const Icon = HEALTH_ICON[h];
          return (
            <span key={h} className="inline-flex items-center gap-1.5">
              <Icon aria-hidden className="size-3.5" style={{ color: HEALTH_COLOR[h] }} strokeWidth={2.25} />
              {HEALTH_LABEL[h]}
            </span>
          );
        })}
        <span className="text-fg-3">{caption ?? "RTT: Median bis Abschnittsende. Verlust: Anteil dieses Abschnitts."}</span>
      </figcaption>
    </figure>
  );
}
