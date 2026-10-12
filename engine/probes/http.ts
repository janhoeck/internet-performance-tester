// HTTP probe: fetch + AbortSignal.timeout, RTT until the response headers arrived (TTFB).
// Any HTTP response counts as OK (the server answered); the body is discarded.
import { performance } from 'node:perf_hooks';
import { isIPv6 } from '../../src/lib/shared/net';
import { SampleStatus, type SampleStatusCode } from '../../src/lib/shared/types';
import { type ProbeOutcome, errorCode, roundMs } from './common';

/** URL for an http target: port 443 → https, otherwise http (default port 80); IPv6 literals bracketed. */
export function buildProbeUrl(host: string, port?: number, path?: string): string {
  const scheme = port === 443 ? 'https' : 'http';
  // zone ids must be percent-encoded inside URLs (fe80::1%254)
  const h = isIPv6(host) ? `[${host.replace('%', '%25')}]` : host;
  const defaultPort = scheme === 'https' ? 443 : 80;
  const p = port === undefined || port === defaultPort ? '' : `:${port}`;
  const rawPath = path && path.trim() !== '' ? path.trim() : '/';
  return `${scheme}://${h}${p}${rawPath.startsWith('/') ? rawPath : `/${rawPath}`}`;
}

/** Map a fetch error to a sample status. */
export function httpErrorStatus(err: unknown): SampleStatusCode {
  const code = errorCode(err);
  switch (code) {
    case 'TimeoutError':
    case 'AbortError':
    case 'ETIMEDOUT':
    case 'UND_ERR_CONNECT_TIMEOUT':
    case 'UND_ERR_HEADERS_TIMEOUT':
      return SampleStatus.TIMEOUT;
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return SampleStatus.UNREACHABLE;
    default:
      return SampleStatus.ERROR;
  }
}

/** One GET request. Never rejects. */
export async function httpProbe(url: string, timeoutMs: number): Promise<ProbeOutcome> {
  const t0 = performance.now();
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      cache: 'no-store',
      headers: { 'user-agent': 'Netzdiagnose/1.0 (Latenzmessung)' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const rtt = roundMs(performance.now() - t0);
    res.body?.cancel().catch(() => undefined);
    return { status: SampleStatus.OK, rtt, error: res.status >= 500 ? `HTTP ${res.status}` : null };
  } catch (err) {
    const status = httpErrorStatus(err);
    const code = errorCode(err);
    return { status, rtt: null, error: status === SampleStatus.TIMEOUT ? null : `HTTP-Fehler (${code ?? 'unbekannt'})` };
  }
}
