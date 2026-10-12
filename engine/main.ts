// Engine entry point (ARCHITECTURE §4.1): `npm run engine` → `tsx engine/main.ts`.
// Environment: NETDIAG_DB (database path), NETDIAG_ENGINE_PORT (default 3901), NETDIAG_LOG_LEVEL.
import fs from 'node:fs';
import { type EngineHandle, startEngine } from './core/bootstrap';
import { createLogger } from './core/logger';
import { errorMessage, isRecord } from './core/util';
import { installSqliteWarningFilter } from './core/warnings';
import { PortInUseError } from './server';

// 1. only the node:sqlite ExperimentalWarning is hidden (.npmrc already passes --disable-warning)
installSqliteWarningFilter();

const log = createLogger();

// a closed console must never crash the engine (EPIPE on stdout/stderr)
process.stdout.on('error', () => undefined);
process.stderr.on('error', () => undefined);
process.on('uncaughtException', (err) => {
  log.error(`Unbehandelte Ausnahme: ${errorMessage(err)}`, err);
});
process.on('unhandledRejection', (reason) => {
  log.error(`Unbehandelte Promise-Ablehnung: ${errorMessage(reason)}`, reason instanceof Error ? reason : undefined);
});

function readVersion(): string {
  try {
    const pkg: unknown = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    return isRecord(pkg) && typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

// node:sqlite is loaded only now (after the warning filter)
const { openEngineDb } = await import('./db/engine-db');

let engine: EngineHandle;
try {
  engine = await startEngine({ version: readVersion(), log, openDb: (path, opts) => openEngineDb(path, opts) });
} catch (err) {
  if (err instanceof PortInUseError) {
    // e.g. "Engine läuft bereits (Port 3901 belegt)"
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
  log.error(`Engine konnte nicht gestartet werden: ${errorMessage(err)}`, err instanceof Error ? err : undefined);
  process.exit(1);
}

// 6. graceful shutdown (tsx watch restarts and taskkill skip this – everything is crash-safe)
let stopping = false;
function shutdown(reason: string): void {
  if (stopping) {
    log.warn('Beenden erzwungen');
    process.exit(1);
  }
  stopping = true;
  const force = setTimeout(() => {
    log.error('Beenden dauert zu lange – Prozess wird sofort beendet');
    process.exit(1);
  }, 10_000);
  force.unref();
  engine.shutdown(reason).then(
    () => process.exit(0),
    (err: unknown) => {
      log.error(`Fehler beim Beenden: ${errorMessage(err)}`, err instanceof Error ? err : undefined);
      process.exit(1);
    },
  );
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP'] as const) {
  process.on(signal, () => shutdown(signal));
}
// started with an IPC channel (e.g. a supervisor or test harness): 'shutdown' message = graceful stop
if (typeof process.send === 'function') {
  process.on('message', (msg: unknown) => {
    if (msg === 'shutdown' || (isRecord(msg) && msg.type === 'shutdown')) shutdown('IPC');
  });
}
