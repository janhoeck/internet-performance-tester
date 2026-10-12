import { connection, type NextRequest } from 'next/server';
import { z } from 'zod';
import { handle, json, parseQuery } from '../../../lib/server/http';
import { ID_RE, resolveRange, zInt, zTs } from '../../../lib/server/params';
import { getSamples } from '../../../lib/server/queries';
import { DAY, HOUR } from '../../../lib/server/time';

const querySchema = z.object({
  target: z.string().regex(ID_RE, 'ungültige Ziel-ID'),
  from: zTs,
  to: zTs,
  limit: zInt(1, 200_000),
});

/** GET /api/samples?target=cf4&from&to[&limit=20000] → SamplesResponse (raw, ascending). */
export async function GET(request: NextRequest): Promise<Response> {
  await connection();
  return handle(() => {
    const q = parseQuery(querySchema, request.nextUrl.searchParams);
    const range = resolveRange(q, { defaultSpanMs: HOUR, maxSpanMs: 31 * DAY });
    return json(getSamples(q.target, range.from, range.to, q.limit ?? 20_000));
  });
}
