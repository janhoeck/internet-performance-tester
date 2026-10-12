// Parser for macOS `pmset -g log` (docs/research/macos.md §5): power management history with
// sleep / wake / dark wake / powerd start lines. Not localized. Pure.
//
//   Time stamp                Domain              	Message                                   	Duration  	Delay
//   ==========                ======              	=======                                   	========  	=====
//   2026-10-12 22:10:01 +0200 Sleep               	Entering Sleep state due to 'Idle Sleep':… 	2 secs
//   2026-10-12 22:40:13 +0200 DarkWake            	DarkWake from Deep Idle [CDNP] : due to …  	45 secs
//   2026-10-13 07:30:05 +0200 Wake                	Wake from Deep Idle [CDNVA] : due to …
//   2026-10-13 08:01:02 +0200 Start               	powerd process is started
// [unverified: exact column padding – the parser splits at the first tab, else at 2+ spaces]

export type PmsetKind = 'sleep' | 'wake' | 'darkwake' | 'start' | 'shutdown';

export interface PmsetEntry {
  ts: number;
  /** raw domain column, e.g. 'Sleep', 'Wake Requests', 'Assertions' */
  domain: string;
  message: string;
  /** power transition of the line, null for every other domain */
  kind: PmsetKind | null;
  /** sleep that ends a dark wake ("Maintenance Sleep") */
  maintenance: boolean;
}

const LINE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2}):?(\d{2})\s+(.*)$/;

const KINDS: Record<string, PmsetKind> = {
  sleep: 'sleep',
  wake: 'wake',
  darkwake: 'darkwake',
  start: 'start',
  shutdown: 'shutdown',
};

/** '2026-10-12', '22:10:01', '+0200' parts → epoch ms */
function toEpoch(m: RegExpExecArray): number {
  const utc = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
  const offsetMin = (Number(m[8]) * 60 + Number(m[9])) * (m[7] === '-' ? -1 : 1);
  return utc - offsetMin * 60_000;
}

/** All timestamped lines (header, separator and UUID lines are skipped). */
export function parsePmsetLog(text: string): PmsetEntry[] {
  const out: PmsetEntry[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const m = LINE.exec(raw);
    if (!m) continue;
    const rest = m[10];
    let domain: string;
    let message: string;
    if (rest.includes('\t')) {
      const cols = rest.split('\t');
      domain = cols[0].trim();
      message = (cols[1] ?? '').trim();
    } else {
      const cols = rest.trim().split(/\s{2,}/);
      domain = cols[0] ?? '';
      message = (cols[1] ?? '').trim();
    }
    if (domain === '') continue;
    const kind = KINDS[domain.replace(/\s+/g, '').toLowerCase()] ?? null;
    out.push({ ts: toEpoch(m), domain, message, kind, maintenance: kind === 'sleep' && /maintenance sleep/i.test(message) });
  }
  return out;
}

/** Power transitions only (sleep, wake, dark wake, powerd start = boot, shutdown), oldest first. */
export function pmsetPowerEntries(text: string): PmsetEntry[] {
  return parsePmsetLog(text)
    .filter((e) => e.kind !== null)
    .sort((a, b) => a.ts - b.ts);
}
