import { describe, expect, it } from 'vitest';
import { TestBus, fakeHosts } from './test-helpers';
import { HostCache, pendingText, targetAddress } from './resolve';

describe('targetAddress', () => {
  const hosts = fakeHosts(new TestBus(), { router6: 'fe80::de73:6ff:fe12:34df%4' });

  it('classifies placeholders, literals and hostnames', () => {
    expect(targetAddress(hosts, { host: '$gateway' })).toEqual({ kind: 'ip', ip: '192.168.0.1' });
    expect(targetAddress(hosts, { host: '$router6' })).toEqual({ kind: 'ip', ip: 'fe80::de73:6ff:fe12:34df%4' });
    expect(targetAddress(hosts, { host: '$isp6' })).toEqual({ kind: 'pending', placeholder: '$isp6' });
    expect(targetAddress(hosts, { host: '$unknown' })).toEqual({ kind: 'pending', placeholder: '$unknown' });
    expect(targetAddress(hosts, { host: ' 2606:4700:4700::1111 ' })).toEqual({ kind: 'ip', ip: '2606:4700:4700::1111' });
    expect(targetAddress(hosts, { host: 'dynamodb.eu-central-1.amazonaws.com' })).toEqual({
      kind: 'dns',
      host: 'dynamodb.eu-central-1.amazonaws.com',
    });
  });

  it('has German texts for pending placeholders', () => {
    expect(pendingText('$isp6')).toMatch(/Pfaderkennung/);
    expect(pendingText('$aftr')).toMatch(/AFTR/);
    expect(pendingText('$router6')).toMatch(/IPv6-Adresse des Routers/);
    expect(pendingText('$foo')).toBe('Adresse von „$foo“ noch unbekannt');
  });
});

describe('HostCache', () => {
  function cache(results: Record<string, string[] | Error>) {
    let now = 1_000_000;
    const calls: string[] = [];
    const c = new HostCache({
      now: () => now,
      lookup: async (host, family) => {
        calls.push(`${family}|${host}`);
        const r = results[`${family}|${host}`];
        if (r instanceof Error) throw r;
        return r ?? [];
      },
    });
    return { c, calls, advance: (ms: number) => (now += ms) };
  }

  it('caches positive answers for 5 minutes per family', async () => {
    const { c, calls, advance } = cache({ '4|aws.example': ['3.120.0.1', '3.120.0.2'], '6|aws.example': ['2a05:d014::1'] });
    expect(await c.resolve('aws.example', 4)).toBe('3.120.0.1');
    expect(await c.resolveAll('AWS.example', 4)).toEqual(['3.120.0.1', '3.120.0.2']);
    expect(await c.resolve('aws.example', 6)).toBe('2a05:d014::1');
    expect(calls).toEqual(['4|aws.example', '6|aws.example']);
    expect(c.peek('aws.example', 4)).toBe('3.120.0.1');
    advance(5 * 60_000 + 1);
    expect(c.peek('aws.example', 4)).toBeNull();
    await c.resolve('aws.example', 4);
    expect(calls).toHaveLength(3);
  });

  it('caches failures for 30 s with a German message', async () => {
    const { c, calls, advance } = cache({ '4|nix.invalid': Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }) });
    await expect(c.resolve('nix.invalid', 4)).rejects.toThrow('DNS-Auflösung fehlgeschlagen (ENOTFOUND)');
    await expect(c.resolve('nix.invalid', 4)).rejects.toThrow('DNS-Auflösung fehlgeschlagen (ENOTFOUND)');
    expect(calls).toHaveLength(1);
    advance(30_001);
    await expect(c.resolve('nix.invalid', 4)).rejects.toThrow();
    expect(calls).toHaveLength(2);
  });

  it('reports an empty answer and passes IP literals through', async () => {
    const { c, calls } = cache({ '6|v4only.example': [] });
    await expect(c.resolve('v4only.example', 6)).rejects.toThrow('DNS: keine IPv6-Adresse für v4only.example');
    expect(await c.resolve('1.1.1.1', 4)).toBe('1.1.1.1');
    expect(c.peek('1.1.1.1', 4)).toBe('1.1.1.1');
    expect(calls).toEqual(['6|v4only.example']);
  });

  it('deduplicates concurrent lookups', async () => {
    const { c, calls } = cache({ '4|a.example': ['1.2.3.4'] });
    const [x, y] = await Promise.all([c.resolve('a.example', 4), c.resolve('a.example', 4)]);
    expect([x, y]).toEqual(['1.2.3.4', '1.2.3.4']);
    expect(calls).toHaveLength(1);
  });
});
