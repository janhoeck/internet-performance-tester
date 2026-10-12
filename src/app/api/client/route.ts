import { connection, type NextRequest } from 'next/server';
import { z } from 'zod';
import { handle, json, parseQuery } from '../../../lib/server/http';
import { resolveRange, zTs } from '../../../lib/server/params';
import { getClient } from '../../../lib/server/queries';
import { DAY } from '../../../lib/server/time';
import type { ClientResponse } from '../../../lib/shared/api-types';

const querySchema = z.object({ from: zTs, to: zTs });

/** GET /api/client?from&to → ClientResponse (adapters, WLAN, VPN, NIC link history + KPIs). */
export async function GET(request: NextRequest): Promise<Response> {
  await connection();
  return handle(() => {
    const q = parseQuery(querySchema, request.nextUrl.searchParams);
    const range = resolveRange(q, { defaultSpanMs: 7 * DAY, maxSpanMs: 3660 * DAY });
    return json(getClient(range.from, range.to) satisfies ClientResponse);
  });
}
