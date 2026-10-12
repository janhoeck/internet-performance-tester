import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeProbeContext } from '../../probes/test-helpers';
import { createSystemModule, macTcpSource, tcpMetrics } from '../system';
import { FakeToolRunner, macFixture } from './fake-runner';
import { macTcpCountersFrom, readMacTcpCounters } from './system';
import { MAC_TOOLS } from './tools';

const NETSTAT_TCP = `${MAC_TOOLS.netstat} -s -p tcp`;

describe('macOS TCP counters', () => {
  afterEach(() => vi.useRealTimers());

  it('netstat -s -p tcp → v4 slot only', () => {
    expect(macTcpCountersFrom(macFixture('netstat_s_tcp.txt'), 9)).toEqual({ ts: 9, v4: { retrans: 2345, sent: 1234567 }, v6: null });
    expect(macTcpCountersFrom('tcp:\n', 9)).toBeNull();
  });

  it('two readings → tcp.retrans_pct only', () => {
    const a = macTcpCountersFrom(macFixture('netstat_s_tcp.txt'), 0);
    const b = macTcpCountersFrom(macFixture('netstat_s_tcp.txt').replace('1234567 packets sent', '1334567 packets sent').replace('2345 data packets', '2845 data packets'), 60_000);
    expect(tcpMetrics(a, b ?? { ts: 0, v4: null, v6: null }, 300_000)).toEqual([{ ts: 60_000, key: 'tcp.retrans_pct', value: 0.5 }]);
  });

  it('runs netstat with the C locale; failures become German errors', async () => {
    const r = new FakeToolRunner({ [NETSTAT_TCP]: { stdout: macFixture('netstat_s_tcp.txt') } });
    expect((await readMacTcpCounters(r, 1))?.v4).toEqual({ retrans: 2345, sent: 1234567 });
    expect(r.calls[0].opts.env?.LC_ALL).toBe('C');
    await expect(readMacTcpCounters(new FakeToolRunner(), 1)).rejects.toThrow('netstat: nicht gefunden');
  });

  it('system module records tcp.retrans_pct from the macOS source', async () => {
    let sent = 1_234_567;
    let retrans = 2345;
    const r = new FakeToolRunner({
      [NETSTAT_TCP]: () => {
        const text = `tcp:\n\t${sent} packets sent\n\t\t${retrans} data packets (1 bytes) retransmitted\n`;
        sent += 1000;
        retrans += 10;
        return { stdout: text };
      },
    });
    vi.useFakeTimers();
    const fake = fakeProbeContext();
    const mod = createSystemModule({ createTcpSource: () => macTcpSource(r) });
    mod.init?.(fake.ctx);
    mod.start?.();
    await vi.advanceTimersByTimeAsync(1000); // first reading
    await vi.advanceTimersByTimeAsync(60_000); // second reading → rate
    mod.stop?.();
    expect(r.calls).toHaveLength(2);
    expect(mod.state().lastError).toBeNull();
    expect(fake.metrics.filter((m) => m.key.startsWith('tcp'))).toEqual([{ ts: expect.any(Number), key: 'tcp.retrans_pct', value: 1 }]);
    mod.dispose?.();
    expect(r.killed).toBe(1);
  });
});
