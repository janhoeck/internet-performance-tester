// Operating system of the measuring PC and the German wording that depends on it (UI, diagnosis,
// reports). Pure – no Node built-ins: the Next server passes `hostOsFrom(process.platform)` down,
// the engine uses engine/platform.ts.

export type HostOs = 'windows' | 'macos' | 'linux';

export function hostOsFrom(nodePlatform: string): HostOs {
  if (nodePlatform === 'win32') return 'windows';
  if (nodePlatform === 'darwin') return 'macos';
  return 'linux';
}

export interface OsWording {
  id: HostOs;
  /** 'Windows' / 'macOS' */
  name: string;
  /** "Windows-Ereignisprotokoll" / "macOS-Systemprotokoll" */
  eventLog: string;
  /** where the user finds running process names ("Name aus <processTool>") */
  processTool: string;
  /** example of a game process name */
  processExample: string;
  /** game process names carry the .exe suffix */
  exeSuffix: boolean;
  /** router password storage */
  secretStore: string;
  /** how the engine keeps the computer awake */
  preventSleepHint: string;
  /** "Standby" / "Ruhezustand" */
  standby: string;
}

const WINDOWS: OsWording = {
  id: 'windows',
  name: 'Windows',
  eventLog: 'Windows-Ereignisprotokoll',
  processTool: 'dem Task-Manager (Details)',
  processExample: 'cs2.exe',
  exeSuffix: true,
  secretStore: 'Windows DPAPI',
  preventSleepHint:
    'Windows schläft dann nicht automatisch ein (ohne Administratorrechte). Manuelles Schlafenlegen bleibt möglich, erzeugt aber eine Messlücke.',
  standby: 'Standby',
};

const MACOS: OsWording = {
  id: 'macos',
  name: 'macOS',
  eventLog: 'macOS-Systemprotokoll',
  processTool: 'der Aktivitätsanzeige (Spalte „Prozessname“)',
  processExample: 'LeagueofLegends',
  exeSuffix: false,
  secretStore: 'macOS-Schlüsselbund',
  preventSleepHint:
    'Der Mac schläft dann nicht automatisch ein (über „caffeinate“, ohne Administratorrechte). Zuklappen oder manuelles Schlafenlegen bleibt möglich, erzeugt aber eine Messlücke.',
  standby: 'Ruhezustand',
};

/** Wording for the OS; Linux (unsupported) falls back to neutral macOS-like texts. */
export function osWording(os: HostOs): OsWording {
  if (os === 'windows') return WINDOWS;
  if (os === 'macos') return MACOS;
  return { ...MACOS, id: 'linux', name: 'Linux', eventLog: 'Systemprotokoll', secretStore: 'Arbeitsspeicher', processTool: 'der Prozessliste' };
}

/** Providers of the synthetic macOS system log events (engine/collectors/macos/syslog.ts). */
export const MAC_LINK_PROVIDER = 'macos-link';
export const MAC_POWER_PROVIDER = 'macos-power';

/** Event details stem from the macOS system log module (synthetic provider). */
export function isMacEventProvider(provider: string | null | undefined): boolean {
  return typeof provider === 'string' && provider.toLowerCase().startsWith('macos-');
}

/**
 * Source label of an event-log event: "Windows-Ereignisprotokoll (e2fexpress, ID 27)" for Windows
 * events, "Link-Überwachung (macOS)" / "macOS-Systemprotokoll" for the synthetic macOS events (their
 * ids carry no meaning for the user). Null when the provider is unknown.
 */
export function eventLogSourceText(provider: string | null | undefined, eventId: number | null | undefined): string | null {
  if (!provider) return null;
  if (isMacEventProvider(provider)) {
    return provider.toLowerCase() === MAC_POWER_PROVIDER ? 'macOS-Systemprotokoll (pmset)' : 'Link-Überwachung der Mess-Engine (macOS)';
  }
  return eventId != null ? `Windows-Ereignisprotokoll (${provider}, ID ${eventId})` : `Windows-Ereignisprotokoll (${provider})`;
}

/**
 * Normalized game process name for comparisons: lower case, without `.exe` / `.app` suffix, so a
 * configured "cs2.exe" also matches a macOS process "cs2" and vice versa.
 */
export function normalizeProcessName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/\.(exe|app)$/, '');
}
