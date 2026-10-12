// Segment health (PC → … → game server) for the diagnosis report: KPIs rated with the configured
// bands (config.thresholds, rateBand) plus the findings of each segment. Pure.
import { type Band, rateBand } from '../../shared/config';
import { fmtDb, fmtMs, fmtNumber } from '../../shared/format';
import type { Finding, Health, Segment, SegmentHealth } from '../../shared/types';
import { SEGMENTS } from '../../shared/types';
import { isFaultDrop, relinkStats } from './links';
import { isSevereLineEntry, lineLogKind } from './router-log';
import { wlanSwitches } from './rules/r03-wlan-failover';
import { type BadClass, SEGMENT_LABELS, fmtLinkSpeed, fmtShare, pct } from './text';
import { DAY, MINUTE, maxInWindow } from './time';
import type { DiagnosisInput, StatsSummary } from './types';
import {
  aftrTarget, cmtsTarget, coveredHours, eventCount, eventsOf, gatewayTarget, internetWideLossPct, isp4Target, median,
  segmentTargets, stableStatsOf, statsOf,
} from './util';

type Kpi = SegmentHealth['kpis'][number];

const HEALTH_RANK: Readonly<Record<Health, number>> = { unknown: 0, good: 1, warn: 2, bad: 3 };

export function worstHealth(list: readonly (Health | undefined)[]): Health {
  let best: Health = 'unknown';
  for (const h of list) if (h && HEALTH_RANK[h] > HEALTH_RANK[best]) best = h;
  return best;
}

/** ≤ good → good, < warn → warn, else bad (for "lower is better" values with an open upper band) */
function rateBelow(v: number | null | undefined, good: number, warn: number): Health {
  if (v === null || v === undefined || !Number.isFinite(v)) return 'unknown';
  return v <= good ? 'good' : v < warn ? 'warn' : 'bad';
}

/** share of measured seconds in a class: < 0.1 % good, < 1 % warn, ≥ 1 % bad (methodology §2.2) */
export function rateSecondsShare(n: number, covered: number): Health {
  if (covered <= 0) return 'unknown';
  const r = n / covered;
  return r < 0.001 ? 'good' : r < 0.01 ? 'warn' : 'bad';
}

/** latency/jitter are rated only over ≥ 15 min of data (methodology §2.2), shares only over ≥ 1 h */
const MIN_RATED_MINUTES = 15;
const MIN_RATED_SECONDS = 3600;

/**
 * The status only when the summary rests on enough minutes – otherwise the value is shown unrated.
 * Group summaries (@internet …) sum the minutes of their members, hence `members`.
 */
export function rated(s: StatsSummary | null | undefined, status: Health, members = 1): Health | undefined {
  return s && s.minutes >= MIN_RATED_MINUTES * Math.max(1, members) ? status : undefined;
}

/** number of member targets with data of a pseudo target ('@internet', '@internet4', '@internet6') */
function internetMembers(input: DiagnosisInput, family?: 4 | 6): number {
  return segmentTargets(input, 'internet', 'icmp').filter((t) => (family === undefined || t.family === family) && statsOf(input, t.id) !== null).length;
}

function ratedPair(input: DiagnosisInput, a: StatsSummary | null, b: StatsSummary | null, status: Health): Health | undefined {
  return rated(a, status, internetMembers(input, 4)) !== undefined && rated(b, status, internetMembers(input, 6)) !== undefined ? status : undefined;
}

function latencyKpi(label: string, s: StatsSummary | null, band: Band, field: 'p50' | 'p95' | 'p99' = 'p50', members = 1): Kpi | null {
  if (!s) return null;
  const v = s[field];
  return { label, value: fmtMs(v), status: rated(s, rateBand(v, band), members) };
}

function secondsKpi(input: DiagnosisInput, cls: BadClass, label: string): Kpi | null {
  const s = input.seconds;
  if (!s || s.covered <= 0) return null;
  const n = s[cls];
  return {
    label,
    value: `${fmtNumber(n)} s (${fmtShare(n / s.covered)} der Messzeit)`,
    status: s.covered >= MIN_RATED_SECONDS ? rateSecondsShare(n, s.covered) : undefined,
  };
}

const compact = (list: (Kpi | null)[]): Kpi[] => list.filter((k): k is Kpi => k !== null);

/**
 * Auxiliary KPIs (single polls, categorical states, short bursts) may make a segment warn/bad, but
 * cannot make it 'good' on their own – that needs at least one rated measurement KPI.
 */
const AUXILIARY = new WeakSet<Kpi>();
function aux(k: Kpi | null): Kpi | null {
  if (k) AUXILIARY.add(k);
  return k;
}

// ─── per segment ───────────────────────────────────────────────────────────

function clientKpis(input: DiagnosisInput): Kpi[] {
  const weekStart = input.to - 7 * DAY;
  const faults7 = input.linkDrops.filter((d) => isFaultDrop(d) && d.ts >= weekStart && d.ts < input.to);
  const haveLinkData = input.linkDrops.length > 0 || input.linkSpeed.currentMbps !== null || input.linkDays.length > 0;
  const rs = relinkStats(input.linkDrops.filter((d) => d.ts >= input.to - 30 * DAY && d.ts < input.to));
  const wifiPrimary = input.adapters?.adapters.find((a) => !a.isVirtual && a.status.toLowerCase() === 'up' && !a.isWifi) === undefined
    && input.wlan?.connected === true;
  const failovers = Math.max(faults7.filter((d) => d.wlanFailover === true).length, wlanSwitches(input).filter((e) => e.ts >= weekStart).length);
  const retrans = input.metrics['tcp.retrans_pct'];
  const cpu = input.metrics['sys.cpu_pct'];
  const warp = input.vpn?.warp;
  return compact([
    haveLinkData
      ? { label: 'Echte Link-Abbrüche (7 Tage)', value: String(faults7.length), status: faults7.length >= 3 ? 'bad' : faults7.length > 0 ? 'warn' : 'good' }
      : null,
    input.linkSpeed.currentMbps !== null
      ? {
          label: 'Link-Geschwindigkeit',
          value: fmtLinkSpeed(input.linkSpeed.currentMbps),
          status: wifiPrimary ? undefined : input.linkSpeed.currentMbps >= 1000 ? 'good' : 'warn',
        }
      : null,
    rs.total > 0
      ? {
          label: 'Verbindungsaufbauten unter 1 Gbit/s (30 Tage)',
          value: `${rs.below1g} von ${rs.total}`,
          status: rs.total >= 5 && rs.below1g / rs.total >= 0.2 ? 'bad' : rs.below1g > 0 ? 'warn' : 'good',
        }
      : null,
    haveLinkData ? { label: 'WLAN-Umschaltungen bei Abbrüchen (7 Tage)', value: String(failovers), status: failovers > 0 ? 'warn' : 'good' } : null,
    secondsKpi(input, 'link', 'LINK-Sekunden (PC-Kabel/WLAN-Umschaltung)'),
    retrans && retrans.avg !== null
      ? aux({ label: 'TCP-Neuübertragungen Ø', value: pct(retrans.avg), status: retrans.avg > 1 ? 'warn' : 'good' })
      : null,
    cpu && cpu.avg !== null
      ? aux({ label: 'CPU-Last Ø / max', value: `${pct(cpu.avg, 0)} / ${pct(cpu.max, 0)}`, status: cpu.avg > 80 ? 'warn' : undefined })
      : null,
    warp?.installed
      ? aux({
          label: 'Cloudflare WARP',
          value: `${warp.connected ? 'verbunden' : 'getrennt'}${warp.splitTunnel ? ` (Split-Tunnel „${warp.splitTunnel}“)` : ''}`,
          status: warp.connected && warp.splitTunnel === 'exclude' ? 'warn' : 'good',
        })
      : null,
  ]);
}

function lanKpis(input: DiagnosisInput): Kpi[] {
  const th = input.config.thresholds;
  const gw = gatewayTarget(input);
  const s = statsOf(input, gw?.id);
  const st = stableStatsOf(input, gw?.id);
  const gw6 = input.targets.find((t) => t.enabled && t.host === '$router6' && t.kind === 'icmp');
  return compact([
    latencyKpi('Router-Ping p50', s, th.latency.lan),
    st ? { label: 'Router-Ping p99 (stehender Link)', value: fmtMs(st.p99), status: rated(st, rateBelow(st.p99, 10, 20)) } : null,
    st ? { label: 'Verlust zum Router (stehender Link)', value: pct(st.lossPct), status: rated(st, rateBelow(st.lossPct, 0.1, 0.5)) } : null,
    latencyKpi('Router IPv6 (link-lokal) p50', statsOf(input, gw6?.id), th.latency.lan),
    secondsKpi(input, 'lan', 'LAN-Sekunden (Router-Ping gestört)'),
  ]);
}

function routerKpis(input: DiagnosisInput): Kpi[] {
  const band = input.config.thresholds.latency.router;
  const r = input.router;
  const tcp = input.targets.find((t) => t.enabled && t.host === '$gateway' && t.kind === 'tcp');
  const dns = input.targets.find((t) => t.enabled && t.host === '$gateway' && t.kind === 'udp-dns');
  const reboots = eventCount(input, 'router_reboot');
  const http = input.metrics['router.http_ms'];
  const online = r?.connectionStatus ? /online/i.test(r.connectionStatus) : null;
  return compact([
    r
      ? aux({
          label: 'Router-Status (letzte Abfrage)',
          value: `${r.reachable ? 'erreichbar' : 'nicht erreichbar'}${r.connectionStatus ? `, ${r.connectionStatus}` : ''}`,
          status: !r.reachable ? 'bad' : online === false ? 'bad' : 'good',
        })
      : null,
    latencyKpi('Weboberfläche (TCP-Aufbau) p95', statsOf(input, tcp?.id), band, 'p95'),
    latencyKpi('Router-DNS p50', statsOf(input, dns?.id), band),
    http && http.avg !== null ? { label: 'HTTP-Antwortzeit Ø', value: fmtMs(http.avg) } : null,
    r || reboots > 0 ? aux({ label: 'Neustarts im Zeitraum', value: String(reboots), status: reboots >= 2 ? 'bad' : reboots === 1 ? 'warn' : 'good' }) : null,
    r?.uptimeSec != null ? { label: 'Laufzeit', value: `${Math.floor(r.uptimeSec / 86_400)} T ${Math.floor((r.uptimeSec % 86_400) / 3600)} h` } : null,
    r?.firmware ? { label: 'Firmware', value: r.firmware } : null,
  ]);
}

function docsisKpis(input: DiagnosisInput): Kpi[] {
  const th = input.config.thresholds;
  const cmts = statsOf(input, cmtsTarget(input)?.id);
  const d = input.docsis;
  const logs = eventsOf(input, 'router_log');
  const t3 = logs.filter((e) => lineLogKind(e) === 'T3').map((e) => e.ts).sort((a, b) => a - b);
  const severe = logs.filter(isSevereLineEntry).length;
  const t3Cluster = maxInWindow(t3, 10 * MINUTE).count;
  const snr = input.metrics['docsis.ds.snr_min'];
  const usMax = input.metrics['docsis.us.power_max'];
  const ratingLabel: Record<Health, string> = { good: 'gut', warn: 'grenzwertig', bad: 'kritisch', unknown: 'unbekannt' };
  return compact([
    latencyKpi('Kopfstation (CMTS) p50', cmts, th.latency.docsis),
    cmts ? { label: 'Kopfstation p99', value: fmtMs(cmts.p99) } : null,
    d
      ? { label: 'DOCSIS-Werte (letzte Abfrage)', value: ratingLabel[d.rating], status: d.rating }
      : { label: 'DOCSIS-Werte', value: 'nicht verfügbar (Router-Login nötig)', status: 'unknown' },
    snr?.last != null ? { label: 'Downstream-SNR min', value: fmtDb(snr.last) } : null,
    usMax?.last != null ? { label: 'Upstream-Sendepegel max', value: fmtDb(usMax.last, 'dBmV') } : null,
    logs.length > 0 || d
      ? {
          label: 'T3/T4-Timeouts & Sync-Verluste',
          value: `${t3.length} T3${severe > 0 ? `, ${severe} schwere` : ''}`,
          status: severe > 0 || t3Cluster >= 3 ? 'bad' : t3.length > 0 ? 'warn' : 'good',
        }
      : null,
    secondsKpi(input, 'access', 'ACCESS-Sekunden (Kabelnetz gestört)'),
  ]);
}

function aftrKpis(input: DiagnosisInput): Kpi[] {
  const th = input.config.thresholds;
  const aftr = statsOf(input, aftrTarget(input)?.id);
  const v4 = statsOf(input, '@internet4');
  const v6 = statsOf(input, '@internet6');
  const p95Diff = v4?.p95 != null && v6?.p95 != null ? v4.p95 - v6.p95 : null;
  const lossDiff = v4?.lossPct != null && v6?.lossPct != null ? v4.lossPct - v6.lossPct : null;
  const nat4 = input.nat.find((n) => n.family === 4);
  const natLabel: Record<string, string> = {
    'endpoint-independent': 'endpunktunabhängig (günstig)',
    'endpoint-dependent': 'endpunktabhängig (strikt)',
    blocked: 'blockiert',
    unknown: 'unbekannt',
  };
  return compact([
    latencyKpi('DS-Lite-Gateway (AFTR) p50', aftr, th.latency.aftr),
    p95Diff !== null
      ? { label: 'IPv4 − IPv6 (p95)', value: `${p95Diff >= 0 ? '+' : '−'}${fmtMs(Math.abs(p95Diff))}`, status: ratedPair(input, v4, v6, rateBelow(p95Diff, 10, 30)) }
      : null,
    lossDiff !== null
      ? { label: 'IPv4 − IPv6 (Verlust)', value: `${lossDiff >= 0 ? '+' : '−'}${pct(Math.abs(lossDiff))}`, status: ratedPair(input, v4, v6, rateBelow(lossDiff, 0.5, 1)) }
      : null,
    secondsKpi(input, 'aftr', 'AFTR-Sekunden (nur IPv4 gestört)'),
    input.router?.dsLite != null ? { label: 'DS-Lite', value: input.router.dsLite ? 'aktiv' : 'nein (Dual-Stack)' } : null,
    nat4
      ? aux({
          label: 'NAT-Verhalten (IPv4)',
          value: natLabel[nat4.mapping] ?? nat4.mapping,
          status: nat4.mapping === 'endpoint-independent' ? 'good' : nat4.mapping === 'unknown' ? undefined : 'warn',
        })
      : null,
  ]);
}

function ispKpis(input: DiagnosisInput): Kpi[] {
  const th = input.config.thresholds;
  const isp4 = statsOf(input, isp4Target(input)?.id);
  const mtu4 = input.mtu.find((m) => m.family === 4)?.mtu ?? null;
  return compact([
    latencyKpi('Vodafone-Backbone (1. IPv4-Hop) p50', isp4, th.latency.isp),
    secondsKpi(input, 'backbone', 'BACKBONE-Sekunden (Vodafone-Netz gestört)'),
    input.traceroutes.count > 0 ? { label: 'Routenwechsel im Zeitraum', value: String(input.traceroutes.changed) } : null,
    mtu4 !== null ? aux({ label: 'Pfad-MTU IPv4', value: `${fmtNumber(mtu4)} Byte`, status: mtu4 >= 1460 ? 'good' : 'warn' }) : null,
  ]);
}

function internetKpis(input: DiagnosisInput): Kpi[] {
  const th = input.config.thresholds;
  const s = statsOf(input, '@internet');
  const members = internetMembers(input);
  const tail = s && s.p99 !== null && s.p50 !== null ? s.p99 - s.p50 : null;
  const loss = internetWideLossPct(input);
  const hours = coveredHours(input);
  const perTargetLag = segmentTargets(input, 'internet', 'icmp')
    .map((t) => statsOf(input, t.id))
    .filter((x): x is StatsSummary => x !== null)
    .map((x) => x.over200);
  const lagPerHour = hours >= 1 && perTargetLag.length > 0 ? (median(perTargetLag) ?? 0) / hours : null;
  const outages = eventCount(input, 'outage');
  const outagesPerDay = hours >= 1 ? outages / (hours / 24) : null;
  const burst = input.metrics['udp.burst.cf4-udp.loss_pct'];
  return compact([
    latencyKpi('Latenz p50', s, th.latency.internet, 'p50', members),
    s ? { label: 'Jitter', value: fmtMs(s.jitter), status: rated(s, rateBand(s.jitter, th.jitter), members) } : null,
    tail !== null ? { label: 'Spitzen (p99 − p50)', value: fmtMs(tail), status: rated(s, rateBand(tail, th.tail), members) } : null,
    loss !== null
      ? { label: 'Paketverlust (Internet-weit)', value: pct(loss), status: internetWideLossPct(input, undefined, 3600) !== null ? rateBand(loss, th.loss) : undefined }
      : null,
    lagPerHour !== null ? { label: 'Lag-Spitzen ≥ 200 ms pro Stunde', value: fmtNumber(lagPerHour, lagPerHour < 10 ? 1 : 0), status: rateBand(lagPerHour, th.lagPerHour) } : null,
    outagesPerDay !== null
      ? { label: 'Ausfälle (≥ 3 s) pro Tag', value: fmtNumber(outagesPerDay, outagesPerDay < 10 ? 2 : 0), status: rateBand(outagesPerDay, th.outagesPerDay) }
      : null,
    burst && burst.avg !== null ? aux({ label: 'UDP-Burst-Verlust Ø (spieltypische Paketrate)', value: pct(burst.avg), status: rateBelow(burst.avg, 0.1, 1) }) : null,
  ]);
}

function gameKpis(input: DiagnosisInput): Kpi[] {
  const band = input.config.thresholds.latency.game;
  const list: (Kpi | null)[] = segmentTargets(input, 'game').map((t) => {
    const s = statsOf(input, t.id);
    if (!s) return null;
    const lossBad = (s.lossPct ?? 0) >= 1;
    return {
      label: `${t.name} p50`,
      value: `${fmtMs(s.p50)}${(s.lossPct ?? 0) > 0 ? `, Verlust ${pct(s.lossPct)}` : ''}`,
      status: rated(s, worstHealth([rateBand(s.p50, band), lossBad ? 'bad' : undefined])),
    };
  });
  list.push(secondsKpi(input, 'remote', 'REMOTE-Sekunden (nur Spieleserver gestört)'));
  return compact(list);
}

const KPI_BUILDERS: Readonly<Record<Segment, (input: DiagnosisInput) => Kpi[]>> = {
  client: clientKpis,
  lan: lanKpis,
  router: routerKpis,
  docsis: docsisKpis,
  aftr: aftrKpis,
  isp: ispKpis,
  internet: internetKpis,
  game: gameKpis,
};

const FINDING_HEALTH: Readonly<Record<Finding['severity'], Health | undefined>> = { critical: 'bad', warn: 'warn', info: undefined };

const GOOD_SUMMARY: Readonly<Record<Segment, string>> = {
  client: 'Netzwerkkarte und Verbindung des PCs unauffällig.',
  lan: 'Strecke PC ⇄ Router unauffällig.',
  router: 'Router stabil und erreichbar.',
  docsis: 'Kabelstrecke bis zur Kopfstation unauffällig.',
  aftr: 'IPv4 über DS-Lite verhält sich wie IPv6.',
  isp: 'Vodafone-Netz unauffällig.',
  internet: 'Verbindung ins Internet unauffällig.',
  game: 'Weg zu den Spiele-Rechenzentren unauffällig.',
};

function segmentSummary(segment: Segment, status: Health, kpis: Kpi[], findings: Finding[]): string {
  const top = findings.filter((f) => f.severity !== 'info').sort((a, b) => b.score - a.score)[0];
  if (top) return top.title;
  if (kpis.length === 0) return 'Keine Messdaten für diesen Abschnitt.';
  if (status === 'unknown') return 'Noch zu wenige Messdaten für eine Bewertung.';
  if (status === 'good') return GOOD_SUMMARY[segment];
  const worst = kpis.find((k) => k.status === status) ?? kpis[0];
  return `${worst.label}: ${worst.value}`;
}

/** SegmentHealth for all eight segments in path order. */
export function buildSegments(input: DiagnosisInput, findings: readonly Finding[]): SegmentHealth[] {
  return SEGMENTS.map((segment) => {
    const kpis = KPI_BUILDERS[segment](input);
    const own = findings.filter((f) => f.segment === segment && f.id !== 'data-quality');
    let status = worstHealth([...kpis.map((k) => k.status), ...own.map((f) => FINDING_HEALTH[f.severity])]);
    const coreRated = kpis.some((k) => !AUXILIARY.has(k) && k.status !== undefined && k.status !== 'unknown');
    if (status === 'good' && !coreRated) status = 'unknown';
    return { segment, status, label: SEGMENT_LABELS[segment], summary: segmentSummary(segment, status, kpis, own), kpis };
  });
}
