import { connection, type NextRequest } from 'next/server';
import { z } from 'zod';
import { runDiagnosis } from '../../../lib/server/diagnosis/index';
import { handle, json, parseQuery } from '../../../lib/server/http';
import { resolveRange, zTs } from '../../../lib/server/params';
import { DAY } from '../../../lib/server/time';
import type { DiagnosisResponse } from '../../../lib/shared/api-types';

const querySchema = z.object({ from: zTs, to: zTs });

/** GET /api/diagnosis?from&to → DiagnosisReport (default: last 7 days). */
export async function GET(request: NextRequest): Promise<Response> {
  await connection();
  return handle(async () => {
    const q = parseQuery(querySchema, request.nextUrl.searchParams);
    const range = resolveRange(q, { defaultSpanMs: 7 * DAY, maxSpanMs: 400 * DAY });
    const report: DiagnosisResponse = await runDiagnosis(range.from, range.to);
    return json(report);
  });
}
