/** Reine Hilfsfunktionen der Seite „PC & Adapter“ (ohne React). */
import type { AdapterInfo, AdapterSnapshot, NetEvent } from "@/lib/shared/types";
import type { Severity } from "@/lib/health";

/* -------------------------------------------------------------------------- */
/* Adapter                                                                     */
/* -------------------------------------------------------------------------- */

export interface AdapterGroups {
  ethernet: AdapterInfo | null;
  wifi: AdapterInfo | null;
  /** weitere physische Adapter */
  otherPhysical: AdapterInfo[];
  virtual: AdapterInfo[];
}

export function groupAdapters(snap: AdapterSnapshot | null): AdapterGroups {
  const list = snap?.adapters ?? [];
  const physical = list.filter((a) => !a.isVirtual);
  const wired = physical.filter((a) => !a.isWifi);
  const primaryIf = snap?.routes.find((r) => r.family === 4)?.ifAlias ?? null;
  const score = (a: AdapterInfo) =>
    (a.name === primaryIf ? 4 : 0) + (/ethernet|\bLAN\b/i.test(a.name) || /ethernet/i.test(a.description) ? 2 : 0) + (a.status === "Up" ? 1 : 0);
  const ethernet = [...wired].sort((a, b) => score(b) - score(a))[0] ?? null;
  const wifi = physical.find((a) => a.isWifi) ?? null;
  return {
    ethernet,
    wifi,
    otherPhysical: physical.filter((a) => a !== ethernet && a !== wifi),
    virtual: list.filter((a) => a.isVirtual),
  };
}

/** NetAdapter-Treiber für Windows 11 (e2fn 2.1.x) bereits installiert? */
export function isNetAdapterDriver(a: AdapterInfo | null): boolean {
  if (!a) return false;
  if (a.serviceName && /^e2fn/i.test(a.serviceName)) return true;
  return a.driverVersion != null && /^2\.1\./.test(a.driverVersion) && /I22[56]/i.test(a.description);
}

export function isIntelI225(a: AdapterInfo | null): boolean {
  return a != null && /I22[56]/i.test(a.description);
}

export function adapterConnected(a: AdapterInfo): boolean {
  if (a.isWifi && a.mediaConnected != null) return a.mediaConnected;
  return a.status === "Up";
}

/** IPv4 zuerst, dann globale IPv6, link-lokale/APIPA zuletzt. */
export function sortAddresses(list: readonly string[]): { main: string[]; local: string[] } {
  const local = list.filter((x) => /^fe80:/i.test(x) || x.startsWith("169.254."));
  const main = list.filter((x) => !local.includes(x)).sort((a, b) => Number(a.includes(":")) - Number(b.includes(":")));
  return { main, local };
}

const STATUS_DE: Record<string, string> = {
  Up: "verbunden",
  Disconnected: "getrennt",
  Disabled: "deaktiviert",
  NotPresent: "nicht vorhanden",
  Dormant: "ruhend",
};

export function adapterStatusText(a: AdapterInfo): string {
  if (a.isWifi && a.mediaConnected != null) return a.mediaConnected ? "verbunden" : "getrennt";
  return STATUS_DE[a.status] ?? a.status;
}

/* -------------------------------------------------------------------------- */
/* Link-Ereignisse                                                             */
/* -------------------------------------------------------------------------- */

export type LinkCause = "boot" | "pre_sleep" | "router_reboot" | "runtime" | "unknown";

export const CAUSE_LABEL: Record<LinkCause, string> = {
  boot: "Start/Aufwachen",
  pre_sleep: "vor Standby",
  router_reboot: "Router-Neustart",
  runtime: "im Betrieb",
  unknown: "nicht eingeordnet",
};

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export interface LinkDropRow {
  key: string;
  ts: number;
  cause: LinkCause;
  downtimeMs: number | null;
  relinkMbps: number | null;
  wlanFailover: boolean | null;
  provider: string | null;
  severity: Severity;
}

export function linkDropRows(events: readonly NetEvent[]): LinkDropRow[] {
  return events
    .filter((e) => e.type === "nic_link_down")
    .map((e, i): LinkDropRow => {
      const d = e.details ?? {};
      const c = d.cause;
      const cause: LinkCause = c === "boot" || c === "pre_sleep" || c === "router_reboot" || c === "runtime" ? c : "unknown";
      const downtime = num(d.downtimeMs) ?? (e.endTs != null ? e.endTs - e.ts : null);
      return {
        key: `${e.id ?? i}-${e.ts}`,
        ts: e.ts,
        cause,
        downtimeMs: downtime,
        relinkMbps: num(d.relinkMbps),
        wlanFailover: typeof d.wlanFailover === "boolean" ? d.wlanFailover : null,
        provider: typeof d.provider === "string" ? d.provider : null,
        severity: cause === "runtime" ? "warn" : "info",
      };
    })
    .sort((a, b) => b.ts - a.ts);
}

/** Wiederaufbauten in Folge mit mindestens 1 Gbit/s (neueste zuerst gezählt). */
export function gigabitStreak(rows: readonly LinkDropRow[]): { streak: number; known: number } {
  let streak = 0;
  let known = 0;
  let broken = false;
  for (const r of rows) {
    if (r.relinkMbps == null) continue;
    known++;
    if (!broken && r.relinkMbps >= 1000) streak++;
    else broken = true;
  }
  return { streak, known };
}

/* -------------------------------------------------------------------------- */
/* Erweiterte Adapter-Eigenschaften                                            */
/* -------------------------------------------------------------------------- */

export interface AdvancedProp {
  name: string;
  value: string;
  keyword: string | null;
  registryValue: string | null;
}

/** Das Engine-Format liefert zusätzlich keyword/registryValue (nicht im Vertragstyp) – defensiv lesen. */
export function readAdvanced(list: AdapterSnapshot["advanced"] | null | undefined): AdvancedProp[] {
  return (list ?? []).map((p) => {
    const raw = p as unknown as Record<string, unknown>;
    const kw = typeof raw.keyword === "string" ? raw.keyword : p.name.startsWith("*") ? p.name : null;
    const rv = typeof raw.registryValue === "string" ? raw.registryValue : typeof raw.registryValue === "number" ? String(raw.registryValue) : null;
    return { name: p.name, value: p.value, keyword: kw, registryValue: rv };
  });
}

export interface PropAdvice {
  label: string;
  valueText: string;
  status: Severity | null;
  advice: string;
}

const KEYWORD_LABEL: Record<string, string> = {
  "*SelectiveSuspend": "Selective Suspend",
  "*SSIdleTimeout": "Selective Suspend – Wartezeit",
  IdleTimeoutMs: "Leerlauf-Wartezeit",
  "*DeviceSleepOnDisconnect": "Ruhezustand bei getrenntem Kabel",
  DMACoalescing: "DMA-Zusammenführung",
  EnableModernStandby: "Modern Standby",
  EnablePME: "Aufwecken (PME)",
  LogLinkStateEvent: "Link-Status protokollieren",
  MasterSlave: "Gigabit Master/Slave",
  WaitAutoNegComplete: "Auf Link warten",
  WakeOnLink: "Aufwecken bei Link",
  "*NumRssQueues": "RSS-Warteschlangen",
  "*SpeedDuplex": "Geschwindigkeit und Duplex",
  "*FlowControl": "Flusssteuerung",
  "*InterruptModeration": "Interrupt-Drosselung",
  ITR: "Interrupt-Drosselungsrate",
  "*JumboPacket": "Jumbo Packet",
  "*EEE": "Energieeffizientes Ethernet (EEE)",
  EEELinkAdvertisement: "Energieeffizientes Ethernet (EEE)",
  "*WakeOnMagicPacket": "Aufwecken über Magic Packet",
  "*WakeOnPattern": "Aufwecken bei Musterübereinstimmung",
};

const ON_RE = /^(1|aktiviert|aktiv|ein|an|enabled|on|true)$/i;
const OFF_RE = /^(0|deaktiviert|aus|disabled|off|false)$/i;

function isOn(p: AdvancedProp): boolean | null {
  if (p.registryValue === "1") return true;
  if (p.registryValue === "0") return false;
  if (ON_RE.test(p.value.trim())) return true;
  if (OFF_RE.test(p.value.trim())) return false;
  return null;
}

function onOffText(p: AdvancedProp): string {
  const on = isOn(p);
  if (on == null) return p.value;
  const looksRaw = /^\d+$/.test(p.value.trim());
  return looksRaw ? (on ? "aktiviert" : "deaktiviert") : p.value;
}

/** Bewertung + Empfehlung je Eigenschaft (Quelle: docs/research/environment.md §1.1). */
export function adviseProp(p: AdvancedProp): PropAdvice {
  const kw = p.keyword ?? "";
  const rawName = p.name === kw || p.name.startsWith("*");
  const label = rawName && KEYWORD_LABEL[kw] ? KEYWORD_LABEL[kw] : p.name;
  const name = `${p.name} ${kw}`;
  const base = { label, valueText: p.value };

  if (kw === "*SelectiveSuspend" || /selective suspend$/i.test(p.name)) {
    const on = isOn(p);
    return on
      ? { ...base, valueText: onOffText(p), status: "warn", advice: "Für den Testzeitraum ausschalten (Gerätemanager, Intel I225-V, Erweitert, „Selective Suspend“: Deaktiviert)." }
      : { ...base, valueText: onOffText(p), status: "good", advice: "Aus – passt." };
  }
  if (kw === "*SSIdleTimeout" || kw === "IdleTimeoutMs") {
    return { ...base, valueText: kw === "IdleTimeoutMs" ? `${p.value} ms` : `${p.value} s`, status: "info", advice: "Nur wirksam, solange Selective Suspend an ist." };
  }
  if (kw === "*SpeedDuplex" || /geschwindigkeit und duplex|speed ?& ?duplex/i.test(p.name)) {
    const auto = p.registryValue === "0" || /auto/i.test(p.value);
    return auto
      ? { ...base, status: "good", advice: "Automatische Aushandlung ist richtig für Gigabit. Nur für den Kabeltest kurz auf „1,0 Gbit/s Vollduplex“ stellen, danach zurück." }
      : { ...base, status: "warn", advice: "Fest eingestellt – zurück auf „Automatische Aushandlung“, außer du machst gerade den Kabeltest." };
  }
  if (kw === "LogLinkStateEvent") {
    const on = p.registryValue === "51" || /aktiv|enabled/i.test(p.value);
    return on
      ? { ...base, valueText: p.registryValue === "51" ? "aktiviert" : p.value, status: "good", advice: "Muss an bleiben – daraus liest Netzpuls die Link-Abbrüche." }
      : { ...base, status: "crit", advice: "Einschalten – sonst sieht Netzpuls keine Link-Abbrüche im Windows-Ereignisprotokoll." };
  }
  if (/\*?EEE|energieeffizient|green ethernet|ultra low power|energiespar|powersaving/i.test(name)) {
    const on = isOn(p);
    return on
      ? { ...base, valueText: onOffText(p), status: "warn", advice: "Ausschalten – Energiesparfunktionen können den Link kurz unterbrechen." }
      : { ...base, valueText: onOffText(p), status: on === false ? "good" : null, advice: on === false ? "Aus – passt." : "Sollte aus sein." };
  }
  if (kw === "*DeviceSleepOnDisconnect" || kw === "DMACoalescing") {
    const on = isOn(p);
    return on
      ? { ...base, valueText: onOffText(p), status: "warn", advice: "Ausschalten (Standard)." }
      : { ...base, valueText: onOffText(p), status: "good", advice: "Aus – passt." };
  }
  if (kw === "MasterSlave") {
    const auto = p.registryValue === "0" || /auto/i.test(p.value);
    return auto
      ? { ...base, valueText: "automatisch", status: "good", advice: "Nicht erzwingen." }
      : { ...base, status: "warn", advice: "Auf „Automatisch“ zurückstellen – erzwungen kann es zu Abbrüchen oder 100 Mbit/s führen." };
  }
  if (kw === "*JumboPacket") {
    const std = p.registryValue === "1514" || /1514|deaktiviert|disabled/i.test(p.value);
    return std
      ? { ...base, status: "good", advice: "Standard – passt." }
      : { ...base, status: "warn", advice: "Auf den Standard (1514) zurückstellen – größere Pakete bringen beim Spielen nichts." };
  }
  if (kw === "WakeOnLink") {
    const forced = p.registryValue === "2";
    return {
      ...base,
      valueText: forced ? "erzwungen" : p.registryValue === "0" ? "deaktiviert" : p.value,
      status: "info",
      advice: forced ? "Optional ausschalten (Nutzen unsicher)." : "Belassen.",
    };
  }
  if (kw === "WaitAutoNegComplete") return { ...base, valueText: p.registryValue === "2" ? "automatisch" : p.value, status: "info", advice: "Belassen – betrifft nur die Meldung beim Start." };
  if (kw === "*FlowControl") return { ...base, status: "info", advice: "Belassen." };
  if (kw === "*InterruptModeration" || kw === "ITR") return { ...base, status: "info", advice: "Belassen – beeinflusst den Link nicht." };
  if (kw === "EnablePME" || kw === "EnableModernStandby" || kw === "*WakeOnMagicPacket" || kw === "*WakeOnPattern" || /wake on|aufwecken|^akt\. /i.test(p.name)) {
    return { ...base, valueText: onOffText(p), status: "info", advice: "Belassen." };
  }
  return { ...base, valueText: /^\d+$/.test(p.value) && isOn(p) != null ? onOffText(p) : p.value, status: null, advice: "–" };
}

const ADVICE_RANK: Record<string, number> = { crit: 0, warn: 1, good: 2, info: 3, unknown: 4, none: 5 };
export function adviceRank(a: PropAdvice): number {
  return ADVICE_RANK[a.status ?? "none"];
}
