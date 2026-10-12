"use client";

import { useState } from "react";
import { CircleCheck, KeyRound, ShieldAlert, Trash2, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { ChoiceGroup, Field, Switch, TextInput } from "@/components/ui/Field";
import type { AppConfig } from "@/lib/shared/config";
import { GroupTitle, IssueLine, NumField } from "./controls";
import { ROUTER_HOSTNAME_TRAP, type IssueMap, type PasswordDraft } from "./draft";

type RouterCfg = AppConfig["router"];

interface RouterSectionProps {
  value: RouterCfg;
  onChange: (v: RouterCfg) => void;
  password: PasswordDraft;
  onPasswordChange: (p: PasswordDraft) => void;
  hasPassword: boolean;
  engineOnline: boolean;
  issues: IssueMap;
}

const ADAPTERS = [
  { value: "auto", label: "Automatisch", hint: "erkennt das Modell" },
  { value: "arris-vodafone-station", label: "Vodafone Station", hint: "ARRIS TG6442" },
  { value: "generic", label: "Generisch", hint: "nur Erreichbarkeit" },
] as const;

export function RouterSection({ value, onChange, password, onPasswordChange, hasPassword, engineOnline, issues }: RouterSectionProps) {
  const set = <K extends keyof RouterCfg>(k: K, v: RouterCfg[K]) => onChange({ ...value, [k]: v });
  const ipIssue = issues["router.ip"];
  const ipLooksLikeTrap = ROUTER_HOSTNAME_TRAP.test(value.ip.trim());

  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-4 md:grid-cols-2">
        <Field
          label="Router-Adresse"
          htmlFor="router-ip"
          hint="IP-Adresse der Vodafone Station, meist 192.168.0.1. Nur private Adressen."
          error={ipIssue?.message}
        >
          <TextInput
            id="router-ip"
            value={value.ip}
            spellCheck={false}
            autoComplete="off"
            inputMode="url"
            className="np-num"
            aria-invalid={ipIssue ? true : undefined}
            aria-describedby={ipIssue ? "router-ip-error" : "router-ip-hint"}
            onChange={(e) => set("ip", e.target.value)}
          />
        </Field>
        <Field label="Benutzer" htmlFor="router-user" hint="Bei der Vodafone Station immer „admin“." error={issues["router.username"]?.message}>
          <TextInput
            id="router-user"
            value={value.username}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => set("username", e.target.value)}
          />
        </Field>
      </div>

      {ipLooksLikeTrap && (
        <div role="alert" className="flex items-start gap-3 rounded-[10px] bg-crit/10 px-4 py-3 ring-1 ring-inset ring-crit/35">
          <ShieldAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-crit" strokeWidth={2.25} />
          <p className="text-sm text-fg-2">
            <span className="font-medium text-fg">Sicherheitswarnung.</span> „easy.box“ und „kabel.box“ lösen bei diesem Anschluss zu fremden
            Servern im Internet auf. Gib dort nie dein Router-Passwort ein – deine Vodafone Station erreichst du unter{" "}
            <span className="np-num text-fg">192.168.0.1</span>.
          </p>
        </div>
      )}

      <ChoiceGroup
        name="router-adapter"
        legend="Router-Modell"
        options={ADAPTERS}
        value={value.adapter}
        onChange={(v) => set("adapter", v)}
      />

      <div>
        <GroupTitle>Anmeldung</GroupTitle>
        <PasswordField password={password} onChange={onPasswordChange} hasPassword={hasPassword} engineOnline={engineOnline} issueText={issues.routerPassword?.message} />
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Switch
              id="router-login"
              checked={value.loginEnabled}
              onChange={(e) => set("loginEnabled", e.target.checked)}
              label="Anmeldung am Router erlauben"
              hint="Für DOCSIS-Werte, Router-Protokoll, Laufzeit und Geräteliste. Bei falschem Passwort versucht die Mess-Engine es nie automatisch erneut."
            />
            <IssueLine issue={issues["router.loginEnabled"]} className="pl-12" />
          </div>
          <Switch
            id="router-logout"
            checked={value.logoutAfterPoll}
            onChange={(e) => set("logoutAfterPoll", e.target.checked)}
            label="Nach jeder Abfrage abmelden"
            hint="Die Station erlaubt nur eine Admin-Sitzung. So bleibt die Weboberfläche für dich frei."
          />
        </div>
      </div>

      <div>
        <GroupTitle>Abfrageintervalle</GroupTitle>
        <div className="grid gap-4 sm:grid-cols-3">
          <NumField
            id="router-poll-status"
            label="Status ohne Anmeldung"
            unit="s"
            step={1}
            value={value.pollStatusSec}
            onChange={(v) => set("pollStatusSec", v ?? Number.NaN)}
            hint="Startseite, Firmware, DS-Lite-Daten"
            issue={issues["router.pollStatusSec"]}
          />
          <NumField
            id="router-poll-docsis"
            label="DOCSIS-Werte und Laufzeit"
            unit="min"
            scale={60}
            step={1}
            value={value.pollDocsisSec}
            onChange={(v) => set("pollDocsisSec", v ?? Number.NaN)}
            hint="Mit Anmeldung, empfohlen 5 min"
            issue={issues["router.pollDocsisSec"]}
          />
          <NumField
            id="router-poll-log"
            label="Router-Protokoll"
            unit="min"
            scale={60}
            step={1}
            value={value.pollLogSec}
            onChange={(v) => set("pollLogSec", v ?? Number.NaN)}
            hint="Mit Anmeldung, empfohlen 15 min"
            issue={issues["router.pollLogSec"]}
          />
        </div>
      </div>
    </div>
  );
}

interface PasswordFieldProps {
  password: PasswordDraft;
  onChange: (p: PasswordDraft) => void;
  hasPassword: boolean;
  engineOnline: boolean;
  issueText?: string;
}

/** Nur-Schreib-Feld: das gespeicherte Passwort wird nie angezeigt oder an den Browser gesendet. */
function PasswordField({ password, onChange, hasPassword, engineOnline, issueText }: PasswordFieldProps) {
  const [editing, setEditing] = useState(false);
  const offlineHint = engineOnline
    ? "Wird verschlüsselt (Windows DPAPI) lokal gespeichert und nie wieder angezeigt."
    : "Mess-Engine nicht erreichbar – ein neues Passwort kann erst gespeichert werden, wenn sie läuft.";

  if (password.mode === "remove") {
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-[10px] bg-warn/10 px-4 py-3 ring-1 ring-inset ring-warn/30">
        <Trash2 aria-hidden className="size-4 shrink-0 text-warn" strokeWidth={2.25} />
        <p className="min-w-0 flex-1 text-sm text-fg-2">Das gespeicherte Passwort wird beim Speichern entfernt.</p>
        <Button size="sm" variant="ghost" icon={Undo2} onClick={() => onChange({ mode: "keep" })}>
          Rückgängig
        </Button>
      </div>
    );
  }

  if (hasPassword && !editing && password.mode === "keep") {
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-[10px] bg-raised/60 px-4 py-3 ring-1 ring-inset ring-line">
        <CircleCheck aria-hidden className="size-4 shrink-0 text-good" strokeWidth={2.25} />
        <p className="min-w-0 flex-1 text-sm text-fg">
          Passwort gespeichert
          <span className="block text-xs text-fg-3">Verschlüsselt auf diesem PC, wird nicht angezeigt.</span>
        </p>
        <div className="flex gap-2">
          <Button size="sm" icon={KeyRound} onClick={() => setEditing(true)}>
            Passwort ändern
          </Button>
          <Button size="sm" variant="danger" icon={Trash2} onClick={() => onChange({ mode: "remove" })}>
            Passwort entfernen
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 md:max-w-md">
      <Field label={hasPassword ? "Neues Router-Passwort" : "Router-Passwort"} htmlFor="router-password" hint={offlineHint} error={issueText}>
        <TextInput
          id="router-password"
          type="password"
          autoComplete="new-password"
          spellCheck={false}
          placeholder={hasPassword ? "Neues Passwort eingeben" : "Passwort der Weboberfläche"}
          value={password.mode === "set" ? password.value : ""}
          onChange={(e) => onChange(e.target.value ? { mode: "set", value: e.target.value } : { mode: "keep" })}
        />
      </Field>
      {hasPassword && (
        <div>
          <Button
            size="sm"
            variant="ghost"
            icon={Undo2}
            onClick={() => {
              setEditing(false);
              onChange({ mode: "keep" });
            }}
          >
            Gespeichertes Passwort behalten
          </Button>
        </div>
      )}
    </div>
  );
}
