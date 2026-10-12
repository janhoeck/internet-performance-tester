// macOS TCP retransmission counters (docs/research/macos.md §0): `netstat -s -p tcp`. macOS keeps one
// TCP statistic for IPv4 and IPv6, so only the v4 slot is filled (→ metric tcp.retrans_pct).
import { parseNetstatTcp } from '../../../src/lib/shared/parsers/macos/netstat';
import type { TcpCounters } from '../system';
import { type ToolRunner, runTool, toolText } from './tools';

/** `netstat -s -p tcp` output → counters (null when the lines are missing). Pure. */
export function macTcpCountersFrom(text: string, now: number): TcpCounters | null {
  const s = parseNetstatTcp(text);
  return s ? { ts: now, v4: { retrans: s.retransmitted, sent: s.sent }, v6: null } : null;
}

export async function readMacTcpCounters(runner: ToolRunner, now: number): Promise<TcpCounters | null> {
  const r = await runTool(runner, 'netstat', ['-s', '-p', 'tcp'], { timeoutMs: 15_000, maxBytes: 1024 * 1024 });
  return macTcpCountersFrom(toolText(r, 'netstat'), now);
}
