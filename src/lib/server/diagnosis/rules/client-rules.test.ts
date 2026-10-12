import { describe, expect, it } from 'vitest';
import type { VpnInfo } from '../../../shared/types';
import { T_END, drop, ev, healthyInput, hourlySeconds, secondsTotals, stats, withEvents } from '../test-utils';
import { DAY, HOUR, MINUTE } from '../time';
import type { DiagnosisInput } from '../types';
import { nicLinkFlaps } from './r01-nic-link-flaps';
import { nic100m } from './r02-nic-100m';
import { wlanFailover, wlanSwitches } from './r03-wlan-failover';
import { afterChange, quoteDe } from './r14-after-change';
import { compareVpn, vpnActive } from './r15-vpn-active';
import { dataQuality, dataQualityIssues, setupHints } from './r16-data-quality';
import { esAutocorrelation, mergeSpikeTimes, periodicSpikes } from './r19-periodic-spikes';

const healthy = healthyInput();

describe('R01 nic-link-flaps', () => {
  it('stays silent for a healthy line, 2 drops or boot renegotiations', () => {
    expect(nicLinkFlaps(healthy)).toBeNull();
    expect(nicLinkFlaps(healthyInput({ linkDrops: [drop(T_END - DAY), drop(T_END - 2 * DAY)] }))).toBeNull();
    const boots = Array.from({ length: 6 }, (_, i) => drop(T_END - i * HOUR, 'boot'));
    expect(nicLinkFlaps(healthyInput({ linkDrops: boots }))).toBeNull();
  });

  it('raises a warning for ≥ 3 genuine drops within 7 days', () => {
    const f = nicLinkFlaps(healthyInput({ linkDrops: [drop(T_END - 6 * DAY), drop(T_END - 3 * DAY), drop(T_END - DAY)] }));
    expect(f).not.toBeNull();
    expect(f!.severity).toBe('warn');
    expect(f!.confidence).toBe('high');
    expect(f!.segment).toBe('client');
    expect(f!.title).toBe('Netzwerkverbindung am PC bricht ab');
    expect(f!.evidence.find((e) => e.label === 'Echte Abbrüche (letzte 7 Tage)')?.value).toBe('3');
    expect(f!.recommendations[0]).toMatch(/Cat-6/);
  });

  it('is critical for a cluster of ≥ 5 drops in 30 min (like 08.10. 18:29–18:43)', () => {
    const cluster = Array.from({ length: 8 }, (_, i) => drop(T_END - 2 * HOUR + i * 2 * MINUTE, 'runtime', { downtimeMs: 3000 + i * 2000 }));
    const f = nicLinkFlaps(healthyInput({ linkDrops: [...cluster, drop(T_END - 3 * DAY, 'boot')] }));
    expect(f!.severity).toBe('critical');
    expect(f!.summary).toContain('8-mal');
    expect(f!.summary).toMatch(/je 3–17 s/);
    expect(f!.evidence.some((e) => e.label.startsWith('Neuverbindungen nach Start/Standby'))).toBe(true);
  });

  it('counts unclassified drops but with medium confidence', () => {
    const f = nicLinkFlaps(healthyInput({ linkDrops: [1, 2, 3].map((i) => drop(T_END - i * DAY, 'unknown')) }));
    expect(f!.confidence).toBe('medium');
  });

  it('ranks higher when LINK seconds explain the bad seconds', () => {
    const drops = [1, 2, 3].map((i) => drop(T_END - i * DAY));
    const low = nicLinkFlaps(healthyInput({ linkDrops: drops }))!;
    const high = nicLinkFlaps(healthyInput({ linkDrops: drops, seconds: secondsTotals({ link: 900, unknown: 100 }) }))!;
    expect(high.score).toBeGreaterThan(low.score);
  });
});

describe('R02 nic-100m', () => {
  const relinks = (speeds: number[]) => speeds.map((s, i) => drop(T_END - (speeds.length - i) * DAY, 'boot', { relinkMbps: s }));

  it('flags ≥ 20 % sub-gigabit relinks (≥ 5 cases)', () => {
    const f = nic100m(healthyInput({ linkDrops: relinks([1000, 100, 1000, 100, 1000, 1000, 100, 1000, 1000, 1000]) }));
    expect(f).not.toBeNull();
    expect(f!.title).toBe('Kabel/Port schafft kein Gigabit');
    expect(f!.confidence).toBe('high');
    expect(f!.severity).toBe('warn'); // tariff unknown
    expect(f!.summary).toContain('3 der letzten 10');
  });

  it('ignores a low share and a proven fix (≥ 10 gigabit relinks in a row)', () => {
    expect(nic100m(healthyInput({ linkDrops: relinks([100, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000]) }))).toBeNull();
    expect(nic100m(healthyInput({ linkDrops: relinks([100, 100, 100, ...Array<number>(11).fill(1000)]) }))).toBeNull();
    expect(nic100m(healthy)).toBeNull();
  });

  it('flags > 10 min at 100 Mbit/s and becomes critical with a faster tariff', () => {
    const input = healthyInput({
      linkSpeed: { currentMbps: 100, currentTs: T_END - MINUTE, msBelow1g: 3 * HOUR, msObserved: 3 * DAY, minMbps: 100 },
    });
    input.config.tariff.downMbps = 250;
    const f = nic100m(input);
    expect(f!.severity).toBe('critical');
    expect(f!.summary).toContain('Dein Tarif');
    expect(f!.recommendations.some((r) => r.includes('Bundesnetzagentur'))).toBe(true);
  });

  it('uses the router view of the port speed', () => {
    const router = (speed: string): DiagnosisInput['router'] => ({
      ts: T_END, ip: '192.168.0.1', reachable: true, httpMs: 80, adapter: 'arris-vodafone-station', vendor: 'ARRIS', model: 'TG6442',
      firmware: '01.05.069.14', loginConfigured: true, loginEnabled: true, loggedIn: false, loginError: null, lockoutUntil: null,
      connectionStatus: 'DOCSIS Online', wanIpv4: null, wanIpv6: null, aftrAddress: null, dsLite: true, gwMode: 'Ipv6', uptimeSec: 1000,
      lastRebootReason: null, docsis: null, extra: {},
      attachedDevices: [{ kind: 'lan', hostName: 'Jan-PC', mac: null, ipv4: '192.168.0.192', ipv6: null, speed, isThisPc: true }],
    });
    expect(nic100m(healthyInput({ router: router('100 Mbps') }))?.evidence.find((e) => e.label === 'Port-Geschwindigkeit laut Router')?.value).toBe('100 Mbps');
    expect(nic100m(healthyInput({ router: router('1000 Mbps') }))).toBeNull();
  });
});

describe('R03 wlan-failover', () => {
  it('flags failovers at ≥ 50 % of genuine drops', () => {
    const drops = [1, 2, 3].map((i) => drop(T_END - i * DAY, 'runtime', { wlanFailover: i !== 2 }));
    const f = wlanFailover(healthyInput({ linkDrops: drops }));
    expect(f!.severity).toBe('warn');
    expect(f!.confidence).toBe('high');
    expect(f!.summary).toContain('Bei 2 von 3 Abbrüchen');
  });

  it('flags repeated egress switches to WLAN', () => {
    const input = withEvents(healthy, [
      ev('route_switch', T_END - DAY, { details: { from: 'Ethernet', to: 'WLAN' } }),
      ev('route_switch', T_END - DAY + MINUTE, { title: 'Internetverkehr: WLAN → Ethernet', details: { from: 'WLAN', to: 'Ethernet' } }),
      ev('route_switch', T_END - HOUR, { details: { toIf: 'WLAN' } }),
    ]);
    const f = wlanFailover(input);
    expect(f!.confidence).toBe('medium');
    expect(f!.evidence.find((e) => e.label === 'Schnittstellenwechsel aufs WLAN')?.value).toBe('2');
  });

  it('stays silent without failovers', () => {
    const drops = [1, 2, 3].map((i) => drop(T_END - i * DAY, 'runtime', { wlanFailover: false }));
    expect(wlanFailover(healthyInput({ linkDrops: drops }))).toBeNull();
    expect(wlanFailover(healthy)).toBeNull();
  });

  it('counts the IPv4 and IPv6 route_switch events of one failover once', () => {
    // shape written by engine/collectors/adapter.ts (one event per address family)
    const sw = (ts: number, family: 4 | 6) =>
      ev('route_switch', ts, { title: `Internetverkehr (IPv${family}) läuft jetzt über WLAN statt Ethernet`, details: { family, from: 'Ethernet', to: 'WLAN', toWifi: true } });
    const one = withEvents(healthy, [sw(T_END - HOUR, 4), sw(T_END - HOUR + 900, 6)]);
    expect(wlanSwitches(one)).toHaveLength(1);
    expect(wlanFailover(one)).toBeNull();
    const two = withEvents(one, [sw(T_END - 10 * MINUTE, 4), sw(T_END - 10 * MINUTE + 500, 6)]);
    expect(wlanSwitches(two)).toHaveLength(2);
    expect(wlanFailover(two)).not.toBeNull();
  });
});

describe('R14 after-change', () => {
  it('reports problems that started after a driver change', () => {
    const change = T_END - 10 * DAY;
    const drops = Array.from({ length: 6 }, (_, i) => drop(change + (i + 1) * DAY));
    const f = afterChange(healthyInput({ linkDrops: drops, changes: [{ ts: change, kind: 'driver', label: 'Treiber Ethernet: 1.1.4.43 → 2.1.5.12' }] }));
    expect(f).not.toBeNull();
    expect(f!.severity).toBe('warn');
    expect(f!.title).toMatch(/^Probleme seit Änderung am .*: Treiber Ethernet/);
    expect(f!.summary).toContain('echte Link-Abbrüche');
  });

  it('proves a fix after a cable swap (≥ 10 gigabit relinks, ≥ 7 days without drop)', () => {
    const change = T_END - 9 * DAY;
    const before = Array.from({ length: 6 }, (_, i) => drop(change - (i + 1) * DAY, 'runtime', { relinkMbps: i % 2 ? 100 : 1000 }));
    const after = Array.from({ length: 12 }, (_, i) => drop(change + DAY + i * 12 * HOUR, 'boot', { relinkMbps: 1000 }));
    const f = afterChange(healthyInput({ linkDrops: [...before, ...after], changes: [{ ts: change, kind: 'note', label: 'Kabel getauscht' }] }));
    expect(f!.severity).toBe('info');
    expect(f!.title).toMatch(/^Behebung nachgewiesen/);
    expect(f!.summary).toContain('als repariert');
  });

  it('compares the share of bad seconds per day', () => {
    const change = T_END - 4 * DAY;
    const day0 = new Date(2026, 9, 9).getTime();
    const secondsDaily = Array.from({ length: 8 }, (_, i) => {
      const dayStart = day0 - (8 - i) * DAY;
      return { day: `d${i}`, dayStart, covered: 40_000, bad: dayStart >= change ? 2000 : 40, es: 0 };
    });
    const f = afterChange(healthyInput({ secondsDaily, changes: [{ ts: change, kind: 'firmware', label: 'Router-Firmware: A → B' }] }));
    expect(f!.segment).toBe('router');
    expect(f!.summary).toContain('gestörte Sekunden');
  });

  it('quotes labels only once', () => {
    expect(quoteDe('Kabel getauscht')).toBe('„Kabel getauscht“');
    expect(quoteDe('Langzeittest „Neues Kabel“')).toBe('Langzeittest „Neues Kabel“');
  });

  it('ignores app config changes and changes without effect', () => {
    const change = T_END - 10 * DAY;
    const drops = Array.from({ length: 6 }, (_, i) => drop(change + (i + 1) * DAY));
    expect(afterChange(healthyInput({ linkDrops: drops, changes: [{ ts: change, kind: 'config', label: 'Einstellungen geändert' }] }))).toBeNull();
    expect(afterChange(healthyInput({ changes: [{ ts: change, kind: 'note', label: 'Notiz' }] }))).toBeNull();
    expect(afterChange(healthy)).toBeNull();
  });
});

describe('R15 vpn-active', () => {
  // real values: fixtures/windows/warp-cli_json_status.json + warp-cli_json_settings_list.json
  const warpInclude: VpnInfo = {
    ts: T_END,
    warp: { installed: true, connected: true, status: 'Connected', mode: 'tunnel_only', splitTunnel: 'include' },
    otherTunnels: [],
  };

  it('clears WARP in include mode (company networks only)', () => {
    const f = vpnActive(healthyInput({ vpn: warpInclude }));
    expect(f!.severity).toBe('info');
    expect(f!.title).toBe('VPN (WARP) leitet nur Firmennetze um');
  });

  it('warns when WARP tunnels everything or other tunnels are active', () => {
    const full = vpnActive(healthyInput({ vpn: { ...warpInclude, warp: { ...warpInclude.warp!, splitTunnel: 'exclude', mode: 'warp' } } }));
    expect(full!.severity).toBe('warn');
    expect(full!.title).toBe('VPN leitet Spieleverkehr um');
    expect(full!.confidence).toBe('high');
    const other = vpnActive(healthyInput({ vpn: { ts: T_END, warp: null, otherTunnels: ['WireGuard Tunnel'] } }));
    expect(other!.confidence).toBe('medium');
  });

  it('compares WARP on/off', () => {
    const cmp = (on: number, off: number) => ({ on: stats({ p95: on }), off: stats({ p95: off }), onMs: 5 * HOUR, offMs: 5 * HOUR });
    expect(compareVpn(cmp(30, 29))).toBe('same');
    expect(compareVpn(cmp(60, 30))).toBe('worse');
    expect(compareVpn({ ...cmp(60, 30), onMs: HOUR })).toBeNull();
    expect(vpnActive(healthyInput({ vpn: warpInclude, vpnCompare: cmp(30, 29) }))!.title).toBe('VPN (WARP) ist nicht die Ursache');
    expect(vpnActive(healthyInput({ vpn: warpInclude, vpnCompare: cmp(60, 30) }))!.severity).toBe('warn');
  });

  it('stays silent without VPN data', () => {
    expect(vpnActive(healthy)).toBeNull();
  });
});

describe('R16 data-quality', () => {
  it('stays silent for 3 days at 90 % coverage', () => {
    expect(dataQuality(healthy)).toBeNull();
  });

  it('says honestly that there is no data', () => {
    const input = healthyInput({
      seconds: null,
      coverage: { ...healthy.coverage, coveredSeconds: 0, coveragePct: 0, hasSeconds: false, samples: 0, daysCovered: 0, firstTs: null, lastTs: null },
    });
    const f = dataQuality(input)!;
    expect(f.title).toBe('Keine Messdaten im Zeitraum');
    expect(f.severity).toBe('warn');
    expect(dataQualityIssues(input).noData).toBe(true);
  });

  it('asks for more data below 24 h and reports long gaps', () => {
    const few = dataQuality(healthyInput({ coverage: { ...healthy.coverage, coveredSeconds: 10 * 3600, coveragePct: 14 } }))!;
    expect(few.title).toBe('Zu wenige Messdaten für eine sichere Aussage');
    expect(few.severity).toBe('warn'); // coverage < 30 %
    const gap = dataQuality(healthyInput({ coverage: { ...healthy.coverage, gaps: { count: 2, totalMs: 10 * HOUR, longestMs: 9 * HOUR } } }))!;
    expect(gap.title).toMatch(/^Messlücke 9 h 00 min/);
    expect(gap.severity).toBe('info');
  });

  it('notices missing evenings', () => {
    const s = healthy.seconds!;
    const hourly = hourlySeconds(s, { 19: { covered: 0 }, 20: { covered: 0 }, 21: { covered: 0 }, 22: { covered: 0 } });
    expect(dataQuality(healthyInput({ secondsHourly: hourly }))!.title).toBe('Abende kaum gemessen');
  });

  it('adds setup hints for DOCSIS and tariff', () => {
    expect(setupHints(healthy)).toHaveLength(2);
  });
});

describe('R19 periodic-spikes', () => {
  it('detects spikes every ~60 s', () => {
    const start = T_END - 2 * HOUR;
    const spikeTimes = Array.from({ length: 40 }, (_, i) => ({ ts: start + i * 60_000 + (i % 3) * 700, targetId: 'cf4' }));
    // a second target spiking in the same second must not create short intervals
    spikeTimes.push(...spikeTimes.slice(0, 10).map((s) => ({ ts: s.ts + 400, targetId: 'g4' })));
    const f = periodicSpikes(healthyInput({ spikeTimes }));
    expect(f).not.toBeNull();
    expect(f!.summary).toContain('etwa alle 60 s');
    expect(f!.severity).toBe('warn');
  });

  it('ignores irregular spikes', () => {
    let t = T_END - 6 * HOUR;
    const spikeTimes = Array.from({ length: 30 }, (_, i) => {
      t += ((i * 7919) % 900) * 1000 + 15_000;
      return { ts: t, targetId: 'cf4' };
    });
    expect(periodicSpikes(healthyInput({ spikeTimes }))).toBeNull();
    expect(periodicSpikes(healthy)).toBeNull();
  });

  it('does not mistake dense bursts of spikes (10–14 s apart) for a period', () => {
    // live run 09.10. 19:18–19:29: 29 spike episodes, mostly 10–14 s apart during a congested phase
    const t0 = T_END - 20 * MINUTE;
    const gaps = [11, 13, 12, 10, 14, 12, 11, 25, 12, 13, 40, 12, 11, 14, 10, 12, 33, 12, 13, 11, 12, 70, 12, 14, 11, 12, 13, 12];
    let t = t0;
    const spikeTimes = [{ ts: t, targetId: 'cf4' }, ...gaps.map((g) => ({ ts: (t += g * 1000), targetId: 'cf4' }))];
    expect(periodicSpikes(healthyInput({ spikeTimes }))).toBeNull();
  });

  it('merges simultaneous spike episodes', () => {
    expect(mergeSpikeTimes([1000, 1500, 9000, 4000])).toEqual([1000, 9000]);
  });

  it('finds a 15-minute period in the errored seconds per minute', () => {
    const t0 = T_END - 12 * HOUR;
    const series = Array.from({ length: 720 }, (_, i) => ({ ts: t0 + i * MINUTE, es: i % 15 === 0 ? 5 : 0, covered: 60 }));
    expect(esAutocorrelation(series)).toMatchObject({ lagMin: 15 });
    const f = periodicSpikes(healthyInput({ esPerMinute: series }));
    expect(f!.summary).toContain('etwa alle 15 min');
  });

  it('does not mistake one long disturbance for a period', () => {
    const t0 = T_END - 12 * HOUR;
    const series = Array.from({ length: 720 }, (_, i) => ({ ts: t0 + i * MINUTE, es: i >= 300 && i < 420 ? 10 : 0, covered: 60 }));
    expect(esAutocorrelation(series)).toBeNull();
  });
});
