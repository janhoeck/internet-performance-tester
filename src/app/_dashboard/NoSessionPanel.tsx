"use client";

import { useState } from "react";
import { Activity, Play } from "lucide-react";
import { useTargets } from "@/lib/client/targets";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/States";
import { SessionStartDialog } from "@/components/shell/SessionDialogs";

/** Hinweis, solange kein Langzeittest läuft (Engine erreichbar). Öffnet denselben Dialog wie die Statusleiste. */
export function NoSessionPanel() {
  const [open, setOpen] = useState(false);
  const { config } = useTargets();
  return (
    <section aria-label="Kein Langzeittest aktiv" className="np-panel np-frame">
      <EmptyState
        icon={Activity}
        title="Kein Langzeittest aktiv"
        className="py-8"
        action={
          <Button variant="primary" icon={Play} onClick={() => setOpen(true)}>
            Langzeittest starten
          </Button>
        }
      >
        <p>
          Im Langzeittest pingt die Mess-Engine jede Sekunde alle Abschnitte vom PC über Router, Kabelnetz und DS-Lite-Gateway bis zu den Internetzielen
          und protokolliert Link-Abbrüche, Ausfälle und Speedtests. So lässt sich zeigen, wo die Lags entstehen.
        </p>
        <p className="mt-2">
          Empfohlen sind <span className="np-num text-fg-2">72</span> Stunden inklusive zweier Abende. Starte den Test hier oder oben in der Statusleiste mit
          „Langzeittest starten“. Die Werte unten stammen aus früheren Messungen.
        </p>
      </EmptyState>
      {open && <SessionStartDialog onClose={() => setOpen(false)} preventSleep={config?.session.preventSleep ?? true} />}
    </section>
  );
}
