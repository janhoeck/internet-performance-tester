"use client";

import { useState } from "react";
import Link from "next/link";
import { KeyRound, LogIn, Settings, ShieldAlert } from "lucide-react";
import type { PublicConfig } from "@/lib/shared/api-types";
import type { RouterStatus } from "@/lib/shared/types";
import { Button } from "@/components/ui/Button";
import { HealthBadge } from "@/components/ui/HealthBadge";
import { Panel } from "@/components/ui/Panel";
import { toast } from "@/components/ui/Toast";
import { control } from "@/lib/client/api";
import { revalidateApi } from "@/lib/client/use-api";
import { fmtShortTime, NBSP } from "@/lib/format";
import type { Severity } from "@/lib/health";
import { KeyValueList, Note, Num } from "./bits";

type RouterConfig = PublicConfig["router"];

interface LoginView {
  status: Severity;
  label: string;
  title: string;
  text: string;
}

export function loginView(s: RouterStatus | null, cfg: RouterConfig | null, now: number | null): LoginView {
  const hasPassword = s?.loginConfigured ?? cfg?.hasPassword ?? false;
  const enabled = s?.loginEnabled ?? cfg?.loginEnabled ?? false;
  if (s?.lockoutUntil != null && now != null && s.lockoutUntil > now) {
    return {
      status: "crit",
      label: "Gesperrt",
      title: "Anmeldung am Router gesperrt",
      text: `Der Router hat nach Fehlversuchen gesperrt. Neuer Versuch ab ${fmtShortTime(s.lockoutUntil)} Uhr möglich – die Mess-Engine wartet die Sperre automatisch ab.`,
    };
  }
  if (s?.loginError) {
    return {
      status: "crit",
      label: "Fehlgeschlagen",
      title: "Anmeldung fehlgeschlagen",
      text: `${s.loginError} Bei falschem Passwort versucht es die Mess-Engine nicht erneut, bis du unter Einstellungen ein neues Passwort einträgst.`,
    };
  }
  if (!hasPassword) {
    return {
      status: "info",
      label: "Kein Passwort",
      title: "Kein Router-Passwort hinterlegt",
      text: "Ohne Anmeldung liest Netzpuls nur die Startseite (Status, Firmware, DS-Lite). Mit Passwort kommen DOCSIS-Werte, Protokoll, Laufzeit und Geräteliste dazu.",
    };
  }
  if (!enabled) {
    return {
      status: "info",
      label: "Ausgeschaltet",
      title: "Router-Anmeldung ausgeschaltet",
      text: "Ein Passwort ist gespeichert, die Anmeldung ist aber unter Einstellungen ausgeschaltet. Schalte sie ein, um DOCSIS-Werte zu sammeln.",
    };
  }
  if (s?.loggedIn) {
    return { status: "good", label: "Angemeldet", title: "Angemeldet", text: "Die Mess-Engine ist gerade am Router angemeldet und liest Werte." };
  }
  return {
    status: "good",
    label: "Bereit",
    title: "Anmeldung eingerichtet",
    text: "Die Mess-Engine meldet sich für jede Abfrage kurz an und danach wieder ab – so bleibt die Weboberfläche für dich frei.",
  };
}

/** Abfrageintervall: "alle 5 min", "alle 60 s", "alle 2 h". */
function every(sec: number): string {
  if (sec < 120) return `alle ${sec}${NBSP}s`;
  if (sec < 7200) return `alle ${Math.round(sec / 60)}${NBSP}min`;
  return `alle ${Math.round(sec / 3600)}${NBSP}h`;
}

export function LoginPanel({
  status,
  config,
  now,
  engineOffline,
}: {
  status: RouterStatus | null;
  config: RouterConfig | null;
  now: number | null;
  engineOffline: boolean;
}) {
  const v = loginView(status, config, now);
  const [busy, setBusy] = useState(false);
  const canRelogin = (status?.loginConfigured ?? config?.hasPassword ?? false) && (status?.loginEnabled ?? config?.loginEnabled ?? false);
  const locked = status?.lockoutUntil != null && now != null && status.lockoutUntil > now;

  const relogin = async () => {
    setBusy(true);
    const r = await control("router.login");
    setBusy(false);
    toast({ title: r.ok ? "Router-Anmeldung gestartet" : r.error ?? "Router-Anmeldung nicht möglich", tone: r.ok ? "success" : "error" });
    if (r.ok) revalidateApi("/api/router");
  };

  return (
    <Panel
      title={
        <span className="inline-flex items-center gap-2">
          <KeyRound aria-hidden className="size-5 text-fg-3" strokeWidth={1.75} />
          Router-Anmeldung
        </span>
      }
      actions={<HealthBadge status={v.status} label={v.label} />}
    >
      <Note tone={v.status === "crit" ? "crit" : "info"} title={v.title}>
        {v.text}
      </Note>
      {config && (
        <KeyValueList
          className="mt-4"
          columns={2}
          items={[
            { label: "Benutzer", value: <Num>{config.username}</Num> },
            { label: "Passwort", value: config.hasPassword || status?.loginConfigured ? "lokal verschlüsselt gespeichert" : "nicht gespeichert" },
            { label: "DOCSIS-Abfrage", value: <Num>{every(config.pollDocsisSec)}</Num> },
            { label: "Protokoll-Abfrage", value: <Num>{every(config.pollLogSec)}</Num> },
          ]}
        />
      )}
      <p className="mt-4 text-xs text-fg-3">
        Die Station erlaubt nur eine Admin-Sitzung. Netzpuls fragt höchstens alle paar Minuten ab, meldet sich danach ab und versucht es bei falschem Passwort
        nie automatisch erneut.
      </p>
      <div className="mt-4 flex flex-wrap gap-2">
        <Link
          href="/einstellungen"
          className="inline-flex h-9 items-center gap-2 rounded-lg bg-raised px-3.5 text-sm font-medium text-fg ring-1 ring-inset ring-line-strong hover:bg-overlay focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fiber"
        >
          <Settings aria-hidden className="size-4" strokeWidth={2} />
          Router-Zugang einstellen
        </Link>
        {canRelogin && (
          <Button icon={LogIn} onClick={relogin} loading={busy} disabled={locked || engineOffline}>
            Neu anmelden
          </Button>
        )}
      </div>
    </Panel>
  );
}

/** Sicherheitshinweis: easy.box/kabel.box zeigen auf fremde Server im Internet. */
export function SecurityNote({ ip }: { ip: string }) {
  return (
    <Note tone="warn" icon={ShieldAlert} title="Router-Passwort nur unter der IP-Adresse eingeben">
      Die Namen <Num>easy.box</Num> und <Num>kabel.box</Num> führen zu fremden Servern im Internet, nicht zu deiner Vodafone Station. Öffne die
      Weboberfläche nur über{" "}
      <a href={`http://${ip}`} target="_blank" rel="noreferrer" className="text-fiber underline-offset-2 hover:underline">
        <Num>http://{ip}</Num>
      </a>
      .
    </Note>
  );
}
