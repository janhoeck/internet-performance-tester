/**
 * Deutsche Zahlen- und Zeitformate für die UI. Zeitzone fest auf Europe/Berlin, damit Server-
 * und Client-Render identisch sind (keine Hydration-Abweichung).
 * Einheiten werden mit geschütztem Leerzeichen (U+00A0) angehängt: "18,4 ms", "0,8 %".
 *
 * UI-Code importiert Formate von HIER (nicht aus src/lib/shared/format.ts – das ist die
 * Engine-/Server-Variante ohne NBSP und mit lokaler Zeitzone).
 */
export const NBSP = " ";
export const DASH = "–"; // "–" für fehlende Werte

const nfCache = new Map<string, Intl.NumberFormat>();
function nf(min: number, max: number): Intl.NumberFormat {
  const key = `${min}-${max}`;
  let f = nfCache.get(key);
  if (!f) {
    f = new Intl.NumberFormat("de-DE", { minimumFractionDigits: min, maximumFractionDigits: max });
    nfCache.set(key, f);
  }
  return f;
}

const isNum = (v: number | null | undefined): v is number => v != null && Number.isFinite(v);

export function fmtNumber(v: number | null | undefined, digits = 1): string {
  if (!isNum(v)) return DASH;
  return nf(0, digits).format(v);
}

/** Ganze Zahl mit Tausenderpunkt: "1.234" */
export function fmtInt(v: number | null | undefined): string {
  if (!isNum(v)) return DASH;
  return nf(0, 0).format(Math.round(v));
}

/** Latenz: unter 10 ms eine Nachkommastelle (LAN: 0,3 vs. 0,9 ms zählt), sonst ganze ms. */
export function fmtMsValue(v: number | null | undefined): string {
  if (!isNum(v)) return DASH;
  if (v < 0.1) return "<0,1";
  return nf(v < 10 ? 1 : 0, v < 10 ? 1 : 0).format(v);
}
export const fmtMs = (v: number | null | undefined): string => (!isNum(v) ? DASH : `${fmtMsValue(v)}${NBSP}ms`);

/** Prozent immer mit einer Nachkommastelle: "0,0 %", "2,4 %". */
export function fmtPctValue(v: number | null | undefined): string {
  if (!isNum(v)) return DASH;
  return nf(1, 1).format(v);
}
export const fmtPct = (v: number | null | undefined): string => (!isNum(v) ? DASH : `${fmtPctValue(v)}${NBSP}%`);

/** Kleine Verluste genauer: "0,05 %", "1,2 %", "12 %". */
export function fmtLossPct(v: number | null | undefined): string {
  if (!isNum(v)) return DASH;
  const d = v === 0 ? 1 : v < 0.1 ? 2 : v < 10 ? 1 : 0;
  return `${nf(d, d).format(v)}${NBSP}%`;
}

export const fmtMbitValue = (v: number | null | undefined): string => (!isNum(v) ? DASH : nf(0, v < 100 ? 1 : 0).format(v));
export const fmtMbit = (v: number | null | undefined): string => (!isNum(v) ? DASH : `${fmtMbitValue(v)}${NBSP}Mbit/s`);

/** Linkgeschwindigkeit: 1000 -> "1 Gbit/s", 2500 -> "2,5 Gbit/s", 100 -> "100 Mbit/s". */
export function fmtLinkSpeed(mbps: number | null | undefined): string {
  if (!isNum(mbps)) return DASH;
  if (mbps >= 1000) return `${nf(0, 1).format(mbps / 1000)}${NBSP}Gbit/s`;
  return `${nf(0, 0).format(mbps)}${NBSP}Mbit/s`;
}

export const fmtDb = (v: number | null | undefined, unit: "dB" | "dBmV" | "dBm" = "dB"): string =>
  !isNum(v) ? DASH : `${nf(1, 1).format(v).replace("-", "−")}${NBSP}${unit}`;

/** Bytes: "512 B", "1,2 MB", "3,4 GB" (Basis 1024). */
export function fmtBytes(v: number | null | undefined): string {
  if (!isNum(v)) return DASH;
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let x = v;
  while (x >= 1024 && i < units.length - 1) {
    x /= 1024;
    i++;
  }
  return `${nf(0, i === 0 ? 0 : 1).format(x)}${NBSP}${units[i]}`;
}

const TZ = "Europe/Berlin";
const dfTime = new Intl.DateTimeFormat("de-DE", { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: TZ });
const dfShortTime = new Intl.DateTimeFormat("de-DE", { hour: "2-digit", minute: "2-digit", timeZone: TZ });
const dfDate = new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: TZ });
const dfDateShort = new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", timeZone: TZ });
const dfDayLong = new Intl.DateTimeFormat("de-DE", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: TZ });
const dfDayShort = new Intl.DateTimeFormat("de-DE", { weekday: "short", day: "numeric", month: "numeric", timeZone: TZ });
const dfDayKey = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: TZ });
const dfInput = new Intl.DateTimeFormat("sv-SE", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: TZ,
});

type DateInput = string | number | Date;
const toDate = (d: DateInput): Date => (d instanceof Date ? d : new Date(d));

export const fmtTime = (d: DateInput): string => dfTime.format(toDate(d)); // 18:43:12
export const fmtShortTime = (d: DateInput): string => dfShortTime.format(toDate(d)); // 18:43
export const fmtDate = (d: DateInput): string => dfDate.format(toDate(d)); // 08.10.2026
export const fmtDateTime = (d: DateInput): string => `${fmtDate(d)}, ${fmtTime(d)}`; // 08.10.2026, 18:43:12
/** "08.10., 18:43" */
export const fmtDateTimeShort = (d: DateInput): string => `${dfDateShort.format(toDate(d))}, ${fmtShortTime(d)}`;
export const fmtDayLong = (d: DateInput): string => dfDayLong.format(toDate(d)); // Donnerstag, 8. Oktober 2026
export const fmtDayShort = (d: DateInput): string => dfDayShort.format(toDate(d)); // Do., 8.10.
/** Kalendertag in Europe/Berlin als "YYYY-MM-DD" (für Gruppierung). */
export const dayKey = (d: DateInput): string => dfDayKey.format(toDate(d));
/** Wert für <input type="datetime-local">: "2026-10-08T18:43" (Europe/Berlin). */
export const toDateTimeInput = (d: DateInput): string => dfInput.format(toDate(d)).replace(" ", "T");

/** Zeitspanne mit Halbgeviertstrich: "18:29–18:43" (gleicher Tag) bzw. "08.10., 18:29 – 09.10., 06:00". */
export function fmtTimeRange(from: DateInput, to: DateInput): string {
  if (dayKey(from) === dayKey(to)) return `${fmtShortTime(from)}–${fmtShortTime(to)}`;
  return `${fmtDateTimeShort(from)} – ${fmtDateTimeShort(to)}`;
}

/** Laufzeit: "3 T 04:12:55" ab einem Tag, sonst "04:12:55". */
export function fmtRuntime(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(s / 86400);
  const hh = String(Math.floor((s % 86400) / 3600)).padStart(2, "0");
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return days > 0 ? `${days}${NBSP}T ${hh}:${mm}:${ss}` : `${hh}:${mm}:${ss}`;
}

/** Dauer kurz (Sekunden): "22 s", "3 min 05 s", "2 h 14 min", ab 2 Tagen "3 T 4 h". */
export function fmtDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}${NBSP}s`;
  if (s < 3600) return `${Math.floor(s / 60)}${NBSP}min ${String(s % 60).padStart(2, "0")}${NBSP}s`;
  if (s < 172_800) return `${Math.floor(s / 3600)}${NBSP}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}${NBSP}min`;
  return `${Math.floor(s / 86400)}${NBSP}T ${Math.floor((s % 86400) / 3600)}${NBSP}h`;
}

/** Wie fmtDuration, aber Eingabe in Millisekunden (API-Zeitstempel sind ms). */
export const fmtDurationMs = (ms: number | null | undefined): string => (!isNum(ms) ? DASH : fmtDuration(ms / 1000));

const rtf = new Intl.RelativeTimeFormat("de", { numeric: "auto" });

/**
 * Relativ zu `now` (aus useNow(), nie Date.now() im Render): "in 12 Minuten", "vor 3 Minuten",
 * "vor 2 Stunden", "gestern".
 */
export function fmtRelative(ts: number, now: number): string {
  const diffS = (ts - now) / 1000;
  const a = Math.abs(diffS);
  if (a < 45) return diffS >= 0 ? "gleich" : "gerade eben";
  if (a < 3600) return rtf.format(Math.round(diffS / 60), "minute");
  if (a < 86_400) return rtf.format(Math.round(diffS / 3600), "hour");
  return rtf.format(Math.round(diffS / 86_400), "day");
}
