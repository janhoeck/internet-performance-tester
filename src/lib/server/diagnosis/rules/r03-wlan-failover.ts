// R03 wlan-failover: Windows connects WLAN within 5 s at ≥ 50 % of the genuine link drops, or the
// egress interface switched to WLAN repeatedly (docs/research/critique.md §5.3 R03).
import type { Finding, FindingEvidence, NetEvent } from '../../../shared/types';
import { isFaultDrop } from '../links';
import { fmtShare } from '../text';
import { DAY } from '../time';
import type { DiagnosisInput } from '../types';
import { eventIds, eventsOf, findingScore, isRecord, segmentImpact } from '../util';

export const WLAN_FAILOVER = 'wlan-failover';

const WLAN_RE = /wlan|wi-?fi|wireless|drahtlos/i;

/** route_switch event that moved traffic onto the WLAN adapter */
export function isSwitchToWlan(e: NetEvent): boolean {
  if (e.type !== 'route_switch') return false;
  if (isRecord(e.details)) {
    for (const key of ['to', 'toIf', 'ifAlias', 'interface', 'egress', 'v4If', 'newIf']) {
      const v = e.details[key];
      if (typeof v === 'string' && WLAN_RE.test(v)) return true;
    }
    if (e.details.isWifi === true || e.details.toWifi === true) return true;
  }
  return / → .*(wlan|wi-?fi)|auf wlan|zu wlan/i.test(e.title);
}

/** the adapter module reports one route_switch per address family – events within 30 s are one switch */
const SAME_SWITCH_MS = 30_000;

/** switches of the internet traffic onto the WLAN adapter (IPv4/IPv6 events of one switch merged) */
export function wlanSwitches(input: DiagnosisInput): NetEvent[] {
  const list = eventsOf(input, 'route_switch').filter(isSwitchToWlan).sort((a, b) => a.ts - b.ts);
  const out: NetEvent[] = [];
  for (const e of list) if (out.length === 0 || e.ts - out[out.length - 1].ts > SAME_SWITCH_MS) out.push(e);
  return out;
}

export function wlanFailover(input: DiagnosisInput): Finding | null {
  const windowStart = Math.min(input.from, input.to - 7 * DAY);
  const faults = input.linkDrops.filter((d) => isFaultDrop(d) && d.ts >= windowStart && d.ts < input.to);
  const known = faults.filter((d) => d.wlanFailover !== null);
  const withFailover = known.filter((d) => d.wlanFailover === true);
  const switches = wlanSwitches(input);
  const byDrops = known.length >= 2 && withFailover.length / known.length >= 0.5;
  const bySwitches = switches.length >= 2;
  if (!byDrops && !bySwitches) return null;

  const confidence = known.length >= 3 && byDrops ? 'high' : 'medium';
  const parts: string[] = [];
  if (byDrops) parts.push(`Bei ${withFailover.length} von ${known.length} Abbrüchen hat Windows innerhalb von 5 s auf WLAN umgeschaltet und später zurück.`);
  else parts.push(`Windows hat im Zeitraum ${switches.length}-mal den Internetverkehr auf das WLAN umgeleitet.`);
  parts.push('Jede Umschaltung ändert die IP-Adresse des PCs (bei DS-Lite auch die öffentliche IPv4-Zuordnung) – Spielverbindungen brechen ab, auch wenn der Ping kaum Verluste zeigt.');

  const evidence: FindingEvidence[] = [];
  if (known.length > 0) evidence.push({ label: 'Abbrüche mit WLAN-Umschaltung', value: `${withFailover.length} von ${known.length} (${fmtShare(withFailover.length / known.length)})` });
  if (switches.length > 0) evidence.push({ label: 'Schnittstellenwechsel aufs WLAN', value: String(switches.length), ts: switches[switches.length - 1].ts });
  if (input.wlan?.ssid) evidence.push({ label: 'WLAN-Netz', value: input.wlan.ssid });
  for (const d of withFailover.slice(-3).reverse()) evidence.push({ label: 'Umschaltung nach Abbruch', value: 'WLAN innerhalb von 5 s verbunden', ts: d.ts, tsEnd: d.endTs ?? undefined });

  return {
    id: WLAN_FAILOVER,
    severity: 'warn',
    confidence,
    segment: 'client',
    title: 'Windows wechselt bei Abbrüchen aufs WLAN – Spielverbindungen brechen trotzdem ab',
    summary: parts.join(' '),
    evidence,
    recommendations: [
      'Ursache beheben: das Kabelproblem (siehe „Netzwerkverbindung am PC bricht ab“).',
      'Optional das WLAN-Profil auf diesem PC auf „Manuell verbinden“ stellen – dann sind Kabelabbrüche allerdings komplette Ausfälle.',
    ],
    score: findingScore('warn', confidence, 0.5 * segmentImpact(input, 'client')),
    relatedEventIds: [
      ...withFailover.map((d) => d.id).filter((id): id is number => id !== null),
      ...eventIds(switches),
    ].slice(0, 50),
  };
}
