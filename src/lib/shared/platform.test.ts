import { describe, expect, it } from 'vitest';
import { eventLogSourceText, hostOsFrom, isMacEventProvider, normalizeProcessName, osWording } from './platform';

describe('hostOsFrom / osWording', () => {
  it('maps Node platforms', () => {
    expect(hostOsFrom('win32')).toBe('windows');
    expect(hostOsFrom('darwin')).toBe('macos');
    expect(hostOsFrom('linux')).toBe('linux');
  });

  it('OS specific wording', () => {
    expect(osWording('windows')).toMatchObject({ id: 'windows', eventLog: 'Windows-Ereignisprotokoll', exeSuffix: true, secretStore: 'Windows DPAPI' });
    expect(osWording('macos')).toMatchObject({ id: 'macos', eventLog: 'macOS-Systemprotokoll', exeSuffix: false, secretStore: 'macOS-Schlüsselbund' });
    expect(osWording('linux')).toMatchObject({ id: 'linux', name: 'Linux', exeSuffix: false });
  });
});

describe('event log source labels', () => {
  it('Windows events keep provider and id', () => {
    expect(eventLogSourceText('e2fexpress', 27)).toBe('Windows-Ereignisprotokoll (e2fexpress, ID 27)');
    expect(eventLogSourceText('Microsoft-Windows-Kernel-Power', null)).toBe('Windows-Ereignisprotokoll (Microsoft-Windows-Kernel-Power)');
    expect(eventLogSourceText(null, 27)).toBeNull();
  });

  it('macOS events hide their synthetic ids', () => {
    expect(isMacEventProvider('macos-link')).toBe(true);
    expect(isMacEventProvider('e2fexpress')).toBe(false);
    expect(eventLogSourceText('macos-link', 27)).toBe('Link-Überwachung der Mess-Engine (macOS)');
    expect(eventLogSourceText('macos-power', 2)).toBe('macOS-Systemprotokoll (pmset)');
  });
});

describe('normalizeProcessName', () => {
  it('strips .exe/.app and lower-cases', () => {
    expect(normalizeProcessName(' CS2.exe ')).toBe('cs2');
    expect(normalizeProcessName('League of Legends.app')).toBe('league of legends');
    expect(normalizeProcessName('LeagueofLegends')).toBe('leagueoflegends');
  });
});
