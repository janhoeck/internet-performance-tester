import { describe, expect, it } from 'vitest';
import type { EngineDb, PowerShellHost } from '../core/types';
import { DPAPI_PREFIX, ROUTER_PASSWORD_KEY, createSecretStore, parseStoredSecret, protectScript, unprotectScript } from './secret-store';

/** Fake worker: "encrypts" by hex-encoding, records every script it got. */
function fakePs(opts: { fail?: boolean } = {}) {
  const scripts: string[] = [];
  const ps: PowerShellHost = {
    available: true,
    json: () => Promise.reject(new Error('not used')),
    text: (script: string) => {
      scripts.push(script);
      if (opts.fail) return Promise.reject(new Error(`Fehler in: ${script}`));
      const b64 = /FromBase64String\('([^']*)'\)/.exec(script)?.[1];
      if (b64 !== undefined) return Promise.resolve(Buffer.from(b64, 'base64').toString('hex'));
      const hex = /ConvertTo-SecureString -String '([0-9a-fA-F]+)'/.exec(script)?.[1];
      if (hex !== undefined) return Promise.resolve(`${Buffer.from(hex, 'hex').toString('base64')}\r\n`);
      return Promise.reject(new Error('unexpected script'));
    },
    dispose: () => undefined,
  };
  return { ps, scripts };
}

function fakeDb() {
  const settings = new Map<string, string>();
  const db = {
    getSetting: (k: string) => settings.get(k) ?? null,
    setSetting: (k: string, v: string | null) => (v === null ? settings.delete(k) : settings.set(k, v)),
  } as unknown as EngineDb;
  return { db, settings };
}

describe('secret store helpers', () => {
  it('builds scripts only from base64/hex input (no injection possible)', () => {
    expect(protectScript(Buffer.from("pa'ss$(calc)", 'utf8').toString('base64'))).toContain("FromBase64String('cGEnc3MkKGNhbGMp')");
    expect(() => protectScript("x'); calc; ('")).toThrow();
    expect(unprotectScript('01000000d08c')).toContain("ConvertTo-SecureString -String '01000000d08c'");
    expect(() => unprotectScript('01zz')).toThrow();
  });
  it('parses the stored setting', () => {
    expect(parseStoredSecret(`${DPAPI_PREFIX}0a0B`)).toBe('0a0B');
    expect(parseStoredSecret('klartext')).toBeNull();
    expect(parseStoredSecret('dpapi:')).toBeNull();
    expect(parseStoredSecret(null)).toBeNull();
  });
});

describe('createSecretStore', () => {
  it('round-trips a password without storing or sending it in plain text', async () => {
    const { ps, scripts } = fakePs();
    const { db, settings } = fakeDb();
    const store = createSecretStore(ps, db);
    expect(store.hasRouterPassword()).toBe(false);
    expect(await store.getRouterPassword()).toBeNull();
    const secret = "Pässwört' \"x\" $(calc) 😀";
    await store.setRouterPassword(secret);
    const stored = settings.get(ROUTER_PASSWORD_KEY) ?? '';
    expect(stored.startsWith(DPAPI_PREFIX)).toBe(true);
    expect(stored).not.toContain('Pässwört');
    expect(scripts.join('\n')).not.toContain('Pässwört');
    expect(store.hasRouterPassword()).toBe(true);
    // a fresh store (no cache) decrypts via the worker
    const again = createSecretStore(ps, db);
    expect(await again.getRouterPassword()).toBe(secret);
    await again.setRouterPassword(null);
    expect(settings.has(ROUTER_PASSWORD_KEY)).toBe(false);
    expect(again.hasRouterPassword()).toBe(false);
  });

  it('fails with German messages that never contain PowerShell output', async () => {
    const { db, settings } = fakeDb();
    settings.set(ROUTER_PASSWORD_KEY, 'klartext');
    await expect(createSecretStore(fakePs().ps, db).getRouterPassword()).rejects.toThrow(/unbekanntes Format/);
    settings.set(ROUTER_PASSWORD_KEY, 'dpapi:0011');
    const failing = createSecretStore(fakePs({ fail: true }).ps, db);
    await expect(failing.getRouterPassword()).rejects.toThrow(/anderer Windows-Benutzer/);
    await expect(failing.setRouterPassword('geheim')).rejects.toThrow(/nicht verschlüsselt/);
    await failing.getRouterPassword().catch((e: unknown) => expect(String(e)).not.toContain('Fehler in'));
  });
});
