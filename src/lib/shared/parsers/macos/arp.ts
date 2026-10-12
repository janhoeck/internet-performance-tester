// Parser for macOS `arp -n <ip>` / `arp -an` (docs/research/macos.md §0, identity). Not localized. Pure.
//
//   ? (192.168.0.1) at dc:73:6:12:34:df on en7 ifscope [ethernet]
//   ? (192.168.0.1) at (incomplete) on en7 ifscope [ethernet]
//   192.168.0.1 (192.168.0.1) -- no entry
import { padMac } from './netstat';

export interface ArpEntry {
  ip: string;
  /** 'aa:bb:cc:dd:ee:ff' (octets padded), null for incomplete entries */
  mac: string | null;
  /** BSD name of the interface */
  device: string | null;
  permanent: boolean;
}

const LINE = /^\S+\s+\(([^)]+)\)\s+at\s+(\S+)(?:\s+on\s+(\S+))?(.*)$/;

/** Neighbour entries; "-- no entry" lines and unknown text are skipped. */
export function parseArp(text: string): ArpEntry[] {
  const out: ArpEntry[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const m = LINE.exec(raw.trim());
    if (!m) continue;
    out.push({
      ip: m[1],
      mac: padMac(m[2]),
      device: m[3] ?? null,
      permanent: /\bpermanent\b/.test(m[4] ?? ''),
    });
  }
  return out;
}

/** MAC of `ip` (first complete entry), null when unknown or incomplete. */
export function arpMacFor(entries: readonly ArpEntry[], ip: string): string | null {
  return entries.find((e) => e.ip === ip && e.mac !== null)?.mac ?? null;
}
