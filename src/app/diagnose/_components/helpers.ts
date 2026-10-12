/**
 * Kleine reine Hilfen für Diagnose und Bericht (keine Hooks).
 */
import type { DiagnosisReport, Finding, SecondsRollup, Segment, TargetStats } from "@/lib/shared/types";
import { CONFIDENCE_LABEL } from "@/lib/client/adapters";

const MIN = 60_000;

/**
 * Link in den Verlauf für einen Beleg: Episode mit etwas Rand, Zeitpunkt ±15 min.
 * Format von useTimeRange: ?range=custom&from=<ms>&to=<ms>
 */
export function verlaufHref(ts: number, tsEnd?: number | null): string {
  let from: number;
  let to: number;
  if (tsEnd != null && tsEnd > ts) {
    const pad = Math.max(5 * MIN, (tsEnd - ts) * 0.2);
    from = ts - pad;
    to = tsEnd + pad;
  } else {
    from = ts - 15 * MIN;
    to = ts + 15 * MIN;
  }
  return `/verlauf?range=custom&from=${Math.round(from)}&to=${Math.round(to)}`;
}

const NON_CAUSE = new Set(["data-quality"]);

/**
 * Der Befund hinter dem Urteil (wie die Diagnose ihn wählt): höchster Score unter den
 * Auffällig/Kritisch-Befunden des Hauptabschnitts, sonst der beste Kandidat überhaupt.
 */
export function primaryFinding(report: DiagnosisReport): Finding | null {
  const candidates = report.findings
    .filter((f) => !NON_CAUSE.has(f.id) && f.severity !== "info")
    .sort((a, b) => b.score - a.score);
  const seg = report.verdict.primarySegment;
  return (seg ? candidates.find((f) => f.segment === seg) : undefined) ?? candidates[0] ?? null;
}

export function confidenceText(f: Finding | null): string | null {
  return f ? CONFIDENCE_LABEL[f.confidence] : null;
}

/** Urteil ist vorläufig (zu wenig Daten / ausdrücklich so betitelt). */
export function isProvisional(report: DiagnosisReport): boolean {
  if (/vorläufig/i.test(report.verdict.title) || /vorläufig/i.test(report.verdict.text)) return true;
  if (report.findings.some((f) => f.id === "data-quality" && f.severity !== "info")) return true;
  return report.dataQuality.coveragePct < 70 && (report.seconds?.covered ?? 0) < 24 * 3600;
}

/** DiagnosisReport.seconds -> SecondsRollup (für <FaultShareBar/> und secondsBreakdown()). */
export function secondsToRollup(s: DiagnosisReport["seconds"]): SecondsRollup | null {
  if (!s) return null;
  return {
    ts: 0,
    covered: s.covered,
    good: Math.max(0, s.covered - s.bad),
    link: s.byClass.link,
    lan: s.byClass.lan,
    access: s.byClass.access,
    aftr: s.byClass.aftr,
    backbone: s.byClass.backbone,
    remote: s.byClass.remote,
    unknown: s.byClass.unknown,
    es: s.es,
    ses: s.ses,
    selfLoad: s.selfLoad,
  };
}

/** Statistik eines Ziels (nur wenn gemessen). */
export function statOf(stats: readonly TargetStats[] | null | undefined, id: string): TargetStats | null {
  const s = stats?.find((x) => x.targetId === id);
  return s && s.sent > 0 ? s : null;
}

export function segmentOf(report: DiagnosisReport | null, seg: Segment) {
  return report?.segments.find((s) => s.segment === seg) ?? null;
}

/** MAC-Adressen unkenntlich machen (Router-Protokoll im Bericht). */
export function redactMacs(text: string): string {
  return text.replace(/\b([0-9a-f]{2})[:-](?:[0-9a-f]{2}[:-]){4}[0-9a-f]{2}\b/gi, "$1:xx:xx:xx:xx:xx");
}

const hourParts = new Intl.DateTimeFormat("de-DE", { hour: "2-digit", hourCycle: "h23", timeZone: "Europe/Berlin" });
const dayParts = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: "Europe/Berlin" });

/** Stunde 0..23 in deutscher Ortszeit (de-DE formatiert sonst „16 Uhr“). */
export function berlinHour(ts: number): number {
  const v = hourParts.formatToParts(ts).find((p) => p.type === "hour")?.value;
  const h = Number(v);
  return Number.isFinite(h) ? h % 24 : 0;
}

/** Kalendertag "YYYY-MM-DD" in deutscher Ortszeit. */
export function berlinDay(ts: number): string {
  return dayParts.format(ts);
}
