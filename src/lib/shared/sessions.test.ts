import { describe, expect, it } from 'vitest';
import { isRunningSession, matchesSessionQuery, searchKey, sessionWindow, startContextOf } from './sessions';
import type { TestSession } from './types';

const base: TestSession = { id: 3, startedAt: 1_000, endedAt: 5_000, plannedEndAt: 9_000, label: 'Neues LAN-Kabel', status: 'completed', note: null };

describe('sessions helpers', () => {
  it('detects running tests', () => {
    expect(isRunningSession(base)).toBe(false);
    expect(isRunningSession({ ...base, status: 'running', endedAt: null })).toBe(true);
    // a stopped test with a stale status still counts as ended
    expect(isRunningSession({ ...base, status: 'running', endedAt: 5_000 })).toBe(false);
  });

  it('computes the window of finished, running and unfinished tests', () => {
    expect(sessionWindow(base, 7_000)).toEqual({ from: 1_000, to: 5_000 });
    expect(sessionWindow({ ...base, status: 'running', endedAt: null }, 7_000)).toEqual({ from: 1_000, to: 7_000 });
    expect(sessionWindow({ ...base, status: 'running', endedAt: null }, null)).toBeNull();
    expect(sessionWindow({ ...base, status: 'aborted', endedAt: null }, 7_000)).toEqual({ from: 1_000, to: 9_000 });
    expect(sessionWindow({ ...base, endedAt: 500 }, 7_000)).toEqual({ from: 1_000, to: 1_000 });
  });

  it('searches names case- and accent-insensitive, word by word', () => {
    expect(searchKey('  Küche   WLAN ')).toBe('kuche wlan');
    expect(matchesSessionQuery(base, '')).toBe(true);
    expect(matchesSessionQuery(base, 'lan-kabel')).toBe(true);
    expect(matchesSessionQuery(base, 'kabel neues')).toBe(true);
    expect(matchesSessionQuery(base, 'wlan')).toBe(false);
    expect(matchesSessionQuery({ ...base, label: 'Küche' }, 'kuche')).toBe(true);
    expect(matchesSessionQuery({ ...base, label: null, note: 'nach Technikerbesuch' }, 'techniker')).toBe(true);
    expect(matchesSessionQuery({ ...base, label: null }, '#3')).toBe(true);
  });

  it('reads the connection context of a session_start event', () => {
    expect(startContextOf(null)).toBeNull();
    expect(startContextOf({ sessionId: 1 })).toBeNull();
    expect(startContextOf({ primaryAdapter: 'Ethernet', isWifi: false, linkMbps: 1000, ssid: null })).toEqual({
      primaryAdapter: 'Ethernet',
      isWifi: false,
      linkMbps: 1000,
      ssid: null,
    });
    expect(startContextOf({ expectedIf: 'WLAN', isWifi: true, ssid: 'Zuhause' })).toEqual({ primaryAdapter: 'WLAN', isWifi: true, linkMbps: null, ssid: 'Zuhause' });
  });
});
