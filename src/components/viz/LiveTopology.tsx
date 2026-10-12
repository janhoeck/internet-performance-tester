"use client";

import { useLiveConnection, useSession } from "@/lib/client/live-store";
import { useLiveTopology } from "@/lib/client/segment-health";
import { SegmentTopology } from "./SegmentTopology";

interface LiveTopologyProps {
  /** eindeutiger Präfix für SVG-IDs, falls mehrere Topologien auf einer Seite stehen */
  id?: string;
  showTunnel?: boolean;
  className?: string;
}

/**
 * Leitungsweg mit Live-Zustand (letzte 60 s, Schwellen aus der Konfiguration): Link-Status und
 * WLAN-Ausweichen am LAN-Kabel, RTT/Verlust je Abschnitt, Router-/DOCSIS-/DS-Lite-Zustand.
 */
export function LiveTopology({ id = "np-live-topo", showTunnel = true, className }: LiveTopologyProps) {
  const topo = useLiveTopology();
  const conn = useLiveConnection();
  const session = useSession();
  const sessionRunning = session != null && session.status === "running" && session.endedAt == null;
  const caption = !conn.online
    ? conn.status === "idle" || conn.status === "connecting"
      ? "Verbindung zur Mess-Engine wird aufgebaut …"
      : "Mess-Engine nicht erreichbar – Zustand unbekannt."
    : !topo.hasData
      ? sessionRunning
        ? "Warte auf Messwerte … Der Langzeittest läuft, die Live-Werte je Abschnitt erscheinen gleich."
        : "Kein Langzeittest aktiv: Live-Werte je Abschnitt erscheinen, sobald ein Test läuft."
      : "RTT: Median der letzten 60 s bis Abschnittsende. Verlust: Anteil dieses Abschnitts.";
  return <SegmentTopology id={id} nodes={topo.nodes} links={topo.links} showTunnel={showTunnel} caption={caption} className={className} />;
}
