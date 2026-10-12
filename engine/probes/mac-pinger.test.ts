import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MacInterface } from '../../src/lib/shared/parsers/macos/interfaces';
import { SampleStatus } from '../../src/lib/shared/types';
import { MAC_TOOLS } from '../collectors/macos/tools';
import type { NicTick } from '../core/types';
import { type AgentConfig, normalizeAddress } from './agent-protocol';
import type { IcmpEcho } from './common';
import { MacPinger, type MacPingerOptions, macPingArgs, nicTickOf, nicsToReport } from './mac-pinger';
import type { PingerMode } from './pinger';
import { FakeSpawner, recordingLogger } from './test-helpers';

const T0 = 1_791_550_560_000; // whole second
const OWN = new Set(['192.168.0.43'].map(normalizeAddress));

const CFG: AgentConfig = {
  targets: [
    { id: 'gw', ip: '192.168.0.1' },
    { id: 'gw6', ip: 'fe80::de73:6ff:fe12:34df%en7' },
    { id: 'cf4', ip: '1.1.1.1', every: 2 },
    { id: 'bad', ip: 'not-an-ip' },
  ],
  intervalMs: 1000,
  timeoutMs: 2000,
  size: 32,
  nics: ['Ethernet', 'WLAN'],
  preventSleep: true,
  ppid: 4242,
};

function iface(p: Partial<MacInterface> & Pick<MacInterface, 'device' | 'name'>): MacInterface {
  return {
    port: p.name,
    ifIndex: 16,
    isWifi: false,
    isVirtual: false,
    status: 'Up',
    linkUp: true,
    mediaMbps: 1000,
    duplex: 'full',
    media: 'autoselect (1000baseT <full-duplex>)',
    mtu: 1500,
    mac: null,
    addresses: [],
    inet6: [],
    counters: { device: p.device, down: false, ifIndex: 16, mtu: 1500, mac: null, ipkts: 10, ierrs: 1, ibytes: 1000, opkts: 20, oerrs: 0, obytes: 2000, coll: 0, drops: null },
    ...p,
  };
}

const ETH = iface({ device: 'en7', name: 'Ethernet' });
const WIFI = iface({ device: 'en0', name: 'Wi-Fi', isWifi: true, mediaMbps: null, duplex: null });

function setup(opts: Partial<MacPingerOptions> = {}) {
  const spawner = new FakeSpawner();
  const log = recordingLogger();
  const echoes: IcmpEcho[] = [];
  const nics: NicTick[] = [];
  const modes: PingerMode[] = [];
  const tracked: unknown[] = [];
  const pinger = new MacPinger(
    {
      log,
      onEcho: (e) => echoes.push(e),
      onNic: (t) => nics.push(t),
      isOwnAddress: (ip) => OWN.has(ip),
      ownAddresses: () => [...OWN],
      trackChild: (c) => tracked.push(c),
      onModeChange: (m) => modes.push(m),
    },
    { spawnFn: spawner.spawn, pid: 4242, readInterfaces: async () => [ETH, WIFI], ...opts },
  );
  const pings = () => spawner.children.filter((c) => c.command === MAC_TOOLS.ping || c.command === MAC_TOOLS.ping6);
  return { spawner, log, echoes, nics, modes, tracked, pinger, pings };
}

beforeEach(() => {
  vi.useFakeTimers({ now: T0 + 300 });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('macPingArgs', () => {
  it('IPv4 with -W timeout, IPv6 without (ping6 -W is something else)', () => {
    expect(macPingArgs('1.1.1.1', 4, 32, 2000)).toEqual(['-n', '-c', '1', '-s', '32', '-W', '2000', '1.1.1.1']);
    expect(macPingArgs('fe80::1%en7', 6, 32, 2000)).toEqual(['-n', '-c', '1', '-s', '32', 'fe80::1%en7']);
  });
});

describe('MacPinger', () => {
  it('pings every target on whole seconds (every n-th tick for slower targets)', async () => {
    const { pinger, pings, modes, tracked } = setup();
    pinger.start(CFG);
    expect(modes).toEqual(['agent']);
    await vi.advanceTimersByTimeAsync(700); // → T0 + 1000 (odd second: cf4 every 2 s skipped)
    const sec1 = Math.round((T0 + 1000) / 1000);
    expect(pings().map((c) => c.args[c.args.length - 1])).toEqual(sec1 % 2 === 0 ? ['192.168.0.1', 'fe80::de73:6ff:fe12:34df%en7', '1.1.1.1'] : ['192.168.0.1', 'fe80::de73:6ff:fe12:34df%en7']);
    expect(pings()[0].command).toBe(MAC_TOOLS.ping);
    expect(pings()[1].command).toBe(MAC_TOOLS.ping6);
    expect(pings()[0].options.env?.LC_ALL).toBe('C');
    expect(tracked.length).toBeGreaterThanOrEqual(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(pings().filter((c) => c.args.includes('1.1.1.1'))).toHaveLength(1);
    pinger.stop();
  });

  it('records the reply with the scheduled tick as ts', async () => {
    const { pinger, pings, echoes } = setup();
    pinger.start({ ...CFG, targets: [{ id: 'cf4', ip: '1.1.1.1' }] });
    await vi.advanceTimersByTimeAsync(700);
    const c = pings()[0];
    vi.setSystemTime(T0 + 1040);
    c.out('PING 1.1.1.1 (1.1.1.1): 32 data bytes\n40 bytes from 1.1.1.1: icmp_seq=0 ttl=57 time=12.345 ms\n');
    c.exit(0);
    expect(echoes).toEqual([{ targetId: 'cf4', ts: T0 + 1000, status: SampleStatus.OK, rtt: 12.345 }]);
    pinger.stop();
  });

  it('kills a silent ping after timeout + grace → TIMEOUT', async () => {
    const { pinger, pings, echoes } = setup();
    pinger.start({ ...CFG, targets: [{ id: 'gw6', ip: 'fe80::1%en7', to: 1500 }] });
    await vi.advanceTimersByTimeAsync(700);
    const c = pings()[0];
    await vi.advanceTimersByTimeAsync(1999);
    expect(c.killed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(c.killed).toBe(true);
    expect(echoes.find((e) => e.ts === T0 + 1000)).toEqual({ targetId: 'gw6', ts: T0 + 1000, status: SampleStatus.TIMEOUT, rtt: null });
    pinger.stop();
  });

  it('ARP failure (sendto: Host is down) → UNREACHABLE, ICMP error from an own address → UNREACHABLE', async () => {
    const { pinger, pings, echoes } = setup();
    pinger.start({ ...CFG, targets: [{ id: 'gw', ip: '192.168.0.1' }, { id: 'cf4', ip: '1.1.1.1' }] });
    await vi.advanceTimersByTimeAsync(700);
    const [gw, cf4] = pings();
    gw.err('ping: sendto: Host is down\n');
    gw.exit(2);
    cf4.out('60 bytes from 192.168.0.43: Time to live exceeded\n');
    cf4.exit(2);
    expect(echoes.map((e) => [e.targetId, e.status])).toEqual([
      ['gw', SampleStatus.UNREACHABLE],
      ['cf4', SampleStatus.UNREACHABLE],
    ]);
    pinger.stop();
  });

  it('spawn failures record no sample, warn once and set lastError until a ping works again', async () => {
    const { pinger, pings, echoes, spawner, log } = setup();
    pinger.start({ ...CFG, targets: [{ id: 'cf4', ip: '1.1.1.1' }], preventSleep: false });
    spawner.failNext = Object.assign(new Error('spawn /sbin/ping ENOENT'), { code: 'ENOENT' });
    await vi.advanceTimersByTimeAsync(700);
    expect(echoes).toEqual([]);
    expect(pinger.info().lastError).toMatch(/Ping konnte nicht gestartet werden/);
    await vi.advanceTimersByTimeAsync(1000);
    const c = pings()[0];
    c.emit('error', new Error('spawn EACCES'));
    expect(echoes).toEqual([]);
    expect(log.lines.filter((l) => l.level === 'warn' && /Ping konnte nicht gestartet werden/.test(l.msg))).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000);
    const ok = pings()[1];
    ok.out('40 bytes from 1.1.1.1: icmp_seq=0 ttl=57 time=9.5 ms\n');
    ok.exit(0);
    expect(echoes).toEqual([{ targetId: 'cf4', ts: T0 + 3000, status: SampleStatus.OK, rtt: 9.5 }]);
    expect(pinger.info().lastError).toBeNull();
    pinger.stop();
  });

  it('stop kills running pings and drops their results', async () => {
    const { pinger, pings, echoes, modes } = setup();
    pinger.start({ ...CFG, preventSleep: false });
    await vi.advanceTimersByTimeAsync(700);
    const running = pings();
    pinger.stop();
    expect(running.every((c) => c.killed)).toBe(true);
    expect(echoes).toEqual([]);
    expect(modes).toEqual(['agent', 'stopped']);
    expect(pinger.info()).toMatchObject({ mode: 'stopped', preventSleepActive: null });
    expect(pinger.activeTargetIds()).toEqual([]);
  });

  it('update() applies new targets on the next tick without restarting', async () => {
    const { pinger, pings } = setup();
    pinger.start({ ...CFG, targets: [{ id: 'gw', ip: '192.168.0.1' }], preventSleep: false });
    await vi.advanceTimersByTimeAsync(700);
    pinger.update({ ...CFG, targets: [{ id: 'g4', ip: '8.8.8.8' }], preventSleep: false });
    expect(pinger.activeTargetIds()).toEqual(['g4']);
    await vi.advanceTimersByTimeAsync(1000);
    expect(pings().map((c) => c.args[c.args.length - 1])).toEqual(['192.168.0.1', '8.8.8.8']);
    pinger.stop();
  });

  it('NIC ticks for the configured adapters, never overlapping reads', async () => {
    let resolveRead: ((l: MacInterface[]) => void) | null = null;
    let reads = 0;
    const { pinger, nics } = setup({
      readInterfaces: () => {
        reads++;
        return new Promise<MacInterface[]>((r) => {
          resolveRead = r;
        });
      },
    });
    pinger.start({ ...CFG, targets: [], preventSleep: false });
    await vi.advanceTimersByTimeAsync(700);
    await vi.advanceTimersByTimeAsync(1000); // read still running → skipped
    expect(reads).toBe(1);
    (resolveRead as unknown as (l: MacInterface[]) => void)([ETH, WIFI]);
    await vi.advanceTimersByTimeAsync(0);
    expect(nics).toEqual([{ ts: T0 + 1000, name: 'Ethernet', up: true, mbps: 1000, rxBytes: 1000, txBytes: 2000, rxErrors: 1, rxDiscards: 0, isWifi: false }]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(reads).toBe(2);
    pinger.stop();
  });

  it('repeated NIC read failures set lastError', async () => {
    const { pinger } = setup({ readInterfaces: async () => Promise.reject(new Error('ifconfig: Zeitüberschreitung')) });
    pinger.start({ ...CFG, targets: [], preventSleep: false });
    await vi.advanceTimersByTimeAsync(1700);
    expect(pinger.info().lastError).toBeNull();
    await vi.advanceTimersByTimeAsync(1000);
    expect(pinger.info().lastError).toBe('Link-Status der Netzwerkadapter nicht lesbar (ifconfig: Zeitüberschreitung)');
    pinger.stop();
  });

  it('preventSleep: caffeinate -i -w <pid>, restarted after an unexpected exit, killed on stop', async () => {
    const { pinger, spawner } = setup({ caffeinateRetryMs: 5000 });
    pinger.start({ ...CFG, targets: [] });
    const caf = () => spawner.children.filter((c) => c.command === MAC_TOOLS.caffeinate);
    expect(caf()).toHaveLength(1);
    expect(caf()[0].args).toEqual(['-i', '-w', '4242']);
    expect(pinger.info().preventSleepActive).toBe(true);
    caf()[0].exit(1);
    expect(pinger.info().preventSleepActive).toBe(false);
    await vi.advanceTimersByTimeAsync(5000);
    expect(caf()).toHaveLength(2);
    expect(pinger.info().preventSleepActive).toBe(true);
    pinger.update({ ...CFG, targets: [], preventSleep: false });
    expect(caf()[1].killed).toBe(true);
    expect(pinger.info().preventSleepActive).toBeNull();
    pinger.update({ ...CFG, targets: [], preventSleep: true });
    expect(caf()).toHaveLength(3);
    pinger.stop();
    expect(caf()[2].killed).toBe(true);
  });
});

describe('nicTickOf / nicsToReport', () => {
  it('Wi-Fi has no link speed, down links no speed, missing counters no tick', () => {
    expect(nicTickOf(WIFI, 5)).toMatchObject({ name: 'Wi-Fi', up: true, mbps: null, isWifi: true });
    expect(nicTickOf({ ...ETH, status: 'Disconnected' }, 5)).toMatchObject({ up: false, mbps: null });
    expect(nicTickOf({ ...ETH, counters: null }, 5)).toBeNull();
    expect(nicTickOf({ ...ETH, counters: { ...ETH.counters!, drops: 3 } }, 5)?.rxDiscards).toBe(3);
  });

  it('configured names (shown or BSD), else all physical interfaces', () => {
    const tun = iface({ device: 'utun4', name: 'utun4', isVirtual: true });
    expect(nicsToReport([ETH, WIFI, tun], ['ethernet', 'WLAN']).map((i) => i.name)).toEqual(['Ethernet']);
    expect(nicsToReport([ETH, WIFI, tun], ['en0']).map((i) => i.name)).toEqual(['Wi-Fi']);
    expect(nicsToReport([ETH, WIFI, tun], ['LAN']).map((i) => i.name)).toEqual(['Ethernet', 'Wi-Fi']);
  });
});
