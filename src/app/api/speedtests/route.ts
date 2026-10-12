import { connection, type NextRequest } from 'next/server';
import { z } from 'zod';
import { handle, json, parseQuery } from '../../../lib/server/http';
import { resolveRange, zInt, zTs } from '../../../lib/server/params';
import { listSpeedtests } from '../../../lib/server/queries';

const querySchema = z.object({
  from: zTs,
  to: zTs,
  limit: zInt(1, 5000),
});

/** GET /api/speedtests?from&to[&limit=200] → SpeedtestsResponse (newest first, without series). */
export async function GET(request: NextRequest): Promise<Response> {
  await connection();
  return handle(() => {
    const q = parseQuery(querySchema, request.nextUrl.searchParams);
    // default: all speed tests (they are few and kept for 10 years)
    const range = resolveRange(q, { defaultSpanMs: Number.POSITIVE_INFINITY, maxSpanMs: Number.POSITIVE_INFINITY });
    return json(listSpeedtests(range.from, range.to, q.limit ?? 200));
  });
}
