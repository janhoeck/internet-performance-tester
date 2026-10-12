import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SampleStatus } from '../../src/lib/shared/types';
import {
  AGENT_CONFIG_ENV,
  type AgentConfig,
  type AgentTarget,
  MAX_COMMAND_LINE,
  agentArgs,
  agentConfigKey,
  agentEnv,
  buildAgentScript,
  encodeAgentConfig,
  encodePowerShellCommand,
  mapAgentRtt,
  mapAgentStatus,
  minifyPowerShell,
  normalizeAddress,
  parseAgentLine,
  sanitizeAgentTargets,
} from './agent-protocol';
import { loadPingerTemplate } from './pinger';

const FIX = path.join(process.cwd(), 'fixtures', 'windows');
const OWN = new Set(['192.168.0.192', 'fe80::374c:2a6a:2786:ee2e', '3fff:8071:7ca0:c980:d8de:c10f:adb:ac10'].map(normalizeAddress));
const isOwn = (ip: string) => OWN.has(ip);

function cfg(targets: AgentTarget[], patch: Partial<AgentConfig> = {}): AgentConfig {
  return { targets, intervalMs: 1000, timeoutMs: 2000, size: 32, nics: ['Ethernet', 'WLAN'], preventSleep: true, ...patch };
}

describe('sanitizeAgentTargets', () => {
  it('keeps IP literals incl. IPv6 zone ids and drops invalid ids, hostnames and duplicates', () => {
    const out = sanitizeAgentTargets([
      { id: 'gw', ip: '192.168.0.1' },
      { id: 'gw6', ip: 'fe80::de73:6ff:fe12:34df%4' },
      { id: 'cf6', ip: '2606:4700:4700::1111' },
      { id: 'host', ip: 'dynamodb.eu-central-1.amazonaws.com' },
      { id: 'Bad Id', ip: '1.1.1.1' },
      { id: 'evil"', ip: '1.1.1.1' },
      { id: 'gw', ip: '192.168.0.2' },
      { id: 'ph', ip: '$isp6' },
    ]);
    expect(out.map((t) => t.id)).toEqual(['gw', 'gw6', 'cf6']);
    expect(out[0].ip).toBe('192.168.0.1');
  });
});

describe('config transport (environment variable)', () => {
  const c = cfg([{ id: 'cf4', ip: '1.1.1.1' }, { id: 'gw6', ip: 'fe80::de73:6ff:fe12:34df%4', every: 5, to: 3000 }], { ppid: 4242 });

  it('encodes the config as base64 UTF-8 JSON that round-trips', () => {
    const decoded: unknown = JSON.parse(Buffer.from(encodeAgentConfig(c), 'base64').toString('utf8'));
    expect(decoded).toEqual(c);
  });

  it('adds the config variable to the parent environment without dropping it', () => {
    const env = agentEnv(c, { SystemRoot: 'C:\\Windows', Path: 'C:\\Windows\\System32' });
    expect(env.SystemRoot).toBe('C:\\Windows');
    expect(env.Path).toBe('C:\\Windows\\System32');
    expect(env[AGENT_CONFIG_ENV]).toBe(encodeAgentConfig(c));
  });

  it('keeps the variable well below the 32767-char limit for the maximum of 64 targets', () => {
    const many = Array.from({ length: 64 }, (_, i) => ({
      id: `target-${String(i).padStart(2, '0')}-abcdefghijklmnopqr`.slice(0, 32),
      ip: `3fff:8071:7ca0:c980:d8de:c10f:adb:${(0xac10 + i).toString(16)}`,
      every: 10,
      to: 3000,
    }));
    const big = cfg(many, { nics: ['Ethernet', 'WLAN', 'Ethernet 2', 'WLAN 2', 'Ethernet 3', 'Ethernet 4', 'LAN 5', 'LAN 6'], ppid: 123456 });
    expect(encodeAgentConfig(big).length).toBeLessThan(MAX_COMMAND_LINE);
  });
});

describe('agent script (pinger.ps1)', () => {
  const template = loadPingerTemplate();

  it('minifies comments, indentation and blank lines', () => {
    expect(minifyPowerShell('# c\n  $a = 1\n\n\t# x\n  if ($a) { $b = 2 }\r\n')).toBe('$a = 1\nif ($a) { $b = 2 }');
    const min = buildAgentScript(template);
    expect(min.split('\n').some((l) => l.startsWith('#') || l !== l.trim() || l === '')).toBe(false);
    expect(min).toContain(AGENT_CONFIG_ENV);
    expect(min).toContain('SetThreadExecutionState');
    expect(min).toContain('SendPingAsync');
    expect(min).toContain('GetAllNetworkInterfaces');
  });

  it('avoids constructs the minifier would break (here-strings, block/trailing comments)', () => {
    expect(template).not.toMatch(/@'|@"|<#|#>/);
    for (const line of template.split(/\r?\n/)) {
      const t = line.trim();
      if (t.startsWith('#')) continue;
      // a '#' outside of a string would start a trailing comment
      expect(t.replace(/'[^']*'|"[^"]*"/g, '')).not.toContain('#');
    }
  });

  it('refuses a template that does not read the config variable', () => {
    expect(() => buildAgentScript('$x = 1')).toThrow(AGENT_CONFIG_ENV);
  });

  it('fits into the Windows command line independent of the number of targets', () => {
    const encoded = encodePowerShellCommand(buildAgentScript(template));
    const cmd = ['"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"', ...agentArgs(encoded)].join(' ');
    expect(cmd.length).toBeLessThan(MAX_COMMAND_LINE);
    expect(Buffer.from(encoded, 'base64').toString('utf16le')).toBe(buildAgentScript(template));
  });

  it('passes the documented powershell.exe arguments', () => {
    expect(agentArgs('QUJD')).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', 'QUJD']);
  });
});

describe('agentConfigKey', () => {
  const base = cfg([{ id: 'cf4', ip: '1.1.1.1' }, { id: 'gw', ip: '192.168.0.1' }]);

  it('ignores order, nic case and the parent pid', () => {
    const same = cfg([{ id: 'gw', ip: '192.168.0.1' }, { id: 'cf4', ip: '1.1.1.1', every: 1, to: 2000 }], { nics: ['wlan', 'ETHERNET'], ppid: 99 });
    expect(agentConfigKey(same)).toBe(agentConfigKey(base));
  });

  it('changes when a target, its interval/timeout, the NIC list or preventSleep change', () => {
    const k = agentConfigKey(base);
    expect(agentConfigKey(cfg([{ id: 'cf4', ip: '1.0.0.1' }, { id: 'gw', ip: '192.168.0.1' }]))).not.toBe(k);
    expect(agentConfigKey(cfg([{ id: 'cf4', ip: '1.1.1.1', every: 5 }, { id: 'gw', ip: '192.168.0.1' }]))).not.toBe(k);
    expect(agentConfigKey(cfg([{ id: 'cf4', ip: '1.1.1.1', to: 3000 }, { id: 'gw', ip: '192.168.0.1' }]))).not.toBe(k);
    expect(agentConfigKey(cfg([{ id: 'cf4', ip: '1.1.1.1' }]))).not.toBe(k);
    expect(agentConfigKey({ ...base, nics: ['Ethernet'] })).not.toBe(k);
    expect(agentConfigKey({ ...base, preventSleep: false })).not.toBe(k);
  });
});

describe('parseAgentLine', () => {
  it('parses icmp lines (IPStatus names, numeric codes, link-local sources)', () => {
    expect(parseAgentLine('{"k":"icmp","id":"cf4","ts":1791550457000,"st":"Success","rtt":17,"from":"1.1.1.1","err":null}')).toEqual({
      k: 'icmp', id: 'cf4', ts: 1791550457000, st: 'Success', rtt: 17, from: '1.1.1.1', err: null,
    });
    expect(parseAgentLine('{"k":"icmp","id":"x","ts":1,"st":11050,"rtt":null,"from":null,"err":null}')).toMatchObject({ st: '11050', rtt: null });
    expect(parseAgentLine('{"k":"icmp","id":"gw6","ts":1,"st":"Success","rtt":0,"from":"fe80::de73:6ff:fe12:34df%4","err":null}')).toMatchObject({
      from: 'fe80::de73:6ff:fe12:34df%4',
    });
    expect(parseAgentLine('{"k":"icmp","id":"doc","ts":1,"st":"Error","rtt":null,"from":null,"err":"PingException:-2146233079"}')).toMatchObject({
      st: 'Error', err: 'PingException:-2146233079',
    });
  });

  it('parses nic lines into NicTicks (mbps only while up)', () => {
    expect(parseAgentLine('{"k":"nic","ts":1000,"name":"Ethernet","up":true,"mbps":100,"rx":1597841801,"tx":88375540,"inErr":0,"inDisc":3,"wifi":false}')).toEqual({
      k: 'nic',
      tick: { ts: 1000, name: 'Ethernet', up: true, mbps: 100, rxBytes: 1597841801, txBytes: 88375540, rxErrors: 0, rxDiscards: 3, isWifi: false },
    });
    expect(parseAgentLine('{"k":"nic","ts":1000,"name":"WLAN","up":false,"mbps":null,"rx":0,"tx":0,"inErr":0,"inDisc":0,"wifi":true}')).toMatchObject({
      tick: { up: false, mbps: null, isWifi: true },
    });
    expect(parseAgentLine('{"k":"nic","ts":1000,"name":"Ethernet","up":false,"mbps":1000,"rx":5,"tx":6,"inErr":0,"inDisc":0,"wifi":false}')).toMatchObject({
      tick: { mbps: null },
    });
  });

  it('parses heartbeat, hello and warn lines', () => {
    expect(parseAgentLine('{"k":"hb","ts":1791550458000}')).toEqual({ k: 'hb', ts: 1791550458000 });
    expect(parseAgentLine('{"k":"hello","pid":20124,"sleep":true,"targets":5}')).toEqual({ k: 'hello', pid: 20124, sleep: true });
    expect(parseAgentLine('{"k":"warn","msg":"invalid address for target x"}')).toEqual({ k: 'warn', msg: 'invalid address for target x' });
  });

  it('rejects everything else without throwing', () => {
    for (const line of [
      '',
      'Ausnahme beim Aufrufen von "SendPingAsync"',
      '#< CLIXML',
      '{"k":"icmp","id":"x"}',
      '{"k":"hb"}',
      '{"k":"nic","ts":1,"name":"Ethernet"}',
      '{"k":"other","ts":1}',
      '[1,2]',
      '{broken',
    ]) {
      expect(parseAgentLine(line)).toBeNull();
    }
  });
});

describe('status mapping (ARCHITECTURE §4.5)', () => {
  it('maps IPStatus names', () => {
    expect(mapAgentStatus('Success', '1.1.1.1', isOwn)).toBe(SampleStatus.OK);
    expect(mapAgentStatus('TimedOut', '0.0.0.0', isOwn)).toBe(SampleStatus.TIMEOUT);
    expect(mapAgentStatus('TimedOut', '::', isOwn)).toBe(SampleStatus.TIMEOUT);
    expect(mapAgentStatus('DestinationHostUnreachable', '192.168.0.1', isOwn)).toBe(SampleStatus.UNREACHABLE);
    expect(mapAgentStatus('DestinationNetworkUnreachable', null, isOwn)).toBe(SampleStatus.UNREACHABLE);
    expect(mapAgentStatus('DestinationUnreachable', null, isOwn)).toBe(SampleStatus.UNREACHABLE);
    expect(mapAgentStatus('TtlExpired', '92.79.214.92', isOwn)).toBe(SampleStatus.TTL_EXPIRED);
    expect(mapAgentStatus('TimeExceeded', null, isOwn)).toBe(SampleStatus.TTL_EXPIRED);
    expect(mapAgentStatus('PacketTooBig', '192.168.0.1', isOwn)).toBe(SampleStatus.ERROR);
    expect(mapAgentStatus('Error', null, isOwn)).toBe(SampleStatus.ERROR);
    expect(mapAgentStatus('11050', null, isOwn)).toBe(SampleStatus.ERROR);
  });

  it('treats a failure reported by one of our own addresses as a local ARP/ND failure', () => {
    expect(mapAgentStatus('DestinationHostUnreachable', '192.168.0.192', isOwn)).toBe(SampleStatus.UNREACHABLE);
    expect(mapAgentStatus('TimedOut', '192.168.0.192', isOwn)).toBe(SampleStatus.UNREACHABLE);
    expect(mapAgentStatus('DestinationHostUnreachable', 'fe80::374c:2a6a:2786:ee2e%4', isOwn)).toBe(SampleStatus.UNREACHABLE);
    expect(mapAgentStatus('Success', '192.168.0.192', isOwn)).toBe(SampleStatus.OK);
  });

  it('stores sub-millisecond replies as 0.5 ms and drops RTTs of failures', () => {
    expect(mapAgentRtt('Success', 0)).toBe(0.5);
    expect(mapAgentRtt('Success', 17)).toBe(17);
    expect(mapAgentRtt('Success', 1234)).toBe(1234);
    expect(mapAgentRtt('Success', null)).toBeNull();
    expect(mapAgentRtt('Success', -1)).toBeNull();
    expect(mapAgentRtt('TimedOut', 0)).toBeNull();
  });

  it('normalizes addresses for own-address comparisons', () => {
    expect(normalizeAddress('FE80::374C:2A6A:2786:EE2E%4')).toBe(normalizeAddress('fe80::374c:2a6a:2786:ee2e'));
    expect(normalizeAddress('3fff:8071:7ca0:c980:d8de:c10f:adb:ac10/64')).toBe(normalizeAddress('3fff:8071:7ca0:c980:d8de:c10f:0adb:ac10'));
    expect(normalizeAddress(' 192.168.0.192 ')).toBe('192.168.0.192');
  });

  it('maps every status of the captured .NET pinger runs (fixtures)', () => {
    interface Rec { type: string; target?: string; status?: string; rtt?: number | null; from?: string | null }
    const stream = JSON.parse(fs.readFileSync(path.join(FIX, 'dotnet_pinger_stream.json'), 'utf8')) as { recs: Rec[] };
    const errors = fs
      .readFileSync(path.join(FIX, 'dotnet_pinger_error_cases.jsonl'), 'utf8')
      .split(/\r?\n/)
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l) as Rec);
    const echoes = [...stream.recs, ...errors].filter((r) => r.type === 'echo');
    expect(echoes.length).toBeGreaterThan(40);
    const seen = new Map<string, Set<number>>();
    for (const r of echoes) {
      const st = r.status ?? '';
      const code = mapAgentStatus(st, r.from ?? null, isOwn);
      seen.set(st, (seen.get(st) ?? new Set()).add(code));
      if (st === 'Success') {
        expect(code).toBe(SampleStatus.OK);
        expect(mapAgentRtt(st, r.rtt ?? null)).toBeGreaterThan(0);
      } else {
        expect(code).not.toBe(SampleStatus.OK);
        expect(mapAgentRtt(st, r.rtt ?? null)).toBeNull();
      }
    }
    expect([...(seen.get('TimedOut') ?? [])]).toEqual([SampleStatus.TIMEOUT]);
    expect([...(seen.get('Error') ?? [])]).toEqual([SampleStatus.ERROR]);
    // the ARP failure on 192.168.0.2 is reported by our own address or as plain host unreachable
    if (seen.has('DestinationHostUnreachable')) expect([...(seen.get('DestinationHostUnreachable') ?? [])]).toEqual([SampleStatus.UNREACHABLE]);
  });
});
