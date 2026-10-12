import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/PageHeader";
import { PlanStatus } from "./_components/PlanStatus";
import {
  AnalysisSection,
  DocsisSection,
  GoalSection,
  HypothesesSection,
  MeasurementsSection,
  PrincipleSection,
  ProcedureSection,
  RetentionPlanSection,
  RulesSection,
} from "./_components/PlanSections";
import { TOC } from "./_content/plan";

export const metadata: Metadata = { title: "Messplan" };

export default function MessplanPage() {
  return (
    <>
      <PageHeader
        title="Messplan"
        description="Was Netzpuls misst, wie oft und warum – und woran die Diagnose die Ursache deiner Lags erkennt."
      />
      <div className="grid gap-6 lg:grid-cols-[12.5rem_minmax(0,1fr)]">
        <nav aria-label="Inhalt des Messplans" className="hidden lg:block">
          <ul className="sticky top-20 flex flex-col gap-0.5">
            {TOC.map((t) => (
              <li key={t.id}>
                <a
                  href={`#${t.id}`}
                  className="flex h-9 items-center rounded-lg px-3 text-sm text-fg-2 hover:bg-raised hover:text-fg focus-visible:outline-2 focus-visible:outline-fiber"
                >
                  {t.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <div className="flex min-w-0 flex-col gap-6">
          <div id="status" className="scroll-mt-20">
            <PlanStatus />
          </div>
          <GoalSection />
          <AnalysisSection />
          <PrincipleSection />
          <MeasurementsSection />
          <DocsisSection />
          <RulesSection />
          <RetentionPlanSection />
          <ProcedureSection />
          <HypothesesSection />
        </div>
      </div>
    </>
  );
}
