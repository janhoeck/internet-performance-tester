"use client";

import { useMemo } from "react";
import { Timer } from "lucide-react";
import type { RouterResponse } from "@/lib/shared/api-types";
import { Panel } from "@/components/ui/Panel";
import { EmptyState } from "@/components/ui/States";
import { EChart } from "@/components/viz/EChart";
import { fmtMs } from "@/lib/format";
import { Chip, Num } from "./bits";
import { timeLinesOption } from "./router-charts";

type Http = RouterResponse["httpHistory"];

export function quantile(values: readonly (number | null)[], q: number): number | null {
  const v = values.filter((x): x is number => typeof x === "number" && Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const pos = (v.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return v[lo] + (v[hi] - v[lo]) * (pos - lo);
}

/** Bereiche ohne Antwort (ms = null) -> [start, ende] */
function unreachableRanges(h: Http): [number, number][] {
  const out: [number, number][] = [];
  let start: number | null = null;
  for (let i = 0; i < h.ts.length; i++) {
    const down = h.ms[i] == null;
    if (down && start == null) start = h.ts[i];
    if (!down && start != null) {
      out.push([start, h.ts[i]]);
      start = null;
    }
  }
  if (start != null) out.push([start, h.ts[h.ts.length - 1]]);
  return out;
}

export function HttpChart({ http, from, to }: { http: Http; from: number | null; to: number | null }) {
  const outages = useMemo(() => unreachableRanges(http), [http]);
  const stats = useMemo(() => ({ p50: quantile(http.ms, 0.5), p95: quantile(http.ms, 0.95), n: http.ts.length }), [http]);
  const option = useMemo(
    () =>
      timeLinesOption({
        ts: http.ts,
        lines: [{ id: "http", name: "Antwortzeit Weboberfläche", values: http.ms, slot: 0 }],
        unit: "ms",
        digits: 0,
        from,
        to,
        lo: 0,
        outages,
      }),
    [http, from, to, outages],
  );

  return (
    <Panel
      title="Antwortzeit der Weboberfläche"
      description="Wie schnell die Station ihre Startseite ausliefert – ein Maß für die Auslastung des Routers. Rote Bereiche: keine Antwort."
    >
      {http.ts.length === 0 ? (
        <EmptyState icon={Timer} title="Keine Messwerte im Zeitraum">
          Die Mess-Engine ruft die Startseite regelmäßig ab, auch ohne Langzeittest. Wähle einen längeren Zeitraum oder warte auf die nächste Abfrage.
        </EmptyState>
      ) : (
        <>
          <div className="mb-3 flex flex-wrap gap-2">
            <Chip>
              Median&nbsp;<Num>{fmtMs(stats.p50)}</Num>
            </Chip>
            <Chip>
              p95&nbsp;<Num>{fmtMs(stats.p95)}</Num>
            </Chip>
            <Chip tone={outages.length > 0 ? "warn" : "neutral"}>
              ohne Antwort:&nbsp;<Num>{outages.length}</Num>&nbsp;{outages.length === 1 ? "Phase" : "Phasen"}
            </Chip>
          </div>
          <EChart option={option} ariaLabel="Antwortzeit der Router-Weboberfläche im gewählten Zeitraum" height={220} />
        </>
      )}
    </Panel>
  );
}
