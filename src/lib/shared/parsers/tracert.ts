// Parser for Windows `tracert -d -w 1000 -h N [-4|-6] <target>` output (fallback path discovery).
// Pure functions, de-DE and en-US. Format facts (docs/research/windows-collectors.md §4.1):
//  - hop number "%1!3lu!  " followed by three 9-char RTT columns: "%1!4lu! ms  ", "  <1 ms  ", "   *     "
//  - then the address (plus a trailing space), a localized timeout text or "<ip> meldet: <msg>"
//  - header "Routenverfolgung zu <t> über maximal <n> Hops" / "Tracing route to <t> over a maximum of <n> hops"
//  - end "Ablaufverfolgung beendet." / "Trace complete."
// Only ASCII fragments of localized words are matched so a wrong code page can never break parsing.
import { isIpLiteral, sameIp } from '../net';
import type { TraceHop } from '../types';

/** RTT of one tracert probe in ms ('<1 ms' → 0.5), null for '*'. */
export type TracertProbe = number | null;

export type TracertNote =
  | 'timeout'
  | 'net-unreachable'
  | 'host-unreachable'
  | 'protocol-unreachable'
  | 'transmit-error'
  | 'general-failure'
  | 'other';

export type TracertErrorKind = 'resolve' | 'driver' | 'transmit' | 'usage';

export type TracertLine =
  | { kind: 'blank' }
  | { kind: 'header'; target: string; address: string | null; maxHops: number | null }
  /** second header line when tracert resolved a name: "über maximal 30 Hops:" */
  | { kind: 'header-hops'; maxHops: number }
  | {
      kind: 'hop';
      hop: number;
      rtts: TracertProbe[];
      ip: string | null;
      host: string | null;
      note: TracertNote | null;
      /** remaining text after the columns (address or message) */
      text: string;
    }
  | { kind: 'end' }
  | { kind: 'error'; error: TracertErrorKind; text: string }
  | { kind: 'unknown'; text: string };

export interface ParsedTracert {
  target: string | null;
  /** resolved address from the header (only when tracert was given a host name) */
  address: string | null;
  maxHops: number | null;
  hops: TraceHop[];
  /** destination answered (last hop = target address) */
  reached: boolean;
  /** "Ablaufverfolgung beendet." / "Trace complete." seen */
  complete: boolean;
  /** an intermediate router reported the destination unreachable (tracert stops there) */
  unreachable: { hop: number; ip: string | null; note: TracertNote } | null;
  error: string | null;
}

const COL = String.raw`(?:<\s*\d+\s*ms|\d+\s*ms|\*)`;
const HOP_RE = new RegExp(String.raw`^\s*(\d{1,3})((?:\s+${COL}){1,3})(?:\s+(.*?))?\s*$`, 'i');
const COL_RE = new RegExp(COL, 'gi');
const HEADER_RE =
  /^(?:Routenverfolgung zu|Tracing route to)\s+(\S+)(?:\s+\[([^\]]+)\])?(?:\s+(?:\S{0,2}ber maximal|over a maximum of)\s+(\d+)\s+hops)?/i;
const HEADER_HOPS_RE = /^(?:\S{0,2}ber maximal|over a maximum of)\s+(\d+)\s+hops:?$/i;
const END_RE = /^(?:Ablaufverfolgung beendet|Trace complete)\.?$/i;
const REPORTS_RE = /^(\S+)\s+(?:meldet|reports):\s*(.*)$/i;
const HOST_IP_RE = /^(\S+)\s+\[([^\]]+)\]$/;

/** Parse one RTT column token: "12 ms" → 12, "<1 ms" → 0.5, "*" → null. */
export function parseTracertColumn(token: string): TracertProbe {
  const t = token.trim();
  if (t === '*') return null;
  if (t.startsWith('<')) return 0.5;
  const m = /^(\d+)\s*ms$/i.exec(t);
  return m ? Number(m[1]) : null;
}

/** Classify the localized message part of a hop line (or a standalone error line). */
export function classifyTracertMessage(text: string): TracertNote {
  const s = text.trim();
  if (/berschreitung der Anforderung|Request timed out/i.test(s)) return 'timeout';
  if (/Zielnetz nicht erreichbar|Destination net(?:work)? unreachable/i.test(s)) return 'net-unreachable';
  if (/Zielhost nicht erreichbar|Destination host unreachable/i.test(s)) return 'host-unreachable';
  if (/Zielprotokoll nicht erreichbar|Destination protocol unreachable/i.test(s)) return 'protocol-unreachable';
  if (/bertragungsfehler|Transmit error/i.test(s)) return 'transmit-error';
  if (/Allgemeiner Fehler|General failure/i.test(s)) return 'general-failure';
  return 'other';
}

function stripZone(ip: string): string {
  return ip.replace(/%.*$/, '');
}

function parseHopRemainder(text: string): { ip: string | null; host: string | null; note: TracertNote | null } {
  const s = text.trim();
  if (s === '') return { ip: null, host: null, note: null };
  if (isIpLiteral(s)) return { ip: stripZone(s), host: null, note: null };
  const hostIp = HOST_IP_RE.exec(s);
  if (hostIp && isIpLiteral(hostIp[2])) return { ip: stripZone(hostIp[2]), host: hostIp[1], note: null };
  const rep = REPORTS_RE.exec(s);
  if (rep) {
    const addr = rep[1].replace(/^\[|\]$/g, '');
    return { ip: isIpLiteral(addr) ? stripZone(addr) : null, host: null, note: classifyTracertMessage(rep[2]) };
  }
  return { ip: null, host: null, note: classifyTracertMessage(s) };
}

/** Classify a single (complete) tracert output line. */
export function parseTracertLine(line: string): TracertLine {
  const s = line.replace(/\r$/, '');
  const t = s.trim();
  if (t === '') return { kind: 'blank' };

  const hop = HOP_RE.exec(s);
  if (hop) {
    const rtts = (hop[2].match(COL_RE) ?? []).map(parseTracertColumn);
    const rest = hop[3] ?? '';
    const { ip, host, note } = parseHopRemainder(rest);
    return { kind: 'hop', hop: Number(hop[1]), rtts, ip, host, note, text: rest.trim() };
  }

  const header = HEADER_RE.exec(t);
  if (header) {
    return {
      kind: 'header',
      target: header[1],
      address: header[2] && isIpLiteral(header[2]) ? stripZone(header[2]) : null,
      maxHops: header[3] ? Number(header[3]) : null,
    };
  }
  const headerHops = HEADER_HOPS_RE.exec(t);
  if (headerHops) return { kind: 'header-hops', maxHops: Number(headerHops[1]) };
  if (END_RE.test(t)) return { kind: 'end' };

  if (/konnte nicht aufgel|Unable to resolve target/i.test(t)) return { kind: 'error', error: 'resolve', text: t };
  if (/IP-Treiber|Unable to contact IP driver/i.test(t)) return { kind: 'error', error: 'driver', text: t };
  if (/bertragungsfehler|Transmit error/i.test(t)) return { kind: 'error', error: 'transmit', text: t };
  if (/^(?:Syntax|Usage):\s*tracert/i.test(t)) return { kind: 'error', error: 'usage', text: t };
  return { kind: 'unknown', text: t };
}

function toTraceHop(hop: number, rtts: TracertProbe[], ip: string | null): TraceHop {
  const ok = rtts.filter((r): r is number => r !== null);
  const lossPct = rtts.length > 0 ? ((rtts.length - ok.length) / rtts.length) * 100 : 100;
  const avgMs = ok.length > 0 ? ok.reduce((a, b) => a + b, 0) / ok.length : null;
  return { hop, ip, rtts, lossPct, avgMs };
}

/** Parse a complete tracert output (already decoded with decodeConsole / ConsoleLineSplitter). */
export function parseTracert(text: string): ParsedTracert {
  const out: ParsedTracert = {
    target: null,
    address: null,
    maxHops: null,
    hops: [],
    reached: false,
    complete: false,
    unreachable: null,
    error: null,
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = parseTracertLine(raw);
    switch (line.kind) {
      case 'header':
        out.target = line.target;
        out.address = line.address;
        if (line.maxHops !== null) out.maxHops = line.maxHops;
        break;
      case 'header-hops':
        out.maxHops = line.maxHops;
        break;
      case 'hop': {
        // a responder that only reports an error (no RTT column answered) still identifies the hop
        out.hops.push(toTraceHop(line.hop, line.rtts, line.ip));
        if (line.note && line.note !== 'timeout' && line.note !== 'other' && out.unreachable === null) {
          out.unreachable = { hop: line.hop, ip: line.ip, note: line.note };
        }
        break;
      }
      case 'end':
        out.complete = true;
        break;
      case 'error':
        out.error ??= line.text;
        break;
      default:
        break;
    }
  }
  out.hops.sort((a, b) => a.hop - b.hop);
  const dest = out.address ?? (out.target && isIpLiteral(out.target) ? out.target : null);
  const last = out.hops[out.hops.length - 1];
  out.reached = !!(dest && last?.ip && sameIp(last.ip, dest));
  return out;
}
