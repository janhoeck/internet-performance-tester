"use client";

import type { ReactNode } from "react";
import { CalendarClock, Gamepad2, Moon, Network, PlugZap, Timer, Unplug } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { HealthBadge } from "@/components/ui/HealthBadge";
import { Panel } from "@/components/ui/Panel";
import { cn } from "@/lib/cn";
import { fmtDuration, fmtMbit, fmtRelative, fmtShortTime, NBSP } from "@/lib/format";
import type { AppConfig } from "@/lib/shared/config";
import type { ClientState, EngineStatus, ModuleState } from "@/lib/shared/types";
import { berlinHour, inQuietHours } from "./speed-utils";

interface SchedulePanelProps {
  schedules: AppConfig["schedules"] | null;
  engine: EngineStatus | null;
  online: boolean;
  client: ClientState | null;
  lastTestTs: number | null;
  now: number | null;
}

interface Rule {
  id: string;
  icon: LucideIcon;
  title: string;
  text: ReactNode;
  active: boolean | null;
}

function everyText(min: number): string {
  if (min % 60 === 0) return min === 60 ? "jede Stunde" : `alle ${min / 60} Stunden`;
  return `alle ${min} Minuten`;
}

/** Nächster geplanter Test + warum geplante Tests übersprungen werden (Regeln der Engine, speed-schedule.ts). */
export function SchedulePanel({ schedules, engine, online, client, lastTestTs, now }: SchedulePanelProps) {
  const mod: ModuleState | null = engine?.modules.find((m) => m.name === "speedtest") ?? null;
  const session = engine?.session ?? null;
  const quiet = schedules?.speedtestQuietHours ?? null;
  const hour = now !== null ? berlinHour(now) : null;
  const ownMbps = client && (client.rxMbps !== null || client.txMbps !== null) ? (client.rxMbps ?? 0) + (client.txMbps ?? 0) : null;
  const gapActive = lastTestTs !== null && now !== null ? now - lastTestTs < 30 * 60_000 : null;

  let headline: ReactNode;
  if (!online || !engine) {
    headline = (
      <p className="flex items-start gap-2 text-sm text-fg-2">
        <PlugZap aria-hidden className="mt-0.5 size-4 shrink-0 text-warn" strokeWidth={2} />
        <span>Mess-Engine nicht erreichbar – der nächste Termin ist unbekannt. Läuft der Befehl npm run dev noch?</span>
      </p>
    );
  } else if (schedules && !schedules.speedtestEnabled) {
    headline = <p className="text-sm text-fg-2">Geplante Speedtests sind ausgeschaltet. Du kannst sie in den Einstellungen einschalten.</p>;
  } else if (!session) {
    headline = (
      <p className="text-sm text-fg-2">
        Geplante Tests laufen nur während eines Langzeittests. Starte einen Langzeittest oder teste jetzt manuell.
      </p>
    );
  } else if (mod?.busy || engine.speedtest?.running) {
    headline = <p className="text-sm text-fg-2">Gerade läuft ein Speedtest.</p>;
  } else if (mod?.nextRunTs != null) {
    headline = (
      <p className="text-sm text-fg-2">
        Nächster geplanter Test: <span className="np-num font-medium text-fg">{fmtShortTime(mod.nextRunTs)}{NBSP}Uhr</span>
        {now !== null && <span className="text-fg-3"> ({fmtRelative(mod.nextRunTs, now)})</span>}
      </p>
    );
  } else {
    headline = <p className="text-sm text-fg-2">Der erste geplante Test läuft etwa 10 Minuten nach Start des Langzeittests.</p>;
  }

  const linkProblem = client ? client.linkUp === false || client.onExpected === false : null;
  const rules: Rule[] = [
    {
      id: "quiet",
      icon: Moon,
      title: quiet ? `Ruhezeit ${quiet.from}–${quiet.to} Uhr` : "Ruhezeit",
      text: quiet
        ? "In dieser Zeit wird niemand im Haushalt durch einen Test gestört – und abendliche Spitzen werden nicht durch eigene Last verfälscht."
        : "Keine Ruhezeit eingestellt – geplante Tests laufen rund um die Uhr.",
      active: quiet && hour !== null ? inQuietHours(hour, quiet) : quiet ? null : false,
    },
    {
      id: "gaming",
      icon: Gamepad2,
      title: "Spiel läuft",
      text: "Solange ein eingetragenes Spiel läuft, startet kein geplanter Test – er würde deine Verbindung ausbremsen.",
      active: client ? client.gaming : null,
    },
    {
      id: "load",
      icon: Network,
      title: `Eigenlast über 5${NBSP}Mbit/s`,
      text: (
        <>
          Lädt der PC gerade selbst (Mittel der letzten Minute), wäre das Ergebnis verfälscht.
          {ownMbps !== null && (
            <>
              {" "}
              Jetzt: <span className="np-num text-fg-2">{fmtMbit(ownMbps)}</span>
            </>
          )}
        </>
      ),
      active: ownMbps !== null ? ownMbps > 5 : null,
    },
    {
      id: "outage",
      icon: Unplug,
      title: "Ausfall oder Link getrennt",
      text: "Während eines Ausfalls, ohne Netzwerkkabel oder auf der WLAN-Ausweichverbindung wird nicht getestet.",
      active: linkProblem,
    },
    {
      id: "gap",
      icon: Timer,
      title: `Mindestabstand 30${NBSP}min`,
      text: "Zwischen zwei Tests liegen mindestens 30 Minuten – die Testlast bleibt gering.",
      active: gapActive,
    },
  ];

  return (
    <Panel
      title={
        <span className="flex items-center gap-2">
          <CalendarClock aria-hidden className="size-4.5 text-fiber" strokeWidth={2} />
          Zeitplan
        </span>
      }
      description={schedules ? `Geplant ${everyText(schedules.speedtestEveryMin)} während eines Langzeittests.` : undefined}
    >
      {headline}
      {mod?.lastError && (
        <p className="mt-2 text-xs text-warn">Letzter Fehler der Mess-Engine: {mod.lastError}</p>
      )}
      <h3 className="mt-4 text-sm font-medium text-fg">Ein geplanter Test wird übersprungen bei</h3>
      <ul className="mt-2 flex flex-col gap-2.5">
        {rules.map((r) => (
          <li key={r.id} className="flex gap-2.5">
            <r.icon aria-hidden className={cn("mt-0.5 size-4 shrink-0", r.active ? "text-warn" : "text-fg-3")} strokeWidth={2} />
            <div className="min-w-0 flex-1">
              <p className="flex flex-wrap items-center gap-2 text-sm text-fg">
                {r.title}
                {r.active === true && <HealthBadge size="sm" status="info" label="gerade zutreffend" />}
              </p>
              <p className="text-xs text-fg-3">{r.text}</p>
            </div>
          </li>
        ))}
      </ul>
      <p className="mt-4 text-xs text-fg-3">
        Ein übersprungener Test wird nach etwa {fmtDuration(10 * 60)} erneut versucht. „Speedtest starten“ ignoriert diese Regeln.
      </p>
    </Panel>
  );
}
