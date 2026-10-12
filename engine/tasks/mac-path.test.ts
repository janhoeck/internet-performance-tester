import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildTraceHops } from '../../src/lib/shared/path-analysis';
import { MAC_TOOLS } from '../collectors/macos/tools';
import { setPlatformOverride } from '../platform';
import {
  type RunFn,
  bsdProbeToHop,
  classifyMacDfPing,
  dfPingArgs,
  macDfProbe,
  macV6DontFragment,
  readMacPmtu,
  resetMacPathState,
  runMacTraceroute,
  runMacTtlProbes,
  ttlProbeArgs,
} from './mac-path';
import { WINDOWS_MTU_WORDING, macMtuWording, measureFamilyMtu } from './mtu';
import { type ProcessResult, type TtlPlan, discoveryPlan, runTracert, runTtlProbes } from './traceroute';

const readText = (name: string) => fs.readFileSync(new URL(`../../fixtures/macos/${name}`, import.meta.url), 'utf8');

interface Reply {
  stdout?: string;
  stderr?: string;
  code?: number | null;
  timedOut?: boolean;
  error?: string | null;
  delayMs?: number;
}

/** Fake runner: `respond(file, args)` decides the output; records calls and concurrency. */
function fakeRun(respond: (file: string, args: readonly string[]) => Reply) {
  const calls: { file: string; args: readonly string[] }[] = [];
  let running = 0;
  let maxRunning = 0;
  const run: RunFn = async (file, args, opts) => {
    calls.push({ file, args });
    running++;
    maxRunning = Math.max(maxRunning, running);
    const r = respond(file, args);
    try {
      if (r.delayMs) await new Promise((res) => setTimeout(res, r.delayMs));
      const aborted = opts.signal?.aborted === true;
      const result: ProcessResult = {
        code: r.code === undefined ? 0 : r.code,
        stdout: Buffer.from(r.stdout ?? '', 'utf8'),
        stderr: Buffer.from(r.stderr ?? '', 'utf8'),
        timedOut: r.timedOut ?? false,
        aborted,
        error: r.error ?? null,
        durationMs: r.delayMs ?? 1,
      };
      return result;
    } finally {
      running--;
    }
  };
  return { run, calls, maxRunning: () => maxRunning };
}

const argOf = (args: readonly string[], flag: string) => Number(args[args.indexOf(flag) + 1]);

/** Path 192.168.0.1 → (silent) → 92.79.214.92 → 1.1.1.1 (destination at TTL 4). */
const PATH_V4: (string | null)[] = ['192.168.0.1', null, '92.79.214.92', '1.1.1.1'];

function pathResponder(path: (string | null)[], dst: string) {
  return (_file: string, args: readonly string[]): Reply => {
    const ttl = argOf(args, '-f');
    const hop = path[Math.min(ttl, path.length) - 1];
    const header = `traceroute to ${dst} (${dst}), ${ttl} hops max, 72 byte packets\n`;
    if (ttl > path.length) return { stdout: ` ${ttl}  ${dst}  12.5 ms\n`, stderr: header };
    return { stdout: hop ? ` ${ttl}  ${hop}  ${(ttl * 1.5).toFixed(3)} ms\n` : ` ${ttl}  *\n`, stderr: header };
  };
}

const plan = (p: Partial<TtlPlan> = {}): TtlPlan => ({ ...discoveryPlan('1.1.1.1', 8), intervalMs: 0, ...p });

beforeEach(() => resetMacPathState());
afterEach(() => setPlatformOverride(null));

describe('ttlProbeArgs / dfPingArgs', () => {
  it('one probe for exactly one TTL', () => {
    expect(ttlProbeArgs('1.1.1.1', 3, 1000, true)).toEqual(['-n', '-I', '-q', '1', '-w', '1', '-f', '3', '-m', '3', '1.1.1.1']);
    expect(ttlProbeArgs('2606:4700:4700::1111', 2, 1500, false)).toEqual(['-n', '-q', '1', '-w', '2', '-f', '2', '-m', '2', '2606:4700:4700::1111']);
  });

  it('DF pings', () => {
    expect(dfPingArgs(4, '1.1.1.1', 1432, 1000)).toEqual(['-n', '-D', '-s', '1432', '-c', '1', '-W', '1000', '1.1.1.1']);
    expect(dfPingArgs(6, '2606:4700:4700::1111', 1452, 1000)).toEqual(['-n', '-D', '-m', '-s', '1452', '-c', '1', '2606:4700:4700::1111']);
    expect(dfPingArgs(6, '2606:4700:4700::1111', 1452, 1000, false)).toEqual(['-n', '-m', '-s', '1452', '-c', '1', '2606:4700:4700::1111']);
  });
});

describe('bsdProbeToHop', () => {
  const base = { annotation: null, sendError: false };
  it('reply / ttl-expired / lost / unreachable / local error', () => {
    expect(bsdProbeToHop({ ...base, from: '1.1.1.1', rttMs: 12.3456 }, 9, 1, '1.1.1.1', () => false)).toEqual({ ttl: 9, round: 1, from: '1.1.1.1', rttMs: 12.35, kind: 'reply' });
    expect(bsdProbeToHop({ ...base, from: 'fe80::1%en7', rttMs: 1 }, 1, 2, '2606:4700:4700::1111', () => false)).toMatchObject({ from: 'fe80::1', kind: 'ttl-expired' });
    expect(bsdProbeToHop({ ...base, from: null, rttMs: null }, 2, 1, '1.1.1.1', () => false)).toMatchObject({ kind: 'lost', from: null });
    expect(bsdProbeToHop({ ...base, from: '192.168.0.1', rttMs: 3000, annotation: '!H' }, 2, 1, '1.1.1.1', () => false).kind).toBe('unreachable');
    expect(bsdProbeToHop({ ...base, from: '192.168.0.43', rttMs: 3000, annotation: '!H' }, 2, 1, '1.1.1.1', (ip) => ip === '192.168.0.43')).toMatchObject({ kind: 'error', from: null });
    expect(bsdProbeToHop({ ...base, from: null, rttMs: null, sendError: true }, 1, 1, '1.1.1.1', () => false).kind).toBe('error');
    expect(bsdProbeToHop(null, 1, 1, '1.1.1.1', () => false).kind).toBe('error');
  });
});

describe('runMacTtlProbes', () => {
  it('discovery: all TTLs of round 1 in flight, later rounds stop at the destination', async () => {
    const f = fakeRun(pathResponder(PATH_V4, '1.1.1.1'));
    const r = await runMacTtlProbes(plan(), {}, { run: f.run });
    expect(r).toMatchObject({ ok: true, complete: true, error: null });
    expect(f.calls.every((c) => c.file === MAC_TOOLS.traceroute && c.args.includes('-I'))).toBe(true);
    expect(r.probes.filter((p) => p.round === 1).map((p) => p.ttl)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(r.probes.filter((p) => p.round === 2).map((p) => p.ttl)).toEqual([1, 2, 3, 4]);
    expect(r.probes.filter((p) => p.round === 3).map((p) => p.ttl)).toEqual([1, 2, 3, 4]);
    const built = buildTraceHops(r.probes, { silentTail: 2 });
    expect(built.reached).toBe(true);
    expect(built.hops.map((h) => h.ip)).toEqual(['192.168.0.1', null, '92.79.214.92', '1.1.1.1']);
    expect(built.hops[0].rtts).toEqual([1.5, 1.5, 1.5]);
  });

  it('respects maxConc', async () => {
    const f = fakeRun((file, args) => ({ ...pathResponder(PATH_V4, '1.1.1.1')(file, args), delayMs: 5 }));
    await runMacTtlProbes(plan({ maxConc: 2, rounds: 1, stopAtDest: false }), {}, { run: f.run });
    expect(f.maxRunning()).toBe(2);
    expect(f.calls).toHaveLength(8);
  });

  it('trimSilent: nothing beyond hop 1 answers → later rounds probe up to hop 1 + 3', async () => {
    const f = fakeRun(pathResponder(['192.168.0.1', null, null, null, null, null, null, null, null], '1.1.1.1'));
    const r = await runMacTtlProbes(plan(), {}, { run: f.run });
    expect(r.probes.filter((p) => p.round === 1)).toHaveLength(8);
    expect(r.probes.filter((p) => p.round === 3).map((p) => p.ttl)).toEqual([1, 2, 3, 4]);
    expect(buildTraceHops(r.probes, { silentTail: 2 }).reached).toBe(false);
  });

  it('traceroute6 without -I support: retried with UDP probes, remembered', async () => {
    const f = fakeRun((_file, args) =>
      args.includes('-I')
        ? { stderr: readText('traceroute6_illegal_option.txt'), code: 64 }
        : { stdout: ` ${argOf(args, '-f')}  2001:db8::1  5.0 ms\n` },
    );
    const r = await runMacTtlProbes(plan({ dst: '2606:4700:4700::1111', ttls: [1, 2], rounds: 1, maxConc: 1 }), {}, { run: f.run });
    expect(r.ok).toBe(true);
    expect(f.calls.map((c) => [c.file, c.args.includes('-I')])).toEqual([
      [MAC_TOOLS.traceroute6, true],
      [MAC_TOOLS.traceroute6, false],
      [MAC_TOOLS.traceroute6, false],
    ]);
    expect(r.probes.map((p) => p.kind)).toEqual(['ttl-expired', 'ttl-expired']);
  });

  it('missing tool: not ok, stops after the first batch', async () => {
    const f = fakeRun(() => ({ code: null, error: 'spawn /usr/sbin/traceroute ENOENT' }));
    const r = await runMacTtlProbes(plan(), {}, { run: f.run });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('/usr/sbin/traceroute: spawn /usr/sbin/traceroute ENOENT');
    expect(f.calls).toHaveLength(8);
  });

  it('a probe killed without output counts as lost; local unreachable as error', async () => {
    const f = fakeRun((_file, args) =>
      argOf(args, '-f') === 1 ? { timedOut: true, code: null } : { stdout: ' 2  192.168.0.43  3001.2 ms !H\n' },
    );
    const r = await runMacTtlProbes(plan({ ttls: [1, 2], rounds: 1 }), { isLocal: (ip) => ip === '192.168.0.43' }, { run: f.run });
    expect(r.probes.map((p) => p.kind)).toEqual(['lost', 'error']);
  });

  it('abort: no further probes, error "aborted"', async () => {
    const ac = new AbortController();
    const f = fakeRun((file, args) => {
      ac.abort();
      return pathResponder(PATH_V4, '1.1.1.1')(file, args);
    });
    const r = await runMacTtlProbes(plan({ maxConc: 1 }), { signal: ac.signal }, { run: f.run });
    expect(r.error).toBe('aborted');
    expect(r.complete).toBe(false);
    expect(f.calls).toHaveLength(1);
  });

  it('invalid destination', async () => {
    expect((await runMacTtlProbes(plan({ dst: 'example.com' }), {}, { run: fakeRun(() => ({})).run })).ok).toBe(false);
  });
});

describe('runMacTraceroute (sequential UDP fallback)', () => {
  it('builds hops from a full run', async () => {
    const f = fakeRun(() => ({ stdout: readText('traceroute_full_v4.txt') }));
    const r = await runMacTraceroute('1.1.1.1', 4, 30, {}, { run: f.run });
    expect(f.calls[0]).toEqual({ file: MAC_TOOLS.traceroute, args: ['-n', '-q', '3', '-w', '1', '-m', '30', '1.1.1.1'] });
    expect(r).toMatchObject({ ok: true, reached: true, error: null });
    expect(r.hops.map((h) => h.ip)).toEqual(['192.168.0.1', null, '92.79.214.92', '203.0.113.10', '198.51.100.33', '1.1.1.1']);
    expect(r.hops[4].lossPct).toBeCloseTo(33.33, 1);
  });

  it('router unreachable ends the trace', async () => {
    const f = fakeRun(() => ({ stdout: readText('traceroute_unreachable_v4.txt') }));
    const r = await runMacTraceroute('1.1.1.1', 4, 30, {}, { run: f.run });
    expect(r).toMatchObject({ ok: true, reached: false });
    expect(r.hops).toHaveLength(2);
  });

  it('IPv6 uses traceroute6; failures are reported', async () => {
    const f = fakeRun(() => ({ stderr: readText('traceroute6_illegal_option.txt'), code: 64 }));
    const r = await runMacTraceroute('2606:4700:4700::1111', 6, 30, {}, { run: f.run });
    expect(f.calls[0].file).toBe(MAC_TOOLS.traceroute6);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('/usr/sbin/traceroute6: unsupported arguments');
  });
});

describe('MTU probes', () => {
  it('classifies DF ping output', () => {
    expect(classifyMacDfPing(readText('ping_v4_df_1432_reply.txt'))).toBe('ok');
    expect(classifyMacDfPing(readText('ping_v4_df_1433_fragneeded.txt'))).toBe('too-big');
    expect(classifyMacDfPing(readText('ping_v4_df_1473_toolong.txt'))).toBe('too-big');
    expect(classifyMacDfPing(readText('ping6_df_toolong.txt'))).toBe('too-big');
    expect(classifyMacDfPing(readText('ping_v4_timeout.txt'))).toBe('timeout');
    expect(classifyMacDfPing(readText('ping_v4_host_unreachable.txt'))).toBe('error');
  });

  it('macDfProbe: IPv4 with -D, timeout by ping6 kill', async () => {
    const f = fakeRun((file) => (file === MAC_TOOLS.ping ? { stdout: readText('ping_v4_df_1433_fragneeded.txt'), code: 2 } : { timedOut: true, code: null }));
    expect(await macDfProbe(4, '1.1.1.1', 1433, {}, { run: f.run })).toBe('too-big');
    expect(f.calls[0].args).toContain('-D');
    expect(await macDfProbe(6, '2606:4700:4700::1111', 1452, {}, { run: f.run })).toBe('timeout');
    expect(await macDfProbe(4, 'not-an-ip', 1200, {}, { run: f.run })).toBe('error');
  });

  it('ping6 without -D: falls back to -m only and remembers it', async () => {
    const f = fakeRun((_file, args) => (args.includes('-D') ? { stderr: readText('ping6_illegal_option.txt'), code: 64 } : { stdout: readText('ping6_reply.txt') }));
    expect(macV6DontFragment()).toBe(true);
    expect(await macDfProbe(6, '2606:4700:4700::1111', 1452, {}, { run: f.run })).toBe('ok');
    expect(macV6DontFragment()).toBe(false);
    expect(await macDfProbe(6, '2606:4700:4700::1111', 1452, {}, { run: f.run })).toBe('ok');
    expect(f.calls.map((c) => c.args.includes('-D'))).toEqual([true, false, false]);
  });

  it('readMacPmtu: only learned host routes count', async () => {
    const out = (name: string) => fakeRun(() => ({ stdout: readText(name) })).run;
    expect(await readMacPmtu(4, '1.1.1.1', {}, { run: out('route_get_v4_pmtu.txt') })).toBe(1460);
    expect(await readMacPmtu(4, '1.1.1.1', {}, { run: out('route_get_v4.txt') })).toBeNull();
    expect(await readMacPmtu(4, '1.1.1.1', {}, { run: fakeRun(() => ({ stderr: readText('route_get_noroute.txt'), code: 1 })).run })).toBeNull();
    const f = fakeRun(() => ({ stdout: readText('route_get_v6.txt') }));
    await readMacPmtu(6, '2606:4700:4700::1111', {}, { run: f.run });
    expect(f.calls[0]).toEqual({ file: MAC_TOOLS.route, args: ['-n', 'get', '-inet6', '2606:4700:4700::1111'] });
  });

  it('macOS wording of the notes', async () => {
    const v4 = await measureFamilyMtu(4, async (p) => (p <= 1432 ? 'ok' : 'too-big'), async () => 1500, { wording: macMtuWording(() => true) });
    expect(v4.result).toMatchObject({ mtu: 1460, note: 'macOS-Routencache meldet 1500 Byte' });
    const v6df = await measureFamilyMtu(6, async () => 'ok', async () => null, { wording: macMtuWording(() => true) });
    expect(v6df.result).toMatchObject({ mtu: 1500, note: null });
    const v6frag = await measureFamilyMtu(6, async () => 'ok', async () => null, { wording: macMtuWording(() => false) });
    expect(v6frag.result.note).toMatch(/^IPv6 ohne DF-Bit: macOS fragmentiert selbst/);
    const win = await measureFamilyMtu(6, async () => 'ok', async () => null, { wording: WINDOWS_MTU_WORDING });
    expect(win.result.note).toMatch(/^IPv6 ohne DF-Bit: Windows fragmentiert selbst/);
  });
});

describe('platform dispatch in traceroute.ts', () => {
  it('runTtlProbes / runTracert use the BSD tools on macOS', async () => {
    setPlatformOverride('macos');
    const ttl = await runTtlProbes({ ...plan({ ttls: [1], rounds: 1 }) }, { timeoutMs: 15_000 });
    const tr = await runTracert('1.1.1.1', 4, 2);
    if (process.platform !== 'darwin') {
      // no BSD tools here: the spawn error names the macOS tool (proves the dispatch)
      expect(ttl.ok).toBe(false);
      expect(ttl.error).toContain('/usr/sbin/traceroute');
      expect(tr.ok).toBe(false);
    }
  });
});
