// MAC address redaction for exports/reports (router logs contain CM-MAC/CMTS-MAC, the router's
// device list contains every household device). Pure functions.

export const MAC_PLACEHOLDER = 'xx:xx:xx:xx:xx:xx';

// six hex octets with a consistent ':' or '-' separator, or Cisco style aaaa.bbbb.cccc
const MAC_RE = /[0-9A-Fa-f]{2}([:-])(?:[0-9A-Fa-f]{2}\1){4}[0-9A-Fa-f]{2}|[0-9A-Fa-f]{4}\.[0-9A-Fa-f]{4}\.[0-9A-Fa-f]{4}/g;

/** A hex digit or ':' next to the match means it is part of a longer token (e.g. an IPv6 address). */
const continuesToken = (ch: string | undefined) => ch !== undefined && /[0-9A-Fa-f:]/.test(ch);

/** Replace MAC addresses in free text with a placeholder. */
export function redactMacs(text: string): string {
  return text.replace(MAC_RE, (match: string, _sep: string | undefined, offset: number, whole: string) => {
    if (continuesToken(whole[offset - 1]) || continuesToken(whole[offset + match.length])) return match;
    return MAC_PLACEHOLDER;
  });
}

/** Deep copy of a JSON-like value with all strings MAC-redacted. */
export function redactDeep<T>(value: T): T {
  return redactValue(value) as T;
}

function redactValue(v: unknown): unknown {
  if (typeof v === 'string') return redactMacs(v);
  if (Array.isArray(v)) return v.map(redactValue);
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) out[k] = redactValue(val);
    return out;
  }
  return v;
}
