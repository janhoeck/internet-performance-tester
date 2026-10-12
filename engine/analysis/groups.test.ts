import { describe, expect, it } from 'vitest';
import type { TargetConfig } from '../../src/lib/shared/types';
import { GroupCache, resolveGroups } from './groups';
import { testConfig } from './test-helpers';

const icmp = (id: string, family: 4 | 6, segment: TargetConfig['segment'], extra: Partial<TargetConfig> = {}): TargetConfig => ({
  id, name: id, host: id, family, kind: 'icmp', segment, intervalMs: 1000, timeoutMs: 2000, enabled: true, builtin: false, ...extra,
});

describe('resolveGroups', () => {
  it('finds the default reference groups', () => {
    const g = resolveGroups(testConfig());
    expect(g.gw).toEqual(['gw', 'gw6']);
    expect(g.isp6).toEqual(['isp6']);
    expect(g.v4).toEqual(['cf4', 'g4']);
    expect(g.v6).toEqual(['cf6', 'g6']);
    expect(g.game).toEqual(['aws-fra', 'aws-irl']);
    expect(g.internet).toEqual(['cf4', 'cf6', 'g4', 'g6']);
    expect(g.provider).toEqual(['aftr', 'isp4']);
    expect(g.icmp.has('q4')).toBe(true); // disabled, but still an ICMP target id
    expect(g.icmp.has('cf4-udp')).toBe(false);
  });

  it('includes enabled dual-stack pairs and ignores disabled targets', () => {
    const g = resolveGroups(
      testConfig((c) => {
        for (const t of c.targets) {
          if (t.id === 'q4' || t.id === 'q6') t.enabled = true;
          if (t.id === 'g6' || t.id === 'gw6') t.enabled = false;
        }
      }),
    );
    expect(g.v4).toEqual(['cf4', 'q4']); // g4 lost its counterpart
    expect(g.v6).toEqual(['cf6', 'q6']);
    expect(g.internet).toEqual(['cf4', 'cf6', 'g4', 'q4', 'q6']); // config order
    expect(g.gw).toEqual(['gw']);
  });

  it('works with renamed targets via segment, family and pairId (declared on one side only)', () => {
    const cfg = testConfig((c) => {
      c.targets = [
        icmp('router', 4, 'lan'),
        icmp('cmts', 6, 'docsis'),
        icmp('a4', 4, 'internet'),
        icmp('a6', 6, 'internet', { pairId: 'a4' }),
        icmp('solo4', 4, 'internet'),
        { ...icmp('game1', 4, 'game'), kind: 'tcp', port: 443, intervalMs: 10_000 },
      ];
    });
    const g = resolveGroups(cfg);
    expect(g.gw).toEqual(['router']);
    expect(g.isp6).toEqual(['cmts']);
    expect(g.v4).toEqual(['a4']);
    expect(g.v6).toEqual(['a6']);
    expect(g.internet).toEqual(['a4', 'a6', 'solo4']);
    expect(g.game).toEqual(['game1']);
    expect(g.icmp.has('game1')).toBe(false);
  });

  it('falls back to family groups when no pairs exist', () => {
    const cfg = testConfig((c) => {
      c.targets = [icmp('x4', 4, 'internet'), icmp('y4', 4, 'internet'), icmp('x6', 6, 'internet')];
    });
    const g = resolveGroups(cfg);
    expect(g.v4).toEqual(['x4', 'y4']);
    expect(g.v6).toEqual(['x6']);
  });

  it('caches per config object', () => {
    const cache = new GroupCache();
    const a = testConfig();
    expect(cache.get(a)).toBe(cache.get(a));
    expect(cache.get(testConfig())).not.toBe(cache.get(a));
  });
});
