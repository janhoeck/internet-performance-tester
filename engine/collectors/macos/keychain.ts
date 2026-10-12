// Router password storage on macOS: the login Keychain via /usr/bin/security (docs/research/macos.md §0).
// settings['router.password'] = 'keychain:v1' only marks that a password is stored. The secret goes
// to `security -i` on stdin – never on a command line (visible in `ps`) – as hex of base64(UTF-8),
// so no quoting is needed and `find-generic-password -w` prints plain base64 text.
// Never log commands, stdin or tool output of these calls. [unverified: `-X` of add-generic-password
// and the absence of a Keychain prompt for items created by /usr/bin/security]
import type { EngineDb, SecretStore } from '../../core/types';
import { ROUTER_PASSWORD_KEY, SecretStoreError } from '../secret-store';
import { ProcessRunner } from '../util';
import { type ToolRunner, runTool } from './tools';

export const KEYCHAIN_VALUE = 'keychain:v1';
export const KEYCHAIN_SERVICE = 'netzpuls.router';
export const KEYCHAIN_ACCOUNT = 'router.password';
const KEYCHAIN_LABEL = 'Netzpuls-Router';
const TIMEOUT_MS = 15_000;
/** `security` exit code for "The specified item could not be found in the keychain." */
export const SEC_ITEM_NOT_FOUND = 44;

const B64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** stdin line for `security -i` that creates/updates the item (hex payload only – no quoting issues). */
export function addPasswordCommand(password: string): string {
  const hex = Buffer.from(Buffer.from(password, 'utf8').toString('base64'), 'ascii').toString('hex');
  return `add-generic-password -U -a ${KEYCHAIN_ACCOUNT} -s ${KEYCHAIN_SERVICE} -l ${KEYCHAIN_LABEL} -X ${hex}\n`;
}

/** base64 text printed by `find-generic-password -w` → password; null when it is no base64. */
export function decodeKeychainOutput(stdout: string): string | null {
  const t = stdout.trim();
  if (t === '' || !B64.test(t)) return null;
  return Buffer.from(t, 'base64').toString('utf8');
}

export function createKeychainSecretStore(db: EngineDb, runner: ToolRunner = new ProcessRunner()): SecretStore {
  let cache: { stored: string; plain: string } | null = null;

  const read = async (): Promise<string | null> => {
    const r = await runTool(runner, 'security', ['find-generic-password', '-a', KEYCHAIN_ACCOUNT, '-s', KEYCHAIN_SERVICE, '-w'], {
      timeoutMs: TIMEOUT_MS,
      maxBytes: 64 * 1024,
    });
    if (r.error || r.timedOut) throw new SecretStoreError('Router-Passwort konnte nicht aus dem Schlüsselbund gelesen werden (security nicht verfügbar).');
    if (r.code === SEC_ITEM_NOT_FOUND) return null;
    if (r.code !== 0) throw new SecretStoreError('Router-Passwort konnte nicht aus dem Schlüsselbund gelesen werden (Schlüsselbund gesperrt?) – bitte neu eingeben.');
    const plain = decodeKeychainOutput(r.stdout.toString('utf8'));
    if (plain === null) throw new SecretStoreError('Router-Passwort im Schlüsselbund hat ein unbekanntes Format – bitte neu eingeben.');
    return plain;
  };

  const remove = async (): Promise<void> => {
    // "could not be found" (44) is fine – nothing to delete
    await runTool(runner, 'security', ['delete-generic-password', '-a', KEYCHAIN_ACCOUNT, '-s', KEYCHAIN_SERVICE], { timeoutMs: TIMEOUT_MS, maxBytes: 64 * 1024 });
  };

  return {
    hasRouterPassword(): boolean {
      const v = db.getSetting(ROUTER_PASSWORD_KEY);
      return v !== null && v.trim() !== '';
    },

    async getRouterPassword(): Promise<string | null> {
      const stored = db.getSetting(ROUTER_PASSWORD_KEY);
      if (!stored || stored.trim() === '') return null;
      if (cache && cache.stored === stored) return cache.plain;
      if (stored.trim() !== KEYCHAIN_VALUE) {
        throw new SecretStoreError(
          stored.trim().startsWith('dpapi:')
            ? 'Gespeichertes Router-Passwort stammt von Windows (DPAPI) – bitte unter macOS neu eingeben.'
            : 'Gespeichertes Router-Passwort hat ein unbekanntes Format – bitte neu eingeben.',
        );
      }
      const plain = await read();
      if (plain === null) throw new SecretStoreError('Router-Passwort fehlt im Schlüsselbund (anderer macOS-Benutzer?) – bitte neu eingeben.');
      cache = { stored, plain };
      return plain;
    },

    async setRouterPassword(password: string | null): Promise<void> {
      if (password === null || password === '') {
        db.setSetting(ROUTER_PASSWORD_KEY, null);
        cache = null;
        try {
          await remove();
        } catch {
          /* the setting is gone – a stale Keychain item is harmless */
        }
        return;
      }
      const r = await runTool(runner, 'security', ['-i'], { timeoutMs: TIMEOUT_MS, maxBytes: 64 * 1024, input: addPasswordCommand(password) });
      if (r.error || r.timedOut) throw new SecretStoreError('Router-Passwort konnte nicht im Schlüsselbund gespeichert werden (security nicht verfügbar).');
      // `security -i` exits 0 even when a command failed – read the item back to be sure
      let back: string | null;
      try {
        back = await read();
      } catch {
        back = null;
      }
      if (back !== password) throw new SecretStoreError('Router-Passwort konnte nicht im Schlüsselbund gespeichert werden.');
      db.setSetting(ROUTER_PASSWORD_KEY, KEYCHAIN_VALUE);
      cache = { stored: KEYCHAIN_VALUE, plain: password };
    },
  };
}
