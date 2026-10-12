// Protocol of the ICMP pinger agent (engine/probes/pinger.ps1): config encoding, script
// preparation and parsing/mapping of its JSON output lines. Pure functions (no I/O).
import { isIpLiteral, normalizeIp } from '../../src/lib/shared/net';
import { SampleStatus, type SampleStatusCode } from '../../src/lib/shared/types';
import type { NicTick } from '../core/types';

/**
 * Environment variable that carries base64(UTF-8 JSON of AgentConfig) into the agent.
 * Not a command line argument: PowerShell 5.1 rejects any argument after -EncodedCommand
 * (verified), and embedding the config into the script exceeds the 32767-char command line
 * limit at ~40 targets (≈ 370 chars per target after UTF-16 + base64).
 */
export const AGENT_CONFIG_ENV = 'NETDIAG_PINGER_CFG';

/** Windows command line limit (CreateProcess lpCommandLine, incl. the program path). */
export const MAX_COMMAND_LINE = 32_767;

/** Physical adapters reported when no adapters snapshot is known yet. */
export const DEFAULT_NICS: readonly string[] = ['Ethernet', 'WLAN'];

export interface AgentTarget {
  /** target id ([a-z0-9-]) */
  id: string;
  /** IP literal (IPv6 may carry a zone id, e.g. fe80::1%4) */
  ip: string;
  /** ping on every n-th tick (target interval / agent interval), default 1 */
  every?: number;
  /** per-target timeout in ms (default: AgentConfig.timeoutMs) */
  to?: number;
}

export interface AgentConfig {
  targets: AgentTarget[];
  intervalMs: number;
  timeoutMs: number;
  /** ICMP payload bytes (32 = ping.exe default) */
  size: number;
  /** adapter names (interface aliases) reported once per tick as `nic` lines */
  nics: string[];
  /** SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED) while the agent runs */
  preventSleep: boolean;
  /** engine PID – the agent exits when its parent is gone */
  ppid?: number;
}

export interface AgentEchoLine {
  k: 'icmp';
  id: string;
  ts: number;
  /** IPStatus name (e.g. 'Success', 'TimedOut', 'DestinationHostUnreachable'), a number for unknown codes, or 'Error' */
  st: string;
  rtt: number | null;
  from: string | null;
  /** exception type and code for st = 'Error' */
  err: string | null;
}
export interface AgentNicLine {
  k: 'nic';
  tick: NicTick;
}
export interface AgentHeartbeatLine {
  k: 'hb';
  ts: number;
}
export interface AgentHelloLine {
  k: 'hello';
  pid: number | null;
  /** SetThreadExecutionState succeeded */
  sleep: boolean | null;
}
export interface AgentWarnLine {
  k: 'warn';
  msg: string;
}
export type AgentLine = AgentEchoLine | AgentNicLine | AgentHeartbeatLine | AgentHelloLine | AgentWarnLine;

// ─── config / script ───────────────────────────────────────────────────────

const TARGET_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Drop targets the agent cannot ping (invalid id or not an IP literal) and duplicates. */
export function sanitizeAgentTargets(targets: readonly AgentTarget[]): AgentTarget[] {
  const seen = new Set<string>();
  const out: AgentTarget[] = [];
  for (const t of targets) {
    if (!TARGET_ID.test(t.id) || !isIpLiteral(t.ip) || seen.has(t.id)) continue;
    seen.add(t.id);
    out.push(t);
  }
  return out;
}

/** base64 of the UTF-8 JSON config (value of AGENT_CONFIG_ENV). */
export function encodeAgentConfig(cfg: AgentConfig): string {
  return Buffer.from(JSON.stringify(cfg), 'utf8').toString('base64');
}

/** Environment for the agent process: the parent environment plus the encoded config. */
export function agentEnv<E extends Readonly<Record<string, string | undefined>>>(
  cfg: AgentConfig,
  base: E,
): E & Record<typeof AGENT_CONFIG_ENV, string> {
  return { ...base, [AGENT_CONFIG_ENV]: encodeAgentConfig(cfg) };
}

/**
 * Remove comment lines, indentation and blank lines to keep the -EncodedCommand short
 * (the command line limit is 32767 chars; base64 of UTF-16 inflates the script 2.7×).
 * pinger.ps1 avoids here-strings, block comments and trailing comments, so this is safe.
 */
export function minifyPowerShell(src: string): string {
  return src
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'))
    .join('\n');
}

/** Final script text (constant – the config travels in AGENT_CONFIG_ENV). */
export function buildAgentScript(template: string): string {
  const min = minifyPowerShell(template);
  if (!min.includes(AGENT_CONFIG_ENV)) throw new Error(`pinger.ps1: liest ${AGENT_CONFIG_ENV} nicht`);
  return min;
}

/** Value for `powershell.exe -EncodedCommand` (base64 of UTF-16LE). */
export function encodePowerShellCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

/** Arguments for powershell.exe (absolute path is resolved by the caller). */
export function agentArgs(encodedCommand: string): string[] {
  return ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodedCommand];
}

/** Stable key for change detection (restart only when something relevant changed). */
export function agentConfigKey(cfg: AgentConfig): string {
  const targets = [...cfg.targets]
    .map((t) => ({ id: t.id, ip: t.ip, every: t.every ?? 1, to: t.to ?? cfg.timeoutMs }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const nics = [...cfg.nics].map((n) => n.toLowerCase()).sort();
  return JSON.stringify({ targets, i: cfg.intervalMs, t: cfg.timeoutMs, s: cfg.size, nics, p: cfg.preventSleep });
}

// ─── output lines ──────────────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

/** Parse one stdout line of the agent; null for anything that is not a valid agent message. */
export function parseAgentLine(line: string): AgentLine | null {
  const s = line.trim();
  if (!s.startsWith('{')) return null;
  let v: unknown;
  try {
    v = JSON.parse(s);
  } catch {
    return null;
  }
  if (!isRecord(v)) return null;
  switch (v.k) {
    case 'icmp': {
      const id = str(v.id);
      const ts = num(v.ts);
      const st = typeof v.st === 'number' ? String(v.st) : str(v.st);
      if (id === null || ts === null || st === null) return null;
      return { k: 'icmp', id, ts, st, rtt: num(v.rtt), from: str(v.from), err: str(v.err) };
    }
    case 'nic': {
      const ts = num(v.ts);
      const name = str(v.name);
      if (ts === null || name === null || typeof v.up !== 'boolean') return null;
      const mbps = num(v.mbps);
      return {
        k: 'nic',
        tick: {
          ts,
          name,
          up: v.up,
          mbps: v.up && mbps !== null && mbps > 0 ? mbps : null,
          rxBytes: num(v.rx) ?? 0,
          txBytes: num(v.tx) ?? 0,
          rxErrors: num(v.inErr) ?? 0,
          rxDiscards: num(v.inDisc) ?? 0,
          isWifi: v.wifi === true,
        },
      };
    }
    case 'hb': {
      const ts = num(v.ts);
      return ts === null ? null : { k: 'hb', ts };
    }
    case 'hello':
      return { k: 'hello', pid: num(v.pid), sleep: typeof v.sleep === 'boolean' ? v.sleep : null };
    case 'warn':
      return { k: 'warn', msg: str(v.msg) ?? '' };
    default:
      return null;
  }
}

/** Normalized form used for own-address comparisons (zone id stripped, IPv6 expanded). */
export function normalizeAddress(ip: string): string {
  return normalizeIp(ip.split('%')[0].split('/')[0].trim()).toLowerCase();
}

/**
 * Map the agent status to SampleStatus (ARCHITECTURE §4.5):
 * Success → OK; TimedOut → TIMEOUT; *Unreachable → UNREACHABLE (also any failure reported from
 * one of our own addresses = local ARP/ND failure); TtlExpired/TimeExceeded → TTL_EXPIRED;
 * everything else (PacketTooBig, exceptions, unknown codes such as 11050 general failure) → ERROR.
 */
export function mapAgentStatus(
  st: string,
  from: string | null,
  isOwnAddress: (normalizedIp: string) => boolean,
): SampleStatusCode {
  if (st === 'Success') return SampleStatus.OK;
  if (from && isOwnAddress(normalizeAddress(from))) return SampleStatus.UNREACHABLE;
  if (st === 'TimedOut') return SampleStatus.TIMEOUT;
  if (st.endsWith('Unreachable')) return SampleStatus.UNREACHABLE;
  if (st === 'TtlExpired' || st === 'TimeExceeded') return SampleStatus.TTL_EXPIRED;
  return SampleStatus.ERROR;
}

/** RTT of a successful echo; the ICMP API reports whole ms, 0 means < 1 ms → stored as 0.5. */
export function mapAgentRtt(st: string, rtt: number | null): number | null {
  if (st !== 'Success' || rtt === null || rtt < 0) return null;
  return rtt === 0 ? 0.5 : rtt;
}
