import { connection, type NextRequest } from 'next/server';
import { z } from 'zod';
import { handle, json, parseBody, parseQuery } from '../../../../lib/server/http';
import { deleteSession } from '../../../../lib/server/sessions';
import type { SessionDeleteResult } from '../../../../lib/shared/sessions';

const paramsSchema = z.object({ id: z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER) });
const querySchema = z.object({ scope: z.enum(['entry', 'data']).optional() });

/**
 * DELETE /api/sessions/[id]?scope=entry|data → SessionDeleteResult. `entry` (default) removes only
 * the list entry, `data` also everything measured during the test. 404 unknown, 409 still running.
 */
export async function DELETE(request: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  await connection();
  return handle(async () => {
    const { id } = parseBody(paramsSchema, await ctx.params);
    const q = parseQuery(querySchema, request.nextUrl.searchParams);
    return json((await deleteSession(id, q.scope ?? 'entry')) satisfies SessionDeleteResult);
  });
}
