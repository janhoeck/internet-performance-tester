"use client";

import type { GamingScore } from "@/lib/shared/types";
import { HealthBadge } from "@/components/ui/HealthBadge";
import type { Health } from "@/lib/health";
import { HEALTH_COLOR } from "@/lib/health";
import { fmtNumber } from "@/lib/format";

const GRADE_HEALTH: Record<GamingScore["grade"], Health> = { A: "good", B: "good", C: "warn", D: "crit", F: "crit" };
const GRADE_TEXT: Record<GamingScore["grade"], string> = {
  A: "sehr gut spielbar",
  B: "gut spielbar",
  C: "spürbare Einschränkungen",
  D: "deutliche Lags",
  F: "kaum spielbar",
};

type PartKey = GamingScore["parts"][number]["key"];
const LIMIT_TEXT: Record<PartKey, string> = {
  p50: "die Grundlatenz (Median) ist zu hoch",
  jitter: "die Latenz schwankt stark von Ping zu Ping (Jitter)",
  tail: "einzelne Pings sind deutlich langsamer als üblich (Latenzspitzen)",
  loss: "es gehen Pakete verloren",
  outages: "die Verbindung fällt zeitweise ganz aus",
};

/** Gaming-Score: Punkte, Note, Faktoren mit verlorenen Punkten, begrenzender Faktor, MOS. */
export function GamingScorePanel({ score }: { score: GamingScore }) {
  const health = GRADE_HEALTH[score.grade];
  const limiting = score.limiting ? score.parts.find((p) => p.key === score.limiting) : undefined;
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
        <p className="flex items-baseline gap-1.5">
          <span className="np-num text-4xl font-semibold text-fg">{Math.round(score.score)}</span>
          <span className="np-num text-sm text-fg-3">von 100</span>
        </p>
        <div className="flex flex-col gap-1 pb-1">
          <span className="flex items-center gap-2">
            <span className="np-num grid size-8 place-items-center rounded-lg text-lg font-semibold ring-1 ring-inset ring-line-strong" style={{ color: HEALTH_COLOR[health] }}>
              {score.grade}
            </span>
            <HealthBadge status={health} size="sm" />
          </span>
          <span className="text-xs text-fg-3">Note {score.grade}: {GRADE_TEXT[score.grade]}</span>
        </div>
        {score.mos != null && (
          <div className="ml-auto pb-1 text-right">
            <p className="np-label">MOS (geschätzt)</p>
            <p className="np-num text-lg font-semibold text-fg">
              {fmtNumber(score.mos, 2)}
              <span className="text-sm font-normal text-fg-3"> von 4,5</span>
            </p>
          </div>
        )}
      </div>

      <p className="text-sm text-fg-2">
        {limiting
          ? `Begrenzender Faktor: ${limiting.label} (${limiting.value}) – ${LIMIT_TEXT[limiting.key]}. Das kostet ${fmtNumber(limiting.pointsLost, 0)} Punkte.`
          : "Kein Faktor kostet Punkte – die Verbindung ist für Spiele ideal."}
      </p>

      <ul className="flex flex-col gap-3">
        {score.parts.map((p) => {
          const pct = Math.max(0, Math.min(1, p.factor)) * 100;
          const isLimit = p.key === score.limiting;
          return (
            <li key={p.key} className="flex flex-col gap-1">
              <div className="flex items-baseline justify-between gap-3 text-sm">
                <span className={isLimit ? "font-medium text-fg" : "text-fg-2"}>{p.label}</span>
                <span className="flex items-baseline gap-3">
                  <span className="np-num text-fg">{p.value}</span>
                  <span className="np-num w-24 text-right text-xs text-fg-3">{p.pointsLost > 0.05 ? `−${fmtNumber(p.pointsLost, 1)} Punkte` : "keine Abzüge"}</span>
                </span>
              </div>
              <span
                role="img"
                aria-label={`${p.label}: Faktor ${fmtNumber(p.factor, 2)}`}
                className="block h-2 overflow-hidden rounded-full bg-sunken ring-1 ring-inset ring-line"
              >
                <span className="block h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: isLimit ? HEALTH_COLOR[health] : "var(--np-fiber)", opacity: isLimit ? 1 : 0.7 }} />
              </span>
            </li>
          );
        })}
      </ul>
      <p className="text-xs text-fg-3">
        Score = 100 × Produkt der Faktoren (je 0 bis 1). Volle Balken bedeuten keinen Abzug. MOS ist eine Schätzung der Gesprächsqualität nach dem E-Modell (1 bis 4,5).
      </p>
    </div>
  );
}
