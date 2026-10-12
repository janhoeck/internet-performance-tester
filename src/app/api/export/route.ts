import { connection, type NextRequest } from 'next/server';
import { z } from 'zod';
import { getConfig } from '../../../lib/server/config-store';
import { runDiagnosis } from '../../../lib/server/diagnosis/index';
import { exportResponse } from '../../../lib/server/export';
import { handle, parseQuery } from '../../../lib/server/http';
import { resolveRange, zMetricKeyList, zTargetList, zTs } from '../../../lib/server/params';
import { DAY } from '../../../lib/server/time';
import type { ExportKind } from '../../../lib/shared/api-types';

const KINDS: Record<ExportKind, true> = {
  samples: true,
  rollups: true,
  events: true,
  speedtests: true,
  traceroutes: true,
  metrics: true,
  report: true,
};

const querySchema = z.object({
  kind: z.enum(Object.keys(KINDS) as [ExportKind, ...ExportKind[]]),
  format: z.enum(['csv', 'json']).optional(),
  from: zTs,
  to: zTs,
  targets: zTargetList,
  keys: zMetricKeyList,
});

/** Largest export range per kind (raw samples are kept ≤ 90 days, the rest up to 10 years). */
function maxSpanMs(kind: ExportKind): number {
  return kind === 'samples' ? 92 * DAY : 3660 * DAY;
}

/**
 * GET /api/export?kind=samples|rollups|events|speedtests|traceroutes|metrics|report&format=csv|json&from&to[&targets][&keys]
 * → file download (Content-Disposition attachment). `report` is always a JSON bundle; MAC
 * addresses are redacted in everything that may contain them.
 */
export async function GET(request: NextRequest): Promise<Response> {
  await connection();
  return handle(async () => {
    const q = parseQuery(querySchema, request.nextUrl.searchParams);
    const range = resolveRange(q, { defaultSpanMs: 7 * DAY, maxSpanMs: maxSpanMs(q.kind) });
    return exportResponse({ kind: q.kind, format: q.format ?? 'csv', ...range, targets: q.targets, keys: q.keys }, getConfig(), runDiagnosis);
  });
}
