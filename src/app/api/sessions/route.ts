import { connection, type NextRequest } from 'next/server';
import { z } from 'zod';
import { handle, json, parseQuery } from '../../../lib/server/http';
import { zInt } from '../../../lib/server/params';
import { getSessions } from '../../../lib/server/queries';
import type { SessionsResponse } from '../../../lib/shared/api-types';

const querySchema = z.object({ limit: zInt(1, 1000) });

/** GET /api/sessions[?limit=200] → SessionsResponse (newest first + the running session). */
export async function GET(request: NextRequest): Promise<Response> {
  await connection();
  return handle(() => {
    const q = parseQuery(querySchema, request.nextUrl.searchParams);
    return json(getSessions(q.limit ?? 200) satisfies SessionsResponse);
  });
}
