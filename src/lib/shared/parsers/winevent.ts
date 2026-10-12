// Windows event log: pure parsing of `wevtutil qe <log> /f:xml` output, mapping to NetEvents and the
// classification of NIC link drops (docs/ARCHITECTURE.md §4.9, docs/research/environment.md §1.3–1.4,
// docs/research/critique.md §7.5–7.6). Language independent: only provider names, event IDs,
// EventData names and numbers are evaluated – never the localized message texts. No Node built-ins.
import { fmtDuration } from '../format';
import type { NetEvent, Segment, Severity } from '../types';

// ─── logs, providers, queries ───────────────────────────────────────────────

export const LOG_SYSTEM = 'System';
export const LOG_WLAN = 'Microsoft-Windows-WLAN-AutoConfig/Operational';
export const LOG_NCSI = 'Microsoft-Windows-NCSI/Operational';
export const EVENT_LOGS = [LOG_SYSTEM, LOG_WLAN, LOG_NCSI] as const;
export type EventLogName = (typeof EVENT_LOGS)[number];

/**
 * Intel NDIS/NetAdapter drivers sharing the e1/e2 message table (27 link down, 32 up 1 Gbit/s …).
 * e2fexpress = legacy I225 driver on this PC, e2fnexpress = Windows-11 NetAdapter driver (active since
 * the driver update on 2026-10-09), e2f68 = older variant. The e1* names (I21x) are included on the
 * assumption that they use the same IDs [uncertain – not present on this PC].
 */
export const INTEL_NIC_PROVIDERS = [
  'e2fexpress', 'e2fnexpress', 'e2f68', 'e1dexpress', 'e1iexpress', 'e1rexpress', 'e1cexpress', 'e1qexpress',
] as const;

const INTEL_SET = new Set<string>(INTEL_NIC_PROVIDERS);
export const isIntelNicProvider = (provider: string): boolean => INTEL_SET.has(provider.toLowerCase());

const P_EVENTLOG = 'eventlog';
const P_KBOOT = 'microsoft-windows-kernel-boot';
const P_KGENERAL = 'microsoft-windows-kernel-general';
const P_KPOWER = 'microsoft-windows-kernel-power';
const P_PTROUBLE = 'microsoft-windows-power-troubleshooter';
const P_TCPIP = 'tcpip';
const P_SCM = 'service control manager';
const P_WLAN = 'microsoft-windows-wlan-autoconfig';
const P_NCSI = 'microsoft-windows-ncsi';

/**
 * XPath selector for the System log: Intel NIC providers (all IDs – they only log link related
 * events), boot/shutdown/sleep/resume markers, address conflicts and installed services (NIC driver
 * updates reset the link). EventLog 6013 is deliberately not used: it is also logged daily at 12:00.
 */
export const SYSTEM_SELECTOR = [
  `(Provider[${INTEL_NIC_PROVIDERS.map((p) => `@Name='${p}'`).join(' or ')}])`,
  "(Provider[@Name='EventLog'] and (EventID=6005 or EventID=6006 or EventID=6008))",
  "(Provider[@Name='Microsoft-Windows-Kernel-Boot'] and EventID=27)",
  "(Provider[@Name='Microsoft-Windows-Kernel-General'] and (EventID=12 or EventID=13))",
  "(Provider[@Name='Microsoft-Windows-Power-Troubleshooter'] and EventID=1)",
  "(Provider[@Name='Microsoft-Windows-Kernel-Power'] and (EventID=41 or EventID=42 or EventID=107 or EventID=109 or EventID=506 or EventID=507))",
  "(Provider[@Name='Tcpip'] and EventID=4199)",
  "(Provider[@Name='Service Control Manager'] and EventID=7045)",
].join(' or ');

export const LOG_SELECTORS: Record<EventLogName, string> = {
  [LOG_SYSTEM]: SYSTEM_SELECTOR,
  [LOG_WLAN]: 'EventID=8001 or EventID=8002 or EventID=8003',
  [LOG_NCSI]: 'EventID=4042',
};

/** XPath for `wevtutil qe /q:` – records after a cursor and/or younger than `maxAgeMs`. */
export function buildEventQuery(selector: string, opts: { afterRecordId?: number | null; maxAgeMs?: number | null } = {}): string {
  const parts = [`(${selector})`];
  if (opts.afterRecordId !== undefined && opts.afterRecordId !== null && opts.afterRecordId > 0) {
    parts.push(`(EventRecordID > ${Math.floor(opts.afterRecordId)})`);
  }
  if (opts.maxAgeMs !== undefined && opts.maxAgeMs !== null && opts.maxAgeMs > 0) {
    parts.push(`TimeCreated[timediff(@SystemTime) <= ${Math.floor(opts.maxAgeMs)}]`);
  }
  return `*[System[${parts.join(' and ')}]]`;
}

// ─── XML parsing ────────────────────────────────────────────────────────────

export interface WinEvent {
  /** channel, e.g. 'System' */
  log: string;
  provider: string;
  id: number;
  recordId: number;
  /** TimeCreated/@SystemTime as epoch ms */
  ts: number;
  level: number | null;
  /** <Data Name='x'> values; unnamed <Data> elements as p<position> (like ConvertTo-EvRow) */
  data: Record<string, string>;
}

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

export function decodeXmlEntities(s: string): string {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, ent: string) => {
    if (ent[0] === '#') {
      const code = ent[1] === 'x' || ent[1] === 'X' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[ent] ?? m;
  });
}

/** '2026-10-09T13:26:34.0708350Z' → epoch ms (fraction truncated to ms); null if invalid */
export function parseSystemTime(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})?$/.exec(s.trim());
  if (!m) return null;
  const ms = m[7] ? Number(`${m[7]}00`.slice(0, 3)) : 0;
  let t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]), ms);
  const tz = m[8];
  if (tz && tz !== 'Z') {
    const sign = tz[0] === '-' ? -1 : 1;
    const digits = tz.slice(1).replace(':', '');
    t -= sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4))) * 60_000;
  }
  return Number.isFinite(t) ? t : null;
}

function attr(tagText: string, name: string): string | null {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:'([^']*)'|"([^"]*)")`).exec(tagText);
  if (!m) return null;
  return decodeXmlEntities(m[1] ?? m[2] ?? '');
}

function element(xml: string, name: string): string | null {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([^<]*)</${name}>`).exec(xml);
  return m ? decodeXmlEntities(m[1]) : null;
}

function parseData(block: string): Record<string, string> {
  const data: Record<string, string> = {};
  const ed = /<EventData(?:\s[^>]*)?>([\s\S]*?)<\/EventData>/.exec(block);
  if (ed) {
    const re = /<Data(\s[^>]*?)?(?:\/>|>([\s\S]*?)<\/Data>)/g;
    let m: RegExpExecArray | null;
    let i = 0;
    while ((m = re.exec(ed[1])) !== null) {
      const name = m[1] ? attr(m[1], 'Name') : null;
      data[name && name !== '' ? name : `p${i}`] = decodeXmlEntities(m[2] ?? '');
      i++;
    }
    return data;
  }
  // UserData: arbitrary schema – keep the leaf elements by name
  const ud = /<UserData>([\s\S]*?)<\/UserData>/.exec(block);
  if (ud) {
    const re = /<([A-Za-z_][\w.-]*)(?:\s[^>]*)?>([^<]*)<\/\1>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(ud[1])) !== null) data[m[1]] = decodeXmlEntities(m[2]);
  }
  return data;
}

/** Parses the concatenated `<Event>` elements printed by `wevtutil qe … /f:xml` (optionally inside `<Events>`). */
export function parseWevtutilXml(xml: string): WinEvent[] {
  const out: WinEvent[] = [];
  const re = /<Event[\s>][\s\S]*?<\/Event>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const block = m[0];
    const sys = /<System>([\s\S]*?)<\/System>/.exec(block)?.[1];
    if (!sys) continue;
    const providerTag = /<Provider\s[^>]*>/.exec(sys)?.[0] ?? '';
    const provider = attr(providerTag, 'Name') ?? '';
    const id = Number(element(sys, 'EventID'));
    const recordId = Number(element(sys, 'EventRecordID'));
    const timeTag = /<TimeCreated\s[^>]*>/.exec(sys)?.[0] ?? '';
    const ts = parseSystemTime(attr(timeTag, 'SystemTime'));
    if (!provider || !Number.isFinite(id) || !Number.isFinite(recordId) || ts === null) continue;
    const levelText = element(sys, 'Level');
    const level = levelText !== null && levelText !== '' ? Number(levelText) : null;
    out.push({
      log: element(sys, 'Channel') ?? '',
      provider,
      id,
      recordId,
      ts,
      level: level !== null && Number.isFinite(level) ? level : null,
      data: parseData(block),
    });
  }
  return out;
}

/** wevtutil `/uni:true` output (UTF-16LE, optional BOM) → string */
export function decodeUtf16le(bytes: Uint8Array): string {
  return new TextDecoder('utf-16le').decode(bytes).replace(/^﻿/, '');
}

export const eventDedupeKey = (e: Pick<WinEvent, 'log' | 'recordId'>): string => `evtlog:${e.log}:${e.recordId}`;

export const byTime = (a: WinEvent, b: WinEvent): number => a.ts - b.ts || a.recordId - b.recordId;

// ─── event kinds ────────────────────────────────────────────────────────────

/** Intel link-up IDs → speed (Mbit/s) and duplex. */
const INTEL_UP: Record<number, { mbps: number; duplex: 'full' | 'half' }> = {
  31: { mbps: 10_000, duplex: 'full' },
  32: { mbps: 1000, duplex: 'full' },
  33: { mbps: 100, duplex: 'full' },
  34: { mbps: 100, duplex: 'half' },
  35: { mbps: 10, duplex: 'full' },
  36: { mbps: 10, duplex: 'half' },
  57: { mbps: 2500, duplex: 'full' },
  62: { mbps: 5000, duplex: 'full' },
};

/** Other Intel IDs worth an adapter_change event (e2fmsg.dll message table). */
const INTEL_OTHER: Record<number, { title: string; severity: Severity }> = {
  28: { title: 'Netzwerkadapter wechselt in den Energiesparzustand', severity: 'info' },
  29: { title: 'Netzwerkadapter hat den Energiesparzustand verlassen', severity: 'info' },
  30: { title: 'Gegenstelle ohne automatische Aushandlung – möglicher Duplex-Konflikt', severity: 'warn' },
  37: { title: 'PCIe-Bandbreite für den Netzwerkadapter unzureichend', severity: 'warn' },
  40: { title: 'Intel SmartSpeed hat die Link-Geschwindigkeit herabgestuft', severity: 'warn' },
  41: { title: 'Netzwerkadaptertreiber wurde gestoppt', severity: 'info' },
  42: { title: 'Netzwerkadaptertreiber wurde gestartet', severity: 'info' },
  50: { title: 'Netzwerkadapter wegen Überhitzung gestoppt', severity: 'critical' },
  51: { title: 'Link-Geschwindigkeit wegen Überhitzung verringert', severity: 'critical' },
  52: { title: 'Netzwerkadapter wegen Überhitzung gestoppt', severity: 'critical' },
  56: { title: 'Netzwerkadapter wurde entfernt', severity: 'warn' },
  65: { title: 'PCIe-Bandbreite für den Netzwerkadapter unzureichend', severity: 'warn' },
  66: { title: 'PCIe-Bandbreite für den Netzwerkadapter unzureichend', severity: 'warn' },
  82: { title: 'Gewählte Link-Geschwindigkeit nicht unterstützt – automatische Aushandlung aktiv', severity: 'warn' },
};

export type LinkKind = { kind: 'down' } | { kind: 'up'; mbps: number; duplex: 'full' | 'half' } | null;

/** Link down/up of an Intel NIC event, null for everything else. */
export function linkKindOf(e: WinEvent): LinkKind {
  if (!isIntelNicProvider(e.provider)) return null;
  if (e.id === 27) return { kind: 'down' };
  const up = INTEL_UP[e.id];
  return up ? { kind: 'up', ...up } : null;
}

/** 'inactive' = the wired link carried no connectivity before the drop (e.g. adapter re-enabled) – derived from NCSI */
export type MarkerKind = 'boot' | 'resume' | 'shutdown' | 'sleep' | 'driver' | 'inactive';

const NIC_DRIVER_SERVICE = /e2f|e1[a-z]?express|netwtw|ethernet|netadapter|network connection|wi-?fi|wireless|wlan|rtl8|rt640|killer/i;

/** 7045 "service installed" for a network driver (a driver update resets the link). */
export function isNicDriverInstall(e: WinEvent): boolean {
  if (e.provider.toLowerCase() !== P_SCM || e.id !== 7045) return false;
  const text = `${e.data.ServiceName ?? ''} ${e.data.ImagePath ?? ''}`;
  return NIC_DRIVER_SERVICE.test(text);
}

/** Boot/shutdown/sleep/resume/driver-(re)start marker kind of a System event, or null. */
export function markerOf(e: WinEvent): MarkerKind | null {
  const p = e.provider.toLowerCase();
  switch (p) {
    case P_EVENTLOG:
      if (e.id === 6005 || e.id === 6008) return 'boot';
      if (e.id === 6006) return 'shutdown';
      return null;
    case P_KBOOT:
      return e.id === 27 ? 'boot' : null;
    case P_KGENERAL:
      if (e.id === 12) return 'boot';
      if (e.id === 13) return 'shutdown';
      return null;
    case P_PTROUBLE:
      return e.id === 1 ? 'resume' : null;
    case P_KPOWER:
      if (e.id === 42 || e.id === 506) return 'sleep';
      if (e.id === 107 || e.id === 507) return 'resume';
      if (e.id === 41) return 'boot';
      if (e.id === 109) return 'shutdown';
      return null;
    default:
      if (isIntelNicProvider(e.provider) && (e.id === 41 || e.id === 42)) return 'driver';
      if (isNicDriverInstall(e)) return 'driver';
      return null;
  }
}

export interface NcsiChange {
  ts: number;
  guid: string | null;
  /** 0 = IPv4, 1 = IPv6 */
  family: number | null;
  /** 0 none, 1 local, 2 internet */
  capability: number;
  previous: number | null;
}

export function ncsiChangeOf(e: WinEvent): NcsiChange | null {
  if (e.provider.toLowerCase() !== P_NCSI || e.id !== 4042) return null;
  const cap = Number(e.data.Capability);
  if (!Number.isFinite(cap) || e.data.Capability === undefined) return null;
  const num = (v: string | undefined) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
  return {
    ts: e.ts,
    guid: e.data.InterfaceGuid ? e.data.InterfaceGuid.toLowerCase() : null,
    family: num(e.data.Family),
    capability: cap,
    previous: num(e.data.PreviousCapability),
  };
}

export type WlanEventKind = 'connected' | 'failed' | 'disconnected';

export function wlanKindOf(e: WinEvent): WlanEventKind | null {
  if (e.provider.toLowerCase() !== P_WLAN) return null;
  if (e.id === 8001) return 'connected';
  if (e.id === 8002) return 'failed';
  if (e.id === 8003) return 'disconnected';
  return null;
}

/** WLAN 8002 ReasonCode: connection failed because no connectable access point was visible. */
export const WLAN_REASON_NO_AP = '229396';
/** WLAN 8003 ReasonCode: soft disconnect by policy (the wired connection is back). */
export const WLAN_REASON_POLICY = '5';

// ─── link drop classification ───────────────────────────────────────────────

export type LinkCause = 'boot' | 'pre_sleep' | 'router_reboot' | 'runtime';

export const LINK_RULES = {
  /** |down − boot/resume/shutdown/driver marker| ≤ this → 'boot' */
  markerWindowMs: 30_000,
  /** down − sleep marker (Kernel-Power 42/506) within [−120 s, +60 s] → 'pre_sleep' */
  preSleepBeforeMs: 120_000,
  preSleepAfterMs: 60_000,
  /** internet back later than this … */
  rebootInternetMs: 120_000,
  /** … and WLAN 8002 ReasonCode 229396 within this window … */
  rebootNoApWindowMs: 240_000,
  /** … or ≥ 2 more link downs within this window → 'router_reboot' */
  rebootMoreDownsWindowMs: 180_000,
  rebootMoreDowns: 2,
  /** WLAN 8001 within this time after the down → wlanFailover */
  failoverWindowMs: 5000,
  /** a link-up later than this does not belong to the down */
  relinkMaxMs: 10 * 60_000,
  /** NCSI: the internet loss must be logged within [down − 5 s, down + 60 s] */
  ncsiLossBeforeMs: 5000,
  ncsiLossAfterMs: 60_000,
  /** NCSI: recovery is searched up to this long after the down */
  ncsiRecoveryMaxMs: 30 * 60_000,
  /** wired interface without any connectivity (NCSI capability 0) for at least this long before the drop → 'inactive' */
  inactiveMinMs: 120_000,
  /** a classification is final once the down is older than this (all look-ahead windows passed) */
  finalAfterMs: 10 * 60_000,
} as const;

export interface InternetRecovery {
  /** first time the internet answered again (≥ down), null = not yet seen */
  recoveredTs: number | null;
  /** data covers the time up to here (lower bound for an ongoing outage) */
  coveredUntil: number;
}

export interface ClassifyOptions {
  now: number;
  /** WLAN-AutoConfig log readable (otherwise wlanFailover is null instead of false) */
  wlanLogAvailable?: boolean;
  /** live internet reachability from the engine's own samples (preferred over NCSI when it has data) */
  internetRecovery?: (downTs: number) => InternetRecovery | null;
  /** NCSI interface GUIDs of the wired adapters (adapters snapshot) – enables the 'inactive' rule */
  wiredGuids?: readonly string[];
}

export interface LinkMarkerRef {
  kind: MarkerKind;
  provider: string;
  id: number;
  /** down − marker */
  deltaMs: number;
}

export interface LinkDropAnalysis {
  down: WinEvent;
  up: WinEvent | null;
  relinkMbps: number | null;
  duplex: 'full' | 'half' | null;
  downtimeMs: number | null;
  cause: LinkCause;
  marker: LinkMarkerRef | null;
  wlanFailover: boolean | null;
  /** WLAN was already connected when the link went down (traffic moved without a new connect) */
  wlanAlreadyConnected: boolean;
  /** time until the internet answered again (any interface); null = unknown / no loss seen */
  internetDownMs: number | null;
  /** internetDownMs is only a lower bound (outage still ongoing at analysis time) */
  internetOngoing: boolean;
  internetSource: 'samples' | 'ncsi' | null;
  /** further link downs within 180 s */
  moreDowns: number;
  /** WLAN 8002 "no access point visible" within 240 s */
  noAccessPoint: boolean;
  /** record id of the first down of the router-reboot episode this down was merged into */
  mergedInto: number | null;
  /** all look-ahead windows have passed – the result will not change anymore */
  final: boolean;
}

function lowerBound<T>(arr: readonly T[], ts: number, key: (x: T) => number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (key(arr[mid]) < ts) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function inWindow<T>(arr: readonly T[], from: number, to: number, key: (x: T) => number): T[] {
  const out: T[] = [];
  for (let i = lowerBound(arr, from, key); i < arr.length && key(arr[i]) <= to; i++) out.push(arr[i]);
  return out;
}

const ncsiTs = (c: NcsiChange) => c.ts;
const normGuid = (g: string) => g.replace(/[{}]/g, '').trim().toLowerCase();

/** last NCSI state of a wired interface before the drop when it had no connectivity at all for ≥ 120 s */
function inactiveWired(ncsi: readonly NcsiChange[], wired: ReadonlySet<string>, downTs: number): NcsiChange | null {
  if (wired.size === 0) return null;
  let last: NcsiChange | null = null;
  const end = lowerBound(ncsi, downTs - LINK_RULES.ncsiLossBeforeMs, ncsiTs);
  for (let i = end - 1; i >= 0; i--) {
    const c = ncsi[i];
    if (c.guid && wired.has(normGuid(c.guid))) {
      last = c;
      break;
    }
  }
  return last && last.capability === 0 && downTs - last.ts >= LINK_RULES.inactiveMinMs ? last : null;
}

function ncsiRecovery(ncsi: readonly NcsiChange[], downTs: number, now: number): { ms: number | null; ongoing: boolean } | null {
  const R = LINK_RULES;
  const loss = inWindow(ncsi, downTs - R.ncsiLossBeforeMs, downTs + R.ncsiLossAfterMs, ncsiTs).find(
    (c) => c.previous === 2 && c.capability < 2,
  );
  if (!loss) return null; // NCSI never saw the internet go away
  for (let i = lowerBound(ncsi, loss.ts, ncsiTs); i < ncsi.length; i++) {
    const c = ncsi[i];
    if (c.ts - downTs > R.ncsiRecoveryMaxMs) break;
    if (c.ts >= loss.ts && c !== loss && c.capability === 2) return { ms: Math.max(0, c.ts - downTs), ongoing: false };
  }
  if (now - downTs <= R.ncsiRecoveryMaxMs) return { ms: Math.max(0, now - downTs), ongoing: true };
  return null;
}

/**
 * Analyses every Intel link-down in `events` (any mix of System, WLAN and NCSI events, any order).
 * Rules (first match wins): boot/resume/shutdown/driver marker within ±30 s → 'boot'; Kernel-Power
 * 42/506 within [−120 s, +60 s] → 'pre_sleep'; internet back after > 120 s together with WLAN 8002
 * ReasonCode 229396 within 240 s or ≥ 2 more downs within 180 s (or inside such an episode) →
 * 'router_reboot'; otherwise 'runtime'.
 */
export function analyzeLinkDrops(events: readonly WinEvent[], opts: ClassifyOptions): LinkDropAnalysis[] {
  const R = LINK_RULES;
  const sorted = [...events].sort(byTime);
  const links: { e: WinEvent; kind: NonNullable<LinkKind> }[] = [];
  const markers: { e: WinEvent; kind: MarkerKind }[] = [];
  const wlan: { e: WinEvent; kind: WlanEventKind }[] = [];
  const ncsi: NcsiChange[] = [];
  for (const e of sorted) {
    const lk = linkKindOf(e);
    if (lk) {
      links.push({ e, kind: lk });
      continue;
    }
    const mk = markerOf(e);
    if (mk) {
      markers.push({ e, kind: mk });
      continue;
    }
    const wk = wlanKindOf(e);
    if (wk) {
      wlan.push({ e, kind: wk });
      continue;
    }
    const nc = ncsiChangeOf(e);
    if (nc) ncsi.push(nc);
  }
  const downs = links.filter((l) => l.kind.kind === 'down');
  const wired = new Set((opts.wiredGuids ?? []).map(normGuid).filter((g) => g !== ''));
  const out: LinkDropAnalysis[] = [];
  let episode: { recordId: number; until: number } | null = null;

  for (let i = 0; i < links.length; i++) {
    const { e: down, kind } = links[i];
    if (kind.kind !== 'down') continue;

    // matching link-up: next up before the next down (within 10 min)
    let up: WinEvent | null = null;
    let upKind: { mbps: number; duplex: 'full' | 'half' } | null = null;
    for (let j = i + 1; j < links.length; j++) {
      const n = links[j];
      if (n.kind.kind === 'down') break;
      if (n.e.ts - down.ts <= R.relinkMaxMs) {
        up = n.e;
        upKind = { mbps: n.kind.mbps, duplex: n.kind.duplex };
      }
      break;
    }

    // nearest marker
    let marker: LinkMarkerRef | null = null;
    let sleepMarker: LinkMarkerRef | null = null;
    const near = inWindow(markers, down.ts - R.preSleepAfterMs - R.markerWindowMs, down.ts + R.preSleepBeforeMs, (m) => m.e.ts);
    for (const m of near) {
      const delta = down.ts - m.e.ts;
      const ref: LinkMarkerRef = { kind: m.kind, provider: m.e.provider, id: m.e.id, deltaMs: delta };
      if (m.kind === 'sleep') {
        if (delta >= -R.preSleepBeforeMs && delta <= R.preSleepAfterMs && (!sleepMarker || Math.abs(delta) < Math.abs(sleepMarker.deltaMs))) {
          sleepMarker = ref;
        }
      } else if (Math.abs(delta) <= R.markerWindowMs && (!marker || Math.abs(delta) < Math.abs(marker.deltaMs))) {
        marker = ref;
      }
    }

    // WLAN context
    const wlanAfter = inWindow(wlan, down.ts, down.ts + R.rebootNoApWindowMs, (w) => w.e.ts);
    const failover = wlanAfter.some((w) => w.kind === 'connected' && w.e.ts - down.ts <= R.failoverWindowMs);
    const lastBefore = wlan.slice(0, lowerBound(wlan, down.ts, (w) => w.e.ts)).reverse().find((w) => w.kind !== 'failed');
    const wlanAlreadyConnected = lastBefore?.kind === 'connected' && down.ts - lastBefore.e.ts < 12 * 3600_000;
    const noAccessPoint = wlanAfter.some((w) => w.kind === 'failed' && w.e.data.ReasonCode === WLAN_REASON_NO_AP);
    const wlanKnown = opts.wlanLogAvailable ?? wlan.length > 0;

    // further downs
    const moreDowns = inWindow(downs, down.ts + 1, down.ts + R.rebootMoreDownsWindowMs, (d) => d.e.ts).filter((d) => d.e !== down).length;

    // internet recovery: own samples first, then NCSI
    let internetDownMs: number | null = null;
    let internetOngoing = false;
    let internetSource: LinkDropAnalysis['internetSource'] = null;
    const live = opts.internetRecovery?.(down.ts) ?? null;
    if (live) {
      internetSource = 'samples';
      if (live.recoveredTs !== null) internetDownMs = Math.max(0, live.recoveredTs - down.ts);
      else {
        internetDownMs = Math.max(0, live.coveredUntil - down.ts);
        internetOngoing = true;
      }
    } else {
      const nc = ncsiRecovery(ncsi, down.ts, opts.now);
      if (nc) {
        internetSource = 'ncsi';
        internetDownMs = nc.ms;
        internetOngoing = nc.ongoing;
      }
    }

    let cause: LinkCause;
    let mergedInto: number | null = null;
    let inactive: NcsiChange | null = null;
    if (marker) cause = 'boot';
    else if (sleepMarker) {
      cause = 'pre_sleep';
      marker = sleepMarker;
    } else if ((inactive = inactiveWired(ncsi, wired, down.ts)) !== null) {
      cause = 'boot';
      marker = { kind: 'inactive', provider: 'Microsoft-Windows-NCSI', id: 4042, deltaMs: down.ts - inactive.ts };
    } else if (episode && down.ts <= episode.until) {
      cause = 'router_reboot';
      mergedInto = episode.recordId;
    } else if (internetDownMs !== null && internetDownMs > R.rebootInternetMs && (noAccessPoint || moreDowns >= R.rebootMoreDowns)) {
      cause = 'router_reboot';
      episode = { recordId: down.recordId, until: down.ts + internetDownMs };
    } else cause = 'runtime';

    out.push({
      down,
      up,
      relinkMbps: upKind?.mbps ?? null,
      duplex: upKind?.duplex ?? null,
      downtimeMs: up ? Math.max(0, up.ts - down.ts) : null,
      cause,
      marker,
      wlanFailover: failover ? true : wlanKnown ? false : null,
      wlanAlreadyConnected: !failover && wlanAlreadyConnected,
      internetDownMs,
      internetOngoing,
      internetSource,
      moreDowns,
      noAccessPoint,
      mergedInto,
      final: opts.now - down.ts >= R.finalAfterMs,
    });
  }
  return out;
}

// ─── NetEvent mapping (German titles) ───────────────────────────────────────

/** 1000 → '1 Gbit/s', 2500 → '2,5 Gbit/s', 100 → '100 Mbit/s' */
export function fmtLinkSpeed(mbps: number): string {
  if (mbps >= 1000) return `${String(Math.round(mbps / 100) / 10).replace('.', ',')} Gbit/s`;
  return `${Math.round(mbps)} Mbit/s`;
}

const MARKER_TEXT: Record<MarkerKind, string> = {
  boot: 'Systemstart',
  resume: 'Aufwachen aus dem Standby',
  shutdown: 'Herunterfahren',
  sleep: 'Wechsel in den Standby',
  driver: 'Treiberwechsel/-neustart',
  inactive: 'Aktivieren der Verbindung',
};

function linkDownTitle(a: LinkDropAnalysis): string {
  const relink = a.relinkMbps !== null ? `danach ${fmtLinkSpeed(a.relinkMbps)}` : null;
  switch (a.cause) {
    case 'boot': {
      const what = a.marker ? MARKER_TEXT[a.marker.kind] : 'Systemstart';
      return `Link-Neuaufbau beim ${what}${relink ? ` (${relink})` : ''}`;
    }
    case 'pre_sleep':
      return 'Link getrennt beim Wechsel in den Standby';
    case 'router_reboot': {
      const back = a.internetDownMs !== null && !a.internetOngoing ? `Internet nach ${fmtDuration(a.internetDownMs)} wieder da` : null;
      return `Netzwerkverbindung unterbrochen – vermutlich Router-Neustart${back ? ` (${back})` : ''}`;
    }
    default: {
      const parts: string[] = [];
      if (a.downtimeMs !== null) parts.push(fmtDuration(a.downtimeMs));
      if (relink) parts.push(relink);
      if (a.up === null && a.final) parts.push('keine Wiederverbindung erkannt');
      return `Netzwerkverbindung am PC unterbrochen${parts.length ? ` (${parts.join(', ')})` : ''}`;
    }
  }
}

function adapterName(e: WinEvent): string | null {
  const v = e.data.p1 ?? e.data.p0 ?? null;
  return v && v.trim() !== '' ? v.trim() : null;
}

/** nic_link_down event (insert or update) for one analysed link drop. */
export function linkDownEvent(a: LinkDropAnalysis): NetEvent {
  const severity: Severity = a.cause === 'runtime' || a.cause === 'router_reboot' ? 'warn' : 'info';
  const segment: Segment = a.cause === 'router_reboot' ? 'router' : 'client';
  return {
    ts: a.down.ts,
    endTs: a.up?.ts ?? null,
    type: 'nic_link_down',
    severity,
    segment,
    title: linkDownTitle(a),
    details: {
      cause: a.cause,
      relinkMbps: a.relinkMbps,
      duplex: a.duplex,
      downtimeMs: a.downtimeMs,
      wlanFailover: a.wlanFailover,
      wlanAlreadyConnected: a.wlanAlreadyConnected,
      internetDownMs: a.internetDownMs,
      internetOngoing: a.internetOngoing,
      internetSource: a.internetSource,
      moreDowns180s: a.moreDowns,
      noAccessPoint: a.noAccessPoint,
      marker: a.marker,
      mergedInto: a.mergedInto,
      final: a.final,
      provider: a.down.provider,
      eventId: a.down.id,
      recordId: a.down.recordId,
      upRecordId: a.up?.recordId ?? null,
      adapter: adapterName(a.down),
    },
    source: 'eventlog',
    dedupeKey: eventDedupeKey(a.down),
  };
}

/** Fields of a nic_link_down event that change while the analysis is not final. */
export function linkDownPatch(a: LinkDropAnalysis): Pick<NetEvent, 'endTs' | 'severity' | 'title' | 'details'> {
  const e = linkDownEvent(a);
  return { endTs: e.endTs ?? null, severity: e.severity, title: e.title, details: e.details ?? null };
}

const str = (v: string | undefined): string | null => (v !== undefined && v.trim() !== '' ? v.trim() : null);

/**
 * NetEvent for every other mapped event: Intel link-up and adapter conditions, standby/resume/boot/
 * shutdown, WLAN connect/disconnect/failed, address conflict (Tcpip 4199) and NIC driver installs.
 * Returns null for events that are only used as context (NCSI, Power-Troubleshooter, EventLog, …)
 * and for link-downs (see linkDownEvent).
 */
export function winEventToNetEvent(e: WinEvent): NetEvent | null {
  const base = { ts: e.ts, source: 'eventlog' as const, dedupeKey: eventDedupeKey(e) };
  const p = e.provider.toLowerCase();
  const lk = linkKindOf(e);
  if (lk) {
    if (lk.kind === 'down') return null;
    const duplex = lk.duplex === 'full' ? 'Vollduplex' : 'Halbduplex';
    return {
      ...base,
      type: 'nic_link_up',
      severity: lk.mbps < 1000 || lk.duplex === 'half' ? 'warn' : 'info',
      segment: 'client',
      title: `Netzwerkverbindung hergestellt: ${fmtLinkSpeed(lk.mbps)} ${duplex}`,
      details: { speedMbps: lk.mbps, duplex: lk.duplex, provider: e.provider, eventId: e.id, recordId: e.recordId, adapter: adapterName(e) },
    };
  }
  if (isIntelNicProvider(e.provider)) {
    const other = INTEL_OTHER[e.id];
    if (!other) return null;
    return {
      ...base,
      type: 'adapter_change',
      severity: other.severity,
      segment: 'client',
      title: other.title,
      details: { provider: e.provider, eventId: e.id, recordId: e.recordId, adapter: adapterName(e) },
    };
  }
  if (p === P_KPOWER) {
    if (e.id === 42 || e.id === 506) {
      return {
        ...base,
        type: 'standby',
        severity: 'info',
        segment: 'client',
        title: e.id === 506 ? 'PC wechselt in den Modern Standby' : 'PC wechselt in den Standby/Ruhezustand',
        details: { kind: 'sleep', eventId: e.id, reason: str(e.data.Reason), targetState: str(e.data.TargetState), effectiveState: str(e.data.EffectiveState) },
      };
    }
    if (e.id === 107 || e.id === 507) {
      return {
        ...base,
        type: 'resume',
        severity: 'info',
        segment: 'client',
        title: 'PC aus dem Standby/Ruhezustand aufgewacht',
        details: { kind: 'resume', eventId: e.id, wakeFromState: str(e.data.WakeFromState) },
      };
    }
    if (e.id === 41) {
      return {
        ...base,
        type: 'resume',
        severity: 'warn',
        segment: 'client',
        title: 'PC nach unerwartetem Neustart/Absturz gestartet',
        details: { kind: 'crash', eventId: e.id, bugcheckCode: str(e.data.BugcheckCode) },
      };
    }
    return null;
  }
  if (p === P_KGENERAL) {
    if (e.id === 12) {
      return { ...base, type: 'resume', severity: 'info', segment: 'client', title: 'PC gestartet', details: { kind: 'boot', eventId: e.id } };
    }
    if (e.id === 13) {
      return { ...base, type: 'standby', severity: 'info', segment: 'client', title: 'PC heruntergefahren', details: { kind: 'shutdown', eventId: e.id } };
    }
    return null;
  }
  if (p === P_WLAN) {
    const ssid = str(e.data.SSID);
    const suffix = ssid ? ` (${ssid})` : '';
    const common = { ssid, interfaceGuid: str(e.data.InterfaceGuid), connectionId: str(e.data.ConnectionId), eventId: e.id, recordId: e.recordId };
    if (e.id === 8001) {
      return {
        ...base,
        type: 'wlan_connect',
        severity: 'info',
        segment: 'client',
        title: `WLAN verbunden${suffix}`,
        details: {
          ...common,
          kind: 'connected',
          phyType: str(e.data.PHYType),
          authentication: str(e.data.AuthenticationAlgorithm),
          cipher: str(e.data.CipherAlgorithm),
          connectionMode: str(e.data.ConnectionMode),
          profile: str(e.data.ProfileName),
        },
      };
    }
    if (e.id === 8003) {
      const code = str(e.data.ReasonCode);
      return {
        ...base,
        type: 'wlan_disconnect',
        severity: 'info',
        segment: 'client',
        title: `WLAN getrennt${suffix}${code === WLAN_REASON_POLICY ? ' – Kabelverbindung wieder aktiv' : ''}`,
        details: { ...common, kind: 'disconnected', reasonCode: code, reason: str(e.data.Reason) },
      };
    }
    if (e.id === 8002) {
      const code = str(e.data.ReasonCode);
      return {
        ...base,
        type: 'wlan_disconnect',
        severity: 'warn',
        segment: 'client',
        title: `WLAN-Verbindung fehlgeschlagen${suffix}${code === WLAN_REASON_NO_AP ? ' – kein Zugangspunkt sichtbar' : ''}`,
        details: { ...common, kind: 'connect_failed', reasonCode: code, reason: str(e.data.FailureReason), rssi: str(e.data.RSSI) },
      };
    }
    return null;
  }
  if (p === P_TCPIP && e.id === 4199) {
    return {
      ...base,
      type: 'identity_change',
      severity: 'critical',
      segment: 'lan',
      title: 'IP-Adresskonflikt im Heimnetz erkannt',
      details: { kind: 'address_conflict', eventId: e.id, recordId: e.recordId, data: e.data },
    };
  }
  if (isNicDriverInstall(e)) {
    const name = str(e.data.ServiceName);
    return {
      ...base,
      type: 'adapter_change',
      severity: 'info',
      segment: 'client',
      title: `Netzwerktreiber installiert${name ? `: ${name}` : ''}`,
      details: { kind: 'driver_install', serviceName: name, imagePath: str(e.data.ImagePath), eventId: e.id, recordId: e.recordId },
    };
  }
  return null;
}
