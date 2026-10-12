import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isUnreachableAnnotation, parseBsdTraceroute } from './traceroute';

const readText = (name: string) => fs.readFileSync(new URL(`../../../../../fixtures/macos/${name}`, import.meta.url), 'utf8');

const probe = (from: string | null, rttMs: number | null, annotation: string | null = null) => ({ from, rttMs, annotation, sendError: false });

describe('parseBsdTraceroute', () => {
  it('single-TTL runs (-q 1 -f T -m T)', () => {
    expect(parseBsdTraceroute(readText('traceroute_ttl1_v4.txt'))).toEqual({
      hops: [{ ttl: 1, probes: [probe('192.168.0.1', 1.204)] }],
      destination: '1.1.1.1',
      errors: [],
      usage: false,
    });
    expect(parseBsdTraceroute(readText('traceroute_ttl2_silent_v4.txt')).hops).toEqual([{ ttl: 2, probes: [probe(null, null)] }]);
    expect(parseBsdTraceroute(readText('traceroute_ttl9_dest_v4.txt')).hops).toEqual([{ ttl: 9, probes: [probe('1.1.1.1', 12.871)] }]);
  });

  it('IPv6 responder with zone id and the traceroute6 header', () => {
    const r = parseBsdTraceroute(readText('traceroute6_ttl1.txt'));
    expect(r.destination).toBe('2606:4700:4700::1111');
    expect(r.hops).toEqual([{ ttl: 1, probes: [probe('fe80::de73:6ff:fe12:34df%en7', 1.412)] }]);
  });

  it('full run: silent hop, alternating responders, lost probe in between', () => {
    const r = parseBsdTraceroute(readText('traceroute_full_v4.txt'));
    expect(r.hops.map((h) => h.ttl)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(r.hops[1].probes).toEqual([probe(null, null), probe(null, null), probe(null, null)]);
    expect(r.hops[3].probes).toEqual([probe('203.0.113.10', 11.201), probe('203.0.113.14', 11.876), probe('203.0.113.10', 11.402)]);
    // '*' between two times: the responder of the following time stays the same
    expect(r.hops[4].probes).toEqual([probe('198.51.100.33', 12.004), probe(null, null), probe('198.51.100.33', 12.311)]);
    expect(r.hops[5].probes.every((p) => p.from === '1.1.1.1')).toBe(true);
  });

  it('unreachable annotations', () => {
    const r = parseBsdTraceroute(readText('traceroute_unreachable_v4.txt'));
    expect(r.hops[1].probes).toEqual([probe('192.168.0.1', 3002.231, '!H'), probe('192.168.0.1', 3001.876, '!H'), probe('192.168.0.1', 3002.002, '!H')]);
    expect(['!H', '!N', '!P', '!S', '!F-1460', '!F', '!X', '!V', '!C', '!<10>', '!Z', '!A'].every(isUnreachableAnnotation)).toBe(true);
    expect(isUnreachableAnnotation('!')).toBe(false);
    expect(isUnreachableAnnotation(null)).toBe(false);
  });

  it('send failures in the middle of the hop line', () => {
    const r = parseBsdTraceroute(readText('traceroute_sendto_noroute_v4.txt'));
    expect(r.hops).toEqual([{ ttl: 1, probes: [1, 2, 3].map(() => ({ from: null, rttMs: null, annotation: null, sendError: true })) }]);
    expect(r.errors).toEqual(['sendto: No route to host', 'sendto: No route to host', 'sendto: No route to host']);
  });

  it('a failed send followed by successful probes of the same hop', () => {
    const text = ' 1 traceroute: wrote 1.1.1.1 52 chars, ret=-1\n *  192.168.0.1  1.234 ms  1.100 ms\n';
    expect(parseBsdTraceroute(text).hops[0].probes).toEqual([
      { from: null, rttMs: null, annotation: null, sendError: true },
      probe('192.168.0.1', 1.234),
      probe('192.168.0.1', 1.1),
    ]);
  });

  it('usage errors', () => {
    expect(parseBsdTraceroute(readText('traceroute6_illegal_option.txt'))).toMatchObject({ usage: true, hops: [] });
  });

  it('host names with addresses in parentheses (without -n)', () => {
    const r = parseBsdTraceroute(' 1  router.local (192.168.0.1)  1.234 ms  1.1 ms');
    expect(r.hops[0].probes).toEqual([probe('192.168.0.1', 1.234), probe('192.168.0.1', 1.1)]);
  });
});
