/**
 * Live-Kennzahlen für die KPI-Kacheln des Dashboards: mehrere Ringpuffer (z. B. alle
 * Internet-ICMP-Ziele) werden zu einer Kennzahl zusammengefasst. Reine Funktionen.
 */
import { SampleStatus, type Sample } from "@/lib/shared/types";
import { meanAbsSuccessiveDiff, median } from "@/lib/shared/stats";

export interface PooledStats {
  sent: number;
  lost: number;
  lossPct: number | null;
  /** Median aller erfolgreichen RTTs der Ziele im Fenster */
  p50: number | null;
  /** Mittel der Jitter (MASD) je Ziel – Folgen verschiedener Ziele werden nicht vermischt */
  jitter: number | null;
}

type SampleMap = Readonly<Record<string, readonly Sample[]>>;

const isOk = (s: Sample): boolean => s.status === SampleStatus.OK && s.rtt != null;

/** Samples eines aufsteigenden Ringpuffers im Fenster [from, to] (rückwärts gesucht, kein voller Scan). */
function windowOf(arr: readonly Sample[] | undefined, from: number, to: number): readonly Sample[] {
  if (!arr || arr.length === 0) return [];
  let start = arr.length;
  while (start > 0 && arr[start - 1].ts >= from) start--;
  let end = arr.length;
  while (end > start && arr[end - 1].ts > to) end--;
  return arr.slice(start, end);
}

export function pooledStats(samples: SampleMap, ids: readonly string[], from: number, to: number): PooledStats {
  let sent = 0;
  let lost = 0;
  const all: number[] = [];
  const jitters: number[] = [];
  for (const id of ids) {
    const list = windowOf(samples[id], from, to);
    const ok: number[] = [];
    for (const s of list) {
      sent++;
      if (isOk(s)) ok.push(s.rtt as number);
      else lost++;
    }
    all.push(...ok);
    const j = meanAbsSuccessiveDiff(ok);
    if (j != null) jitters.push(j);
  }
  return {
    sent,
    lost,
    lossPct: sent > 0 ? (lost / sent) * 100 : null,
    p50: all.length ? median(all) : null,
    jitter: jitters.length ? jitters.reduce((a, b) => a + b, 0) / jitters.length : null,
  };
}

/** Sparkline: Median je Zeitabschnitt über alle Ziele (null = keine Antwort im Abschnitt). */
export function pooledSpark(samples: SampleMap, ids: readonly string[], now: number, windowMs: number, buckets = 30): Array<number | null> {
  const from = now - windowMs;
  const width = windowMs / buckets;
  const groups: number[][] = Array.from({ length: buckets }, () => []);
  for (const id of ids) {
    for (const s of windowOf(samples[id], from, now)) {
      if (!isOk(s)) continue;
      const i = Math.min(buckets - 1, Math.floor((s.ts - from) / width));
      if (i >= 0) groups[i].push(s.rtt as number);
    }
  }
  return groups.map((g) => (g.length ? median(g) : null));
}
