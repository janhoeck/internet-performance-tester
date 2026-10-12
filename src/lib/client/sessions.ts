/**
 * Langzeittests in der Oberfläche: Anzeigename, Status, Links auf die Auswertungsseiten.
 * Typen und reine Helfer (Suche, Zeitfenster) liegen in `@/lib/shared/sessions`.
 */
import type { SessionStatus, TestSession } from "../shared/types";
import { fmtDateTimeShort } from "../format";

/** Name des Tests, ohne Namen: "Langzeittest ab 10.10., 12:18" */
export function sessionName(s: TestSession): string {
  const label = s.label?.trim();
  return label ? label : `Langzeittest ab ${fmtDateTimeShort(s.startedAt)}`;
}

/** Überschrift: "Langzeittest „WLAN“", ohne Dopplung bei Namen wie "Langzeittest 72 h" */
export function sessionTitle(s: TestSession): string {
  const label = s.label?.trim();
  if (!label) return sessionName(s);
  return /^langzeittest\b/i.test(label) ? label : `Langzeittest „${label}“`;
}

export const SESSION_STATUS_LABEL: Record<SessionStatus, string> = {
  running: "läuft",
  completed: "beendet",
  aborted: "vorzeitig beendet",
};

/** Seite mit genau diesem Langzeittest als Zeitraum (useTimeRange: ?range=session&session=<id>) */
export function sessionHref(path: "/bericht" | "/diagnose" | "/verlauf", id: number): string {
  return `${path}?range=session&session=${id}`;
}
