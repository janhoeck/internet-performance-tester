"use client";

import type { ReactNode } from "react";
import { CircleCheck, Lightbulb } from "lucide-react";
import type { AdapterInfo } from "@/lib/shared/types";
import type { ClientResponse } from "@/lib/shared/api-types";
import { HealthBadge } from "@/components/ui/HealthBadge";
import { Panel } from "@/components/ui/Panel";
import { cn } from "@/lib/cn";
import { fmtDate, fmtInt, fmtNumber, fmtPctValue, NBSP } from "@/lib/format";
import { useNow } from "@/lib/use-now";
import { Note, Num } from "./bits";
import { isIntelI225, isNetAdapterDriver, type AdvancedProp, type LinkDropRow, gigabitStreak } from "./pc-model";

interface Step {
  id: string;
  title: string;
  body: ReactNode;
  done?: boolean;
  optional?: boolean;
}

function Progress({ label, value, goal, unit }: { label: string; value: number; goal: number; unit: string }) {
  const pct = Math.max(0, Math.min(100, (value / goal) * 100));
  const reached = value >= goal;
  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-2 text-sm">
        <span className="text-fg-2">{label}</span>
        <Num className={reached ? "text-good" : "text-fg"}>
          {fmtNumber(value, unit === "Tage" ? 1 : 0)} von {goal}
          {unit ? `${NBSP}${unit}` : ""}
        </Num>
      </div>
      <div
        className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-raised"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={goal}
        aria-valuenow={Math.min(value, goal)}
      >
        <div className={cn("h-full rounded-full", reached ? "bg-good" : "bg-fiber-strong")} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function Recommendations({
  summary,
  ethernet,
  drops,
  advanced,
}: {
  summary: ClientResponse["linkSummary"];
  ethernet: AdapterInfo | null;
  drops: readonly LinkDropRow[];
  advanced: readonly AdvancedProp[];
}) {
  const now = useNow(60_000);
  const problem = summary.runtimeDrops7d > 0 || (summary.relinkBelow1gPct ?? 0) >= 20;
  const netAdapter = isNetAdapterDriver(ethernet);
  const intel = isIntelI225(ethernet);
  const ss = advanced.find((p) => p.keyword === "*SelectiveSuspend" || /selective suspend$/i.test(p.name)) ?? null;
  const ssOn = ss != null && (ss.registryValue === "1" || /^(aktiviert|enabled|1)$/i.test(ss.value.trim()));
  const { streak } = gigabitStreak(drops);
  const daysSince = summary.lastDropTs == null ? 7 : now != null ? Math.max(0, (now - summary.lastDropTs) / 86_400_000) : null;

  const steps: Step[] = [
    {
      id: "cable",
      title: "Kabel tauschen – direkt PC–Station",
      body: (
        <>
          Neues, kurzes Cat-6-Patchkabel direkt zwischen PC und Vodafone Station – ohne Wanddose, Kupplung oder Switch. Stecker müssen hörbar einrasten; das
          Kabel nicht knicken oder einklemmen (Stuhlrollen, Tür).
        </>
      ),
    },
    {
      id: "port",
      title: "Anderen LAN-Port der Station nutzen",
      body: <>Die Station hat vier Gigabit-Ports. Wechsle den Port und notiere, welchen du nutzt – so lässt sich ein defekter Port erkennen.</>,
    },
    {
      id: "force",
      title: "Gegenprobe: 1 Gbit/s fest einstellen",
      optional: true,
      body: (
        <>
          Gerätemanager, Intel I225-V, Erweitert, „Geschwindigkeit und Duplex“ kurz auf „1,0 Gbit/s Vollduplex“. Kommt dann keine stabile Verbindung zustande,
          schafft Kabel oder Port kein Gigabit. Danach wieder auf „Automatische Aushandlung“ stellen.
        </>
      ),
    },
    {
      id: "driver",
      title: netAdapter ? "Treiber: NetAdapter-Treiber ist bereits installiert" : "Treiber aktualisieren – erst nach Kabel und Port",
      done: netAdapter,
      body: netAdapter ? (
        <>
          Installiert ist <Num>{ethernet?.driverVersion ?? "2.1.x"}</Num>
          {ethernet?.driverDate ? <> vom {Number.isFinite(Date.parse(ethernet.driverDate)) ? fmtDate(Date.parse(ethernet.driverDate)) : ethernet.driverDate}</> : null}{" "}
          (Dienst <Num>{ethernet?.serviceName ?? "e2fnexpress"}</Num>) – der Windows-11-Treiberzweig e2fn 2.1.x. Dieser Schritt ist erledigt. Bleiben die Abbrüche,
          liegt es eher an Kabel, Port oder Router.
        </>
      ) : (
        <>
          {intel ? "Für den Intel I225-V" : "Für Intel-Adapter"} gibt es unter Windows 11 den NetAdapter-Treiber (e2fn 2.1.x, Intel-Paket „Network Adapter Driver for
          Windows 11“). Installiert ist <Num>{ethernet?.driverVersion ?? "unbekannt"}</Num>. Erst nach dem Kabeltest wechseln, damit die Ursache eindeutig bleibt.
        </>
      ),
    },
  ];
  if (ss) {
    steps.push({
      id: "ss",
      title: ssOn ? "Selective Suspend für den Test ausschalten" : "Selective Suspend ist aus",
      done: !ssOn,
      body: ssOn ? (
        <>Gerätemanager, Intel I225-V, Erweitert, „Selective Suspend“: Deaktiviert. Die Energiesparfunktion ist eine bekannte, wenn auch seltene Ursache.</>
      ) : (
        <>Die Energiesparfunktion des Adapters ist ausgeschaltet – passt.</>
      ),
    });
  }

  return (
    <Panel
      title={
        <span className="inline-flex items-center gap-2">
          <Lightbulb aria-hidden className="size-5 text-fg-3" strokeWidth={1.75} />
          Empfehlungen
        </span>
      }
      description="Immer nur eine Änderung zur Zeit – und danach einen neuen Langzeittest, damit klar ist, was geholfen hat."
      actions={<HealthBadge status={problem ? "warn" : "good"} label={problem ? "Handlungsbedarf" : "Kein Handlungsbedarf"} />}
      frame
    >
      {problem ? (
        <Note tone="warn" title="Die Netzwerkverbindung am PC bricht ab">
          <Num>{fmtInt(summary.runtimeDrops7d)}</Num> echte Abbrüche im Betrieb in 7 Tagen
          {summary.relinkBelow1gPct != null && (
            <>
              , <Num>{fmtPctValue(summary.relinkBelow1gPct)}{NBSP}%</Num> der Neuaufbauten nur unter 1 Gbit/s
            </>
          )}
          . Das passt zu Kabel, Stecker oder Port – deshalb diese Reihenfolge:
        </Note>
      ) : (
        <Note tone="info" title="Keine echten Abbrüche in den letzten 7 Tagen">
          Der Ethernet-Link läuft stabil. Die Schritte unten helfen, falls wieder Abbrüche auftreten.
        </Note>
      )}

      <ol className="mt-4 flex flex-col gap-3">
        {steps.map((s, i) => (
          <li key={s.id} className="flex gap-3">
            {s.done ? (
              <CircleCheck aria-hidden className="mt-0.5 size-6 shrink-0 text-good" strokeWidth={2} />
            ) : (
              <span aria-hidden className="np-num mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-raised text-xs text-fg-2 ring-1 ring-inset ring-line-strong">
                {i + 1}
              </span>
            )}
            <div className="min-w-0">
              <p className="text-sm font-medium text-fg">
                {s.title}
                {s.optional && <span className="ml-2 text-xs font-normal text-fg-3">optional</span>}
                {s.done && <span className="sr-only"> (erledigt)</span>}
              </p>
              <p className="mt-0.5 text-sm text-fg-3">{s.body}</p>
            </div>
          </li>
        ))}
      </ol>

      <div className="mt-5 rounded-[10px] bg-raised/50 p-4 ring-1 ring-inset ring-line">
        <p className="text-sm font-medium text-fg">Nachweis, dass es behoben ist</p>
        <p className="mt-0.5 text-xs text-fg-3">Kabel/Port gelten als repariert, wenn die nächsten 10 Neuaufbauten mit 1 Gbit/s kommen und 7 Tage kein echter Abbruch auftritt.</p>
        <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Progress label="Neuaufbauten mit 1 Gbit/s in Folge (im Zeitraum)" value={streak} goal={10} unit="" />
          <Progress label="Tage ohne Abbruch im Betrieb" value={daysSince ?? 0} goal={7} unit="Tage" />
        </div>
      </div>
    </Panel>
  );
}
