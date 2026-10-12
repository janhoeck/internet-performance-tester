"use client";

/**
 * NUR für /dev/ui: interaktive Vorschau-Inseln (Statusleisten-Zustände, Dialog, Meldungen,
 * Formulare, Zeitraum, Live-Diagramm mit Demodaten, Zustände von useApi/useLive).
 */
import { useMemo, useState } from "react";
import { Flag, Play, RefreshCw } from "lucide-react";
import type { StatusResponse } from "@/lib/shared/api-types";
import { fmtDateTimeShort, fmtTime } from "@/lib/format";
import { useNow } from "@/lib/use-now";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { ChoiceGroup, Field, Select, Switch, TextInput } from "@/components/ui/Field";
import { HealthBadge } from "@/components/ui/HealthBadge";
import { DataState } from "@/components/ui/States";
import { TimeRangePicker } from "@/components/ui/TimeRangePicker";
import { toast } from "@/components/ui/Toast";
import { SessionStartDialog, SessionStopDialog, type SessionControlFn } from "@/components/shell/SessionDialogs";
import { StatusBarView } from "@/components/shell/StatusBar";
import { EChart } from "@/components/viz/EChart";
import { heatmapOption, liveLatencyOption, bandThresholds } from "./charts";
import { DEMO_NOW, demoHeatmap, demoLiveSamples, demoSession } from "./demo-data";
import { reconnectLive, useLiveConnection, useLiveSampleMap, useSession } from "./live-store";
import { seriesTargets, useTargets } from "./targets";
import { useApi } from "./use-api";
import { useTimeRange } from "./use-time-range";

const previewToast = (what: string) => () => toast({ title: `Vorschau: ${what}`, tone: "info", durationMs: 2500 });

/** Statusleiste in allen Zuständen (Daten = Demo, Zeit = echt). */
export function StatusBarPreview() {
  const now = useNow(1000);
  const session = now != null ? demoSession(now) : null;
  const variants = [
    { key: "running", label: "Langzeittest läuft", engine: "running" as const, session, health: "crit" as const, next: now != null ? now + 12 * 60_000 : null },
    { key: "ready", label: "Bereit, kein Test", engine: "ready" as const, session: null, health: "unknown" as const, next: null },
    { key: "offline", label: "Engine nicht erreichbar", engine: "offline" as const, session: null, health: "unknown" as const, next: null },
    { key: "connecting", label: "Verbindungsaufbau", engine: "connecting" as const, session: null, health: "unknown" as const, next: null },
  ];
  return (
    <div className="flex flex-col gap-3">
      {variants.map((v) => (
        <div key={v.key} className="overflow-hidden rounded-xl ring-1 ring-line">
          <p className="bg-sunken px-3 py-1 text-2xs text-fg-3">{v.label}</p>
          <StatusBarView
            className="static"
            engine={v.engine}
            session={v.session}
            now={now}
            nextSpeedtestTs={v.next}
            health={v.health}
            onStart={previewToast("Langzeittest starten")}
            onStop={previewToast("Langzeittest beenden")}
            onMarkLag={previewToast("Lag markieren")}
          />
        </div>
      ))}
    </div>
  );
}

/** liveLatencyOption() mit Demo-Ringpuffern (ohne Engine). */
export function LiveDemoChart() {
  const now = useNow(1000);
  const { targets, config } = useTargets();
  const series = useMemo(() => seriesTargets(["gw", "isp6", "cf4"], targets), [targets]);
  const thresholds = useMemo(() => bandThresholds(config?.thresholds.latency.internet ?? { good: 40, warn: 80 }), [config]);
  const option = useMemo(() => {
    if (now == null) return null;
    return liveLatencyOption(demoLiveSamples(now), { targets: series, now, windowMs: 5 * 60_000, thresholds });
  }, [now, series, thresholds]);
  if (!option) return <div style={{ height: 240 }} />;
  return <EChart option={option} ariaLabel="Demo: Live-Latenz der letzten 5 Minuten" height={240} replaceMerge={["series"]} />;
}

/** heatmapOption() – ECharts-Variante mit Schraffur für Stunden ohne Messung. */
export function HeatmapEChartDemo() {
  const option = useMemo(() => heatmapOption(demoHeatmap()), []);
  return <EChart option={option} ariaLabel="Demo: Paketverlust je Stunde und Tag" height={420} />;
}

/** Zustand der echten Live-/API-Anbindung (hilft beim Prüfen der Engine-Verbindung). */
export function ConnectionProbe() {
  const conn = useLiveConnection();
  const session = useSession();
  const samples = useLiveSampleMap();
  const status = useApi<StatusResponse>("/api/status", { refreshMs: 10_000 });
  const targetsWithData = Object.entries(samples).filter(([, s]) => s.length > 0);
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
      <dt className="text-fg-3">Live-Stream</dt>
      <dd className="flex flex-wrap items-center gap-2">
        <HealthBadge size="sm" status={conn.online ? "good" : conn.status === "idle" || conn.status === "connecting" ? "unknown" : "crit"} label={conn.status} />
        {conn.error && <span className="text-xs text-fg-3">{conn.error}</span>}
        <Button size="sm" variant="ghost" icon={RefreshCw} onClick={reconnectLive}>
          Neu verbinden
        </Button>
      </dd>
      <dt className="text-fg-3">Langzeittest</dt>
      <dd className="np-num text-fg-2">{session ? `#${session.id} seit ${fmtDateTimeShort(session.startedAt)}` : "–"}</dd>
      <dt className="text-fg-3">Ringpuffer</dt>
      <dd className="np-num text-fg-2">
        {targetsWithData.length ? targetsWithData.map(([id, s]) => `${id}: ${s.length}`).join(" · ") : "keine Live-Samples"}
      </dd>
      <dt className="text-fg-3">/api/status</dt>
      <dd className="np-num text-fg-2">
        {status.loading && !status.data ? "lädt …" : status.error ? `Fehler: ${status.error.message}` : status.data ? `ok – Engine ${status.data.engineOnline ? "online" : "offline"}` : "–"}
      </dd>
    </dl>
  );
}

/** DataState in allen Zuständen. */
export function DataStatePreview() {
  const reload = () => toast({ title: "Vorschau: Erneut versuchen", tone: "info", durationMs: 2500 });
  const sample = { rows: 3 };
  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
      {[
        { key: "loading", title: "Erstes Laden", result: { data: null, error: null, loading: true } },
        { key: "error", title: "Fehler ohne Daten", result: { data: null, error: { message: "Schnittstelle nicht gefunden (wird evtl. noch gebaut)." }, loading: false, reload } },
        { key: "empty", title: "Leer", result: { data: { rows: 0 }, error: null, loading: false } },
        { key: "stale", title: "Nachladen (alte Daten gedimmt)", result: { data: sample, error: null, loading: true, stale: true } },
      ].map((v) => (
        <div key={v.key} className="np-panel p-4">
          <p className="mb-2 text-xs text-fg-3">{v.title}</p>
          <DataState
            result={v.result}
            height={160}
            isEmpty={(d) => d.rows === 0}
            emptyTitle="Keine Ereignisse in diesem Zeitraum"
          >
            {(d) => (
              <div className="grid h-40 place-items-center rounded-[10px] bg-sunken/60 text-sm text-fg-2 ring-1 ring-inset ring-line">
                {d.rows} Zeilen geladen
              </div>
            )}
          </DataState>
        </div>
      ))}
    </div>
  );
}

const DURATION_OPTIONS = [
  { value: "1h", label: "1 h" },
  { value: "24h", label: "24 h", hint: "mindestens" },
  { value: "72h", label: "72 h", hint: "empfohlen" },
] as const;
type DemoDuration = (typeof DURATION_OPTIONS)[number]["value"];

/** Vorschau-Steuerung: berührt die echte Mess-Engine nie (kurze Verzögerung, dann ok). */
const previewControl: SessionControlFn = (action) =>
  new Promise((resolve) => setTimeout(() => resolve({ ok: true, result: { preview: true, action } }), 800));

/** Formulare, Dialog, Meldungen, Zeitraum. */
export function InteractivePreview() {
  const [open, setOpen] = useState(false);
  const [sessionDialog, setSessionDialog] = useState<"start" | "stop" | null>(null);
  const [name, setName] = useState("");
  const [duration, setDuration] = useState<DemoDuration>("72h");
  const [adapter, setAdapter] = useState("auto");
  const [sleep, setSleep] = useState(true);
  const range = useTimeRange({ defaultPreset: "24h", param: "demo" });

  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-2 [&>*]:min-w-0">
      <div className="np-panel flex flex-col gap-4 p-5">
        <h3 className="text-lg font-medium text-fg">Formular-Bausteine</h3>
        <Field label="Router-Adresse" htmlFor="demo-ip" hint="Nur private Adressen, z. B. 192.168.0.1.">
          <TextInput id="demo-ip" defaultValue="192.168.0.1" inputMode="decimal" aria-describedby="demo-ip-hint" />
        </Field>
        <Field label="Bezeichnung" htmlFor="demo-name" optional error={name.length > 20 ? "Höchstens 20 Zeichen." : undefined}>
          <TextInput id="demo-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="z. B. Neues LAN-Kabel" aria-invalid={name.length > 20 || undefined} />
        </Field>
        <Field label="Router-Typ" htmlFor="demo-adapter">
          <Select id="demo-adapter" value={adapter} onChange={(e) => setAdapter(e.target.value)}>
            <option value="auto">Automatisch erkennen</option>
            <option value="arris-vodafone-station">Vodafone Station (ARRIS)</option>
            <option value="generic">Anderer Router</option>
          </Select>
        </Field>
        <ChoiceGroup name="demo-duration" legend="Dauer" options={DURATION_OPTIONS} value={duration} onChange={setDuration} />
        <Switch id="demo-sleep" label="Standby während des Tests verhindern" hint="Ohne Administratorrechte, endet mit dem Test." checked={sleep} onChange={(e) => setSleep(e.target.checked)} />
      </div>

      <div className="flex flex-col gap-4">
        <div className="np-panel flex flex-col gap-3 p-5">
          <h3 className="text-lg font-medium text-fg">Dialog & Meldungen</h3>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={() => setSessionDialog("start")}>
              Start-Dialog (Vorschau)
            </Button>
            <Button size="sm" onClick={() => setSessionDialog("stop")}>
              Stopp-Dialog (Vorschau)
            </Button>
            <span className="text-xs text-warn">Diese beiden senden echte Befehle an die Mess-Engine.</span>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" icon={Play} onClick={() => setOpen(true)}>
              Dialog öffnen
            </Button>
            <Button icon={Flag} onClick={() => toast({ title: `Lag markiert – ${fmtTime(1760026933000)}` })}>
              Erfolg
            </Button>
            <Button onClick={() => toast({ title: "Speedtest gestartet", description: "Dauert etwa 45 Sekunden.", tone: "info" })}>Hinweis</Button>
            <Button onClick={() => toast({ title: "Router-Anmeldung gesperrt", description: "Neuer Versuch in 2 Minuten möglich.", tone: "warn" })}>Warnung</Button>
            <Button variant="danger" onClick={() => toast({ title: "Speichern fehlgeschlagen", description: "Mess-Engine nicht erreichbar.", tone: "error" })}>
              Fehler
            </Button>
          </div>
        </div>
        <div className="np-panel flex flex-col gap-3 p-5">
          <h3 className="text-lg font-medium text-fg">Zeitraum (URL-Parameter „demo“)</h3>
          <TimeRangePicker range={range} />
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm">
            <dt className="text-fg-3">Anzeige</dt>
            <dd className="text-fg-2">{range.label}</dd>
            <dt className="text-fg-3">Von – bis</dt>
            <dd className="np-num text-fg-2">{range.from != null && range.to != null ? `${fmtDateTimeShort(range.from)} – ${fmtDateTimeShort(range.to)}` : "–"}</dd>
            <dt className="text-fg-3">API-Query</dt>
            <dd className="np-num break-all text-xs text-fg-3">{range.query ?? "–"}</dd>
          </dl>
        </div>
      </div>

      {sessionDialog === "start" && <SessionStartDialog onClose={() => setSessionDialog(null)} control={previewControl} />}
      {sessionDialog === "stop" && (
        <SessionStopDialog onClose={() => setSessionDialog(null)} session={demoSession(DEMO_NOW)} now={DEMO_NOW} control={previewControl} />
      )}
      {open && (
        <Dialog
          open
          onClose={() => setOpen(false)}
          title="Messdaten löschen?"
          description="Messdaten älter als 30 Tage löschen? Das lässt sich nicht rückgängig machen."
          size="sm"
          footer={
            <>
              <Button variant="ghost" onClick={() => setOpen(false)}>
                Abbrechen
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  setOpen(false);
                  toast({ title: "Vorschau: nichts gelöscht", tone: "info" });
                }}
              >
                Löschen
              </Button>
            </>
          }
        />
      )}
    </div>
  );
}
