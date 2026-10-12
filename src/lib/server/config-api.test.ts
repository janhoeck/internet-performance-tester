import { describe, expect, it } from 'vitest';
import { MAX_PASSWORD_LENGTH, ROUTER_ADDRESS_ERROR, isPrivateRouterAddress, parseConfigPut } from './config-api';

describe('isPrivateRouterAddress', () => {
  it.each(['192.168.0.1', ' 192.168.0.1 ', '10.0.0.138', '172.16.0.1', '172.31.255.254', '169.254.1.1', 'fe80::1', 'fe80::de73:6ff:fe12:34df%4', 'fd00::1', 'fc12:3456::1'])(
    'accepts %s',
    (ip) => expect(isPrivateRouterAddress(ip)).toBe(true),
  );

  it.each(['easy.box', 'kabel.box', '45.77.92.157', '8.8.8.8', '172.32.0.1', '100.64.0.1', '2a02:8071::1', '::1', '', '192.168.0.256', 'http://192.168.0.1'])(
    'rejects %s',
    (ip) => expect(isPrivateRouterAddress(ip)).toBe(false),
  );
});

describe('parseConfigPut', () => {
  it('separates the router password from the config patch', () => {
    const res = parseConfigPut({ tariff: { downMbps: 500 }, routerPassword: 'geheim' });
    expect(res).toEqual({ ok: true, value: { patch: { tariff: { downMbps: 500 } }, password: 'geheim' } });
  });

  it('treats missing/empty password as unchanged and null as delete', () => {
    expect(parseConfigPut({ routerPassword: '' })).toEqual({ ok: true, value: { patch: {}, password: undefined } });
    expect(parseConfigPut({})).toEqual({ ok: true, value: { patch: {}, password: undefined } });
    expect(parseConfigPut({ routerPassword: null })).toEqual({ ok: true, value: { patch: {}, password: null } });
  });

  it('strips the read-only hasPassword flag and trims the router address', () => {
    const res = parseConfigPut({ router: { ip: ' 192.168.0.1 ', hasPassword: true, loginEnabled: true } });
    expect(res).toEqual({ ok: true, value: { patch: { router: { ip: '192.168.0.1', loginEnabled: true } }, password: undefined } });
  });

  it('rejects public addresses and hostnames with a German message', () => {
    for (const ip of ['easy.box', '8.8.8.8', 42]) {
      const res = parseConfigPut({ router: { ip } });
      expect(res).toEqual({ ok: false, error: ROUTER_ADDRESS_ERROR });
    }
    expect(ROUTER_ADDRESS_ERROR).toContain('private IP-Adresse');
  });

  it('rejects malformed bodies', () => {
    expect(parseConfigPut(null)).toMatchObject({ ok: false });
    expect(parseConfigPut([1])).toMatchObject({ ok: false });
    expect(parseConfigPut({ router: 'x' })).toEqual({ ok: false, error: 'Ungültige Router-Einstellungen.' });
    expect(parseConfigPut({ routerPassword: 123 })).toEqual({ ok: false, error: 'Ungültiges Router-Passwort.' });
    expect(parseConfigPut({ routerPassword: 'x'.repeat(MAX_PASSWORD_LENGTH + 1) })).toMatchObject({ ok: false });
  });
});
