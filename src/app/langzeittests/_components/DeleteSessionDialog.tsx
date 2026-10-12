"use client";

import { useState, type FormEvent } from "react";
import { Trash2 } from "lucide-react";
import type { SessionDeleteResult, SessionDeleteScope, SessionOverview } from "@/lib/shared/sessions";
import { errorMessage, fetchJson } from "@/lib/client/api";
import { revalidateApi } from "@/lib/client/use-api";
import { sessionName } from "@/lib/client/sessions";
import { fmtInt, fmtTimeRange } from "@/lib/format";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { ChoiceGroup, type ChoiceOption } from "@/components/ui/Field";
import { toast } from "@/components/ui/Toast";

const SCOPES: readonly ChoiceOption<SessionDeleteScope>[] = [
  { value: "entry", label: "Nur den Eintrag", hint: "Messwerte bleiben für Zeiträume wie „Letzte 7 Tage“" },
  { value: "data", label: "Eintrag und Messdaten", hint: "alles, was in diesem Test gemessen wurde" },
];

/** Löschen bei langen Tests: viele kleine Schritte, damit die laufende Messung nie warten muss */
const DELETE_TIMEOUT_MS = 10 * 60_000;

/** „Langzeittest löschen“: nur der Eintrag oder Eintrag samt Messdaten (DELETE /api/sessions/[id]). */
export function DeleteSessionDialog({ item, onClose }: { item: SessionOverview; onClose: () => void }) {
  const [scope, setScope] = useState<SessionDeleteScope>("entry");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = sessionName(item.session);
  const period = fmtTimeRange(item.from, item.to);

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetchJson<SessionDeleteResult>(`/api/sessions/${item.session.id}?scope=${scope}`, {
        method: "DELETE",
        timeoutMs: DELETE_TIMEOUT_MS,
      });
      const rows = Object.entries(res.deleted)
        .filter(([table]) => table !== "sessions")
        .reduce((sum, [, n]) => sum + n, 0);
      toast({
        title: "Langzeittest gelöscht",
        description: res.scope === "data" ? `„${name}“ und ${fmtInt(rows)} gespeicherte Datensätze wurden entfernt.` : `„${name}“ wurde aus der Liste entfernt.`,
      });
      // Messdaten können überall fehlen (Verlauf, Diagnose, Bericht …): alles neu laden
      revalidateApi("/api/");
      onClose();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      dismissible={!busy}
      title="Langzeittest löschen?"
      description={
        <>
          <span className="font-medium text-fg">{name}</span>
          <span className="np-num"> · {period}</span>
        </>
      }
      onSubmit={submit}
      initialFocus="input[type=radio]:checked"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Abbrechen
          </Button>
          <Button type="submit" variant="danger" icon={Trash2} loading={busy}>
            {busy ? "Wird gelöscht …" : "Endgültig löschen"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <ChoiceGroup name="np-delete-scope" legend="Was soll gelöscht werden?" options={SCOPES} value={scope} onChange={setScope} columns={2} />
        {scope === "entry" ? (
          <p className="text-sm text-fg-2">
            Der Test verschwindet aus der Liste und aus der Auswahl im Bericht. Die Messwerte dieses Zeitraums bleiben gespeichert und erscheinen weiter, wenn du
            einen Zeitraum wie „Letzte 7 Tage“ ansiehst.
          </p>
        ) : (
          <div className="flex flex-col gap-2 text-sm text-fg-2">
            <p>
              Gelöscht wird alles, was vom <span className="np-num">{period}</span> gemessen wurde: Pings, gestörte Sekunden, Minutenwerte, Speedtests,
              Traceroutes und Ereignisse wie Ausfälle und Lag-Markierungen. Einträge aus dem Windows- und dem Router-Protokoll bleiben erhalten, ebenso der jeweils
              aktuelle Stand von Router und Netzwerkkarte.
            </p>
            <p className="text-fg-3">Bei langen Tests dauert das einige Sekunden. Eine laufende Messung wird dabei nicht unterbrochen.</p>
          </div>
        )}
        <p className="text-sm font-medium text-warn">Das lässt sich nicht rückgängig machen.</p>
        {error && (
          <p role="alert" className="text-sm text-crit">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
