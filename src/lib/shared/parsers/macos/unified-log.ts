// Parser for the macOS unified log (`log show --style ndjson`, docs/research/macos.md §5): kernel
// link messages of Ethernet drivers for the history import, e.g.
//   {"timestamp":"2026-10-12 21:03:04.123456+0200","eventMessage":"Link up on en7, 1-Gigabit, Full-duplex, Symmetric flow-control, Debug [796d,2301,0de1,0300,cde1,3800]",…}
//   {"timestamp":"2026-10-12 21:02:58.000123+0200","eventMessage":"AppleBCM5701Ethernet [en0]: Link down on en0",…}
// [unverified: the wording differs between drivers – unrecognised messages are ignored] Pure.

export interface UnifiedLogEntry {
  ts: number;
  message: string;
  process: string | null;
}

export interface KernelLinkEvent {
  ts: number;
  /** BSD name, e.g. 'en7' */
  device: string;
  up: boolean;
  mbps: number | null;
  duplex: 'full' | 'half' | null;
  message: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** '2026-10-12 21:03:04.123456+0200' (also 'T', 'Z', '+02:00') → epoch ms; null if invalid. */
export function parseLogTimestamp(s: unknown): number | null {
  if (typeof s !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?\s*(Z|[+-]\d{2}:?\d{2})?$/.exec(s.trim());
  if (!m) return null;
  const ms = m[7] ? Number(`${m[7]}00`.slice(0, 3)) : 0;
  let t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]), ms);
  const tz = m[8];
  if (tz && tz !== 'Z') {
    const sign = tz[0] === '-' ? -1 : 1;
    const digits = tz.slice(1).replace(':', '');
    t -= sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4))) * 60_000;
  }
  return Number.isFinite(t) ? t : null;
}

/** One JSON object per line; banner lines, the trailing summary object and garbage are skipped. */
export function parseLogNdjson(text: string): UnifiedLogEntry[] {
  const out: UnifiedLogEntry[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith('{')) continue;
    let v: unknown;
    try {
      v = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(v) || typeof v.eventMessage !== 'string') continue;
    const ts = parseLogTimestamp(v.timestamp);
    if (ts === null) continue;
    const proc = typeof v.processImagePath === 'string' ? v.processImagePath : typeof v.process === 'string' ? v.process : null;
    out.push({ ts, message: v.eventMessage, process: proc });
  }
  return out;
}

const LINK = /\bLink (up|down) on (en\d+)\b(.*)$/i;

/** '1-Gigabit' → 1000, '100-Megabit' → 100, '2.5-Gigabit' → 2500 */
function speedOf(rest: string): number | null {
  const m = /(\d+(?:\.\d+)?)\s*-?\s*(Gigabit|Megabit|Gbps|Mbps)/i.exec(rest);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  return /^g/i.test(m[2]) ? Math.round(n * 1000) : Math.round(n);
}

/** Link change in a kernel message, null for anything else. */
export function kernelLinkEvent(message: string): Omit<KernelLinkEvent, 'ts' | 'message'> | null {
  const m = LINK.exec(message);
  if (!m) return null;
  const up = m[1].toLowerCase() === 'up';
  const rest = m[3] ?? '';
  const duplex = /full[- ]duplex/i.test(rest) ? 'full' : /half[- ]duplex/i.test(rest) ? 'half' : null;
  return { device: m[2], up, mbps: up ? speedOf(rest) : null, duplex: up ? duplex : null };
}

/** Link events of a `log show --style ndjson` output, oldest first. */
export function parseKernelLinkEvents(text: string): KernelLinkEvent[] {
  const out: KernelLinkEvent[] = [];
  for (const e of parseLogNdjson(text)) {
    const k = kernelLinkEvent(e.message);
    if (k) out.push({ ts: e.ts, message: e.message, ...k });
  }
  return out.sort((a, b) => a.ts - b.ts);
}
