import { connection, type NextRequest } from 'next/server';
import { z } from 'zod';
import { HttpError, handle, json, parseQuery } from '../../../lib/server/http';
import { zFamily, zInt, zTs } from '../../../lib/server/params';
import { listTraceroutes } from '../../../lib/server/queries';

const querySchema = z.object({
  family: zFamily,
  from: zTs,
  to: zTs,
  limit: zInt(1, 1000),
});

/** GET /api/traceroutes?[family=4|6][&from][&to][&limit=50] → TraceroutesResponse (newest first). */
export async function GET(request: NextRequest): Promise<Response> {
  await connection();
  return handle(() => {
    const q = parseQuery(querySchema, request.nextUrl.searchParams);
    if (q.from !== undefined && q.to !== undefined && q.from >= q.to) {
      throw new HttpError(400, 'Ungültiger Zeitraum: „from“ muss vor „to“ liegen.');
    }
    return json(listTraceroutes({ family: q.family, from: q.from, to: q.to, limit: q.limit ?? 50 }));
  });
}
