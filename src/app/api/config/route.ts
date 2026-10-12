import { connection } from 'next/server';
import { parseConfigPut } from '../../../lib/server/config-api';
import { getConfig, saveConfig, toPublicConfig } from '../../../lib/server/config-store';
import { sendEngineControl } from '../../../lib/server/engine-client';
import { apiError, handle, json, readJsonBody } from '../../../lib/server/http';
import type { ConfigResponse } from '../../../lib/shared/api-types';

/** GET /api/config → ConfigResponse (router password never included). */
export async function GET(): Promise<Response> {
  await connection();
  return handle(() => {
    const body: ConfigResponse = { config: toPublicConfig(getConfig()) };
    return json(body);
  });
}

/**
 * PUT /api/config (body: DeepPartial<AppConfig> & { routerPassword?: string | null }).
 * Saves the config, hands a new router password to the engine (DPAPI – Next never stores it)
 * and asks the engine to reload. Engine offline → saved anyway, `warning` explains it.
 */
export async function PUT(request: Request): Promise<Response> {
  await connection();
  return handle(async () => {
    const parsed = parseConfigPut(await readJsonBody(request));
    if (!parsed.ok) return apiError(400, parsed.error);
    const { patch, password } = parsed.value;
    const configChanged = Object.keys(patch).length > 0;
    if (configChanged) saveConfig(patch);

    const warnings: string[] = [];
    if (password !== undefined) {
      const res = await sendEngineControl({ action: 'router.setPassword', params: { password } }, 30_000);
      if (!res.ok) {
        warnings.push(
          res.offline
            ? 'Das Router-Passwort wurde nicht gespeichert, weil der Messdienst (Engine) nicht läuft. Bitte nach dem Start erneut eingeben.'
            : `Das Router-Passwort konnte nicht gespeichert werden: ${res.error}`,
        );
      } else if (!res.data.ok) {
        warnings.push(`Das Router-Passwort konnte nicht gespeichert werden: ${res.data.error ?? 'unbekannter Fehler'}`);
      }
    }
    if (configChanged) {
      const res = await sendEngineControl({ action: 'config.reload' }, 10_000);
      if (!res.ok) {
        warnings.push(
          res.offline
            ? 'Einstellungen gespeichert. Der Messdienst (Engine) läuft gerade nicht – die Änderungen gelten ab dem nächsten Start.'
            : `Einstellungen gespeichert, aber der Messdienst konnte nicht benachrichtigt werden: ${res.error}`,
        );
      } else if (!res.data.ok) {
        warnings.push(`Einstellungen gespeichert, aber der Messdienst meldet: ${res.data.error ?? 'Fehler beim Neuladen'}`);
      }
    }
    const body: ConfigResponse = { config: toPublicConfig(getConfig()), warning: warnings.length ? warnings.join(' ') : null };
    return json(body);
  });
}
