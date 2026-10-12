/**
 * Entwurfszustand der Einstellungen-Seite: Normalisierung, Validierung (zod-Schema aus
 * src/lib/shared/config.ts + eigene Prüfungen), Patch für PUT /api/config und das Zerlegen
 * von Validierungsfehlern der API. Reine Funktionen, keine React-Abhängigkeit.
 */
import type { ConfigPatch } from "@/lib/client/api";
import type { PublicConfig } from "@/lib/shared/api-types";
import { configSchema, type AppConfig, type Band } from "@/lib/shared/config";
import { expandIPv6, ipFamily, isIPv4, isIPv6, isLinkLocalV6, isPrivateV4 } from "@/lib/shared/net";
import type { ProbeKind, Segment } from "@/lib/shared/types";

export type SectionKey = Exclude<keyof AppConfig, "version">;

export type PasswordDraft = { mode: "keep" } | { mode: "set"; value: string } | { mode: "remove" };

/** Validierungsproblem an einem Pfad (z. B. "router.ip", "targets.3.intervalMs"). */
export interface Issue {
  message: string;
  /** Grenzwert im gespeicherten Format – das Feld rechnet ihn in seine Anzeigeeinheit um */
  bound?: { kind: "min" | "max"; value: number; inclusive: boolean };
  /** Warnung statt Fehler (blockiert das Speichern nicht) */
  warning?: boolean;
}

export type IssueMap = Readonly<Record<string, Issue>>;

export const NO_ISSUES: IssueMap = Object.freeze({});

/** PublicConfig -> bearbeitbare AppConfig (ohne das Nur-Lese-Flag hasPassword). */
export function toDraft(cfg: PublicConfig): AppConfig {
  const { hasPassword: _ignored, ...router } = cfg.router;
  void _ignored;
  return structuredClone({ ...cfg, router });
}

/** Leerzeichen entfernen, leere optionale Texte zu null. */
export function normalize(d: AppConfig): AppConfig {
  const name = d.tariff.name?.trim() ?? "";
  return {
    ...d,
    router: { ...d.router, ip: d.router.ip.trim(), username: d.router.username.trim() },
    tariff: { ...d.tariff, name: name ? name : null },
    gaming: { processNames: d.gaming.processNames.map((p) => p.trim()).filter(Boolean) },
    targets: d.targets.map((t) => ({ ...t, name: t.name.trim(), host: t.host.trim() })),
  };
}

const SECTION_KEYS: readonly SectionKey[] = [
  "router", "tariff", "targets", "session", "gaming", "schedules", "speedtest", "udpBurst", "thresholds", "retention", "eventLog",
];

/** Abschnitte, die sich gegenüber dem gespeicherten Stand geändert haben. */
export function changedSections(base: AppConfig, draft: AppConfig): SectionKey[] {
  const a = normalize(base);
  const b = normalize(draft);
  return SECTION_KEYS.filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
}

/** Patch für saveConfig(): nur geänderte Abschnitte (vollständig), Passwort nur bei Änderung. */
export function buildPatch(base: AppConfig, draft: AppConfig, password: PasswordDraft): ConfigPatch {
  const n = normalize(draft);
  const patch: Record<string, unknown> = {};
  for (const k of changedSections(base, draft)) patch[k] = n[k];
  if (password.mode === "set" && password.value) patch.routerPassword = password.value;
  if (password.mode === "remove") patch.routerPassword = null;
  return patch as ConfigPatch;
}

// ─── Router-Adresse ─────────────────────────────────────────────────────────

/** Gleiche Regel wie die API: private IPv4 (RFC 1918, 169.254/16), IPv6 link-lokal oder ULA. */
export function isPrivateRouterAddress(input: string): boolean {
  const ip = input.trim();
  if (isIPv4(ip)) return isPrivateV4(ip) || ip.startsWith("169.254.");
  if (isIPv6(ip)) {
    if (isLinkLocalV6(ip)) return true;
    const groups = expandIPv6(ip);
    return !!groups && (parseInt(groups[0], 16) & 0xfe00) === 0xfc00;
  }
  return false;
}

export const ROUTER_HOSTNAME_TRAP = /(^|\.)(easy|kabel)\.box\.?$/i;

// ─── Validierung ────────────────────────────────────────────────────────────

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "bigint") return Number(v);
  return null;
}

/** zod-Problem -> deutsche Meldung (+ Grenzwert für die Einheitenumrechnung im Feld). */
export function issueFromZod(raw: unknown): Issue {
  const i = (raw ?? {}) as Record<string, unknown>;
  const origin = typeof i.origin === "string" ? i.origin : "";
  switch (i.code) {
    case "too_small": {
      const min = num(i.minimum);
      const inclusive = i.inclusive !== false;
      if (origin === "string") return { message: min !== null && min > 1 ? `Mindestens ${min} Zeichen.` : "Darf nicht leer sein." };
      if (origin === "array") return { message: `Mindestens ${min ?? 1} Einträge.` };
      if (min === null) return { message: "Wert ist zu klein." };
      return {
        message: inclusive ? `Mindestens ${min}.` : `Muss größer als ${min} sein.`,
        bound: { kind: "min", value: min, inclusive },
      };
    }
    case "too_big": {
      const max = num(i.maximum);
      const inclusive = i.inclusive !== false;
      if (origin === "string") return { message: `Höchstens ${max ?? "?"} Zeichen.` };
      if (origin === "array") return { message: `Höchstens ${max ?? "?"} Einträge.` };
      if (max === null) return { message: "Wert ist zu groß." };
      return {
        message: inclusive ? `Höchstens ${max}.` : `Muss kleiner als ${max} sein.`,
        bound: { kind: "max", value: max, inclusive },
      };
    }
    case "invalid_type":
      if (i.expected === "int") return { message: "Bitte eine ganze Zahl eingeben." };
      if (i.expected === "number") return { message: "Bitte eine Zahl eingeben." };
      if (i.expected === "string") return { message: "Darf nicht leer sein." };
      return { message: "Ungültiger Wert." };
    case "not_multiple_of":
      return { message: "Bitte eine ganze Zahl eingeben." };
    case "invalid_format":
      return { message: "Ungültiges Format." };
    case "invalid_value":
      return { message: "Ungültige Auswahl." };
    default:
      return { message: "Ungültiger Wert." };
  }
}

function addIssue(map: Record<string, Issue>, path: string, issue: Issue): void {
  if (!map[path] || (map[path].warning && !issue.warning)) map[path] = issue;
}

function checkBand(map: Record<string, Issue>, path: string, b: Band): void {
  if (Number.isFinite(b.good) && Number.isFinite(b.warn) && b.good > b.warn) {
    addIssue(map, `${path}.warn`, { message: "Muss mindestens so groß sein wie der Wert für „gut“." });
  }
}

/** Alle Probleme des (normalisierten) Entwurfs. Schlüssel = Pfad mit Punkten. */
export function validateDraft(draft: AppConfig, password: PasswordDraft, hasPassword: boolean): IssueMap {
  const d = normalize(draft);
  const map: Record<string, Issue> = {};

  // Router-Adresse zuerst (eigene, genauere Meldungen)
  if (ROUTER_HOSTNAME_TRAP.test(d.router.ip)) {
    addIssue(map, "router.ip", {
      message: "„easy.box“ und „kabel.box“ zeigen auf fremde Server im Internet. Trage die IP-Adresse der Vodafone Station ein (meist 192.168.0.1).",
    });
  } else if (d.router.ip && !isPrivateRouterAddress(d.router.ip)) {
    addIssue(map, "router.ip", {
      message: "Nur private IP-Adressen sind erlaubt (z. B. 192.168.0.1 oder eine IPv6-Adresse fe80::…). Hostnamen werden aus Sicherheitsgründen abgelehnt.",
    });
  }

  const parsed = configSchema.safeParse(d);
  if (!parsed.success) {
    for (const zi of parsed.error.issues) {
      addIssue(map, zi.path.map(String).join("."), issueFromZod(zi));
    }
  }

  // Schwellen: gut ≤ auffällig
  for (const [seg, band] of Object.entries(d.thresholds.latency)) checkBand(map, `thresholds.latency.${seg}`, band);
  for (const k of ["tail", "jitter", "loss", "lagPerHour", "outagesPerDay", "bufferbloat"] as const) {
    checkBand(map, `thresholds.${k}`, d.thresholds[k]);
  }

  // Ruhezeiten
  const q = d.schedules.speedtestQuietHours;
  if (q && q.from === q.to) addIssue(map, "schedules.speedtestQuietHours.to", { message: "„Von“ und „bis“ dürfen nicht gleich sein." });

  // Ziele
  const seen = new Map<string, number>();
  d.targets.forEach((t, i) => {
    if (seen.has(t.id)) addIssue(map, `targets.${i}.id`, { message: "Doppelte Ziel-ID." });
    seen.set(t.id, i);
    const fam = ipFamily(t.host.split("%")[0]);
    if (fam !== null && fam !== t.family) {
      addIssue(map, `targets.${i}.host`, { message: `Die Adresse ist eine IPv${fam}-Adresse, gewählt ist IPv${t.family}.` });
    }
    if (t.kind === "icmp" && t.intervalMs < 1000) {
      addIssue(map, `targets.${i}.intervalMs`, {
        message: "Ping-Ziele höchstens einmal pro Sekunde.",
        bound: { kind: "min", value: 1000, inclusive: true },
      });
    }
  });

  // Spiele: doppelte Prozessnamen
  const names = d.gaming.processNames.map((p) => p.toLowerCase());
  if (new Set(names).size !== names.length) addIssue(map, "gaming.processNames", { message: "Ein Prozessname steht doppelt in der Liste.", warning: true });

  // Passwort / Login
  if (password.mode === "set" && password.value.length > 128) addIssue(map, "routerPassword", { message: "Höchstens 128 Zeichen." });
  const willHavePassword = password.mode === "set" ? password.value.length > 0 : password.mode === "remove" ? false : hasPassword;
  if (d.router.loginEnabled && !willHavePassword) {
    addIssue(map, "router.loginEnabled", {
      message: "Ohne gespeichertes Passwort kann sich die Mess-Engine nicht anmelden. DOCSIS-Werte und das Router-Protokoll fehlen dann.",
      warning: true,
    });
  }
  return map;
}

export function issueAt(issues: IssueMap, path: string): Issue | undefined {
  return issues[path];
}

/** Probleme, deren Pfad mit einem der Präfixe beginnt. */
export function issuesUnder(issues: IssueMap, prefixes: readonly string[]): [string, Issue][] {
  return Object.entries(issues).filter(([p]) => prefixes.some((x) => p === x || p.startsWith(`${x}.`)));
}

export function countErrors(issues: IssueMap): number {
  return Object.values(issues).filter((i) => !i.warning).length;
}

// ─── Fehler der API ─────────────────────────────────────────────────────────

export interface ServerIssue {
  /** erster Pfadteil ("router", "targets" …) oder null = allgemein */
  section: string | null;
  path: string | null;
  message: string;
}

/**
 * Antwort von PUT /api/config zerlegen. Format der API:
 * "Ungültige Einstellungen: targets.3.port: Too big …; router.ip: …" bzw. ein einzelner Satz.
 */
export function parseServerError(message: string, details: readonly string[] = []): ServerIssue[] {
  const parts: string[] = [...details];
  const m = /^Ungültige Einstellungen:\s*([\s\S]+)$/.exec(message);
  if (m) parts.push(...m[1].split(/;\s+/));
  if (parts.length === 0) {
    const section = /Router-Adresse|Router-Passwort|Router-Einstellungen/.test(message) ? "router" : null;
    return [{ section, path: section === "router" && /Adresse/.test(message) ? "router.ip" : null, message }];
  }
  return parts.map((p) => {
    const pm = /^([A-Za-z][\w.]*):\s*(.+)$/.exec(p.trim());
    if (!pm) return { section: null, path: null, message: p.trim() };
    const path = pm[1] === "(root)" ? null : pm[1];
    return { section: path ? path.split(".")[0] : null, path, message: pm[2] };
  });
}

// ─── Kleinkram ──────────────────────────────────────────────────────────────

export const KIND_LABEL: Record<ProbeKind, string> = {
  icmp: "Ping (ICMP)",
  tcp: "TCP-Aufbau",
  "udp-dns": "UDP (DNS)",
  http: "HTTP",
};

export const KIND_DEFAULT_PORT: Record<ProbeKind, number | undefined> = {
  icmp: undefined,
  tcp: 443,
  "udp-dns": 53,
  http: 80,
};

export const SEGMENT_ORDER: readonly Segment[] = ["client", "lan", "router", "docsis", "aftr", "isp", "internet", "game"];

/** Ziel-ID aus dem Namen: Kleinbuchstaben, Ziffern, Bindestriche; eindeutig. */
export function makeTargetId(name: string, existing: readonly string[]): string {
  const base =
    name
      .toLowerCase()
      .replace(/ä/g, "ae")
      .replace(/ö/g, "oe")
      .replace(/ü/g, "ue")
      .replace(/ß/g, "ss")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24) || "ziel";
  const stem = /^[a-z0-9]/.test(base) ? base : `z-${base}`;
  const taken = new Set(existing);
  if (!taken.has(stem)) return stem;
  for (let n = 2; n < 1000; n++) {
    const id = `${stem}-${n}`;
    if (!taken.has(id)) return id;
  }
  return `${stem}-${existing.length + 1}`;
}

export const DYNAMIC_HOST_LABEL: Record<string, string> = {
  $gateway: "Router-Adresse",
  $isp4: "1. IPv4-Hop (automatisch)",
  $isp6: "1. IPv6-Hop (automatisch)",
  $aftr: "AFTR-Adresse (vom Router)",
  $router6: "Router-IPv6 (automatisch)",
};
