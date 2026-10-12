// German display formatting helpers (pure, usable on server and client).

const nf = (decimals: number) =>
  new Intl.NumberFormat('de-DE', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });

const cache = new Map<number, Intl.NumberFormat>();
function fmt(v: number, decimals: number): string {
  let f = cache.get(decimals);
  if (!f) {
    f = nf(decimals);
    cache.set(decimals, f);
  }
  return f.format(v);
}

export const DASH = '–';

export function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

export function fmtNumber(v: number | null | undefined, decimals = 0): string {
  return isNum(v) ? fmt(v, decimals) : DASH;
}

/** Latency: "<1 ms", "18 ms", "1,2 ms" for small values, "1.250 ms" */
export function fmtMs(v: number | null | undefined, decimals?: number): string {
  if (!isNum(v)) return DASH;
  if (v < 1 && decimals === undefined) return '<1 ms';
  const d = decimals ?? (v < 10 ? 1 : 0);
  return `${fmt(v, d)} ms`;
}

export function fmtPct(v: number | null | undefined, decimals?: number): string {
  if (!isNum(v)) return DASH;
  const d = decimals ?? (v === 0 ? 0 : v < 1 ? 2 : v < 10 ? 1 : 0);
  return `${fmt(v, d)} %`;
}

export function fmtMbps(v: number | null | undefined, decimals?: number): string {
  if (!isNum(v)) return DASH;
  const d = decimals ?? (v < 10 ? 1 : 0);
  return `${fmt(v, d)} Mbit/s`;
}

export function fmtDb(v: number | null | undefined, unit: 'dB' | 'dBmV' | 'dBm' = 'dB'): string {
  return isNum(v) ? `${fmt(v, 1)} ${unit}` : DASH;
}

export function fmtBytes(v: number | null | undefined): string {
  if (!isNum(v)) return DASH;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let x = v;
  while (x >= 1024 && i < units.length - 1) {
    x /= 1024;
    i++;
  }
  return `${fmt(x, i === 0 ? 0 : 1)} ${units[i]}`;
}

const dtf = new Intl.DateTimeFormat('de-DE', {
  day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
});
const dtfShort = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const tf = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const df = new Intl.DateTimeFormat('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' });

/** "09.10.2026, 18:29:13" */
export function fmtDateTime(ts: number | null | undefined): string {
  return isNum(ts) ? dtf.format(ts) : DASH;
}
/** "09.10., 18:29" */
export function fmtDateTimeShort(ts: number | null | undefined): string {
  return isNum(ts) ? dtfShort.format(ts) : DASH;
}
/** "18:29:13" */
export function fmtTime(ts: number | null | undefined): string {
  return isNum(ts) ? tf.format(ts) : DASH;
}
/** "Fr., 09.10." */
export function fmtDay(ts: number | null | undefined): string {
  return isNum(ts) ? df.format(ts) : DASH;
}

/** Duration from ms: "45 s", "3 min 12 s", "2 h 05 min", "3 T 4 h" */
export function fmtDuration(ms: number | null | undefined): string {
  if (!isNum(ms)) return DASH;
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${String(s % 60).padStart(2, '0')} s`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ${String(m % 60).padStart(2, '0')} min`;
  const d = Math.floor(h / 24);
  return `${d} T ${h % 24} h`;
}

/** "vor 5 min" relative to now */
export function fmtAgo(ts: number | null | undefined, now: number = Date.now()): string {
  if (!isNum(ts)) return DASH;
  const diff = Math.max(0, now - ts);
  if (diff < 5_000) return 'gerade eben';
  return `vor ${fmtDuration(diff)}`;
}
