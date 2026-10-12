import { describe, expect, it } from 'vitest';
import { createLogger } from './logger';
import type { EngineDb, PowerShellHost } from './types';
import {
  createMemorySecretStore,
  createUnavailablePowerShellHost,
  isPowerShellHost,
  isSecretStore,
  loadPowerShellHost,
  loadSecretStore,
  POWERSHELL_HOST_FILE,
  SECRET_STORE_FILE,
} from './windows';

function capture() {
  const lines: string[] = [];
  return { lines, log: createLogger({ level: 'debug', sink: (_l, line) => lines.push(line) }) };
}

const missing = (url: string) => {
  const err = Object.assign(new Error(`Cannot find module '${url}'`), { code: 'ERR_MODULE_NOT_FOUND' });
  return Promise.reject(err);
};

/** the loaders never touch the DB themselves – they only hand it to the factory */
const fakeDb = { path: 'test.db' } as unknown as EngineDb;

describe('PowerShell host loader', () => {
  it('falls back to an unavailable host whose calls reject (engine keeps running)', async () => {
    const { log, lines } = capture();
    const ps = await loadPowerShellHost(log, { importer: missing });
    expect(ps.available).toBe(false);
    await expect(ps.json('Get-Date')).rejects.toThrow('PowerShell-Worker nicht verfügbar');
    await expect(ps.text('Get-Date')).rejects.toThrow('PowerShell-Worker nicht verfügbar');
    expect(() => ps.dispose()).not.toThrow();
    expect(lines.some((l) => l.includes('WARN') && l.includes('PowerShell-Host nicht verfügbar'))).toBe(true);
  });

  it('creates the E-windows host with a scoped logger and the spawn hook', async () => {
    const { log, lines } = capture();
    const urls: string[] = [];
    let received: unknown = null;
    const real: PowerShellHost = { available: true, json: async <T>() => ({}) as T, text: async () => 'ok', dispose: () => undefined };
    const onSpawn = () => undefined;
    const ps = await loadPowerShellHost(log, {
      onSpawn,
      importer: async (url) => {
        urls.push(url);
        return {
          createPowerShellHost: (opts: unknown) => {
            received = opts;
            return real;
          },
        };
      },
    });
    expect(ps).toBe(real);
    expect(urls[0]).toMatch(/\/engine\/collectors\/powershell-host\.ts$/);
    expect(POWERSHELL_HOST_FILE).toBe('engine/collectors/powershell-host.ts');
    const opts = received as { log: { info(msg: string): void }; onSpawn: unknown };
    expect(opts.onSpawn).toBe(onSpawn);
    opts.log.info('Worker gestartet');
    expect(lines.at(-1)).toContain('INFO  powershell: Worker gestartet');
  });

  it('rejects factories that return something else', async () => {
    const { log } = capture();
    const ps = await loadPowerShellHost(log, { importer: async () => ({ createPowerShellHost: () => ({ available: true }) }) });
    expect(ps.available).toBe(false);
    const noExport = await loadPowerShellHost(log, { importer: async () => ({}) });
    expect(noExport.available).toBe(false);
  });
});

describe('secret store loader', () => {
  it('uses the E-windows DPAPI store with (ps, db)', async () => {
    const { log } = capture();
    const ps = createUnavailablePowerShellHost();
    let args: unknown[] = [];
    const store = await loadSecretStore(ps, fakeDb, log, async (url) => {
      expect(url).toMatch(/\/engine\/collectors\/secret-store\.ts$/);
      return {
        createSecretStore: (...a: unknown[]) => {
          args = a;
          return createMemorySecretStore();
        },
      };
    });
    expect(isSecretStore(store)).toBe(true);
    expect(args).toEqual([ps, fakeDb]);
    expect(SECRET_STORE_FILE).toBe('engine/collectors/secret-store.ts');
  });

  it('falls back to a memory-only store', async () => {
    const { log, lines } = capture();
    const store = await loadSecretStore(createUnavailablePowerShellHost(), fakeDb, log, missing);
    expect(store.hasRouterPassword()).toBe(false);
    await store.setRouterPassword('geheim');
    expect(store.hasRouterPassword()).toBe(true);
    expect(await store.getRouterPassword()).toBe('geheim');
    await store.setRouterPassword('');
    expect(store.hasRouterPassword()).toBe(false);
    expect(await store.getRouterPassword()).toBeNull();
    expect(lines.some((l) => l.includes('nur im Arbeitsspeicher'))).toBe(true);
    expect(lines.join('\n')).not.toContain('geheim');
  });
});

describe('type guards', () => {
  it('recognizes hosts and stores', () => {
    expect(isPowerShellHost(createUnavailablePowerShellHost())).toBe(true);
    expect(isPowerShellHost({ available: true, json: () => null })).toBe(false);
    expect(isSecretStore(createMemorySecretStore())).toBe(true);
    expect(isSecretStore(null)).toBe(false);
  });
});
