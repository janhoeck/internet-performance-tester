"use client";

import { EmptyState } from "@/components/ui/States";
import { useLiveConnection } from "@/lib/client/live-store";

/** Zeitraum "Langzeittest", aber es gab noch keinen. */
export function NoSessionState({ height = 240 }: { height?: number }) {
  return (
    <div className="grid place-items-center" style={{ minHeight: height }}>
      <EmptyState title="Noch kein Langzeittest">Starte oben in der Statusleiste einen Langzeittest oder wähle einen anderen Zeitraum.</EmptyState>
    </div>
  );
}

/** Mess-Engine weder offen noch gerade beim Verbinden. */
export function useEngineOffline(): boolean {
  const conn = useLiveConnection();
  return !conn.online && conn.status !== "idle" && conn.status !== "connecting";
}

/** Erklärung für leere Zeiträume – unterscheidet "Mess-Engine nicht erreichbar" von "kein Test". */
export function EngineHint({ offline }: { offline: boolean }) {
  return offline ? (
    <>Die Mess-Engine ist nicht erreichbar, daher kommen keine neuen Messwerte hinzu. Läuft der Befehl npm run dev noch?</>
  ) : (
    <>In diesem Zeitraum lief kein Langzeittest oder der PC war aus. Wähle einen anderen Zeitraum oder starte einen Langzeittest.</>
  );
}
