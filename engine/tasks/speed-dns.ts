// Minimal DNS-over-UDP latency prober for the speed test: CH/TXT "id.server" to 1.1.1.1:53.
// The Cloudflare PoP answers this itself (TXT = PoP name, e.g. "dus02"), so the RTT is the pure
// path RTT incl. all queues on the way – exactly what loaded-latency measurement needs.
// Kept local to the speed test on purpose (no dependency on the probes module).
import { randomInt } from 'node:crypto';
import dgram from 'node:dgram';

const QTYPE_TXT = 16;
const QCLASS_CH = 3;

/** DNS query: header (RD=1, QDCOUNT=1) + question "id.server" CH TXT. */
export function buildIdServerQuery(id: number): Buffer {
  const header = Buffer.from([(id >> 8) & 0xff, id & 0xff, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0]);
  const question = Buffer.from([2, 0x69, 0x64, 6, 0x73, 0x65, 0x72, 0x76, 0x65, 0x72, 0, 0, QTYPE_TXT, 0, QCLASS_CH]);
  return Buffer.concat([header, question]);
}

export interface DnsReply {
  id: number;
  rcode: number;
  /** TXT strings of the answer section (the PoP name for id.server) */
  txt: string[];
}

function skipName(buf: Uint8Array, offset: number): number {
  let off = offset;
  for (let guard = 0; guard < 128 && off < buf.length; guard++) {
    const len = buf[off];
    if (len === 0) return off + 1;
    if ((len & 0xc0) === 0xc0) return off + 2;
    off += 1 + len;
  }
  throw new Error('bad name');
}

/** Parses a DNS response. null if it is not a response (QR bit unset) or too short. */
export function parseDnsReply(buf: Uint8Array): DnsReply | null {
  if (buf.length < 12) return null;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const id = view.getUint16(0);
  const flags = view.getUint16(2);
  if ((flags & 0x8000) === 0) return null;
  const reply: DnsReply = { id, rcode: flags & 0x0f, txt: [] };
  try {
    const qd = view.getUint16(4);
    const an = view.getUint16(6);
    let off = 12;
    for (let i = 0; i < qd; i++) off = skipName(buf, off) + 4;
    for (let i = 0; i < an; i++) {
      off = skipName(buf, off);
      const type = view.getUint16(off);
      const rdlen = view.getUint16(off + 8);
      off += 10;
      if (off + rdlen > buf.length) break;
      if (type === QTYPE_TXT) {
        let p = off;
        while (p < off + rdlen) {
          const len = buf[p];
          reply.txt.push(Buffer.from(buf.subarray(p + 1, Math.min(p + 1 + len, off + rdlen))).toString('latin1'));
          p += 1 + len;
        }
      }
      off += rdlen;
    }
  } catch {
    /* truncated/odd answer section – id/rcode are still valid */
  }
  return reply;
}

/** Latency prober used by the speed test (injectable for tests). */
export interface LatencyProber {
  /** creates the socket; rejects when UDP is unavailable */
  open(): Promise<void>;
  /** sends one probe; `done` is called exactly once with the RTT (ms) or null (lost/timeout) */
  probe(done: (rtt: number | null, pop: string | null) => void): void;
  /** probes still waiting for an answer */
  readonly pending: number;
  /** closes the socket; pending probes are dropped without callback */
  close(): void;
}

interface Pending {
  sentAt: number;
  timer: NodeJS.Timeout;
  done: (rtt: number | null, pop: string | null) => void;
}

export function createIdServerProber(opts: { host?: string; port?: number; timeoutMs?: number } = {}): LatencyProber {
  const host = opts.host ?? '1.1.1.1';
  const port = opts.port ?? 53;
  const timeoutMs = opts.timeoutMs ?? 2000;
  const pending = new Map<number, Pending>();
  let sock: dgram.Socket | null = null;
  let nextId = randomInt(0, 0x10000);

  const settle = (id: number, rtt: number | null, pop: string | null) => {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    clearTimeout(p.timer);
    p.done(rtt, pop);
  };

  return {
    get pending() {
      return pending.size;
    },
    open() {
      return new Promise<void>((resolve, reject) => {
        const s = dgram.createSocket(host.includes(':') ? 'udp6' : 'udp4');
        let settled = false;
        const fail = (err: unknown) => {
          if (settled) return;
          settled = true;
          try {
            s.close();
          } catch {
            /* ignore */
          }
          reject(err instanceof Error ? err : new Error(String(err)));
        };
        s.on('message', (msg) => {
          const reply = parseDnsReply(msg);
          if (!reply) return;
          const p = pending.get(reply.id);
          if (!p) return; // late answer after timeout or stray datagram
          settle(reply.id, performance.now() - p.sentAt, reply.txt[0] ?? null);
        });
        // before open: fail; afterwards (e.g. ICMP port unreachable) probes simply time out
        s.on('error', (err) => fail(err));
        // Node calls the connect callback with the error on failure (typed as () => void)
        s.connect(port, host, (err?: unknown) => {
          if (err) {
            fail(err);
            return;
          }
          if (settled) return;
          settled = true;
          sock = s;
          resolve();
        });
      });
    },
    probe(done) {
      const s = sock;
      if (!s) {
        done(null, null);
        return;
      }
      const id = nextId;
      nextId = (nextId + 1) & 0xffff;
      const old = pending.get(id);
      if (old) settle(id, null, null); // 65536 probes in flight cannot happen, but stay safe
      const timer = setTimeout(() => settle(id, null, null), timeoutMs);
      pending.set(id, { sentAt: performance.now(), timer, done });
      s.send(buildIdServerQuery(id), (err) => {
        if (err) settle(id, null, null);
      });
    },
    close() {
      for (const p of pending.values()) clearTimeout(p.timer);
      pending.clear();
      const s = sock;
      sock = null;
      if (s) {
        try {
          s.close();
        } catch {
          /* already closed */
        }
      }
    },
  };
}
