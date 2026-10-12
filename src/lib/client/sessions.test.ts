import { describe, expect, it } from 'vitest';
import type { TestSession } from '../shared/types';
import { sessionHref, sessionName, sessionTitle } from './sessions';

const s = (label: string | null): TestSession => ({
  id: 7,
  startedAt: new Date(2026, 9, 10, 12, 18).getTime(),
  endedAt: null,
  plannedEndAt: null,
  label,
  status: 'running',
  note: null,
});

describe('session display names', () => {
  it('uses the name, otherwise the start time', () => {
    expect(sessionName(s('  WLAN '))).toBe('WLAN');
    expect(sessionName(s(null))).toBe('Langzeittest ab 10.10., 12:18');
    expect(sessionName(s('   '))).toBe('Langzeittest ab 10.10., 12:18');
  });

  it('builds headings without doubling the word', () => {
    expect(sessionTitle(s('LAN-Kabel'))).toBe('Langzeittest „LAN-Kabel“');
    expect(sessionTitle(s('Langzeittest 72 h'))).toBe('Langzeittest 72 h');
    expect(sessionTitle(s('Langzeittests sind toll'))).toBe('Langzeittest „Langzeittests sind toll“');
    expect(sessionTitle(s(null))).toBe('Langzeittest ab 10.10., 12:18');
  });

  it('links to a page with exactly this test', () => {
    expect(sessionHref('/bericht', 7)).toBe('/bericht?range=session&session=7');
  });
});
