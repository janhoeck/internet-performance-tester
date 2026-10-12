import type { CpuInfo } from 'node:os';
import { describe, expect, it } from 'vitest';
import { cpuPct, cpuTimes, memPct, parseTcpCounters, retransPct, tcpMetrics } from './system';

const cpu = (user: number, sys: number, idle: number): CpuInfo => ({ model: 'x', speed: 1, times: { user, nice: 0, sys, idle, irq: 0 } });

describe('cpu / memory', () => {
  it('computes the busy share between two samples', () => {
    const a = cpuTimes([cpu(100, 50, 850), cpu(100, 50, 850)]);
    const b = cpuTimes([cpu(200, 100, 1700), cpu(150, 50, 1800)]);
    expect(a).toEqual({ idle: 1700, total: 2000 });
    // Δtotal 2000, Δidle 1800 → 10 %
    expect(cpuPct(a, b)).toBe(10);
    expect(cpuPct(null, b)).toBeNull();
    expect(cpuPct(b, b)).toBeNull();
  });
  it('computes memory usage', () => {
    expect(memPct(16e9, 4e9)).toBe(75);
    expect(memPct(0, 1)).toBeNull();
  });
});

describe('TCP retransmissions', () => {
  // two real Get-NdTcpCounters readings on Jan-PC (2026-10-09 ~18:47 and ~19:04)
  const a = parseTcpCounters({ t: 1791564409525, v4: { retrans: 100165, sent: 12413813 }, v6: { retrans: 87005, sent: 42412677 } }, 0);
  const b = parseTcpCounters({ t: 1791565469505, v4: { retrans: 101222, sent: 12540454 }, v6: { retrans: 88074, sent: 42540371 } }, 0);

  it('parses the PowerShell counters', () => {
    expect(a).toEqual({ ts: 1791564409525, v4: { retrans: 100165, sent: 12413813 }, v6: { retrans: 87005, sent: 42412677 } });
    expect(parseTcpCounters({ v4: null, v6: null }, 5)).toBeNull();
    expect(parseTcpCounters({ v4: { retrans: 1, sent: 2 } }, 5)).toEqual({ ts: 5, v4: { retrans: 1, sent: 2 }, v6: null });
  });

  it('Δretrans / Δsent with reset and noise guards', () => {
    expect(retransPct(a?.v4 ?? null, b?.v4 ?? null)).toBe(0.835); // 1057 / 126641
    expect(retransPct(a?.v6 ?? null, b?.v6 ?? null)).toBe(0.837); // 1069 / 127694
    expect(retransPct({ retrans: 10, sent: 1000 }, { retrans: 11, sent: 1050 })).toBeNull(); // < 100 segments
    expect(retransPct({ retrans: 10, sent: 1000 }, { retrans: 5, sent: 5000 })).toBeNull(); // counter reset (reboot)
    expect(retransPct(null, { retrans: 1, sent: 1 })).toBeNull();
  });

  it('emits tcp.* metrics only for plausible intervals', () => {
    if (!a || !b) throw new Error('parse failed');
    expect(tcpMetrics(a, b, 3_600_000)).toEqual([
      { ts: b.ts, key: 'tcp.retrans_pct', value: 0.835 },
      { ts: b.ts, key: 'tcp6.retrans_pct', value: 0.837 },
    ]);
    expect(tcpMetrics(a, b, 300_000)).toEqual([]); // gap (standby) → no rate
    expect(tcpMetrics(null, b, 300_000)).toEqual([]);
  });
});
