// macOS WLAN source for the wlan module: `system_profiler SPAirPortDataType -json` (docs/research/macos.md §4).
// It takes 0.5–2 s per call, so it is polled at most every 30 s.
import { parseAirportJson, wlanInfoFromAirport } from '../../../src/lib/shared/parsers/macos/airport';
import type { AdapterInfo, WlanInfo } from '../../../src/lib/shared/types';
import type { WlanSource } from '../wlan';
import { type ToolRunner, runTool, toolText } from './tools';

export const MAC_WLAN_MIN_INTERVAL_MS = 30_000;
const TIMEOUT_MS = 20_000;

/** BSD name of an adapter from the adapters snapshot (AdapterInfoExt.device), null if unknown. */
export function deviceOf(a: AdapterInfo | null): string | null {
  if (!a) return null;
  const d = (a as AdapterInfo & { device?: unknown }).device;
  return typeof d === 'string' && d.trim() !== '' ? d.trim() : null;
}

export class SystemProfilerWlanSource implements WlanSource {
  readonly via = 'system_profiler';
  readonly minIntervalMs = MAC_WLAN_MIN_INTERVAL_MS;

  constructor(private readonly runner: ToolRunner) {}

  async read(wifi: AdapterInfo | null): Promise<WlanInfo> {
    const r = await runTool(this.runner, 'systemProfiler', ['SPAirPortDataType', '-json'], { timeoutMs: TIMEOUT_MS, maxBytes: 8 * 1024 * 1024 });
    const text = toolText(r, 'system_profiler');
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error('system_profiler: unerwartete Ausgabe (kein JSON)');
    }
    return wlanInfoFromAirport(parseAirportJson(json), Date.now(), { device: deviceOf(wifi), mediaConnected: wifi ? wifi.mediaConnected : null });
  }
}
