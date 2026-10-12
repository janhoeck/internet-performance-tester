/** Aufbereitung der DOCSIS-Kanaldaten für Tabellen und Diagramme (rein, ohne React). */
import {
  channelFamily,
  frequencyRange,
  GRADE_LABEL,
  gradeHealth,
  qamOrder,
  VFKD,
  type Breaks3,
  type Breaks6,
  type DocsisFamily,
  type DocsisGrade,
} from "@/lib/shared/docsis";
import type { DocsisChannel } from "@/lib/shared/types";
import { toUiHealth, type Health } from "@/lib/health";
import { NBSP } from "@/lib/format";

const nf = (d: number) => new Intl.NumberFormat("de-DE", { minimumFractionDigits: 0, maximumFractionDigits: d });
const nf1 = nf(1);

export interface ChannelRow {
  key: string;
  ch: DocsisChannel;
  family: DocsisFamily;
  start: number | null;
  end: number | null;
  /** "602 MHz" bzw. "751–861 MHz" */
  freqText: string;
  health: Health;
  grade: DocsisGrade | null;
  /** Bewertungstext (Grund bei Auffällig/Kritisch, sonst Vodafone-Stufe) */
  note: string | null;
  /** OFDMA: auf 6,4 MHz umgerechneter Pegel */
  powerNorm: number | null;
  /** OFDM: benötigter MER-Wert der Modulation */
  requiredMer: number | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Zusatzfelder der bewerteten Snapshots (RatedDocsisSnapshot) – optional, defensiv gelesen. */
function gradeOf(ch: DocsisChannel): DocsisGrade | null {
  const g: unknown = (ch as unknown as Record<string, unknown>).grade;
  return typeof g === "string" && g in GRADE_LABEL ? (g as DocsisGrade) : null;
}

function extraNum(ch: DocsisChannel, key: string): number | null {
  return numOrNull((ch as unknown as Record<string, unknown>)[key]);
}

function worstCheckNote(ch: DocsisChannel): string | null {
  const checks: unknown = (ch as unknown as Record<string, unknown>).checks;
  if (!Array.isArray(checks)) return null;
  const rank: Record<string, number> = { sofort: 3, monatsfrist: 2, toleriert: 1, konform: 0 };
  let best: { r: number; note: string } | null = null;
  for (const c of checks) {
    if (!isRecord(c) || typeof c.note !== "string" || typeof c.grade !== "string") continue;
    const r = rank[c.grade] ?? -1;
    if (r >= 1 && (!best || r > best.r)) best = { r, note: c.note };
  }
  return best?.note ?? null;
}

export function fmtMHz(v: number): string {
  return nf1.format(v);
}

export function toRows(channels: readonly DocsisChannel[]): ChannelRow[] {
  const rows = channels.map((ch, i): ChannelRow => {
    const r = frequencyRange(ch);
    const fam = channelFamily(ch);
    const wide = r != null && r.end - r.start >= 0.5;
    const freqText = r == null ? (ch.frequencyText ?? "–") : wide ? `${fmtMHz(r.start)}–${fmtMHz(r.end)}${NBSP}MHz` : `${fmtMHz(r.start)}${NBSP}MHz`;
    const grade = gradeOf(ch);
    const health = toUiHealth(ch.rating);
    const note = ch.ratingNote ?? worstCheckNote(ch) ?? (grade && grade !== "unbekannt" ? GRADE_LABEL[grade] : null);
    return {
      key: `${ch.dir}:${fam}:${r ? Math.round(r.start * 10) : `?${i}`}:${ch.channelId ?? i}`,
      ch,
      family: fam,
      start: r?.start ?? null,
      end: r?.end ?? null,
      freqText,
      health,
      grade,
      note,
      powerNorm: extraNum(ch, "powerNormDbmv"),
      requiredMer: extraNum(ch, "requiredMerDb"),
    };
  });
  const famOrder: Record<DocsisFamily, number> = { ds: 0, ofdm: 1, us: 0, ofdma: 1 };
  rows.sort((a, b) => famOrder[a.family] - famOrder[b.family] || (a.start ?? 1e9) - (b.start ?? 1e9));
  // eindeutige Schlüssel (falls der Router Kanäle doppelt meldet)
  const seen = new Map<string, number>();
  for (const r of rows) {
    const n = seen.get(r.key) ?? 0;
    seen.set(r.key, n + 1);
    if (n > 0) r.key = `${r.key}#${n}`;
  }
  return rows;
}

/** Häufigste QAM-Ordnung der Kanäle (für die Wahl der Richtwert-Zeile). */
function dominantQam(rows: readonly ChannelRow[]): number | null {
  const counts = new Map<number, number>();
  for (const r of rows) {
    const q = qamOrder(r.ch.modulation);
    if (q != null) counts.set(q, (counts.get(q) ?? 0) + 1);
  }
  let best: number | null = null;
  let n = 0;
  for (const [q, c] of counts) if (c > n) [best, n] = [q, c];
  return best;
}

export function dsPowerBreaks(rows: readonly ChannelRow[]): { breaks: Breaks6; label: string } {
  const q = dominantQam(rows);
  if (q != null && q <= 64) return { breaks: VFKD.dsPower.qam64, label: "64QAM" };
  return { breaks: VFKD.dsPower.qam256, label: "256QAM" };
}

export function dsSnrBreaks(rows: readonly ChannelRow[]): { breaks: Breaks3; label: string } {
  const q = dominantQam(rows);
  if (q != null && q <= 64) return { breaks: VFKD.dsSnr.qam64, label: "64QAM" };
  return { breaks: VFKD.dsSnr.qam256, label: "256QAM" };
}

export interface DocsisKpis {
  dsCount: number;
  dsLocked: number;
  ofdmCount: number;
  usCount: number;
  ofdmaCount: number;
  dsPowerMin: number | null;
  dsPowerMax: number | null;
  dsSnrMin: number | null;
  ofdmMerMin: number | null;
  usPowerMax: number | null;
  counts: Record<Health, number>;
}

function minMax(values: readonly (number | null)[]): { min: number | null; max: number | null } {
  let min: number | null = null;
  let max: number | null = null;
  for (const v of values) {
    if (v == null || !Number.isFinite(v)) continue;
    min = min == null ? v : Math.min(min, v);
    max = max == null ? v : Math.max(max, v);
  }
  return { min, max };
}

export function docsisKpis(ds: readonly ChannelRow[], us: readonly ChannelRow[]): DocsisKpis {
  const dsSc = ds.filter((r) => r.family === "ds");
  const ofdm = ds.filter((r) => r.family === "ofdm");
  const usSc = us.filter((r) => r.family === "us");
  const ofdma = us.filter((r) => r.family === "ofdma");
  const lockedSc = dsSc.filter((r) => r.ch.locked !== false);
  const p = minMax(lockedSc.map((r) => r.ch.powerDbmv));
  const counts: Record<Health, number> = { good: 0, warn: 0, crit: 0, unknown: 0 };
  for (const r of [...ds, ...us]) counts[r.health]++;
  return {
    dsCount: dsSc.length,
    dsLocked: lockedSc.length,
    ofdmCount: ofdm.length,
    usCount: usSc.length,
    ofdmaCount: ofdma.length,
    dsPowerMin: p.min,
    dsPowerMax: p.max,
    dsSnrMin: minMax(lockedSc.map((r) => r.ch.snrDb)).min,
    ofdmMerMin: minMax(ofdm.map((r) => r.ch.snrDb)).min,
    usPowerMax: minMax(usSc.map((r) => r.ch.powerDbmv)).max,
    counts,
  };
}

/* -------------------------------------------------------------------------- */
/* Bewertung einzelner Aspekte (für die Kanal-Diagramme)                       */
/* -------------------------------------------------------------------------- */

const GRADE_RANK: Record<DocsisGrade, number> = { unbekannt: -1, konform: 0, toleriert: 1, monatsfrist: 2, sofort: 3 };

/**
 * Bewertung nur für bestimmte Aspekte (z. B. Pegel-Diagramm: power/neighbour/limit), damit ein
 * SNR-Ausreißer den Pegel-Balken nicht einfärbt. Ohne Prüfdetails: lokale Bewertung des Werts.
 */
export function aspectView(row: ChannelRow, aspects: readonly string[], fallback: DocsisGrade): { health: Health; note: string } {
  const checks: unknown = (row.ch as unknown as Record<string, unknown>).checks;
  let worst: { grade: DocsisGrade; note: string } | null = null;
  if (Array.isArray(checks)) {
    for (const c of checks) {
      if (!isRecord(c) || typeof c.aspect !== "string" || !aspects.includes(c.aspect)) continue;
      const g = typeof c.grade === "string" && c.grade in GRADE_RANK ? (c.grade as DocsisGrade) : "unbekannt";
      if (!worst || GRADE_RANK[g] > GRADE_RANK[worst.grade]) worst = { grade: g, note: typeof c.note === "string" ? c.note : GRADE_LABEL[g] };
    }
  }
  const grade = worst?.grade ?? fallback;
  return { health: toUiHealth(gradeHealth(grade)), note: worst?.note ?? GRADE_LABEL[grade] };
}
