// macOS interface catalog: `networksetup -listallhardwareports` (cached), `ifconfig -a` and
// `netstat -ibn` joined by buildMacInterfaces(). Shared by the adapter source, the pinger's NIC
// ticks and the system log module (BSD name ↔ shown name).
import { parseIfconfig } from '../../../src/lib/shared/parsers/macos/ifconfig';
import { type MacInterface, buildMacInterfaces } from '../../../src/lib/shared/parsers/macos/interfaces';
import { parseNetstatInterfaces } from '../../../src/lib/shared/parsers/macos/netstat';
import { type HardwarePort, parseHardwarePorts } from '../../../src/lib/shared/parsers/macos/networksetup';
import { type ToolRunner, runTool, toolText } from './tools';

const PORTS_TTL_MS = 10 * 60_000;
const TOOL_TIMEOUT_MS = 10_000;

export interface CatalogOptions {
  /** read netstat counters too (default true) */
  counters?: boolean;
  /** re-read the hardware ports even if the cache is fresh */
  refreshPorts?: boolean;
}

export class MacInterfaceCatalog {
  private ports: HardwarePort[] = [];
  private portsTs = 0;
  private portsError: string | null = null;
  private last: MacInterface[] = [];

  constructor(
    private readonly runner: ToolRunner,
    private readonly now: () => number = Date.now,
  ) {}

  /** latest successful read (empty before the first one) */
  latest(): readonly MacInterface[] {
    return this.last;
  }

  /** why the hardware port list is missing (null = fine) */
  portError(): string | null {
    return this.portsError;
  }

  async read(opts: CatalogOptions = {}): Promise<MacInterface[]> {
    const wantCounters = opts.counters !== false;
    const portsStale = opts.refreshPorts === true || this.portsTs === 0 || this.now() - this.portsTs >= PORTS_TTL_MS;
    const [ifc, ns, ports] = await Promise.all([
      runTool(this.runner, 'ifconfig', ['-a'], { timeoutMs: TOOL_TIMEOUT_MS, maxBytes: 4 * 1024 * 1024 }),
      wantCounters ? runTool(this.runner, 'netstat', ['-ibn'], { timeoutMs: TOOL_TIMEOUT_MS, maxBytes: 4 * 1024 * 1024 }) : Promise.resolve(null),
      portsStale ? runTool(this.runner, 'networksetup', ['-listallhardwareports'], { timeoutMs: TOOL_TIMEOUT_MS, maxBytes: 1024 * 1024 }) : Promise.resolve(null),
    ]);
    if (ports) {
      try {
        const list = parseHardwarePorts(toolText(ports, 'networksetup'));
        if (list.length > 0 || this.ports.length === 0) this.ports = list;
        this.portsError = null;
      } catch (err) {
        this.portsError = err instanceof Error ? err.message : String(err);
      }
      this.portsTs = this.now();
    }
    const interfaces = parseIfconfig(toolText(ifc, 'ifconfig'));
    const counters = ns ? parseNetstatInterfaces(toolText(ns, 'netstat')) : [];
    const list = buildMacInterfaces(this.ports, interfaces, counters);
    this.last = list;
    return list;
  }
}
