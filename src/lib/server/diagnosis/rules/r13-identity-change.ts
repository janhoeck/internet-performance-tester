// R13 identity-change: IP address conflict (Tcpip 4199) → critical; gateway MAC or DHCP server
// changed → warn ("Fremdes/zweites Gerät im Netz"); IPv6 prefix, DNS servers or public IPv4
// (Carrier-NAT) changed → info (critique.md R13, MESSPLAN R13).
import { fmtDateTime } from '../../../shared/format';
import type { Finding, FindingEvidence, NetEvent, Segment, Severity } from '../../../shared/types';
import type { DiagnosisInput } from '../types';
import { eventIds, eventsOf, findingScore, isRecord } from '../util';

export const IDENTITY_CHANGE = 'identity-change';

export type IdentityKind = 'conflict' | 'gateway_mac' | 'dhcp' | 'dns' | 'prefix' | 'public_ip' | 'other';

const KIND_SEVERITY: Readonly<Record<IdentityKind, Severity>> = {
  conflict: 'critical',
  gateway_mac: 'warn',
  dhcp: 'warn',
  dns: 'info',
  prefix: 'info',
  public_ip: 'info',
  other: 'info',
};

const KIND_LABEL: Readonly<Record<IdentityKind, string>> = {
  conflict: 'IP-Adresskonflikt',
  gateway_mac: 'Router-MAC-Adresse geändert',
  dhcp: 'DHCP-Server geändert',
  dns: 'DNS-Server geändert',
  prefix: 'IPv6-Präfix geändert',
  public_ip: 'Öffentliche IP-Adresse / AFTR geändert',
  other: 'Netzwerk-Identität geändert',
};

function textOf(e: NetEvent): string {
  const parts = [e.title];
  if (isRecord(e.details)) {
    for (const key of ['kind', 'field', 'what', 'change', 'changed', 'reason', 'type']) {
      const v = e.details[key];
      if (typeof v === 'string') parts.push(v);
      else if (Array.isArray(v)) parts.push(v.filter((x): x is string => typeof x === 'string').join(' '));
    }
  }
  return parts.join(' ').toLowerCase();
}

export function identityKind(e: NetEvent): IdentityKind {
  if (e.type === 'ip_change' || e.type === 'nat_change') {
    return /präfix|prefix/.test(textOf(e)) ? 'prefix' : 'public_ip';
  }
  const t = textOf(e);
  if (/konflikt|conflict|4199|duplicate/.test(t)) return 'conflict';
  if (/gateway.?mac|router.?mac|gatewaymac|\bmac\b/.test(t)) return 'gateway_mac';
  if (/dhcp/.test(t)) return 'dhcp';
  if (/präfix|prefix/.test(t)) return 'prefix';
  if (/dns/.test(t)) return 'dns';
  return e.severity === 'critical' ? 'conflict' : 'other';
}

const RANK: Readonly<Record<Severity, number>> = { info: 0, warn: 1, critical: 2 };

export function identityChange(input: DiagnosisInput): Finding | null {
  const events = [...eventsOf(input, 'identity_change'), ...eventsOf(input, 'ip_change'), ...eventsOf(input, 'nat_change')].sort(
    (a, b) => a.ts - b.ts,
  );
  if (events.length === 0) return null;
  const items = events.map((e) => ({ e, kind: identityKind(e) }));
  const severity = items.reduce<Severity>((s, i) => (RANK[KIND_SEVERITY[i.kind]] > RANK[s] ? KIND_SEVERITY[i.kind] : s), 'info');
  const count = (k: IdentityKind) => items.filter((i) => i.kind === k).length;

  let title: string;
  let summary: string;
  let segment: Segment;
  if (count('conflict') > 0) {
    title = 'IP-Adresskonflikt erkannt';
    summary = `Windows hat ${count('conflict')}-mal gemeldet, dass ein anderes Gerät dieselbe IP-Adresse verwendet. Dabei bricht die Verbindung des PCs ab.`;
    segment = 'lan';
  } else if (count('gateway_mac') > 0 || count('dhcp') > 0) {
    title = count('gateway_mac') > 0 ? 'Ein anderes Gerät antwortet als Router (MAC geändert)' : 'Fremdes/zweites Gerät im Netz (DHCP-Server geändert)';
    summary =
      'Die Hardware-Adresse des Routers bzw. der DHCP-Server im Heimnetz hat gewechselt. Das deutet auf ein zweites Gerät hin, ' +
      'das sich als Router ausgibt oder Adressen verteilt (z. B. alte EasyBox, Repeater oder zweiter Router).';
    segment = 'lan';
  } else {
    title = 'IPv6-Präfix bzw. öffentliche IPv4 (Carrier-NAT) hat gewechselt';
    summary = `Die öffentliche Adresse des Anschlusses hat sich im Zeitraum ${events.length}-mal geändert. Laufende Verbindungen (auch Spiele) brechen dabei ab.`;
    segment = 'isp';
  }

  const evidence: FindingEvidence[] = items
    .slice(-6)
    .reverse()
    .map(({ e, kind }) => ({ label: KIND_LABEL[kind], value: `${e.title} (${fmtDateTime(e.ts)})`, ts: e.ts }));

  const recommendations =
    severity === 'info'
      ? ['Häufen sich die Wechsel, den Router-Neustartgrund prüfen und Vodafone informieren (Zwangstrennung/AFTR-Wechsel).']
      : [
          'Zweiten Router, alte EasyBox oder Repeater im Netz suchen und dessen DHCP-Server abschalten.',
          'Feste IP-Adressen im Heimnetz prüfen: keine Adresse doppelt vergeben.',
        ];
  const confidence = severity === 'info' ? 'medium' : 'high';
  return {
    id: IDENTITY_CHANGE,
    severity,
    confidence,
    segment,
    title,
    summary,
    evidence,
    recommendations,
    score: findingScore(severity, confidence, 0, Math.min(5, events.length)),
    relatedEventIds: eventIds(events),
  };
}
