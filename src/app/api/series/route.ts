import { connection, type NextRequest } from 'next/server';
import { z } from 'zod';
import { getConfig } from '../../../lib/server/config-store';
import { handle, json, parseQuery } from '../../../lib/server/http';
import { resolveRange, zInt, zTargetList, zTs } from '../../../lib/server/params';
import { getSeries } from '../../../lib/server/queries';
import { DAY, HOUR } from '../../../lib/server/time';
import { enabledTargets } from '../../../lib/shared/config';

const querySchema = z.object({
  targets: zTargetList,
  from: zTs,
  to: zTs,
  step: zInt(1000, 7 * DAY),
});

/** GET /api/series?targets=gw,cf4&from&to[&step] → SeriesResponse (raw ≤ 3 h, rollups otherwise). */
export async function GET(request: NextRequest): Promise<Response> {
  await connection();
  return handle(() => {
    const q = parseQuery(querySchema, request.nextUrl.searchParams);
    const range = resolveRange(q, { defaultSpanMs: HOUR, maxSpanMs: 90 * DAY });
    const cfg = getConfig();
    const targets = q.targets ?? enabledTargets(cfg).map((t) => t.id);
    return json(getSeries({ targets, ...range, step: q.step }, cfg));
  });
}
