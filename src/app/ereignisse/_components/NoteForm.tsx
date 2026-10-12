"use client";

import { useState, type FormEvent } from "react";
import { NotebookPen } from "lucide-react";
import { addNote, errorMessage } from "@/lib/client/api";
import { revalidateApi } from "@/lib/client/use-api";
import { fmtTime } from "@/lib/format";
import { Button } from "@/components/ui/Button";
import { Field, Switch, TextInput } from "@/components/ui/Field";
import { Panel } from "@/components/ui/Panel";
import { toast } from "@/components/ui/Toast";

const TEXTAREA =
  "w-full rounded-lg bg-raised px-3 py-2 text-sm text-fg ring-1 ring-inset ring-line-control placeholder:text-fg-4 hover:bg-overlay " +
  "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-fiber";

/**
 * Notiz anlegen (POST /api/events): z. B. "Lag in Fortnite", damit der Moment später im Verlauf
 * und in der Diagnose neben den Messwerten steht.
 */
export function NoteForm() {
  const [title, setTitle] = useState("");
  const [when, setWhen] = useState("");
  const [text, setText] = useState("");
  const [lag, setLag] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [whenError, setWhenError] = useState<string | null>(null);

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const t = title.trim();
    if (!t) {
      setError("Gib der Notiz einen kurzen Titel.");
      return;
    }
    setError(null);
    let ts = Date.now();
    if (when) {
      const parsed = Date.parse(when);
      if (!Number.isFinite(parsed)) {
        setWhenError("Der Zeitpunkt ist unvollständig.");
        return;
      }
      if (parsed > ts + 60_000) {
        setWhenError("Der Zeitpunkt liegt in der Zukunft. Wähle einen vergangenen Moment.");
        return;
      }
      ts = parsed;
    }
    setWhenError(null);
    setBusy(true);
    try {
      const details: Record<string, unknown> = {};
      if (lag) details.kind = "lag";
      if (text.trim()) details.note = text.trim();
      await addNote(t, { ts, details: Object.keys(details).length ? details : undefined });
      toast({ title: "Notiz gespeichert", description: `${t} – ${fmtTime(ts)}` });
      setTitle("");
      setWhen("");
      setText("");
      revalidateApi("/api/events");
    } catch (err) {
      toast({ title: "Notiz nicht gespeichert", description: errorMessage(err), tone: "error" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel title="Notiz hinzufügen" description="Markiere einen Moment, zum Beispiel einen Lag im Spiel. Er erscheint dann in der Zeitleiste und im Verlauf.">
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <Field label="Titel" htmlFor="np-note-title" error={error}>
          <TextInput
            id="np-note-title"
            value={title}
            maxLength={200}
            placeholder="Lag in Fortnite"
            onChange={(e) => setTitle(e.target.value)}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "np-note-title-error" : undefined}
            required
          />
        </Field>
        <Field label="Zeitpunkt" htmlFor="np-note-when" optional hint="Leer lassen für jetzt." error={whenError}>
          <TextInput
            id="np-note-when"
            type="datetime-local"
            value={when}
            onChange={(e) => setWhen(e.target.value)}
            aria-invalid={whenError ? true : undefined}
            aria-describedby={whenError ? "np-note-when-error" : "np-note-when-hint"}
          />
        </Field>
        <Field label="Beschreibung" htmlFor="np-note-text" optional>
          <textarea id="np-note-text" rows={3} maxLength={2000} value={text} onChange={(e) => setText(e.target.value)} className={TEXTAREA} />
        </Field>
        <Switch id="np-note-lag" checked={lag} onChange={(e) => setLag(e.target.checked)} label="Als Lag markieren" hint="Im Latenzdiagramm steht dann „Lag“ statt „Notiz“." />
        <div>
          <Button type="submit" variant="primary" icon={NotebookPen} loading={busy}>
            Notiz speichern
          </Button>
        </div>
      </form>
    </Panel>
  );
}
