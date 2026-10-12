// Config persistence for the Next server (settings table, key 'config').
// The router password is stored by the ENGINE (DPAPI) under 'router.password' – Next only
// checks whether one exists and never reads/returns it.
import type { PublicConfig } from '../shared/api-types';
import { type AppConfig, configSchema, mergeConfig } from '../shared/config';
import { get, run } from './db';

export function getConfig(): AppConfig {
  const row = get<{ value: string }>("SELECT value FROM settings WHERE key = 'config'");
  if (!row) return mergeConfig({});
  try {
    return mergeConfig(JSON.parse(row.value));
  } catch {
    return mergeConfig({});
  }
}

export function hasRouterPassword(): boolean {
  const row = get<{ value: string }>("SELECT value FROM settings WHERE key = 'router.password'");
  return !!row && row.value.trim() !== '';
}

export function toPublicConfig(cfg: AppConfig): PublicConfig {
  return { ...cfg, router: { ...cfg.router, hasPassword: hasRouterPassword() } };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function deepMerge(base: unknown, patch: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch === undefined ? base : patch;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    out[k] = deepMerge(base[k], v);
  }
  return out;
}

export class ConfigValidationError extends Error {
  constructor(message: string, readonly issues: string[]) {
    super(message);
  }
}

/**
 * Deep-merge a partial config (arrays such as `targets` replace the stored list) and persist it.
 * Throws ConfigValidationError with German messages if the result is invalid.
 */
export function saveConfig(patch: unknown): AppConfig {
  const current = getConfig();
  const candidate = deepMerge(current, patch);
  const parsed = configSchema.safeParse(candidate);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new ConfigValidationError('Ungültige Einstellungen', issues);
  }
  const ids = parsed.data.targets.map((t) => t.id);
  if (new Set(ids).size !== ids.length) {
    throw new ConfigValidationError('Ungültige Einstellungen', ['targets: doppelte Ziel-IDs']);
  }
  const cfg = parsed.data as AppConfig;
  run(
    "INSERT INTO settings(key, value, updated_at) VALUES('config', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    JSON.stringify(cfg),
    Date.now(),
  );
  return cfg;
}
