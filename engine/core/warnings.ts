// Filters only the node:sqlite ExperimentalWarning ("SQLite is an experimental feature …").
// Must be installed before node:sqlite is loaded (engine/main.ts imports engine-db dynamically).
import { isRecord } from './util';

export function isSqliteExperimentalWarning(warning: unknown, rest: readonly unknown[] = []): boolean {
  let text = '';
  let type = '';
  if (typeof warning === 'string') {
    text = warning;
    const opt = rest[0];
    if (typeof opt === 'string') type = opt;
    else if (isRecord(opt) && typeof opt.type === 'string') type = opt.type;
  } else if (warning instanceof Error) {
    text = warning.message;
    type = warning.name;
  }
  return type === 'ExperimentalWarning' && /sqlite/i.test(text);
}

let installed = false;

export function installSqliteWarningFilter(): void {
  if (installed) return;
  installed = true;
  const original = process.emitWarning.bind(process) as (...args: unknown[]) => void;
  const filtered = (warning: unknown, ...rest: unknown[]): void => {
    if (isSqliteExperimentalWarning(warning, rest)) return;
    original(warning, ...rest);
  };
  process.emitWarning = filtered as typeof process.emitWarning;
}
