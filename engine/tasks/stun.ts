// Public address & NAT behaviour (ARCHITECTURE §4.7, environment.md §2 + §4, critique.md §7.4):
//  - STUN binding requests (RFC 5389/8489) from ONE local UDP socket per family to
//    stun.l.google.com:19302 and stun.cloudflare.com:3478 (distinct IPs) → XOR-MAPPED-ADDRESS,
//    mapping endpoint-independent / endpoint-dependent / blocked, public IP;
//  - CGNAT (IPv4): router runs DS-Lite (latest 'router' snapshot / bus 'router', or a known $aftr)
//    or the public IPv4 differs from the router WAN IPv4. IPv6: `cgnat` = NAT66 (mapped ≠ local);
//  - `o-o.myaddr.l.google.com` TXT via 8.8.8.8 (raw DNS over UDP): ECS /24 of the CGNAT exit.
// Snapshot 'nat' = { results: NatResult[], dns, trigger }; events `ip_change` (public IPv4 changed)
// and `nat_change` (mapping / CGNAT / NAT66 changed). Runs every `stunEveryMin` while a session runs
// (first run 20 s after the start), 30 s after the egress interface changed (debounced) and runNow().
import dgram from 'node:dgram';
import dns from 'node:dns';
import type { AppConfig } from '../../src/lib/shared/config';
import { isIPv4, isIpLiteral, sameIp } from '../../src/lib/shared/net';
import {
  DNS_TYPE_TXT,
  NAT_MAPPING_LABEL,
  type RouterNatHints,
  type StunEndpoint,
  type StunProbeOutcome,
  buildBindingRequest,
  buildDnsQuery,
  classifyMapping,
  deriveCgnatV4,
  deriveNat66,
  formatEndpoint,
  ipv4InCidr,
  matchesTransaction,
  newTransactionId,
  parseDnsTxtResponse,
  parseGoogleMyAddr,
  parseStunMessage,
  publicIpFrom,
} from '../../src/lib/shared/stun';
import type { IpFamily, ModuleState, NatMapping, NatResult, NetEvent } from '../../src/lib/shared/types';
import type { EgressTick, EngineContext, EngineModule, Logger, TaskResult } from '../core/types';
import { FAMILIES, errorText } from './traceroute';

export interface StunServer {
  label: string;
  host: string;
  port: number;
}

export const STUN_SERVERS: readonly StunServer[] = [
  { label: 'stun.l.google.com:19302', host: 'stun.l.google.com', port: 19302 },
  { label: 'stun.cloudflare.com:3478', host: 'stun.cloudflare.com', port: 3478 },
];
export const MYADDR_NAME = 'o-o.myaddr.l.google.com';
export const MYADDR_RESOLVER = '8.8.8.8';
/** transmissions at 0 / 500 / 1500 ms (RFC 5389 RTO 500 ms, doubling), give up after 2.5 s */
export const STUN_SEND_AT_MS: readonly number[] = [0, 500, 1500];
export const STUN_DEADLINE_MS = 2500;
export const EGRESS_DEBOUNCE_MS = 30_000;

const FIRST_RUN_DELAY_MS = 20_000;
const DNS_TIMEOUT_MS = 3000;

export type StunTrigger = 'schedule' | 'manual' | 'egress';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const round1 = (v: number) => Math.round(v * 10) / 10;

// ─── network primitives ────────────────────────────────────────────────────

export function lookupHost(host: string, family: IpFamily, timeoutMs = DNS_TIMEOUT_MS): Promise<string | null> {
  if (isIpLiteral(host)) return Promise.resolve(host);
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      done = true;
      resolve(null);
    }, timeoutMs);
    timer.unref();
    dns.lookup(host, { family }, (err, address) => {
      if (done) return;
      clearTimeout(timer);
      resolve(err ? null : address);
    });
  });
}

/** Local source address Windows picks towards `ip` (connect() on a UDP socket sends nothing). */
export function localSourceAddress(family: IpFamily, ip: string, port: number, timeoutMs = 500): Promise<string | null> {
  return new Promise((resolve) => {
    let sock: dgram.Socket;
    try {
      sock = dgram.createSocket(family === 6 ? { type: 'udp6', ipv6Only: true } : { type: 'udp4' });
    } catch {
      resolve(null);
      return;
    }
    let done = false;
    const finish = (addr: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        sock.close();
      } catch {
        // already closed
      }
      resolve(addr && addr !== '0.0.0.0' && addr !== '::' ? addr : null);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    sock.once('error', () => finish(null));
    try {
      sock.connect(port, ip, () => {
        try {
          finish(sock.address().address);
        } catch {
          finish(null);
        }
      });
    } catch {
      finish(null);
    }
  });
}

function bindSocket(sock: dgram.Socket): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    sock.once('error', onError);
    sock.bind(0, () => {
      sock.off('error', onError);
      resolve();
    });
  });
}

function closeQuietly(sock: dgram.Socket): void {
  try {
    sock.close();
  } catch {
    // already closed
  }
}

export interface StunRound {
  family: IpFamily;
  /** local source address + port of the socket used for all requests */
  local: StunEndpoint | null;
  outcomes: StunProbeOutcome[];
}

export interface StunRoundOptions {
  servers?: readonly StunServer[];
  resolve?: (host: string, family: IpFamily) => Promise<string | null>;
  deadlineMs?: number;
  sendAtMs?: readonly number[];
  signal?: AbortSignal;
}

/** Binding requests to every server from ONE socket (the EIM test needs the same local port). */
export async function stunRound(family: IpFamily, opts: StunRoundOptions = {}): Promise<StunRound> {
  const servers = opts.servers ?? STUN_SERVERS;
  const resolve = opts.resolve ?? lookupHost;
  const deadlineMs = opts.deadlineMs ?? STUN_DEADLINE_MS;
  const sendAt = opts.sendAtMs ?? STUN_SEND_AT_MS;
  const resolved = await Promise.all(servers.map(async (s) => ({ s, ip: await resolve(s.host, family) })));
  const outcomes: StunProbeOutcome[] = resolved.map(({ s, ip }) => ({
    server: s.label,
    serverIp: ip,
    mapped: null,
    rttMs: null,
    error: ip ? null : 'dns',
  }));
  const targets = resolved.map((r, idx) => ({ ...r, idx })).filter((r): r is typeof r & { ip: string } => r.ip !== null);
  if (targets.length === 0 || opts.signal?.aborted) return { family, local: null, outcomes };

  const sock = dgram.createSocket(family === 6 ? { type: 'udp6', ipv6Only: true } : { type: 'udp4' });
  sock.on('error', () => undefined); // errors are reported per request (send callback / timeout)
  try {
    await bindSocket(sock);
  } catch (err) {
    closeQuietly(sock);
    for (const t of targets) outcomes[t.idx].error = `bind: ${errorText(err)}`;
    return { family, local: null, outcomes };
  }
  const port = sock.address().port;
  const localIp = await localSourceAddress(family, targets[0].ip, targets[0].s.port);
  const local: StunEndpoint | null = localIp ? { family, address: localIp, port } : null;

  await new Promise<void>((done) => {
    const pending = targets.map((t) => {
      const txId = newTransactionId();
      return { ...t, txId, req: buildBindingRequest(txId), lastSent: 0, finished: false };
    });
    const timers: NodeJS.Timeout[] = [];
    let closed = false;
    const finishAll = () => {
      if (closed) return;
      closed = true;
      for (const t of timers) clearTimeout(t);
      opts.signal?.removeEventListener('abort', finishAll);
      for (const p of pending) {
        if (!p.finished) outcomes[p.idx].error ??= opts.signal?.aborted ? 'aborted' : 'timeout';
      }
      done();
    };
    const checkDone = () => {
      if (pending.every((p) => p.finished)) finishAll();
    };
    sock.on('message', (msg: Buffer) => {
      const bytes = new Uint8Array(msg.buffer, msg.byteOffset, msg.byteLength);
      for (const p of pending) {
        if (p.finished || !matchesTransaction(bytes, p.txId)) continue;
        p.finished = true;
        const o = outcomes[p.idx];
        o.rttMs = round1(performance.now() - p.lastSent);
        const parsed = parseStunMessage(bytes, p.txId);
        if (parsed.ok) {
          o.mapped = parsed.xorMapped ?? parsed.mapped;
          o.error = o.mapped ? null : 'no-mapped-address';
        } else {
          o.error = parsed.errorCode ? `${parsed.error} ${parsed.errorCode}` : parsed.error;
        }
      }
      checkDone();
    });
    const transmit = () => {
      if (closed) return;
      for (const p of pending) {
        if (p.finished) continue;
        p.lastSent = performance.now();
        sock.send(p.req, p.s.port, p.ip, (err) => {
          if (!err || p.finished) return;
          p.finished = true;
          const code = isRecord(err) && typeof err.code === 'string' ? err.code : null;
          outcomes[p.idx].error = code ?? errorText(err);
          checkDone();
        });
      }
    };
    for (const at of sendAt) timers.push(setTimeout(transmit, at));
    timers.push(setTimeout(finishAll, deadlineMs));
    opts.signal?.addEventListener('abort', finishAll, { once: true });
  });
  closeQuietly(sock);
  return { family, local, outcomes };
}

export interface MyAddrAnswer {
  txt: string[] | null;
  rttMs: number | null;
  error: string | null;
}

/** `o-o.myaddr.l.google.com` TXT straight from a resolver (raw DNS over UDP, 2 tries). */
export async function queryMyAddr(
  opts: { resolver?: string; port?: number; name?: string; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<MyAddrAnswer> {
  const resolver = opts.resolver ?? MYADDR_RESOLVER;
  const port = opts.port ?? 53;
  const name = opts.name ?? MYADDR_NAME;
  const timeoutMs = opts.timeoutMs ?? 3000;
  const id = Math.floor(Math.random() * 0x10000);
  const query = buildDnsQuery(id, name, DNS_TYPE_TXT);
  const question = query.subarray(12);
  const sock = dgram.createSocket(isIPv4(resolver) ? { type: 'udp4' } : { type: 'udp6', ipv6Only: true });
  sock.on('error', () => undefined);
  const answer = await new Promise<MyAddrAnswer>((resolve) => {
    let sentAt = 0;
    let settled = false;
    const timers: NodeJS.Timeout[] = [];
    const finish = (a: MyAddrAnswer) => {
      if (settled) return;
      settled = true;
      for (const t of timers) clearTimeout(t);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve(a);
    };
    const onAbort = () => finish({ txt: null, rttMs: null, error: 'aborted' });
    sock.on('message', (msg: Buffer) => {
      const res = parseDnsTxtResponse(new Uint8Array(msg.buffer, msg.byteOffset, msg.byteLength), id, question);
      if (!res.ok) return; // foreign / malformed datagram – keep waiting
      finish(
        res.rcode === 0
          ? { txt: res.txt, rttMs: round1(performance.now() - sentAt), error: null }
          : { txt: null, rttMs: round1(performance.now() - sentAt), error: `rcode ${res.rcode}` },
      );
    });
    const send = () => {
      if (settled) return;
      sentAt = performance.now();
      sock.send(query, port, resolver, (err) => {
        if (err) finish({ txt: null, rttMs: null, error: isRecord(err) && typeof err.code === 'string' ? err.code : errorText(err) });
      });
    };
    timers.push(setTimeout(send, 0), setTimeout(send, Math.round(timeoutMs / 2)));
    timers.push(setTimeout(() => finish({ txt: null, rttMs: null, error: 'timeout' }), timeoutMs));
    opts.signal?.addEventListener('abort', onAbort, { once: true });
  });
  closeQuietly(sock);
  return answer;
}

// ─── results & events (pure) ───────────────────────────────────────────────

export interface DnsExitInfo {
  server: string;
  name: string;
  /** ECS subnet Google saw for our resolver query, e.g. '92.208.29.0/24' (CGNAT exit /24) */
  clientSubnet: string | null;
  /** address that queried Google's authoritative server (resolver egress) */
  resolverIp: string | null;
  rttMs: number | null;
  error: string | null;
  /** STUN public IPv4 lies inside clientSubnet (null = not comparable) */
  consistent: boolean | null;
}

export function buildDnsExit(answer: MyAddrAnswer, publicIpV4: string | null): DnsExitInfo {
  const parsed = answer.txt ? parseGoogleMyAddr(answer.txt) : { clientSubnet: null, sourceIp: null };
  const consistent =
    parsed.clientSubnet && publicIpV4 && isIPv4(publicIpV4) && /^[\d.]+\/\d+$/.test(parsed.clientSubnet)
      ? ipv4InCidr(publicIpV4, parsed.clientSubnet)
      : null;
  return {
    server: MYADDR_RESOLVER,
    name: MYADDR_NAME,
    clientSubnet: parsed.clientSubnet,
    resolverIp: parsed.sourceIp,
    rttMs: answer.rttMs,
    error: answer.error,
    consistent,
  };
}

export function buildNatResult(round: StunRound, ts: number, router: RouterNatHints | null): NatResult {
  const mapping = classifyMapping(round.outcomes);
  const publicIp = publicIpFrom(round.outcomes);
  const firstMapped = round.outcomes.find((o) => o.mapped !== null)?.mapped ?? null;
  const cgnat = round.family === 4 ? deriveCgnatV4(publicIp, router) : deriveNat66(round.local?.address ?? null, firstMapped);
  return {
    ts,
    family: round.family,
    localAddress: round.local ? formatEndpoint(round.local) : null,
    publicIp,
    mappings: round.outcomes.map((o) => ({
      server: o.server,
      mapped: o.mapped ? formatEndpoint(o.mapped) : null,
      rttMs: o.rttMs,
      error: o.error,
    })),
    mapping,
    cgnat,
  };
}

/** DS-Lite / WAN IPv4 from a 'router' snapshot or bus payload (RouterStatus, tolerant). */
export function routerHintsFrom(data: unknown): RouterNatHints | null {
  if (!isRecord(data)) return null;
  const dsLite = typeof data.dsLite === 'boolean' ? data.dsLite : null;
  const wanIpv4 = typeof data.wanIpv4 === 'string' && data.wanIpv4.trim() !== '' ? data.wanIpv4.trim() : null;
  if (dsLite === null && wanIpv4 === null) return null;
  return { dsLite, wanIpv4 };
}

/** Last known values per family used for change detection (null = never determined). */
export interface NatMemory {
  publicIp: string | null;
  mapping: NatMapping | null;
  cgnat: boolean | null;
}

export const emptyNatMemory = (): NatMemory => ({ publicIp: null, mapping: null, cgnat: null });

const DEFINITIVE: readonly NatMapping[] = ['endpoint-independent', 'endpoint-dependent'];

export function updateNatMemory(mem: NatMemory, r: NatResult): NatMemory {
  return {
    publicIp: r.publicIp ?? mem.publicIp,
    mapping: DEFINITIVE.includes(r.mapping) ? r.mapping : mem.mapping,
    cgnat: r.cgnat ?? mem.cgnat,
  };
}

/**
 * Events for a new result compared with the last known values: `ip_change` when the public IPv4
 * changed (new AFTR binding – running UDP game sessions break), `nat_change` when the mapping
 * behaviour flipped between endpoint-independent and endpoint-dependent, or CGNAT/NAT66 appeared or
 * disappeared. Failed rounds (no mapping) never produce events.
 */
export function natEvents(mem: NatMemory, cur: NatResult, trigger: StunTrigger): NetEvent[] {
  const out: NetEvent[] = [];
  const fam = `IPv${cur.family}`;
  if (cur.family === 4 && mem.publicIp && cur.publicIp && !sameIp(mem.publicIp, cur.publicIp)) {
    out.push({
      ts: cur.ts,
      type: 'ip_change',
      severity: 'warn',
      segment: cur.cgnat === false ? 'isp' : 'aftr',
      title: `Öffentliche IPv4-Adresse geändert: ${mem.publicIp} → ${cur.publicIp}`,
      details: { family: 4, before: mem.publicIp, after: cur.publicIp, cgnat: cur.cgnat, mapping: cur.mapping, localAddress: cur.localAddress, trigger },
      source: 'stun',
      dedupeKey: `ip_change:stun4:${cur.ts}`,
    });
  }
  if (mem.mapping && DEFINITIVE.includes(cur.mapping) && mem.mapping !== cur.mapping) {
    out.push({
      ts: cur.ts,
      type: 'nat_change',
      severity: cur.mapping === 'endpoint-dependent' ? 'warn' : 'info',
      segment: cur.family === 4 ? 'aftr' : 'isp',
      title: `NAT-Verhalten ${fam} geändert: ${NAT_MAPPING_LABEL[mem.mapping]} → ${NAT_MAPPING_LABEL[cur.mapping]}`,
      details: { family: cur.family, before: mem.mapping, after: cur.mapping, publicIp: cur.publicIp, trigger },
      source: 'stun',
      dedupeKey: `nat_change:${cur.family}:mapping:${cur.ts}`,
    });
  }
  if (mem.cgnat !== null && cur.cgnat !== null && mem.cgnat !== cur.cgnat) {
    const title =
      cur.family === 4
        ? cur.cgnat
          ? 'IPv4 jetzt hinter Carrier-NAT (CGNAT/DS-Lite)'
          : 'IPv4 nicht mehr hinter Carrier-NAT (öffentliche IPv4-Adresse)'
        : cur.cgnat
          ? 'IPv6 wird jetzt übersetzt (NAT66)'
          : 'IPv6 wieder ohne Adressübersetzung';
    out.push({
      ts: cur.ts,
      type: 'nat_change',
      severity: 'info',
      segment: cur.family === 4 ? 'aftr' : 'isp',
      title,
      details: { family: cur.family, cgnatBefore: mem.cgnat, cgnatAfter: cur.cgnat, publicIp: cur.publicIp, trigger },
      source: 'stun',
      dedupeKey: `nat_change:${cur.family}:cgnat:${cur.ts}`,
    });
  }
  return out;
}

/** NatResult[] from a stored 'nat' snapshot ({ results } or array) – tolerant. */
export function natResultsFromSnapshot(data: unknown): NatResult[] {
  const list = Array.isArray(data) ? data : isRecord(data) && Array.isArray(data.results) ? data.results : [];
  return list.filter((r): r is NatResult => isRecord(r) && (r.family === 4 || r.family === 6) && typeof r.mapping === 'string');
}

export interface NatSnapshot {
  results: NatResult[];
  dns: DnsExitInfo | null;
  trigger: StunTrigger;
}

// ─── module ────────────────────────────────────────────────────────────────

export interface StunModuleOptions {
  round?: (family: IpFamily, signal: AbortSignal) => Promise<StunRound>;
  myAddr?: (signal: AbortSignal) => Promise<MyAddrAnswer>;
  checkIntervalMs?: number;
  firstRunDelayMs?: number;
  egressDebounceMs?: number;
}

export function createStunModule(opts: StunModuleOptions = {}): EngineModule {
  const doRound = opts.round ?? ((family: IpFamily, signal: AbortSignal) => stunRound(family, { signal }));
  const doMyAddr = opts.myAddr ?? ((signal: AbortSignal) => queryMyAddr({ signal }));
  const checkMs = opts.checkIntervalMs ?? 30_000;
  const firstRunDelayMs = opts.firstRunDelayMs ?? FIRST_RUN_DELAY_MS;
  const debounceMs = opts.egressDebounceMs ?? EGRESS_DEBOUNCE_MS;

  let ctx: EngineContext | null = null;
  let log: Logger | null = null;
  const unsubscribe: (() => void)[] = [];
  let scheduled = false;
  let checkTimer: NodeJS.Timeout | null = null;
  let kickTimer: NodeJS.Timeout | null = null;
  let egressTimer: NodeJS.Timeout | null = null;
  let egressKey: string | null = null;
  let rerunAfterCurrent = false;
  let nextRunTs: number | null = null;
  let lastRunTs: number | null = null;
  let lastError: string | null = null;
  let router: RouterNatHints | null = null;
  const memory: Record<IpFamily, NatMemory> = { 4: emptyNatMemory(), 6: emptyNatMemory() };
  let current: { abort: AbortController; done: Promise<NatSnapshot> } | null = null;

  const intervalMs = (cfg: AppConfig) => Math.max(1, cfg.schedules.stunEveryMin) * 60_000;

  function routerHints(c: EngineContext): RouterNatHints | null {
    const aftrKnown = c.hosts.get().aftr !== null;
    if (!router) return aftrKnown ? { dsLite: true, wanIpv4: null } : null;
    return router.dsLite === null && aftrKnown ? { ...router, dsLite: true } : router;
  }

  async function runOnce(c: EngineContext, trigger: StunTrigger, signal: AbortSignal): Promise<NatSnapshot> {
    const ts = Date.now();
    const [rounds, myAddr] = await Promise.all([
      Promise.all(
        FAMILIES.map((f) =>
          doRound(f, signal).catch((err: unknown): StunRound => {
            log?.warn(`STUN IPv${f} failed`, { error: errorText(err) });
            return { family: f, local: null, outcomes: [] };
          }),
        ),
      ),
      doMyAddr(signal).catch((err: unknown): MyAddrAnswer => ({ txt: null, rttMs: null, error: errorText(err) })),
    ]);
    const hints = routerHints(c);
    const results = rounds.map((r) => buildNatResult(r, ts, hints));
    const v4 = results.find((r) => r.family === 4) ?? null;
    const snapshot: NatSnapshot = { results, dns: buildDnsExit(myAddr, v4?.publicIp ?? null), trigger };
    if (signal.aborted) return snapshot;

    c.recordSnapshot('nat', snapshot, ts);
    for (const r of results) {
      for (const ev of natEvents(memory[r.family], r, trigger)) c.recordEvent(ev);
      memory[r.family] = updateNatMemory(memory[r.family], r);
    }
    lastRunTs = ts;
    const failed = results.filter((r) => r.publicIp === null).map((r) => `IPv${r.family}`);
    lastError = failed.length === results.length ? `STUN ohne Antwort (${failed.join(', ')})` : null;
    for (const r of results) {
      log?.info(
        `STUN IPv${r.family}: public ${r.publicIp ?? '–'}, ${r.mapping}, cgnat=${String(r.cgnat)}, local ${r.localAddress ?? '–'} | ${r.mappings
          .map((m) => `${m.server} → ${m.mapped ?? m.error ?? '–'}${m.rttMs !== null ? ` (${m.rttMs} ms)` : ''}`)
          .join(', ')}`,
      );
    }
    log?.info(`myaddr via ${MYADDR_RESOLVER}: subnet ${snapshot.dns?.clientSubnet ?? '–'}, resolver ${snapshot.dns?.resolverIp ?? '–'}${snapshot.dns?.error ? ` (${snapshot.dns.error})` : ''}`);
    return snapshot;
  }

  function launch(trigger: StunTrigger): Promise<NatSnapshot> {
    const c = ctx;
    if (!c) return Promise.reject(new Error('STUN-Modul ist nicht initialisiert'));
    const abort = new AbortController();
    const done = runOnce(c, trigger, abort.signal).finally(() => {
      if (current?.abort === abort) current = null;
      if (rerunAfterCurrent && scheduled && !abort.signal.aborted) {
        rerunAfterCurrent = false;
        void launch('egress').catch(() => undefined);
      }
    });
    current = { abort, done };
    return done;
  }

  function check(): void {
    const c = ctx;
    if (!c || !scheduled || current) return;
    const now = Date.now();
    if (nextRunTs === null || now < nextRunTs) return;
    nextRunTs = now + intervalMs(c.config());
    void launch('schedule').catch(() => undefined);
  }

  function onEgress(t: EgressTick): void {
    if (!scheduled) return;
    const key = `${t.v4If ?? '-'}|${t.v6If ?? '-'}|${t.v4Address ?? '-'}`;
    if (egressKey === null) {
      egressKey = key;
      return;
    }
    if (key === egressKey) return;
    egressKey = key;
    if (egressTimer) clearTimeout(egressTimer);
    egressTimer = null;
    if (!t.v4If && !t.v6If) return; // no egress at all – wait for the next change
    egressTimer = setTimeout(() => {
      egressTimer = null;
      if (!scheduled) return;
      log?.info(`egress interface changed (${key}) – STUN check`);
      if (current) rerunAfterCurrent = true;
      else void launch('egress').catch(() => undefined);
    }, debounceMs);
    egressTimer.unref();
  }

  function clearTimers(): void {
    if (checkTimer) clearInterval(checkTimer);
    if (kickTimer) clearTimeout(kickTimer);
    if (egressTimer) clearTimeout(egressTimer);
    checkTimer = kickTimer = egressTimer = null;
  }

  async function abortCurrent(): Promise<void> {
    const cur = current;
    if (!cur) return;
    cur.abort.abort();
    await Promise.race([cur.done.catch(() => undefined), new Promise((r) => setTimeout(r, 3000).unref())]);
  }

  return {
    name: 'stun',

    init(c: EngineContext) {
      ctx = c;
      log = c.log;
      try {
        router = routerHintsFrom(c.db.latestSnapshot<unknown>('router')?.data);
        const snap = c.db.latestSnapshot<unknown>('nat');
        if (snap) {
          lastRunTs = snap.ts;
          for (const r of natResultsFromSnapshot(snap.data)) memory[r.family] = updateNatMemory(memory[r.family], r);
        }
      } catch (err) {
        log.warn('could not read previous router / NAT snapshots', { error: errorText(err) });
      }
      unsubscribe.push(
        c.bus.on('router', (status) => {
          router = routerHintsFrom(status) ?? router;
        }),
        c.bus.on('egress', onEgress),
      );
    },

    start() {
      if (!ctx) return;
      scheduled = true;
      egressKey = null;
      nextRunTs = Date.now() + firstRunDelayMs;
      if (!checkTimer) {
        checkTimer = setInterval(check, checkMs);
        checkTimer.unref();
      }
      if (kickTimer) clearTimeout(kickTimer);
      kickTimer = setTimeout(() => {
        kickTimer = null;
        check();
      }, firstRunDelayMs + 50);
      kickTimer.unref();
    },

    async stop() {
      scheduled = false;
      rerunAfterCurrent = false;
      clearTimers();
      nextRunTs = null;
      await abortCurrent();
    },

    async dispose() {
      scheduled = false;
      rerunAfterCurrent = false;
      clearTimers();
      nextRunTs = null;
      await abortCurrent();
      for (const off of unsubscribe.splice(0)) off();
    },

    reconfigure(cfg: AppConfig) {
      if (!scheduled || nextRunTs === null || lastRunTs === null) return;
      nextRunTs = Math.max(Date.now() + 5_000, lastRunTs + intervalMs(cfg));
    },

    async runNow(): Promise<TaskResult<NatSnapshot>> {
      if (!ctx) throw new Error('STUN-Modul ist nicht initialisiert');
      // a running check answers the manual request as well
      const snapshot = await (current ? current.done : launch('manual'));
      const ok = snapshot.results.some((r) => r.publicIp !== null);
      return ok ? { ok: true, result: snapshot } : { ok: false, result: snapshot, error: 'Keine STUN-Antwort erhalten' };
    },

    state(): ModuleState {
      return {
        name: 'stun',
        enabled: true,
        running: scheduled,
        busy: current !== null,
        lastRunTs,
        nextRunTs: scheduled ? nextRunTs : null,
        lastError,
      };
    },
  };
}
