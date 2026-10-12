"use client";

import { useState, useSyncExternalStore, type ReactNode } from "react";
import { Copy, Database, FileClock, PlugZap } from "lucide-react";
import type { MotionPreference } from "@/components/background/MotionGovernor";
import { setMotionPreference } from "@/components/background/MotionGovernor";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { ChoiceGroup } from "@/components/ui/Field";
import { Skeleton } from "@/components/ui/States";
import { toast } from "@/components/ui/Toast";
import { control } from "@/lib/client/api";
import { useApi } from "@/lib/client/use-api";
import { DASH, fmtBytes, fmtDateTime, fmtNumber } from "@/lib/format";
import type { StatusResponse } from "@/lib/shared/api-types";
import type { AppConfig } from "@/lib/shared/config";
import { GroupTitle, NumField } from "./controls";
import type { IssueMap } from "./draft";

// ─── Datenhaltung ───────────────────────────────────────────────────────────

type Retention = AppConfig["retention"];

const RETENTION_FIELDS = [
  ["rawDays", "Rohmesswerte (jede Antwort)", "ca. 20 MB je Tag"],
  ["rollupDays", "Minutenwerte und Sekunden-Klassen", "für Verlauf und Diagnose"],
  ["metricsDays", "Kennzahlen (Adapter, WLAN, DOCSIS)", "1–60 s Auflösung"],
  ["snapshotsDays", "Schnappschüsse (Router, DOCSIS-Tabellen)", "alle 5 min bzw. bei Änderung"],
  ["eventsDays", "Ereignisse", "klein, lange aufheben"],
] as const;

export function RetentionSection({ value, onChange, issues }: { value: Retention; onChange: (v: Retention) => void; issues: IssueMap }) {
  const rawMb = Number.isFinite(value.rawDays) ? value.rawDays * 20 : null;
  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {RETENTION_FIELDS.map(([k, label, hint]) => (
          <NumField
            key={k}
            id={`ret-${k}`}
            label={label}
            unit="Tage"
            step={1}
            value={value[k]}
            onChange={(v) => onChange({ ...value, [k]: v ?? Number.NaN })}
            hint={k === "rawDays" && rawMb !== null ? `Rohdaten belegen dann ca. ${fmtNumber(rawMb >= 1000 ? rawMb / 1000 : rawMb, rawMb >= 1000 ? 1 : 0)} ${rawMb >= 1000 ? "GB" : "MB"}` : hint}
            issue={issues[`retention.${k}`]}
          />
        ))}
      </div>
      <p className="text-xs text-fg-3">Ältere Daten löscht die Mess-Engine automatisch einmal täglich. Speedtests und Traceroutes bleiben so lange wie Ereignisse.</p>
      <DatabaseInfo />
    </div>
  );
}

function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-4">
      <dt className="shrink-0 text-xs text-fg-3 sm:w-40">{label}</dt>
      <dd className="min-w-0 text-sm text-fg">{children}</dd>
    </div>
  );
}

function DatabaseInfo() {
  const status = useApi<StatusResponse>("/api/status", { refreshMs: 30_000 });
  const db = status.data?.db;
  const size = status.data?.engine?.dbSizeBytes ?? db?.sizeBytes ?? null;
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast({ title: "Pfad kopiert" });
    } catch {
      toast({ title: "Kopieren nicht möglich", description: "Der Browser erlaubt keinen Zugriff auf die Zwischenablage.", tone: "warn" });
    }
  };

  return (
    <div className="rounded-[10px] bg-raised/40 px-4 py-4 ring-1 ring-inset ring-line">
      <GroupTitle className="flex items-center gap-2">
        <Database aria-hidden className="size-4 text-fg-3" strokeWidth={2} />
        Datenbank
      </GroupTitle>
      {!db ? (
        status.error ? (
          <p className="text-sm text-fg-3">Datenbank-Infos nicht verfügbar: {status.error.message}</p>
        ) : (
          <div className="flex flex-col gap-2" aria-busy="true" aria-label="Datenbank-Infos werden geladen">
            <Skeleton className="w-3/4" />
            <Skeleton className="w-1/3" />
          </div>
        )
      ) : (
        <dl className="flex flex-col gap-2.5">
          <InfoRow label="Speicherort">
            <span className="flex min-w-0 items-start gap-2">
              <code className="np-num min-w-0 break-all text-xs text-fg-2">{db.path}</code>
              <Button size="sm" variant="ghost" icon={Copy} aria-label="Pfad kopieren" onClick={() => void copy(db.path)} className="-my-1 shrink-0" />
            </span>
          </InfoRow>
          <InfoRow label="Größe">
            <span className="np-num">{size !== null ? fmtBytes(size) : DASH}</span>
          </InfoRow>
          <InfoRow label="Erster Messwert">
            <span className="np-num">{db.firstSampleTs !== null ? fmtDateTime(db.firstSampleTs) : DASH}</span>
          </InfoRow>
          <InfoRow label="Letzter Messwert">
            <span className="np-num">{db.lastSampleTs !== null ? fmtDateTime(db.lastSampleTs) : DASH}</span>
          </InfoRow>
        </dl>
      )}
    </div>
  );
}

// ─── Ereignisprotokoll ──────────────────────────────────────────────────────

type EventLogCfg = AppConfig["eventLog"];

interface EventLogSectionProps {
  value: EventLogCfg;
  onChange: (v: EventLogCfg) => void;
  issues: IssueMap;
  engineOnline: boolean;
}

export function EventLogSection({ value, onChange, issues, engineOnline }: EventLogSectionProps) {
  const [days, setDays] = useState<number | null>(value.importDays > 0 ? Math.min(value.importDays, 3650) : 365);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const daysValid = days !== null && Number.isInteger(days) && days >= 1 && days <= 3650;

  const run = async () => {
    if (!daysValid) return;
    setBusy(true);
    const r = await control("eventlog.import", { days });
    setBusy(false);
    setConfirm(false);
    toast(
      r.ok
        ? { title: "Import gestartet", description: "Neue Link-Abbrüche erscheinen nach und nach unter PC & Adapter und Ereignisse." }
        : { title: "Import nicht gestartet", description: r.error, tone: "error" },
    );
  };

  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm text-fg-3">
        Link-Abbrüche des Netzwerkadapters, Standby und WLAN-Wechsel liest die Mess-Engine aus dem Windows-Ereignisprotokoll. Bereits
        importierte Einträge werden nicht doppelt gespeichert.
      </p>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <NumField
          id="evl-first"
          label="Beim ersten Start importieren"
          unit="Tage"
          step={1}
          value={value.importDays}
          onChange={(v) => onChange({ importDays: v ?? Number.NaN })}
          hint="Wird mit „Speichern“ übernommen."
          issue={issues["eventLog.importDays"]}
        />
        <NumField
          id="evl-now"
          label="Jetzt neu importieren"
          unit="Tage"
          step={1}
          value={days}
          onChange={setDays}
          nullable
          issue={days !== null && !daysValid ? { message: "", bound: { kind: days < 1 ? "min" : "max", value: days < 1 ? 1 : 3650, inclusive: true } } : undefined}
          hint="1 bis 3650 Tage"
        />
        <div className="flex items-start sm:pt-[1.375rem]">
          <Button icon={FileClock} disabled={!engineOnline || !daysValid} onClick={() => setConfirm(true)}>
            Ereignisprotokoll neu importieren
          </Button>
        </div>
      </div>
      {!engineOnline && (
        <p className="flex items-center gap-2 text-xs text-warn">
          <PlugZap aria-hidden className="size-3.5 shrink-0" strokeWidth={2.25} />
          Mess-Engine nicht erreichbar – der Import ist erst möglich, wenn sie läuft.
        </p>
      )}
      {confirm && (
        <Dialog
          open
          onClose={() => !busy && setConfirm(false)}
          dismissible={!busy}
          size="sm"
          title="Ereignisprotokoll neu importieren?"
          description={`Die Mess-Engine liest die letzten ${days ?? ""} Tage aus dem Windows-Ereignisprotokoll. Das kann bis zu einer Minute dauern.`}
          footer={
            <>
              <Button onClick={() => setConfirm(false)} disabled={busy}>
                Abbrechen
              </Button>
              <Button variant="primary" icon={FileClock} loading={busy} onClick={() => void run()}>
                Import starten
              </Button>
            </>
          }
        />
      )}
    </div>
  );
}

// ─── Darstellung ────────────────────────────────────────────────────────────

/* Gleicher Speicher wie MotionGovernor (np-motion / np-motion-change). */
const MOTION_KEY = "np-motion";
const MOTION_EVENT = "np-motion-change";

function readMotion(): MotionPreference {
  try {
    const v = window.localStorage.getItem(MOTION_KEY);
    return v === "on" || v === "off" ? v : "auto";
  } catch {
    return "auto";
  }
}

function subscribeMotion(onChange: () => void): () => void {
  window.addEventListener(MOTION_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(MOTION_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

const MOTION_OPTIONS = [
  { value: "auto", label: "Automatisch", hint: "folgt der Systemeinstellung" },
  { value: "on", label: "An", hint: "pausiert bei Inaktivität" },
  { value: "off", label: "Aus", hint: "spart Strom" },
] as const;

export function AppearanceSection() {
  const pref = useSyncExternalStore(subscribeMotion, readMotion, () => "auto" as MotionPreference);
  return (
    <div className="flex flex-col gap-3">
      <ChoiceGroup name="motion" legend="Hintergrundanimation" options={MOTION_OPTIONS} value={pref} onChange={(v) => setMotionPreference(v)} />
      <p className="text-xs text-fg-3">Gilt sofort und nur in diesem Browser – kein Speichern nötig.</p>
    </div>
  );
}
