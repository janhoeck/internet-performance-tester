// R19 periodic-spikes: lag spikes at a fixed interval point to a scheduled process (background
// service, cloud sync, WLAN background scan, router housekeeping) rather than a line fault.
//  (a) seconds scale: dominant interval between spike episodes (stats.ts dominantInterval)
//  (b) minutes scale: autocorrelation of errored seconds per minute, peak r ≥ 0.3 at a lag of
//      2–120 min that is a real local maximum (not just the slow decay of a long episode)
// Sources: methodology.md §6, critique.md §5.4, MESSPLAN R19.
import { dominantInterval } from '../../../shared/stats';
import type { Finding, FindingEvidence } from '../../../shared/types';
import { fmtShare } from '../text';
import { MINUTE } from '../time';
import type { DiagnosisInput } from '../types';
import { findingScore } from '../util';

export const PERIODIC_SPIKES = 'periodic-spikes';

/**
 * Intervals below 20 s are bursts of one disturbance, not a period (live run 09.10.: dense spikes
 * during a congested evening produced a spurious 12-s 'period'); WLAN scans/scheduled tasks are ≥ 30 s.
 */
const MIN_PERIOD_MS = 20_000;

/** spike episodes on several targets within this time count as one event */
const MERGE_MS = 3000;

export function mergeSpikeTimes(times: readonly number[]): number[] {
  const sorted = [...times].sort((a, b) => a - b);
  const out: number[] = [];
  for (const t of sorted) if (out.length === 0 || t - out[out.length - 1] > MERGE_MS) out.push(t);
  return out;
}

export interface MinutePeriod {
  lagMin: number;
  r: number;
  esMinutes: number;
}

/**
 * Autocorrelation of errored seconds per minute (missing minutes are skipped pairwise).
 * Returns the strongest fundamental period in [minLag, maxLag] minutes or null.
 */
export function esAutocorrelation(
  series: readonly { ts: number; es: number; covered: number }[],
  minLag = 2,
  maxLag = 120,
): MinutePeriod | null {
  const rows = series.filter((r) => r.covered > 0);
  if (rows.length < 360) return null;
  const t0 = rows[0].ts;
  const n = Math.round((rows[rows.length - 1].ts - t0) / MINUTE) + 1;
  if (n <= maxLag + 1) return null;
  const x = new Float64Array(n).fill(Number.NaN);
  for (const r of rows) {
    const i = Math.round((r.ts - t0) / MINUTE);
    if (i >= 0 && i < n) x[i] = r.es;
  }
  let present = 0;
  let sum = 0;
  let esMinutes = 0;
  for (let i = 0; i < n; i++) {
    if (Number.isNaN(x[i])) continue;
    present++;
    sum += x[i];
    if (x[i] > 0) esMinutes++;
  }
  if (esMinutes < 10) return null;
  const mean = sum / present;
  let den = 0;
  for (let i = 0; i < n; i++) if (!Number.isNaN(x[i])) den += (x[i] - mean) ** 2;
  if (den === 0) return null;
  const variance = den / present;
  const r = new Float64Array(maxLag + 2);
  for (let k = 1; k <= maxLag + 1; k++) {
    let s = 0;
    let pairs = 0;
    for (let i = 0; i + k < n; i++) {
      const a = x[i];
      const b = x[i + k];
      if (Number.isNaN(a) || Number.isNaN(b)) continue;
      s += (a - mean) * (b - mean);
      pairs++;
    }
    r[k] = pairs > 0 ? s / pairs / variance : 0;
  }
  const peaks: { lag: number; r: number }[] = [];
  for (let k = minLag; k <= maxLag; k++) {
    if (r[k] < 0.3 || r[k] < r[k - 1] || r[k] < r[k + 1]) continue;
    let dip = Number.POSITIVE_INFINITY;
    for (let j = 1; j < k; j++) dip = Math.min(dip, r[j]);
    if (dip > r[k] - 0.15) continue; // monotonic decay, no real period
    peaks.push({ lag: k, r: r[k] });
  }
  if (peaks.length === 0) return null;
  // peaks are in ascending lag order: multiples (±5 %) of a shorter accepted period are harmonics
  const fundamentals: { lag: number; r: number }[] = [];
  for (const p of peaks) {
    if (!fundamentals.some((f) => Math.abs(p.lag / f.lag - Math.round(p.lag / f.lag)) < 0.05)) fundamentals.push(p);
  }
  const best = fundamentals.reduce((a, b) => (b.r > a.r ? b : a));
  return { lagMin: best.lag, r: best.r, esMinutes };
}

function fmtPeriod(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 120) return `${s} s`;
  const m = Math.round(s / 60);
  return m < 120 ? `${m} min` : `${Math.round(m / 60)} h`;
}

function hintFor(periodMs: number, wifi: boolean): string {
  const s = periodMs / 1000;
  if ((s >= 50 && s <= 70) || (s >= 110 && s <= 130)) {
    return wifi
      ? 'Ein Abstand von 1–2 Minuten passt zu WLAN-Hintergrundsuchen (Windows sucht regelmäßig nach Netzen) oder Standortdiensten.'
      : 'Ein Abstand von 1–2 Minuten passt zu einem Hintergrunddienst oder zur Telemetrie (bei WLAN auch zu Hintergrundsuchen).';
  }
  if (s < 600) return 'Typische Ursachen sind zeitgesteuerte Aufgaben, Cloud-Synchronisation oder Wartungsvorgänge im Router.';
  return 'Typische Ursachen sind geplante Aufgaben (Backups, Updates, Cloud-Synchronisation) auf diesem PC oder anderen Geräten im Heimnetz.';
}

export function periodicSpikes(input: DiagnosisInput): Finding | null {
  const spikes = mergeSpikeTimes(input.spikeTimes.map((s) => s.ts));
  const byInterval = dominantInterval(spikes, { binMs: 2000, minEvents: 10, minShare: 0.5, minPeriodMs: MIN_PERIOD_MS });
  const byAcf = byInterval ? null : esAutocorrelation(input.esPerMinute);
  if (!byInterval && !byAcf) return null;

  const wifi = input.wlan?.connected === true || input.adapters?.adapters.some((a) => a.isWifi && a.status.toLowerCase() === 'up' && !a.isVirtual) === true;
  const periodMs = byInterval ? byInterval.periodMs : (byAcf as MinutePeriod).lagMin * MINUTE;
  const strong = byInterval ? byInterval.share >= 0.6 : (byAcf as MinutePeriod).r >= 0.5;
  const many = byInterval ? byInterval.events >= 30 : (byAcf as MinutePeriod).esMinutes >= 30;
  const severity = strong && many ? 'warn' : 'info';
  const confidence = strong ? 'medium' : 'low';

  const summary =
    `Lag-Spitzen treten auffällig regelmäßig auf – etwa alle ${fmtPeriod(periodMs)}. ` +
    `Das spricht für einen zeitgesteuerten Vorgang statt einer zufälligen Leitungsstörung. ${hintFor(periodMs, wifi)}`;

  const evidence: FindingEvidence[] = [];
  if (byInterval) {
    evidence.push({ label: 'Spitzen-Episoden ausgewertet', value: String(byInterval.events) });
    evidence.push({ label: `Abstände von ca. ${fmtPeriod(byInterval.periodMs)}`, value: `${fmtShare(byInterval.share)} aller Abstände` });
  } else if (byAcf) {
    evidence.push({ label: 'Minuten mit gestörten Sekunden', value: String(byAcf.esMinutes) });
    evidence.push({ label: `Autokorrelation bei ${byAcf.lagMin} min`, value: byAcf.r.toFixed(2).replace('.', ',') });
  }
  const lanSpikes = input.spikeTimes.filter((s) => input.targets.find((t) => t.id === s.targetId)?.segment === 'lan').length;
  if (input.spikeTimes.length > 0) evidence.push({ label: 'Davon schon am Router (LAN)', value: fmtShare(lanSpikes / input.spikeTimes.length) });

  return {
    id: PERIODIC_SPIKES,
    severity,
    confidence,
    segment: 'client',
    title: 'Periodische Lag-Spitzen (Hintergrunddienst/WLAN-Scan)',
    summary,
    evidence,
    recommendations: [
      'Hintergrundprogramme prüfen, die regelmäßig laufen (Cloud-Synchronisation, Launcher-Updates, Backups) und testweise beenden.',
      'Bei WLAN: das Kabel verwenden oder die automatische Netzwerksuche/Standortdienste testweise deaktivieren.',
      'Nach jeder Änderung eine Notiz setzen – die App vergleicht vorher/nachher.',
    ],
    score: findingScore(severity, confidence),
  };
}
