// German labels and small formatting helpers for findings, segments and the verdict.
import { DASH, fmtDuration, fmtMs, fmtNumber, fmtPct, isNum } from '../../shared/format';
import type { Confidence, SecondClass, Segment } from '../../shared/types';

export const SEGMENT_LABELS: Readonly<Record<Segment, string>> = {
  client: 'PC & Adapter',
  lan: 'Heimnetz (PC ⇄ Router)',
  router: 'Router (Vodafone Station)',
  docsis: 'Kabelnetz (DOCSIS)',
  aftr: 'DS-Lite-Gateway (AFTR)',
  isp: 'Vodafone-Backbone',
  internet: 'Internet',
  game: 'Spieleserver',
};

export type BadClass = Exclude<SecondClass, 'excluded' | 'good'>;

export const BAD_CLASSES: readonly BadClass[] = ['link', 'lan', 'access', 'aftr', 'backbone', 'remote', 'unknown'];
/** classes that point to a segment (everything except 'unknown') */
export const ATTRIBUTABLE_CLASSES: readonly Exclude<BadClass, 'unknown'>[] = ['link', 'lan', 'access', 'aftr', 'backbone', 'remote'];

/** UI labels of the second classes (docs/research/critique.md §5.2). */
export const CLASS_LABELS: Readonly<Record<BadClass, string>> = {
  link: 'PC-Kabel/WLAN-Umschaltung',
  lan: 'Heimnetz/Router',
  access: 'Kabelnetz (Zugang/CMTS)',
  aftr: 'IPv4-Tunnel (DS-Lite)',
  backbone: 'Vodafone-Backbone/Internet',
  remote: 'Spielserver/Route',
  unknown: 'Unklar',
};

export const CLASS_SEGMENT: Readonly<Record<BadClass, Segment | null>> = {
  link: 'client',
  lan: 'lan',
  access: 'docsis',
  aftr: 'aftr',
  backbone: 'isp',
  remote: 'game',
  unknown: null,
};

export const CONFIDENCE_LABELS: Readonly<Record<Confidence, string>> = { low: 'gering', medium: 'mittel', high: 'hoch' };

/** part / whole as a fraction (0..1), null when whole is 0 */
export function ratio(part: number, whole: number): number | null {
  return whole > 0 ? part / whole : null;
}

/** fraction 0..1 → '42 %' (small values with decimals) */
export function fmtShare(share: number | null | undefined): string {
  if (!isNum(share)) return DASH;
  const p = share * 100;
  return fmtPct(p, p === 0 || p >= 10 ? 0 : p >= 1 ? 1 : 2);
}

/** '1 Abbruch' / '5 Abbrüche' (German number formatting) */
export function fmtCount(n: number, singular: string, plural: string): string {
  return `${fmtNumber(n)} ${n === 1 ? singular : plural}`;
}

/** '1.234 s' */
export function fmtSecondsCount(n: number): string {
  return `${fmtNumber(n)} s`;
}

/** link speed: 1000 → '1 Gbit/s', 2500 → '2,5 Gbit/s', 100 → '100 Mbit/s' */
export function fmtLinkSpeed(mbps: number | null | undefined): string {
  if (!isNum(mbps)) return DASH;
  if (mbps >= 1000) return `${fmtNumber(mbps / 1000, mbps % 1000 === 0 ? 0 : 1)} Gbit/s`;
  return `${fmtNumber(mbps)} Mbit/s`;
}

/** durations in ms → '3–22 s' / '6 s' */
export function fmtSecondsRange(values: readonly number[]): string {
  if (values.length === 0) return DASH;
  const s = values.map((v) => Math.max(0, Math.round(v / 1000)));
  const lo = Math.min(...s);
  const hi = Math.max(...s);
  return lo === hi ? `${fmtNumber(lo)} s` : `${fmtNumber(lo)}–${fmtNumber(hi)} s`;
}

/** covered seconds → readable duration ('9 h 40 min') */
export function fmtCoverage(seconds: number): string {
  return fmtDuration(seconds * 1000);
}

/** ms with sensible precision; '–' for null */
export function ms(v: number | null | undefined): string {
  return fmtMs(v);
}

/** percent value (already in %) */
export function pct(v: number | null | undefined, decimals?: number): string {
  return fmtPct(v, decimals);
}

/** German list: 'a, b und c' */
export function joinDe(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} und ${items[items.length - 1]}`;
}
