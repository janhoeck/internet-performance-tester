"use client";

import type { Finding } from "@/lib/shared/types";
import { HealthBadge } from "@/components/ui/HealthBadge";
import { severityToUi } from "@/lib/health";
import { cn } from "@/lib/cn";
import { insufficientNote, RULE_CHECKS, type RuleDataContext } from "./rules";

interface RuleChecksProps {
  findings: readonly Finding[];
  ctx: RuleDataContext;
}

/** „So wurde geprüft“: alle Regeln R01–R20 mit Ergebnis und Hinweis bei zu wenigen Daten. */
export function RuleChecks({ findings, ctx }: RuleChecksProps) {
  const byId = new Map(findings.map((f) => [f.id, f]));
  const triggered = RULE_CHECKS.filter((r) => byId.has(r.id)).length;
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-fg-2">
        <span className="np-num text-fg">{triggered}</span> von <span className="np-num text-fg">{RULE_CHECKS.length}</span> Regeln haben einen Befund ergeben. Jede Regel
        wertet die Messwerte des gewählten Zeitraums aus; ohne Befund war nichts auffällig – oder es fehlten die nötigen Daten.
      </p>
      <ol className="divide-y divide-line rounded-[10px] ring-1 ring-inset ring-line">
        {RULE_CHECKS.map((r) => {
          const f = byId.get(r.id);
          const note = insufficientNote(r, ctx);
          return (
            <li key={r.code} className="grid grid-cols-[3rem_1fr] gap-x-3 gap-y-1 px-3 py-2.5 sm:grid-cols-[3rem_1fr_auto]">
              <span className="np-num pt-0.5 text-xs text-fg-3">{r.code}</span>
              <div className="min-w-0">
                <p className={cn("text-sm", f ? "font-medium text-fg" : "text-fg-2")}>{f ? f.title : r.name}</p>
                <p className="mt-0.5 text-xs text-fg-3">{r.trigger}</p>
                {note && <p className="mt-1 text-xs text-warn">Eingeschränkt prüfbar: {note}.</p>}
              </div>
              <div className="col-start-2 flex items-start gap-2 sm:col-start-3 sm:justify-end">
                {f ? (
                  <>
                    <HealthBadge status={severityToUi(f.severity)} size="sm" />
                    <span className="pt-0.5 text-xs text-fg-2">ausgelöst</span>
                  </>
                ) : note ? (
                  <>
                    <HealthBadge status="unknown" size="sm" />
                    <span className="pt-0.5 text-xs text-fg-3">nicht ausgelöst</span>
                  </>
                ) : (
                  <>
                    <HealthBadge status="good" size="sm" />
                    <span className="pt-0.5 text-xs text-fg-3">nicht ausgelöst</span>
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
