"use client";

import { useMemo } from "react";
import type { DiagnosisReport, Segment, TargetStats } from "@/lib/shared/types";
import {
  SegmentTopology,
  type TopologyLinkId,
  type TopologyLinkState,
  type TopologyNodeId,
  type TopologyNodeState,
} from "@/components/viz/SegmentTopology";
import { toUiHealth, worstKnownHealth, type Health } from "@/lib/health";
import { SEGMENTS, type SegmentId } from "@/lib/segments";
import { fmtDuration, fmtPct } from "@/lib/format";
import { cn } from "@/lib/cn";
import { statOf } from "./helpers";

type ByClass = NonNullable<DiagnosisReport["seconds"]>["byClass"];

/** Gestörte Sekunden je Design-Abschnitt (Klasse -> Abschnitt wie FAULT_CLASSES). */
const CLASS_TO_SEGMENT: Record<keyof ByClass, SegmentId | null> = {
  link: "pc",
  lan: "lan",
  access: "docsis",
  aftr: "provider",
  backbone: "provider",
  remote: "targets",
  unknown: null,
};

interface Attribution {
  seconds: Record<SegmentId, number>;
  unknown: number;
  bad: number;
}

function attribution(report: DiagnosisReport): Attribution {
  const seconds: Record<SegmentId, number> = { pc: 0, lan: 0, router: 0, docsis: 0, provider: 0, internet: 0, targets: 0 };
  let unknown = 0;
  const s = report.seconds;
  if (s) {
    for (const [cls, v] of Object.entries(s.byClass) as [keyof ByClass, number][]) {
      const seg = CLASS_TO_SEGMENT[cls];
      if (seg) seconds[seg] += v;
      else unknown += v;
    }
  }
  const bad = Object.values(seconds).reduce((a, b) => a + b, 0) + unknown;
  return { seconds, unknown, bad };
}

const share = (v: number, bad: number): number | null => (bad > 0 ? (v / bad) * 100 : null);

function healthOf(report: DiagnosisReport, seg: Segment): Health {
  return toUiHealth(report.segments.find((s) => s.segment === seg)?.status);
}

function lossDelta(end: TargetStats | null, prev: TargetStats | null): number | null {
  if (!end || end.lossPct == null) return null;
  return Math.max(0, end.lossPct - (prev?.lossPct ?? 0));
}

function topology(report: DiagnosisReport, stats: readonly TargetStats[] | null, att: Attribution) {
  const gw = statOf(stats, "gw");
  const isp6 = statOf(stats, "isp6");
  const aftr = statOf(stats, "aftr");
  const cf4 = statOf(stats, "cf4");
  const detail = (seg: SegmentId): string | undefined => {
    const p = share(att.seconds[seg], att.bad);
    return p != null && att.seconds[seg] > 0 ? `${fmtPct(p)} der Störungen` : undefined;
  };
  const nodes: Record<TopologyNodeId, TopologyNodeState> = {
    pc: { health: healthOf(report, "client"), sublabel: "Netzwerkadapter", detail: detail("pc") },
    router: { health: healthOf(report, "router"), sublabel: "Vodafone Station" },
    cmts: { health: healthOf(report, "docsis"), sublabel: "CMTS, 1. IPv6-Hop", detail: detail("docsis") },
    aftr: { health: healthOf(report, "aftr"), sublabel: "DS-Lite, nur IPv4", detail: detail("provider") },
    targets: {
      health: worstKnownHealth(healthOf(report, "game"), healthOf(report, "internet")),
      sublabel: "Internet, Spieleserver",
      detail: detail("targets"),
    },
  };
  const links: Record<TopologyLinkId, TopologyLinkState> = {
    lan: { health: healthOf(report, "lan"), rttMs: gw?.p50 ?? null, lossPct: gw?.lossPct ?? null },
    docsis: { health: healthOf(report, "docsis"), rttMs: isp6?.p50 ?? null, lossPct: lossDelta(isp6, gw) },
    backbone: { health: healthOf(report, "isp"), rttMs: aftr?.p50 ?? null, lossPct: lossDelta(aftr, isp6 ?? gw) },
    internet: { health: healthOf(report, "internet"), rttMs: cf4?.p50 ?? null, lossPct: lossDelta(cf4, aftr ?? isp6 ?? gw) },
  };
  return { nodes, links };
}

interface PathAttributionProps {
  report: DiagnosisReport;
  stats: readonly TargetStats[] | null;
}

/** Leitungsweg mit Zustand je Abschnitt (aus der Diagnose) und Zuordnung der gestörten Sekunden. */
export function PathAttribution({ report, stats }: PathAttributionProps) {
  const att = useMemo(() => attribution(report), [report]);
  const topo = useMemo(() => topology(report, stats, att), [report, stats, att]);
  const max = Math.max(0, ...Object.values(att.seconds), att.unknown);

  return (
    <div className="flex flex-col gap-6">
      <SegmentTopology
        id="np-diag-topo"
        nodes={topo.nodes}
        links={topo.links}
        caption="Zustand laut Diagnose. RTT: Median im Zeitraum bis zum Abschnittsende. Verlust: Zuwachs in diesem Abschnitt."
      />

      <div>
        <h3 className="text-sm font-medium text-fg">Wo die gestörten Sekunden entstehen</h3>
        <p className="mt-0.5 text-xs text-fg-3">
          Jede gestörte Sekunde wird dem ersten auffälligen Abschnitt zugeordnet. Der Router selbst und das Internet dahinter bekommen keine eigenen Sekunden – sie stecken
          in Heimnetz bzw. Vodafone-Netz.
        </p>
        {att.bad === 0 ? (
          <p className="mt-3 text-sm text-fg-2">{report.seconds ? "Keine gestörten Sekunden im Zeitraum." : "Im Zeitraum wurde nicht im Sekundentakt gemessen."}</p>
        ) : (
          <ol className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4 2xl:grid-cols-8">
            {SEGMENTS.map((seg) => {
              const v = att.seconds[seg.id];
              const p = share(v, att.bad) ?? 0;
              const isTop = v > 0 && v === max;
              return (
                <li
                  key={seg.id}
                  className={cn("flex min-w-0 flex-col gap-1.5 rounded-[10px] px-3 py-2.5 ring-1 ring-inset", isTop ? "bg-raised ring-line-strong" : "ring-line")}
                >
                  <span className="flex min-w-0 items-center gap-1.5 text-xs text-fg-2">
                    <seg.icon aria-hidden className="size-3.5 shrink-0 text-fg-3" strokeWidth={2} />
                    <span className="truncate">{seg.label}</span>
                  </span>
                  <span className="flex items-baseline justify-between gap-2">
                    <span className={cn("np-num text-lg font-semibold", v > 0 ? "text-fg" : "text-fg-4")}>{v > 0 ? fmtPct(p) : "–"}</span>
                    <span className="np-num text-2xs text-fg-3">{v > 0 ? fmtDuration(v) : ""}</span>
                  </span>
                  <span aria-hidden className="block h-1 overflow-hidden rounded-full bg-sunken">
                    <span className="block h-full rounded-full" style={{ width: `${p}%`, backgroundColor: seg.color }} />
                  </span>
                </li>
              );
            })}
            <li className={cn("flex min-w-0 flex-col gap-1.5 rounded-[10px] px-3 py-2.5 ring-1 ring-inset ring-line", att.unknown === max && att.unknown > 0 && "bg-raised")}>
              <span className="text-xs text-fg-2">Unklar</span>
              <span className="flex items-baseline justify-between gap-2">
                <span className={cn("np-num text-lg font-semibold", att.unknown > 0 ? "text-fg" : "text-fg-4")}>
                  {att.unknown > 0 ? fmtPct(share(att.unknown, att.bad)) : "–"}
                </span>
                <span className="np-num text-2xs text-fg-3">{att.unknown > 0 ? fmtDuration(att.unknown) : ""}</span>
              </span>
              <span aria-hidden className="block h-1 overflow-hidden rounded-full bg-sunken">
                <span className="block h-full rounded-full bg-chart-other" style={{ width: `${share(att.unknown, att.bad) ?? 0}%` }} />
              </span>
            </li>
          </ol>
        )}
      </div>
    </div>
  );
}
