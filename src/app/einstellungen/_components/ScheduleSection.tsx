"use client";

import { ChevronRight } from "lucide-react";
import { Field, Select, Switch } from "@/components/ui/Field";
import type { AppConfig } from "@/lib/shared/config";
import { fmtNumber } from "@/lib/format";
import { GroupTitle, IssueLine, NumField, ProblemChip } from "./controls";
import type { IssueMap } from "./draft";

type Schedules = AppConfig["schedules"];
type SpeedtestCfg = AppConfig["speedtest"];
type UdpBurstCfg = AppConfig["udpBurst"];

interface ScheduleSectionProps {
  schedules: Schedules;
  speedtest: SpeedtestCfg;
  udpBurst: UdpBurstCfg;
  onSchedules: (v: Schedules) => void;
  onSpeedtest: (v: SpeedtestCfg) => void;
  onUdpBurst: (v: UdpBurstCfg) => void;
  issues: IssueMap;
}

const HOURS = Array.from({ length: 24 }, (_, h) => h);

function everyText(min: number): string | undefined {
  if (!Number.isFinite(min) || min <= 0) return undefined;
  if (min < 60) return `alle ${fmtNumber(min, 0)} min`;
  const h = min / 60;
  if (h < 24) return `alle ${fmtNumber(h, Number.isInteger(h) ? 0 : 1)} h`;
  const d = h / 24;
  return `alle ${fmtNumber(d, Number.isInteger(d) ? 0 : 1)} Tage`;
}

export function ScheduleSection({ schedules: s, speedtest, udpBurst, onSchedules, onSpeedtest, onUdpBurst, issues }: ScheduleSectionProps) {
  const set = <K extends keyof Schedules>(k: K, v: Schedules[K]) => onSchedules({ ...s, [k]: v });
  const num = <K extends keyof Schedules>(k: K) => (v: number | null) => set(k, (v ?? Number.NaN) as Schedules[K]);
  const quiet = s.speedtestQuietHours;
  const advIssues = Object.entries(issues).filter(
    ([p, i]) => !i.warning && (p.startsWith("speedtest.") || p.startsWith("udpBurst.") || /^schedules\.\w+PollSec$/.test(p)),
  ).length;

  const job = (k: keyof Schedules, id: string, label: string, hint: string) => {
    const v = s[k] as number;
    return (
      <NumField
        id={id}
        label={label}
        unit="min"
        step={1}
        value={v}
        onChange={num(k)}
        hint={everyText(v) ? `${hint} (${everyText(v)})` : hint}
        issue={issues[`schedules.${k}`]}
      />
    );
  };

  return (
    <div className="flex flex-col gap-6">
      <div>
        <GroupTitle>Speedtest</GroupTitle>
        <div className="flex flex-col gap-4">
          <Switch
            id="st-enabled"
            checked={s.speedtestEnabled}
            onChange={(e) => set("speedtestEnabled", e.target.checked)}
            label="Geplante Speedtests"
            hint="Nicht während eines Spiels, bei hoher Eigenlast oder während eines Ausfalls. Manuell geht es jederzeit."
          />
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <NumField
              id="st-every"
              label="Intervall"
              unit="min"
              step={1}
              value={s.speedtestEveryMin}
              onChange={num("speedtestEveryMin")}
              disabled={!s.speedtestEnabled}
              hint={everyText(s.speedtestEveryMin) ?? "Empfohlen: 180 min"}
              issue={issues["schedules.speedtestEveryMin"]}
            />
          </div>
          <div className="flex flex-col gap-3">
            <Switch
              id="st-quiet"
              checked={quiet !== null}
              disabled={!s.speedtestEnabled}
              onChange={(e) => set("speedtestQuietHours", e.target.checked ? { from: 18, to: 23 } : null)}
              label="Ruhezeiten"
              hint="In diesem Zeitraum keine geplanten Speedtests – abends wird gespielt und das Kabelnetz ist ohnehin voll."
            />
            {quiet && (
              <div className="grid max-w-md grid-cols-2 gap-4 pl-12">
                <Field label="Von" htmlFor="st-quiet-from" error={issues["schedules.speedtestQuietHours.from"]?.message}>
                  <Select
                    id="st-quiet-from"
                    value={quiet.from}
                    disabled={!s.speedtestEnabled}
                    onChange={(e) => set("speedtestQuietHours", { ...quiet, from: Number(e.target.value) })}
                  >
                    {HOURS.map((h) => (
                      <option key={h} value={h}>
                        {String(h).padStart(2, "0")}:00 Uhr
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Bis" htmlFor="st-quiet-to" error={issues["schedules.speedtestQuietHours.to"]?.message}>
                  <Select
                    id="st-quiet-to"
                    value={quiet.to}
                    disabled={!s.speedtestEnabled}
                    onChange={(e) => set("speedtestQuietHours", { ...quiet, to: Number(e.target.value) })}
                  >
                    {HOURS.map((h) => h + 1).map((h) => (
                      <option key={h} value={h}>
                        {String(h).padStart(2, "0")}:00 Uhr
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
            )}
          </div>
        </div>
      </div>

      <div>
        <GroupTitle>Pfad- und Spezialmessungen</GroupTitle>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {job("tracerouteEveryMin", "sch-trace", "Pfaderkennung (Hops 1–8)", "Routenwechsel, Hop-Adressen")}
          {job("mtrEveryMin", "sch-mtr", "MTR (20 Pings je Hop)", "Wo Paketverlust beginnt")}
          {job("mtuEveryMin", "sch-mtu", "Pfad-MTU", "IPv4 und IPv6")}
          {job("stunEveryMin", "sch-stun", "NAT-Test (STUN)", "Öffentliche IPv4, NAT-Verhalten")}
          {job("udpBurstEveryMin", "sch-burst", "UDP-Burst", "Spieltypische Paketrate")}
        </div>
      </div>

      <details className="group rounded-[10px] ring-1 ring-inset ring-line">
        <summary className="flex cursor-pointer list-none items-center gap-2 rounded-[10px] px-4 py-3 text-sm font-medium text-fg hover:bg-raised/60 focus-visible:outline-2 focus-visible:outline-fiber [&::-webkit-details-marker]:hidden">
          <ChevronRight aria-hidden className="size-4 text-fg-3 transition-transform group-open:rotate-90" strokeWidth={2} />
          Erweitert: Abfrageintervalle, Speedtest- und Burst-Parameter
          {advIssues > 0 && <ProblemChip count={advIssues} />}
        </summary>
        <div className="flex flex-col gap-6 px-4 pb-5 pt-2">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {(
              [
                ["adapterPollSec", "Adapterstatistik"],
                ["eventLogPollSec", "Ereignisprotokoll"],
                ["wlanPollSec", "WLAN-Werte"],
                ["routePollSec", "Routing-Tabelle"],
                ["vpnPollSec", "VPN/WARP-Status"],
                ["systemPollSec", "CPU und Speicher"],
                ["identityPollSec", "Gateway, DHCP, Spiele-Erkennung"],
              ] as const
            ).map(([k, label]) => (
              <NumField key={k} id={`sch-${k}`} label={label} unit="s" step={1} value={s[k]} onChange={num(k)} issue={issues[`schedules.${k}`]} />
            ))}
          </div>
          <div>
            <GroupTitle>Speedtest-Ablauf</GroupTitle>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
              {(
                [
                  ["downloadStreams", "Verbindungen Download", undefined],
                  ["uploadStreams", "Verbindungen Upload", undefined],
                  ["idleSec", "Ruhemessung", "s"],
                  ["downloadSec", "Dauer Download", "s"],
                  ["uploadSec", "Dauer Upload", "s"],
                ] as const
              ).map(([k, label, unit]) => (
                <NumField
                  key={k}
                  id={`spt-${k}`}
                  label={label}
                  unit={unit}
                  step={1}
                  value={speedtest[k]}
                  onChange={(v) => onSpeedtest({ ...speedtest, [k]: v ?? Number.NaN })}
                  issue={issues[`speedtest.${k}`]}
                />
              ))}
            </div>
          </div>
          <div>
            <GroupTitle>UDP-Burst</GroupTitle>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <NumField
                id="burst-pps"
                label="Pakete pro Sekunde"
                unit="/s"
                step={1}
                value={udpBurst.packetsPerSecond}
                onChange={(v) => onUdpBurst({ ...udpBurst, packetsPerSecond: v ?? Number.NaN })}
                issue={issues["udpBurst.packetsPerSecond"]}
              />
              <NumField
                id="burst-dur"
                label="Dauer"
                unit="s"
                step={1}
                value={udpBurst.durationSec}
                onChange={(v) => onUdpBurst({ ...udpBurst, durationSec: v ?? Number.NaN })}
                issue={issues["udpBurst.durationSec"]}
              />
            </div>
          </div>
        </div>
      </details>
      <IssueLine issue={issues["schedules.speedtestQuietHours"]} />
    </div>
  );
}
