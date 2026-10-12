import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createLogger } from './core/logger';
import { importFailureReason, instantiate, loadModules, MODULES, type ModuleEntry, projectFileUrl } from './modules';

function capture() {
  const lines: string[] = [];
  return { lines, log: createLogger({ level: 'debug', sink: (_l, line) => lines.push(line) }) };
}

const ARCH_ORDER = [
  'system', 'identity', 'adapter', 'eventlog', 'wlan', 'vpn', 'router', 'probes', 'traceroute', 'mtr', 'mtu', 'stun',
  'speedtest', 'udpburst', 'incidents', 'classifier', 'rollup',
];

describe('module registry', () => {
  it('matches the order and files of ARCHITECTURE.md §4.3', () => {
    expect(MODULES.map((m) => m.name)).toEqual(ARCH_ORDER);
    const doc = fs.readFileSync(fileURLToPath(projectFileUrl('docs/ARCHITECTURE.md')), 'utf8');
    for (const m of MODULES) {
      expect(doc).toContain(`| ${m.name} | \`${m.factory}\` | ${m.file} |`);
    }
  });

  it('resolves project files relative to the repo root', () => {
    expect(projectFileUrl('engine/collectors/system.ts')).toMatch(/^file:\/\/\/.+\/engine\/collectors\/system\.ts$/);
    expect(fs.existsSync(fileURLToPath(projectFileUrl('engine/modules.ts')))).toBe(true);
  });
});

describe('loadModules', () => {
  const entry = (name: string): ModuleEntry => ({ name, factory: `create${name[0].toUpperCase()}${name.slice(1)}Module`, file: `engine/x/${name}.ts` });

  it('instantiates available modules in order and skips missing/broken ones', async () => {
    const { log, lines } = capture();
    const registry = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'].map(entry);
    const loaded = await loadModules(
      log,
      async (e) => {
        switch (e.name) {
          case 'alpha':
            return { createAlphaModule: () => ({ name: 'alpha', state: () => ({}) }) };
          case 'beta': {
            const err = new Error(`Cannot find module 'C:\\Projekt\\engine\\x\\beta.ts' imported from C:\\Projekt\\engine\\modules.ts`);
            Object.assign(err, { code: 'ERR_MODULE_NOT_FOUND' });
            throw err;
          }
          case 'gamma':
            return { somethingElse: 1 };
          case 'delta':
            return {
              createDeltaModule: () => {
                throw new Error('Konstruktor kaputt');
              },
            };
          default:
            return { createEpsilonModule: () => ({ name: 'eps', state: () => ({}) }) };
        }
      },
      registry,
    );
    expect(loaded.map((l) => [l.entry.name, l.module !== null])).toEqual([
      ['alpha', true], ['beta', false], ['gamma', false], ['delta', false], ['epsilon', true],
    ]);
    expect(loaded[1].error).toBe('Datei engine/x/beta.ts fehlt');
    expect(lines).toContain(lines.find((l) => l.includes('Modul beta nicht verfügbar: Datei engine/x/beta.ts fehlt')));
    expect(lines.some((l) => l.includes('Modul gamma nicht verfügbar: Export createGammaModule fehlt'))).toBe(true);
    expect(lines.some((l) => l.includes('Modul delta nicht verfügbar: Konstruktor kaputt'))).toBe(true);
    expect(lines.some((l) => l.includes('meldet den Namen „eps“'))).toBe(true);
    expect(lines.at(-1)).toContain('Module geladen: alpha, epsilon · nicht verfügbar: beta, gamma, delta');
  });

  it('distinguishes a missing dependency from a missing module file', () => {
    const e = entry('wlan');
    const dep = Object.assign(new Error("Cannot find module 'C:\\P\\src\\lib\\shared\\parsers\\netsh' imported from C:\\P\\engine\\x\\wlan.ts"), {
      code: 'ERR_MODULE_NOT_FOUND',
    });
    expect(importFailureReason(e, dep)).toBe("Abhängigkeit fehlt: C:\\P\\src\\lib\\shared\\parsers\\netsh");
    expect(importFailureReason(e, new SyntaxError('Unexpected token'))).toBe('Unexpected token');
  });

  it('rejects factories that do not return an EngineModule', () => {
    expect(() => instantiate(entry('alpha'), { createAlphaModule: () => ({ name: 'alpha' }) })).toThrow('kein gültiges Modul');
    expect(() => instantiate(entry('alpha'), null)).toThrow('Export createAlphaModule fehlt');
  });

  // imports (and transforms) every real module file – slow when the whole suite runs in parallel
  it('loads the real registry without throwing (modules may be missing during development)', { timeout: 60_000 }, async () => {
    const { log } = capture();
    const loaded = await loadModules(log);
    expect(loaded.map((l) => l.entry.name)).toEqual(ARCH_ORDER);
    for (const l of loaded) expect(l.module !== null || typeof l.error === 'string').toBe(true);
  });
});
