import { describe, expect, it } from 'vitest';
import { ClientHistory } from './client-history';
import { T0, clientState } from './test-helpers';

describe('ClientHistory', () => {
  it('returns the state derived during (or shortly after) a tick, null when stale', () => {
    const h = new ClientHistory();
    for (let i = 0; i < 10; i++) h.push(clientState(T0 + i * 1000 + 300, { rxMbps: i }));
    expect(h.at(T0 + 5000)?.rxMbps).toBe(5); // derived 300 ms after the tick
    expect(h.at(T0 + 4000)?.rxMbps).toBe(4);
    expect(h.at(T0 - 2000)).toBeNull();
    expect(h.at(T0 + 9000 + 5300)?.rxMbps).toBe(9);
    expect(h.at(T0 + 9000 + 5301)).toBeNull(); // > 5 s old
  });

  it('ignores duplicates and older states', () => {
    const h = new ClientHistory();
    h.push(clientState(T0 + 1000, { rxMbps: 1 }));
    h.push(clientState(T0 + 1000, { rxMbps: 2 }));
    h.push(clientState(T0 + 500, { rxMbps: 3 }));
    h.push(null);
    expect(h.at(T0 + 1000)?.rxMbps).toBe(1);
    expect(h.latest?.rxMbps).toBe(1);
  });

  it('tracks the 60 s recovery window after the expected link came back', () => {
    const h = new ClientHistory();
    h.push(clientState(T0, {}));
    h.push(clientState(T0 + 1000, { linkUp: false, onExpected: false, egressV4If: 'WLAN' }));
    h.push(clientState(T0 + 7000, { linkUp: true, onExpected: false, egressV4If: 'WLAN' })); // relink
    h.push(clientState(T0 + 9000, { linkUp: true, onExpected: true })); // egress back on Ethernet
    expect(h.inRecovery(T0 + 5000)).toBe(false);
    expect(h.inRecovery(T0 + 7000)).toBe(true);
    expect(h.inRecovery(T0 + 67_000)).toBe(true);
    expect(h.inRecovery(T0 + 69_000)).toBe(true); // 60 s after the egress came back
    expect(h.inRecovery(T0 + 69_001)).toBe(false);
    h.clear();
    expect(h.inRecovery(T0 + 8000)).toBe(false);
    expect(h.at(T0 + 8000)).toBeNull();
  });
});
