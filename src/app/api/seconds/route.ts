import { connection, type NextRequest } from 'next/server';
import { z } from 'zod';
import { handle, json, parseQuery } from '../../../lib/server/http';
import { resolveRange, zInt, zTs } from '../../../lib/server/params';
import { getSeconds } from '../../../lib/server/queries';
import { DAY } from '../../../lib/server/time';

const querySchema = z.object({
  from: zTs,
  to: zTs,
  step: zInt(60_000, 31 * DAY),
});

/** GET /api/seconds?from&to[&step] → SecondsResponse (classified seconds, step ≥ 60 s). */
export async function GET(request: NextRequest): Promise<Response> {
  await connection();
  return handle(() => {
    const q = parseQuery(querySchema, request.nextUrl.searchParams);
    const range = resolveRange(q, { defaultSpanMs: DAY, maxSpanMs: 400 * DAY });
    return json(getSeconds(range.from, range.to, q.step));
  });
}
