import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, DEFAULT_TARGETS, configSchema, mergeConfig } from './config';

describe('config', () => {
  it('defaults are valid', () => {
    expect(configSchema.safeParse(DEFAULT_CONFIG).success).toBe(true);
    const ids = DEFAULT_TARGETS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const t of DEFAULT_TARGETS) {
      if (t.pairId) expect(ids).toContain(t.pairId);
    }
  });

  it('merges partial config onto defaults', () => {
    const cfg = mergeConfig({ router: { ip: '192.168.0.2' }, tariff: { downMbps: 250 } });
    expect(cfg.router.ip).toBe('192.168.0.2');
    expect(cfg.router.username).toBe('admin');
    expect(cfg.tariff.downMbps).toBe(250);
    expect(cfg.targets.length).toBe(DEFAULT_TARGETS.length);
  });

  it('keeps stored targets and appends new builtin ones', () => {
    const custom = { ...DEFAULT_TARGETS[0], id: 'my-game', name: 'Mein Server', host: '203.0.113.5', builtin: false };
    const cfg = mergeConfig({ targets: [custom, { ...DEFAULT_TARGETS[1], enabled: false }] });
    expect(cfg.targets[0].id).toBe('my-game');
    expect(cfg.targets.find((t) => t.id === DEFAULT_TARGETS[1].id)?.enabled).toBe(false);
    expect(cfg.targets.length).toBe(DEFAULT_TARGETS.length + 1);
  });

  it('falls back per section on invalid input', () => {
    const cfg = mergeConfig({ router: { ip: '' }, tariff: { downMbps: 100 } });
    expect(cfg.router.ip).toBe(DEFAULT_CONFIG.router.ip);
    expect(cfg.tariff.downMbps).toBe(100);
  });

  it('never throws on garbage', () => {
    expect(() => mergeConfig('nonsense')).not.toThrow();
    expect(() => mergeConfig(null)).not.toThrow();
    expect(mergeConfig(42).router.ip).toBe(DEFAULT_CONFIG.router.ip);
  });
});
