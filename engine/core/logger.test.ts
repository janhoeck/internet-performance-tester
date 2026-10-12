import { describe, expect, it } from 'vitest';
import { createLogger, formatClock, formatLogLine, parseLogLevel } from './logger';
import { isSqliteExperimentalWarning } from './warnings';

describe('logger', () => {
  const at = new Date(2026, 9, 9, 7, 5, 3);

  it('formats [HH:MM:SS] LEVEL scope: msg', () => {
    expect(formatClock(at)).toBe('07:05:03');
    expect(formatLogLine(at, 'info', 'engine', 'Engine bereit')).toBe('[07:05:03] INFO  engine: Engine bereit');
    expect(formatLogLine(at, 'warn', 'probes', 'Ziel fehlt', { id: 'gw' })).toBe('[07:05:03] WARN  probes: Ziel fehlt {"id":"gw"}');
    expect(formatLogLine(at, 'debug', 'x', 'y', new Error('boom'))).toBe('[07:05:03] DEBUG x: y Error: boom');
    expect(formatLogLine(at, 'error', 'x', 'y', new Error('boom'))).toContain('Error: boom\n');
  });

  it('parses NETDIAG_LOG_LEVEL values', () => {
    expect(parseLogLevel('DEBUG')).toBe('debug');
    expect(parseLogLevel(' warning ')).toBe('warn');
    expect(parseLogLevel('nonsense')).toBe('info');
    expect(parseLogLevel(undefined, 'error')).toBe('error');
  });

  it('filters by level and scopes children', () => {
    const lines: string[] = [];
    const log = createLogger({ level: 'info', sink: (_l, line) => lines.push(line), now: () => at });
    log.debug('unsichtbar');
    log.info('sichtbar');
    const probes = log.child('probes');
    probes.warn('Pinger neu gestartet');
    probes.child('pinger').error('Agent tot');
    expect(lines).toEqual([
      '[07:05:03] INFO  engine: sichtbar',
      '[07:05:03] WARN  probes: Pinger neu gestartet',
      '[07:05:03] ERROR probes/pinger: Agent tot',
    ]);
  });

  it('truncates huge data and survives circular structures', () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    expect(formatLogLine(at, 'info', 's', 'm', circular)).toContain('[object Object]');
    expect(formatLogLine(at, 'info', 's', 'm', 'x'.repeat(5000)).length).toBeLessThan(2200);
  });
});

describe('sqlite warning filter', () => {
  it('matches only the node:sqlite ExperimentalWarning', () => {
    expect(isSqliteExperimentalWarning('SQLite is an experimental feature and might change at any time', ['ExperimentalWarning'])).toBe(true);
    expect(isSqliteExperimentalWarning('SQLite is an experimental feature', [{ type: 'ExperimentalWarning' }])).toBe(true);
    expect(isSqliteExperimentalWarning('WASI is an experimental feature', ['ExperimentalWarning'])).toBe(false);
    expect(isSqliteExperimentalWarning('SQLite something', ['DeprecationWarning'])).toBe(false);
    const e = new Error('SQLite is an experimental feature');
    e.name = 'ExperimentalWarning';
    expect(isSqliteExperimentalWarning(e)).toBe(true);
  });
});
