/**
 * Messziele für die UI: Namen, feste Farbslots, Konfiguration aus /api/status.
 *
 * Farbe folgt dem Ziel (nie dem Rang): die wichtigsten eingebauten Ziele haben einen festen
 * Slot der Diagrammpalette; alle anderen bekommen pro Diagramm den nächsten freien Slot
 * (resolveSeriesColors) bzw. "Sonstige", wenn die 8 Farben belegt sind.
 */
import { useMemo } from "react";
import type { PublicConfig, StatusResponse } from "@/lib/shared/api-types";
import { DEFAULT_CONFIG } from "@/lib/shared/config";
import type { TargetConfig } from "@/lib/shared/types";
import { chartTokens, type ChartTokens } from "@/lib/echarts-theme";
import { useApi } from "./use-api";

/** Feste Slots (0–7) der Diagrammpalette für eingebaute Ziele. */
export const FIXED_TARGET_SLOTS: Readonly<Record<string, number>> = {
  gw: 0, // Cyan – Router
  cf4: 1, // Violett – 1.1.1.1
  g4: 2, // Magenta – 8.8.8.8
  isp6: 3, // Blau – Kopfstation
  aftr: 4, // Orange – AFTR
  cf6: 5, // Petrol – Cloudflare IPv6
  g6: 6, // Gold – Google IPv6
  "aws-fra": 7, // Orchidee – AWS Frankfurt
};

/** Kurznamen für Legenden (lange Konfigurationsnamen sprengen kleine Diagramme). */
const SHORT_NAMES: Readonly<Record<string, string>> = {
  gw: "Router",
  gw6: "Router (IPv6)",
  "gw-tcp": "Router-Web (TCP)",
  "gw-dns": "Router-DNS",
  isp6: "Kopfstation",
  aftr: "AFTR",
  isp4: "Vodafone (IPv4)",
  cf4: "1.1.1.1",
  cf6: "Cloudflare IPv6",
  g4: "8.8.8.8",
  g6: "Google IPv6",
  q4: "9.9.9.9",
  q6: "Quad9 IPv6",
  "cf4-udp": "Cloudflare UDP v4",
  "cf6-udp": "Cloudflare UDP v6",
  "cf4-tcp": "Cloudflare TCP v4",
  "cf6-tcp": "Cloudflare TCP v6",
  "aws-fra": "AWS Frankfurt",
  "aws-irl": "AWS Irland",
};

export function shortTargetName(id: string, targets?: readonly TargetConfig[] | null): string {
  return SHORT_NAMES[id] ?? targets?.find((t) => t.id === id)?.name ?? id;
}

export function targetName(id: string, targets?: readonly TargetConfig[] | null): string {
  return targets?.find((t) => t.id === id)?.name ?? SHORT_NAMES[id] ?? id;
}

const HEX = /^#[0-9a-f]{6}$/i;

/**
 * Farben für die Serien EINES Diagramms (hex, für ECharts): feste Slots zuerst, dann freie
 * Slots in Reihenfolge, danach "Sonstige". Eine explizite Zielfarbe (TargetConfig.color, hex) gewinnt.
 */
export function resolveSeriesColors(
  ids: readonly string[],
  targets?: readonly TargetConfig[] | null,
  t: ChartTokens = chartTokens(),
): Record<string, string> {
  const out: Record<string, string> = {};
  const used = new Set<number>();
  for (const id of ids) {
    const override = targets?.find((x) => x.id === id)?.color;
    if (override && HEX.test(override)) out[id] = override;
    else if (id in FIXED_TARGET_SLOTS) {
      out[id] = t.series[FIXED_TARGET_SLOTS[id]];
      used.add(FIXED_TARGET_SLOTS[id]);
    }
  }
  let next = 0;
  for (const id of ids) {
    if (out[id]) continue;
    while (next < t.series.length && used.has(next)) next++;
    if (next < t.series.length) {
      out[id] = t.series[next];
      used.add(next);
      next++;
    } else out[id] = t.other;
  }
  return out;
}

/**
 * Serien für die Diagramm-Builder (charts.ts): Kurzname + feste Farbe je Ziel-ID.
 *   const series = seriesTargets(["gw", "cf4"], targets);  // [{ id, name, color }]
 */
export function seriesTargets(
  ids: readonly string[],
  targets?: readonly TargetConfig[] | null,
  t: ChartTokens = chartTokens(),
): Array<{ id: string; name: string; color: string }> {
  const colors = resolveSeriesColors(ids, targets, t);
  return ids.map((id) => ({ id, name: shortTargetName(id, targets), color: colors[id] }));
}

/**
 * Gemeinsames Segment aller Ziele (für automatische Schwellen) – undefined, sobald die Ziele
 * in verschiedenen Abschnitten liegen (z. B. Router + 1.1.1.1: LAN-Schwellen wären irreführend).
 */
export function commonSegment(ids: readonly string[], byId: Readonly<Record<string, TargetConfig>>): TargetConfig["segment"] | undefined {
  let seg: TargetConfig["segment"] | undefined;
  for (const id of ids) {
    const s = byId[id]?.segment;
    if (!s || (seg && s !== seg)) return undefined;
    seg = s;
  }
  return seg;
}

/** CSS-Farbe für ein Ziel außerhalb von Canvas (Legenden-Punkte, Tabellen). */
export function targetCssColor(id: string): string {
  const slot = FIXED_TARGET_SLOTS[id];
  return slot === undefined ? "var(--np-chart-other)" : `var(--np-chart-${slot + 1})`;
}

export interface TargetsInfo {
  /** Konfiguration (Fallback: Standardwerte, solange /api/status lädt oder fehlt) */
  config: PublicConfig | null;
  /** alle konfigurierten Ziele (Fallback: eingebaute Standardziele) */
  targets: readonly TargetConfig[];
  /** nur aktivierte Ziele */
  enabled: readonly TargetConfig[];
  byId: Readonly<Record<string, TargetConfig>>;
  /** Konfiguration stammt vom Server (nicht Fallback) */
  fromServer: boolean;
  loading: boolean;
}

/** Konfiguration + Ziele aus GET /api/status (geteilte Anfrage, alle 30 s aktualisiert). */
export function useTargets(): TargetsInfo {
  const status = useApi<StatusResponse>("/api/status", { refreshMs: 30_000 });
  const config = status.data?.config ?? null;
  return useMemo(() => {
    const targets = config?.targets?.length ? config.targets : DEFAULT_CONFIG.targets;
    return {
      config,
      targets,
      enabled: targets.filter((t) => t.enabled),
      byId: Object.fromEntries(targets.map((t) => [t.id, t])),
      fromServer: config != null,
      loading: status.loading && config == null,
    };
  }, [config, status.loading]);
}
