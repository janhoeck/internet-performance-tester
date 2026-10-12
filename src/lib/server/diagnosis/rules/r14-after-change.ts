// R14 after-change: temporal relation between a change (driver, router firmware, VPN, user note
// such as "Kabel getauscht", labelled test session) and the problem rate before vs. after:
//   worse  – rate after ≥ 2 × rate before (≥ 3 days on each side for warn, otherwise info/low)
//   better – rate after ≤ ½ × rate before, or the MESSPLAN proof of a fix (≥ 10 relinks at
//            1 Gbit/s and ≥ 7 days without a genuine link drop after the change) → info
// Metrics: genuine link drops per day (event log) and the share of bad seconds per day.
// Sources: critique.md R14, MESSPLAN §5 ("Nachweis einer Behebung").
import { fmtDateTime, fmtDay, fmtNumber } from '../../../shared/format';
import type { Finding, FindingEvidence, Segment } from '../../../shared/types';
import { isFaultDrop } from '../links';
import { pct } from '../text';
import { DAY } from '../time';
import type { ChangeMarker, DiagnosisInput } from '../types';
import { findingScore } from '../util';

export const AFTER_CHANGE = 'after-change';

const SIDE_MAX_MS = 14 * DAY;
const MIN_SIDE_DAYS = 3;
/** a day counts for the bad-seconds rate with ≥ 1 h of classified seconds */
const MIN_DAY_COVERED = 3600;

type Metric = 'link' | 'seconds';

export interface ChangeEffect {
  change: ChangeMarker;
  metric: Metric;
  before: number;
  after: number;
  beforeDays: number;
  afterDays: number;
  direction: 'worse' | 'better' | 'fixed';
}

function linkEffect(input: DiagnosisInput, c: ChangeMarker): ChangeEffect | null {
  const start = Math.max(input.linkFrom, c.ts - SIDE_MAX_MS);
  const end = Math.min(input.to, c.ts + SIDE_MAX_MS);
  const beforeDays = (c.ts - start) / DAY;
  const afterDays = (end - c.ts) / DAY;
  if (beforeDays < 1 || afterDays < 1) return null;
  const faults = input.linkDrops.filter((d) => isFaultDrop(d));
  const nBefore = faults.filter((d) => d.ts >= start && d.ts < c.ts).length;
  const nAfter = faults.filter((d) => d.ts >= c.ts && d.ts < end).length;
  const before = nBefore / beforeDays;
  const after = nAfter / afterDays;
  const base = { change: c, metric: 'link' as const, before, after, beforeDays, afterDays };
  // MESSPLAN: ≥ 10 relinks at 1 Gbit/s after the change and ≥ 7 days without a genuine drop
  const relinksAfter = input.linkDrops.filter((d) => d.ts >= c.ts && d.relinkMbps !== null);
  if (nBefore >= 3 && nAfter === 0 && afterDays >= 7 && relinksAfter.length >= 10 && relinksAfter.every((d) => (d.relinkMbps ?? 0) >= 1000)) {
    return { ...base, direction: 'fixed' };
  }
  if (nAfter >= 2 && after >= 0.5 && after >= 2 * before) return { ...base, direction: 'worse' };
  if (nBefore >= 3 && before >= 0.5 && after <= 0.5 * before) return { ...base, direction: 'better' };
  return null;
}

function secondsEffect(input: DiagnosisInput, c: ChangeMarker): ChangeEffect | null {
  let bBad = 0;
  let bCov = 0;
  let aBad = 0;
  let aCov = 0;
  let beforeDays = 0;
  let afterDays = 0;
  for (const d of input.secondsDaily) {
    if (d.covered < MIN_DAY_COVERED) continue;
    const dayStart = d.dayStart;
    if (dayStart + DAY <= c.ts && dayStart >= c.ts - SIDE_MAX_MS) {
      bBad += d.bad;
      bCov += d.covered;
      beforeDays++;
    } else if (dayStart >= c.ts && dayStart < c.ts + SIDE_MAX_MS) {
      aBad += d.bad;
      aCov += d.covered;
      afterDays++;
    }
  }
  if (beforeDays < 1 || afterDays < 1 || bCov === 0 || aCov === 0) return null;
  const before = (bBad / bCov) * 100;
  const after = (aBad / aCov) * 100;
  const base = { change: c, metric: 'seconds' as const, before, after, beforeDays, afterDays };
  if (after >= 1 && after >= 2 * before) return { ...base, direction: 'worse' };
  if (before >= 1 && after <= 0.5 * before) return { ...base, direction: 'better' };
  return null;
}

const RELEVANT: ReadonlySet<ChangeMarker['kind']> = new Set(['driver', 'firmware', 'note', 'vpn', 'session']);

export function changeEffects(input: DiagnosisInput): ChangeEffect[] {
  const out: ChangeEffect[] = [];
  for (const c of input.changes) {
    if (!RELEVANT.has(c.kind) || c.ts >= input.to) continue;
    const l = linkEffect(input, c);
    if (l) out.push(l);
    const s = secondsEffect(input, c);
    if (s) out.push(s);
  }
  return out;
}

/** German quotation marks, unless the label already contains some (e.g. Langzeittest „X“) */
export function quoteDe(label: string): string {
  return /[„“"]/.test(label) ? label : `„${label}“`;
}

const strength = (e: ChangeEffect) => Math.abs(Math.log((e.after + 0.01) / (e.before + 0.01)));
const solid = (e: ChangeEffect) => e.beforeDays >= MIN_SIDE_DAYS && e.afterDays >= MIN_SIDE_DAYS;

function fmtRate(e: ChangeEffect, v: number): string {
  return e.metric === 'link' ? `${fmtNumber(v, v >= 10 ? 0 : 1)} pro Tag` : pct(v);
}

function segmentFor(e: ChangeEffect): Segment {
  if (e.metric === 'link') return 'client';
  return e.change.kind === 'firmware' ? 'router' : 'client';
}

export function afterChange(input: DiagnosisInput): Finding | null {
  const effects = changeEffects(input);
  if (effects.length === 0) return null;
  const pick = (list: ChangeEffect[]) => [...list].sort((a, b) => strength(b) - strength(a))[0];
  const worseSolid = effects.filter((e) => e.direction === 'worse' && solid(e));
  const good = effects.filter((e) => e.direction === 'fixed' || (e.direction === 'better' && solid(e)));
  const chosen = worseSolid.length > 0
    ? pick(worseSolid)
    : good.length > 0
      ? (good.find((e) => e.direction === 'fixed') ?? pick(good))
      : pick(effects.filter((e) => e.direction === 'worse'));
  if (!chosen) return null;

  const c = chosen.change;
  const what = chosen.metric === 'link' ? 'echte Link-Abbrüche' : 'gestörte Sekunden';
  const worse = chosen.direction === 'worse';
  const severity = worse && solid(chosen) ? 'warn' : 'info';
  const confidence = solid(chosen) ? 'medium' : 'low';

  let title: string;
  let summary: string;
  let recommendations: string[];
  if (worse) {
    title = `Probleme seit Änderung am ${fmtDay(c.ts)}: ${c.label}`;
    summary =
      `Seit ${quoteDe(c.label)} (${fmtDateTime(c.ts)}) gibt es deutlich mehr ${what}: ${fmtRate(chosen, chosen.after)} statt ${fmtRate(chosen, chosen.before)} vorher. ` +
      'Das ist ein zeitlicher Zusammenhang – nicht zwingend die Ursache.';
    recommendations = [
      'Änderung testweise rückgängig machen bzw. das aktuelle Update einspielen und das Ergebnis als Notiz festhalten.',
      'Immer nur eine Änderung zur Zeit vornehmen, damit die Ursache eindeutig bleibt.',
    ];
  } else if (chosen.direction === 'fixed') {
    title = `Behebung nachgewiesen seit ${fmtDay(c.ts)}: ${c.label}`;
    summary =
      `Seit ${quoteDe(c.label)} (${fmtDateTime(c.ts)}) gab es ${fmtNumber(chosen.afterDays, 0)} Tage keinen echten Link-Abbruch mehr und alle Verbindungsaufbauten erfolgten mit 1 Gbit/s ` +
      `(vorher ${fmtRate(chosen, chosen.before)}). Nach dem Messplan gilt Kabel/Port damit als repariert.`;
    recommendations = ['Änderung beibehalten. Treten wieder Abbrüche auf, vergleicht die App automatisch mit diesem Zeitraum.'];
  } else {
    title = `Verbesserung seit Änderung am ${fmtDay(c.ts)}: ${c.label}`;
    summary =
      `Seit ${quoteDe(c.label)} (${fmtDateTime(c.ts)}) gibt es deutlich weniger ${what}: ${fmtRate(chosen, chosen.after)} statt ${fmtRate(chosen, chosen.before)} vorher.`;
    recommendations = ['Änderung beibehalten und weiter messen – als behoben gilt ein Problem erst nach mindestens 7–9 Tagen ohne Rückfall.'];
  }

  const evidence: FindingEvidence[] = [
    { label: 'Änderung', value: `${c.label} (${fmtDateTime(c.ts)})`, ts: c.ts },
    { label: `${what.charAt(0).toUpperCase()}${what.slice(1)} vorher`, value: `${fmtRate(chosen, chosen.before)} (${fmtNumber(chosen.beforeDays, 1)} Tage)` },
    { label: `${what.charAt(0).toUpperCase()}${what.slice(1)} nachher`, value: `${fmtRate(chosen, chosen.after)} (${fmtNumber(chosen.afterDays, 1)} Tage)` },
  ];
  for (const e of effects) {
    if (e === chosen) continue;
    evidence.push({ label: `Weitere Änderung (${fmtDay(e.change.ts)})`, value: `${e.change.label}: ${fmtRate(e, e.before)} → ${fmtRate(e, e.after)}`, ts: e.change.ts });
    if (evidence.length >= 8) break;
  }

  return {
    id: AFTER_CHANGE,
    severity,
    confidence,
    segment: segmentFor(chosen),
    title,
    summary,
    evidence,
    recommendations,
    score: findingScore(severity, confidence),
  };
}
