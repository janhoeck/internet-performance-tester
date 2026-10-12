import { connection, type NextRequest } from 'next/server';
import { z } from 'zod';
import { handle, json, parseQuery } from '../../../lib/server/http';
import { ID_RE, zFlag, zInt } from '../../../lib/server/params';
import { getHeatmap } from '../../../lib/server/queries';

const querySchema = z.object({
  target: z.string().regex(ID_RE, 'ungültige Ziel-ID'),
  metric: z.enum(['p95', 'avg', 'loss', 'spikes']).optional(),
  days: zInt(1, 90),
  excludeSpeedtests: zFlag,
});

/**
 * GET /api/heatmap?target=cf4&metric=p95|avg|loss|spikes&days=14 → HeatmapResponse
 * (local day × hour) plus `coverage[day][hour]` (% of minutes measured).
 */
export async function GET(request: NextRequest): Promise<Response> {
  await connection();
  return handle(() => {
    const q = parseQuery(querySchema, request.nextUrl.searchParams);
    return json(getHeatmap(q.target, q.metric ?? 'p95', q.days ?? 14, { excludeSpeedtests: q.excludeSpeedtests ?? true }));
  });
}
