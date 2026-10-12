import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parsePingLine } from '../../src/lib/shared/parsers/ping';
import { SampleStatus } from '../../src/lib/shared/types';
import type { IcmpEcho } from './common';
import { FallbackTimestamper, PingFallback } from './ping-fallback';
import { FakeSpawner, recordingLogger } from './test-helpers';

const FIX = path.join(process.cwd(), 'fixtures', 'windows');
const PING = 'C:\\Windows\\System32\\PING.EXE';
const T0 = 1_791_550_560_000;

interface Timeline {
  args: string[];
  lines: { t: number; cp850: string }[];
}

function timeline(name: string): Timeline {
  return JSON.parse(fs.readFileSync(path.join(FIX, `ping_t_${name}.fromBash.timeline.json`), 'utf8')) as Timeline;
}

/** stamps for all echo lines of a captured `ping -t` run (spawned at T0 + 0.4 s) */
function stampTimeline(name: string): { kind: string; ts: number; arrival: number }[] {
  const tl = timeline(name);
  const w = Number(tl.args[tl.args.indexOf('-w') + 1]);
  const stamper = new FallbackTimestamper(w);
  const out: { kind: string; ts: number; arrival: number }[] = [];
  for (const l of tl.lines) {
    const p = parsePingLine(l.cp850, { ownAddresses: ['192.168.0.192'] });
    if (!p.echo) continue;
    const arrival = T0 + 400 + l.t;
    out.push({ kind: p.kind, ts: stamper.stamp(arrival, p), arrival });
  }
  return out;
}

describe('FallbackTimestamper (real ping -t timelines)', () => {
  it('replies: one stamp per second, whole seconds, close to the send time', () => {
    const s = stampTimeline('ipv4_1.1.1.1');
    expect(s.length).toBe(9);
    for (let i = 0; i < s.length; i++) {
      expect(s[i].ts % 1000).toBe(0);
      expect(Math.abs(s[i].arrival - s[i].ts)).toBeLessThanOrEqual(600);
      if (i > 0) expect(s[i].ts - s[i - 1].ts).toBe(1000);
    }
  });

  it('IPv6 replies (no TTL) are stamped the same way', () => {
    const s = stampTimeline('ipv6_cloudflare');
    expect(s.length).toBe(9);
    expect(new Set(s.map((x) => x.ts)).size).toBe(9);
  });

  it('timeouts: stamped at the estimated send time (arrival − timeout), unique and increasing', () => {
    const s = stampTimeline('unresponsive_192.0.2.1');
    expect(s.every((x) => x.kind === 'timeout')).toBe(true);
    for (let i = 1; i < s.length; i++) expect(s[i].ts).toBeGreaterThan(s[i - 1].ts);
    // -w 1000 → one echo every 2 s during an outage
    expect(s[s.length - 1].ts - s[0].ts).toBe((s.length - 1) * 2000);
  });

  it('ARP failure: alternating timeouts and "Zielhost nicht erreichbar" never collide', () => {
    const s = stampTimeline('arpfail_192.168.0.2');
    expect(s.filter((x) => x.kind === 'unreachable')).toHaveLength(4);
    expect(new Set(s.map((x) => x.ts)).size).toBe(s.length);
    for (let i = 1; i < s.length; i++) expect(s[i].ts).toBeGreaterThan(s[i - 1].ts);
  });

  it('forces strictly increasing stamps when lines arrive close together', () => {
    const st = new FallbackTimestamper(2000);
    const reply = parsePingLine('Antwort von 1.1.1.1: Bytes=32 Zeit=18ms TTL=57');
    expect(st.stamp(T0 + 100, reply)).toBe(T0);
    expect(st.stamp(T0 + 300, reply)).toBe(T0 + 1000);
    // timeout: sent ≈ timeout − 420 ms (IcmpSendEcho2 fires early) before the line → 5100 − 1580
    expect(st.stamp(T0 + 5_100, parsePingLine('Zeitüberschreitung der Anforderung.'))).toBe(T0 + 4000);
    // local failure: reported at once – would round to 4000 again → forced to the next second
    expect(st.stamp(T0 + 4_200, parsePingLine('PING: Fehler bei der Übertragung. Allgemeiner Fehler.'))).toBe(T0 + 5000);
  });
});

function setup(silenceMs?: number) {
  const spawner = new FakeSpawner();
  const echoes: IcmpEcho[] = [];
  const log = recordingLogger();
  const fb = new PingFallback(
    { log, onEcho: (e) => echoes.push(e), ownAddresses: () => ['192.168.0.192', 'fe80::374c:2a6a:2786:ee2e%4'] },
    { pingPath: PING, spawnFn: spawner.spawn, silenceMs, now: () => Date.now() },
  );
  return { spawner, echoes, fb, log };
}

const raw = (name: string) => fs.readFileSync(path.join(FIX, `ping_t_${name}.fromBash.raw.bin`));

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('PingFallback', () => {
  it('spawns one hidden ping.exe -t per target with -w and the address family', () => {
    const { spawner, fb } = setup();
    fb.start([
      { id: 'cf4', ip: '1.1.1.1', family: 4, timeoutMs: 2000 },
      { id: 'gw6', ip: 'fe80::de73:6ff:fe12:34df%4', family: 6, timeoutMs: 2000 },
    ]);
    expect(spawner.children.map((c) => [c.command, ...c.args])).toEqual([
      [PING, '-t', '-w', '2000', '-4', '1.1.1.1'],
      [PING, '-t', '-w', '2000', '-6', 'fe80::de73:6ff:fe12:34df%4'],
    ]);
    for (const c of spawner.children) {
      expect(c.options).toMatchObject({ windowsHide: true });
      expect(c.options.shell).toBeUndefined();
      expect(c.options.detached).toBeUndefined();
    }
    expect(fb.runningIds()).toEqual(['cf4', 'gw6']);
    fb.stop();
  });

  it('decodes CP850 output split at arbitrary byte boundaries and reports every echo', () => {
    const { spawner, echoes, fb } = setup();
    fb.start([{ id: 'cf4', ip: '1.1.1.1', family: 4, timeoutMs: 1000 }]);
    const bytes = raw('ipv4_1.1.1.1');
    for (let i = 0; i < bytes.length; i += 7) spawner.last.out(bytes.subarray(i, i + 7));
    expect(echoes.map((e) => e.rtt)).toEqual([22, 18, 19, 20, 42, 22, 21, 49, 17]);
    expect(echoes.every((e) => e.targetId === 'cf4' && e.status === SampleStatus.OK && e.ts % 1000 === 0)).toBe(true);
    fb.stop();
  });

  it('counts "Zielhost nicht erreichbar" (ARP failure) and timeouts as losses', () => {
    const { spawner, echoes, fb } = setup();
    fb.start([{ id: 'gw', ip: '192.168.0.2', family: 4, timeoutMs: 1000 }]);
    spawner.last.out(raw('arpfail_192.168.0.2'));
    expect(echoes.filter((e) => e.status === SampleStatus.UNREACHABLE)).toHaveLength(4);
    expect(echoes.filter((e) => e.status === SampleStatus.TIMEOUT)).toHaveLength(6);
    expect(echoes.every((e) => e.rtt === null)).toBe(true);
    fb.stop();
  });

  it('restarts a ping.exe that ended (backoff) and stops for good on stop()', () => {
    const { spawner, fb, log } = setup();
    fb.start([{ id: 'cf4', ip: '1.1.1.1', family: 4, timeoutMs: 2000 }]);
    spawner.last.exit(1);
    expect(fb.runningIds()).toEqual([]);
    expect(log.lines.some((l) => l.level === 'warn' && l.msg.includes('cf4'))).toBe(true);
    vi.advanceTimersByTime(999);
    expect(spawner.children).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(spawner.children).toHaveLength(2);
    spawner.last.exit(1);
    vi.advanceTimersByTime(2000);
    expect(spawner.children).toHaveLength(3);
    fb.stop();
    expect(spawner.last.killed).toBe(true);
    vi.advanceTimersByTime(60_000);
    expect(spawner.children).toHaveLength(3);
  });

  it('applies target changes: restarts changed, stops removed, starts new targets', () => {
    const { spawner, fb } = setup();
    fb.start([
      { id: 'a', ip: '1.1.1.1', family: 4, timeoutMs: 2000 },
      { id: 'b', ip: '8.8.8.8', family: 4, timeoutMs: 2000 },
    ]);
    const [a, b] = spawner.children;
    fb.update([
      { id: 'a', ip: '1.1.1.1', family: 4, timeoutMs: 2000 },
      { id: 'b', ip: '8.8.4.4', family: 4, timeoutMs: 2000 },
      { id: 'c', ip: '2620:fe::fe', family: 6, timeoutMs: 2000 },
    ]);
    expect(a.killed).toBe(false);
    expect(b.killed).toBe(true);
    expect(spawner.alive().map((c) => c.args[c.args.length - 1])).toEqual(['1.1.1.1', '8.8.4.4', '2620:fe::fe']);
    fb.update([{ id: 'c', ip: '2620:fe::fe', family: 6, timeoutMs: 2000 }]);
    expect(spawner.alive().map((c) => c.args[c.args.length - 1])).toEqual(['2620:fe::fe']);
    vi.advanceTimersByTime(60_000);
    expect(spawner.alive()).toHaveLength(1); // killed processes are not restarted
    fb.stop();
  });

  it('kills and restarts a ping.exe that stays silent', () => {
    const { spawner, fb } = setup(15_000);
    fb.start([{ id: 'cf4', ip: '1.1.1.1', family: 4, timeoutMs: 2000 }]);
    vi.advanceTimersByTime(10_000);
    spawner.last.out(raw('ipv4_1.1.1.1').subarray(0, 120));
    vi.advanceTimersByTime(14_000);
    expect(spawner.children[0].killed).toBe(false);
    vi.advanceTimersByTime(2000);
    expect(spawner.children[0].killed).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(spawner.children).toHaveLength(2);
    fb.stop();
  });

  it('survives a spawn exception and retries', () => {
    const { spawner, fb } = setup();
    spawner.failNext = new Error('spawn ENOENT');
    fb.start([{ id: 'cf4', ip: '1.1.1.1', family: 4, timeoutMs: 2000 }]);
    expect(spawner.children).toHaveLength(0);
    vi.advanceTimersByTime(1000);
    expect(spawner.children).toHaveLength(1);
    fb.stop();
  });
});
