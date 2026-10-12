import { connection, type NextRequest } from 'next/server';
import { z } from 'zod';
import { HttpError, handle, json, parseQuery } from '../../../lib/server/http';
import { resolveRange, zInt, zMetricKeyList, zTs } from '../../../lib/server/params';
import { getMetrics } from '../../../lib/server/queries';
import { DAY } from '../../../lib/server/time';

const querySchema = z.object({
  keys: zMetricKeyList,
  from: zTs,
  to: zTs,
  step: zInt(1000, 7 * DAY),
});

/** GET /api/metrics?keys=a,b&from&to[&step] → MetricsResponse (bucketed with each metric's aggregation). */
export async function GET(request: NextRequest): Promise<Response> {
  await connection();
  return handle(() => {
    const q = parseQuery(querySchema, request.nextUrl.searchParams);
    if (!q.keys || q.keys.length === 0) throw new HttpError(400, 'Ungültige Anfrage – Parameter „keys“ fehlt (z. B. keys=nic.link_mbps).');
    const range = resolveRange(q, { defaultSpanMs: DAY, maxSpanMs: 400 * DAY });
    return json(getMetrics(q.keys, range.from, range.to, q.step));
  });
}
