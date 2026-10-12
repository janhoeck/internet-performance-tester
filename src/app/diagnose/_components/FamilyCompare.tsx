"use client";

import type { TargetStats } from "@/lib/shared/types";
import { HealthBadge } from "@/components/ui/HealthBadge";
import type { Health } from "@/lib/health";
import { fmtLossPct, fmtMs, NBSP } from "@/lib/format";
import { statOf } from "./helpers";

const PAIRS = [
  { name: "Cloudflare", v4: "cf4", v6: "cf6", v4Label: "1.1.1.1", v6Label: "2606:4700:4700::1111" },
  { name: "Google", v4: "g4", v6: "g6", v4Label: "8.8.8.8", v6Label: "2001:4860:4860::8888" },
] as const;

/** Grenzen wie Regel R11 (vereinfacht auf den ganzen Zeitraum). */
const P95_DIFF_MS = 30;
const LOSS_DIFF_PP = 1;

function signed(v: number | null, fmt: (x: number) => string): string {
  if (v == null || !Number.isFinite(v)) return "–";
  if (Math.abs(v) < 0.05) return fmt(0);
  return `${v > 0 ? "+" : "−"}${fmt(Math.abs(v))}`;
}

function verdict(v4: TargetStats | null, v6: TargetStats | null): { health: Health; text: string } {
  if (!v4 || !v6) return { health: "unknown", text: "Zu wenige Messwerte für einen Vergleich." };
  const dP95 = v4.p95 != null && v6.p95 != null ? v4.p95 - v6.p95 : null;
  const dLoss = v4.lossPct != null && v6.lossPct != null ? v4.lossPct - v6.lossPct : null;
  if ((dP95 != null && dP95 >= P95_DIFF_MS) || (dLoss != null && dLoss >= LOSS_DIFF_PP)) {
    return { health: "crit", text: "IPv4 deutlich schlechter als IPv6 – Hinweis auf das DS-Lite-Gateway." };
  }
  if ((dP95 != null && dP95 >= P95_DIFF_MS / 2) || (dLoss != null && dLoss >= LOSS_DIFF_PP / 2)) {
    return { health: "warn", text: "IPv4 etwas schlechter als IPv6." };
  }
  return { health: "good", text: "IPv4 und IPv6 verhalten sich gleich." };
}

/** „IPv4 gegen IPv6“: dieselben Anbieter über beide Protokolle (isoliert DS-Lite/AFTR). */
export function FamilyCompare({ stats }: { stats: readonly TargetStats[] }) {
  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {PAIRS.map((p) => {
          const v4 = statOf(stats, p.v4);
          const v6 = statOf(stats, p.v6);
          const vd = verdict(v4, v6);
          const rows = [
            { label: "Median (p50)", a: fmtMs(v4?.p50), b: fmtMs(v6?.p50), d: signed(v4?.p50 != null && v6?.p50 != null ? v4.p50 - v6.p50 : null, (x) => fmtMs(x)) },
            { label: "p95", a: fmtMs(v4?.p95), b: fmtMs(v6?.p95), d: signed(v4?.p95 != null && v6?.p95 != null ? v4.p95 - v6.p95 : null, (x) => fmtMs(x)) },
            {
              label: "Paketverlust",
              a: fmtLossPct(v4?.lossPct),
              b: fmtLossPct(v6?.lossPct),
              d: signed(v4?.lossPct != null && v6?.lossPct != null ? v4.lossPct - v6.lossPct : null, (x) => `${fmtLossPct(x).replace(`${NBSP}%`, "")}${NBSP}%-Pkt.`),
            },
          ];
          return (
            <section key={p.name} className="flex min-w-0 flex-col gap-3 rounded-[10px] p-4 ring-1 ring-inset ring-line">
              <header className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-medium text-fg">{p.name}</h3>
                <HealthBadge status={vd.health} size="sm" />
              </header>
              <div className="relative overflow-x-auto">
                <table className="w-full min-w-[300px] text-sm">
                  <caption className="sr-only">{`${p.name}: IPv4 gegen IPv6`}</caption>
                  <thead>
                    <tr className="text-xs text-fg-3 font-stretch-semi-condensed">
                      <th scope="col" className="pb-1.5 text-left font-medium">
                        Kennzahl
                      </th>
                      <th scope="col" className="pb-1.5 text-right font-medium">
                        IPv4
                        <span className="np-num block text-2xs font-normal text-fg-4">{p.v4Label}</span>
                      </th>
                      <th scope="col" className="pb-1.5 text-right font-medium">
                        IPv6
                        <span className="np-num block truncate text-2xs font-normal text-fg-4">{p.v6Label}</span>
                      </th>
                      <th scope="col" className="pb-1.5 text-right font-medium">
                        IPv4 − IPv6
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.label} className="border-t border-line">
                        <th scope="row" className="py-1.5 text-left font-normal text-fg-3">
                          {r.label}
                        </th>
                        <td className="np-num py-1.5 text-right text-fg">{r.a}</td>
                        <td className="np-num py-1.5 text-right text-fg">{r.b}</td>
                        <td className="np-num py-1.5 text-right text-fg-2">{r.d}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-xs text-fg-3">{vd.text}</p>
            </section>
          );
        })}
      </div>
      <div className="rounded-[10px] bg-sunken/60 p-4 text-sm text-fg-2 ring-1 ring-inset ring-line">
        <p className="font-medium text-fg">Warum dieser Vergleich?</p>
        <p className="mt-1">
          Dein Anschluss nutzt DS-Lite: Du hast keine eigene öffentliche IPv4-Adresse. Der Router verpackt jeden IPv4-Verkehr in IPv6 und schickt ihn zum DS-Lite-Gateway
          (AFTR) von Vodafone, das ihn auspackt und über ein Carrier-NAT ins Internet leitet. IPv6 läuft dagegen direkt. Sind dieselben Ziele über IPv4 deutlich langsamer
          oder verlustreicher als über IPv6, liegt das Problem sehr wahrscheinlich am AFTR – nicht an deiner Leitung. Die meisten Spiele nutzen IPv4 und damit diesen Weg.
        </p>
        <p className="mt-2 text-xs text-fg-3">
          Auffällig ab {P95_DIFF_MS}
          {NBSP}ms höherem p95 oder {LOSS_DIFF_PP}
          {NBSP}Prozentpunkt mehr Verlust auf IPv4. Die Regel R11 prüft das genauer in 15-Minuten-Fenstern und bei beiden Anbietern.
        </p>
      </div>
    </div>
  );
}
