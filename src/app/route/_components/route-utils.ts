/**
 * Hilfen für die Route-Seite: Hop-Rollen (Router, AFTR, Kopfstation, Vodafone-Netz, Cloudflare,
 * Ziel), RTT-Kennzahlen je Hop und Routenwechsel. Reine Funktionen ohne React.
 */
import type { Health } from "@/lib/health";
import { rateUi } from "@/lib/client/segment-health";
import type { AppConfig } from "@/lib/shared/config";
import { isIPv4, isIPv6, expandIPv6, isPrivateV4, isGlobalV6, sameIp } from "@/lib/shared/net";
import { comparePaths, isRouterAddress, type PathDiff } from "@/lib/shared/path-analysis";
import { median, quantileSorted } from "@/lib/shared/stats";
import type { DynamicHosts, IpFamily, TraceHop, TracerouteResult } from "@/lib/shared/types";

export type HopRole = "router" | "aftr" | "cmts" | "isp" | "cloudflare" | "transit" | "target" | "silent";

export const ROLE_LABEL: Record<HopRole, string> = {
  router: "Router (Vodafone Station)",
  aftr: "DS-Lite-Gateway (AFTR)",
  cmts: "Kopfstation (CMTS)",
  isp: "Vodafone-Netz",
  cloudflare: "Cloudflare",
  transit: "Internet (Transit)",
  target: "Ziel",
  silent: "Unbekannt",
};

/** Kurzform für die Hop-Kette */
export const ROLE_SHORT: Record<HopRole, string> = {
  router: "Router",
  aftr: "AFTR",
  cmts: "Kopfstation",
  isp: "Vodafone",
  cloudflare: "Cloudflare",
  transit: "Transit",
  target: "Ziel",
  silent: "stumm",
};

/** Segmentfarbe (CSS-Variable) je Rolle – Reihenfolge "Nah -> Fern" aus dem Designsystem. */
export const ROLE_COLOR: Record<HopRole, string> = {
  router: "var(--np-seg-router)",
  aftr: "var(--np-seg-provider)",
  cmts: "var(--np-seg-docsis)",
  isp: "var(--np-seg-provider)",
  cloudflare: "var(--np-seg-internet)",
  transit: "var(--np-seg-internet)",
  target: "var(--np-seg-targets)",
  silent: "var(--np-unknown)",
};

function v4ToInt(ip: string): number | null {
  if (!isIPv4(ip)) return null;
  const p = ip.split(".").map(Number);
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}

const CF_V4: readonly [string, number][] = [
  ["173.245.48.0", 20], ["103.21.244.0", 22], ["103.22.200.0", 22], ["103.31.4.0", 22], ["141.101.64.0", 18],
  ["108.162.192.0", 18], ["190.93.240.0", 20], ["188.114.96.0", 20], ["197.234.240.0", 22], ["198.41.128.0", 17],
  ["162.158.0.0", 15], ["104.16.0.0", 13], ["104.24.0.0", 14], ["172.64.0.0", 13], ["131.0.72.0", 22], ["1.1.1.0", 24], ["1.0.0.0", 24],
];
const CF_V6_PREFIXES = ["2400:cb00", "2606:4700", "2803:f800", "2405:b500", "2405:8100", "2a06:98c0", "2c0f:f248"];

/** Adresse aus den veröffentlichten Cloudflare-Netzen (ips-v4/ips-v6, Stand 2026). */
export function isCloudflare(ip: string): boolean {
  const n = v4ToInt(ip);
  if (n !== null) {
    return CF_V4.some(([base, bits]) => {
      const b = v4ToInt(base);
      if (b === null) return false;
      const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
      return ((n & mask) >>> 0) === ((b & mask) >>> 0);
    });
  }
  const g = expandIPv6(ip);
  if (!g) return false;
  const head = `${g[0]}:${g[1]}`.replace(/(^|:)0+(?=[0-9a-f])/g, "$1");
  if (head.startsWith("2a06:98c")) return true;
  return CF_V6_PREFIXES.some((p) => head === p);
}

export interface HopView {
  hop: TraceHop;
  role: HopRole;
  /** Hop antwortet nicht (ip = null) */
  silent: boolean;
  rttMin: number | null;
  rttMedian: number | null;
  rttP95: number | null;
  lossPct: number | null;
}

/** Rollen entlang des Pfads (Position + dynamische Hosts der Engine). */
export function hopRoles(result: Pick<TracerouteResult, "hops" | "family" | "target" | "reached">, dyn: DynamicHosts | null): HopRole[] {
  const hops = [...result.hops].sort((a, b) => a.hop - b.hop);
  const hop1 = hops.find((h) => h.hop === 1)?.ip ?? null;
  const routers = [dyn?.gateway ?? null, dyn?.router6 ?? null, hop1];
  const lastIdx = hops.length - 1;
  let seenCloudflare = false;
  let seenCmts = false;
  return hops.map((h, i) => {
    if (h.ip === null) {
      if (result.family === 4 && h.hop === 2 && (hop1 === null || isRouterAddress(hop1, routers) || (isIPv4(hop1) && isPrivateV4(hop1)))) return "aftr";
      return "silent";
    }
    if (sameIp(h.ip, result.target) || (i === lastIdx && result.reached)) return "target";
    if (h.hop === 1 || isRouterAddress(h.ip, routers)) return "router";
    if (result.family === 6 && !seenCmts && ((dyn?.isp6 && sameIp(h.ip, dyn.isp6)) || (!dyn?.isp6 && isIPv6(h.ip) && isGlobalV6(h.ip)))) {
      seenCmts = true;
      return "cmts";
    }
    if (isCloudflare(h.ip)) {
      seenCloudflare = true;
      return "cloudflare";
    }
    return seenCloudflare ? "transit" : "isp";
  });
}

function rttStats(h: TraceHop): { min: number | null; med: number | null; p95: number | null } {
  const ok = h.rtts.filter((r): r is number => r !== null && Number.isFinite(r)).sort((a, b) => a - b);
  if (ok.length === 0) return { min: null, med: null, p95: null };
  return { min: ok[0], med: median(ok), p95: quantileSorted(ok, 0.95) };
}

export function hopViews(result: TracerouteResult, dyn: DynamicHosts | null): HopView[] {
  const hops = [...result.hops].sort((a, b) => a.hop - b.hop);
  const roles = hopRoles(result, dyn);
  return hops.map((h, i) => {
    const s = rttStats(h);
    return {
      hop: h,
      role: roles[i],
      silent: h.ip === null,
      rttMin: s.min,
      rttMedian: s.med,
      rttP95: s.p95,
      lossPct: h.ip === null ? null : (h.mtr && h.mtr.sent > 0 ? h.mtr.lossPct : h.lossPct),
    };
  });
}

/** Zustand eines Hops: Laufzeit gegen das Segment-Band; stumme Hops = Hinweis. */
export function hopHealth(v: HopView, thresholds: AppConfig["thresholds"]["latency"]): Health | "info" {
  if (v.silent) return "info";
  const band =
    v.role === "router" ? thresholds.router : v.role === "cmts" ? thresholds.docsis : v.role === "isp" || v.role === "aftr" ? thresholds.isp : thresholds.internet;
  const lat = rateUi(v.rttMedian, band);
  // Verlust zählt nur am Ziel (Zwischenhops drosseln ICMP-Antworten – kosmetisch)
  if (v.role === "target" && v.lossPct !== null && v.lossPct > 0) return lat === "crit" ? "crit" : "warn";
  return lat;
}

export function isMtrRow(r: TracerouteResult): boolean {
  return r.hops.some((h) => h.mtr != null && h.mtr.sent > 0);
}

export interface RouteChange {
  row: TracerouteResult;
  prev: TracerouteResult | null;
  diffs: PathDiff[];
  lengthChanged: boolean;
  prevLength: number | null;
  curLength: number | null;
}

/** Zeilen mit changed = true (Pfaderkennung) mit Unterschied zur vorherigen Pfaderkennung. */
export function routeChanges(rows: readonly TracerouteResult[], family: IpFamily): RouteChange[] {
  const disc = rows.filter((r) => r.family === family && !isMtrRow(r)).sort((a, b) => b.ts - a.ts);
  const out: RouteChange[] = [];
  disc.forEach((row, i) => {
    if (!row.changed) return;
    const prev = disc[i + 1] ?? null;
    const cmp = prev ? comparePaths(prev, row) : null;
    out.push({
      row,
      prev,
      diffs: cmp?.diffs ?? [],
      lengthChanged: cmp?.lengthChanged ?? false,
      prevLength: cmp?.prevLength ?? null,
      curLength: cmp?.curLength ?? null,
    });
  });
  return out;
}

export const TRIGGER_LABEL: Record<TracerouteResult["trigger"], string> = {
  schedule: "geplant",
  manual: "manuell",
  incident: "nach Störung",
  startup: "Start Langzeittest",
};
