import { describe, expect, it } from 'vitest';
import type { DynamicHosts } from '../../src/lib/shared/types';
import { createBus } from './bus';
import { createHostRegistry, parsePersistedHosts, serializeHosts } from './hosts';
import { silentLogger } from './logger';

function setup(initial?: Partial<DynamicHosts>) {
  const log = silentLogger();
  const bus = createBus(log);
  const emitted: DynamicHosts[] = [];
  const persisted: string[] = [];
  bus.on('dynamicHosts', (h) => emitted.push(h));
  const reg = createHostRegistry({
    bus,
    log,
    gateway: '192.168.0.1',
    initial,
    persist: (h) => persisted.push(serializeHosts(h)),
  });
  return { reg, emitted, persisted };
}

describe('dynamic host registry', () => {
  it('resolves placeholders, IP literals and hostnames', () => {
    const { reg } = setup();
    expect(reg.resolve('$gateway')).toBe('192.168.0.1');
    expect(reg.resolve('$isp6')).toBeNull();
    expect(reg.resolve('$unknown')).toBeNull();
    expect(reg.resolve('1.1.1.1')).toBe('1.1.1.1');
    expect(reg.resolve('2606:4700:4700::1111')).toBe('2606:4700:4700::1111');
    expect(reg.resolve('dynamodb.eu-central-1.amazonaws.com')).toBe('dynamodb.eu-central-1.amazonaws.com');
  });

  it('emits and persists only on change', () => {
    const { reg, emitted, persisted } = setup();
    reg.set({ isp6: '2a02:8101:3ff:ff89::3', isp4: '92.79.214.92' }, 'traceroute');
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ gateway: '192.168.0.1', isp6: '2a02:8101:3ff:ff89::3', isp4: '92.79.214.92' });
    reg.set({ isp6: '2A02:8101:3FF:FF89::3' }, 'traceroute'); // same address, other case
    reg.set({}, 'traceroute');
    expect(emitted).toHaveLength(1);
    expect(persisted).toHaveLength(1);
    expect(reg.resolve('$isp4')).toBe('92.79.214.92');
  });

  it('accepts link-local addresses with zone id and clears with null', () => {
    const { reg, emitted } = setup();
    reg.set({ router6: 'fe80::de73:6ff:fe12:34df%4' }, 'adapter');
    expect(reg.resolve('$router6')).toBe('fe80::de73:6ff:fe12:34df%4');
    reg.set({ router6: 'fe80::de73:6ff:fe12:34df%5' }, 'adapter'); // zone change matters
    reg.set({ router6: null }, 'adapter');
    expect(reg.resolve('$router6')).toBeNull();
    expect(emitted).toHaveLength(3);
  });

  it('ignores invalid values (no hostnames for dynamic hosts)', () => {
    const { reg, emitted } = setup();
    reg.set({ aftr: 'easy.box' }, 'router');
    reg.set({ aftr: 42 as unknown as string }, 'router');
    expect(reg.get().aftr).toBeNull();
    expect(emitted).toHaveLength(0);
  });

  it('follows config.router.ip via $gateway and returns copies', () => {
    const { reg } = setup();
    reg.set({ gateway: '192.168.178.1' }, 'config');
    expect(reg.resolve('$gateway')).toBe('192.168.178.1');
    const copy = reg.get();
    copy.gateway = '10.0.0.1';
    expect(reg.get().gateway).toBe('192.168.178.1');
  });

  it('restores persisted hosts (gateway always from config)', () => {
    const json = serializeHosts({ gateway: '10.0.0.1', isp4: '92.79.214.92', isp6: '2a02:8101:3ff:ff89::3', aftr: '2a00:0:cff:84a0::3', router6: null });
    const restored = parsePersistedHosts(json);
    expect(restored).toEqual({ isp4: '92.79.214.92', isp6: '2a02:8101:3ff:ff89::3', aftr: '2a00:0:cff:84a0::3' });
    const { reg } = setup(restored);
    expect(reg.get()).toEqual({ gateway: '192.168.0.1', isp4: '92.79.214.92', isp6: '2a02:8101:3ff:ff89::3', aftr: '2a00:0:cff:84a0::3', router6: null });
    expect(parsePersistedHosts('{kaputt')).toEqual({});
    expect(parsePersistedHosts(JSON.stringify({ isp4: 'evil.example' }))).toEqual({});
  });
});
