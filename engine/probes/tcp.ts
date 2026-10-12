// TCP handshake probe: time from connect() to the 'connect' event (SYN → SYN/ACK → ACK), then the
// socket is destroyed. ECONNREFUSED counts as OK – the host answered (with RST) within the RTT –
// but only when the refusal arrives quickly: Windows retries the SYN after an RST (≈ 1 s apart)
// and reports ECONNREFUSED only after ≈ 2 s (measured: router port 9 → 2057 ms, real RTT 2 ms).
// Such a late refusal is no latency and no loss → the sample is discarded with a hint.
import net from 'node:net';
import { performance } from 'node:perf_hooks';
import { SampleStatus, type SampleStatusCode } from '../../src/lib/shared/types';
import { type ProbeOutcome, errorCode, roundMs } from './common';

/** A refusal later than this went through Windows' SYN retries – its time is not the RTT. */
export const REFUSED_MAX_RTT_MS = 900;

export const REFUSED_SLOW_TEXT =
  'Port geschlossen (Verbindung abgelehnt) – Laufzeit nicht messbar, bitte einen offenen Port wählen';

/** Map a socket error code to a sample status. */
export function tcpErrorStatus(code: string | null): SampleStatusCode {
  switch (code) {
    case 'ECONNREFUSED':
      return SampleStatus.OK;
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return SampleStatus.UNREACHABLE;
    case 'ETIMEDOUT':
      return SampleStatus.TIMEOUT;
    default:
      return SampleStatus.ERROR;
  }
}

/** Outcome of a socket error after `elapsedMs` (pure). */
export function tcpErrorOutcome(code: string | null, elapsedMs: number): ProbeOutcome {
  const status = tcpErrorStatus(code);
  if (status === SampleStatus.OK) {
    if (elapsedMs < REFUSED_MAX_RTT_MS) return { status, rtt: roundMs(elapsedMs) };
    return { status: SampleStatus.ERROR, rtt: null, discard: true, error: REFUSED_SLOW_TEXT };
  }
  return { status, rtt: null, error: status === SampleStatus.ERROR ? `Verbindungsfehler (${code ?? 'unbekannt'})` : null };
}

/** The part of net.Socket the probe uses (injectable for tests). */
export type ProbeSocket = Pick<net.Socket, 'once' | 'connect' | 'destroy'>;

/** One TCP connect to an IP literal (IPv6 may carry a zone id). Never rejects. */
export function tcpConnectProbe(
  ip: string,
  port: number,
  timeoutMs: number,
  createSocket: () => ProbeSocket = () => new net.Socket(),
): Promise<ProbeOutcome> {
  return new Promise((resolve) => {
    const sock = createSocket();
    let done = false;
    let t0 = 0;
    const finish = (outcome: ProbeOutcome) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      resolve(outcome);
    };
    const timer = setTimeout(() => finish({ status: SampleStatus.TIMEOUT, rtt: null }), timeoutMs);
    sock.once('connect', () => finish({ status: SampleStatus.OK, rtt: roundMs(performance.now() - t0) }));
    sock.once('error', (err) => finish(tcpErrorOutcome(errorCode(err), performance.now() - t0)));
    t0 = performance.now();
    try {
      sock.connect({ host: ip, port, noDelay: true });
    } catch (err) {
      finish({ status: SampleStatus.ERROR, rtt: null, error: `Verbindungsfehler (${errorCode(err) ?? 'unbekannt'})` });
    }
  });
}
