"use client";

import type { DiagnosisReport } from "@/lib/shared/types";
import { FaultShareBar } from "@/components/viz/FaultShareBar";
import { FAULT_CLASSES } from "@/lib/segments";
import { fmtDuration, fmtInt, fmtPct } from "@/lib/format";
import { secondsToRollup } from "./helpers";

/** Wofür die Klassen stehen (MESSPLAN §2). */
const CLASS_HINT: Record<(typeof FAULT_CLASSES)[number]["id"], string> = {
  link: "Kabelverbindung weg, WLAN-Ausweichen oder bis 60 s nach dem Wiederaufbau",
  lan: "Router-Ping verloren oder Ping-Spitze",
  access: "Router gut, Kopfstation schlecht, IPv4 und IPv6 gestört",
  aftr: "nur IPv4 gestört, IPv6 sauber",
  backbone: "Kopfstation gut, IPv4 und IPv6 gestört",
  remote: "nur der Spieleserver gestört",
  unknown: "gestört, aber keine Regel passt eindeutig",
};

export function SecondsPanel({ report }: { report: DiagnosisReport }) {
  const s = report.seconds;
  const total = secondsToRollup(s);
  if (!s || !total) return null;
  const pctOf = (v: number) => (s.covered > 0 ? (v / s.covered) * 100 : null);

  return (
    <div className="flex flex-col gap-5">
      <FaultShareBar total={total} caption="Anteil je Abschnitt an allen gestörten Sekunden" />

      <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          { label: "Gemessen", value: fmtDuration(s.covered), hint: `${fmtInt(s.covered)} s` },
          { label: "Gestört (ES)", value: `${fmtInt(s.es)} s`, hint: `${fmtPct(pctOf(s.es))} der Messzeit` },
          { label: "Stark gestört (SES)", value: `${fmtInt(s.ses)} s`, hint: `${fmtPct(pctOf(s.ses))} der Messzeit` },
          { label: "Mit Eigenlast", value: `${fmtInt(s.selfLoad)} s`, hint: `${fmtPct(pctOf(s.selfLoad))} der Messzeit` },
        ].map((k) => (
          <div key={k.label} className="min-w-0 rounded-[10px] bg-sunken/60 px-3 py-2.5 ring-1 ring-inset ring-line">
            <dt className="np-label truncate">{k.label}</dt>
            <dd className="mt-1 flex flex-col">
              <span className="np-num truncate text-lg font-semibold text-fg">{k.value}</span>
              <span className="np-num truncate text-2xs text-fg-3">{k.hint}</span>
            </dd>
          </div>
        ))}
      </dl>

      <div className="relative overflow-x-auto rounded-[10px] ring-1 ring-line">
        <table className="w-full min-w-[520px] border-separate border-spacing-0 text-sm">
          <caption className="sr-only">Gestörte Sekunden je Klasse</caption>
          <thead>
            <tr className="text-xs text-fg-3 font-stretch-semi-condensed">
              <th scope="col" className="h-9 border-b border-line-strong bg-raised px-3 text-left font-medium">
                Klasse
              </th>
              <th scope="col" className="h-9 border-b border-line-strong bg-raised px-3 text-right font-medium">
                Sekunden
              </th>
              <th scope="col" className="h-9 border-b border-line-strong bg-raised px-3 text-right font-medium">
                Anteil gestört
              </th>
              <th scope="col" className="h-9 border-b border-line-strong bg-raised px-3 text-right font-medium">
                Anteil Messzeit
              </th>
            </tr>
          </thead>
          <tbody>
            {FAULT_CLASSES.map((c) => {
              const v = s.byClass[c.id];
              return (
                <tr key={c.id}>
                  <td className="border-b border-line px-3 py-2 align-top">
                    <span className="flex items-center gap-2 text-fg">
                      <span aria-hidden className="size-2.5 shrink-0 rounded-[3px]" style={{ backgroundColor: c.color }} />
                      {c.label}
                    </span>
                    <span className="mt-0.5 block pl-4.5 text-xs text-fg-3">{CLASS_HINT[c.id]}</span>
                  </td>
                  <td className="np-num border-b border-line px-3 py-2 text-right align-top text-fg">{fmtInt(v)}</td>
                  <td className="np-num border-b border-line px-3 py-2 text-right align-top text-fg">{s.bad > 0 ? fmtPct((v / s.bad) * 100) : "–"}</td>
                  <td className="np-num border-b border-line px-3 py-2 text-right align-top text-fg-2">{fmtPct(pctOf(v))}</td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row" className="px-3 py-2 text-left font-medium text-fg">
                Summe gestört
              </th>
              <td className="np-num px-3 py-2 text-right font-medium text-fg">{fmtInt(s.bad)}</td>
              <td className="np-num px-3 py-2 text-right text-fg">{s.bad > 0 ? fmtPct(100) : "–"}</td>
              <td className="np-num px-3 py-2 text-right text-fg-2">{fmtPct(pctOf(s.bad))}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      <p className="text-xs text-fg-3">
        ES = Sekunde mit Verlust oder Ping-Spitze auf den Internet-Referenzzielen. SES = mindestens die Hälfte der Internet-Pings verloren oder 200 ms und mehr. Die Summe
        der Klassen kann von ES abweichen, weil auch Störungen im Heimnetz und am Spieleserver zählen.
      </p>
    </div>
  );
}
