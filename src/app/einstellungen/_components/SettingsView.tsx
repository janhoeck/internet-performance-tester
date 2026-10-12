"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { CircleCheck, OctagonAlert, PencilLine, Save, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Panel } from "@/components/ui/Panel";
import { ErrorState, Skeleton } from "@/components/ui/States";
import { toast } from "@/components/ui/Toast";
import { ApiFailure, errorMessage, saveConfig } from "@/lib/client/api";
import { useLiveConnection } from "@/lib/client/live-store";
import { revalidateApi, setApiData, useApi } from "@/lib/client/use-api";
import { cn } from "@/lib/cn";
import type { ConfigResponse, PublicConfig } from "@/lib/shared/api-types";
import type { AppConfig } from "@/lib/shared/config";
import { ServerIssues } from "./controls";
import {
  buildPatch,
  changedSections,
  countErrors,
  parseServerError,
  toDraft,
  validateDraft,
  type IssueMap,
  type PasswordDraft,
  type SectionKey,
  type ServerIssue,
} from "./draft";
import { GamingSection, SessionSection, TariffSection } from "./GeneralSections";
import { RouterSection } from "./RouterSection";
import { ScheduleSection } from "./ScheduleSection";
import { AppearanceSection, EventLogSection, RetentionSection } from "./SystemSections";
import { TargetsSection } from "./TargetsSection";
import { ThresholdsSection } from "./ThresholdsSection";

interface SectionDef {
  id: string;
  title: string;
  description: string;
  keys: readonly SectionKey[];
  /** zusätzliche Fehlerpfade (Präfixe), z. B. das Passwortfeld */
  extraPaths?: readonly string[];
}

const SECTIONS: readonly SectionDef[] = [
  { id: "router", title: "Router-Zugang", description: "Adresse und Anmeldung an der Vodafone Station.", keys: ["router"], extraPaths: ["routerPassword"] },
  { id: "tarif", title: "Tarif", description: "Vertragswerte – Grundlage für die Bewertung der Speedtests.", keys: ["tariff"] },
  { id: "langzeittest", title: "Langzeittest", description: "Verhalten des PCs während eines laufenden Tests.", keys: ["session"] },
  { id: "spiele", title: "Spiele-Erkennung", description: "Programme, an denen Netzpuls erkennt, dass du spielst.", keys: ["gaming"] },
  { id: "zeitplaene", title: "Zeitpläne", description: "Wann Speedtests und Pfadmessungen automatisch laufen.", keys: ["schedules", "speedtest", "udpBurst"] },
  { id: "messziele", title: "Messziele", description: "Welche Ziele die Mess-Engine anpingt und wie oft.", keys: ["targets"] },
  { id: "schwellen", title: "Schwellen", description: "Ab wann ein Wert als Auffällig oder Kritisch gilt.", keys: ["thresholds"] },
  { id: "datenhaltung", title: "Datenhaltung", description: "Wie lange Messdaten aufbewahrt werden.", keys: ["retention"] },
  { id: "ereignisprotokoll", title: "Windows-Ereignisprotokoll", description: "Import der Link-Abbrüche aus Windows.", keys: ["eventLog"] },
  { id: "darstellung", title: "Darstellung", description: "Einstellungen nur für diesen Browser.", keys: [] },
];

function sectionOfPath(path: string): SectionDef | undefined {
  const head = path.split(".")[0];
  return SECTIONS.find((s) => (s.keys as readonly string[]).includes(head) || s.extraPaths?.includes(head));
}

/** Lädt GET /api/config und zeigt das Formular (Lade-, Fehlerzustand). */
export function SettingsView() {
  const cfg = useApi<ConfigResponse>("/api/config");
  if (!cfg.data) {
    if (cfg.error) {
      return (
        <Panel>
          <ErrorState title="Einstellungen konnten nicht geladen werden" message={cfg.error.message} onRetry={cfg.reload} />
        </Panel>
      );
    }
    return <SettingsSkeleton />;
  }
  return <SettingsForm initial={cfg.data.config} />;
}

function SettingsSkeleton() {
  return (
    <div className="flex flex-col gap-6 lg:ml-[15rem]" aria-busy="true" aria-label="Einstellungen werden geladen">
      {[0, 1, 2].map((i) => (
        <div key={i} className="np-panel flex flex-col gap-4 p-5">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-3 w-72 max-w-full" />
          <div className="grid gap-4 md:grid-cols-2">
            <Skeleton className="h-9" />
            <Skeleton className="h-9" />
          </div>
        </div>
      ))}
    </div>
  );
}

function SettingsForm({ initial }: { initial: PublicConfig }) {
  const [base, setBase] = useState<PublicConfig>(initial);
  const [draft, setDraft] = useState<AppConfig>(() => toDraft(initial));
  const [password, setPassword] = useState<PasswordDraft>({ mode: "keep" });
  const [serverIssues, setServerIssues] = useState<ServerIssue[]>([]);
  const [saving, setSaving] = useState(false);
  const [formKey, setFormKey] = useState(0);
  const conn = useLiveConnection();
  // solange der Live-Stream noch verbindet: kein "nicht erreichbar" anzeigen
  const engineOnline = conn.online || conn.status === "idle" || conn.status === "connecting";

  const baseDraft = useMemo(() => toDraft(base), [base]);
  const changed = useMemo(() => changedSections(baseDraft, draft), [baseDraft, draft]);
  const passwordChanged = password.mode === "remove" || (password.mode === "set" && password.value.length > 0);
  const dirty = changed.length > 0 || passwordChanged;
  const issues: IssueMap = useMemo(() => validateDraft(draft, password, base.router.hasPassword), [draft, password, base.router.hasPassword]);
  const errorCount = countErrors(issues);

  // Ungespeicherte Änderungen: Browser fragt beim Verlassen nach
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  const update =
    <K extends SectionKey>(key: K) =>
    (v: AppConfig[K]) =>
      setDraft((d) => ({ ...d, [key]: v }));

  const sectionState = (s: SectionDef) => {
    const prefixes = [...s.keys, ...(s.extraPaths ?? [])];
    const errs = Object.entries(issues).filter(([p, i]) => !i.warning && prefixes.some((x) => p === x || p.startsWith(`${x}.`))).length;
    const isDirty = s.keys.some((k) => changed.includes(k)) || (s.id === "router" && passwordChanged);
    const srv = serverIssues.filter((i) => (i.path ? sectionOfPath(i.path) === s : false));
    return { errs, isDirty, srv };
  };
  const generalServerIssues = serverIssues.filter((i) => !i.path || !sectionOfPath(i.path));

  const jumpTo = (id: string) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.querySelectorAll("details").forEach((d) => (d.open = true));
    el.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const discard = () => {
    setDraft(toDraft(base));
    setPassword({ mode: "keep" });
    setServerIssues([]);
    setFormKey((k) => k + 1);
  };

  const save = async () => {
    if (errorCount > 0) {
      const first = SECTIONS.find((s) => sectionState(s).errs > 0);
      if (first) jumpTo(first.id);
      toast({ title: "Bitte Eingaben prüfen", description: "Rot markierte Felder enthalten ungültige Werte.", tone: "warn" });
      return;
    }
    setSaving(true);
    setServerIssues([]);
    try {
      const res = await saveConfig(buildPatch(baseDraft, draft, password));
      setApiData("/api/config", res);
      revalidateApi("/api/status");
      setBase(res.config);
      setDraft(toDraft(res.config));
      setPassword({ mode: "keep" });
      setFormKey((k) => k + 1);
      toast(
        res.warning
          ? { title: "Einstellungen gespeichert", description: res.warning, tone: "warn", durationMs: 10_000 }
          : { title: "Einstellungen gespeichert", description: "Die Mess-Engine übernimmt die Änderungen sofort." },
      );
    } catch (e) {
      const parsed = e instanceof ApiFailure ? parseServerError(e.message, e.details) : [{ section: null, path: null, message: errorMessage(e) }];
      setServerIssues(parsed);
      const firstPath = parsed.find((p) => p.path)?.path;
      const target = firstPath ? sectionOfPath(firstPath) : undefined;
      if (target) jumpTo(target.id);
      toast({ title: "Speichern fehlgeschlagen", description: parsed[0]?.message ?? errorMessage(e), tone: "error" });
    } finally {
      setSaving(false);
    }
  };

  const body: Record<string, ReactNode> = {
    router: (
      <RouterSection
        value={draft.router}
        onChange={update("router")}
        password={password}
        onPasswordChange={setPassword}
        hasPassword={base.router.hasPassword}
        engineOnline={engineOnline}
        issues={issues}
      />
    ),
    tarif: <TariffSection value={draft.tariff} onChange={update("tariff")} issues={issues} />,
    langzeittest: <SessionSection value={draft.session} onChange={update("session")} />,
    spiele: <GamingSection value={draft.gaming} onChange={update("gaming")} issues={issues} />,
    zeitplaene: (
      <ScheduleSection
        schedules={draft.schedules}
        speedtest={draft.speedtest}
        udpBurst={draft.udpBurst}
        onSchedules={update("schedules")}
        onSpeedtest={update("speedtest")}
        onUdpBurst={update("udpBurst")}
        issues={issues}
      />
    ),
    messziele: <TargetsSection value={draft.targets} onChange={update("targets")} issues={issues} />,
    schwellen: <ThresholdsSection value={draft.thresholds} onChange={update("thresholds")} issues={issues} />,
    datenhaltung: <RetentionSection value={draft.retention} onChange={update("retention")} issues={issues} />,
    ereignisprotokoll: <EventLogSection value={draft.eventLog} onChange={update("eventLog")} issues={issues} engineOnline={engineOnline} />,
    darstellung: <AppearanceSection />,
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[13.5rem_minmax(0,1fr)]">
      <nav aria-label="Bereiche der Einstellungen" className="hidden lg:block">
        <ul className="sticky top-20 flex flex-col gap-0.5">
          {SECTIONS.map((s) => {
            const st = sectionState(s);
            return (
              <li key={s.id}>
                <a
                  href={`#${s.id}`}
                  onClick={(e) => {
                    e.preventDefault();
                    jumpTo(s.id);
                  }}
                  className="flex h-9 items-center gap-2 rounded-lg px-3 text-sm text-fg-2 hover:bg-raised hover:text-fg focus-visible:outline-2 focus-visible:outline-fiber"
                >
                  <span className="min-w-0 flex-1 truncate">{s.title}</span>
                  {st.errs + st.srv.length > 0 ? (
                    <OctagonAlert aria-label="enthält Fehler" className="size-3.5 shrink-0 text-crit" strokeWidth={2.25} />
                  ) : st.isDirty ? (
                    <span className="size-2 shrink-0 rounded-full bg-fiber" title="geändert">
                      <span className="sr-only">geändert</span>
                    </span>
                  ) : null}
                </a>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="flex min-w-0 flex-col gap-6" key={formKey}>
        {generalServerIssues.length > 0 && <ServerIssues issues={generalServerIssues} title="Die Einstellungen wurden nicht gespeichert:" />}
        {SECTIONS.map((s) => {
          const st = sectionState(s);
          return (
            <div key={s.id} id={s.id} className="scroll-mt-20">
              <Panel
                title={
                  <span className="flex flex-wrap items-center gap-2">
                    {s.title}
                    {st.isDirty && (
                      <span className="inline-flex h-5 items-center gap-1 rounded-full bg-fiber/12 px-2 text-2xs font-medium text-fiber ring-1 ring-inset ring-fiber/35">
                        <PencilLine aria-hidden className="size-3" strokeWidth={2.25} />
                        geändert
                      </span>
                    )}
                  </span>
                }
                description={s.description}
              >
                <ServerIssues issues={st.srv} />
                {body[s.id]}
              </Panel>
            </div>
          );
        })}

        <SaveBar dirty={dirty} saving={saving} errorCount={errorCount} changedCount={changed.length + (passwordChanged ? 1 : 0)} rejected={serverIssues.length > 0} onSave={() => void save()} onDiscard={discard} />
      </div>
    </div>
  );
}

interface SaveBarProps {
  dirty: boolean;
  saving: boolean;
  errorCount: number;
  changedCount: number;
  rejected: boolean;
  onSave: () => void;
  onDiscard: () => void;
}

function SaveBar({ dirty, saving, errorCount, changedCount, rejected, onSave, onDiscard }: SaveBarProps) {
  let icon: ReactNode;
  let text: ReactNode;
  if (errorCount > 0) {
    icon = <OctagonAlert aria-hidden className="size-4 shrink-0 text-crit" strokeWidth={2.25} />;
    text = (
      <>
        <span className="np-num">{errorCount}</span> {errorCount === 1 ? "Eingabe ist ungültig" : "Eingaben sind ungültig"} – bitte prüfen.
      </>
    );
  } else if (rejected) {
    icon = <OctagonAlert aria-hidden className="size-4 shrink-0 text-crit" strokeWidth={2.25} />;
    text = "Die API hat die Änderungen abgelehnt – siehe markierte Bereiche.";
  } else if (dirty) {
    icon = <PencilLine aria-hidden className="size-4 shrink-0 text-fiber" strokeWidth={2.25} />;
    text = (
      <>
        Ungespeicherte Änderungen in <span className="np-num">{changedCount}</span> {changedCount === 1 ? "Bereich" : "Bereichen"}.
      </>
    );
  } else {
    icon = <CircleCheck aria-hidden className="size-4 shrink-0 text-good" strokeWidth={2.25} />;
    text = "Alle Änderungen sind gespeichert.";
  }

  return (
    <div
      className={cn(
        "np-panel sticky bottom-4 z-10 flex flex-wrap items-center gap-3 px-4 py-3 transition-shadow",
        dirty && "shadow-overlay ring-1 ring-fiber/40",
      )}
      role="region"
      aria-label="Speichern"
    >
      <p className="flex min-w-0 flex-1 items-center gap-2 text-sm text-fg-2" aria-live="polite">
        {icon}
        <span className="min-w-0">{text}</span>
      </p>
      <div className="flex gap-2">
        <Button variant="ghost" icon={Undo2} disabled={!dirty || saving} onClick={onDiscard}>
          Verwerfen
        </Button>
        <Button variant="primary" icon={Save} loading={saving} disabled={!dirty} onClick={onSave}>
          Speichern
        </Button>
      </div>
    </div>
  );
}
