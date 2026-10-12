import { connection, type NextRequest } from 'next/server';
import { z } from 'zod';
import { getConfig } from '../../../lib/server/config-store';
import { handle, json, parseQuery } from '../../../lib/server/http';
import { resolveRange, zTs } from '../../../lib/server/params';
import { getRouter } from '../../../lib/server/queries';
import { DAY } from '../../../lib/server/time';
import type { RouterResponse } from '../../../lib/shared/api-types';

const querySchema = z.object({ from: zTs, to: zTs, at: zTs });

/** GET /api/router?from&to[&at] → RouterResponse (latest status – or the one at `at` –, DOCSIS + HTTP history, router log). */
export async function GET(request: NextRequest): Promise<Response> {
  await connection();
  return handle(() => {
    const q = parseQuery(querySchema, request.nextUrl.searchParams);
    const range = resolveRange(q, { defaultSpanMs: 7 * DAY, maxSpanMs: 400 * DAY });
    return json(getRouter(range.from, range.to, getConfig(), q.at) satisfies RouterResponse);
  });
}
