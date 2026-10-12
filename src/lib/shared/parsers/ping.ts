// Parser for single lines of Windows ping.exe output (de-DE and en-US), used by the ping.exe
// fallback of the ICMP probe (engine/probes/ping-fallback.ts).
//
// Decode the raw bytes first with ConsoleLineSplitter (cp850.ts): ping.exe writes the OEM code page
// (CP850) to pipes. The patterns below only use ASCII fragments, so a wrong code page (CP850 vs.
// UTF-8 vs. 1252) can never break the classification. Message texts: fixtures/windows/res_ping.*.json.
//
// Loss semantics: every echo line except a reply is a loss. Windows itself counts
// "Zielhost nicht erreichbar" (ARP failure, reported by our own address) as *received* and ping
// exits with code 0 – never trust ping's own statistics or exit code.
import { sameIp } from '../net';
import { SampleStatus, type SampleStatusCode } from '../types';

export type PingLineKind =
  /** "Antwort von 1.1.1.1: Bytes=32 Zeit=18ms TTL=57" – IPv6 replies have no bytes/TTL */
  | 'reply'
  /** "Zeitüberschreitung der Anforderung." / "Request timed out." */
  | 'timeout'
  /** "Antwort von 192.168.0.192: Zielhost nicht erreichbar." (host/net/port/protocol) */
  | 'unreachable'
  /** "Die Gültigkeitsdauer wurde bei der Übertragung überschritten." / "TTL expired in transit." */
  | 'ttl_expired'
  /** "Paket müsste fragmentiert werden, DF-Flag ist jedoch gesetzt." */
  | 'too_big'
  /** "PING: Fehler bei der Übertragung. Allgemeiner Fehler." (link down / no route), hardware error, no resources */
  | 'failure'
  | 'header'
  | 'stats'
  /** "Ping-Anforderung konnte Host "x" nicht finden." – ping exits */
  | 'resolve_failed'
  | 'blank'
  | 'unknown';

export interface PingParseContext {
  /** own interface addresses: an error reply "from" one of them is a local ARP/ND failure */
  ownAddresses?: readonly string[];
}

export interface PingLine {
  kind: PingLineKind;
  /** the line reports the result of exactly one echo request (= one sample) */
  echo: boolean;
  /** sample status for echo lines (null otherwise) */
  status: SampleStatusCode | null;
  /** RTT in ms for replies ("Zeit<1ms" and "Zeit=0ms" → 0.5), null otherwise */
  rtt: number | null;
  /** TTL of IPv4 replies (never required: IPv6 replies carry none) */
  ttl: number | null;
  bytes: number | null;
  /** responding address from "Antwort von X:" / "Reply from X:" (zone id kept), null if absent */
  from: string | null;
  /** `from` is one of our own addresses (local neighbour resolution failed) */
  local: boolean;
}

/** RTT stored for sub-millisecond replies ("Zeit<1ms"), same as the .NET agent's rtt 0 → 0.5 ms. */
export const SUB_MS_RTT = 0.5;

// IPv6 addresses contain ':' – the address ends at the first ": " (colon + whitespace).
const FROM_RE = /^(?:Antwort von|Reply from)\s+(.+?):\s/i;
// "Zeitüberschreitung" contains "Zeit" too, but never "Zeit=<digits>" / "Zeit<digits>".
const REPLY_RE = /(?:Zeit|time)\s?([=<])\s?(\d+)\s?ms/i;
const TTL_RE = /\bTTL=(\d+)/i;
const BYTES_RE = /\bbytes=(\d+)/i;

const HEADER_RE = /^(?:Ping wird ausgef|Pinging\s)/i;
const STATS_RE =
  /^(?:Ping-Statistik|Ping statistics|Ca\. Zeitangaben|Approximate round trip)|(?:Gesendet|Sent) = \d+, (?:Empfangen|Received) = \d+|Minimum = \d+ms, Maximum = \d+ms|^\(\d+% (?:Verlust|loss)\)/i;
const UNREACHABLE_RE =
  /Ziel(?:host|netz|port|protokoll) nicht erreichbar|Destination (?:host|net|port|protocol) unreachable/i;
const TIMEOUT_RE = /berschreitung der Anforderung|Request timed out/i;
const TOO_BIG_RE = /fragmentiert werden|needs to be fragmented/i;
const TRANSMIT_FAILED_RE = /^PING: (?:Fehler bei der|transmit failed)/i;
const FAILURE_RE = /Allgemeiner Fehler|General failure|Hardwarefehler|Hardware error|Keine Ressourcen|No resources/i;
// "bei der Übertragung überschritten": the umlaut may be 1 (CP850/UTF-8 decoded) or 2 chars (mangled)
const TTL_EXPIRED_RE = /bei der .{1,2}bertragung .{1,2}berschritten|TTL expired in transit/i;
const RESOLVE_FAILED_RE = /konnte Host .* nicht finden|could not find host/i;

function base(kind: PingLineKind): PingLine {
  return { kind, echo: false, status: null, rtt: null, ttl: null, bytes: null, from: null, local: false };
}

function echoLine(kind: PingLineKind, status: SampleStatusCode, from: string | null, ctx: PingParseContext): PingLine {
  return { ...base(kind), echo: true, status, from, local: isOwn(from, ctx) };
}

function isOwn(from: string | null, ctx: PingParseContext): boolean {
  if (!from || !ctx.ownAddresses || ctx.ownAddresses.length === 0) return false;
  const ip = from.split('%')[0];
  return ctx.ownAddresses.some((own) => sameIp(own.split('%')[0], ip));
}

function toInt(s: string | undefined): number | null {
  if (s === undefined) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Classify one decoded ping.exe output line. Pure; never throws. */
export function parsePingLine(line: string, ctx: PingParseContext = {}): PingLine {
  const s = line.trim();
  if (s === '') return base('blank');
  if (HEADER_RE.test(s)) return base('header');
  if (STATS_RE.test(s)) return base('stats');

  const from = FROM_RE.exec(s)?.[1] ?? null;
  const reply = REPLY_RE.exec(s);
  if (reply) {
    const ms = Number(reply[2]);
    const rtt = reply[1] === '<' || ms === 0 ? SUB_MS_RTT : ms;
    return {
      ...echoLine('reply', SampleStatus.OK, from, ctx),
      rtt,
      ttl: toInt(TTL_RE.exec(s)?.[1]),
      bytes: toInt(BYTES_RE.exec(s)?.[1]),
    };
  }
  if (UNREACHABLE_RE.test(s)) return echoLine('unreachable', SampleStatus.UNREACHABLE, from, ctx);
  if (TIMEOUT_RE.test(s)) return echoLine('timeout', SampleStatus.TIMEOUT, from, ctx);
  if (TOO_BIG_RE.test(s)) return echoLine('too_big', SampleStatus.ERROR, from, ctx);
  // before TTL_EXPIRED_RE: "PING: Fehler bei der Übertragung." also contains "bei der Übertragung"
  if (TRANSMIT_FAILED_RE.test(s) || FAILURE_RE.test(s)) return echoLine('failure', SampleStatus.ERROR, from, ctx);
  if (TTL_EXPIRED_RE.test(s)) return echoLine('ttl_expired', SampleStatus.TTL_EXPIRED, from, ctx);
  if (RESOLVE_FAILED_RE.test(s)) return base('resolve_failed');
  return base('unknown');
}
