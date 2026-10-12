import { connection } from 'next/server';
import { handle, json } from '../../../lib/server/http';
import { getPath } from '../../../lib/server/queries';
import type { PathResponse } from '../../../lib/shared/api-types';

/** GET /api/path → PathResponse (latest MTU + NAT result per IP family). */
export async function GET(): Promise<Response> {
  await connection();
  return handle(() => json(getPath() satisfies PathResponse));
}
