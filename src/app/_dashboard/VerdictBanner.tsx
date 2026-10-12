"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { ChevronRight, Info } from "lucide-react";
import type { DiagnosisResponse } from "@/lib/shared/api-types";
import type { Confidence } from "@/lib/shared/types";
import type { UseApiResult } from "@/lib/client/use-api";
import { CONFIDENCE_LABEL } from "@/lib/client/adapters";
import { cn } from "@/lib/cn";
import { fmtPct, fmtShortTime } from "@/lib/format";
import { HEALTH_COLOR, HEALTH_ICON, HEALTH_SOFT, HEALTH_TEXT, severityToUi, type Severity } from "@/lib/health";
import { HealthBadge } from "@/components/ui/HealthBadge";
import { ErrorState, Refetching, Skeleton } from "@/components/ui/States";

/** Unter diesem Anteil gemessener Zeit (24 h) gilt die Aussage als dünn belegt. */
const LOW_COVERAGE_PCT = 50;

const CONFIDENCE_SENTENCE = /\s*Sicherheit: (?:niedrig|mittel|hoch)\./;
const PROVISIONAL_SENTENCE = /\s*Achtung: erst [^.]*?vorläufig\./;

interface VerdictView {
  severity: Severity;
  title: string;
  text: string;
  confidence: Confidence | null;
  provisional: boolean;
  coveragePct: number;
  notes: string[];
}

export function toVerdictView(d: DiagnosisResponse): VerdictView {
  const v = d.verdict;
  // Sicherheit der Hauptursache = Befund mit dem höchsten Rang im Hauptabschnitt
  const primary = v.primarySegment
    ? [...d.findings].filter((f) => f.segment === v.primarySegment && f.severity !== "info").sort((a, b) => b.score - a.score)[0]
    : undefined;
  const hasProblem = d.findings.some((f) => f.severity !== "info");
  const allClear = v.severity === "info" && v.primarySegment == null && !hasProblem && /^Keine Auffälligkeiten/.test(v.title);
  const provisional = /vorläufig/i.test(v.title) || PROVISIONAL_SENTENCE.test(v.text) || d.dataQuality.coveragePct < LOW_COVERAGE_PCT;
  return {
    severity: allClear ? "good" : severityToUi(v.severity),
    title: v.title,
    text: v.text.replace(CONFIDENCE_SENTENCE, "").replace(PROVISIONAL_SENTENCE, "").trim(),
    confidence: primary?.confidence ?? null,
    provisional,
    coveragePct: d.dataQuality.coveragePct,
    notes: d.dataQuality.notes,
  };
}

function Chip({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-2xs font-medium ring-1 ring-inset", className)}>{children}</span>;
}

function VerdictSkeleton() {
  return (
    <div className="np-panel flex flex-col gap-3 p-5" aria-busy="true" aria-label="Diagnose wird berechnet">
      <Skeleton className="h-3 w-32" />
      <Skeleton className="h-6 w-3/4" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-2/3" />
    </div>
  );
}

/** Urteil der Diagnose (letzte 24 h) als Banner über dem Dashboard. */
export function VerdictBanner({ result }: { result: UseApiResult<DiagnosisResponse> }) {
  const { data, error } = result;
  if (data == null) {
    if (error) {
      return (
        <div className="np-panel">
          <ErrorState title="Diagnose nicht verfügbar" message={error.message} onRetry={result.reload} className="py-6" />
        </div>
      );
    }
    return <VerdictSkeleton />;
  }
  const v = toVerdictView(data);
  const Icon = HEALTH_ICON[v.severity];
  return (
    <Refetching active={result.stale}>
      <section aria-labelledby="np-verdict-title" className="np-panel relative overflow-hidden p-5">
        <span aria-hidden className="absolute inset-y-4 left-0 w-1 rounded-r-full" style={{ backgroundColor: HEALTH_COLOR[v.severity] }} />
        <div className="flex flex-col gap-4 md:flex-row md:items-start">
          <span className={cn("grid size-11 shrink-0 place-items-center rounded-full ring-1 ring-inset", HEALTH_SOFT[v.severity], HEALTH_TEXT[v.severity])}>
            <Icon aria-hidden className="size-5" strokeWidth={2} />
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="np-label font-sans">Diagnose, letzte 24 Stunden</span>
              <HealthBadge status={v.severity} size="sm" />
              {v.confidence && <Chip className="bg-raised text-fg-2 ring-line">Sicherheit: {CONFIDENCE_LABEL[v.confidence]}</Chip>}
              {v.provisional && <Chip className="bg-warn/12 text-warn ring-warn/30">vorläufig</Chip>}
            </div>
            <h2 id="np-verdict-title" className="font-display text-xl font-medium text-fg text-balance">
              {v.title}
            </h2>
            {v.text && <p className="max-w-4xl text-sm text-fg-2">{v.text}</p>}
            {v.provisional && (
              <p className="flex items-start gap-2 text-xs text-fg-3">
                <Info aria-hidden className="mt-0.5 size-3.5 shrink-0 text-info" strokeWidth={2.25} />
                <span>
                  Gemessen wurde bisher <span className="np-num text-fg-2">{fmtPct(v.coveragePct)}</span> der letzten 24 Stunden. Für eine sichere Aussage
                  mindestens 24 Stunden messen, besser 72 Stunden inklusive zweier Abende.
                </span>
              </p>
            )}
          </div>
          <div className="flex shrink-0 flex-col items-start gap-2 md:items-end">
            <Link
              href="/diagnose"
              className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-raised px-3.5 text-sm font-medium text-fg ring-1 ring-inset ring-line-strong hover:bg-overlay hover:ring-line-control focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fiber"
            >
              Zur Diagnose
              <ChevronRight aria-hidden className="size-4" strokeWidth={2} />
            </Link>
            <span className="text-2xs text-fg-3">
              Stand <span className="np-num">{fmtShortTime(data.generatedAt)}</span> Uhr
            </span>
          </div>
        </div>
      </section>
    </Refetching>
  );
}
