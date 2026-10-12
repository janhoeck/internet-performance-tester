import { describe, expect, it } from 'vitest';
import { ConsoleLineSplitter, decodeCp850 } from './cp850';
import {
  expandIPv6, ipFamily, isCgnatV4, isGlobalV6, isIPv4, isIPv6, isLinkLocalV6, isPrivateV4, isPublicV4, sameIp,
} from './net';

describe('ip helpers', () => {
  it('classifies IPv4', () => {
    expect(isIPv4('192.168.0.1')).toBe(true);
    expect(isIPv4('256.1.1.1')).toBe(false);
    expect(isPrivateV4('192.168.0.192')).toBe(true);
    expect(isCgnatV4('100.96.0.7')).toBe(true);
    expect(isPublicV4('92.79.214.92')).toBe(true);
    expect(isPublicV4('145.254.2.19')).toBe(true);
    expect(isPublicV4('192.0.0.1')).toBe(false);
    expect(isPublicV4('10.1.2.3')).toBe(false);
    expect(isPublicV4('100.64.1.1')).toBe(false);
  });

  it('classifies IPv6', () => {
    expect(isIPv6('2606:4700:4700::1111')).toBe(true);
    expect(isIPv6('fe80::de73:6ff:fe12:34df%4')).toBe(true);
    expect(isIPv6('1.1.1.1')).toBe(false);
    expect(isGlobalV6('2a00:0:cff:84a0::3')).toBe(true);
    expect(isGlobalV6('fe80::1')).toBe(false);
    expect(isGlobalV6('2001:db8::1')).toBe(false);
    expect(isLinkLocalV6('fe80::de73:6ff:fe12:34df')).toBe(true);
    expect(expandIPv6('2a00:0:cff:84a0::3')).toEqual(['2a00', '0000', '0cff', '84a0', '0000', '0000', '0000', '0003']);
    expect(sameIp('2606:4700:4700::1111', '2606:4700:4700:0:0:0:0:1111')).toBe(true);
    expect(ipFamily('8.8.8.8')).toBe(4);
    expect(ipFamily('2001:4860:4860::8888')).toBe(6);
    expect(ipFamily('example.com')).toBeNull();
  });
});

describe('cp850', () => {
  it('decodes German umlauts from ping output', () => {
    // "Zeitüberschreitung" as emitted by ping.exe (ü = 0x81)
    const bytes = Uint8Array.from([0x5a, 0x65, 0x69, 0x74, 0x81, 0x62, 0x65, 0x72]);
    expect(decodeCp850(bytes)).toBe('Zeitüber');
  });

  it('splits lines across chunks', () => {
    const s = new ConsoleLineSplitter();
    expect(s.push(Uint8Array.from([0x61, 0x0d]))).toEqual([]);
    expect(s.push(Uint8Array.from([0x0a, 0x62, 0x0d, 0x0a, 0x63]))).toEqual(['a', 'b']);
    expect(s.flush()).toBe('c');
  });
});
