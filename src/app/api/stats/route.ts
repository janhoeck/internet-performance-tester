import { connection, type NextRequest } from 'next/server';
import { z } from 'zod';
import { getConfig } from '../../../lib/server/config-store';
import { handle, json, parseQuery } from '../../../lib/server/http';
import { resolveRange, zFlag, zTargetList, zTs } from '../../../lib/server/params';
import { getStats } from '../../../lib/server/queries';
import { DAY } from '../../../lib/server/time';
import { enabledTargets } from '../../../lib/shared/config';

const querySchema = z.object({
  from: zTs,
  to: zTs,
  targets: zTargetList,
  excludeSpeedtests: zFlag,
});

/** GET /api/stats?from&to[&targets=a,b][&excludeSpeedtests=1] → StatsResponse. */
export async function GET(request: NextRequest): Promise<Response> {
  await connection();
  return handle(() => {
    const q = parseQuery(querySchema, request.nextUrl.searchParams);
    const range = resolveRange(q, { defaultSpanMs: DAY, maxSpanMs: 90 * DAY });
    const cfg = getConfig();
    const targets = q.targets ?? enabledTargets(cfg).map((t) => t.id);
    return json(getStats({ ...range, targets, excludeSpeedtests: q.excludeSpeedtests ?? true }, cfg));
  });
}
