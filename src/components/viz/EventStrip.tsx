import { cn } from "@/lib/cn";
import { fmtDuration, fmtShortTime, fmtTime } from "@/lib/format";
import { HEALTH_LABEL, HEALTH_TEXT } from "@/lib/health";
import { SEGMENTS, type SegmentId } from "@/lib/segments";
import type { TimelineEvent } from "./EventTimeline";

interface EventStripProps {
  events: readonly TimelineEvent[];
  /** Zeitfenster als ISO-Strings, z. B. letzte 24 h */
  from: string;
  to: string;
  /** Welche Spuren gezeigt werden (Standard: alle mit Ereignissen + PC/Router/DOCSIS) */
  lanes?: SegmentId[];
  className?: string;
}

/**
 * 24-h-Streifen: eine Spur je Segment, Striche = Ereignisse, Breite = Dauer (min. 2 px).
 * Macht Muster sichtbar wie "Link-Abbrüche gehäuft 18:29–18:43". Reines HTML/CSS.
 * Schmaler Container (< 28rem): Spurname steht über der Spur, damit die Zeitachse Platz hat.
 */
export function EventStrip({ events, from, to, lanes, className }: EventStripProps) {
  const t0 = new Date(from).getTime();
  const t1 = new Date(to).getTime();
  const span = Math.max(1, t1 - t0);
  const used = new Set(events.map((e) => e.segment).filter(Boolean) as SegmentId[]);
  const laneIds = lanes ?? SEGMENTS.filter((s) => used.has(s.id) || ["pc", "router", "docsis"].includes(s.id)).map((s) => s.id);
  // 5 Marken (bei 24 h alle 6 h) – überlappen auch in schmalen Spalten nicht
  const ticks = Array.from({ length: 5 }, (_, i) => t0 + (span * i) / 4);

  return (
    <div className={cn("@container", className)}>
      <div className="grid grid-cols-1 gap-x-3 text-xs @md:grid-cols-[8.5rem_minmax(0,1fr)]">
        {laneIds.map((id) => {
          const seg = SEGMENTS.find((s) => s.id === id)!;
          const laneEvents = events.filter((e) => e.segment === id);
          return (
            <div key={id} className="contents">
              <div className="flex h-5 items-end gap-2 truncate text-fg-3 @md:h-7 @md:items-center">
                <seg.icon aria-hidden className="size-3.5 shrink-0" strokeWidth={2} />
                <span className="truncate">{seg.label}</span>
              </div>
              <div className="relative h-7 border-b border-line" role="list" aria-label={`Ereignisse ${seg.label}`}>
                {laneEvents.map((e) => {
                  const start = new Date(e.at).getTime();
                  const left = ((start - t0) / span) * 100;
                  const width = (((e.durationS ?? 0) * 1000) / span) * 100;
                  if (left < 0 || left > 100) return null;
                  const label = `${fmtTime(e.at)} ${e.title}${e.durationS != null ? `, ${fmtDuration(e.durationS)}` : ""} (${HEALTH_LABEL[e.severity]})`;
                  return (
                    <span
                      key={e.id}
                      role="listitem"
                      title={label}
                      aria-label={label}
                      className={cn("absolute bottom-1.5 top-1.5 rounded-sm bg-current opacity-90", HEALTH_TEXT[e.severity])}
                      style={{ left: `${left}%`, width: `max(2px, ${width}%)` }}
                    />
                  );
                })}
              </div>
            </div>
          );
        })}
        <div aria-hidden className="hidden @md:block" />
        <div aria-hidden className="relative mt-1 h-4">
          {ticks.map((t, i) => (
            <span
              key={t}
              className={cn(
                "np-num absolute text-2xs text-fg-4",
                i === 0 ? "translate-x-0" : i === ticks.length - 1 ? "-translate-x-full" : "-translate-x-1/2",
              )}
              style={{ left: `${(i / (ticks.length - 1)) * 100}%` }}
            >
              {fmtShortTime(t)}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
