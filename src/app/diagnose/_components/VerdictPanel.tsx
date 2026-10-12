"use client";

import { Hourglass, PlugZap } from "lucide-react";
import type { DiagnosisReport } from "@/lib/shared/types";
import { Panel } from "@/components/ui/Panel";
import { HealthBadge } from "@/components/ui/HealthBadge";
import { HEALTH_COLOR, severityToUi } from "@/lib/health";
import { SEGMENT_BY_ID, SHARED_SEGMENT_LABEL, segmentFromShared } from "@/lib/segments";
import { fmtDateTime, fmtDuration, fmtPct } from "@/lib/format";
import { confidenceText, isProvisional, primaryFinding } from "./helpers";

interface VerdictPanelProps {
  report: DiagnosisReport;
  engineOnline: boolean;
  rangeLabel: string;
}

/** „Wahrscheinlichste Ursache“: Urteil der Diagnose mit Abschnitt, Sicherheit und Vorläufig-Hinweis. */
export function VerdictPanel({ report, engineOnline, rangeLabel }: VerdictPanelProps) {
  const v = report.verdict;
  const sev = severityToUi(v.severity);
  const primary = primaryFinding(report);
  const confidence = v.primarySegment ? confidenceText(primary) : null;
  // ohne jede Messung ist das Urteil nicht „vorläufig“, sondern leer (Text der API erklärt es)
  const provisional = isProvisional(report) && (report.dataQuality.samples > 0 || (report.seconds?.covered ?? 0) > 0);
  const segId = segmentFromShared(v.primarySegment);
  const seg = segId ? SEGMENT_BY_ID[segId] : undefined;
  const covered = report.seconds?.covered ?? 0;

  return (
    <Panel frame title="Wahrscheinlichste Ursache" description={`Zeitraum: ${rangeLabel}`} className="overflow-hidden">
      <span aria-hidden className="absolute inset-y-0 left-0 w-0.5" style={{ backgroundColor: HEALTH_COLOR[sev] }} />
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <HealthBadge status={sev} />
          {seg && v.primarySegment && (
            <span className="inline-flex h-6 items-center gap-1.5 rounded-full px-2.5 text-xs text-fg-2 ring-1 ring-inset ring-line">
              <seg.icon aria-hidden className="size-3.5 text-fg-3" strokeWidth={2} />
              {SHARED_SEGMENT_LABEL[v.primarySegment]}
            </span>
          )}
          {confidence && (
            <span className="inline-flex h-6 items-center rounded-full px-2.5 text-xs text-fg-2 ring-1 ring-inset ring-line">
              Sicherheit: {confidence}
            </span>
          )}
          {provisional && (
            <span className="inline-flex h-6 items-center gap-1.5 rounded-full bg-warn/12 px-2.5 text-xs font-medium text-warn ring-1 ring-inset ring-warn/30">
              <Hourglass aria-hidden className="size-3.5" strokeWidth={2.25} />
              vorläufig
            </span>
          )}
        </div>

        <div>
          <h3 className="font-display text-xl font-semibold text-fg">{v.title}</h3>
          <p className="mt-2 max-w-3xl text-base text-fg-2">{v.text}</p>
        </div>

        {provisional && (
          <p className="max-w-3xl text-sm text-fg-3">
            Vorläufig heißt: Es liegen noch zu wenige Messdaten für eine sichere Aussage vor. Lass den Langzeittest mindestens 24 Stunden laufen, besser 72 Stunden
            inklusive zweier Abende – die Diagnose wird automatisch genauer.
          </p>
        )}

        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 border-t border-line pt-4 text-sm sm:grid-cols-4">
          <div className="min-w-0">
            <dt className="np-label">Gemessene Zeit</dt>
            <dd className="np-num mt-0.5 text-fg">{covered > 0 ? fmtDuration(covered) : "–"}</dd>
          </div>
          <div className="min-w-0">
            <dt className="np-label">Messabdeckung</dt>
            <dd className="np-num mt-0.5 text-fg">{fmtPct(report.dataQuality.coveragePct)}</dd>
          </div>
          <div className="min-w-0">
            <dt className="np-label">Befunde</dt>
            <dd className="np-num mt-0.5 text-fg">{report.findings.length}</dd>
          </div>
          <div className="min-w-0">
            <dt className="np-label">Ausgewertet am</dt>
            <dd className="np-num mt-0.5 text-fg">{fmtDateTime(report.generatedAt)}</dd>
          </div>
        </dl>

        {!engineOnline && (
          <p className="flex items-start gap-2 text-xs text-fg-3">
            <PlugZap aria-hidden className="size-3.5 shrink-0 text-warn" strokeWidth={2.25} />
            <span>Mess-Engine nicht erreichbar – ausgewertet werden die gespeicherten Messwerte.</span>
          </p>
        )}
      </div>
    </Panel>
  );
}
