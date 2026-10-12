import { connection } from 'next/server';
import { openEngineLive } from '../../../lib/server/engine-client';
import { offlineSseResponse, proxySseResponse } from '../../../lib/server/sse';

/**
 * GET /api/live – SSE proxy of the engine's /live stream. Engine down → HTTP 200 with
 * `retry: 3000` + an `offline` message, then the stream ends (EventSource keeps retrying).
 */
export async function GET(request: Request): Promise<Response> {
  await connection();
  try {
    const live = await openEngineLive(request.signal);
    if (!live.ok) return offlineSseResponse(live.since, live.error);
    return proxySseResponse(live.body, request.signal, live.abort);
  } catch (err) {
    return offlineSseResponse(Date.now(), `Live-Stream nicht verfügbar: ${err instanceof Error ? err.message : String(err)}`);
  }
}
