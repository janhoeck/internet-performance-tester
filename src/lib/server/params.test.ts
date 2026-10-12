import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { HttpError, parseQuery } from './http';
import { METRIC_KEY_RE, resolveRange, zFamily, zFlag, zInt, zMetricKeyList, zTargetList, zTs } from './params';
import { DAY, HOUR } from './time';

const schema = z.object({ from: zTs, to: zTs, targets: zTargetList, keys: zMetricKeyList, flag: zFlag, family: zFamily, limit: zInt(1, 100) });
const q = (s: string) => parseQuery(schema, new URLSearchParams(s));

describe('query parameter schemas', () => {
  it('parses lists, numbers, flags and families', () => {
    expect(q('from=1000&to=2000&targets=gw,cf4,gw&keys=nic.link_mbps,udp.burst.cf4-udp.loss_pct&flag=ja&family=6&limit=7')).toEqual({
      from: 1000,
      to: 2000,
      targets: ['gw', 'cf4'],
      keys: ['nic.link_mbps', 'udp.burst.cf4-udp.loss_pct'],
      flag: true,
      family: 6,
      limit: 7,
    });
    expect(q('flag=0&targets=&from=')).toEqual({ flag: false });
  });

  it('throws HttpError(400) with a German message for invalid input', () => {
    for (const bad of ['targets=GW', 'targets=a;b', 'from=abc', 'limit=0', 'limit=1.5', 'family=5', 'flag=vielleicht', 'keys=Nic.Up']) {
      try {
        q(bad);
        expect.unreachable(bad);
      } catch (err) {
        expect(err).toBeInstanceOf(HttpError);
        expect((err as HttpError).status).toBe(400);
        expect((err as HttpError).message).toMatch(/^Ungültige Anfrage – /);
      }
    }
  });

  it('limits list length', () => {
    const many = Array.from({ length: 65 }, (_, i) => `t${i}`).join(',');
    expect(() => q(`targets=${many}`)).toThrow(/höchstens 64/);
  });

  it('metric key pattern', () => {
    expect(METRIC_KEY_RE.test('docsis.ds.snr_min')).toBe(true);
    expect(METRIC_KEY_RE.test('x'.repeat(81))).toBe(false);
    expect(METRIC_KEY_RE.test('.hidden')).toBe(false);
  });
});

describe('resolveRange', () => {
  const now = 1_791_564_000_000;
  it('defaults `to` to now and `from` to the default span', () => {
    expect(resolveRange({}, { defaultSpanMs: HOUR, maxSpanMs: DAY }, now)).toEqual({ from: now - HOUR, to: now });
    expect(resolveRange({ to: 5000 }, { defaultSpanMs: HOUR, maxSpanMs: DAY }, now)).toEqual({ from: 0, to: 5000 });
    expect(resolveRange({}, { defaultSpanMs: Number.POSITIVE_INFINITY, maxSpanMs: Number.POSITIVE_INFINITY }, now)).toEqual({ from: 0, to: now });
  });

  it('rejects inverted and oversized ranges in German', () => {
    expect(() => resolveRange({ from: 10, to: 10 }, { defaultSpanMs: HOUR, maxSpanMs: DAY }, now)).toThrow(/„from“ muss vor „to“/);
    expect(() => resolveRange({ from: 0, to: 3 * DAY }, { defaultSpanMs: HOUR, maxSpanMs: 2 * DAY }, now)).toThrow('Zeitraum zu groß (höchstens 2 Tage).');
  });
});
