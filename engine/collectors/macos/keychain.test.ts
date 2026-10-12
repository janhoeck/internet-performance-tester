import { afterEach, describe, expect, it } from 'vitest';
import type { EngineDb, PowerShellHost } from '../../core/types';
import { setPlatformOverride } from '../../platform';
import { ROUTER_PASSWORD_KEY, createSecretStore } from '../secret-store';
import type { RunOptions, RunResult } from '../util';
import { KEYCHAIN_VALUE, SEC_ITEM_NOT_FOUND, addPasswordCommand, createKeychainSecretStore, decodeKeychainOutput } from './keychain';

const result = (code: number, stdout = ''): RunResult => ({ code, stdout: Buffer.from(stdout), stderr: Buffer.alloc(0), timedOut: false, error: null, durationMs: 1 });

/** Fake /usr/bin/security with an in-memory keychain item. */
function fakeSecurity(opts: { ignoreAdd?: boolean; readCode?: number } = {}) {
  let item: Buffer | null = null;
  const calls: { file: string; args: string[]; input?: string }[] = [];
  const runner = {
    run(file: string, args: string[], o: RunOptions): Promise<RunResult> {
      calls.push({ file, args, input: o.input });
      if (args[0] === '-i') {
        const hex = /-X ([0-9a-f]+)\n$/.exec(o.input ?? '')?.[1];
        if (hex && !opts.ignoreAdd) item = Buffer.from(hex, 'hex');
        return Promise.resolve(result(0, 'security> '));
      }
      if (args[0] === 'find-generic-password') {
        if (opts.readCode !== undefined) return Promise.resolve(result(opts.readCode));
        return Promise.resolve(item ? result(0, `${item.toString('latin1')}\n`) : result(SEC_ITEM_NOT_FOUND));
      }
      if (args[0] === 'delete-generic-password') {
        const had = item !== null;
        item = null;
        return Promise.resolve(result(had ? 0 : SEC_ITEM_NOT_FOUND));
      }
      return Promise.resolve(result(1));
    },
  };
  return { runner, calls, item: () => item };
}

function fakeDb() {
  const settings = new Map<string, string>();
  const db = {
    getSetting: (k: string) => settings.get(k) ?? null,
    setSetting: (k: string, v: string | null) => (v === null ? settings.delete(k) : settings.set(k, v)),
  } as unknown as EngineDb;
  return { db, settings };
}

afterEach(() => setPlatformOverride(null));

describe('keychain helpers', () => {
  it('builds the stdin command from hex only', () => {
    const cmd = addPasswordCommand("pa'ss $(calc)");
    expect(cmd).toMatch(/^add-generic-password -U -a router\.password -s netzpuls\.router -l Netzpuls-Router -X [0-9a-f]+\n$/);
    expect(cmd).not.toContain('calc');
    expect(decodeKeychainOutput(`${Buffer.from('Pässwört', 'utf8').toString('base64')}\n`)).toBe('Pässwört');
    expect(decodeKeychainOutput('kein base64!')).toBeNull();
    expect(decodeKeychainOutput('')).toBeNull();
  });
});

describe('createKeychainSecretStore', () => {
  it('stores via stdin, verifies, reads back with a fresh store and deletes', async () => {
    const sec = fakeSecurity();
    const { db, settings } = fakeDb();
    const store = createKeychainSecretStore(db, sec.runner);
    expect(store.hasRouterPassword()).toBe(false);
    expect(await store.getRouterPassword()).toBeNull();
    const secret = "Pässwört' \"x\" $(calc) 😀";
    await store.setRouterPassword(secret);
    expect(settings.get(ROUTER_PASSWORD_KEY)).toBe(KEYCHAIN_VALUE);
    expect(store.hasRouterPassword()).toBe(true);
    for (const c of sec.calls) {
      expect(c.file).toBe('/usr/bin/security');
      expect(c.args.join(' ')).not.toContain('Pässwört');
    }
    expect(sec.calls[0].args).toEqual(['-i']);
    const fresh = createKeychainSecretStore(db, sec.runner);
    expect(await fresh.getRouterPassword()).toBe(secret);
    await fresh.setRouterPassword(null);
    expect(settings.has(ROUTER_PASSWORD_KEY)).toBe(false);
    expect(sec.item()).toBeNull();
    expect(sec.calls.at(-1)?.args[0]).toBe('delete-generic-password');
  });

  it('German errors: failed add, missing item, locked keychain, Windows blob', async () => {
    const { db, settings } = fakeDb();
    await expect(createKeychainSecretStore(db, fakeSecurity({ ignoreAdd: true }).runner).setRouterPassword('geheim')).rejects.toThrow(/nicht im Schlüsselbund gespeichert/);
    expect(settings.has(ROUTER_PASSWORD_KEY)).toBe(false);
    settings.set(ROUTER_PASSWORD_KEY, KEYCHAIN_VALUE);
    await expect(createKeychainSecretStore(db, fakeSecurity().runner).getRouterPassword()).rejects.toThrow(/fehlt im Schlüsselbund/);
    await expect(createKeychainSecretStore(db, fakeSecurity({ readCode: 51 }).runner).getRouterPassword()).rejects.toThrow(/gesperrt/);
    settings.set(ROUTER_PASSWORD_KEY, 'dpapi:0011');
    await expect(createKeychainSecretStore(db, fakeSecurity().runner).getRouterPassword()).rejects.toThrow(/stammt von Windows/);
  });

  it('createSecretStore picks the Keychain store on macOS', async () => {
    setPlatformOverride('macos');
    const { db, settings } = fakeDb();
    const ps = { available: false } as unknown as PowerShellHost;
    settings.set(ROUTER_PASSWORD_KEY, 'dpapi:0011');
    // the DPAPI store would complain about PowerShell; the Keychain store recognises the Windows blob
    await expect(createSecretStore(ps, db).getRouterPassword()).rejects.toThrow(/stammt von Windows/);
  });
});
