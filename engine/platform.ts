// Host platform of the engine (docs/research/macos.md §1). Every module that needs a platform
// specific data source asks here – never `process.platform` directly – so tests can override it.
import type { HostOs } from '../src/lib/shared/platform';

let override: HostOs | null = null;

/** 'windows' | 'macos' | 'linux' (Linux is not supported – collectors report "nicht verfügbar"). */
export function hostPlatform(): HostOs {
  if (override) return override;
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'macos';
  return 'linux';
}

export const isMac = (): boolean => hostPlatform() === 'macos';
export const isWindows = (): boolean => hostPlatform() === 'windows';

/** Tests only: pretend to run on another platform (null = real platform). */
export function setPlatformOverride(os: HostOs | null): void {
  override = os;
}
