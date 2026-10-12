/**
 * Ereignisse für das Dashboard: API-Ereignisse (24 h) mit den Live-Ereignissen zusammenführen und
 * gleichzeitige Ping-Spitzen auf mehreren Zielen zu einem Eintrag bündeln. Reine Funktionen.
 */
import type { NetEvent } from "@/lib/shared/types";
import type { TimelineEvent } from "@/components/viz/EventTimeline";
import { eventDurationS, eventKey, eventSegment, eventSourceText, toTimelineEvent } from "@/lib/client/adapters";
import { fmtMs } from "@/lib/format";
import { severityToUi, type Severity } from "@/lib/health";
import { SEGMENTS, type SegmentId } from "@/lib/segments";

/** API-Ereignisse + Live-Ereignisse (Live gewinnt bei gleichem Schlüssel, z. B. nachgetragenes Ende), neueste zuerst. */
export function mergeEvents(api: readonly NetEvent[], live: readonly NetEvent[], from: number): NetEvent[] {
  const map = new Map<string, NetEvent>();
  for (const e of api) map.set(eventKey(e), e);
  for (const e of live) if (e.ts >= from) map.set(eventKey(e), e);
  return [...map.values()].filter((e) => e.ts >= from).sort((a, b) => b.ts - a.ts);
}

const SEV_RANK: Record<Severity, number> = { info: 0, unknown: 0, good: 0, warn: 1, crit: 2 };
const SEGMENT_ORDER: Record<SegmentId, number> = Object.fromEntries(SEGMENTS.map((s, i) => [s.id, i])) as Record<SegmentId, number>;

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function detailsOf(e: NetEvent): Record<string, unknown> {
  return e.details && typeof e.details === "object" ? e.details : {};
}

/**
 * NetEvents -> Timeline-Einträge. `latency_spike`-Ereignisse mit gleichem Zeitpunkt werden zu
 * „Ping-Spitze auf N Zielen“ zusammengefasst (Abschnitt = der nächstgelegene betroffene).
 */
export function toDashboardTimeline(events: readonly NetEvent[], nameOf: (targetId: string) => string): TimelineEvent[] {
  const spikes = new Map<number, NetEvent[]>();
  const out: TimelineEvent[] = [];
  for (const e of events) {
    if (e.type !== "latency_spike") {
      out.push(toTimelineEvent(e));
      continue;
    }
    const list = spikes.get(e.ts);
    if (list) list.push(e);
    else spikes.set(e.ts, [e]);
  }
  for (const [ts, list] of spikes) {
    if (list.length === 1) {
      out.push(toTimelineEvent(list[0]));
      continue;
    }
    let severity: Severity = "info";
    let segment: SegmentId | undefined;
    let durationS: number | undefined;
    let peak: number | null = null;
    const names: string[] = [];
    for (const e of list) {
      const sev = severityToUi(e.severity);
      if (SEV_RANK[sev] > SEV_RANK[severity]) severity = sev;
      const seg = eventSegment(e);
      if (seg && (segment === undefined || SEGMENT_ORDER[seg] < SEGMENT_ORDER[segment])) segment = seg;
      const d = eventDurationS(e);
      if (d != null && (durationS === undefined || d > durationS)) durationS = d;
      const det = detailsOf(e);
      const p = num(det.peakMs);
      if (p != null && (peak === null || p > peak)) peak = p;
      const tid = typeof det.targetId === "string" ? det.targetId : null;
      if (tid && !names.includes(nameOf(tid))) names.push(nameOf(tid));
    }
    const targets = names.length ? names.join(", ") : `${list.length} Ziele`;
    out.push({
      id: `spikes-${ts}`,
      at: new Date(ts).toISOString(),
      severity,
      segment,
      title: `Ping-Spitze auf ${list.length} Zielen`,
      detail: peak != null ? `Bis ${fmtMs(peak)}: ${targets}` : targets,
      durationS,
      source: eventSourceText(list[0]),
    });
  }
  return out.sort((a, b) => b.at.localeCompare(a.at));
}
