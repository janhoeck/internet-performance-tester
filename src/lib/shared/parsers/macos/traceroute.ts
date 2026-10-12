// Parser for macOS `/usr/sbin/traceroute -n …` and `/usr/sbin/traceroute6 -n …` output (stdout +
// stderr), used by the macOS path discovery / MTR runner (docs/research/macos.md §6). Not localized.
// Pure.
//
//   traceroute to 1.1.1.1 (1.1.1.1), 30 hops max, 72 byte packets      (stderr)
//    1  192.168.0.1  1.234 ms  0.987 ms  1.012 ms
//    2  * * *
//    4  10.0.0.1  10.1 ms  10.0.0.2  11.2 ms *
//    5  192.0.2.7  20.3 ms !H
//   traceroute: sendto: No route to host                                  (stderr)
//    1 traceroute: wrote 1.1.1.1 52 chars, ret=-1
import { isIpLiteral } from '../../net';

export interface BsdTraceProbe {
  /** responder (zone id kept), null for '*' */
  from: string | null;
  rttMs: number | null;
  /** "!H", "!N", "!P", "!S", "!F-1460", "!X", "!<10>" … after the time (null = none) */
  annotation: string | null;
  /** the probe could not be sent ("wrote … ret=-1") */
  sendError: boolean;
}

export interface BsdTraceHop {
  ttl: number;
  probes: BsdTraceProbe[];
}

export interface BsdTraceroute {
  hops: BsdTraceHop[];
  /** destination from the header line, null when absent */
  destination: string | null;
  /** "traceroute: sendto: No route to host" etc. */
  errors: string[];
  /** the tool rejected its arguments (exit 64 / usage text / illegal option) */
  usage: boolean;
}

/** Unreachable annotations (the plain "!" only flags a reply TTL ≤ 1 and is no error). */
export function isUnreachableAnnotation(a: string | null): boolean {
  return a !== null && /^!(?:[HNPSXVCZATUM]|F(?:-\d+)?|<\d+>|\d+)$/.test(a);
}

const ip = (token: string): string | null => {
  const t = token.replace(/^\(|\)$/g, '');
  return isIpLiteral(t) ? t : null;
};

function tokenizeInto(hop: BsdTraceHop, rest: string, state: { from: string | null }): void {
  const tokens = rest.trim().split(/\s+/).filter((t) => t !== '');
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '*') {
      hop.probes.push({ from: null, rttMs: null, annotation: null, sendError: false });
      continue;
    }
    if (t.startsWith('!')) {
      const last = hop.probes[hop.probes.length - 1];
      if (last && last.annotation === null && last.from !== null) last.annotation = t;
      continue;
    }
    const addr = ip(t);
    if (addr !== null) {
      state.from = addr;
      continue;
    }
    if (/^\d+(?:\.\d+)?$/.test(t) && tokens[i + 1] === 'ms') {
      hop.probes.push({ from: state.from, rttMs: Number(t), annotation: null, sendError: false });
      i++;
    }
    // host names (without -n) and anything else are skipped; "(ip)" after a name was handled above
  }
}

const WROTE = /traceroute6?: wrote \S+ \d+ chars, ret=-?\d+/;

export function parseBsdTraceroute(text: string): BsdTraceroute {
  const out: BsdTraceroute = { hops: [], destination: null, errors: [], usage: false };
  let hop: BsdTraceHop | null = null;
  const state = { from: null as string | null };
  // a failed send prints "traceroute: wrote … ret=-1\n" in the middle of the hop line, before the
  // probe's own '*' – put the marker on a line of its own
  const lines = text.replace(/(traceroute6?: wrote )/g, '\n$1').split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (line === '') continue;
    let m: RegExpExecArray | null;
    if ((m = /^traceroute6? to \S+ \((\S+?)\)/.exec(line))) {
      out.destination = m[1];
      continue;
    }
    if (/^usage:|illegal option|invalid option|unrecognized option|option requires an argument|unknown option/i.test(line)) {
      out.usage = true;
      continue;
    }
    if (WROTE.test(line)) {
      hop?.probes.push({ from: null, rttMs: null, annotation: null, sendError: true });
      continue;
    }
    if ((m = /^traceroute6?: (.+)$/.exec(line))) {
      out.errors.push(m[1].trim());
      continue;
    }
    if ((m = /^(\d+)(?:\s+(.*))?$/.exec(line))) {
      const ttl = Number(m[1]);
      hop = out.hops.find((h) => h.ttl === ttl) ?? null;
      if (!hop) {
        hop = { ttl, probes: [] };
        out.hops.push(hop);
      }
      state.from = null;
      if (m[2]) tokenizeInto(hop, m[2], state);
      continue;
    }
    // continuation of the current hop (after a "wrote … ret=-1" marker)
    if (hop && /^(\*|!|\d+(?:\.\d+)?\s+ms\b|\S+\s+\d+(?:\.\d+)?\s+ms\b)/.test(line)) {
      const tokens = line.split(/\s+/);
      // the '*' right after a send failure is that failed probe's own output
      const last = hop.probes[hop.probes.length - 1];
      if (last?.sendError && tokens[0] === '*') tokens.shift();
      if (tokens.length > 0) tokenizeInto(hop, tokens.join(' '), state);
    }
  }
  out.hops.sort((a, b) => a.ttl - b.ttl);
  return out;
}
