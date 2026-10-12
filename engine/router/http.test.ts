// Tests for the router HTTP client: private-address policy, cookie jar, redirect handling, timeouts.
import { describe, expect, it, vi } from 'vitest';
import {
  CookieJar,
  HttpError,
  HttpSession,
  isAllowedRouterAddress,
  type HttpTransport,
  type TransportResponse,
} from './http';

describe('isAllowedRouterAddress', () => {
  it('allows RFC1918 + link-local literals', () => {
    for (const ip of ['192.168.0.1', '10.0.0.1', '172.16.0.1', '169.254.1.1', 'fe80::1', 'fe80::de73:6ff:fe12:34df%4']) {
      expect(isAllowedRouterAddress(ip)).toBe(true);
    }
  });
  it('refuses public IPs, hostnames and global IPv6', () => {
    for (const h of ['8.8.8.8', '1.1.1.1', 'easy.box', 'kabel.box', 'router.local', '2a02:908::1', '']) {
      expect(isAllowedRouterAddress(h)).toBe(false);
    }
  });
});

describe('HttpSession host policy', () => {
  it('refuses to be constructed for a non-private host', () => {
    expect(() => new HttpSession({ host: '8.8.8.8' })).toThrow(HttpError);
    expect(() => new HttpSession({ host: 'easy.box' })).toThrow(/private Router-Adresse/);
  });

  it('builds the origin (brackets for IPv6, port only when not 80)', () => {
    expect(new HttpSession({ host: '192.168.0.1' }).origin).toBe('http://192.168.0.1');
    expect(new HttpSession({ host: '192.168.0.1', port: 8080 }).origin).toBe('http://192.168.0.1:8080');
    expect(new HttpSession({ host: 'fe80::1%4' }).origin).toBe('http://[fe80::1%254]');
  });
});

describe('CookieJar', () => {
  it('stores, reads, expires and clears cookies', () => {
    const jar = new CookieJar();
    jar.store('PHPSESSID=abc; path=/; HttpOnly');
    jar.store('credential=xyz; path=/');
    expect(jar.get('PHPSESSID')).toBe('abc');
    expect(jar.header()).toContain('PHPSESSID=abc');
    expect(jar.header()).toContain('credential=xyz');
    // expiry via max-age ≤ 0
    jar.store('credential=; Max-Age=0');
    expect(jar.get('credential')).toBeNull();
    jar.clear();
    expect(jar.header()).toBeNull();
  });

  it('accepts an array of Set-Cookie headers', () => {
    const jar = new CookieJar();
    jar.store(['a=1', 'b=2']);
    expect(jar.header()).toBe('a=1; b=2');
  });
});

function transportOf(responses: TransportResponse[]): { transport: HttpTransport; paths: string[] } {
  const paths: string[] = [];
  let i = 0;
  const transport: HttpTransport = (req) => {
    paths.push(req.path);
    return Promise.resolve(responses[Math.min(i++, responses.length - 1)]);
  };
  return { transport, paths };
}

describe('HttpSession requests', () => {
  it('stores Set-Cookie and sends it back on the next request', async () => {
    const { transport, paths } = transportOf([
      { status: 200, headers: { 'set-cookie': 'PHPSESSID=abc; path=/' }, body: 'ok' },
      { status: 200, headers: {}, body: 'ok2' },
    ]);
    const spy = vi.fn(transport);
    const s = new HttpSession({ host: '192.168.0.1', transport: spy });
    await s.get('/');
    await s.get('/php/x');
    expect(paths).toEqual(['/', '/php/x']);
    const secondHeaders = spy.mock.calls[1][0].headers;
    expect(secondHeaders.Cookie).toBe('PHPSESSID=abc');
  });

  it('follows a same-host redirect but blocks a redirect to a public host', async () => {
    const good = transportOf([
      { status: 302, headers: { location: '/landing' }, body: '' },
      { status: 200, headers: {}, body: 'done' },
    ]);
    const s1 = new HttpSession({ host: '192.168.0.1', transport: good.transport });
    const r = await s1.get('/');
    expect(r.status).toBe(200);
    expect(good.paths).toEqual(['/', '/landing']);

    const bad = transportOf([{ status: 302, headers: { location: 'http://8.8.8.8/evil' }, body: '' }]);
    const s2 = new HttpSession({ host: '192.168.0.1', transport: bad.transport });
    await expect(s2.get('/')).rejects.toThrow(/blockiert/);
  });

  it('stops following redirects after maxRedirects', async () => {
    const loop: HttpTransport = () => Promise.resolve({ status: 302, headers: { location: '/again' }, body: '' });
    const s = new HttpSession({ host: '192.168.0.1', transport: loop, maxRedirects: 2 });
    const r = await s.get('/');
    expect(r.status).toBe(302); // gave up, returns the last redirect response
  });

  it('a POST is not redirected', async () => {
    const { transport, paths } = transportOf([
      { status: 302, headers: { location: '/elsewhere' }, body: '' },
    ]);
    const s = new HttpSession({ host: '192.168.0.1', transport });
    const r = await s.post('/php/login');
    expect(r.status).toBe(302);
    expect(paths).toEqual(['/php/login']);
  });

  it('aborting rejects in-flight and future requests', async () => {
    const slow: HttpTransport = () => new Promise(() => undefined);
    const s = new HttpSession({ host: '192.168.0.1', transport: slow });
    s.abort();
    await expect(s.get('/')).rejects.toThrow(/abgebrochen/);
  });
});
