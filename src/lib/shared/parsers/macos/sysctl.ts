// Parser for macOS `sysctl kern.boottime kern.sleeptime kern.waketime` (docs/research/macos.md §5):
//   kern.boottime: { sec = 1728712345, usec = 678901 } Sat Oct 12 08:12:25 2024
// Used as a cheap change detector for boot / sleep / wake. Not localized. Pure.

export interface KernTimes {
  /** last boot (epoch ms) */
  boot: number | null;
  /** last sleep, null when the Mac has not slept since the boot */
  sleep: number | null;
  /** last wake, null when the Mac has not woken since the boot */
  wake: number | null;
}

/** '{ sec = 1728712345, usec = 678901 } …' → epoch ms; null for sec = 0 or unparsable text. */
export function parseTimeval(text: string): number | null {
  const m = /\{\s*sec\s*=\s*(\d+)\s*,\s*usec\s*=\s*(\d+)\s*\}/.exec(text);
  if (!m) return null;
  const sec = Number(m[1]);
  const usec = Number(m[2]);
  if (!Number.isFinite(sec) || sec <= 0) return null;
  return sec * 1000 + Math.floor((Number.isFinite(usec) ? usec : 0) / 1000);
}

/** `name: value` lines; unknown names (e.g. an older macOS without kern.waketime) stay null. */
export function parseKernTimes(text: string): KernTimes {
  const out: KernTimes = { boot: null, sleep: null, wake: null };
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*kern\.(boottime|sleeptime|waketime)\s*[:=]\s*(.*)$/.exec(raw);
    if (!m) continue;
    const v = parseTimeval(m[2]);
    if (m[1] === 'boottime') out.boot = v;
    else if (m[1] === 'sleeptime') out.sleep = v;
    else out.wake = v;
  }
  return out;
}
