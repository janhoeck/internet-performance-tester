"use client";

import Link from "next/link";
import { ChevronRight, Stethoscope } from "lucide-react";
import type { DiagnosisResponse } from "@/lib/shared/api-types";
import { toFindingView } from "@/lib/client/adapters";
import type { UseApiResult } from "@/lib/client/use-api";
import { DataState, KpiSkeleton } from "@/components/ui/States";
import { FindingCard } from "@/components/viz/FindingCard";

const TOP_N = 3;

function topFindings(d: DiagnosisResponse) {
  return [...d.findings].sort((a, b) => b.score - a.score).slice(0, TOP_N);
}

export function FindingsPanel({ result }: { result: UseApiResult<DiagnosisResponse> }) {
  return (
    <section aria-labelledby="np-findings-title" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-1">
        <div>
          <h2 id="np-findings-title" className="text-xl font-medium text-fg">
            Wichtigste Befunde
          </h2>
          <p className="mt-0.5 text-sm text-fg-3">Die drei wahrscheinlichsten Ursachen der letzten 24 Stunden, mit Belegen und Empfehlung.</p>
        </div>
        <Link href="/diagnose" className="inline-flex items-center gap-1 text-sm text-fiber underline-offset-4 hover:underline">
          Alle Befunde in der Diagnose
          <ChevronRight aria-hidden className="size-4" strokeWidth={2} />
        </Link>
      </div>
      <DataState
        result={result}
        isEmpty={(d) => d.findings.length === 0}
        emptyIcon={Stethoscope}
        emptyTitle="Noch keine Befunde"
        emptyText="Noch zu wenige Messwerte für einen Befund – nach etwa 24 Stunden Messung erscheint hier die erste Auswertung."
        height={200}
        skeleton={
          <div className="grid gap-4 lg:grid-cols-3">
            <KpiSkeleton />
            <KpiSkeleton />
            <KpiSkeleton />
          </div>
        }
      >
        {(d) => (
          <div className="grid items-start gap-4 lg:grid-cols-3">
            {topFindings(d).map((f) => (
              <FindingCard key={f.id} finding={toFindingView(f)} />
            ))}
          </div>
        )}
      </DataState>
    </section>
  );
}
