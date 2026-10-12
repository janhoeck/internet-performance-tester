import { describe, expect, it } from 'vitest';
import { MAC_PLACEHOLDER, redactDeep, redactMacs } from './redact';

describe('redactMacs', () => {
  it('replaces colon, dash and Cisco style MACs', () => {
    expect(redactMacs('CM-MAC=a4:bb:6d:12:34:56;CMTS-MAC=00-01-5C-7A-BC-DE;')).toBe(`CM-MAC=${MAC_PLACEHOLDER};CMTS-MAC=${MAC_PLACEHOLDER};`);
    expect(redactMacs('dev 0001.5c7a.bcde up')).toBe(`dev ${MAC_PLACEHOLDER} up`);
  });

  it('leaves IPv6 addresses, mixed separators and longer hex runs alone', () => {
    const v6 = '2a02:8071:1234:5600:9c4e:1a2b:3c4d:5e6f';
    expect(redactMacs(`from ${v6} ok`)).toBe(`from ${v6} ok`);
    expect(redactMacs('fe80::de73:6ff:fe12:34df%4')).toBe('fe80::de73:6ff:fe12:34df%4');
    expect(redactMacs('a4:bb-6d:12:34:56')).toBe('a4:bb-6d:12:34:56');
    expect(redactMacs('aa:bb:cc:dd:ee:ff:00')).toBe('aa:bb:cc:dd:ee:ff:00');
  });

  it('deep-copies JSON values and redacts every string', () => {
    const input = { a: 'A4-BB-6D-12-34-56', list: [{ mac: 'b0:72:bf:12:34:03', n: 1 }], keep: null, flag: true };
    const out = redactDeep(input);
    expect(out).toEqual({ a: MAC_PLACEHOLDER, list: [{ mac: MAC_PLACEHOLDER, n: 1 }], keep: null, flag: true });
    expect(input.a).toBe('A4-BB-6D-12-34-56');
  });
});
