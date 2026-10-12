// Response/error helpers shared by all route handlers (src/app/api/**).
import { z } from 'zod';
import type { ApiError } from '../shared/api-types';
import { ConfigValidationError } from './config-store';

// German validation messages for every zod schema evaluated in the Next server process.
z.config(z.locales.de());

export const NO_STORE_HEADERS: Readonly<Record<string, string>> = { 'Cache-Control': 'no-store' };

/** JSON response that is never cached. */
export function json(data: unknown, status = 200, headers?: Record<string, string>): Response {
  return Response.json(data, { status, headers: { ...NO_STORE_HEADERS, ...headers } });
}

export function apiError(status: number, message: string): Response {
  const body: ApiError = { error: message };
  return json(body, status);
}

/** Thrown inside handlers to answer with an ApiError. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function issuePath(issue: z.core.$ZodIssue): string {
  return issue.path.map(String).join('.');
}

/** Format zod issues as one German sentence list. */
export function formatIssues(issues: readonly z.core.$ZodIssue[], subject = 'Parameter'): string {
  const parts = issues.slice(0, 5).map((i) => {
    const p = issuePath(i);
    return p ? `${subject} „${p}“: ${i.message}` : i.message;
  });
  return parts.join('; ');
}

/** Validate URL search params (last value wins) against a schema; throws HttpError(400). */
export function parseQuery<S extends z.ZodType>(schema: S, params: URLSearchParams): z.output<S> {
  const raw: Record<string, string> = {};
  for (const [k, v] of params) raw[k] = v;
  const res = schema.safeParse(raw);
  if (!res.success) throw new HttpError(400, `Ungültige Anfrage – ${formatIssues(res.error.issues)}`);
  return res.data;
}

/** Validate an already parsed JSON body; throws HttpError(400). */
export function parseBody<S extends z.ZodType>(schema: S, body: unknown): z.output<S> {
  const res = schema.safeParse(body);
  if (!res.success) throw new HttpError(400, `Ungültige Anfrage – ${formatIssues(res.error.issues, 'Feld')}`);
  return res.data;
}

/** Read a JSON request body with a size limit; throws HttpError(400/413). */
export async function readJsonBody(request: Request, maxBytes = 64 * 1024): Promise<unknown> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > maxBytes) throw new HttpError(413, 'Anfrage ist zu groß.');
  let text: string;
  try {
    text = await request.text();
  } catch {
    throw new HttpError(400, 'Anfrage konnte nicht gelesen werden.');
  }
  if (text.length > maxBytes) throw new HttpError(413, 'Anfrage ist zu groß.');
  if (text.trim() === '') throw new HttpError(400, 'Leere Anfrage – JSON erwartet.');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpError(400, 'Ungültiges JSON in der Anfrage.');
  }
}

/** Map any thrown value to an ApiError response (never leaks stack traces). */
export function errorResponse(err: unknown): Response {
  if (err instanceof HttpError) return apiError(err.status, err.message);
  if (err instanceof ConfigValidationError) {
    const detail = err.issues.slice(0, 5).join('; ');
    return apiError(400, detail ? `${err.message}: ${detail}` : err.message);
  }
  const msg = err instanceof Error ? err.message : String(err);
  console.error('[api] Fehler:', err);
  return apiError(500, `Interner Fehler: ${msg}`);
}

/** Run a handler body and convert exceptions into ApiError responses. */
export async function handle(fn: () => Promise<Response> | Response): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    return errorResponse(err);
  }
}
