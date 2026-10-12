// Application configuration: types, defaults, merge + validation.
// Stored as JSON in settings key 'config' (the router password is stored separately by the
// engine under 'router.password', DPAPI-encrypted).
import { z } from 'zod';
import type { SpikeRule } from './stats';
import type { RouterAdapterId, Segment, TargetConfig } from './types';

/** value ≤ good → gut, value ≤ warn → grenzwertig, above → schlecht */
export interface Band {
  good: number;
  warn: number;
}

export interface AppConfig {
  version: 1;
  router: {
    /** router address – must be a private IP literal (never easy.box / kabel.box!) */
    ip: string;
    adapter: 'auto' | RouterAdapterId;
    username: string;
    /** allow the engine to log into the router web UI (needs a stored password) */
    loginEnabled: boolean;
    /** unauthenticated start page poll (status vars + HTTP response time) */
    pollStatusSec: number;
    /** authenticated DOCSIS + uptime poll (one scrape takes ~5 s) */
    pollDocsisSec: number;
    /** authenticated router event log poll */
    pollLogSec: number;
    /** log out after every authenticated poll so the single admin session stays free for the browser */
    logoutAfterPoll: boolean;
  };
  tariff: {
    name: string | null;
    downMbps: number | null;
    upMbps: number | null;
  };
  targets: TargetConfig[];
  session: {
    /** keep Windows from idle sleep while a session runs (SetThreadExecutionState, no admin) */
    preventSleep: boolean;
  };
  gaming: {
    /** process names (case-insensitive, e.g. 'cs2.exe'); while one runs, speed tests are skipped */
    processNames: string[];
  };
  schedules: {
    speedtestEnabled: boolean;
    speedtestEveryMin: number;
    /** local hours [from, to) during which scheduled speed tests are skipped */
    speedtestQuietHours: { from: number; to: number } | null;
    /** path discovery (TTL probes hops 1–8, 3 probes each) incl. route-change detection */
    tracerouteEveryMin: number;
    /** deep MTR pass (20 probes per hop) */
    mtrEveryMin: number;
    mtuEveryMin: number;
    stunEveryMin: number;
    udpBurstEveryMin: number;
    adapterPollSec: number;
    eventLogPollSec: number;
    wlanPollSec: number;
    routePollSec: number;
    vpnPollSec: number;
    systemPollSec: number;
    /** gateway MAC, DHCP server, DNS servers, IPv6 prefix, game process detection */
    identityPollSec: number;
  };
  speedtest: {
    downloadStreams: number;
    uploadStreams: number;
    idleSec: number;
    downloadSec: number;
    uploadSec: number;
  };
  udpBurst: {
    packetsPerSecond: number;
    durationSec: number;
  };
  thresholds: {
    /** typical latency (p50, ms) per segment */
    latency: Record<Segment, Band>;
    /** spike tail p99 − p50 (ms) */
    tail: Band;
    /** jitter, mean absolute successive difference (ms) */
    jitter: Band;
    /** internet-wide packet loss (%) */
    loss: Band;
    /** samples ≥ 200 ms per hour */
    lagPerHour: Band;
    /** outages ≥ 3 s per day */
    outagesPerDay: Band;
    /** bufferbloat: loaded − idle latency (ms) */
    bufferbloat: Band;
    spikeLan: SpikeRule;
    spikeWan: SpikeRule;
    /** consecutive lost rounds on all internet targets that count as outage */
    outageMinSec: number;
    /** loss burst: ≥ burstMinLosses within burstWindowSec on one target */
    burstWindowSec: number;
    burstMinLosses: number;
    /** own traffic ≥ this % of min(link speed, tariff) tags a second as self-load */
    selfLoadPct: number;
  };
  retention: {
    rawDays: number;
    rollupDays: number;
    eventsDays: number;
    snapshotsDays: number;
    metricsDays: number;
  };
  eventLog: {
    /** days of Windows event log history imported on first start (backfill) */
    importDays: number;
  };
}

const icmp = (
  id: string, name: string, host: string, family: 4 | 6, segment: Segment,
  extra: Partial<TargetConfig> = {},
): TargetConfig => ({
  id, name, host, family, kind: 'icmp', segment, intervalMs: 1000, timeoutMs: 2000,
  enabled: true, builtin: true, ...extra,
});

export const DEFAULT_TARGETS: TargetConfig[] = [
  icmp('gw', 'Router (Gateway)', '$gateway', 4, 'lan', {
    description: 'Ping zum Router – misst die Strecke PC ⇄ Router (Netzwerkkabel bzw. WLAN).',
  }),
  icmp('gw6', 'Router (IPv6, link-lokal)', '$router6', 6, 'lan', {
    description: 'Ping zum Router über IPv6 (link-lokale Adresse) – zweiter LAN-Messpunkt.',
  }),
  {
    id: 'gw-tcp', name: 'Router-Weboberfläche (TCP 80)', host: '$gateway', family: 4, kind: 'tcp', port: 80,
    segment: 'router', intervalMs: 10_000, timeoutMs: 2000, enabled: true, builtin: true,
    description: 'TCP-Verbindungsaufbau zur Router-Oberfläche – steigt, wenn der Router überlastet ist.',
  },
  {
    id: 'gw-dns', name: 'Router-DNS (UDP)', host: '$gateway', family: 4, kind: 'udp-dns', port: 53,
    query: 'cloudflare.com', segment: 'router', intervalMs: 10_000, timeoutMs: 2000, enabled: true, builtin: true,
    description: 'Antwortzeit des DNS-Proxys im Router.',
  },
  icmp('isp6', 'Vodafone-Kopfstation (CMTS, 1. IPv6-Hop)', '$isp6', 6, 'docsis', {
    description: 'Erster Provider-Knoten hinter dem Router – misst die Kabelstrecke (DOCSIS) ohne DS-Lite.',
  }),
  icmp('aftr', 'DS-Lite-Gateway (AFTR)', '$aftr', 6, 'aftr', {
    description: 'Vodafone-DS-Lite-Gateway: hierüber läuft der komplette IPv4-Verkehr (Carrier-NAT).',
  }),
  icmp('isp4', 'Vodafone-Backbone (1. IPv4-Hop)', '$isp4', 4, 'isp', {
    description: 'Erster antwortender IPv4-Knoten hinter dem AFTR (antwortet nicht immer zuverlässig).',
  }),
  icmp('cf4', 'Cloudflare 1.1.1.1', '1.1.1.1', 4, 'internet', { pairId: 'cf6' }),
  icmp('cf6', 'Cloudflare IPv6', '2606:4700:4700::1111', 6, 'internet', { pairId: 'cf4' }),
  icmp('g4', 'Google 8.8.8.8', '8.8.8.8', 4, 'internet', { pairId: 'g6' }),
  icmp('g6', 'Google IPv6', '2001:4860:4860::8888', 6, 'internet', { pairId: 'g4' }),
  icmp('q4', 'Quad9 9.9.9.9', '9.9.9.9', 4, 'internet', { pairId: 'q6', enabled: false }),
  icmp('q6', 'Quad9 IPv6', '2620:fe::fe', 6, 'internet', { pairId: 'q4', enabled: false }),
  {
    id: 'cf4-udp', name: 'Cloudflare UDP (IPv4)', host: '1.1.1.1', family: 4, kind: 'udp-dns', port: 53,
    query: 'id.server', segment: 'internet', intervalMs: 5000, timeoutMs: 2000, enabled: true, builtin: true,
    pairId: 'cf6-udp',
    description: 'UDP-Laufzeit wie bei Spieleverkehr (über NAT/AFTR). Abfrage „id.server“ (CH/TXT) beantwortet der Cloudflare-Knoten direkt.',
  },
  {
    id: 'cf6-udp', name: 'Cloudflare UDP (IPv6)', host: '2606:4700:4700::1111', family: 6, kind: 'udp-dns',
    port: 53, query: 'id.server', segment: 'internet', intervalMs: 5000, timeoutMs: 2000, enabled: true,
    builtin: true, pairId: 'cf4-udp', description: 'UDP-Laufzeit über natives IPv6 (ohne DS-Lite).',
  },
  {
    id: 'cf4-tcp', name: 'Cloudflare HTTPS (TCP, IPv4)', host: '1.1.1.1', family: 4, kind: 'tcp', port: 443,
    segment: 'internet', intervalMs: 10_000, timeoutMs: 3000, enabled: true, builtin: true, pairId: 'cf6-tcp',
  },
  {
    id: 'cf6-tcp', name: 'Cloudflare HTTPS (TCP, IPv6)', host: '2606:4700:4700::1111', family: 6, kind: 'tcp',
    port: 443, segment: 'internet', intervalMs: 10_000, timeoutMs: 3000, enabled: true, builtin: true, pairId: 'cf4-tcp',
  },
  {
    id: 'aws-fra', name: 'AWS Frankfurt (eu-central-1)', host: 'dynamodb.eu-central-1.amazonaws.com', family: 4,
    kind: 'tcp', port: 443, segment: 'game', intervalMs: 10_000, timeoutMs: 3000, enabled: true, builtin: true,
    description: 'Viele Spieleserver laufen in AWS-Rechenzentren in Frankfurt.',
  },
  {
    id: 'aws-irl', name: 'AWS Irland (eu-west-1)', host: 'dynamodb.eu-west-1.amazonaws.com', family: 4,
    kind: 'tcp', port: 443, segment: 'game', intervalMs: 10_000, timeoutMs: 3000, enabled: true, builtin: true,
  },
];

export const DEFAULT_GAME_PROCESSES: string[] = [
  'cs2.exe', 'valorant-win64-shipping.exe', 'fortniteclient-win64-shipping.exe', 'league of legends.exe',
  'r5apex.exe', 'r5apex_dx12.exe', 'rocketleague.exe', 'overwatch.exe', 'dota2.exe', 'cod.exe',
  'gta5.exe', 'gta5_enhanced.exe', 'fc25.exe', 'fc26.exe', 'rainbowsix.exe', 'rainbowsix_vulkan.exe',
  'tslgame.exe', 'escapefromtarkov.exe', 'wow.exe', 'destiny2.exe', 'robloxplayerbeta.exe',
  'marvel-win64-shipping.exe', 'minecraft.windows.exe',
  // macOS process names (compared without .exe/.app, docs/research/macos.md §0)
  'leagueoflegends', 'world of warcraft', 'robloxplayer', 'geforcenow',
];

export const DEFAULT_CONFIG: AppConfig = {
  version: 1,
  router: {
    ip: '192.168.0.1',
    adapter: 'auto',
    username: 'admin',
    loginEnabled: false,
    pollStatusSec: 60,
    pollDocsisSec: 300,
    pollLogSec: 900,
    logoutAfterPoll: true,
  },
  tariff: { name: null, downMbps: null, upMbps: null },
  targets: DEFAULT_TARGETS,
  session: { preventSleep: true },
  gaming: { processNames: DEFAULT_GAME_PROCESSES },
  schedules: {
    speedtestEnabled: true,
    speedtestEveryMin: 180,
    speedtestQuietHours: { from: 18, to: 23 },
    tracerouteEveryMin: 15,
    mtrEveryMin: 60,
    mtuEveryMin: 1440,
    stunEveryMin: 30,
    udpBurstEveryMin: 5,
    adapterPollSec: 10,
    eventLogPollSec: 60,
    wlanPollSec: 15,
    routePollSec: 60,
    vpnPollSec: 120,
    systemPollSec: 10,
    identityPollSec: 60,
  },
  speedtest: { downloadStreams: 6, uploadStreams: 4, idleSec: 10, downloadSec: 15, uploadSec: 15 },
  udpBurst: { packetsPerSecond: 20, durationSec: 10 },
  thresholds: {
    latency: {
      client: { good: 5, warn: 20 },
      lan: { good: 2, warn: 5 },
      router: { good: 10, warn: 50 },
      docsis: { good: 15, warn: 30 },
      aftr: { good: 25, warn: 40 },
      isp: { good: 25, warn: 40 },
      internet: { good: 40, warn: 80 },
      game: { good: 40, warn: 80 },
    },
    tail: { good: 20, warn: 50 },
    jitter: { good: 5, warn: 15 },
    loss: { good: 0.1, warn: 1 },
    lagPerHour: { good: 0, warn: 2 },
    outagesPerDay: { good: 0, warn: 1 },
    bufferbloat: { good: 30, warn: 60 },
    spikeLan: { k: 5, minDeltaMs: 10, lagMs: 200 },
    spikeWan: { k: 5, minDeltaMs: 25, lagMs: 200 },
    outageMinSec: 3,
    burstWindowSec: 10,
    burstMinLosses: 2,
    selfLoadPct: 80,
  },
  retention: { rawDays: 14, rollupDays: 400, eventsDays: 3650, snapshotsDays: 60, metricsDays: 90 },
  eventLog: { importDays: 365 },
};

// ─── validation ────────────────────────────────────────────────────────────

const segmentSchema = z.enum(['client', 'lan', 'router', 'docsis', 'aftr', 'isp', 'internet', 'game']);
const band = z.object({ good: z.number().nonnegative(), warn: z.number().nonnegative() });
const spikeRule = z.object({ k: z.number().positive().max(20), minDeltaMs: z.number().positive(), lagMs: z.number().positive() });

export const targetSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/),
  name: z.string().min(1).max(80),
  host: z.string().min(1).max(253),
  family: z.union([z.literal(4), z.literal(6)]),
  kind: z.enum(['icmp', 'tcp', 'udp-dns', 'http']),
  port: z.number().int().min(1).max(65535).optional(),
  path: z.string().max(200).optional(),
  query: z.string().max(253).optional(),
  segment: segmentSchema,
  intervalMs: z.number().int().min(250).max(600_000),
  timeoutMs: z.number().int().min(100).max(10_000),
  enabled: z.boolean(),
  builtin: z.boolean(),
  pairId: z.string().optional(),
  color: z.string().max(40).optional(),
  description: z.string().max(300).optional(),
});

export const configSchema = z.object({
  version: z.literal(1),
  router: z.object({
    ip: z.string().min(1).max(253),
    adapter: z.enum(['auto', 'arris-vodafone-station', 'generic']),
    username: z.string().min(1).max(64),
    loginEnabled: z.boolean(),
    pollStatusSec: z.number().int().min(10).max(3600),
    pollDocsisSec: z.number().int().min(60).max(86_400),
    pollLogSec: z.number().int().min(60).max(86_400),
    logoutAfterPoll: z.boolean(),
  }),
  tariff: z.object({
    name: z.string().max(80).nullable(),
    downMbps: z.number().positive().max(100_000).nullable(),
    upMbps: z.number().positive().max(100_000).nullable(),
  }),
  targets: z.array(targetSchema).max(64),
  session: z.object({ preventSleep: z.boolean() }),
  gaming: z.object({ processNames: z.array(z.string().min(1).max(100)).max(200) }),
  schedules: z.object({
    speedtestEnabled: z.boolean(),
    speedtestEveryMin: z.number().int().min(30).max(10_080),
    speedtestQuietHours: z.object({ from: z.number().int().min(0).max(23), to: z.number().int().min(0).max(24) }).nullable(),
    tracerouteEveryMin: z.number().int().min(1).max(1440),
    mtrEveryMin: z.number().int().min(5).max(1440),
    mtuEveryMin: z.number().int().min(10).max(10_080),
    stunEveryMin: z.number().int().min(5).max(1440),
    udpBurstEveryMin: z.number().int().min(1).max(1440),
    adapterPollSec: z.number().int().min(2).max(600),
    eventLogPollSec: z.number().int().min(5).max(3600),
    wlanPollSec: z.number().int().min(2).max(600),
    routePollSec: z.number().int().min(10).max(3600),
    vpnPollSec: z.number().int().min(10).max(3600),
    systemPollSec: z.number().int().min(1).max(600),
    identityPollSec: z.number().int().min(10).max(3600),
  }),
  speedtest: z.object({
    downloadStreams: z.number().int().min(1).max(16),
    uploadStreams: z.number().int().min(1).max(16),
    idleSec: z.number().int().min(3).max(30),
    downloadSec: z.number().int().min(5).max(30),
    uploadSec: z.number().int().min(5).max(30),
  }),
  udpBurst: z.object({
    packetsPerSecond: z.number().int().min(5).max(50),
    durationSec: z.number().int().min(3).max(30),
  }),
  thresholds: z.object({
    latency: z.object({
      client: band, lan: band, router: band, docsis: band, aftr: band, isp: band, internet: band, game: band,
    }),
    tail: band,
    jitter: band,
    loss: band,
    lagPerHour: band,
    outagesPerDay: band,
    bufferbloat: band,
    spikeLan: spikeRule,
    spikeWan: spikeRule,
    outageMinSec: z.number().int().min(1).max(120),
    burstWindowSec: z.number().int().min(2).max(300),
    burstMinLosses: z.number().int().min(2).max(100),
    selfLoadPct: z.number().min(10).max(100),
  }),
  retention: z.object({
    rawDays: z.number().int().min(1).max(90),
    rollupDays: z.number().int().min(7).max(3650),
    eventsDays: z.number().int().min(7).max(3650),
    snapshotsDays: z.number().int().min(1).max(365),
    metricsDays: z.number().int().min(1).max(365),
  }),
  eventLog: z.object({ importDays: z.number().int().min(0).max(3650) }),
});

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(patch)) return (patch === undefined ? base : (patch as T));
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    const b = (base as Record<string, unknown>)[k];
    out[k] = isPlainObject(b) && isPlainObject(v) ? deepMerge(b, v) : v;
  }
  return out as T;
}

/**
 * Merge a stored/partial config onto the defaults. Targets: stored list wins, but builtin
 * defaults missing from the stored list are appended (new versions can ship new targets).
 * Invalid input falls back to defaults section by section (never throws).
 */
export function mergeConfig(input: unknown): AppConfig {
  const stored: Record<string, unknown> = isPlainObject(input) ? input : {};
  const merged = deepMerge<AppConfig>(structuredClone(DEFAULT_CONFIG), stored);
  if (Array.isArray(stored.targets)) {
    const list = stored.targets.filter((t): t is TargetConfig => targetSchema.safeParse(t).success);
    for (const def of DEFAULT_TARGETS) {
      if (!list.some((t) => t.id === def.id)) list.push(structuredClone(def));
    }
    merged.targets = list;
  }
  const parsed = configSchema.safeParse(merged);
  if (parsed.success) return parsed.data as AppConfig;
  const safe = structuredClone(DEFAULT_CONFIG);
  const writable = safe as unknown as Record<string, unknown>;
  for (const key of Object.keys(safe) as (keyof AppConfig)[]) {
    const section = configSchema.shape[key].safeParse(merged[key]);
    if (section.success) writable[key] = section.data;
  }
  return safe;
}

export function enabledTargets(cfg: AppConfig): TargetConfig[] {
  return cfg.targets.filter((t) => t.enabled);
}

export function targetById(cfg: AppConfig, id: string): TargetConfig | undefined {
  return cfg.targets.find((t) => t.id === id);
}

/** Rate a value against a band: ≤ good → 'good', ≤ warn → 'warn', else 'bad'; null → 'unknown'. */
export function rateBand(value: number | null | undefined, b: Band): 'good' | 'warn' | 'bad' | 'unknown' {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'unknown';
  if (value <= b.good) return 'good';
  if (value <= b.warn) return 'warn';
  return 'bad';
}

/** Spike rule for a segment (LAN-side segments use the tighter LAN rule). */
export function spikeRuleFor(cfg: AppConfig, segment: Segment): SpikeRule {
  return segment === 'lan' || segment === 'router' || segment === 'client' ? cfg.thresholds.spikeLan : cfg.thresholds.spikeWan;
}
