// Router password storage: DPAPI (current Windows user) via the PowerShell RPC worker.
// settings['router.password'] = 'dpapi:<hex blob from ConvertFrom-SecureString>'.
// The plaintext travels base64-encoded inside the command (no quoting issues) and back as base64.
// Never log scripts or PowerShell error texts of these calls – they could contain secret material.
import type { EngineDb, PowerShellHost, SecretStore } from '../core/types';

export const ROUTER_PASSWORD_KEY = 'router.password';
export const DPAPI_PREFIX = 'dpapi:';

const HEX = /^[0-9a-fA-F]+$/;
const B64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** PowerShell script that DPAPI-encrypts a base64 UTF-8 secret and prints the hex blob. */
export function protectScript(secretB64: string): string {
  if (!B64.test(secretB64)) throw new Error('invalid base64');
  return [
    `$p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${secretB64}'))`,
    '$s = ConvertTo-SecureString -String $p -AsPlainText -Force',
    '$p = $null',
    'ConvertFrom-SecureString -SecureString $s',
  ].join('; ');
}

/** PowerShell script that decrypts a DPAPI hex blob and prints the secret as base64 UTF-8. */
export function unprotectScript(hex: string): string {
  if (!HEX.test(hex)) throw new Error('invalid hex');
  return [
    `$s = ConvertTo-SecureString -String '${hex}'`,
    '$b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)',
    'try { $p = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }',
    '[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($p))',
  ].join('; ');
}

/** 'dpapi:<hex>' → hex, anything else → null */
export function parseStoredSecret(value: string | null): string | null {
  if (!value) return null;
  const v = value.trim();
  if (!v.startsWith(DPAPI_PREFIX)) return null;
  const hex = v.slice(DPAPI_PREFIX.length);
  return hex.length > 0 && HEX.test(hex) ? hex : null;
}

export class SecretStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretStoreError';
  }
}

export function createSecretStore(ps: PowerShellHost, db: EngineDb): SecretStore {
  // decrypted value cached per stored blob (re-decrypted when the setting changes)
  let cache: { stored: string; plain: string } | null = null;

  return {
    hasRouterPassword(): boolean {
      const v = db.getSetting(ROUTER_PASSWORD_KEY);
      return v !== null && v.trim() !== '';
    },

    async getRouterPassword(): Promise<string | null> {
      const stored = db.getSetting(ROUTER_PASSWORD_KEY);
      if (!stored || stored.trim() === '') return null;
      if (cache && cache.stored === stored) return cache.plain;
      const hex = parseStoredSecret(stored);
      if (!hex) throw new SecretStoreError('Gespeichertes Router-Passwort hat ein unbekanntes Format – bitte neu eingeben.');
      if (!ps.available) throw new SecretStoreError('Router-Passwort kann nicht entschlüsselt werden (PowerShell nicht verfügbar).');
      let out: string;
      try {
        out = (await ps.text(unprotectScript(hex), { timeoutMs: 15_000 })).trim();
      } catch {
        // deliberately no PowerShell error text (may echo parts of the command)
        throw new SecretStoreError('Router-Passwort konnte nicht entschlüsselt werden (anderer Windows-Benutzer?) – bitte neu eingeben.');
      }
      if (!B64.test(out)) throw new SecretStoreError('Router-Passwort konnte nicht entschlüsselt werden.');
      const plain = Buffer.from(out, 'base64').toString('utf8');
      cache = { stored, plain };
      return plain;
    },

    async setRouterPassword(password: string | null): Promise<void> {
      if (password === null || password === '') {
        db.setSetting(ROUTER_PASSWORD_KEY, null);
        cache = null;
        return;
      }
      if (!ps.available) throw new SecretStoreError('Router-Passwort kann nicht gespeichert werden (PowerShell nicht verfügbar).');
      const b64 = Buffer.from(password, 'utf8').toString('base64');
      let hex: string;
      try {
        hex = (await ps.text(protectScript(b64), { timeoutMs: 15_000 })).trim();
      } catch {
        throw new SecretStoreError('Router-Passwort konnte nicht verschlüsselt werden.');
      }
      if (!hex || !HEX.test(hex)) throw new SecretStoreError('Router-Passwort konnte nicht verschlüsselt werden.');
      const stored = `${DPAPI_PREFIX}${hex}`;
      db.setSetting(ROUTER_PASSWORD_KEY, stored);
      cache = { stored, plain: password };
    },
  };
}
