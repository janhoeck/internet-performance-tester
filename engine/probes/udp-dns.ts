// DNS-over-UDP probe with ONE persistent, connected socket per target (stable NAT/AFTR mapping,
// like game traffic). `query === 'id.server'` → class CH, type TXT: answered by the Cloudflare PoP
// itself (pure path RTT, the TXT answer is the PoP name, e.g. 'dus01'); otherwise IN A.
// Replies are matched by the 16-bit transaction id + QR bit. The first answer after a (re)start is
// flagged `first` so callers can drop it (it includes the mapping creation).
import { randomInt } from 'node:crypto';
import dgram from 'node:dgram';
import { performance } from 'node:perf_hooks';
import {
  DNS_CLASS,
  DNS_TYPE,
  decodeDnsHeader,
  decodeDnsMessage,
  encodeDnsQuery,
  extractTxtStrings,
  rcodeName,
} from '../../src/lib/shared/dns';
import { SampleStatus, type SampleStatusCode } from '../../src/lib/shared/types';
import { type ProbeOutcome, errorCode, roundMs } from './common';

export interface DnsQuestionSpec {
  name: string;
  type: number;
  cls: number;
}

/** Question for a udp-dns target: 'id.server' → CH TXT, anything else → IN A (default cloudflare.com). */
export function questionForQuery(query: string | undefined): DnsQuestionSpec {
  const name = (query ?? '').trim().replace(/\.$/, '') || 'cloudflare.com';
  if (name.toLowerCase() === 'id.server') return { name: 'id.server', type: DNS_TYPE.TXT, cls: DNS_CLASS.CH };
  return { name, type: DNS_TYPE.A, cls: DNS_CLASS.IN };
}

export interface DnsProbeResult extends ProbeOutcome {
  /** response code of the answer (null when lost) */
  rcode: number | null;
  /** TXT strings of the answer (id.server → PoP name) */
  txt: string[];
  /** first answer on a fresh socket – callers drop it */
  first: boolean;
}

/** Status for a socket/send error. */
export function udpErrorStatus(code: string | null): SampleStatusCode {
  return code === 'EHOSTUNREACH' || code === 'ENETUNREACH' ? SampleStatus.UNREACHABLE : SampleStatus.ERROR;
}

interface Pending {
  t0: number;
  first: boolean;
  timer: NodeJS.Timeout;
  resolve: (r: DnsProbeResult) => void;
}

export class UdpDnsClient {
  private sock: dgram.Socket | null = null;
  private connecting: Promise<dgram.Socket> | null = null;
  private readonly pending = new Map<number, Pending>();
  private fresh = true;
  private closed = false;

  constructor(
    readonly server: string,
    readonly port: number,
    readonly family: 4 | 6,
    readonly question: DnsQuestionSpec,
  ) {}

  /** Send one query; resolves with the matched answer, a timeout or an error. Never rejects. */
  async query(timeoutMs: number): Promise<DnsProbeResult> {
    let sock: dgram.Socket;
    try {
      sock = await this.ensureSocket();
    } catch (err) {
      const code = errorCode(err);
      return { status: udpErrorStatus(code), rtt: null, rcode: null, txt: [], first: false, error: `UDP-Fehler (${code ?? 'unbekannt'})` };
    }
    const first = this.fresh;
    this.fresh = false;
    let id = randomInt(0, 0x10000);
    for (let i = 0; this.pending.has(id) && i < 16; i++) id = randomInt(0, 0x10000);
    const query = encodeDnsQuery({ id, ...this.question });
    return new Promise<DnsProbeResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ status: SampleStatus.TIMEOUT, rtt: null, rcode: null, txt: [], first });
      }, timeoutMs);
      this.pending.set(id, { t0: performance.now(), first, timer, resolve });
      sock.send(query, (err) => {
        if (!err) return;
        const p = this.pending.get(id);
        if (!p) return;
        clearTimeout(p.timer);
        this.pending.delete(id);
        const code = errorCode(err);
        resolve({ status: udpErrorStatus(code), rtt: null, rcode: null, txt: [], first, error: `UDP-Fehler (${code ?? 'unbekannt'})` });
        this.reset();
      });
    });
  }

  close(): void {
    this.closed = true;
    this.reset();
  }

  private ensureSocket(): Promise<dgram.Socket> {
    if (this.closed) return Promise.reject(new Error('closed'));
    if (this.sock) return Promise.resolve(this.sock);
    if (this.connecting) return this.connecting;
    const sock = dgram.createSocket(this.family === 6 ? 'udp6' : 'udp4');
    this.connecting = new Promise<dgram.Socket>((resolve, reject) => {
      const onError = (err: Error) => {
        this.connecting = null;
        try {
          sock.close();
        } catch {
          // already closed
        }
        reject(err);
      };
      sock.once('error', onError);
      sock.on('message', (msg: Buffer) => this.onMessage(msg));
      sock.connect(this.port, this.server, (...args: unknown[]) => {
        const err = args[0];
        if (err instanceof Error) {
          onError(err);
          return;
        }
        sock.off('error', onError);
        sock.on('error', () => this.reset());
        this.sock = sock;
        this.connecting = null;
        this.fresh = true;
        resolve(sock);
      });
    });
    return this.connecting;
  }

  private onMessage(msg: Buffer): void {
    const h = decodeDnsHeader(msg);
    if (!h || !h.qr) return;
    const p = this.pending.get(h.id);
    if (!p) return; // late answer after timeout, or not ours
    clearTimeout(p.timer);
    this.pending.delete(h.id);
    const rtt = roundMs(performance.now() - p.t0);
    const parsed = decodeDnsMessage(msg);
    p.resolve({
      status: SampleStatus.OK,
      rtt,
      rcode: h.rcode,
      txt: parsed ? extractTxtStrings(parsed) : [],
      first: p.first,
      error: h.rcode === 0 ? null : `DNS-Antwort ${rcodeName(h.rcode)}`,
    });
  }

  /** Drop the socket (next query opens a new one and its first answer is dropped again). */
  private reset(): void {
    const sock = this.sock;
    this.sock = null;
    this.fresh = true;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      this.pending.delete(id);
      p.resolve({ status: SampleStatus.ERROR, rtt: null, rcode: null, txt: [], first: p.first, error: 'UDP-Socket geschlossen' });
    }
    if (sock) {
      try {
        sock.close();
      } catch {
        // already closed
      }
    }
  }
}
