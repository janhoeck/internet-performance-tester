import { connection, type NextRequest } from 'next/server';
import { z } from 'zod';
import { HttpError, handle, json, parseBody } from '../../../../lib/server/http';
import { getSpeedtest } from '../../../../lib/server/queries';
import type { SpeedtestDetailResponse } from '../../../../lib/shared/api-types';

const paramsSchema = z.object({ id: z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER) });

/** GET /api/speedtests/[id] → SpeedtestDetailResponse (full result incl. series), 404 if unknown. */
export async function GET(_request: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  await connection();
  return handle(async () => {
    const { id } = parseBody(paramsSchema, await ctx.params);
    const result = getSpeedtest(id);
    if (!result) throw new HttpError(404, `Speedtest ${id} wurde nicht gefunden.`);
    return json(result satisfies SpeedtestDetailResponse);
  });
}
