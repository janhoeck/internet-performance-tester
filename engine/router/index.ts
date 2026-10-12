// Router module (ARCHITECTURE §4.3/§4.10): polls the home router, rates the DOCSIS line and the
// router event log, and emits status/metrics/snapshots/events. Talks ONLY to a private IP literal
// (easy.box/kabel.box resolve to public hosts). Enforces the safety policy from §4.10: never
// auto-retry a failed login, wait out lockouts, stop on a wrong password until it changes, back off
// on transport errors. Auto-detects the ARRIS Vodafone Station; otherwise a generic reachability probe.
import {
  detectArris,
  parseStartPage,
  startPageInfo,
  type CategorizedLogEntry,
  type StartPageInfo,
} from './arris-parse';
import { ArrisAdapter, type LoginContext } from './arris';
import { GenericAdapter } from './generic';
import { HttpError, HttpSession, isAllowedRouterAddress } from './http';
import {
  DocsisChangeDebouncer,
  docsisMetricPoints,
  docsisSignature,
  FamilyBaseline,
  loginBackoffMs,
  LOCKOUT_GRACE_MS,
  markThisPc,
  pcIdentity,
  type DocsisFamilyName,
} from './status';
import { rateDocsis, type RatedDocsisSnapshot } from '../../src/lib/shared/docsis';
import type { AppConfig } from '../../src/lib/shared/config';
import type {
  AdapterSnapshot,
  MetricPoint,
  ModuleState,
  RouterAdapterId,
  RouterAttachedDevice,
  RouterStatus,
  Severity,
} from '../../src/lib/shared/types';
import type { EngineContext, EngineModule } from '../core/types';

/** status-only poll interval while no session runs (ARCHITECTURE §4.3/§4.10) */
export const IDLE_STATUS_SEC = 300;
/** a persisted 'router' snapshot at least this often even without a change */
export const SNAPSHOT_MAX_INTERVAL_MS = 10 * 60_000;
/** consecutive failed status polls before a router_offline event */
export const OFFLINE_AFTER_FAILS = 2;

type DetectedAdapter = RouterAdapterId;

interface LoginGate {
  /** set when the router rejected the password – stop until the password changes */
  disabledReason: string | null;
  /** epoch ms until which login is locked out (router said so) */
  lockoutUntil: number | null;
  /** consecutive transport failures (drives the backoff schedule) */
  backoffFailures: number;
  /** epoch ms before which no login is attempted (transport backoff) */
  backoffUntil: number | null;
}

interface ResolvedAdapters {
  arris: ArrisAdapter;
  generic: GenericAdapter;
  host: string;
  port: number;
}

export interface RouterModuleDeps {
  /** inject a session factory for tests (host policy still applies) */
  makeSession?: (host: string, port: number) => HttpSession;
  now?: () => number;
  /** delay of the first status poll after init (default 2 s) */
  firstStatusDelayMs?: number;
  /** delay of the first authenticated cycle after a session starts (default 3 s) */
  firstAuthDelayMs?: number;
}

export function createRouterModule(deps: RouterModuleDeps = {}): EngineModule {
  return new RouterModule(deps);
}

class RouterModule implements EngineModule {
  readonly name = 'router';
  private ctx: EngineContext | null = null;
  private readonly now: () => number;

  private statusTimer: NodeJS.Timeout | null = null;
  private authTimer: NodeJS.Timeout | null = null;
  private sessionActive = false;
  private statusBusy = false;
  private authBusy = false;

  private adapters: ResolvedAdapters | null = null;
  private addressBlocked = false;
  private detected: DetectedAdapter | null = null;

  private readonly gate: LoginGate = { disabledReason: null, lockoutUntil: null, backoffFailures: 0, backoffUntil: null };
  private keptSession: LoginContext | null = null;
  private lastLoginCategory: 'success' | 'failure' | 'lockout' | null = null;

  // last known assembled fields
  private lastStartInfo: StartPageInfo | null = null;
  private lastHttpMs: number | null = null;
  private lastDocsis: RatedDocsisSnapshot | null = null;
  private lastAttached: RouterAttachedDevice[] | null = null;
  private lastUptimeSec: number | null = null;
  private lastFirmwareAuth: string | null = null;

  private offlineFailures = 0;
  private offlineEventId: number | null = null;
  private lastWanIpv6: string | null = null;
  private lastAftr: string | null = null;
  private lastSnapshotTs = 0;
  private lastSnapshotSig: string | null = null;
  private lastLogDue = 0;

  private readonly docsisChange = new DocsisChangeDebouncer();
  private readonly baseline = new FamilyBaseline();

  private lastRunTs: number | null = null;
  private nextRunTs: number | null = null;
  private lastError: string | null = null;

  constructor(private readonly deps: RouterModuleDeps) {
    this.now = deps.now ?? Date.now;
  }

  // ─── lifecycle ────────────────────────────────────────────────────────────

  init(ctx: EngineContext): void {
    this.ctx = ctx;
    this.buildAdapters(ctx.config());
    this.scheduleStatus(this.deps.firstStatusDelayMs ?? 2000);
  }

  start(): void {
    this.sessionActive = true;
    // tighter status cadence + authenticated polling during a session
    this.scheduleStatus(500);
    this.scheduleAuth(this.deps.firstAuthDelayMs ?? 3000);
  }

  stop(): void {
    this.sessionActive = false;
    this.clearAuthTimer();
    void this.dropSession();
    // keep the idle status poll running
    this.scheduleStatus(this.statusIntervalMs());
  }

  async dispose(): Promise<void> {
    this.sessionActive = false;
    this.clearStatusTimer();
    this.clearAuthTimer();
    await this.dropSession();
  }

  reconfigure(cfg: AppConfig): void {
    const prev = this.adapters;
    this.buildAdapters(cfg);
    // router address / adapter changed → reset detection, caches and session
    if (!prev || prev.host !== cfg.router.ip) {
      this.detected = null;
      this.lastStartInfo = null;
      this.lastDocsis = null;
      this.lastAttached = null;
      this.docsisChange.reset();
      this.baseline.reset();
      void this.dropSession();
    }
    // user changed the config/password → re-enable login (never happens automatically)
    this.gate.disabledReason = null;
    this.gate.backoffFailures = 0;
    this.gate.backoffUntil = null;
    if (this.sessionActive) this.scheduleAuth(500);
  }

  async runNow(params?: Record<string, unknown>): Promise<unknown> {
    const action = typeof params?.action === 'string' ? params.action : 'poll';
    if (action === 'login') {
      // user-initiated: clear the "stopped" state and the backoff, then attempt a full cycle
      this.gate.disabledReason = null;
      this.gate.backoffFailures = 0;
      this.gate.backoffUntil = null;
      await this.pollStatus();
      await this.authCycle();
      return { loggedIn: this.keptSession !== null, loginError: this.lastError, lockoutUntil: this.gate.lockoutUntil };
    }
    await this.pollStatus();
    if (this.canLogin(this.now())) await this.authCycle();
    const status = this.lastStartInfo;
    return {
      reachable: this.offlineFailures === 0 && this.lastStartInfo !== null,
      connectionStatus: status?.connectionStatus ?? null,
      httpMs: this.lastHttpMs,
      docsisGrade: this.lastDocsis?.grade ?? null,
    };
  }

  state(): ModuleState {
    return {
      name: this.name,
      enabled: !this.addressBlocked,
      running: this.statusTimer !== null || this.sessionActive,
      busy: this.statusBusy || this.authBusy,
      lastRunTs: this.lastRunTs,
      nextRunTs: this.nextRunTs,
      lastError: this.addressBlocked ? 'Router-Adresse ist keine private IP – Abfrage deaktiviert' : this.lastError,
    };
  }

  // ─── adapter setup ──────────────────────────────────────────────────────────

  private buildAdapters(cfg: AppConfig): void {
    const host = cfg.router.ip.trim();
    const port = 80;
    if (!isAllowedRouterAddress(host)) {
      this.addressBlocked = true;
      this.adapters = null;
      this.lastError = `Router-Adresse ${host || '(leer)'} ist keine private IP – Abfrage deaktiviert`;
      return;
    }
    this.addressBlocked = false;
    const makeSession = this.deps.makeSession ?? ((h: string, p: number) => new HttpSession({ host: h, port: p }));
    this.adapters = {
      host,
      port,
      arris: new ArrisAdapter({ host, port, username: cfg.router.username, makeSession, now: this.now }),
      generic: new GenericAdapter({ host, port, makeSession }),
    };
    if (cfg.router.adapter !== 'auto') this.detected = cfg.router.adapter;
  }

  // ─── scheduling ─────────────────────────────────────────────────────────────

  private statusIntervalMs(): number {
    const cfg = this.ctx?.config();
    const sec = cfg?.router.pollStatusSec ?? IDLE_STATUS_SEC;
    return (this.sessionActive ? sec : Math.max(sec, IDLE_STATUS_SEC)) * 1000;
  }

  private clearStatusTimer(): void {
    if (this.statusTimer) clearTimeout(this.statusTimer);
    this.statusTimer = null;
  }

  private clearAuthTimer(): void {
    if (this.authTimer) clearTimeout(this.authTimer);
    this.authTimer = null;
  }

  private scheduleStatus(delayMs: number): void {
    if (this.addressBlocked) return;
    this.clearStatusTimer();
    this.statusTimer = setTimeout(() => {
      this.statusTimer = null;
      void this.pollStatus().finally(() => {
        if (!this.addressBlocked) this.scheduleStatus(this.statusIntervalMs());
      });
    }, Math.max(0, delayMs));
  }

  private scheduleAuth(delayMs: number): void {
    if (this.addressBlocked || !this.sessionActive) return;
    this.clearAuthTimer();
    const now = this.now();
    // respect lockout / backoff when choosing the next attempt time
    const gated = Math.max(this.gate.lockoutUntil ?? 0, this.gate.backoffUntil ?? 0) - now;
    const wait = Math.max(delayMs, gated);
    this.nextRunTs = now + wait;
    this.authTimer = setTimeout(() => {
      this.authTimer = null;
      void this.authCycle().finally(() => {
        if (this.sessionActive) {
          const periodMs = (this.ctx?.config().router.pollDocsisSec ?? 300) * 1000;
          this.scheduleAuth(periodMs);
        }
      });
    }, Math.max(0, wait));
  }

  // ─── status poll (always) ───────────────────────────────────────────────────

  private async readStartPage(): Promise<{ reachable: boolean; httpMs: number | null; body: string | null; status: number; error: string | null }> {
    const a = this.adapters;
    if (!a) return { reachable: false, httpMs: null, body: null, status: 0, error: 'Router-Adapter nicht initialisiert' };
    const session = (this.deps.makeSession ?? ((h, p) => new HttpSession({ host: h, port: p })))(a.host, a.port);
    try {
      const res = await session.get('/', { timeoutMs: 10_000 });
      return { reachable: true, httpMs: Math.round(res.ms), body: res.body, status: res.status, error: null };
    } catch (err) {
      const msg = err instanceof HttpError ? err.message : err instanceof Error ? err.message : String(err);
      return { reachable: false, httpMs: null, body: null, status: 0, error: msg };
    } finally {
      session.abort();
    }
  }

  private async pollStatus(): Promise<void> {
    const ctx = this.ctx;
    if (!ctx || this.addressBlocked || this.statusBusy) return;
    this.statusBusy = true;
    const ts = this.now();
    try {
      const a = this.adapters;
      if (!a) return;
      const cfg = ctx.config();
      // adapter auto-detection from the start page
      if (this.detected === null && cfg.router.adapter === 'auto') {
        const probe = await this.readStartPage();
        if (!probe.reachable) {
          this.handleUnreachable(ts, probe.error);
          return;
        }
        this.detected = probe.body && detectArris(probe.body) ? 'arris-vodafone-station' : 'generic';
        if (this.detected === 'arris-vodafone-station') {
          this.applyStartInfo(ts, startPageInfo(parseStartPage(probe.body ?? '')), probe.httpMs);
        } else {
          this.applyGeneric(ts, probe.httpMs, probe.status);
        }
        return;
      }

      if (this.detected === 'generic') {
        const g = await a.generic.fetchStatus();
        if (!g.reachable) this.handleUnreachable(ts, g.error);
        else this.applyGeneric(ts, g.httpMs, g.httpStatus, g.title);
        return;
      }

      // ARRIS (or forced): read the start page directly so detection + status share one GET
      const probe = await this.readStartPage();
      if (!probe.reachable || probe.body === null) {
        this.handleUnreachable(ts, probe.error);
        return;
      }
      this.applyStartInfo(ts, startPageInfo(parseStartPage(probe.body)), probe.httpMs);
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      ctx.log.debug(`Router-Statusabfrage fehlgeschlagen: ${this.lastError}`);
    } finally {
      this.statusBusy = false;
      this.lastRunTs = ts;
    }
  }

  private handleUnreachable(ts: number, error: string | null): void {
    const ctx = this.ctx;
    if (!ctx) return;
    this.lastHttpMs = null;
    this.offlineFailures++;
    this.lastError = error ?? 'Router nicht erreichbar';
    ctx.recordMetrics([{ ts, key: 'router.reachable', value: 0 }]);
    if (this.offlineFailures === OFFLINE_AFTER_FAILS && this.offlineEventId === null) {
      this.offlineEventId = ctx.recordEvent({
        ts,
        type: 'router_offline',
        severity: 'warn',
        segment: 'router',
        source: 'router',
        title: 'Router antwortet nicht',
        details: { error: this.lastError, failures: this.offlineFailures },
      });
    }
    this.emitStatus(ts, false);
  }

  private applyGeneric(ts: number, httpMs: number | null, httpStatus: number | null, title: string | null = null): void {
    this.clearOffline(ts);
    this.lastHttpMs = httpMs;
    this.lastStartInfo = {
      vendor: null,
      model: title,
      firmware: null,
      connectionStatus: null,
      wanIpv4: null,
      wanIpv6: null,
      aftrAddress: null,
      dsLite: null,
      gwMode: null,
      lastRebootReason: null,
      lockoutSec: null,
      docsisFailoverStatus: null,
      extra: httpStatus ? { httpStatus } : {},
    };
    this.ctx?.recordMetrics(this.reachMetrics(ts, httpMs));
    this.emitStatus(ts, true);
  }

  /** Status poll: ingest + record reachability metrics + emit/snapshot. */
  private applyStartInfo(ts: number, info: StartPageInfo, httpMs: number | null): void {
    const ctx = this.ctx;
    if (!ctx) return;
    this.ingestStartInfo(ts, info, httpMs);
    ctx.recordMetrics(this.reachMetrics(ts, httpMs));
    this.emitStatus(ts, true);
  }

  /** Update cached status fields from a start page without emitting (used by the auth login). */
  private ingestStartInfo(ts: number, info: StartPageInfo, httpMs: number | null): void {
    const ctx = this.ctx;
    if (!ctx) return;
    this.clearOffline(ts);
    this.lastHttpMs = httpMs;
    this.lastStartInfo = info;
    // $aftr for the probes (DS-Lite gateway)
    if (info.aftrAddress) ctx.hosts.set({ aftr: info.aftrAddress }, 'router');
    // ip_change (WAN IPv6 / AFTR)
    this.detectIpChange(ts, info);
    // lockout seen unauthenticated
    if (info.lockoutSec !== null && info.lockoutSec > 0) {
      this.gate.lockoutUntil = Math.max(this.gate.lockoutUntil ?? 0, ts + info.lockoutSec * 1000 + LOCKOUT_GRACE_MS);
    }
  }

  private reachMetrics(ts: number, httpMs: number | null): MetricPoint[] {
    const out: MetricPoint[] = [{ ts, key: 'router.reachable', value: 1 }];
    if (httpMs !== null && Number.isFinite(httpMs)) out.push({ ts, key: 'router.http_ms', value: httpMs });
    return out;
  }

  private clearOffline(ts: number): void {
    this.offlineFailures = 0;
    if (this.offlineEventId !== null) {
      this.ctx?.updateEvent(this.offlineEventId, { endTs: ts });
      this.offlineEventId = null;
    }
  }

  private detectIpChange(ts: number, info: StartPageInfo): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const first = this.lastWanIpv6 === null && this.lastAftr === null;
    const wanChanged = info.wanIpv6 !== null && info.wanIpv6 !== this.lastWanIpv6;
    const aftrChanged = info.aftrAddress !== null && info.aftrAddress !== this.lastAftr;
    if (!first && (wanChanged || aftrChanged)) {
      ctx.recordEvent({
        ts,
        type: 'ip_change',
        severity: 'info',
        segment: aftrChanged ? 'aftr' : 'isp',
        source: 'router',
        title: aftrChanged ? 'DS-Lite-Gateway (AFTR) gewechselt' : 'WAN-IPv6-Adresse gewechselt',
        details: {
          wanIpv6: info.wanIpv6,
          previousWanIpv6: this.lastWanIpv6,
          aftrAddress: info.aftrAddress,
          previousAftr: this.lastAftr,
        },
      });
    }
    if (info.wanIpv6 !== null) this.lastWanIpv6 = info.wanIpv6;
    if (info.aftrAddress !== null) this.lastAftr = info.aftrAddress;
  }

  // ─── authenticated cycle (session, ARRIS only) ───────────────────────────────

  private canLogin(now: number): boolean {
    const cfg = this.ctx?.config();
    if (!cfg || !this.adapters || this.detected === 'generic') return false;
    if (!cfg.router.loginEnabled) return false;
    if (!this.ctx?.secrets.hasRouterPassword()) return false;
    if (this.gate.disabledReason !== null) return false;
    if (this.gate.lockoutUntil !== null && now < this.gate.lockoutUntil) return false;
    if (this.gate.backoffUntil !== null && now < this.gate.backoffUntil) return false;
    return true;
  }

  private async authCycle(): Promise<void> {
    const ctx = this.ctx;
    const a = this.adapters;
    if (!ctx || !a || this.authBusy) return;
    if (this.detected !== 'arris-vodafone-station' && this.detected !== null) return;
    const now = this.now();
    if (!this.canLogin(now)) {
      this.refreshLoginError();
      return;
    }
    const password = await ctx.secrets.getRouterPassword().catch((err: unknown) => {
      this.lastError = err instanceof Error ? err.message : String(err);
      return null;
    });
    if (password === null) {
      this.refreshLoginError();
      return;
    }

    this.authBusy = true;
    const cfg = ctx.config();
    const logoutAfter = cfg.router.logoutAfterPoll;
    const wantLog = now - this.lastLogDue >= cfg.router.pollLogSec * 1000;
    let lc: LoginContext | null = null;
    let reused = false;
    try {
      // reuse a kept session (only when logoutAfterPoll is off) or log in fresh
      if (!logoutAfter && this.keptSession && !this.keptSession.session.aborted) {
        lc = this.keptSession;
        reused = true;
      } else {
        lc = await this.login(password, now);
      }
      if (!lc) return;

      let docsis = await a.arris.fetchDocsis(lc);
      if (docsis === null && reused) {
        // kept session expired → re-login once (ARCHITECTURE §4.10)
        await this.dropSession();
        lc = await this.login(password, this.now());
        reused = false;
        if (!lc) return;
        docsis = await a.arris.fetchDocsis(lc);
      }

      const status = await a.arris.fetchDeviceStatus(lc);
      const devices = await a.arris.fetchAttachedDevices(lc);
      const log = wantLog ? await a.arris.fetchEventLog(lc) : null;

      const authTs = this.now();
      if (docsis) this.applyDocsis(authTs, docsis.ds, docsis.us);
      if (status) this.applyDeviceStatus(authTs, status.uptimeSec, status.firmware);
      if (devices) this.applyAttachedDevices(devices);
      if (log) {
        this.applyEventLog(log);
        this.lastLogDue = authTs;
      }
      this.emitStatus(authTs, true);
      this.lastRunTs = authTs;
      if (docsis || status) this.gate.backoffFailures = 0;
    } catch (err) {
      this.registerTransportFailure(err instanceof Error ? err.message : String(err));
    } finally {
      // logoutAfterPoll: free the single admin session every cycle; otherwise keep it for reuse
      if (lc) {
        if (logoutAfter) {
          await a.arris.logout(lc);
          this.keptSession = null;
        } else {
          this.keptSession = lc;
        }
      }
      this.authBusy = false;
    }
  }

  /** Perform one login and translate the outcome into the gate / events. Returns the context or null. */
  private async login(password: string, now: number): Promise<LoginContext | null> {
    const a = this.adapters;
    const ctx = this.ctx;
    if (!a || !ctx) return null;
    const result = await a.arris.login(password);
    // the login's start page is a fresh unauthenticated status read – fold it in (emit happens
    // once at the end of the auth cycle)
    if (result.page) {
      this.ingestStartInfo(this.now(), startPageInfo(result.page), result.httpMs);
    }
    const o = result.outcome;
    switch (o.kind) {
      case 'success':
        this.onLoginCategory('success', 'Router-Anmeldung erfolgreich', 'info', {});
        this.lastError = null;
        return { csrfNonce: o.csrfNonce, session: result.session };
      case 'wrong-password':
        this.gate.disabledReason = 'Falsches Router-Passwort';
        this.lastError = 'Router-Anmeldung abgelehnt (falsches Passwort) – bis zur Passwortänderung gestoppt';
        this.onLoginCategory('failure', 'Router-Anmeldung fehlgeschlagen (falsches Passwort)', 'warn', { pStatus: o.pStatus });
        return null;
      case 'implausible':
        this.gate.disabledReason = 'Router-Anmeldung nicht bestätigt';
        this.lastError = `Router-Anmeldung nicht bestätigt: ${o.message} – bis zur Passwortänderung gestoppt`;
        this.onLoginCategory('failure', 'Router-Anmeldung nicht bestätigt', 'warn', { reason: o.message });
        return null;
      case 'lockout': {
        const waitMs = (o.waitSec ?? 60) * 1000 + LOCKOUT_GRACE_MS;
        this.gate.lockoutUntil = now + waitMs;
        this.lastError = `Router gesperrt – warte ${Math.round(waitMs / 1000)} s`;
        this.onLoginCategory('lockout', 'Router-Anmeldung gesperrt (zu viele Versuche)', 'warn', { waitSec: o.waitSec });
        return null;
      }
      case 'unanswered':
      case 'error':
      default:
        this.registerTransportFailure(o.message);
        return null;
    }
  }

  private registerTransportFailure(message: string): void {
    this.gate.backoffFailures++;
    this.gate.backoffUntil = this.now() + loginBackoffMs(this.gate.backoffFailures);
    this.lastError = message;
    this.ctx?.log.debug(`Router-Anmeldung/-Abfrage fehlgeschlagen (Backoff ${this.gate.backoffFailures}): ${message}`);
  }

  private onLoginCategory(category: 'success' | 'failure' | 'lockout', title: string, severity: Severity, details: Record<string, unknown>): void {
    if (this.lastLoginCategory === category) return; // only on transitions
    this.lastLoginCategory = category;
    this.ctx?.recordEvent({ ts: this.now(), type: 'router_login', severity, segment: 'router', source: 'router', title, details });
  }

  private refreshLoginError(): void {
    const now = this.now();
    if (this.gate.disabledReason) this.lastError = `${this.gate.disabledReason} – Anmeldung gestoppt`;
    else if (this.gate.lockoutUntil && now < this.gate.lockoutUntil) this.lastError = `Router gesperrt – warte ${Math.round((this.gate.lockoutUntil - now) / 1000)} s`;
    else if (!this.ctx?.config().router.loginEnabled) this.lastError = null;
    else if (!this.ctx?.secrets.hasRouterPassword()) this.lastError = 'Kein Router-Passwort hinterlegt';
  }

  private async dropSession(): Promise<void> {
    const kept = this.keptSession;
    this.keptSession = null;
    if (kept && this.adapters) await this.adapters.arris.logout(kept);
  }

  // ─── authenticated results ────────────────────────────────────────────────

  private applyDocsis(ts: number, ds: Parameters<typeof rateDocsis>[1], us: Parameters<typeof rateDocsis>[2]): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const lockedByFamily: Record<DocsisFamilyName, number> = { ds: 0, ofdm: 0, us: 0, ofdma: 0 };
    const pre = rateDocsis(ts, ds, us); // first pass to read family counts for the baseline
    for (const f of ['ds', 'ofdm', 'us', 'ofdma'] as const) lockedByFamily[f] = pre.summary.families[f].locked;
    const { baseline, partialSince } = this.baseline.update(ts, lockedByFamily);
    const snap = rateDocsis(ts, ds, us, { baseline, partialSince });
    this.lastDocsis = snap;

    ctx.recordSnapshot('docsis', snap, ts);
    ctx.recordMetrics(docsisMetricPoints(ts, snap));

    const sig = docsisSignature(snap);
    const change = this.docsisChange.push(sig);
    if (change.changed) {
      const severity: Severity = snap.grade === 'sofort' ? 'critical' : snap.grade === 'monatsfrist' ? 'warn' : 'info';
      ctx.recordEvent({
        ts,
        type: 'docsis_change',
        severity,
        segment: 'docsis',
        source: 'router',
        title: this.docsisChangeTitle(snap),
        details: {
          grade: snap.grade,
          rating: snap.rating,
          families: snap.summary.families,
          notes: snap.notes.slice(0, 6),
        },
      });
    }
  }

  private docsisChangeTitle(snap: RatedDocsisSnapshot): string {
    const partial = snap.findings.find((f) => f.code === 'partial');
    if (partial) return `DOCSIS: ${partial.text}`;
    if (snap.grade === 'sofort') return 'DOCSIS-Werte kritisch';
    if (snap.grade === 'monatsfrist') return 'DOCSIS-Werte grenzwertig';
    return 'DOCSIS-Kanäle geändert';
  }

  private applyDeviceStatus(ts: number, uptimeSec: number | null, firmware: string | null): void {
    const ctx = this.ctx;
    if (!ctx) return;
    if (firmware) this.lastFirmwareAuth = firmware;
    if (uptimeSec === null || !Number.isFinite(uptimeSec)) return;
    ctx.recordMetrics([{ ts, key: 'router.uptime_s', value: uptimeSec }]);
    const prev = this.lastUptimeSec;
    // a reboot resets the uptime: current clearly below the previous value (minus the elapsed poll gap)
    if (prev !== null && uptimeSec + 60 < prev) {
      ctx.recordEvent({
        ts,
        type: 'router_reboot',
        severity: 'warn',
        segment: 'router',
        source: 'router',
        title: 'Router neu gestartet (Laufzeit zurückgesetzt)',
        details: { uptimeSec, previousUptimeSec: prev, lastRebootReason: this.lastStartInfo?.lastRebootReason ?? null },
      });
    }
    this.lastUptimeSec = uptimeSec;
  }

  private applyAttachedDevices(devices: RouterAttachedDevice[]): void {
    const ctx = this.ctx;
    if (!ctx) return;
    let adapters: AdapterSnapshot | null = null;
    try {
      adapters = ctx.db.latestSnapshot<AdapterSnapshot>('adapters')?.data ?? null;
    } catch {
      adapters = null;
    }
    this.lastAttached = markThisPc(devices, pcIdentity(adapters));
  }

  private applyEventLog(entries: readonly CategorizedLogEntry[]): void {
    const ctx = this.ctx;
    if (!ctx) return;
    // oldest first so burst windows / dedupe order are stable
    const ordered = [...entries].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
    const snapshot: unknown[] = [];
    for (const e of ordered) {
      const segment = e.dir === 'US' || e.dir === 'DS' ? 'docsis' : null;
      const details: Record<string, unknown> = {
        timeText: e.timeText,
        ts: e.ts,
        index: e.index,
        level: e.level,
        key: e.key,
        category: e.category,
        cmStatusCode: e.cmStatusCode,
        dir: e.dir,
        message: e.message, // display message (CM-MAC tail already stripped)
        burst: e.burst,
      };
      snapshot.push(details);
      if (ctx.db.hasEvent(e.dedupeKey)) continue;
      ctx.recordEvent({
        ts: e.ts ?? this.now(),
        type: 'router_log',
        severity: e.severity,
        segment,
        source: 'router',
        title: e.title,
        details,
        dedupeKey: e.dedupeKey,
      });
    }
    // keep a rolling snapshot of the (volatile) router log, newest first
    ctx.recordSnapshot('router_log', { entries: [...snapshot].reverse() });
  }

  // ─── RouterStatus assembly ──────────────────────────────────────────────────

  private assemble(ts: number, reachable: boolean): RouterStatus {
    const ctx = this.ctx;
    const cfg = ctx?.config();
    const info = this.lastStartInfo;
    const now = this.now();
    const lockoutUntil = this.gate.lockoutUntil !== null && this.gate.lockoutUntil > now ? this.gate.lockoutUntil : null;
    return {
      ts,
      ip: this.adapters?.host ?? cfg?.router.ip ?? '',
      reachable,
      httpMs: this.lastHttpMs,
      adapter: this.detected ?? 'generic',
      vendor: info?.vendor ?? null,
      model: info?.model ?? null,
      firmware: this.lastFirmwareAuth ?? info?.firmware ?? null,
      loginConfigured: this.ctx?.secrets.hasRouterPassword() ?? false,
      loginEnabled: cfg?.router.loginEnabled ?? false,
      loggedIn: this.keptSession !== null && !this.keptSession.session.aborted,
      loginError: this.gate.disabledReason ?? (lockoutUntil ? 'Router gesperrt' : null),
      lockoutUntil,
      connectionStatus: info?.connectionStatus ?? null,
      wanIpv4: info?.wanIpv4 ?? null,
      wanIpv6: info?.wanIpv6 ?? null,
      aftrAddress: info?.aftrAddress ?? null,
      dsLite: info?.dsLite ?? null,
      gwMode: info?.gwMode ?? null,
      uptimeSec: this.lastUptimeSec,
      lastRebootReason: info?.lastRebootReason ?? null,
      docsis: this.lastDocsis,
      attachedDevices: this.lastAttached,
      extra: info?.extra ?? {},
    };
  }

  private emitStatus(ts: number, reachable: boolean): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const status = this.assemble(ts, reachable);
    ctx.bus.emit('router', status);
    // snapshot on change or at least every 10 min
    const sig = this.snapshotSignature(status);
    if (sig !== this.lastSnapshotSig || ts - this.lastSnapshotTs >= SNAPSHOT_MAX_INTERVAL_MS) {
      ctx.recordSnapshot('router', status, ts);
      this.lastSnapshotSig = sig;
      this.lastSnapshotTs = ts;
    }
  }

  /** Signature of the router-level status (not the DOCSIS tables – those snapshot separately). */
  private snapshotSignature(s: RouterStatus): string {
    return [
      s.reachable ? 1 : 0,
      s.connectionStatus ?? '',
      s.firmware ?? '',
      s.wanIpv6 ?? '',
      s.aftrAddress ?? '',
      s.dsLite ? 1 : 0,
      s.loggedIn ? 1 : 0,
      s.loginError ?? '',
      this.lastDocsis?.grade ?? '',
      s.attachedDevices?.length ?? -1,
    ].join('|');
  }
}
