// Shared helpers for the diagnosis rules (pure).
import type { Confidence, EventType, NetEvent, Segment, Severity } from '../../shared/types';
import { BAD_CLASSES, type BadClass, CLASS_SEGMENT } from './text';
import type { DiagnosisInput, StatsSummary, TargetMeta } from './types';

export const SEVERITY_RANK: Readonly<Record<Severity, number>> = { info: 0, warn: 1, critical: 2 };
export const CONFIDENCE_RANK: Readonly<Record<Confidence, number>> = { low: 0, medium: 1, high: 2 };

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// ─── event details ─────────────────────────────────────────────────────────

export function detail(e: NetEvent, key: string): unknown {
  return isRecord(e.details) ? e.details[key] : undefined;
}

export function detailString(e: NetEvent, key: string): string | null {
  const v = detail(e, key);
  return typeof v === 'string' && v !== '' ? v : null;
}

export function detailNumber(e: NetEvent, key: string): number | null {
  const v = detail(e, key);
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

export function detailBool(e: NetEvent, key: string): boolean | null {
  const v = detail(e, key);
  if (typeof v === 'boolean') return v;
  if (v === 1 || v === 'true') return true;
  if (v === 0 || v === 'false') return false;
  return null;
}

/** episode duration: details.durationMs, else endTs − ts */
export function eventDurationMs(e: NetEvent): number | null {
  const d = detailNumber(e, 'durationMs');
  if (d !== null) return d;
  return typeof e.endTs === 'number' && e.endTs >= e.ts ? e.endTs - e.ts : null;
}

export function eventsOf(input: DiagnosisInput, type: EventType): NetEvent[] {
  return input.events.byType[type] ?? [];
}

/** exact count in range (falls back to the list length) */
export function eventCount(input: DiagnosisInput, type: EventType): number {
  return input.events.counts[type] ?? eventsOf(input, type).length;
}

export function eventIds(events: readonly NetEvent[], max = 50): number[] {
  const out: number[] = [];
  for (const e of events) {
    if (typeof e.id === 'number' && Number.isFinite(e.id)) out.push(e.id);
    if (out.length >= max) break;
  }
  return out;
}

// ─── seconds / impact ──────────────────────────────────────────────────────

export function badSeconds(input: DiagnosisInput): number {
  return input.seconds?.bad ?? 0;
}

export function classShare(input: DiagnosisInput, cls: BadClass): number {
  const s = input.seconds;
  if (!s || s.bad <= 0) return 0;
  return s[cls] / s.bad;
}

/** share of all bad seconds that the classifier attributes to this segment (0..1) */
export function segmentImpact(input: DiagnosisInput, segment: Segment): number {
  const s = input.seconds;
  if (!s || s.bad <= 0) return 0;
  let n = 0;
  for (const c of BAD_CLASSES) if (CLASS_SEGMENT[c] === segment) n += s[c];
  // the router as a device shows up as LAN seconds (gateway lost)
  if (segment === 'router') n += s.lan;
  return clamp(n / s.bad, 0, 1);
}

/**
 * Ranking 0..100 for Finding.score: base by severity (critical 60, warn 40, info 10), + confidence
 * (high 10, medium 5), + up to 30 for the share of bad seconds the finding explains, + bonus.
 */
export function findingScore(severity: Severity, confidence: Confidence, impact = 0, bonus = 0): number {
  const base = severity === 'critical' ? 60 : severity === 'warn' ? 40 : 10;
  const conf = confidence === 'high' ? 10 : confidence === 'medium' ? 5 : 0;
  return Math.round(clamp(base + conf + 30 * clamp(impact, 0, 1) + bonus, 0, 100));
}

// ─── targets ───────────────────────────────────────────────────────────────

export function statsOf(input: DiagnosisInput, id: string | null | undefined): StatsSummary | null {
  if (!id) return null;
  const s = input.stats[id];
  return s && s.sent > 0 ? s : null;
}

export function stableStatsOf(input: DiagnosisInput, id: string | null | undefined): StatsSummary | null {
  if (!id) return null;
  const s = input.statsStable[id];
  return s && s.sent > 0 ? s : statsOf(input, id);
}

function targetByHost(input: DiagnosisInput, host: string, fallbackId: string): TargetMeta | null {
  const enabled = input.targets.filter((t) => t.enabled);
  return (
    enabled.find((t) => t.host === host && t.kind === 'icmp') ??
    enabled.find((t) => t.id === fallbackId) ??
    null
  );
}

/** gateway ICMP target (host $gateway, default id 'gw') */
export function gatewayTarget(input: DiagnosisInput): TargetMeta | null {
  return targetByHost(input, '$gateway', 'gw');
}

/** CMTS / first IPv6 hop (host $isp6) */
export function cmtsTarget(input: DiagnosisInput): TargetMeta | null {
  return targetByHost(input, '$isp6', 'isp6');
}

export function aftrTarget(input: DiagnosisInput): TargetMeta | null {
  return targetByHost(input, '$aftr', 'aftr');
}

export function isp4Target(input: DiagnosisInput): TargetMeta | null {
  return targetByHost(input, '$isp4', 'isp4');
}

export function targetName(input: DiagnosisInput, id: string): string {
  return input.targets.find((t) => t.id === id)?.name ?? id;
}

/** enabled targets of a segment */
export function segmentTargets(input: DiagnosisInput, segment: TargetMeta['segment'], kind?: TargetMeta['kind']): TargetMeta[] {
  return input.targets.filter((t) => t.enabled && t.segment === segment && (kind === undefined || t.kind === kind));
}

/** IPv4/IPv6 pairs of enabled internet targets of the same kind: [v4, v6] */
export function dualStackPairs(input: DiagnosisInput, kind: TargetMeta['kind'] = 'icmp'): [TargetMeta, TargetMeta][] {
  const out: [TargetMeta, TargetMeta][] = [];
  for (const t of input.targets) {
    if (!t.enabled || t.kind !== kind || t.family !== 4 || !t.pairId || t.segment !== 'internet') continue;
    const p = input.targets.find((x) => x.id === t.pairId && x.enabled && x.family === 6 && x.kind === kind);
    if (p) out.push([t, p]);
  }
  return out;
}

/**
 * "Internet-wide" loss: the smallest per-target loss among the internet ICMP reference targets with
 * enough samples (a loss affecting the whole internet shows up on every target; single-target
 * loss is often ICMP rate limiting). Returns null without data.
 */
export function internetWideLossPct(input: DiagnosisInput, family?: 4 | 6, minSent = 600): number | null {
  let best: number | null = null;
  for (const t of segmentTargets(input, 'internet', 'icmp')) {
    if (family !== undefined && t.family !== family) continue;
    const s = statsOf(input, t.id);
    if (!s || s.sent < minSent || s.lossPct === null) continue;
    best = best === null ? s.lossPct : Math.min(best, s.lossPct);
  }
  return best;
}

/** covered hours (seconds_1m, else ICMP minutes) */
export function coveredHours(input: DiagnosisInput): number {
  return input.coverage.coveredSeconds / 3600;
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
