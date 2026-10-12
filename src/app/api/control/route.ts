import { connection } from 'next/server';
import { controlRequestSchema, controlTimeoutMs, toControlRequest } from '../../../lib/server/control';
import { sendEngineControl } from '../../../lib/server/engine-client';
import { handle, json, parseBody, readJsonBody } from '../../../lib/server/http';
import type { ControlApiResponse } from '../../../lib/shared/api-types';

/** POST /api/control (body: ControlRequest) → forwarded to the engine. */
export async function POST(request: Request): Promise<Response> {
  await connection();
  return handle(async () => {
    const req = toControlRequest(parseBody(controlRequestSchema, await readJsonBody(request)));
    const res = await sendEngineControl(req, controlTimeoutMs(req.action));
    if (!res.ok) {
      const body: ControlApiResponse = { ok: false, error: res.error };
      return json(body, res.offline ? 503 : 502);
    }
    return json(res.data satisfies ControlApiResponse, res.status >= 400 ? res.status : 200);
  });
}
