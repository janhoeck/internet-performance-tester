// macOS command line tools (docs/research/macos.md §0): always by absolute path, never via PATH or
// a shell, with timeouts, tracked children and a C locale for stable number/date formats.
import type { ProcessRunner, RunOptions, RunResult } from '../util';

/** Absolute paths of the system tools used on macOS (all present on a stock macOS 13+). */
export const MAC_TOOLS = {
  ping: '/sbin/ping',
  ping6: '/sbin/ping6',
  ifconfig: '/sbin/ifconfig',
  route: '/sbin/route',
  netstat: '/usr/sbin/netstat',
  networksetup: '/usr/sbin/networksetup',
  arp: '/usr/sbin/arp',
  ipconfig: '/usr/sbin/ipconfig',
  scutil: '/usr/sbin/scutil',
  sysctl: '/usr/sbin/sysctl',
  systemProfiler: '/usr/sbin/system_profiler',
  traceroute: '/usr/sbin/traceroute',
  traceroute6: '/usr/sbin/traceroute6',
  ps: '/bin/ps',
  security: '/usr/bin/security',
  caffeinate: '/usr/bin/caffeinate',
  pmset: '/usr/bin/pmset',
  log: '/usr/bin/log',
} as const;

export type MacTool = keyof typeof MAC_TOOLS;

/** Cloudflare WARP CLI locations (the installer links it into /usr/local/bin). */
export const WARP_CLI_MAC_PATHS: readonly string[] = [
  '/usr/local/bin/warp-cli',
  '/Applications/Cloudflare WARP.app/Contents/Resources/warp-cli',
];

/**
 * Environment for parsed tools: C locale (English messages, '.' decimals). `networksetup` keeps the
 * user locale because its hardware port names are shown in the UI.
 */
export function toolEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...base, LC_ALL: 'C', LANG: 'C' };
}

export type ToolRunner = Pick<ProcessRunner, 'run'>;

/** Runs a macOS tool with the C locale. Never rejects (errors are in the result). */
export function runTool(runner: ToolRunner, tool: MacTool, args: string[], opts: RunOptions): Promise<RunResult> {
  const env = tool === 'networksetup' ? opts.env : (opts.env ?? toolEnv());
  return runner.run(MAC_TOOLS[tool], args, { ...opts, env });
}

/** stdout as UTF-8 text when the tool succeeded, else throws a short German error. */
export function toolText(r: RunResult, tool: string, acceptCodes: readonly number[] = [0]): string {
  if (r.error) throw new Error(`${tool}: ${r.error.code === 'ENOENT' ? 'nicht gefunden' : r.error.message}`);
  if (r.timedOut) throw new Error(`${tool}: Zeitüberschreitung`);
  if (r.code === null || !acceptCodes.includes(r.code)) {
    const err = r.stderr.toString('utf8').trim().split(/\r?\n/)[0] ?? '';
    throw new Error(`${tool}: Exit-Code ${r.code ?? '?'}${err ? ` (${err.slice(0, 160)})` : ''}`);
  }
  return r.stdout.toString('utf8');
}
