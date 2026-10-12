// Console logger: `[HH:MM:SS] LEVEL scope: msg [data]`. Level from NETDIAG_LOG_LEVEL (default info).
import type { Logger } from './types';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const LABEL: Record<LogLevel, string> = { debug: 'DEBUG', info: 'INFO ', warn: 'WARN ', error: 'ERROR' };
const MAX_DATA_CHARS = 2000;

export type LogSink = (level: LogLevel, line: string) => void;

export interface LoggerOptions {
  scope?: string;
  level?: LogLevel;
  sink?: LogSink;
  now?: () => Date;
}

export function parseLogLevel(value: string | undefined | null, fallback: LogLevel = 'info'): LogLevel {
  const v = (value ?? '').trim().toLowerCase();
  if (v === 'debug' || v === 'info' || v === 'warn' || v === 'error') return v;
  if (v === 'warning') return 'warn';
  if (v === 'trace' || v === 'verbose') return 'debug';
  return fallback;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** Local wall-clock time `HH:MM:SS`. */
export function formatClock(d: Date): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}… (+${s.length - max} Zeichen)` : s;
}

/** Renders the optional data argument; Errors include the stack for level 'error'. */
export function formatLogData(data: unknown, level: LogLevel): string {
  if (data === undefined) return '';
  if (data instanceof Error) {
    if (level === 'error' && data.stack) return data.stack;
    return `${data.name}: ${data.message}`;
  }
  if (typeof data === 'string') return truncate(data, MAX_DATA_CHARS);
  if (typeof data === 'number' || typeof data === 'boolean' || typeof data === 'bigint' || data === null) {
    return String(data);
  }
  try {
    const json = JSON.stringify(data, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
    return truncate(json ?? String(data), MAX_DATA_CHARS);
  } catch {
    return truncate(String(data), MAX_DATA_CHARS);
  }
}

export function formatLogLine(time: Date, level: LogLevel, scope: string, msg: string, data?: unknown): string {
  const extra = formatLogData(data, level);
  return `[${formatClock(time)}] ${LABEL[level]} ${scope}: ${msg}${extra ? ` ${extra}` : ''}`;
}

const defaultSink: LogSink = (level, line) => {
  try {
    if (level === 'warn' || level === 'error') process.stderr.write(`${line}\n`);
    else process.stdout.write(`${line}\n`);
  } catch {
    /* closed console (EPIPE) – nothing we can do */
  }
};

/**
 * Creates the root logger. `child('probes')` of the root yields scope `probes`; children of
 * children are joined with '/' (`probes/pinger`).
 */
export function createLogger(opts: LoggerOptions = {}): Logger {
  const level = opts.level ?? parseLogLevel(process.env.NETDIAG_LOG_LEVEL);
  const sink = opts.sink ?? defaultSink;
  const now = opts.now ?? (() => new Date());
  return makeLogger(opts.scope ?? 'engine', true, ORDER[level], sink, now);
}

function makeLogger(scope: string, isRoot: boolean, min: number, sink: LogSink, now: () => Date): Logger {
  const write = (level: LogLevel, msg: string, data?: unknown) => {
    if (ORDER[level] < min) return;
    sink(level, formatLogLine(now(), level, scope, msg, data));
  };
  return {
    debug: (msg, data) => write('debug', msg, data),
    info: (msg, data) => write('info', msg, data),
    warn: (msg, data) => write('warn', msg, data),
    error: (msg, data) => write('error', msg, data),
    child: (child) => makeLogger(isRoot ? child : `${scope}/${child}`, false, min, sink, now),
  };
}

/** Logger that discards everything (tests). */
export function silentLogger(): Logger {
  return createLogger({ level: 'error', sink: () => undefined });
}
