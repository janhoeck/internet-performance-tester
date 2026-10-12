"use client";

import { useMemo } from "react";
import { useTimeRange, type TimeRange } from "@/lib/client/use-time-range";
import { useNow } from "@/lib/use-now";

const DAY = 86_400_000;

export interface EffectiveRange {
  range: TimeRange;
  from: number | null;
  to: number | null;
  /** "from=…&to=…" oder null, solange unbekannt */
  query: string | null;
  label: string;
  /** "Langzeittest" gewählt, aber es gibt keinen: ersatzweise die letzten 24 Stunden */
  fallback: boolean;
  /** Zeitraum endet bei „jetzt“ und rückt weiter */
  live: boolean;
}

/**
 * Zeitraum für Diagnose und Bericht: Standard „Langzeittest“ (aktiver oder zuletzt beendeter
 * Test). Gibt es noch keinen, gelten ersatzweise die letzten 24 Stunden (Minutenraster).
 */
export function useEffectiveRange(): EffectiveRange {
  const range = useTimeRange({ defaultPreset: "session" });
  const now = useNow(60_000);
  if (range.noSession) {
    const to = now;
    const from = now != null ? now - DAY : null;
    return {
      range,
      from,
      to,
      query: from != null && to != null ? `from=${from}&to=${to}` : null,
      label: "Letzte 24 Stunden",
      fallback: true,
      live: true,
    };
  }
  return { range, from: range.from, to: range.to, query: range.query, label: range.label, fallback: false, live: range.live };
}

const QUANT_MS = 5 * 60_000;

/**
 * API-Query ("from=…&to=…") für Diagnose/Bericht. Laufende Zeiträume rücken nur alle 5 min weiter:
 * Die Diagnose rechnet über Tage, eine neue URL pro Minute wäre unnötige Last.
 */
export function useRangeQuery(er: EffectiveRange): string | null {
  const { from, to, live, fallback } = er;
  return useMemo(() => {
    if (from == null || to == null) return null;
    if (!live) return `from=${from}&to=${to}`;
    const end = Math.ceil(to / QUANT_MS) * QUANT_MS;
    const start = fallback ? end - DAY : from;
    return `from=${start}&to=${end}`;
  }, [from, to, live, fallback]);
}

/** from/to aus einer Query wie "from=1&to=2" (für Anzeigen, die zur geladenen Auswertung passen). */
export function parseRangeQuery(q: string | null): { from: number; to: number } | null {
  if (!q) return null;
  const sp = new URLSearchParams(q);
  const from = Number(sp.get("from"));
  const to = Number(sp.get("to"));
  return Number.isFinite(from) && Number.isFinite(to) ? { from, to } : null;
}
