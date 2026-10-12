import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SampleStatus } from '../../types';
import { icmpErrorKind, macPingRtt, macPingStatus, parseMacPing } from './ping';

const readText = (name: string) => fs.readFileSync(new URL(`../../../../../fixtures/macos/${name}`, import.meta.url), 'utf8');

describe('parseMacPing', () => {
  it('IPv4 reply', () => {
    const r = parseMacPing(readText('ping_v4_reply.txt'), 4);
    expect(r).toMatchObject({ kind: 'reply', rtt: 12.345, from: '1.1.1.1', usage: false });
    expect(macPingStatus(r, 2000)).toBe(SampleStatus.OK);
    expect(macPingRtt(r, SampleStatus.OK)).toBe(12.345);
  });

  it('IPv6 reply with comma separator and zone id', () => {
    expect(parseMacPing(readText('ping6_reply.txt'), 6)).toMatchObject({ kind: 'reply', rtt: 11.876, from: '2606:4700:4700::1111' });
    expect(parseMacPing(readText('ping6_reply_linklocal.txt'), 6)).toMatchObject({ kind: 'reply', rtt: 0.612, from: 'fe80::de73:6ff:fe12:34df%en7' });
  });

  it('no answer → none → TIMEOUT; late reply → TIMEOUT', () => {
    const r = parseMacPing(readText('ping_v4_timeout.txt'));
    expect(r.kind).toBe('none');
    expect(macPingStatus(r, 2000)).toBe(SampleStatus.TIMEOUT);
    expect(macPingStatus(parseMacPing('40 bytes from 1.1.1.1: icmp_seq=0 ttl=57 time=2100.5 ms'), 2000)).toBe(SampleStatus.TIMEOUT);
    expect(parseMacPing('')).toMatchObject({ kind: 'none' });
  });

  it('ICMP host unreachable (header dump ignored)', () => {
    const r = parseMacPing(readText('ping_v4_host_unreachable.txt'));
    expect(r).toMatchObject({ kind: 'unreachable', from: '192.168.0.1', error: 'Destination Host Unreachable' });
    expect(macPingStatus(r, 2000)).toBe(SampleStatus.UNREACHABLE);
  });

  it('ARP/ND failures are local unreachable send errors', () => {
    const v4 = parseMacPing(readText('ping_v4_sendto_host_down.txt'));
    expect(v4).toMatchObject({ kind: 'send_error', error: 'Host is down', localUnreachable: true });
    expect(macPingStatus(v4, 2000)).toBe(SampleStatus.UNREACHABLE);
    const v6 = parseMacPing(readText('ping6_sendmsg_no_route.txt'), 6);
    expect(v6).toMatchObject({ kind: 'send_error', error: 'No route to host', localUnreachable: true });
  });

  it('other local errors → ERROR', () => {
    const r = parseMacPing("ping: sendto: Can't assign requested address");
    expect(r).toMatchObject({ kind: 'send_error', localUnreachable: false });
    expect(macPingStatus(r, 2000)).toBe(SampleStatus.ERROR);
    expect(parseMacPing('ping: cannot resolve foo: Unknown host')).toMatchObject({ kind: 'send_error', error: 'cannot resolve foo: Unknown host' });
  });

  it('TTL exceeded; an error from our own address is UNREACHABLE', () => {
    const r = parseMacPing(readText('ping_v4_ttl_exceeded.txt'));
    expect(r).toMatchObject({ kind: 'ttl_expired', from: '192.168.0.1' });
    expect(macPingStatus(r, 2000)).toBe(SampleStatus.TTL_EXPIRED);
    expect(macPingStatus(r, 2000, (ip) => ip === '192.168.0.1')).toBe(SampleStatus.UNREACHABLE);
  });

  it('DF probes: reply, fragmentation needed, message too long', () => {
    expect(parseMacPing(readText('ping_v4_df_1432_reply.txt'))).toMatchObject({ kind: 'reply', rtt: 13.002 });
    expect(parseMacPing(readText('ping_v4_df_1433_fragneeded.txt'))).toMatchObject({ kind: 'too_big', mtu: 1460, from: '192.168.0.1' });
    expect(parseMacPing(readText('ping_v4_df_1473_toolong.txt'))).toMatchObject({ kind: 'too_big', error: 'Message too long' });
    expect(parseMacPing(readText('ping6_df_toolong.txt'), 6)).toMatchObject({ kind: 'too_big' });
    expect(parseMacPing('16 bytes from fe80::1%en0: Packet too big mtu = 1280', 6)).toMatchObject({ kind: 'too_big', mtu: 1280 });
    expect(macPingStatus(parseMacPing(readText('ping_v4_df_1473_toolong.txt')), 1000)).toBe(SampleStatus.ERROR);
  });

  it('usage errors', () => {
    expect(parseMacPing(readText('ping6_illegal_option.txt'), 6)).toMatchObject({ kind: 'send_error', usage: true });
  });

  it('duplicate replies keep the first RTT', () => {
    const text = '40 bytes from 1.1.1.1: icmp_seq=0 ttl=57 time=12.0 ms\n40 bytes from 1.1.1.1: icmp_seq=0 ttl=57 time=15.0 ms (DUP!)';
    expect(parseMacPing(text).rtt).toBe(12);
  });

  it('a reply wins over an earlier error line', () => {
    expect(parseMacPing('ping: sendto: Host is down\n40 bytes from 192.168.0.1: icmp_seq=0 ttl=64 time=1.5 ms').kind).toBe('reply');
  });

  it('macPingRtt keeps sub-millisecond values and never returns 0', () => {
    expect(macPingRtt(parseMacPing('40 bytes from 192.168.0.1: icmp_seq=0 ttl=64 time=0.000 ms'), SampleStatus.OK)).toBe(0.001);
    expect(macPingRtt(parseMacPing('40 bytes from 192.168.0.1: icmp_seq=0 ttl=64 time=0.045 ms'), SampleStatus.OK)).toBe(0.045);
    expect(macPingRtt(parseMacPing(''), SampleStatus.TIMEOUT)).toBeNull();
  });
});

describe('icmpErrorKind', () => {
  it.each([
    ['Destination Net Unreachable', 'unreachable'],
    ['Destination Port Unreachable', 'unreachable'],
    ['Destination Host Prohibited', 'unreachable'],
    ['Communication prohibited by filter', 'unreachable'],
    ['Time to live exceeded', 'ttl_expired'],
    ['Frag needed and DF set (MTU 1460)', 'too_big'],
    ['Destination unreachable: Address unreachable', 'unreachable'],
  ])('%s → %s', (text, kind) => {
    expect(icmpErrorKind(text)?.kind).toBe(kind);
  });

  it('unknown texts', () => {
    expect(icmpErrorKind('Redirect Host(New addr: 192.168.0.2)')).toBeNull();
  });
});
