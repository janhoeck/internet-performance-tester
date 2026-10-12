// Parser for macOS `ps -ww -A -o comm=` (docs/research/macos.md §0, game detection): one executable
// path per line, e.g. "/Applications/League of Legends.app/Contents/LoL/Game/LeagueofLegends.app/
// Contents/MacOS/LeagueofLegends". Pure.

/** Executable names (basename of each path, spaces kept); kernel pseudo entries like "(zombie)" are skipped. */
export function parsePsComm(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('(')) continue;
    const base = line.slice(line.lastIndexOf('/') + 1).trim();
    if (base !== '') out.push(base);
  }
  return out;
}
