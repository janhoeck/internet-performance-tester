import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConsoleLineSplitter, decodeConsole } from '../cp850';
import { classifyTracertMessage, parseTracert, parseTracertColumn, parseTracertLine } from './tracert';

const FIX = path.resolve(__dirname, '../../../../fixtures/windows');
const read = (f: string) => fs.readFileSync(path.join(FIX, f));

describe('parseTracertColumn', () => {
  it('parses the three column variants', () => {
    expect(parseTracertColumn('   2 ms  ')).toBe(2);
    expect(parseTracertColumn('  <1 ms  ')).toBe(0.5);
    expect(parseTracertColumn('   *     ')).toBeNull();
    expect(parseTracertColumn('1000 ms')).toBe(1000);
  });
});

describe('parseTracertLine', () => {
  it('parses hop lines with fixed 9-char columns', () => {
    const l = parseTracertLine('  1     2 ms    <1 ms     1 ms  192.168.0.1 ');
    expect(l).toEqual({ kind: 'hop', hop: 1, rtts: [2, 0.5, 1], ip: '192.168.0.1', host: null, note: null, text: '192.168.0.1' });
    const t = parseTracertLine('  2     *        *        *     Zeitüberschreitung der Anforderung.');
    expect(t).toMatchObject({ kind: 'hop', hop: 2, rtts: [null, null, null], ip: null, note: 'timeout' });
    const p = parseTracertLine('  4    15 ms     *       18 ms  145.254.2.199 ');
    expect(p).toMatchObject({ kind: 'hop', hop: 4, rtts: [15, null, 18], ip: '145.254.2.199' });
  });

  it('handles IPv6 addresses, mis-decoded umlauts and English output', () => {
    expect(parseTracertLine('  6    21 ms    39 ms    52 ms  2400:cb00:48:3:: ')).toMatchObject({ ip: '2400:cb00:48:3::', rtts: [21, 39, 52] });
    // CP850 0x81 decoded as latin1 would give a C1 control char instead of ü
    expect(parseTracertLine('  2     *        *        *     Zeit\u0081berschreitung der Anforderung.')).toMatchObject({ note: 'timeout', ip: null });
    expect(parseTracertLine('  3     *        *        *     Request timed out.')).toMatchObject({ note: 'timeout' });
    expect(parseTracertLine('Tracing route to 1.1.1.1 over a maximum of 30 hops')).toEqual({ kind: 'header', target: '1.1.1.1', address: null, maxHops: 30 });
    expect(parseTracertLine('Trace complete.')).toEqual({ kind: 'end' });
  });

  it('parses "meldet"/"reports" unreachable lines and host [ip] remainders', () => {
    expect(parseTracertLine('  5    18 ms    16 ms    17 ms  10.0.0.1 meldet: Zielnetz nicht erreichbar.')).toMatchObject({
      hop: 5, ip: '10.0.0.1', note: 'net-unreachable',
    });
    expect(parseTracertLine('  5    18 ms    16 ms    17 ms  10.0.0.1 reports: Destination host unreachable.')).toMatchObject({
      ip: '10.0.0.1', note: 'host-unreachable',
    });
    expect(parseTracertLine('  1    <1 ms    <1 ms    <1 ms  kabel.box [192.168.0.1]')).toMatchObject({ ip: '192.168.0.1', host: 'kabel.box' });
    expect(parseTracertLine('Routenverfolgung zu one.one.one.one [1.1.1.1]')).toEqual({
      kind: 'header', target: 'one.one.one.one', address: '1.1.1.1', maxHops: null,
    });
    expect(parseTracertLine('über maximal 30 Hops:')).toEqual({ kind: 'header-hops', maxHops: 30 });
  });

  it('recognizes error lines', () => {
    expect(parseTracertLine('Der Zielname foo.invalid konnte nicht aufgelöst werden.')).toMatchObject({ kind: 'error', error: 'resolve' });
    expect(parseTracertLine('Unable to resolve target system name foo.invalid.')).toMatchObject({ kind: 'error', error: 'resolve' });
    expect(parseTracertLine('Übertragungsfehler: Fehlercode 1231.')).toMatchObject({ kind: 'error', error: 'transmit' });
    expect(classifyTracertMessage('Allgemeiner Fehler.')).toBe('general-failure');
  });
});

describe('parseTracert (real fixtures)', () => {
  it('parses the IPv4 run (UTF-8 text capture)', () => {
    const r = parseTracert(read('tracert_v4_1.1.1.1.txt').toString('utf8'));
    expect(r.target).toBe('1.1.1.1');
    expect(r.maxHops).toBe(30);
    expect(r.complete).toBe(true);
    expect(r.reached).toBe(true);
    expect(r.error).toBeNull();
    expect(r.hops.map((h) => h.ip)).toEqual([
      '192.168.0.1', null, '92.79.214.92', '145.254.2.199', '198.41.240.18', '198.41.240.9', '1.1.1.1',
    ]);
    expect(r.hops[0]).toMatchObject({ hop: 1, rtts: [2, 0.5, 1], lossPct: 0 });
    expect(r.hops[0].avgMs).toBeCloseTo(3.5 / 3, 6);
    expect(r.hops[1]).toMatchObject({ hop: 2, rtts: [null, null, null], lossPct: 100, avgMs: null });
    expect(r.hops[2].lossPct).toBeCloseTo(100 / 3, 6);
    expect(r.hops[4]).toMatchObject({ rtts: [18, null, null], avgMs: 18 });
  });

  it('parses the raw CP850 bytes exactly like the decoded text', () => {
    const raw = read('tracert_v4_1.1.1.1.raw.bin');
    const fromBytes = parseTracert(decodeConsole(raw));
    const fromText = parseTracert(read('tracert_v4_1.1.1.1.txt').toString('utf8'));
    expect(fromBytes).toEqual(fromText);
    // streamed through the line splitter in odd chunks (tracert writes partial lines)
    const split = new ConsoleLineSplitter();
    const lines: string[] = [];
    for (let i = 0; i < raw.length; i += 7) lines.push(...split.push(raw.subarray(i, i + 7)));
    const rest = split.flush();
    if (rest !== null) lines.push(rest);
    expect(parseTracert(lines.join('\n'))).toEqual(fromText);
  });

  it('parses the IPv6 run', () => {
    const r = parseTracert(decodeConsole(read('tracert_v6_cloudflare.raw.bin')));
    expect(r.target).toBe('2606:4700:4700::1111');
    expect(r.reached).toBe(true);
    expect(r.hops).toHaveLength(7);
    expect(r.hops[0].ip).toBe('3fff:8071:7ca0:c980:de73:6ff:fe12:34df');
    expect(r.hops[1]).toMatchObject({ ip: '2a02:8101:3ff:ff89::3', rtts: [16, 27, 13] });
    expect(r.hops[3]).toMatchObject({ ip: null, lossPct: 100 });
    expect(r.hops[6].ip).toBe('2606:4700:4700::1111');
  });

  it('reports router-signalled unreachability and incomplete runs', () => {
    const text = [
      '',
      'Routenverfolgung zu 203.0.113.9 über maximal 30 Hops',
      '',
      '  1     1 ms     1 ms     1 ms  192.168.0.1 ',
      '  2    12 ms    11 ms    13 ms  192.0.2.77 meldet: Zielhost nicht erreichbar.',
      '',
      'Ablaufverfolgung beendet.',
    ].join('\r\n');
    const r = parseTracert(text);
    expect(r.reached).toBe(false);
    expect(r.complete).toBe(true);
    expect(r.unreachable).toEqual({ hop: 2, ip: '192.0.2.77', note: 'host-unreachable' });
    expect(parseTracert('Der Zielname foo.invalid konnte nicht aufgelöst werden.').error).toMatch(/foo\.invalid/);
  });
});
