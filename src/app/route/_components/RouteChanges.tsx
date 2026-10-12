"use client";

import { ArrowRight, GitCompareArrows } from "lucide-react";
import { Panel } from "@/components/ui/Panel";
import { EmptyState } from "@/components/ui/States";
import { fmtDateTime, fmtDateTimeShort } from "@/lib/format";
import { TRIGGER_LABEL, type RouteChange } from "./route-utils";

interface RouteChangesProps {
  family: 4 | 6;
  changes: readonly RouteChange[];
  /** Zeitpunkt der ältesten geladenen Pfaderkennung */
  since: number | null;
}

function Addr({ ip }: { ip: string | null }) {
  return ip ? <span className="np-num break-all text-fg">{ip}</span> : <span className="text-fg-3">antwortet nicht</span>;
}

/** Routenwechsel einer Adressfamilie mit Unterschied der Hop-Adressen. */
export function RouteChanges({ family, changes, since }: RouteChangesProps) {
  return (
    <Panel
      title={`Routenwechsel IPv${family}`}
      description={
        since !== null ? (
          <>
            Geänderte Hop-Adressen gegenüber der vorherigen Pfaderkennung, seit <span className="np-num">{fmtDateTimeShort(since)}</span>.
          </>
        ) : (
          "Geänderte Hop-Adressen gegenüber der vorherigen Pfaderkennung."
        )
      }
    >
      {changes.length === 0 ? (
        <EmptyState icon={GitCompareArrows} title="Keine Routenwechsel">
          Der Weg zu Cloudflare blieb im geladenen Zeitraum gleich. Stumme Hops (ICMP-Drosselung) zählen nicht als Wechsel.
        </EmptyState>
      ) : (
        <ol className="flex max-h-[420px] flex-col gap-3 overflow-y-auto pr-1">
          {changes.map((c) => (
            <li key={c.row.id ?? c.row.ts} className="rounded-[10px] bg-raised/50 p-3 ring-1 ring-inset ring-line">
              <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
                <span className="np-num font-medium text-fg">{fmtDateTime(c.row.ts)}</span>
                <span className="text-xs text-fg-3">{TRIGGER_LABEL[c.row.trigger]}</span>
                {c.lengthChanged && (
                  <span className="text-xs text-fg-2">
                    Ziel nach <span className="np-num">{c.curLength}</span> statt <span className="np-num">{c.prevLength}</span> Hops
                  </span>
                )}
              </p>
              {c.diffs.length > 0 ? (
                <ul className="mt-2 flex flex-col gap-1.5">
                  {c.diffs.map((d) => (
                    <li key={d.hop} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
                      <span className="w-12 shrink-0 text-fg-3">
                        Hop <span className="np-num">{d.hop}</span>
                      </span>
                      <Addr ip={d.before} />
                      <ArrowRight aria-label="geändert zu" className="size-3.5 shrink-0 text-fg-3" strokeWidth={2} />
                      <Addr ip={d.after} />
                    </li>
                  ))}
                </ul>
              ) : (
                !c.lengthChanged && (
                  <p className="mt-1 text-xs text-fg-3">
                    {c.prev ? "Neue Hop-Adresse(n) an bekannten Stellen (wechselnde Lastverteilung)." : "Vorherige Pfaderkennung nicht geladen."}
                  </p>
                )
              )}
            </li>
          ))}
        </ol>
      )}
      <p className="mt-3 text-xs text-fg-3">
        Einzelne Routenwechsel sind normal (Wartung, Lastverteilung). Häufen sie sich zeitgleich mit Lags, lohnt ein Blick in den Verlauf.
      </p>
    </Panel>
  );
}
