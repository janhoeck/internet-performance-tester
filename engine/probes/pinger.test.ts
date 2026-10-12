import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SampleStatus } from '../../src/lib/shared/types';
import type { NicTick } from '../core/types';
import { AGENT_CONFIG_ENV, type AgentConfig, agentArgs, normalizeAddress } from './agent-protocol';
import type { IcmpEcho } from './common';
import type { FallbackHooks, FallbackTarget } from './ping-fallback';
import { type FallbackLike, type PingerMode, PingerSupervisor, fallbackTargets } from './pinger';
import { FakeSpawner, recordingLogger } from './test-helpers';

const T0 = 1_791_550_560_000; // whole second
const PS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const OWN = new Set(['192.168.0.192', 'fe80::374c:2a6a:2786:ee2e'].map(normalizeAddress));

const CFG: AgentConfig = {
  targets: [
    { id: 'gw', ip: '192.168.0.1' },
    { id: 'gw6', ip: 'fe80::de73:6ff:fe12:34df%4' },
    { id: 'cf4', ip: '1.1.1.1' },
    { id: 'bad', ip: 'not-an-ip' },
  ],
  intervalMs: 1000,
  timeoutMs: 2000,
  size: 32,
  nics: ['Ethernet', 'WLAN'],
  preventSleep: true,
  ppid: 4242,
};

class FakeFallback implements FallbackLike {
  started: FallbackTarget[] | null = null;
  updates: FallbackTarget[][] = [];
  stopped = false;
  constructor(readonly hooks: FallbackHooks) {}
  start(t: readonly FallbackTarget[]): void {
    this.started = [...t];
  }
  update(t: readonly FallbackTarget[]): void {
    this.updates.push([...t]);
  }
  stop(): void {
    this.stopped = true;
  }
  runningIds(): string[] {
    return (this.started ?? []).map((t) => t.id);
  }
}

function setup(opts: { maxFailedStarts?: number } = {}) {
  const spawner = new FakeSpawner();
  const log = recordingLogger();
  const echoes: IcmpEcho[] = [];
  const nics: NicTick[] = [];
  const modes: PingerMode[] = [];
  const fallbacks: FakeFallback[] = [];
  const tracked: unknown[] = [];
  const sup = new PingerSupervisor(
    {
      log,
      onEcho: (e) => echoes.push(e),
      onNic: (t) => nics.push(t),
      isOwnAddress: (ip) => OWN.has(ip),
      ownAddresses: () => ['192.168.0.192'],
      trackChild: (c) => tracked.push(c),
      onModeChange: (m) => modes.push(m),
    },
    {
      powershellPath: PS,
      scriptTemplate: "$cfgB64 = [Environment]::GetEnvironmentVariable('NETDIAG_PINGER_CFG')\n# comment\n  $x = 1",
      spawnFn: spawner.spawn,
      now: () => Date.now(),
      startupTimeoutMs: 15_000,
      fallbackRetryMs: 600_000,
      maxFailedStarts: opts.maxFailedStarts,
      createFallback: (h) => {
        const f = new FakeFallback(h);
        fallbacks.push(f);
        return f;
      },
    },
  );
  return { spawner, log, echoes, nics, modes, fallbacks, tracked, sup };
}

/** agent says hello + first heartbeat */
function boot(child: { json(o: unknown): void }, ts = T0 + 1000): void {
  child.json({ k: 'hello', pid: 77, sleep: true, targets: 3 });
  child.json({ k: 'hb', ts });
}

beforeEach(() => {
  vi.useFakeTimers({ now: T0 + 300 });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('PingerSupervisor – start and output', () => {
  it('spawns ONE hidden powershell.exe with -EncodedCommand and the config in the environment', () => {
    const { spawner, sup, tracked, modes } = setup();
    sup.start(CFG);
    expect(spawner.children).toHaveLength(1);
    const child = spawner.last;
    expect(child.command).toBe(PS);
    expect(child.args.slice(0, -1)).toEqual(agentArgs('x').slice(0, -1));
    expect(Buffer.from(child.args[child.args.length - 1], 'base64').toString('utf16le')).toBe(
      "$cfgB64 = [Environment]::GetEnvironmentVariable('NETDIAG_PINGER_CFG')\n$x = 1",
    );
    expect(child.options).toMatchObject({ windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    expect(child.options.shell).toBeUndefined();
    expect(child.options.detached).toBeUndefined();
    const encoded = child.options.env?.[AGENT_CONFIG_ENV];
    expect(typeof encoded).toBe('string');
    const sent = JSON.parse(Buffer.from(String(encoded), 'base64').toString('utf8')) as AgentConfig;
    expect(sent.targets.map((t) => t.id)).toEqual(['gw', 'gw6', 'cf4']); // invalid target dropped
    expect(sent).toMatchObject({ intervalMs: 1000, timeoutMs: 2000, nics: ['Ethernet', 'WLAN'], preventSleep: true, ppid: 4242 });
    expect(child.options.env?.SystemRoot ?? child.options.env?.SYSTEMROOT).toBeDefined();
    expect(tracked).toHaveLength(1);
    expect(modes).toEqual(['starting']);
    expect(sup.info()).toMatchObject({ mode: 'starting', pid: 1000, failedStarts: 0 });
    sup.stop();
  });

  it('becomes healthy on the first heartbeat and maps echo and nic lines', () => {
    const { spawner, sup, echoes, nics, modes } = setup();
    sup.start(CFG);
    const child = spawner.last;
    // results before the first heartbeat are ignored (cannot happen with the real agent)
    child.json({ k: 'icmp', id: 'gw', ts: T0, st: 'Success', rtt: 1, from: '192.168.0.1', err: null });
    boot(child);
    expect(modes).toEqual(['starting', 'agent']);
    expect(sup.info()).toMatchObject({ mode: 'agent', preventSleepActive: true, lastHeartbeatTs: T0 + 1000, lastError: null });
    expect(sup.activeTargetIds()).toEqual(['gw', 'gw6', 'cf4']);
    // one tick: nic lines + heartbeat + results split across chunks
    const lines = [
      { k: 'nic', ts: T0 + 1000, name: 'Ethernet', up: false, mbps: null, rx: 0, tx: 0, inErr: 0, inDisc: 0, wifi: false },
      { k: 'nic', ts: T0 + 1000, name: 'WLAN', up: true, mbps: 206, rx: 43633330, tx: 8675763, inErr: 0, inDisc: 0, wifi: true },
      { k: 'icmp', id: 'gw', ts: T0 + 1000, st: 'Success', rtt: 0, from: '192.168.0.1', err: null },
      { k: 'icmp', id: 'gw6', ts: T0 + 1000, st: 'Success', rtt: 2, from: 'fe80::de73:6ff:fe12:34df%4', err: null },
      { k: 'icmp', id: 'cf4', ts: T0 + 1000, st: 'Success', rtt: 1234, from: '1.1.1.1', err: null },
      { k: 'icmp', id: 'cf4', ts: T0 + 2000, st: 'TimedOut', rtt: null, from: '0.0.0.0', err: null },
      { k: 'icmp', id: 'gw', ts: T0 + 2000, st: 'DestinationHostUnreachable', rtt: null, from: '192.168.0.192', err: null },
      { k: 'icmp', id: 'gw6', ts: T0 + 2000, st: 'Error', rtt: null, from: null, err: 'PingException:-2146233079' },
    ];
    const text = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
    child.out(text.slice(0, 77));
    child.out(text.slice(77, 300));
    child.out(text.slice(300));
    expect(nics).toEqual([
      { ts: T0 + 1000, name: 'Ethernet', up: false, mbps: null, rxBytes: 0, txBytes: 0, rxErrors: 0, rxDiscards: 0, isWifi: false },
      { ts: T0 + 1000, name: 'WLAN', up: true, mbps: 206, rxBytes: 43633330, txBytes: 8675763, rxErrors: 0, rxDiscards: 0, isWifi: true },
    ]);
    expect(echoes).toEqual([
      { targetId: 'gw', ts: T0 + 1000, status: SampleStatus.OK, rtt: 0.5 },
      { targetId: 'gw6', ts: T0 + 1000, status: SampleStatus.OK, rtt: 2 },
      { targetId: 'cf4', ts: T0 + 1000, status: SampleStatus.OK, rtt: 1234 },
      { targetId: 'cf4', ts: T0 + 2000, status: SampleStatus.TIMEOUT, rtt: null },
      { targetId: 'gw', ts: T0 + 2000, status: SampleStatus.UNREACHABLE, rtt: null },
      { targetId: 'gw6', ts: T0 + 2000, status: SampleStatus.ERROR, rtt: null },
    ]);
    sup.stop();
  });

  it('logs agent warnings and unexpected output', () => {
    const { spawner, sup, log } = setup();
    sup.start(CFG);
    spawner.last.out('{"k":"warn","msg":"SetThreadExecutionState failed: x"}\nirgendwas\n');
    expect(log.lines.some((l) => l.level === 'warn' && l.msg.includes('SetThreadExecutionState failed'))).toBe(true);
    expect(log.lines.some((l) => l.level === 'debug' && l.msg.includes('irgendwas'))).toBe(true);
    sup.stop();
  });
});

describe('PingerSupervisor – watchdog and restarts', () => {
  it('kills an agent without heartbeat for 5 s and restarts it with backoff 1, 2, 5 s', () => {
    const { spawner, sup } = setup();
    sup.start(CFG);
    boot(spawner.last);
    vi.advanceTimersByTime(6000);
    expect(spawner.children[0].killed).toBe(true);
    expect(sup.info().lastError).toMatch(/Neustart in 1 s/);
    expect(sup.info().mode).toBe('starting');
    vi.advanceTimersByTime(1000);
    expect(spawner.children).toHaveLength(2);
    // second agent is healthy briefly and hangs again → 2 s backoff
    boot(spawner.last, T0 + 9000);
    vi.advanceTimersByTime(6000);
    expect(spawner.children[1].killed).toBe(true);
    vi.advanceTimersByTime(1500);
    expect(spawner.children).toHaveLength(2);
    vi.advanceTimersByTime(600);
    expect(spawner.children).toHaveLength(3);
    expect(sup.info().restarts).toBe(2);
    sup.stop();
  });

  it('keeps a healthy agent alive while heartbeats arrive', () => {
    const { spawner, sup } = setup();
    sup.start(CFG);
    const child = spawner.last;
    boot(child);
    for (let i = 2; i < 30; i++) {
      vi.advanceTimersByTime(1000);
      child.json({ k: 'hb', ts: T0 + i * 1000 });
    }
    expect(child.killed).toBe(false);
    expect(spawner.children).toHaveLength(1);
    sup.stop();
  });

  it('restarts an agent that exits after running a while (backoff reset after 60 s)', () => {
    const { spawner, sup, log } = setup();
    sup.start(CFG);
    const child = spawner.last;
    boot(child);
    for (let i = 2; i < 70; i++) {
      vi.advanceTimersByTime(1000);
      child.json({ k: 'hb', ts: T0 + i * 1000 });
    }
    child.err('Ausnahme beim Aufrufen von "WriteLine"');
    child.exit(1);
    expect(log.lines.some((l) => l.level === 'warn' && l.msg.includes('Ausnahme beim Aufrufen'))).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(spawner.children).toHaveLength(2);
    sup.stop();
  });

  it('switches to the ping.exe fallback after 3 failed starts and retries the agent later', () => {
    const { spawner, sup, fallbacks, modes } = setup();
    sup.start(CFG);
    spawner.last.exit(1); // start 1 failed
    vi.advanceTimersByTime(1000);
    spawner.last.exit(1); // start 2 failed
    vi.advanceTimersByTime(2000);
    expect(spawner.children).toHaveLength(3);
    spawner.last.exit(1); // start 3 failed → fallback
    expect(sup.info().mode).toBe('fallback');
    expect(sup.info().lastError).toMatch(/Ersatzmessung mit ping\.exe/);
    expect(fallbacks).toHaveLength(1);
    expect(fallbacks[0].started).toEqual([
      { id: 'gw', ip: '192.168.0.1', family: 4, timeoutMs: 2000 },
      { id: 'gw6', ip: 'fe80::de73:6ff:fe12:34df%4', family: 6, timeoutMs: 2000 },
      { id: 'cf4', ip: '1.1.1.1', family: 4, timeoutMs: 2000 },
    ]);
    expect(sup.activeTargetIds()).toEqual(['gw', 'gw6', 'cf4']);
    // fallback echoes are forwarded
    fallbacks[0].hooks.onEcho({ targetId: 'cf4', ts: T0, status: SampleStatus.OK, rtt: 18 });
    // agent retry after 10 min: output is ignored until it is healthy, then the fallback stops
    vi.advanceTimersByTime(600_000);
    expect(spawner.children).toHaveLength(4);
    const retry = spawner.last;
    retry.json({ k: 'nic', ts: T0, name: 'Ethernet', up: true, mbps: 1000, rx: 1, tx: 1, inErr: 0, inDisc: 0, wifi: false });
    boot(retry, T0 + 601_000);
    expect(fallbacks[0].stopped).toBe(true);
    expect(sup.info()).toMatchObject({ mode: 'agent', failedStarts: 0, lastError: null });
    expect(modes).toEqual(['starting', 'fallback', 'agent']);
    sup.stop();
  });

  it('stays on the fallback when the agent retry fails', () => {
    const { spawner, sup, fallbacks } = setup({ maxFailedStarts: 1 });
    sup.start(CFG);
    spawner.last.exit(1);
    expect(sup.info().mode).toBe('fallback');
    vi.advanceTimersByTime(600_000);
    spawner.last.exit(1);
    expect(sup.info().mode).toBe('fallback');
    expect(fallbacks[0].stopped).toBe(false);
    vi.advanceTimersByTime(600_000);
    expect(spawner.children).toHaveLength(3);
    sup.stop();
    expect(fallbacks[0].stopped).toBe(true);
  });

  it('counts a spawn exception as a failed start', () => {
    const { spawner, sup } = setup();
    spawner.failNext = new Error('spawn EACCES');
    sup.start(CFG);
    expect(spawner.children).toHaveLength(0);
    expect(sup.info()).toMatchObject({ failedStarts: 1, mode: 'starting' });
    expect(sup.info().lastError).toMatch(/Start fehlgeschlagen: spawn EACCES/);
    vi.advanceTimersByTime(1000);
    expect(spawner.children).toHaveLength(1);
    sup.stop();
  });

  it('kills an agent that never sends a heartbeat within the startup timeout', () => {
    const { spawner, sup } = setup();
    sup.start(CFG);
    vi.advanceTimersByTime(16_000);
    expect(spawner.children[0].killed).toBe(true);
    expect(sup.info().failedStarts).toBe(1);
    sup.stop();
  });
});

describe('PingerSupervisor – config changes and stop', () => {
  it('restarts only when the effective config changed', () => {
    const { spawner, sup } = setup();
    sup.start(CFG);
    boot(spawner.last);
    sup.update({ ...CFG, ppid: 1, nics: ['wlan', 'ethernet'] });
    expect(spawner.children).toHaveLength(1);
    sup.update({ ...CFG, targets: [...CFG.targets, { id: 'cf6', ip: '2606:4700:4700::1111' }] });
    expect(spawner.children[0].killed).toBe(true);
    expect(spawner.children).toHaveLength(2); // planned restart: immediately, no backoff
    expect(sup.info()).toMatchObject({ mode: 'starting', failedStarts: 0 });
    const sent = JSON.parse(Buffer.from(String(spawner.last.options.env?.[AGENT_CONFIG_ENV]), 'base64').toString('utf8')) as AgentConfig;
    expect(sent.targets.map((t) => t.id)).toEqual(['gw', 'gw6', 'cf4', 'cf6']);
    sup.stop();
  });

  it('applies a config change during a backoff wait right away', () => {
    const { spawner, sup } = setup();
    sup.start(CFG);
    spawner.last.exit(1);
    expect(spawner.children).toHaveLength(1);
    sup.update({ ...CFG, preventSleep: false });
    expect(spawner.children).toHaveLength(2);
    sup.stop();
  });

  it('passes config changes to the fallback while it runs', () => {
    const { spawner, sup, fallbacks } = setup({ maxFailedStarts: 1 });
    sup.start(CFG);
    spawner.last.exit(1);
    sup.update({ ...CFG, targets: [{ id: 'cf4', ip: '1.0.0.1' }] });
    expect(fallbacks[0].updates).toEqual([[{ id: 'cf4', ip: '1.0.0.1', family: 4, timeoutMs: 2000 }]]);
    sup.stop();
  });

  it('stop() kills the agent and never restarts it', () => {
    const { spawner, sup, modes } = setup();
    sup.start(CFG);
    boot(spawner.last);
    sup.stop();
    expect(spawner.children[0].killed).toBe(true);
    expect(sup.info()).toMatchObject({ mode: 'stopped', pid: null, preventSleepActive: null });
    vi.advanceTimersByTime(120_000);
    expect(spawner.children).toHaveLength(1);
    expect(modes[modes.length - 1]).toBe('stopped');
    // start again works
    sup.start(CFG);
    expect(spawner.children).toHaveLength(2);
    sup.stop();
  });

  it('plans a restart after the maximum agent age', () => {
    const spawner = new FakeSpawner();
    const sup = new PingerSupervisor(
      { log: recordingLogger(), onEcho: () => undefined, onNic: () => undefined, isOwnAddress: () => false, ownAddresses: () => [] },
      { scriptTemplate: "[Environment]::GetEnvironmentVariable('NETDIAG_PINGER_CFG')", spawnFn: spawner.spawn, now: () => Date.now(), maxAgentAgeMs: 10_000 },
    );
    sup.start(CFG);
    const child = spawner.last;
    boot(child);
    for (let i = 2; i < 13; i++) {
      vi.advanceTimersByTime(1000);
      if (!child.closed) child.json({ k: 'hb', ts: T0 + i * 1000 });
    }
    expect(child.killed).toBe(true);
    expect(spawner.children).toHaveLength(2);
    expect(sup.info().restarts).toBe(0);
    sup.stop();
  });
});

describe('fallbackTargets', () => {
  it('derives family and timeout per target', () => {
    expect(
      fallbackTargets({ ...CFG, targets: [{ id: 'a', ip: '9.9.9.9', to: 3000 }, { id: 'b', ip: '2620:fe::fe' }, { id: 'c', ip: 'x' }] }),
    ).toEqual([
      { id: 'a', ip: '9.9.9.9', family: 4, timeoutMs: 3000 },
      { id: 'b', ip: '2620:fe::fe', family: 6, timeoutMs: 2000 },
    ]);
  });
});

describe('pinger.ps1 location', () => {
  it('is loaded next to pinger.ts', async () => {
    const { loadPingerTemplate } = await import('./pinger');
    expect(loadPingerTemplate()).toContain('SendPingAsync');
    expect(path.basename(new URL('./pinger.ps1', import.meta.url).pathname)).toBe('pinger.ps1');
  });
});
