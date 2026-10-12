import { connection } from 'next/server';
import { getConfig, toPublicConfig } from '../../../lib/server/config-store';
import { getEngineStatus } from '../../../lib/server/engine-client';
import { handle, json } from '../../../lib/server/http';
import { getDbInfo } from '../../../lib/server/queries';
import type { StatusResponse } from '../../../lib/shared/api-types';

/** GET /api/status – engine status (proxied), DB info, public config. */
export async function GET(): Promise<Response> {
  await connection();
  return handle(async () => {
    const cfg = getConfig();
    const engine = await getEngineStatus();
    const body: StatusResponse = {
      now: Date.now(),
      engineOnline: engine.ok,
      engine: engine.ok ? engine.data : null,
      engineError: engine.ok ? null : engine.error,
      db: getDbInfo(cfg),
      config: toPublicConfig(cfg),
    };
    return json(body);
  });
}
