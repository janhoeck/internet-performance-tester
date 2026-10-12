// Parser for one-shot macOS `/sbin/ping -n -c 1 -s 32 -W <ms> <ip>` and `/sbin/ping6 -n -c 1 -s 32
// <ip>` output (stdout + stderr), used by the macOS pinger and the MTU probe (docs/research/macos.md
// §2/§6). The tools are not localized (spawned with LC_ALL=C). Pure.
//
//   40 bytes from 1.1.1.1: icmp_seq=0 ttl=57 time=12.345 ms
//   40 bytes from 2606:4700:4700::1111, icmp_seq=0 hlim=57 time=12.345 ms       (ping6: comma!)
//   92 bytes from 192.168.0.1: Destination Host Unreachable                      (+ header dump)
//   36 bytes from 192.168.0.1: Frag needed and DF set (MTU 1460)
//   ping: sendto: No route to host
//   16 bytes from fe80::1%en0: Packet too big mtu = 1280                         (ping6 -v only)
import { SampleStatus, type SampleStatusCode } from '../../types';

export type MacPingKind = 'reply' | 'unreachable' | 'ttl_expired' | 'too_big' | 'send_error' | 'none';

export interface MacPingResult {
  kind: MacPingKind;
  /** RTT of the (first) echo reply in ms */
  rtt: number | null;
  /** responding address ("bytes from X"), zone id kept; null for local errors / no answer */
  from: string | null;
  /** errno text of a local send failure ("No route to host") or the ICMP error text */
  error: string | null;
  /** next-hop MTU from "Frag needed and DF set (MTU 1460)" / "Packet too big mtu = 1280" */
  mtu: number | null;
  /** local send failure that means "no neighbour / no route" (ARP or ND failed) → a loss, not an error */
  localUnreachable: boolean;
  /** the tool rejected its arguments (unknown option, usage text) */
  usage: boolean;
}

// The address ends at the first ':' or ',' followed by whitespace (IPv6 addresses contain colons).
const REPLY = /^\d+ bytes from (\S+?)[:,]\s+icmp_seq=\d+\s+(?:ttl|hlim)=\d+\s+time=([\d.]+)\s*ms/;
const ICMP_ERROR = /^\d+ bytes from (\S+?)[:,]\s+(.+)$/;
const SEND_ERROR = /^ping6?: (?:sendto|sendmsg|send|writing to socket): (.+)$/i;
const LOCAL_UNREACHABLE = /no route to host|host is down|network is unreachable|host is unreachable|network is down/i;
const TOO_BIG_LOCAL = /message too long/i;
const USAGE = /^usage:|illegal option|invalid option|unrecognized option|option requires an argument/i;
// header, statistics and the IP header dump printed after ICMP errors (case-sensitive: "ping:" is no noise)
const NOISE = /^(PING6?\b|---|\d+ packets? transmitted|round-trip|Request timeout for icmp_seq|Vr HL TOS|\d+\s+\d+\s+[0-9a-fA-F]{2}\s)/;

const empty = (): MacPingResult => ({ kind: 'none', rtt: null, from: null, error: null, mtu: null, localUnreachable: false, usage: false });

/** Kind of an ICMP error message text ("Destination Host Unreachable", "Time to live exceeded", …). */
export function icmpErrorKind(text: string): { kind: MacPingKind; mtu: number | null } | null {
  const frag = /frag(?:mentation)? needed and DF set \(MTU (\d+)\)/i.exec(text);
  if (frag) return { kind: 'too_big', mtu: Number(frag[1]) };
  const ptb = /packet too big(?: mtu = (\d+))?/i.exec(text);
  if (ptb) return { kind: 'too_big', mtu: ptb[1] ? Number(ptb[1]) : null };
  if (/frag(?:mentation)? needed/i.test(text)) return { kind: 'too_big', mtu: null };
  if (/time to live exceeded|hop limit exceeded|time exceeded/i.test(text)) return { kind: 'ttl_expired', mtu: null };
  if (/unreachable|unknown|prohibited|isolated|filter|source route failed|no route to destination/i.test(text)) {
    return { kind: 'unreachable', mtu: null };
  }
  return null;
}

/** Classifies the complete output of one ping/ping6 run (`family` only documents the caller's intent). */
export function parseMacPing(text: string, _family: 4 | 6 = 4): MacPingResult {
  void _family;
  const r = empty();
  let icmp: { kind: MacPingKind; from: string; error: string; mtu: number | null } | null = null;
  let send: { error: string } | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '') continue;
    let m: RegExpExecArray | null;
    if ((m = REPLY.exec(line))) {
      if (r.kind !== 'reply') {
        r.kind = 'reply';
        r.from = m[1];
        r.rtt = Number(m[2]);
      }
      continue;
    }
    if (NOISE.test(line)) continue;
    if ((m = ICMP_ERROR.exec(line))) {
      const k = icmpErrorKind(m[2]);
      if (k && !icmp) icmp = { kind: k.kind, from: m[1], error: m[2].trim(), mtu: k.mtu };
      continue;
    }
    if ((m = SEND_ERROR.exec(line))) {
      send ??= { error: m[1].trim() };
      continue;
    }
    if (USAGE.test(line)) {
      r.usage = true;
      continue;
    }
    // "ping: cannot resolve …", "ping: wrote … ret=-1" and other fatal messages of the tool
    if (/^ping6?:/i.test(line)) send ??= { error: line.replace(/^ping6?:\s*/i, '') };
  }
  if (r.kind === 'reply') return r;
  if (icmp) return { ...r, kind: icmp.kind, from: icmp.from, error: icmp.error, mtu: icmp.mtu };
  if (send) {
    if (TOO_BIG_LOCAL.test(send.error)) return { ...r, kind: 'too_big', error: send.error };
    return { ...r, kind: 'send_error', error: send.error, localUnreachable: LOCAL_UNREACHABLE.test(send.error) };
  }
  if (r.usage) return { ...r, kind: 'send_error', error: 'usage' };
  return r;
}

/**
 * Sample status of one echo (same semantics as the Windows agent, ARCHITECTURE §4.5): reply → OK
 * (later than `timeoutMs` → TIMEOUT), ICMP unreachable and ARP/ND send failures → UNREACHABLE, any
 * ICMP error "from" one of our own addresses → UNREACHABLE, TTL exceeded → TTL_EXPIRED, no answer →
 * TIMEOUT, everything else (too big, other local errors) → ERROR.
 */
export function macPingStatus(r: MacPingResult, timeoutMs: number, isOwnAddress: (ip: string) => boolean = () => false): SampleStatusCode {
  switch (r.kind) {
    case 'reply':
      return r.rtt !== null && r.rtt > timeoutMs ? SampleStatus.TIMEOUT : SampleStatus.OK;
    case 'none':
      return SampleStatus.TIMEOUT;
    case 'send_error':
      return r.localUnreachable ? SampleStatus.UNREACHABLE : SampleStatus.ERROR;
    default:
      if (r.from && isOwnAddress(r.from)) return SampleStatus.UNREACHABLE;
      if (r.kind === 'unreachable') return SampleStatus.UNREACHABLE;
      if (r.kind === 'ttl_expired') return SampleStatus.TTL_EXPIRED;
      return SampleStatus.ERROR;
  }
}

/** RTT stored for a reply (null otherwise); a reported 0.000 ms becomes 0.001 ms. */
export function macPingRtt(r: MacPingResult, status: SampleStatusCode): number | null {
  if (status !== SampleStatus.OK || r.rtt === null || r.rtt < 0) return null;
  return r.rtt > 0 ? r.rtt : 0.001;
}
