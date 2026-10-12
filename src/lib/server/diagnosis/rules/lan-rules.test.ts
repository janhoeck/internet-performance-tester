import { describe, expect, it } from 'vitest';
import type { SpeedtestResult } from '../../../shared/types';
import { T_END, drop, ev, healthyInput, secondsTotals, stats, withEvents } from '../test-utils';
import { DAY, HOUR } from '../time';
import { bufferbloatLoad, evaluateSpeedtest } from './r04-bufferbloat-load';
import { lanQuality } from './r05-lan-quality';
import { lanUnreachable } from './r06-lan-unreachable';
import { householdLoad } from './r08-household-load';
import { identityChange, identityKind } from './r13-identity-change';
import { routerInstability } from './r20-router-instability';

const healthy = healthyInput();

function speedtest(p: Partial<SpeedtestResult> = {}): SpeedtestResult {
  const ts = p.ts ?? T_END - DAY;
  return {
    id: 1, ts, endTs: ts + 45_000, trigger: 'schedule', server: 'Cloudflare DUS', downMbps: 480, upMbps: 45,
    idleLatencyMs: 18, idleJitterMs: 2, loadedDownLatencyMs: 25, loadedDownP95Ms: 30, loadedUpLatencyMs: 24, loadedUpP95Ms: 28,
    bloatDownMs: 7, bloatUpMs: 6, grade: 'A', bytesDown: 0, bytesUp: 0, streams: 6, nicLinkMbps: 1000, error: null, series: [],
    ...p,
  };
}

describe('R04 bufferbloat-load', () => {
  it('evaluates the p95 rise under load against idle', () => {
    const e = evaluateSpeedtest(speedtest({ loadedDownP95Ms: 140, loadedUpP95Ms: 60, grade: 'C' }));
    expect(e.down).toBe(122);
    expect(e.up).toBe(42);
    expect(e.bad).toBe(true);
    expect(e.severe).toBe(false);
  });

  it('flags bloat in most speed tests (WAN queue → router segment)', () => {
    const tests = [1, 2, 3].map((i) => speedtest({ id: i, ts: T_END - i * 3 * HOUR, loadedDownP95Ms: 150, grade: 'C' }));
    const f = bufferbloatLoad(healthyInput({ speedtests: tests }));
    expect(f!.title).toBe('Lags unter Last (Bufferbloat)');
    expect(f!.segment).toBe('router');
    expect(f!.confidence).toBe('high');
    expect(f!.severity).toBe('warn');
  });

  it('switches to the LAN variant when the router ping rises (100-Mbit/s link)', () => {
    const tests = [1, 2].map((i) => speedtest({ id: i, ts: T_END - i * 3 * HOUR, loadedDownP95Ms: 420, grade: 'F', nicLinkMbps: 100 }));
    const input = healthyInput({ speedtests: tests, loadStats: { gw: stats({ p50: 30, p95: 80 }) } });
    const f = bufferbloatLoad(input)!;
    expect(f.segment).toBe('lan');
    expect(f.severity).toBe('critical');
    expect(f.summary).toContain('100 Mbit/s-Link');
  });

  it('stays silent for good grades or a minority of bad tests', () => {
    expect(bufferbloatLoad(healthyInput({ speedtests: [speedtest(), speedtest({ id: 2 })] }))).toBeNull();
    const mixed = [speedtest({ id: 1, grade: 'D', loadedDownP95Ms: 300 }), speedtest({ id: 2 }), speedtest({ id: 3 })];
    expect(bufferbloatLoad(healthyInput({ speedtests: mixed }))).toBeNull();
    expect(bufferbloatLoad(healthy)).toBeNull();
  });
});

describe('R05 lan-quality', () => {
  it('flags loss to the router while the link is up', () => {
    const gw = stats({ p50: 1, p99: 4, sent: 86_400, lost: 864 });
    const f = lanQuality(healthyInput({ statsStable: { ...healthy.statsStable, gw } }))!;
    expect(f.title).toBe('Problem zwischen PC und Router');
    expect(f.severity).toBe('warn');
    expect(f.confidence).toBe('high');
    expect(f.summary).toContain('192.168.0.1');
  });

  it('flags hours with ≥ 0.5 % loss', () => {
    const lanHours = Array.from({ length: 24 }, (_, i) => ({
      ts: T_END - (24 - i) * HOUR, sent: 3600, lost: i % 8 === 0 ? 40 : 0, lossPct: i % 8 === 0 ? 1.1 : 0, p99: 3,
    }));
    const f = lanQuality(healthyInput({ lanHours }))!;
    expect(f.evidence.find((e) => e.label === 'Stunden mit ≥ 0,5 % Verlust')?.value).toBe('3 von 24');
  });

  it('treats router-only latency as a control-plane hint (info)', () => {
    const gw = stats({ p50: 1, p99: 45, sent: 86_400 });
    const f = lanQuality(healthyInput({ statsStable: { ...healthy.statsStable, gw } }))!;
    expect(f.severity).toBe('info');
    expect(f.title).toBe('Router antwortet verzögert (Control-Plane)');
  });

  it('stays silent for a clean LAN', () => {
    expect(lanQuality(healthy)).toBeNull();
  });
});

describe('R06 lan-unreachable', () => {
  const outage = (ts: number, durationMs: number, classification = 'lan') =>
    ev('outage', ts, { severity: 'critical', details: { classification, durationMs }, endTs: ts + durationMs });

  it('reports the router being unreachable for ≥ 30 s with the link up', () => {
    const f = lanUnreachable(withEvents(healthy, [outage(T_END - DAY, 45_000)]))!;
    expect(f.title).toBe('Router reagiert nicht');
    expect(f.segment).toBe('router');
    expect(f.severity).toBe('warn');
    expect(f.confidence).toBe('medium');
  });

  it('is critical for repeated outages and confirmed by router reboots', () => {
    const input = withEvents(healthy, [
      outage(T_END - 3 * DAY, 240_000),
      outage(T_END - 2 * DAY, 35_000),
      outage(T_END - DAY, 40_000),
      ev('router_reboot', T_END - 3 * DAY + 60_000, { source: 'router' }),
    ]);
    const f = lanUnreachable(input)!;
    expect(f.severity).toBe('critical');
    expect(f.confidence).toBe('high');
  });

  it('ignores outages during a NIC link drop, short ones and other classes', () => {
    const t = T_END - DAY;
    expect(lanUnreachable(withEvents(healthyInput({ linkDrops: [drop(t - 2000)] }), [outage(t, 45_000)]))).toBeNull();
    expect(lanUnreachable(withEvents(healthy, [outage(t, 10_000)]))).toBeNull();
    expect(lanUnreachable(withEvents(healthy, [outage(t, 60_000, 'docsis')]))).toBeNull();
  });
});

describe('R08 household-load', () => {
  it('flags errored seconds that cluster in minutes with own high load', () => {
    const f = householdLoad(
      healthyInput({ loadCorrelation: { loadMinutes: 120, esLoad: 300, coveredLoad: 7200, esIdle: 100, coveredIdle: 200_000 } }),
    )!;
    expect(f.title).toBe('Andere Geräte/Downloads verursachen Lags');
    expect(f.confidence).toBe('high');
    expect(f.summary).toContain('75 %');
  });

  it('stays silent without a correlation', () => {
    expect(householdLoad(healthyInput({ loadCorrelation: { loadMinutes: 50, esLoad: 20, coveredLoad: 3000, esIdle: 500, coveredIdle: 200_000 } }))).toBeNull();
    expect(householdLoad(healthyInput({ loadCorrelation: { loadMinutes: 50, esLoad: 40, coveredLoad: 3000, esIdle: 2000, coveredIdle: 150_000 } }))).toBeNull();
    expect(householdLoad(healthy)).toBeNull();
  });
});

describe('R13 identity-change', () => {
  it('classifies identity events', () => {
    expect(identityKind(ev('identity_change', 0, { title: 'IP-Adresskonflikt (Tcpip 4199)', severity: 'critical' }))).toBe('conflict');
    expect(identityKind(ev('identity_change', 0, { title: 'Netzwerk geändert', details: { kind: 'gatewayMac' } }))).toBe('gateway_mac');
    expect(identityKind(ev('identity_change', 0, { title: 'DHCP-Server geändert' }))).toBe('dhcp');
    expect(identityKind(ev('identity_change', 0, { title: 'IPv6-Präfix geändert' }))).toBe('prefix');
    expect(identityKind(ev('identity_change', 0, { title: 'DNS-Server geändert' }))).toBe('dns');
    expect(identityKind(ev('ip_change', 0, { title: 'Öffentliche IPv4 geändert' }))).toBe('public_ip');
  });

  it('is critical for an address conflict', () => {
    const f = identityChange(withEvents(healthy, [ev('identity_change', T_END - DAY, { title: 'IP-Adresskonflikt (Tcpip 4199)', severity: 'critical' })]))!;
    expect(f.severity).toBe('critical');
    expect(f.title).toBe('IP-Adresskonflikt erkannt');
    expect(f.segment).toBe('lan');
  });

  it('warns about a changed router MAC and informs about public IP changes', () => {
    const mac = identityChange(withEvents(healthy, [ev('identity_change', T_END - DAY, { title: 'Gateway-MAC geändert' })]))!;
    expect(mac.severity).toBe('warn');
    expect(mac.title).toBe('Ein anderes Gerät antwortet als Router (MAC geändert)');
    const ip = identityChange(withEvents(healthy, [ev('ip_change', T_END - DAY, { title: 'Öffentliche IPv4 geändert', severity: 'info' })]))!;
    expect(ip.severity).toBe('info');
    expect(ip.segment).toBe('isp');
  });

  it('stays silent without identity events', () => {
    expect(identityChange(healthy)).toBeNull();
  });
});

describe('R20 router-instability', () => {
  it('is critical for two reboots on one day', () => {
    const input = withEvents(healthy, [
      ev('router_reboot', T_END - 3 * HOUR, { source: 'router', title: 'Router neu gestartet' }),
      ev('router_reboot', T_END - HOUR, { source: 'router', title: 'Router neu gestartet' }),
    ]);
    const f = routerInstability(input)!;
    expect(f.severity).toBe('critical');
    expect(f.confidence).toBe('high');
    expect(f.title).toBe('Router instabil (Neustarts/Ausfälle)');
  });

  it('uses suspected reboots from the event-log classification', () => {
    const f = routerInstability(healthyInput({ linkDrops: [drop(T_END - DAY, 'router_reboot')] }))!;
    expect(f.severity).toBe('warn');
    expect(f.confidence).toBe('medium');
    expect(f.summary).toContain('vermuteten Router-Neustart');
  });

  it('counts several link drops of one router reboot as one incident (08.10. 18:29–18:31)', () => {
    const t = T_END - DAY;
    const drops = [0, 57_000, 110_000].map((d) => drop(t + d, 'router_reboot'));
    const input = withEvents(healthyInput({ linkDrops: drops }), [ev('router_offline', t + 20_000, { source: 'router', endTs: t + 240_000 })]);
    const f = routerInstability(input)!;
    expect(f.severity).toBe('warn');
    expect(f.summary).toContain('einen vermuteten Router-Neustart');
    expect(f.evidence.filter((e) => e.label.startsWith('vermuteter Neustart'))).toHaveLength(1);
  });

  it('reports a slow web UI as info', () => {
    const f = routerInstability(healthyInput({ stats: { ...healthy.stats, 'gw-tcp': stats({ p50: 30, p95: 120, sent: 25_000 }) } }))!;
    expect(f.severity).toBe('info');
    expect(f.title).toBe('Router antwortet langsam');
  });

  it('stays silent for a stable router', () => {
    expect(routerInstability(healthy)).toBeNull();
    expect(routerInstability(healthyInput({ seconds: secondsTotals({ lan: 50 }) }))).toBeNull();
  });
});
