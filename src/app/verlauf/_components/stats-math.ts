/** Kleine, reine Rechenhelfer für die Verlaufsseite (keine Hooks, keine I/O). */
import type { TargetStats } from "@/lib/shared/types";

/**
 * 95-%-Wilson-Intervall für einen Anteil (verlorene von gesendeten Pings), Ergebnis in Prozent.
 * Bei wenigen Messwerten ist "0 % Verlust" nur eine grobe Aussage – das Intervall zeigt das.
 */
export function wilsonPct(lost: number, sent: number, z = 1.96): { lo: number; hi: number } | null {
  if (!Number.isFinite(sent) || sent <= 0 || !Number.isFinite(lost) || lost < 0) return null;
  const n = sent;
  const p = Math.min(1, lost / n);
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { lo: Math.max(0, center - half) * 100, hi: Math.min(1, center + half) * 100 };
}

/** Spitzen-Abstand p99 − p50 (ms) – zeigt seltene, hohe Ausreißer. */
export function tailMs(s: Pick<TargetStats, "p50" | "p99">): number | null {
  return s.p50 != null && s.p99 != null ? Math.max(0, s.p99 - s.p50) : null;
}

/**
 * Welcher Wert ist besser? Kleiner = besser (Latenz, Verlust, Jitter, gestörte Sekunden).
 * Gibt "a", "b" oder null (gleich / nicht vergleichbar) zurück. `tolerance` = relative
 * Abweichung, unter der beide als gleich gelten.
 */
export function betterOf(a: number | null | undefined, b: number | null | undefined, tolerance = 0.05, absEps = 0.05): "a" | "b" | null {
  if (a == null || b == null || !Number.isFinite(a) || !Number.isFinite(b)) return null;
  const diff = Math.abs(a - b);
  if (diff <= absEps || diff <= Math.max(Math.abs(a), Math.abs(b)) * tolerance) return null;
  return a < b ? "a" : "b";
}
