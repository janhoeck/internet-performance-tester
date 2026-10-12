import { cn } from "@/lib/cn";
import { dayKey, fmtDayLong, fmtDuration, fmtTime } from "@/lib/format";
import { HEALTH_ICON, HEALTH_LABEL, HEALTH_TEXT, type Severity } from "@/lib/health";
import { SEGMENT_BY_ID, type SegmentId } from "@/lib/segments";

export interface TimelineEvent {
  id: string;
  /** ISO-Zeitpunkt */
  at: string;
  severity: Severity;
  segment?: SegmentId;
  /** Was passiert ist, aus Nutzersicht: "Ethernet-Verbindung getrennt" */
  title: string;
  /** Beleg/Kontext: "Neu verbunden mit 100 Mbit/s statt 1 Gbit/s" */
  detail?: string;
  durationS?: number;
  /** Quelle, z. B. "Windows-Ereignisprotokoll (e2fexpress, ID 27)" */
  source?: string;
}

interface EventTimelineProps {
  events: readonly TimelineEvent[];
  /** "Jetzt" als ISO-String vom Server/Client übergeben (kein Date.now() im Render). */
  now?: string;
  /** Abstand der klebenden Tagesüberschrift: 0 in eigenem Scroll-Container,
      56 (Höhe Statusleiste) wenn die ganze Seite scrollt. */
  stickyOffset?: number;
  className?: string;
}

function dayHeading(key: string, now?: string): string {
  if (now) {
    const today = dayKey(now);
    const yesterday = dayKey(new Date(new Date(now).getTime() - 86_400_000));
    if (key === today) return `Heute, ${fmtDayLong(`${key}T12:00:00Z`)}`;
    if (key === yesterday) return `Gestern, ${fmtDayLong(`${key}T12:00:00Z`)}`;
  }
  return fmtDayLong(`${key}T12:00:00Z`);
}

/**
 * Ereignisprotokoll, neueste zuerst, nach Kalendertag gruppiert.
 * Raster: Uhrzeit | Schiene mit Icon | Inhalt. Farbe nur am Icon, Text bleibt neutral.
 */
export function EventTimeline({ events, now, stickyOffset = 0, className }: EventTimelineProps) {
  const sorted = [...events].sort((a, b) => b.at.localeCompare(a.at));
  const groups = new Map<string, TimelineEvent[]>();
  for (const e of sorted) {
    const k = dayKey(e.at);
    const list = groups.get(k);
    if (list) list.push(e);
    else groups.set(k, [e]);
  }

  return (
    <div className={cn("flex flex-col gap-6", className)}>
      {[...groups.entries()].map(([key, list]) => (
        <section key={key} aria-label={dayHeading(key, now)}>
          <h3 className="sticky z-10 mb-1 bg-panel py-1.5 font-sans text-xs font-medium text-fg-3" style={{ top: stickyOffset }}>
            {dayHeading(key, now)}
            <span className="np-num ml-2 text-fg-4">{list.length}</span>
          </h3>
          <ol className="flex flex-col">
            {list.map((e) => {
              const Icon = HEALTH_ICON[e.severity];
              const seg = e.segment ? SEGMENT_BY_ID[e.segment] : undefined;
              return (
                <li key={e.id} className="group grid grid-cols-[4.75rem_1.5rem_minmax(0,1fr)] gap-x-3">
                  <time dateTime={e.at} className="np-num pt-2.5 text-xs text-fg-3">
                    {fmtTime(e.at)}
                  </time>
                  <span className="relative flex justify-center">
                    <span aria-hidden className="absolute bottom-0 top-0 w-px bg-line group-first:top-4 group-last:bottom-auto group-last:h-4" />
                    <span className={cn("relative mt-2 grid size-6 place-items-center rounded-full bg-panel ring-1 ring-line", HEALTH_TEXT[e.severity])}>
                      <Icon aria-hidden className="size-3.5" strokeWidth={2.25} />
                      <span className="sr-only">{HEALTH_LABEL[e.severity]}</span>
                    </span>
                  </span>
                  <div className="min-w-0 py-2">
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                      <p className="text-sm font-medium text-fg">{e.title}</p>
                      {e.durationS != null && (
                        <span className="np-num rounded-md bg-raised px-1.5 text-2xs leading-5 text-fg-2 ring-1 ring-inset ring-line">
                          {fmtDuration(e.durationS)}
                        </span>
                      )}
                      {seg && (
                        <span className="inline-flex items-center gap-1.5 rounded-full px-2 text-2xs leading-5 text-fg-3 ring-1 ring-inset ring-line">
                          <span aria-hidden className={cn("size-1.5 rounded-full", seg.colorClass)} />
                          {seg.label}
                        </span>
                      )}
                    </div>
                    {e.detail && <p className="mt-0.5 text-xs text-fg-3">{e.detail}</p>}
                    {e.source && <p className="mt-0.5 text-2xs text-fg-4">Quelle: {e.source}</p>}
                  </div>
                </li>
              );
            })}
          </ol>
        </section>
      ))}
    </div>
  );
}
