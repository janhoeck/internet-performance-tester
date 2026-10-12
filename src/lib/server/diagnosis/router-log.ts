// Tolerant classification of router event-log entries (`router_log` events written by the router
// module). Prefers details.category / details.cmStatusCode (categorizer of shared/docsis.ts) and
// falls back to the message text (English DOCSIS texts + German titles). Pure.
import type { NetEvent } from '../../shared/types';
import { detailNumber, detailString } from './util';

export type LineLogKind = 'T3' | 'T4' | 'sync' | 'ranging' | 'partial' | 'mdd' | 'cm-status' | 'reboot' | 'other';

const CATEGORY_MAP: Readonly<Record<string, LineLogKind>> = {
  T3: 'T3',
  T4: 'T4',
  T2: 'sync',
  sync: 'sync',
  ucd: 'sync',
  provisioning: 'ranging',
  ranging: 'ranging',
  partial: 'partial',
  mdd: 'mdd',
  'cm-status': 'cm-status',
  reboot: 'reboot',
};

/** CM-STATUS codes that mean lost lock / failed ranging / FEC over limit (docsis-thresholds §11.4) */
const CRITICAL_CM_STATUS = new Set([2, 6, 7, 20, 21]);

const TEXT_RULES: readonly [RegExp, LineLogKind][] = [
  [/retries exhausted|16 consecutive t3|wiederholungen erschöpft|ranging (vom cmts )?abgebrochen|abort response/, 'ranging'],
  [/t4[ -]?time ?-?out|t4-timeout/, 'T4'],
  [/t3[ -]?time ?-?out|t3-timeout/, 'T3'],
  [/loss of sync|sync timing|failed to acquire|synchronisation verloren|primary ds failure|primärer downstream|t2[ -]?time ?-?out|no ucds|\(ucd\)/, 'sync'],
  [/partial service|teilbetrieb|fail on all upstream|alle upstream-kanäle/, 'partial'],
  [/\bmdd\b/, 'mdd'],
  [/cm-status/, 'cm-status'],
  [/cold start|warm start|reboot|honoring mdd|modem-start|neuregistrierung/, 'reboot'],
];

export function lineLogKind(e: NetEvent): LineLogKind {
  const cat = detailString(e, 'category');
  if (cat !== null && CATEGORY_MAP[cat]) return CATEGORY_MAP[cat];
  const text = `${detailString(e, 'message') ?? ''} ${detailString(e, 'rawMessage') ?? ''} ${e.title}`.toLowerCase();
  for (const [re, kind] of TEXT_RULES) if (re.test(text)) return kind;
  return 'other';
}

/** CM-STATUS event type code of an entry (details.cmStatusCode or parsed from the text) */
export function cmStatusCode(e: NetEvent): number | null {
  const n = detailNumber(e, 'cmStatusCode');
  if (n !== null) return n;
  const m = /event type code:?\s*(\d+)/i.exec(`${detailString(e, 'message') ?? ''} ${e.title}`);
  return m ? Number(m[1]) : null;
}

/** entry that by itself indicates a line fault (T4, sync loss, ranging failure, critical CM-STATUS) */
export function isSevereLineEntry(e: NetEvent): boolean {
  const k = lineLogKind(e);
  if (k === 'T4' || k === 'sync' || k === 'ranging') return true;
  if (k === 'cm-status' || k === 'mdd' || k === 'other') {
    const code = cmStatusCode(e);
    return code !== null && CRITICAL_CM_STATUS.has(code);
  }
  return false;
}

/** upstream partial service / all upstream channels failed → treat as critical */
export function isUpstreamPartial(e: NetEvent): boolean {
  if (lineLogKind(e) !== 'partial') return false;
  const dir = detailString(e, 'dir');
  if (dir === 'US') return true;
  return /\btcs |upstream/i.test(`${detailString(e, 'message') ?? ''} ${e.title}`);
}
