import { connection, type NextRequest } from 'next/server';
import { eventsQuerySchema, noteBodySchema } from '../../../lib/server/events-api';
import { handle, json, parseBody, parseQuery, readJsonBody } from '../../../lib/server/http';
import { resolveRange } from '../../../lib/server/params';
import { getEvents, insertNote } from '../../../lib/server/queries';
import { DAY } from '../../../lib/server/time';

/** GET /api/events?from&to[&types=a,b][&severity=warn,critical][&segment][&source][&limit=500][&offset=0] – newest first. */
export async function GET(request: NextRequest): Promise<Response> {
  await connection();
  return handle(() => {
    const q = parseQuery(eventsQuerySchema, request.nextUrl.searchParams);
    const range = resolveRange(q, { defaultSpanMs: 7 * DAY, maxSpanMs: Number.POSITIVE_INFINITY });
    return json(
      getEvents({
        ...range,
        types: q.types,
        severities: q.severity,
        segments: q.segment,
        sources: q.source,
        limit: q.limit ?? 500,
        offset: q.offset ?? 0,
      }),
    );
  });
}

/** POST /api/events { title, ts?, details? } → the created user `note` event (201). */
export async function POST(request: Request): Promise<Response> {
  await connection();
  return handle(async () => {
    const body = parseBody(noteBodySchema, await readJsonBody(request, 32 * 1024));
    return json(insertNote({ title: body.title, ts: body.ts, details: body.details ?? null }), 201);
  });
}
