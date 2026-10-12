import { connection } from 'next/server';
import { handle, json } from '../../../../lib/server/http';
import { getSessionOverview } from '../../../../lib/server/sessions';
import type { SessionOverviewResponse } from '../../../../lib/shared/sessions';

/** GET /api/sessions/overview → SessionOverviewResponse (all tests, newest first, with key figures). */
export async function GET(): Promise<Response> {
  await connection();
  return handle(() => json(getSessionOverview(Date.now()) satisfies SessionOverviewResponse));
}
