// Resolves the SQLite database location. Server/engine only (uses node:path).
import path from 'node:path';

/** `NETDIAG_DB` env var or `<cwd>/data/netdiag.db` (both processes are started from the project root). */
export function resolveDbPath(): string {
  // turbopackIgnore: keep Turbopack from tracing the database as a module dependency – otherwise every
  // write of the engine (WAL flush each second) triggers a recompile + full page reload in `next dev`.
  const fromEnv = process.env.NETDIAG_DB;
  if (fromEnv && fromEnv.trim() !== '') return path.resolve(/* turbopackIgnore: true */ fromEnv);
  return path.join(/* turbopackIgnore: true */ process.cwd(), 'data', 'netdiag.db');
}

/** Engine control API base URL (`NETDIAG_ENGINE_URL` or http://127.0.0.1:3901). */
export function engineBaseUrl(): string {
  return process.env.NETDIAG_ENGINE_URL?.replace(/\/$/, '') || 'http://127.0.0.1:3901';
}

export const ENGINE_PORT = Number(process.env.NETDIAG_ENGINE_PORT || 3901);
