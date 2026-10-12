// Query parameter schemas shared by the route handlers (zod; values arrive as strings).
import { z } from 'zod';
import { HttpError } from './http';
import { DAY } from './time';

/** Largest accepted epoch-ms value (year ~2286). */
const MAX_TS = 9_999_999_999_999;

const emptyToUndefined = (v: unknown) => (v === '' || v === null ? undefined : v);

/** Optional epoch-ms timestamp. */
export const zTs = z.preprocess(emptyToUndefined, z.coerce.number().int().min(0).max(MAX_TS).optional());

/** Optional integer in [min, max]. */
export function zInt(min: number, max: number) {
  return z.preprocess(emptyToUndefined, z.coerce.number().int().min(min).max(max).optional());
}

/** Optional boolean flag: 1/0/true/false/ja/nein. */
export const zFlag = z.preprocess(
  emptyToUndefined,
  z
    .enum(['1', '0', 'true', 'false', 'ja', 'nein'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === '1' || v === 'true' || v === 'ja')),
);

export const ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** Comma separated list of items matching `re` (deduplicated, max `max` entries). */
export function zList(re: RegExp, max = 64, label = 'Eintrag') {
  return z.preprocess(
    emptyToUndefined,
    z
      .string()
      .max(4000)
      .optional()
      .transform((s, ctx) => {
        if (s === undefined) return undefined;
        const items = [...new Set(s.split(',').map((x) => x.trim()).filter((x) => x !== ''))];
        if (items.length > max) {
          ctx.addIssue({ code: 'custom', message: `höchstens ${max} Einträge erlaubt` });
          return z.NEVER;
        }
        const bad = items.find((x) => !re.test(x));
        if (bad !== undefined) {
          ctx.addIssue({ code: 'custom', message: `ungültiger ${label} „${bad.slice(0, 40)}“` });
          return z.NEVER;
        }
        return items;
      }),
  );
}

export const zTargetList = zList(ID_RE, 64, 'Ziel');

/** Metric keys of the registry (metrics.ts), e.g. 'nic.link_mbps', 'udp.burst.cf4-udp.loss_pct'. */
export const METRIC_KEY_RE = /^[a-z0-9][a-z0-9_.-]{0,79}$/;

export const zMetricKeyList = zList(METRIC_KEY_RE, 64, 'Kennzahl');

/** Optional IP family 4 | 6. */
export const zFamily = z.preprocess(emptyToUndefined, z.enum(['4', '6']).optional().transform((v) => (v === undefined ? undefined : v === '4' ? 4 : 6)));

export interface RangeDefaults {
  /** span used when `from` is missing */
  defaultSpanMs: number;
  /** largest allowed span (Infinity = unbounded) */
  maxSpanMs: number;
}

/** Resolve from/to with defaults (to = now). Throws HttpError(400) for invalid ranges. */
export function resolveRange(
  q: { from?: number; to?: number },
  d: RangeDefaults,
  now: number = Date.now(),
): { from: number; to: number } {
  const to = q.to ?? now;
  const from = q.from ?? Math.max(0, to - d.defaultSpanMs);
  if (from >= to) throw new HttpError(400, 'Ungültiger Zeitraum: „from“ muss vor „to“ liegen.');
  if (to - from > d.maxSpanMs) {
    const days = Math.round(d.maxSpanMs / DAY);
    throw new HttpError(400, `Zeitraum zu groß (höchstens ${days} Tage).`);
  }
  return { from, to };
}
