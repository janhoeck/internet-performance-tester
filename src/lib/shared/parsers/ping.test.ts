import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConsoleLineSplitter } from '../cp850';
import { SampleStatus } from '../types';
import { type PingLine, parsePingLine } from './ping';

const FIX = path.join(process.cwd(), 'fixtures', 'windows');

/** Decode a raw ping.exe capture (CP850 bytes) exactly like the fallback does. */
function rawLines(file: string): string[] {
  const splitter = new ConsoleLineSplitter();
  const lines = splitter.push(fs.readFileSync(path.join(FIX, file)));
  const rest = splitter.flush();
  return rest === null ? lines : [...lines, rest];
}

function textLines(file: string): string[] {
  return fs.readFileSync(path.join(FIX, file), 'utf8').split(/\r?\n/);
}

const OWN = ['192.168.0.192', 'fe80::374c:2a6a:2786:ee2e%4', '3fff:8071:7ca0:c980:d8de:c10f:adb:ac10'];

function parseAll(lines: string[]): PingLine[] {
  return lines.map((l) => parsePingLine(l, { ownAddresses: OWN }));
}

function counts(parsed: PingLine[]): Record<string, number> {
  const c: Record<string, number> = {};
  for (const p of parsed) c[p.kind] = (c[p.kind] ?? 0) + 1;
  return c;
}

describe('parsePingLine – real ping -t captures (raw CP850 bytes)', () => {
  const variants = ['fromBash', 'fromPwsh65001'];

  const ipv4Rtts: Record<string, number[]> = {
    fromBash: [22, 18, 19, 20, 42, 22, 21, 49, 17],
    fromPwsh65001: [25, 15, 17, 17, 27, 29, 18, 19, 15],
  };

  it.each(variants)('IPv4 1.1.1.1 (%s): replies with RTT and TTL', (v) => {
    const parsed = parseAll(rawLines(`ping_t_ipv4_1.1.1.1.${v}.raw.bin`));
    const echoes = parsed.filter((p) => p.echo);
    expect(counts(parsed).unknown).toBeUndefined();
    expect(counts(parsed).header).toBe(1);
    expect(echoes.length).toBe(9);
    expect(echoes.every((e) => e.kind === 'reply' && e.status === SampleStatus.OK)).toBe(true);
    expect(echoes.map((e) => e.rtt)).toEqual(ipv4Rtts[v]);
    expect(echoes[0]).toMatchObject({ ttl: 57, bytes: 32, from: '1.1.1.1', local: false });
  });

  it.each(variants)('IPv6 Cloudflare (%s): replies without TTL', (v) => {
    const parsed = parseAll(rawLines(`ping_t_ipv6_cloudflare.${v}.raw.bin`));
    const echoes = parsed.filter((p) => p.echo);
    expect(counts(parsed).unknown).toBeUndefined();
    expect(echoes.length).toBe(9);
    expect(echoes.every((e) => e.kind === 'reply' && e.ttl === null && e.bytes === null)).toBe(true);
    expect(echoes[0]).toMatchObject({
      kind: 'reply', status: SampleStatus.OK, rtt: v === 'fromBash' ? 15 : 18, from: '2606:4700:4700::1111',
    });
  });

  it.each(variants)('unresponsive 192.0.2.1 (%s): every echo is a timeout', (v) => {
    const parsed = parseAll(rawLines(`ping_t_unresponsive_192.0.2.1.${v}.raw.bin`));
    const echoes = parsed.filter((p) => p.echo);
    expect(counts(parsed).unknown).toBeUndefined();
    expect(echoes.length).toBe(6);
    expect(echoes.every((e) => e.kind === 'timeout' && e.status === SampleStatus.TIMEOUT && e.rtt === null)).toBe(true);
  });

  it.each(variants)('ARP failure 192.168.0.2 (%s): "Zielhost nicht erreichbar" from our own address is a loss', (v) => {
    const parsed = parseAll(rawLines(`ping_t_arpfail_192.168.0.2.${v}.raw.bin`));
    const echoes = parsed.filter((p) => p.echo);
    expect(counts(parsed).unknown).toBeUndefined();
    const unreachable = echoes.filter((e) => e.kind === 'unreachable');
    expect(unreachable.length).toBe(4);
    expect(echoes.filter((e) => e.kind === 'timeout').length).toBe(6);
    for (const u of unreachable) {
      expect(u).toMatchObject({ status: SampleStatus.UNREACHABLE, rtt: null, from: '192.168.0.192', local: true });
    }
    // Windows would count those as received – we count every echo except replies as lost
    expect(echoes.filter((e) => e.status !== SampleStatus.OK).length).toBe(echoes.length);
  });

  it('raw bytes and the decoded .cp850.txt fixtures classify identically', () => {
    for (const c of ['ipv4_1.1.1.1', 'ipv6_cloudflare', 'unresponsive_192.0.2.1', 'arpfail_192.168.0.2']) {
      const a = parseAll(rawLines(`ping_t_${c}.fromBash.raw.bin`)).map((p) => [p.kind, p.rtt]);
      const b = parseAll(textLines(`ping_t_${c}.fromBash.cp850.txt`))
        .slice(0, a.length)
        .map((p) => [p.kind, p.rtt]);
      expect(b).toEqual(a);
    }
  });

  it('code page captures (windowsHide true/false, chcp 65001) all decode as CP850', () => {
    for (const f of ['codepage_A_windowsHide_true.raw.bin', 'codepage_B_windowsHide_false.raw.bin', 'codepage_C_cmd_chcp65001_hidden.raw.bin']) {
      const parsed = parseAll(rawLines(f));
      expect(counts(parsed).unknown).toBeUndefined();
      expect(parsed.some((p) => p.kind === 'header')).toBe(true);
    }
  });
});

describe('parsePingLine – one-shot runs incl. statistics block', () => {
  it('success run: one reply, statistics lines are not echoes', () => {
    const parsed = parseAll(textLines('ping_n1_success_1.1.1.1.cp850.txt'));
    expect(counts(parsed)).toMatchObject({ header: 1, reply: 1, stats: 5 });
    expect(counts(parsed).unknown).toBeUndefined();
    expect(parsed.find((p) => p.echo)?.rtt).toBe(40);
  });

  it.each(['w500', 'w1000', 'w2000', 'w3000'])('timeout run %s', (w) => {
    const parsed = parseAll(textLines(`ping_n_timeout_${w}.cp850.txt`));
    expect(counts(parsed).unknown).toBeUndefined();
    expect(parsed.filter((p) => p.echo).every((p) => p.kind === 'timeout')).toBe(true);
    expect(parsed.some((p) => p.kind === 'stats')).toBe(true);
  });

  it('DF probes: "Paket müsste fragmentiert werden" is an error (local or from the router)', () => {
    const local = parseAll(textLines('ping_DF_1472_v4.txt')).filter((p) => p.echo);
    expect(local).toHaveLength(1);
    expect(local[0]).toMatchObject({ kind: 'too_big', status: SampleStatus.ERROR, from: null });
    const viaRouter = parseAll(textLines('ping_DF_1472_v4_8.8.8.8.txt')).filter((p) => p.echo);
    expect(viaRouter[0]).toMatchObject({ kind: 'too_big', status: SampleStatus.ERROR, from: '192.168.0.1', local: false });
    expect(parseAll(textLines('ping_DF_1473_v4.txt')).filter((p) => p.echo)[0].kind).toBe('too_big');
  });

  it('IPv6 large payloads: replies without TTL', () => {
    for (const [f, rtt] of [['ping_v6_1452.txt', 20], ['ping_v6_1453.txt', 51]] as const) {
      const echoes = parseAll(textLines(f)).filter((p) => p.echo);
      expect(echoes).toHaveLength(1);
      expect(echoes[0]).toMatchObject({ kind: 'reply', rtt, ttl: null });
    }
  });
});

describe('parsePingLine – message table lines (de-DE + en-US)', () => {
  const cases: [string, Partial<PingLine>][] = [
    ['Antwort von 192.168.0.1: Bytes=32 Zeit<1ms TTL=64', { kind: 'reply', rtt: 0.5, ttl: 64, status: SampleStatus.OK }],
    ['Reply from 192.168.0.1: bytes=32 time<1ms TTL=64', { kind: 'reply', rtt: 0.5, ttl: 64, bytes: 32 }],
    ['Reply from 1.1.1.1: bytes=32 time=18ms TTL=57', { kind: 'reply', rtt: 18, ttl: 57, from: '1.1.1.1' }],
    ['Reply from 2606:4700:4700::1111: time=15ms ', { kind: 'reply', rtt: 15, ttl: null, from: '2606:4700:4700::1111' }],
    ['Antwort von fe80::de73:6ff:fe12:34df%4: Zeit<1ms ', { kind: 'reply', rtt: 0.5, from: 'fe80::de73:6ff:fe12:34df%4' }],
    ['Request timed out.', { kind: 'timeout', status: SampleStatus.TIMEOUT }],
    ['Reply from 192.168.0.192: Destination host unreachable.', { kind: 'unreachable', status: SampleStatus.UNREACHABLE, local: true }],
    ['Antwort von 192.168.0.1: Zielnetz nicht erreichbar.', { kind: 'unreachable', status: SampleStatus.UNREACHABLE, local: false }],
    ['Reply from 10.0.0.1: Destination net unreachable.', { kind: 'unreachable', status: SampleStatus.UNREACHABLE }],
    ['Antwort von fe80::374c:2a6a:2786:ee2e%4: Zielhost nicht erreichbar.', { kind: 'unreachable', local: true }],
    ['Antwort von 92.79.214.92: Die Gültigkeitsdauer wurde bei der Übertragung überschritten.', { kind: 'ttl_expired', status: SampleStatus.TTL_EXPIRED, from: '92.79.214.92' }],
    ['Reply from 92.79.214.92: TTL expired in transit.', { kind: 'ttl_expired', status: SampleStatus.TTL_EXPIRED }],
    ['PING: Fehler bei der Übertragung. Allgemeiner Fehler.', { kind: 'failure', status: SampleStatus.ERROR }],
    ['PING: transmit failed. General failure.', { kind: 'failure', status: SampleStatus.ERROR }],
    ['Allgemeiner Fehler.', { kind: 'failure', status: SampleStatus.ERROR }],
    ['Hardware error.', { kind: 'failure', status: SampleStatus.ERROR }],
    ['Packet needs to be fragmented but DF set.', { kind: 'too_big', status: SampleStatus.ERROR }],
    ['Pinging 1.1.1.1 with 32 bytes of data:', { kind: 'header', echo: false }],
    ['Ping statistics for 1.1.1.1:', { kind: 'stats', echo: false }],
    ['    Packets: Sent = 4, Received = 4, Lost = 0 (0% loss),', { kind: 'stats' }],
    ['    Minimum = 16ms, Maximum = 17ms, Average = 16ms', { kind: 'stats' }],
    ['Approximate round trip times in milli-seconds:', { kind: 'stats' }],
    ['Ping-Anforderung konnte Host "nix.invalid" nicht finden. Überprüfen Sie den Namen.', { kind: 'resolve_failed', echo: false }],
    ['Ping request could not find host nix.invalid. Please check the name and try again.', { kind: 'resolve_failed' }],
    ['', { kind: 'blank', echo: false }],
    ['etwas ganz anderes', { kind: 'unknown', echo: false, status: null }],
  ];

  it.each(cases)('%s', (line, expected) => {
    expect(parsePingLine(line, { ownAddresses: OWN })).toMatchObject(expected);
  });

  it('survives a mangled umlaut (UTF-8 read as Latin-1)', () => {
    expect(parsePingLine('ZeitÃ¼berschreitung der Anforderung.').kind).toBe('timeout');
    expect(parsePingLine('Antwort von 1.2.3.4: Die GÃ¼ltigkeitsdauer wurde bei der Ãœbertragung Ã¼berschritten.').kind).toBe(
      'ttl_expired',
    );
  });

  it('marks nothing as local without a context', () => {
    expect(parsePingLine('Antwort von 192.168.0.192: Zielhost nicht erreichbar.').local).toBe(false);
  });
});
