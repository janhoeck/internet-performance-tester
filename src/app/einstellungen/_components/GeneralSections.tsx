"use client";

import { useState, type FormEvent } from "react";
import { Gamepad2, Plus, RotateCcw, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Field, Switch, TextInput } from "@/components/ui/Field";
import { DEFAULT_GAME_PROCESSES, type AppConfig } from "@/lib/shared/config";
import { IssueLine, NumField } from "./controls";
import type { IssueMap } from "./draft";

// ─── Tarif ──────────────────────────────────────────────────────────────────

type Tariff = AppConfig["tariff"];

export function TariffSection({ value, onChange, issues }: { value: Tariff; onChange: (v: Tariff) => void; issues: IssueMap }) {
  return (
    <div className="grid gap-4 md:grid-cols-3">
      <Field label="Tarifname" htmlFor="tariff-name" optional hint="z. B. „GigaZuhause 1000 Kabel“" error={issues["tariff.name"]?.message}>
        <TextInput id="tariff-name" value={value.name ?? ""} onChange={(e) => onChange({ ...value, name: e.target.value })} />
      </Field>
      <NumField
        id="tariff-down"
        label="Download laut Vertrag"
        unit="Mbit/s"
        nullable
        value={value.downMbps}
        onChange={(v) => onChange({ ...value, downMbps: v })}
        hint="Speedtests unter 50 % davon gelten als Kritisch."
        issue={issues["tariff.downMbps"]}
      />
      <NumField
        id="tariff-up"
        label="Upload laut Vertrag"
        unit="Mbit/s"
        nullable
        value={value.upMbps}
        onChange={(v) => onChange({ ...value, upMbps: v })}
        hint="Leer lassen, wenn unbekannt."
        issue={issues["tariff.upMbps"]}
      />
    </div>
  );
}

// ─── Langzeittest ───────────────────────────────────────────────────────────

type SessionCfg = AppConfig["session"];

export function SessionSection({ value, onChange }: { value: SessionCfg; onChange: (v: SessionCfg) => void }) {
  return (
    <Switch
      id="session-sleep"
      checked={value.preventSleep}
      onChange={(e) => onChange({ preventSleep: e.target.checked })}
      label="Standby während eines Langzeittests verhindern"
      hint="Windows schläft dann nicht automatisch ein (ohne Administratorrechte). Manuelles Schlafenlegen bleibt möglich, erzeugt aber eine Messlücke."
    />
  );
}

// ─── Spiele-Erkennung ───────────────────────────────────────────────────────

type Gaming = AppConfig["gaming"];

export function GamingSection({ value, onChange, issues }: { value: Gaming; onChange: (v: Gaming) => void; issues: IssueMap }) {
  const [entry, setEntry] = useState("");
  const list = value.processNames;
  const entryNorm = entry.trim().toLowerCase();
  const duplicate = entryNorm !== "" && list.some((p) => p.toLowerCase() === entryNorm);
  const missingDefaults = DEFAULT_GAME_PROCESSES.filter((d) => !list.some((p) => p.toLowerCase() === d));

  const add = (e: FormEvent) => {
    e.preventDefault();
    if (!entryNorm || duplicate) return;
    const name = entryNorm.endsWith(".exe") ? entryNorm : `${entryNorm}.exe`;
    if (!list.some((p) => p.toLowerCase() === name)) onChange({ processNames: [...list, name] });
    setEntry("");
  };

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-fg-3">
        Läuft eines dieser Programme, markiert die Mess-Engine die Zeit als Spielzeit und lässt geplante Speedtests aus. Groß- und Kleinschreibung
        spielt keine Rolle.
      </p>
      {/* eigenes Mini-Formular: Enter fügt hinzu, ohne die Seite abzusenden */}
      <form onSubmit={add} className="flex flex-wrap items-start gap-2">
        <Field
          label="Prozessname hinzufügen"
          htmlFor="gaming-add"
          hint={duplicate ? "Steht schon in der Liste." : "Name aus dem Task-Manager (Details), z. B. „cs2.exe“."}
          className="min-w-0 flex-1 sm:max-w-sm"
        >
          <TextInput id="gaming-add" value={entry} spellCheck={false} autoComplete="off" className="np-num" onChange={(e) => setEntry(e.target.value)} />
        </Field>
        <Button type="submit" icon={Plus} disabled={!entryNorm || duplicate} className="mt-[1.375rem]">
          Hinzufügen
        </Button>
      </form>

      {list.length === 0 ? (
        <p className="flex items-center gap-2 rounded-[10px] bg-raised/50 px-4 py-3 text-sm text-fg-3 ring-1 ring-inset ring-line">
          <Gamepad2 aria-hidden className="size-4 shrink-0" strokeWidth={2} />
          Keine Spiele eingetragen – Speedtests laufen dann auch während des Spielens.
        </p>
      ) : (
        <ul aria-label="Erkannte Spiele" className="flex max-h-64 flex-wrap gap-2 overflow-y-auto pr-1">
          {list.map((p) => (
            <li key={p} className="inline-flex h-7 items-center gap-1 rounded-full bg-raised pl-3 pr-1 text-xs text-fg-2 ring-1 ring-inset ring-line-strong">
              <span className="np-num">{p}</span>
              <button
                type="button"
                aria-label={`${p} entfernen`}
                onClick={() => onChange({ processNames: list.filter((x) => x !== p) })}
                className="grid size-5 place-items-center rounded-full text-fg-3 hover:bg-overlay hover:text-fg focus-visible:outline-2 focus-visible:outline-fiber"
              >
                <X aria-hidden className="size-3" strokeWidth={2.25} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <IssueLine issue={issues["gaming.processNames"]} />
      <div className="flex flex-wrap items-center gap-3 text-xs text-fg-3">
        <span className="np-num">{list.length}</span> Einträge
        {missingDefaults.length > 0 && (
          <Button
            size="sm"
            variant="ghost"
            icon={RotateCcw}
            onClick={() => onChange({ processNames: [...list, ...missingDefaults] })}
          >
            Standardliste ergänzen ({missingDefaults.length})
          </Button>
        )}
      </div>
    </div>
  );
}
