"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { control as engineControl } from "@/lib/client/api";
import { fmtDateTimeShort, fmtRuntime } from "@/lib/format";
import type { TestSession } from "@/lib/shared/types";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { ChoiceGroup, Field, TextInput, type ChoiceOption } from "@/components/ui/Field";
import { toast } from "@/components/ui/Toast";

type DurationKey = "60" | "360" | "1440" | "2880" | "4320" | "none";

const DURATIONS: readonly ChoiceOption<DurationKey>[] = [
  { value: "60", label: "1 h", hint: "kurzer Test" },
  { value: "360", label: "6 h" },
  { value: "1440", label: "24 h", hint: "mindestens" },
  { value: "2880", label: "48 h" },
  { value: "4320", label: "72 h", hint: "empfohlen" },
  { value: "none", label: "unbegrenzt", hint: "bis du stoppst" },
];

/** Steuerfunktion (Standard: echte Mess-Engine). Vorschauen (/dev/ui) übergeben eine Attrappe. */
export type SessionControlFn = typeof engineControl;

/** Ob die Komponente noch eingehängt ist (für Ergebnisse, die nach dem Schließen eintreffen). */
function useMountedRef() {
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return mounted;
}

/** "Langzeittest starten": Dauer + optionale Bezeichnung -> control('session.start', { durationMin, label }). */
export function SessionStartDialog({
  onClose,
  preventSleep = true,
  control = engineControl,
}: {
  onClose: () => void;
  preventSleep?: boolean;
  /** nur für Vorschauen: Ersatz für control() */
  control?: SessionControlFn;
}) {
  const mounted = useMountedRef();
  const [duration, setDuration] = useState<DurationKey>("4320");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    const text = label.trim();
    const res = await control("session.start", {
      durationMin: duration === "none" ? null : Number(duration),
      ...(text ? { label: text.slice(0, 80) } : {}),
    });
    if (res.ok) {
      toast({ title: "Langzeittest gestartet", description: text ? `„${text}“` : undefined });
      if (mounted.current) {
        setBusy(false);
        onClose();
      }
    } else if (mounted.current) {
      setBusy(false);
      setError(res.error ?? "Die Mess-Engine hat den Start abgelehnt.");
    } else {
      toast({ title: "Langzeittest nicht gestartet", description: res.error ?? "Die Mess-Engine hat den Start abgelehnt.", tone: "error" });
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      dismissible={!busy}
      title="Langzeittest starten"
      description="Die Mess-Engine pingt dann jede Sekunde alle Abschnitte bis zu den Zielen. Empfohlen sind 72 Stunden inklusive zweier Abende."
      onSubmit={submit}
      initialFocus="input[name=np-session-duration]:checked"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Abbrechen
          </Button>
          <Button type="submit" variant="primary" loading={busy}>
            Langzeittest starten
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <ChoiceGroup name="np-session-duration" legend="Dauer" options={DURATIONS} value={duration} onChange={setDuration} columns={3} />
        <Field label="Bezeichnung" htmlFor="np-session-label" optional hint="Hilft beim Vergleich, z. B. „Neues LAN-Kabel“ oder „WLAN-Test“.">
          <TextInput
            id="np-session-label"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            maxLength={80}
            placeholder="z. B. Neues LAN-Kabel"
            autoComplete="off"
            aria-describedby="np-session-label-hint"
          />
        </Field>
        {preventSleep && <p className="text-xs text-fg-3">Der Standby wird während des Tests verhindert. Lege den PC bitte nicht manuell schlafen.</p>}
        {error && (
          <p role="alert" className="rounded-lg bg-crit/12 px-3 py-2 text-sm text-crit ring-1 ring-inset ring-crit/30">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}

/** "Langzeittest beenden": Bestätigung -> control('session.stop'). */
export function SessionStopDialog({
  onClose,
  session,
  now,
  control = engineControl,
}: {
  onClose: () => void;
  session: TestSession | null;
  now: number | null;
  /** nur für Vorschauen: Ersatz für control() */
  control?: SessionControlFn;
}) {
  const mounted = useMountedRef();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const stop = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const res = await control("session.stop");
    if (res.ok) {
      toast({ title: "Langzeittest beendet", description: "Die Messdaten bleiben erhalten." });
      if (mounted.current) {
        setBusy(false);
        onClose();
      }
    } else if (mounted.current) {
      setBusy(false);
      setError(res.error ?? "Die Mess-Engine hat das Beenden abgelehnt.");
    } else {
      toast({ title: "Langzeittest nicht beendet", description: res.error ?? "Die Mess-Engine hat das Beenden abgelehnt.", tone: "error" });
    }
  };

  const runtime = session && now != null ? fmtRuntime(now - session.startedAt) : null;
  return (
    <Dialog
      open
      onClose={onClose}
      dismissible={!busy}
      size="sm"
      title="Langzeittest beenden?"
      description="Die Messung stoppt jetzt. Alle bisher gesammelten Daten bleiben erhalten und stehen für Diagnose und Bericht bereit."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Weiter messen
          </Button>
          <Button variant="danger" onClick={stop} loading={busy}>
            Langzeittest beenden
          </Button>
        </>
      }
    >
      {session && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-[10px] bg-sunken/60 px-4 py-3 text-sm ring-1 ring-inset ring-line">
          {session.label && (
            <>
              <dt className="text-fg-3">Bezeichnung</dt>
              <dd className="text-fg">{session.label}</dd>
            </>
          )}
          <dt className="text-fg-3">Gestartet</dt>
          <dd className="np-num text-fg">{fmtDateTimeShort(session.startedAt)}</dd>
          {runtime && (
            <>
              <dt className="text-fg-3">Laufzeit</dt>
              <dd className="np-num text-fg">{runtime}</dd>
            </>
          )}
        </dl>
      )}
      {error && (
        <p role="alert" className="mt-3 rounded-lg bg-crit/12 px-3 py-2 text-sm text-crit ring-1 ring-inset ring-crit/30">
          {error}
        </p>
      )}
    </Dialog>
  );
}
