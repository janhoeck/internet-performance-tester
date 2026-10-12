// DOCSIS line rating (Vodafone Kabel / ARRIS Vodafone Station) and router event-log categorizer.
// Source of all thresholds: docs/research/docsis-thresholds.md – §3 rating model, §4 DS power,
// §5 DS SNR, §6 OFDM, §7/§8 upstream power, §9 lock/partial service/modulation, §11 event log,
// §14 time-series rules. Pure functions (no Node built-ins) – usable by engine, API and UI.
import { fmtNumber } from './format';
import type { DocsisChannel, DocsisSnapshot, Health, Severity } from './types';

// ─── Grades ────────────────────────────────────────────────────────────────

/**
 * Vodafone service-table grades (VFKD 17.06.2018): konform / toleriert → "gut",
 * Beseitigung binnen Monatsfrist → "grenzwertig", sofortige Beseitigung → "kritisch".
 */
export type DocsisGrade = 'konform' | 'toleriert' | 'monatsfrist' | 'sofort' | 'unbekannt';

const GRADE_RANK: Record<DocsisGrade, number> = { unbekannt: -1, konform: 0, toleriert: 1, monatsfrist: 2, sofort: 3 };

export const GRADE_LABEL: Record<DocsisGrade, string> = {
  konform: 'konform',
  toleriert: 'toleriert',
  monatsfrist: 'Beseitigung binnen Monatsfrist',
  sofort: 'sofortige Beseitigung',
  unbekannt: 'unbekannt',
};

/** Short UI wording of a grade (3 UI levels; "toleriert" kept as hint). */
export const GRADE_SHORT: Record<DocsisGrade, string> = {
  konform: 'konform',
  toleriert: 'toleriert',
  monatsfrist: 'grenzwertig',
  sofort: 'kritisch',
  unbekannt: 'unbekannt',
};

export function gradeHealth(g: DocsisGrade): Health {
  if (g === 'konform' || g === 'toleriert') return 'good';
  if (g === 'monatsfrist') return 'warn';
  if (g === 'sofort') return 'bad';
  return 'unknown';
}

/** Worst grade; 'unbekannt' only when nothing could be rated. */
export function worstGrade(grades: readonly DocsisGrade[]): DocsisGrade {
  let w: DocsisGrade = 'unbekannt';
  for (const g of grades) if (GRADE_RANK[g] > GRADE_RANK[w]) w = g;
  return w;
}

export type Breaks6 = readonly [number, number, number, number, number, number];
export type Breaks3 = readonly [number, number, number];

/**
 * Symmetric scale b0…b5 (0.1-step table semantics): v ≤ b0 sofort; ≤ b1 Monatsfrist; ≤ b2 toleriert;
 * ≤ b3 konform; ≤ b4 toleriert; ≤ b5 Monatsfrist; above sofort.
 */
export function rateSymmetric(v: number, b: Breaks6): DocsisGrade {
  if (!Number.isFinite(v)) return 'unbekannt';
  if (v <= b[0]) return 'sofort';
  if (v <= b[1]) return 'monatsfrist';
  if (v <= b[2]) return 'toleriert';
  if (v <= b[3]) return 'konform';
  if (v <= b[4]) return 'toleriert';
  if (v <= b[5]) return 'monatsfrist';
  return 'sofort';
}

/** Lower-bound scale a0…a2 (SNR/MER): v ≤ a0 sofort; ≤ a1 Monatsfrist; ≤ a2 toleriert; above konform. */
export function rateLowerBound(v: number, a: Breaks3): DocsisGrade {
  if (!Number.isFinite(v)) return 'unbekannt';
  if (v <= a[0]) return 'sofort';
  if (v <= a[1]) return 'monatsfrist';
  if (v <= a[2]) return 'toleriert';
  return 'konform';
}

/** Breakpoints of the VFKD service table (17.06.2018) in dBmV / dB. */
export const VFKD = {
  dsPower: {
    qam64: [-14, -12, -10, 7, 12, 14] as Breaks6,
    qam256: [-8, -6, -4, 13, 18, 20] as Breaks6,
    /** DOCSIS 3.1 row – also used for OFDM channels */
    qam1024: [-6, -4, -2, 15, 20, 22] as Breaks6,
  },
  dsSnr: {
    qam64: [24, 26, 27] as Breaks3,
    qam256: [30, 32, 33] as Breaks3,
    qam1024: [36, 38, 39] as Breaks3,
  },
  /** synthesized OFDM MER scale, only used when the profile modulation is unknown */
  ofdmMerFallback: [35, 38, 40] as Breaks3,
  usPowerScqam: [35, 37, 41, 47, 51, 53] as Breaks6,
  /** applied to the 6.4 MHz-equivalent OFDMA power */
  usPowerOfdma: [38, 40, 44, 47, 48, 50] as Breaks6,
} as const;

/** DOCSIS 3.1 PHY Table 7-41: minimum CNR per OFDM modulation (≤ 1 GHz / 1–1.2 GHz upper edge). */
export const OFDM_CNR: readonly { qam: number; cnr: number; cnrHi: number }[] = [
  { qam: 4096, cnr: 41.0, cnrHi: 41.5 },
  { qam: 2048, cnr: 37.0, cnrHi: 37.5 },
  { qam: 1024, cnr: 34.0, cnrHi: 34.0 },
  { qam: 512, cnr: 30.5, cnrHi: 30.5 },
  { qam: 256, cnr: 27.0, cnrHi: 27.0 },
  { qam: 128, cnr: 24.0, cnrHi: 24.0 },
  { qam: 64, cnr: 21.0, cnrHi: 21.0 },
  { qam: 16, cnr: 15.0, cnrHi: 15.0 },
];

/** OFDM MER must exceed the required CNR by this margin to count as "gut". */
export const OFDM_GOOD_MARGIN_DB = 3;
/** SNR outlier: channel at least this far below the median of its modulation group. */
export const SNR_OUTLIER_DB = 3;
/** Adjacent DS SC-QAM channels must not differ by more than this (64QAM offset normalized). */
export const NEIGHBOUR_MAX_DB = 6;
/** Max. frequency gap (MHz) for two DS channels to count as neighbours. */
export const NEIGHBOUR_MAX_GAP_MHZ = 100;
/** |tilt| above this → grenzwertig. */
export const TILT_MAX_DB = 10;
/** Vodafone sends 64QAM channels ~6 dB below 256QAM channels. */
export const QAM64_OFFSET_DB = 6;
/** partial service on DS SC-QAM becomes kritisch after this long. */
export const PARTIAL_CRITICAL_MS = 15 * 60_000;
/** SC-QAM upstream channel power at/above this with OFDMA active = modem at its limit. */
export const US_SCQAM_LIMIT_WITH_OFDMA_DBMV = 54;
/** headroom: ≥ 6 dB gut, 3–6 dB grenzwertig, < 3 dB kritisch */
export const US_HEADROOM_WARN_DB = 6;
export const US_HEADROOM_BAD_DB = 3;

// ─── Small value helpers ───────────────────────────────────────────────────

const fdb = (v: number): string => `${fmtNumber(v, 1)} dB`;
const fdbmv = (v: number): string => `${fmtNumber(v, 1)} dBmV`;
const fmhz = (v: number): string => `${fmtNumber(v, v % 1 === 0 ? 0 : 1)} MHz`;

function medianOf(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * QAM order of a modulation string: '256QAM' / 'QAM256' / '256-QAM' → 256, 'QPSK' → 4, 'BPSK' → 2.
 * Strings with several numbers (e.g. '256QAM/4096QAM') → the highest. Unknown → null.
 */
export function qamOrder(modulation: string | null | undefined): number | null {
  if (!modulation) return null;
  const s = modulation.toUpperCase();
  const nums = [...s.matchAll(/(\d{1,5})\s*-?\s*QAM|QAM\s*-?\s*(\d{1,5})/g)]
    .map((m) => Number(m[1] ?? m[2]))
    .filter((n) => Number.isFinite(n) && n >= 2);
  if (nums.length > 0) return Math.max(...nums);
  if (/\bQPSK\b/.test(s)) return 4;
  if (/\bBPSK\b/.test(s)) return 2;
  if (/^\s*\d{1,5}\s*$/.test(s)) {
    const n = Number(s);
    return n >= 2 ? n : null;
  }
  return null;
}

/** Normalized channel type: 'SC-QAM' | 'OFDM' | 'OFDMA' (unknown non-empty strings are kept). */
export function normalizeChannelType(raw: string | null | undefined, dir: 'ds' | 'us'): string {
  const s = (raw ?? '').trim();
  if (s === '') return 'SC-QAM';
  if (/ofdma/i.test(s)) return 'OFDMA';
  if (/ofdm/i.test(s)) return dir === 'us' ? 'OFDMA' : 'OFDM';
  if (/sc-?qam|^qam|atdma|tdma|scdma|docsis ?3\.0/i.test(s)) return 'SC-QAM';
  return s;
}

export type DocsisFamily = 'ds' | 'ofdm' | 'us' | 'ofdma';
export const DOCSIS_FAMILIES: readonly DocsisFamily[] = ['ds', 'ofdm', 'us', 'ofdma'];

export const FAMILY_LABEL: Record<DocsisFamily, string> = {
  ds: 'Downstream SC-QAM',
  ofdm: 'Downstream OFDM',
  us: 'Upstream SC-QAM',
  ofdma: 'Upstream OFDMA',
};

export function channelFamily(ch: Pick<DocsisChannel, 'dir' | 'type'>): DocsisFamily {
  const ofdm = /ofdm/i.test(ch.type);
  if (ch.dir === 'ds') return ofdm ? 'ofdm' : 'ds';
  return ofdm ? 'ofdma' : 'us';
}

/** Frequency range of a channel in MHz: OFDM blocks from 'start~end', SC-QAM centre ± 0. */
export function frequencyRange(ch: Pick<DocsisChannel, 'frequencyMHz' | 'frequencyText'>): { start: number; end: number } | null {
  const t = ch.frequencyText ?? '';
  const m = /(\d+(?:[.,]\d+)?)\s*[~–-]\s*(\d+(?:[.,]\d+)?)/.exec(t);
  if (m) {
    const toMHz = (x: number) => (x >= 1e6 ? x / 1e6 : x >= 1e4 ? x / 1e3 : x);
    const a = toMHz(Number(m[1].replace(',', '.')));
    const b = toMHz(Number(m[2].replace(',', '.')));
    if (Number.isFinite(a) && Number.isFinite(b)) return { start: Math.min(a, b), end: Math.max(a, b) };
  }
  if (ch.frequencyMHz !== null && Number.isFinite(ch.frequencyMHz)) return { start: ch.frequencyMHz, end: ch.frequencyMHz };
  return null;
}

/**
 * Stable channel identity (dir, type, rounded frequency) – channel ids change after
 * re-registration. Channels without frequency get an index-based key.
 */
export function channelKey(ch: Pick<DocsisChannel, 'dir' | 'type' | 'frequencyMHz' | 'frequencyText'>, index = 0): string {
  const r = frequencyRange(ch);
  const type = normalizeChannelType(ch.type, ch.dir);
  return r ? `${ch.dir}:${type}:${Math.round(r.start)}` : `${ch.dir}:${type}:?${index}`;
}

/** German short label, e.g. 'DS 602 MHz', 'DS-OFDM 135–324 MHz', 'US-OFDMA 29–64 MHz'. */
export function channelLabel(ch: Pick<DocsisChannel, 'dir' | 'type' | 'frequencyMHz' | 'frequencyText' | 'channelId'>): string {
  const fam = channelFamily(ch);
  const prefix = fam === 'ds' ? 'DS' : fam === 'ofdm' ? 'DS-OFDM' : fam === 'us' ? 'US' : 'US-OFDMA';
  const r = frequencyRange(ch);
  if (!r) return `${prefix} Kanal ${ch.channelId ?? '?'} (ohne Frequenz)`;
  if (r.end - r.start >= 0.5) return `${prefix} ${fmtNumber(r.start, 0)}–${fmtNumber(r.end, 0)} MHz`;
  return `${prefix} ${fmhz(r.start)}`;
}

// ─── Lock / ranging status ────────────────────────────────────────────────

export type LockState = 'locked' | 'transient' | 'failed' | 'unknown';

const LOCK_OK = /^(locked|lock|ja|yes|true|1|active|success|successful|erfolgreich|ok|completed?|gelockt)$/i;
const LOCK_TRANSIENT = /^(continue|in ?progress|ranging|pending|l[aä]uft)$/i;
const LOCK_FAILED =
  /^(not ?locked|unlocked|nein|no|false|0|aborted|abort|retries ?exceeded|timeout ?t4|t4 ?timeout|fail(ed|ure)?|error|fehlgeschlagen|inactive|down|none)$/i;

/**
 * Lock/ranging state from the router's text. DS (§9.1): only Locked/JA/yes/true/1 count as locked,
 * everything else is a failure. US: ACTIVE/SUCCESS/Erfolgreich ok; "continue" transient;
 * aborted/retriesExceeded/timeoutT4 failed; unknown strings → 'unknown' (rated grenzwertig).
 */
export function lockState(text: string | null | undefined, dir: 'ds' | 'us'): LockState | null {
  const s = (text ?? '').toString().trim();
  if (s === '') return null;
  if (LOCK_OK.test(s)) return 'locked';
  if (dir === 'ds') return 'failed';
  if (LOCK_TRANSIENT.test(s)) return 'transient';
  if (LOCK_FAILED.test(s)) return 'failed';
  return 'unknown';
}

/**
 * Boolean lock flag for DocsisChannel.locked: true = locked/ranged, false = explicitly not locked /
 * ranging failed, null = no or ambiguous information (incl. transient "continue" ranging, which is
 * rated grenzwertig via the lock text but does not count as a lost channel).
 */
export function parseLockStatus(text: string | null | undefined, dir: 'ds' | 'us'): boolean | null {
  const st = lockState(text, dir);
  if (st === 'locked') return true;
  if (st === 'failed') return false;
  return null;
}

// ─── Channel-level rules ───────────────────────────────────────────────────

/** VFKD row for a DS SC-QAM modulation: ≤ 128QAM → 64QAM row, 256QAM, > 256 → 1024QAM row. */
function dsRow(qam: number | null): 'qam64' | 'qam256' | 'qam1024' | null {
  if (qam === null) return null;
  if (qam <= 128) return 'qam64';
  if (qam <= 256) return 'qam256';
  return 'qam1024';
}

/** Required CNR for an OFDM profile modulation (next higher table entry for odd orders); null if unknown. */
export function requiredOfdmCnr(qam: number | null, upperEdgeMHz: number | null = null): number | null {
  if (qam === null || qam > 4096) return null;
  const hi = upperEdgeMHz !== null && upperEdgeMHz > 1000;
  let best: { qam: number; cnr: number; cnrHi: number } | null = null;
  for (const r of OFDM_CNR) if (r.qam >= qam && (best === null || r.qam < best.qam)) best = r;
  if (!best) return null;
  return hi ? best.cnrHi : best.cnr;
}

/** Highest OFDM modulation the measured MER supports (PHY Table 7-41); 0 when below 16QAM. */
export function supportableQam(mer: number, upperEdgeMHz: number | null = null): number {
  const hi = upperEdgeMHz !== null && upperEdgeMHz > 1000;
  for (const r of OFDM_CNR) if (mer >= (hi ? r.cnrHi : r.cnr)) return r.qam;
  return 0;
}

export interface OfdmMerRating {
  grade: DocsisGrade;
  requiredDb: number | null;
  marginDb: number | null;
}

/**
 * OFDM MER against the CNR required by the profile modulation (architecture §4.10, MESSPLAN §4):
 * margin ≥ +3 dB konform, ≥ 0 dB Monatsfrist, below sofort. Unknown modulation → synthesized
 * absolute scale (35/38/40 dB).
 */
export function rateOfdmMer(mer: number, qam: number | null, upperEdgeMHz: number | null = null): OfdmMerRating {
  const req = requiredOfdmCnr(qam, upperEdgeMHz);
  if (req === null) return { grade: rateLowerBound(mer, VFKD.ofdmMerFallback), requiredDb: null, marginDb: null };
  const margin = Math.round((mer - req) * 10) / 10;
  const grade: DocsisGrade = margin >= OFDM_GOOD_MARGIN_DB ? 'konform' : margin >= 0 ? 'monatsfrist' : 'sofort';
  return { grade, requiredDb: req, marginDb: margin };
}

/** US SC-QAM modulation (§9.3): ≥ 64QAM konform, 32QAM toleriert, 16QAM Monatsfrist, ≤ 8QAM/QPSK sofort. */
export function rateUsModulation(qam: number | null): DocsisGrade {
  if (qam === null) return 'unbekannt';
  if (qam >= 64) return 'konform';
  if (qam >= 32) return 'toleriert';
  if (qam >= 16) return 'monatsfrist';
  return 'sofort';
}

export type OfdmaMode = 'auto' | 'p1.6' | 'total' | 'p6.4';

export interface OfdmaNormalization {
  /** 6.4 MHz-equivalent power in dBmV */
  p64: number;
  mode: Exclude<OfdmaMode, 'auto'>;
  confidence: 'manuell' | 'mittel' | 'niedrig';
}

/**
 * The TG6442's OFDMA power display is ambiguous (§8.2): normalize to a 6.4 MHz equivalent.
 * 'auto' picks the interpretation closest to the median SC-QAM upstream power.
 */
export function normalizeOfdmaPower(
  pDisp: number, bwMHz: number | null, scqamPowers: readonly number[], mode: OfdmaMode = 'auto',
): OfdmaNormalization {
  const cand: Record<Exclude<OfdmaMode, 'auto'>, number> = {
    'p1.6': pDisp + 6.02,
    'p6.4': pDisp,
    total: bwMHz && bwMHz > 0 ? pDisp - 10 * Math.log10(bwMHz / 6.4) : Number.NaN,
  };
  if (mode !== 'auto') {
    const v = cand[mode];
    return { p64: Number.isFinite(v) ? v : pDisp, mode: Number.isFinite(v) ? mode : 'p6.4', confidence: 'manuell' };
  }
  const ref = medianOf(scqamPowers);
  if (ref === null) return { p64: pDisp, mode: 'p6.4', confidence: 'niedrig' };
  let best: Exclude<OfdmaMode, 'auto'> = 'p6.4';
  let bestErr = Number.POSITIVE_INFINITY;
  for (const k of ['p6.4', 'p1.6', 'total'] as const) {
    const v = cand[k];
    if (!Number.isFinite(v)) continue;
    const err = Math.abs(v - ref);
    if (err < bestErr) {
      best = k;
      bestErr = err;
    }
  }
  return { p64: Math.round(cand[best] * 10) / 10, mode: best, confidence: bestErr <= 3 ? 'mittel' : 'niedrig' };
}

/**
 * Upstream transmit headroom in dB (§7.3, DOCSIS 3.1 Pmax 65 dBmV total, equal PSD):
 * P1.6hi − max(P1.6_i). SC-QAM: P1.6 = P − 10·log10(bw/1.6); OFDMA: P1.6 = P6.4eq − 6.02.
 */
export function usHeadroom(
  scqam: readonly { powerDbmv: number; bwMHz?: number }[],
  ofdma: readonly { p64: number; bwMHz: number }[],
  pmax = 65,
): number | null {
  const p16 = [
    ...scqam.map((c) => c.powerDbmv - 10 * Math.log10((c.bwMHz ?? 6.4) / 1.6)),
    ...ofdma.map((c) => c.p64 - 6.02),
  ];
  const spectrum = scqam.reduce((s, c) => s + (c.bwMHz ?? 6.4), 0) + ofdma.reduce((s, c) => s + c.bwMHz, 0);
  const neq = spectrum / 1.6;
  if (p16.length === 0 || neq <= 0) return null;
  let p16hi = pmax - 10 * Math.log10(neq);
  if (spectrum <= 24) p16hi = Math.min(p16hi, 53.2 + (pmax - 65));
  return Math.round((p16hi - Math.max(...p16)) * 10) / 10;
}

/** Mobile bands near a DS frequency range (LTE/5G ingress hint, §5.3). */
export function mobileBandHint(startMHz: number, endMHz: number): string | null {
  const bands: { name: string; ranges: [number, number][] }[] = [
    { name: 'LTE/5G 700 MHz', ranges: [[703, 733], [758, 788]] },
    { name: 'LTE 800 MHz', ranges: [[791, 821], [832, 862]] },
    { name: 'LTE 900 MHz', ranges: [[880, 915], [925, 960]] },
  ];
  for (const b of bands) {
    for (const [lo, hi] of b.ranges) if (endMHz >= lo && startMHz <= hi) return b.name;
  }
  return null;
}

// ─── Snapshot rating ───────────────────────────────────────────────────────

/** Channel as produced by a router parser (rating not yet applied). */
export type DocsisChannelInput = Omit<DocsisChannel, 'rating' | 'ratingNote'> & {
  rating?: Health;
  ratingNote?: string | null;
  /** raw lock / ranging text from the router (e.g. 'Locked', 'ACTIVE', 'continue') */
  lockText?: string | null;
};

export type DocsisAspect = 'power' | 'snr' | 'mer' | 'lock' | 'modulation' | 'outlier' | 'neighbour' | 'limit';

export interface DocsisChannelCheck {
  aspect: DocsisAspect;
  grade: DocsisGrade;
  /** German short text */
  note: string;
}

export interface RatedDocsisChannel extends DocsisChannel {
  /** stable identity (dir, type, rounded frequency) */
  key: string;
  family: DocsisFamily;
  grade: DocsisGrade;
  lockText?: string | null;
  /** OFDMA: 6.4 MHz-equivalent power used for the rating */
  powerNormDbmv?: number | null;
  /** OFDM: CNR required by the profile modulation */
  requiredMerDb?: number | null;
  checks: DocsisChannelCheck[];
}

export interface DocsisFinding {
  code: 'channel' | 'partial' | 'tilt' | 'headroom' | 'no-data';
  grade: DocsisGrade;
  /** German text */
  text: string;
  family?: DocsisFamily;
  channelKey?: string;
}

export interface FamilyCount {
  /** all rows reported by the router (incl. unlocked placeholder rows) */
  count: number;
  /** rows that carry data and are not reported as unlocked (lock state missing counts as locked) */
  locked: number;
  /** rows explicitly reported as not locked / ranging failed */
  unlocked: number;
}

export interface DocsisSummary {
  families: Record<DocsisFamily, FamilyCount>;
  /** locked DS SC-QAM channels */
  dsPower: { min: number; max: number; avg: number } | null;
  dsSnr: { min: number; avg: number } | null;
  ofdmPowerAvg: number | null;
  ofdmMerMin: number | null;
  usPower: { min: number; max: number; avg: number } | null;
  /** raw displayed OFDMA power (average) */
  ofdmaPowerAvg: number | null;
  /** level difference highest − lowest DS SC-QAM frequency (64QAM offset normalized) */
  tiltDb: number | null;
  usHeadroomDb: number | null;
  ofdma: { key: string; p64: number; mode: Exclude<OfdmaMode, 'auto'>; confidence: OfdmaNormalization['confidence'] }[];
  /** sums over DS channels, null when the router has no codeword counters (Vodafone Station) */
  corrected: number | null;
  uncorrectable: number | null;
  counts: Record<'good' | 'warn' | 'bad' | 'unknown', number>;
}

export interface RatedDocsisSnapshot extends DocsisSnapshot {
  ds: RatedDocsisChannel[];
  us: RatedDocsisChannel[];
  grade: DocsisGrade;
  findings: DocsisFinding[];
  summary: DocsisSummary;
}

export interface DocsisRateOptions {
  /** max. locked channels per family within the last 7 days (partial-service baseline) */
  baseline?: Partial<Record<DocsisFamily, number>> | null;
  /** since when (epoch ms) each family has had fewer locked channels than the baseline */
  partialSince?: Partial<Record<DocsisFamily, number | null>> | null;
  /** OFDMA power display interpretation (default auto-detect) */
  ofdmaMode?: OfdmaMode;
  /** max. number of channel notes copied into snapshot notes (default 8) */
  maxChannelNotes?: number;
}

/** Per-family channel counts (all rows / locked rows / explicitly unlocked rows). */
export function familyCounts(
  channels: readonly Pick<DocsisChannel, 'dir' | 'type' | 'locked' | 'frequencyMHz' | 'frequencyText' | 'powerDbmv'>[],
): Record<DocsisFamily, FamilyCount> {
  const out: Record<DocsisFamily, FamilyCount> = {
    ds: { count: 0, locked: 0, unlocked: 0 },
    ofdm: { count: 0, locked: 0, unlocked: 0 },
    us: { count: 0, locked: 0, unlocked: 0 },
    ofdma: { count: 0, locked: 0, unlocked: 0 },
  };
  for (const ch of channels) {
    const f = out[channelFamily(ch)];
    f.count++;
    if (ch.locked === false) f.unlocked++;
    else if (ch.locked === true || frequencyRange(ch) !== null || isNumber(ch.powerDbmv)) f.locked++;
  }
  return out;
}

function stats(values: readonly number[]): { min: number; max: number; avg: number } | null {
  if (values.length === 0) return null;
  let min = values[0], max = values[0], sum = 0;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }
  return { min, max, avg: Math.round((sum / values.length) * 100) / 100 };
}

const isNumber = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);

function directionWord(v: number, b: Breaks6): string {
  return v > b[3] ? 'zu hoch' : v <= b[2] ? 'zu niedrig' : '';
}

function powerCheck(power: number, b: Breaks6, extra = ''): DocsisChannelCheck {
  const grade = rateSymmetric(power, b);
  const dirWord = directionWord(power, b);
  return {
    aspect: 'power',
    grade,
    note: `Pegel${dirWord ? ` ${dirWord}` : ''}: ${fdbmv(power)}${extra} (${GRADE_SHORT[grade]})`,
  };
}

/** Lower-bound check (SNR / MER): neutral text while konform, "zu niedrig" otherwise. */
function lowerBoundCheck(aspect: 'snr' | 'mer', value: number, a: Breaks3): DocsisChannelCheck {
  const grade = rateLowerBound(value, a);
  const label = aspect === 'snr' ? 'SNR' : 'MER';
  const note = grade === 'konform'
    ? `${label} ${fdb(value)} (konform)`
    : `${label}${grade === 'toleriert' ? '' : ' zu niedrig'}: ${fdb(value)} (${GRADE_SHORT[grade]})`;
  return { aspect, grade, note };
}

function lockCheck(ch: DocsisChannelInput): DocsisChannelCheck | null {
  const text = ch.lockText ?? null;
  const st = text !== null && text.trim() !== ''
    ? lockState(text, ch.dir)
    : ch.locked === true ? 'locked' : ch.locked === false ? 'failed' : null;
  if (st === null) return null;
  const quoted = text ? ` („${text.trim()}“)` : '';
  if (st === 'locked') return { aspect: 'lock', grade: 'konform', note: 'gelockt' };
  if (ch.dir === 'ds') return { aspect: 'lock', grade: 'sofort', note: `nicht gelockt${quoted}` };
  if (st === 'transient') return { aspect: 'lock', grade: 'monatsfrist', note: `Ranging läuft noch${quoted}` };
  if (st === 'failed') return { aspect: 'lock', grade: 'sofort', note: `Ranging fehlgeschlagen${quoted}` };
  return { aspect: 'lock', grade: 'monatsfrist', note: `unbekannter Ranging-Status${quoted}` };
}

interface Working {
  input: DocsisChannelInput;
  key: string;
  family: DocsisFamily;
  qam: number | null;
  checks: DocsisChannelCheck[];
  powerNorm: number | null;
  requiredMer: number | null;
}

/** 64QAM-offset-normalized DS level for tilt/neighbour comparisons. */
function normLevel(w: Working): number | null {
  const p = w.input.powerDbmv;
  if (!isNumber(p)) return null;
  return w.qam !== null && w.qam <= 128 ? p + QAM64_OFFSET_DB : p;
}

function channelBaseChecks(w: Working): void {
  const ch = w.input;
  const lock = lockCheck(ch);
  if (lock) w.checks.push(lock);
  const range = frequencyRange(ch);

  if (w.family === 'ds') {
    const row = dsRow(w.qam);
    if (row && isNumber(ch.powerDbmv)) w.checks.push(powerCheck(ch.powerDbmv, VFKD.dsPower[row]));
    if (row && isNumber(ch.snrDb)) w.checks.push(lowerBoundCheck('snr', ch.snrDb, VFKD.dsSnr[row]));
  } else if (w.family === 'ofdm') {
    if (isNumber(ch.powerDbmv)) w.checks.push(powerCheck(ch.powerDbmv, VFKD.dsPower.qam1024));
    const unsupported = !!ch.modulation && /unsupported|unknown|none|n\/a/i.test(ch.modulation);
    if (unsupported) {
      w.checks.push({ aspect: 'modulation', grade: 'sofort', note: `OFDM-Profil „${ch.modulation}“` });
    } else if (w.qam !== null && w.qam < 4096) {
      // lower profile = less throughput (CMTS downgrade); informational, changes are tracked separately
      w.checks.push({ aspect: 'modulation', grade: 'toleriert', note: `OFDM-Profil ${ch.modulation} (unter 4096QAM)` });
    }
    if (isNumber(ch.snrDb)) {
      const r = rateOfdmMer(ch.snrDb, unsupported ? null : w.qam, range ? range.end : null);
      w.requiredMer = r.requiredDb;
      if (r.requiredDb !== null && r.marginDb !== null) {
        const prof = ch.modulation ?? 'das Profil';
        let note: string;
        if (r.marginDb >= OFDM_GOOD_MARGIN_DB) {
          note = `MER ${fdb(ch.snrDb)} (${fdb(r.marginDb)} über dem für ${prof} nötigen Wert von ${fdb(r.requiredDb)})`;
        } else if (r.marginDb >= 0) {
          note = `MER ${fdb(ch.snrDb)} – nur ${fdb(r.marginDb)} über dem für ${prof} nötigen Wert (${fdb(r.requiredDb)})`;
        } else {
          note = `MER ${fdb(ch.snrDb)} unter dem für ${prof} nötigen Wert (${fdb(r.requiredDb)})`;
        }
        w.checks.push({ aspect: 'mer', grade: r.grade, note });
      } else {
        w.checks.push(lowerBoundCheck('mer', ch.snrDb, VFKD.ofdmMerFallback));
      }
    }
  } else if (w.family === 'us') {
    if (isNumber(ch.powerDbmv)) w.checks.push(powerCheck(ch.powerDbmv, VFKD.usPowerScqam));
    const mg = rateUsModulation(w.qam);
    if (mg !== 'unbekannt') {
      w.checks.push({
        aspect: 'modulation',
        grade: mg,
        note: `Upstream-Modulation ${ch.modulation}${mg === 'sofort' ? ' (stark gestört)' : mg === 'monatsfrist' ? ' (gestört?)' : ''}`,
      });
    }
  }
  // OFDMA power is rated after normalization (needs all SC-QAM powers), modulation is informational.
}

/**
 * Rate one poll of DOCSIS channels (§3–§9): per-channel VFKD grades, OFDM MER vs required CNR,
 * SNR outliers, neighbour level jumps, tilt, partial service vs baseline, upstream headroom and
 * modulation. Returns contract-compatible DocsisSnapshot (+ grade, findings, summary).
 */
export function rateDocsis(
  ts: number,
  dsIn: readonly DocsisChannelInput[],
  usIn: readonly DocsisChannelInput[],
  opts: DocsisRateOptions = {},
): RatedDocsisSnapshot {
  const usedKeys = new Set<string>();
  const mk = (input: DocsisChannelInput, index: number): Working => {
    let key = channelKey(input, index);
    if (usedKeys.has(key)) {
      let n = 2;
      while (usedKeys.has(`${key}#${n}`)) n++;
      key = `${key}#${n}`;
    }
    usedKeys.add(key);
    return {
      input: { ...input, type: normalizeChannelType(input.type, input.dir) },
      key,
      family: channelFamily({ dir: input.dir, type: normalizeChannelType(input.type, input.dir) }),
      qam: qamOrder(input.modulation),
      checks: [],
      powerNorm: null,
      requiredMer: null,
    };
  };
  const ds = dsIn.map((c, i) => mk(c, i));
  const us = usIn.map((c, i) => mk(c, ds.length + i));
  const all = [...ds, ...us];
  for (const w of all) channelBaseChecks(w);

  const isLocked = (w: Working) => w.input.locked !== false;

  // ── SNR outliers per modulation group (DS SC-QAM, locked) ──
  const dsScqam = ds.filter((w) => w.family === 'ds' && isLocked(w));
  const groups = new Map<number, Working[]>();
  for (const w of dsScqam) {
    if (w.qam === null || !isNumber(w.input.snrDb)) continue;
    const g = groups.get(w.qam) ?? [];
    g.push(w);
    groups.set(w.qam, g);
  }
  for (const g of groups.values()) {
    if (g.length < 3) continue;
    const med = medianOf(g.map((w) => w.input.snrDb as number));
    if (med === null) continue;
    for (const w of g) {
      const snr = w.input.snrDb as number;
      const below = Math.round((med - snr) * 10) / 10;
      if (below >= SNR_OUTLIER_DB) {
        const r = frequencyRange(w.input);
        const band = r ? mobileBandHint(r.start - 4, r.end + 4) : null;
        w.checks.push({
          aspect: 'outlier',
          grade: 'monatsfrist',
          note: `SNR ${fdb(below)} unter dem Median gleicher Modulation – Einstrahlungsverdacht${band ? ` (${band})` : ''}`,
        });
      }
    }
  }

  // ── neighbour level jumps + tilt (DS SC-QAM, locked, with power + frequency) ──
  const leveled = dsScqam
    .map((w) => ({ w, f: frequencyRange(w.input)?.start ?? null, lvl: normLevel(w) }))
    .filter((x): x is { w: Working; f: number; lvl: number } => x.f !== null && x.lvl !== null)
    .sort((a, b) => a.f - b.f);
  if (leveled.length >= 2) {
    const medLvl = medianOf(leveled.map((x) => x.lvl)) ?? 0;
    for (let i = 1; i < leveled.length; i++) {
      const a = leveled[i - 1];
      const b = leveled[i];
      if (b.f - a.f > NEIGHBOUR_MAX_GAP_MHZ) continue;
      const diff = Math.round(Math.abs(b.lvl - a.lvl) * 10) / 10;
      if (diff <= NEIGHBOUR_MAX_DB) continue;
      const [odd, other] = Math.abs(a.lvl - medLvl) >= Math.abs(b.lvl - medLvl) ? [a, b] : [b, a];
      if (odd.w.checks.some((c) => c.aspect === 'neighbour')) continue;
      odd.w.checks.push({
        aspect: 'neighbour',
        grade: 'monatsfrist',
        note: `Pegelsprung ${fdb(diff)} zum Nachbarkanal (${fmhz(other.f)})`,
      });
    }
  }
  const tiltDb = leveled.length >= 2
    ? Math.round((leveled[leveled.length - 1].lvl - leveled[0].lvl) * 10) / 10
    : null;

  // ── upstream: OFDMA normalization, modem limit, headroom ──
  const usScqam = us.filter((w) => w.family === 'us' && isLocked(w) && isNumber(w.input.powerDbmv));
  const scqamPowers = usScqam.map((w) => w.input.powerDbmv as number);
  const ofdmaNorm: DocsisSummary['ofdma'] = [];
  const ofdmaForHeadroom: { p64: number; bwMHz: number }[] = [];
  for (const w of us) {
    if (w.family !== 'ofdma' || !isNumber(w.input.powerDbmv)) continue;
    const r = frequencyRange(w.input);
    const bw = r && r.end > r.start ? r.end - r.start : null;
    const n = normalizeOfdmaPower(w.input.powerDbmv, bw, scqamPowers, opts.ofdmaMode ?? 'auto');
    w.powerNorm = n.p64;
    ofdmaNorm.push({ key: w.key, p64: n.p64, mode: n.mode, confidence: n.confidence });
    const extra = n.mode === 'p6.4' ? '' : ` (auf 6,4 MHz umgerechnet aus ${fdbmv(w.input.powerDbmv)})`;
    w.checks.push(powerCheck(n.p64, VFKD.usPowerOfdma, extra));
    if (isLocked(w) && bw) ofdmaForHeadroom.push({ p64: n.p64, bwMHz: bw });
  }
  const ofdmaActive = us.some((w) => w.family === 'ofdma' && isLocked(w) && isNumber(w.input.powerDbmv));
  if (ofdmaActive) {
    for (const w of usScqam) {
      const p = w.input.powerDbmv as number;
      if (p >= US_SCQAM_LIMIT_WITH_OFDMA_DBMV) {
        w.checks.push({ aspect: 'limit', grade: 'sofort', note: `Modem am Sendelimit: ${fdbmv(p)} bei aktivem OFDMA` });
      }
    }
  }
  const headroom = usHeadroom(usScqam.map((w) => ({ powerDbmv: w.input.powerDbmv as number })), ofdmaForHeadroom);

  // ── findings ──
  const findings: DocsisFinding[] = [];
  const counts = familyCounts(all.map((w) => w.input));

  if (tiltDb !== null && Math.abs(tiltDb) > TILT_MAX_DB) {
    findings.push({
      code: 'tilt',
      grade: 'monatsfrist',
      text: `Pegel-Schräglage im Downstream ${fdb(tiltDb)} (über ${TILT_MAX_DB} dB)`,
      family: 'ds',
    });
  }
  if (headroom !== null && headroom < US_HEADROOM_WARN_DB) {
    findings.push({
      code: 'headroom',
      grade: headroom < US_HEADROOM_BAD_DB ? 'sofort' : 'monatsfrist',
      text: headroom < US_HEADROOM_BAD_DB
        ? `Upstream-Sendereserve nur ${fdb(headroom)} – Modem am Sendelimit`
        : `Upstream-Sendereserve nur ${fdb(headroom)} (Modem nahe am Sendelimit)`,
      family: 'us',
    });
  }
  for (const fam of DOCSIS_FAMILIES) {
    const c = counts[fam];
    const base = opts.baseline?.[fam] ?? 0;
    const missingVsBase = base > 0 && c.locked < base;
    const unlockedRows = c.unlocked > 0;
    if (!missingVsBase && !unlockedRows) continue;
    const since = opts.partialSince?.[fam] ?? null;
    const persistent = since !== null && ts - since >= PARTIAL_CRITICAL_MS;
    const grade: DocsisGrade = fam !== 'ds' || persistent ? 'sofort' : 'monatsfrist';
    const ref = missingVsBase ? ` (7-Tage-Maximum ${base})` : '';
    const total = Math.max(c.count, base);
    findings.push({
      code: 'partial',
      grade,
      text: `Teilbetrieb ${FAMILY_LABEL[fam]}: ${c.locked} von ${total} Kanälen gelockt${ref}${persistent ? ' – seit über 15 min' : ''}`,
      family: fam,
    });
  }

  // ── channel grades ──
  const rated = (w: Working): RatedDocsisChannel => {
    const grade = worstGrade(w.checks.map((c) => c.grade));
    const health = gradeHealth(grade);
    const bad = w.checks
      .filter((c) => c.grade === 'monatsfrist' || c.grade === 'sofort')
      .sort((a, b) => GRADE_RANK[b.grade] - GRADE_RANK[a.grade]);
    const c = w.input;
    const out: RatedDocsisChannel = {
      dir: c.dir,
      channelId: c.channelId,
      type: c.type,
      frequencyMHz: c.frequencyMHz,
      frequencyText: c.frequencyText,
      powerDbmv: c.powerDbmv,
      snrDb: c.snrDb,
      modulation: c.modulation,
      locked: c.locked,
      corrected: c.corrected,
      uncorrectable: c.uncorrectable,
      rating: health,
      ratingNote: health === 'warn' || health === 'bad' ? bad.map((x) => x.note).join('; ') : null,
      key: w.key,
      family: w.family,
      grade,
      lockText: c.lockText ?? null,
      checks: w.checks,
    };
    if (w.family === 'ofdma') out.powerNormDbmv = w.powerNorm;
    if (w.family === 'ofdm') out.requiredMerDb = w.requiredMer;
    if (c.raw) out.raw = c.raw;
    return out;
  };
  const dsOut = ds.map(rated);
  const usOut = us.map(rated);
  const allOut = [...dsOut, ...usOut];

  // channel findings: lost channels (DS SC-QAM lock, or any channel explicitly not locked) count via
  // the partial-service rule instead (avoids reporting the same loss twice)
  const channelFindings: DocsisFinding[] = [];
  const channelGrades: DocsisGrade[] = [];
  for (const ch of allOut) {
    const relevant = ch.checks.filter((c) => !(c.aspect === 'lock' && (ch.family === 'ds' || ch.locked === false)));
    const g = worstGrade(relevant.map((c) => c.grade));
    channelGrades.push(g);
    if (g !== 'monatsfrist' && g !== 'sofort') continue;
    const notes = relevant
      .filter((c) => c.grade === 'monatsfrist' || c.grade === 'sofort')
      .sort((a, b) => GRADE_RANK[b.grade] - GRADE_RANK[a.grade])
      .map((c) => c.note);
    channelFindings.push({ code: 'channel', grade: g, text: `${channelLabel(ch)}: ${notes.join('; ')}`, family: ch.family, channelKey: ch.key });
  }
  channelFindings.sort((a, b) => GRADE_RANK[b.grade] - GRADE_RANK[a.grade]);
  findings.push(...channelFindings);

  if (allOut.length === 0) {
    findings.push({ code: 'no-data', grade: 'unbekannt', text: 'Keine DOCSIS-Kanaldaten vom Router erhalten' });
  }
  findings.sort((a, b) => GRADE_RANK[b.grade] - GRADE_RANK[a.grade]);

  const overall = worstGrade([...findings.map((f) => f.grade), ...channelGrades]);

  // notes: snapshot findings first, then at most N channel notes
  const maxNotes = opts.maxChannelNotes ?? 8;
  const notes: string[] = [];
  let channelNotes = 0;
  let omitted = 0;
  for (const f of findings) {
    if (f.code === 'no-data') {
      notes.push(f.text);
      continue;
    }
    if (f.grade !== 'monatsfrist' && f.grade !== 'sofort') continue;
    if (f.code === 'channel') {
      if (channelNotes >= maxNotes) {
        omitted++;
        continue;
      }
      channelNotes++;
    }
    notes.push(f.text);
  }
  if (omitted > 0) notes.push(`… und ${omitted} weitere Kanäle auffällig`);

  // ── summary ──
  const lockedDs = dsOut.filter((c) => c.family === 'ds' && c.locked !== false);
  const ofdmCh = dsOut.filter((c) => c.family === 'ofdm' && c.locked !== false);
  const dsSnrVals = lockedDs.map((c) => c.snrDb).filter(isNumber);
  const snrStats = stats(dsSnrVals);
  const ofdmPower = stats(ofdmCh.map((c) => c.powerDbmv).filter(isNumber));
  const ofdmMer = stats(ofdmCh.map((c) => c.snrDb).filter(isNumber));
  const ofdmaPower = stats(usOut.filter((c) => c.family === 'ofdma').map((c) => c.powerDbmv).filter(isNumber));
  const corrected = dsOut.map((c) => c.corrected).filter(isNumber);
  const uncorrectable = dsOut.map((c) => c.uncorrectable).filter(isNumber);
  const healthCounts = { good: 0, warn: 0, bad: 0, unknown: 0 };
  for (const c of allOut) healthCounts[c.rating]++;

  const summary: DocsisSummary = {
    families: counts,
    dsPower: stats(lockedDs.map((c) => c.powerDbmv).filter(isNumber)),
    dsSnr: snrStats ? { min: snrStats.min, avg: snrStats.avg } : null,
    ofdmPowerAvg: ofdmPower ? ofdmPower.avg : null,
    ofdmMerMin: ofdmMer ? ofdmMer.min : null,
    usPower: stats(usScqam.map((w) => w.input.powerDbmv as number)),
    ofdmaPowerAvg: ofdmaPower ? ofdmaPower.avg : null,
    tiltDb,
    usHeadroomDb: headroom,
    ofdma: ofdmaNorm,
    corrected: corrected.length > 0 ? corrected.reduce((a, b) => a + b, 0) : null,
    uncorrectable: uncorrectable.length > 0 ? uncorrectable.reduce((a, b) => a + b, 0) : null,
    counts: healthCounts,
  };

  return {
    ts,
    ds: dsOut,
    us: usOut,
    rating: gradeHealth(overall),
    notes,
    grade: overall,
    findings,
    summary,
  };
}

// ─── Router event log categorizer (§11) ────────────────────────────────────

export type LogCategory =
  | 'T3' | 'T4' | 'T2' | 'ranging' | 'sync' | 'ucd' | 'partial' | 'mdd' | 'drw' | 'cm-status' | 'profile'
  | 'dhcp' | 'provisioning' | 'tod' | 'reboot' | 'other';

export interface LogClassification {
  /** rule key, e.g. 'us_t3_timeout', 'cm_status_16', 'other' */
  key: string;
  category: LogCategory;
  /** base severity before burst escalation */
  severity: Severity;
  dir: 'US' | 'DS' | '-';
  cmStatusCode: number | null;
  /** German short title */
  title: string;
}

interface LogRule {
  key: string;
  re: RegExp;
  category: LogCategory;
  dir: 'US' | 'DS' | '-';
  severity: Severity;
  title: string;
}

/** Order matters: "retries exhausted" before "t3 time-out", provisioning (T6) before ranging. */
const LOG_RULES: readonly LogRule[] = [
  {
    key: 'provisioning_fail',
    re: /dhcp failed|tftp failed|tftp file complete - but|reg rsp not received|registration rsp rejected|t6 timeout and retries exceeded|rs sent, no ra|solicit sent, no dhcp advertise/,
    category: 'provisioning', dir: '-', severity: 'critical', title: 'Provisionierung/Registrierung fehlgeschlagen',
  },
  {
    key: 'us_ranging_retries_exhausted', re: /retries exhausted|16 consecutive t3 timeouts/,
    category: 'ranging', dir: 'US', severity: 'critical', title: 'Ranging fehlgeschlagen (Wiederholungen erschöpft)',
  },
  { key: 'us_t4_timeout', re: /t4 time ?-?out/, category: 'T4', dir: 'US', severity: 'critical', title: 'T4-Timeout (CMTS fragt das Modem nicht mehr ab)' },
  { key: 'us_ranging_abort', re: /unicast ranging received abort response/, category: 'ranging', dir: 'US', severity: 'critical', title: 'Ranging vom CMTS abgebrochen' },
  { key: 'us_t3_timeout', re: /t3 time ?-?out/, category: 'T3', dir: 'US', severity: 'warn', title: 'T3-Timeout (keine Ranging-Antwort vom CMTS)' },
  { key: 'us_binit_fail', re: /b-init-rng failure/, category: 'ranging', dir: 'US', severity: 'warn', title: 'Gebündeltes Init-Ranging fehlgeschlagen' },
  { key: 'ds_t2_timeout', re: /t2 time ?-?out/, category: 'T2', dir: 'DS', severity: 'critical', title: 'T2-Timeout (keine Ranging-Gelegenheiten)' },
  {
    key: 'ds_no_ucd', re: /no ucds received|ucd invalid or channel unusable|ucd & sync valid - no maps|no maps for this channel/,
    category: 'ucd', dir: 'DS', severity: 'critical', title: 'Upstream-Kanalbeschreibung fehlt oder ungültig (UCD)',
  },
  {
    key: 'ds_sync_loss',
    re: /sync timing synchronization failure|loss of sync|failed to acquire (qam|qpsk|fec|mpeg2)|failed to acquire .*symbol timing|mac sync frame|mpeg2 sync/,
    category: 'sync', dir: 'DS', severity: 'critical', title: 'Synchronisation verloren (Downstream)',
  },
  { key: 'ds_primary_fail', re: /rcs primary ds failure/, category: 'sync', dir: 'DS', severity: 'critical', title: 'Primärer Downstream-Kanal ausgefallen' },
  { key: 'ds_partial', re: /rcs partial service/, category: 'partial', dir: 'DS', severity: 'warn', title: 'Teilbetrieb Downstream (Kanäle verloren)' },
  { key: 'us_all_fail', re: /tcs fail on all upstream channels/, category: 'partial', dir: 'US', severity: 'critical', title: 'Alle Upstream-Kanäle ausgefallen' },
  { key: 'us_partial', re: /tcs partial service/, category: 'partial', dir: 'US', severity: 'warn', title: 'Teilbetrieb Upstream (Kanäle verloren)' },
  {
    key: 'ds_mdd', re: /lost mdd timeout|mdd message timeout|missing mandatory mdd tlv/,
    category: 'mdd', dir: 'DS', severity: 'warn', title: 'MDD-Timeout (Downstream-Steuerdaten fehlen)',
  },
  {
    key: 'us_drw', re: /dynamic range window|top of the drw|in excess of 6 db below/,
    category: 'drw', dir: 'US', severity: 'warn', title: 'Upstream-Sendepegel am Limit (Dynamic Range Window)',
  },
  { key: 'dhcp_renew_fail', re: /dhcp (renew|rebind) sent - no response/, category: 'dhcp', dir: '-', severity: 'warn', title: 'DHCP-Verlängerung ohne Antwort' },
  { key: 'tod', re: /tod (request sent|response received)/, category: 'tod', dir: '-', severity: 'info', title: 'Zeitserver antwortet nicht (ToD)' },
  { key: 'profile_change', re: /(ds|us) profile assignment change/, category: 'profile', dir: '-', severity: 'info', title: 'OFDM-/OFDMA-Profil gewechselt' },
  {
    key: 'boot', re: /honoring mdd|cold start|warm start|reboot|tlv-11 - unrecognized oid|power ?on|system up/,
    category: 'reboot', dir: '-', severity: 'info', title: 'Modem-Start / Neuregistrierung',
  },
  { key: 'dhcp_other', re: /\bdhcp/, category: 'dhcp', dir: '-', severity: 'info', title: 'DHCP-Hinweis' },
];

/** CM-STATUS event type codes (MULPI 3.1 Table 10-4) → German name, severity, category. */
export const CM_STATUS_CODES: Record<number, { name: string; severity: Severity; category: LogCategory }> = {
  1: { name: 'MDD-Timeout auf Sekundärkanal', severity: 'warn', category: 'mdd' },
  2: { name: 'QAM/FEC-Lock verloren', severity: 'critical', category: 'sync' },
  3: { name: 'Sequenz außerhalb des Bereichs', severity: 'warn', category: 'cm-status' },
  4: { name: 'MDD auf Sekundärkanal wieder empfangen', severity: 'info', category: 'mdd' },
  5: { name: 'QAM/FEC-Lock wiederhergestellt', severity: 'info', category: 'sync' },
  6: { name: 'T4-Timeout', severity: 'critical', category: 'T4' },
  7: { name: 'T3-Wiederholungen überschritten', severity: 'critical', category: 'ranging' },
  8: { name: 'Ranging nach T3-Fehlern wieder erfolgreich', severity: 'info', category: 'ranging' },
  9: { name: 'Modem im Batteriebetrieb', severity: 'info', category: 'cm-status' },
  10: { name: 'Modem wieder am Stromnetz', severity: 'info', category: 'cm-status' },
  11: { name: 'MAC-Adresse entfernt', severity: 'info', category: 'cm-status' },
  16: { name: 'OFDM-Profilfehler (Downstream)', severity: 'warn', category: 'profile' },
  17: { name: 'Primärer Downstream gewechselt', severity: 'warn', category: 'cm-status' },
  18: { name: 'DPD-Fehler', severity: 'warn', category: 'cm-status' },
  20: { name: 'NCP-Profilfehler', severity: 'critical', category: 'profile' },
  21: { name: 'PLC-Fehler', severity: 'critical', category: 'profile' },
  22: { name: 'NCP-Profil wiederhergestellt', severity: 'info', category: 'profile' },
  23: { name: 'PLC wiederhergestellt', severity: 'info', category: 'profile' },
  24: { name: 'OFDM-Profil wiederhergestellt', severity: 'info', category: 'profile' },
  25: { name: 'OFDMA-Profilfehler', severity: 'warn', category: 'profile' },
  26: { name: 'MAP-Speicher übergelaufen', severity: 'warn', category: 'cm-status' },
  27: { name: 'MAP-Speicher fast voll', severity: 'info', category: 'cm-status' },
};

const MAC_RE = /\b[0-9a-f]{2}(?:[:-][0-9a-f]{2}){5}\b/gi;

/** Strip the `;CM-MAC=…` tail, normalize dashes/whitespace, lower-case (§11.1). */
export function normalizeLogMessage(raw: string): string {
  return raw
    .replace(/;?\s*(?:cm|cmts)-mac\s*=.*$/i, '')
    .replace(/[‐-―­−]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** MAC addresses contained in a log message (CM-MAC / CMTS-MAC). */
export function extractMacs(text: string): string[] {
  return [...text.matchAll(MAC_RE)].map((m) => m[0].toLowerCase());
}

/** Replace all MAC addresses by 'xx:xx:xx:xx:xx:xx' (exports / reports). */
export function redactMacs(text: string): string {
  return text.replace(MAC_RE, 'xx:xx:xx:xx:xx:xx');
}

/** Severity of an unmatched message from the OSSI priority (number 1–8 or word, de/en). */
function severityFromLevel(level: string | null | undefined): Severity {
  const s = (level ?? '').toString().trim().toLowerCase();
  if (s === '') return 'info';
  const n = Number(/^\d+/.exec(s)?.[0] ?? Number.NaN);
  if (Number.isFinite(n)) return n >= 1 && n <= 4 ? 'warn' : 'info';
  if (/emerg|alert|crit|krit|error|fehler|notfall|alarm/.test(s)) return 'warn';
  return 'info';
}

/** Classify one router log message (catalogue §11.3, CM-STATUS codes §11.4). */
export function classifyLogMessage(raw: string, level?: string | null): LogClassification {
  const m = normalizeLogMessage(raw);
  const cs = /cm-status message sent\.?\s*event type code:?\s*(\d+)/.exec(m);
  if (cs) {
    const code = Number(cs[1]);
    const def = CM_STATUS_CODES[code];
    return {
      key: `cm_status_${code}`,
      category: def?.category ?? 'cm-status',
      severity: def?.severity ?? 'warn',
      dir: '-',
      cmStatusCode: code,
      title: `CM-STATUS ${code}: ${def?.name ?? 'unbekanntes Ereignis'}`,
    };
  }
  for (const r of LOG_RULES) {
    if (r.re.test(m)) {
      return { key: r.key, category: r.category, severity: r.severity, dir: r.dir, cmStatusCode: null, title: r.title };
    }
  }
  return { key: 'other', category: 'other', severity: severityFromLevel(level), dir: '-', cmStatusCode: null, title: 'Router-Ereignis' };
}

/** Burst rules (§11.3/§14.3): within `windowMs` at least `count` entries with this key → `to`. */
export const LOG_BURST_RULES: readonly { key: string; windowMs: number; count: number; to: Severity; reason: string }[] = [
  { key: 'us_t3_timeout', windowMs: 10 * 60_000, count: 3, to: 'critical', reason: '≥ 3 T3-Timeouts in 10 min' },
  { key: 'us_t3_timeout', windowMs: 24 * 3_600_000, count: 10, to: 'critical', reason: '≥ 10 T3-Timeouts pro Tag' },
  { key: 'ds_mdd', windowMs: 3_600_000, count: 3, to: 'critical', reason: '≥ 3 MDD-Timeouts pro Stunde' },
  { key: 'cm_status_16', windowMs: 3_600_000, count: 4, to: 'critical', reason: 'mehr als 3 OFDM-Profilfehler pro Stunde' },
  { key: 'us_drw', windowMs: 3_600_000, count: 3, to: 'critical', reason: 'gehäufte Pegel-Limit-Meldungen' },
  { key: 'profile_change', windowMs: 3_600_000, count: 7, to: 'warn', reason: 'mehr als 6 Profilwechsel pro Stunde' },
];

const SEV_RANK: Record<Severity, number> = { info: 0, warn: 1, critical: 2 };

export interface LogBurstInput {
  ts: number | null;
  key: string;
  severity: Severity;
}

/**
 * Escalate severities of entries that belong to a burst: every entry inside a window of length
 * `windowMs` that contains ≥ `count` entries of the same key gets the rule's severity.
 * Entries without timestamp keep their base severity. Returns one result per input (same order).
 */
export function escalateLogBursts(entries: readonly LogBurstInput[]): { severity: Severity; burst: string | null }[] {
  const out = entries.map((e) => ({ severity: e.severity, burst: null as string | null }));
  for (const rule of LOG_BURST_RULES) {
    const idx = entries
      .map((e, i) => ({ ts: e.ts, i, key: e.key }))
      .filter((x): x is { ts: number; i: number; key: string } => x.key === rule.key && x.ts !== null && Number.isFinite(x.ts))
      .sort((a, b) => a.ts - b.ts);
    let lo = 0;
    for (let hi = 0; hi < idx.length; hi++) {
      while (idx[hi].ts - idx[lo].ts > rule.windowMs) lo++;
      if (hi - lo + 1 >= rule.count) {
        for (let k = lo; k <= hi; k++) {
          const o = out[idx[k].i];
          if (SEV_RANK[rule.to] > SEV_RANK[o.severity]) o.severity = rule.to;
          if (o.burst === null) o.burst = rule.reason;
        }
      }
    }
  }
  return out;
}
