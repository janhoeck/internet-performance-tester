// CSV formatting for German Excel: UTF-8 BOM, ';' separator, decimal comma, CRLF line ends.
// Pure functions.

export const CSV_BOM = '﻿';
export const CSV_SEP = ';';

export type CsvValue = string | number | boolean | null | undefined;

/** Number with up to `maxDecimals` decimals, decimal comma, never exponent notation. */
export function csvNumber(v: number, maxDecimals = 3): string {
  if (!Number.isFinite(v)) return '';
  const f = 10 ** maxDecimals;
  const rounded = Math.round(v * f) / f;
  const s = Number.isInteger(rounded)
    ? rounded.toFixed(0)
    : rounded.toFixed(maxDecimals).replace(/0+$/, '').replace(/\.$/, '');
  return s.replace('.', ',');
}

const NEEDS_QUOTES = /[";\r\n]|^\s|\s$/;
const FORMULA_START = /^[=+\-@\t\r]/;

export function csvField(v: CsvValue): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return csvNumber(v);
  if (typeof v === 'boolean') return v ? 'ja' : 'nein';
  // spreadsheet formula injection guard (router log texts etc. are untrusted)
  const s = FORMULA_START.test(v) ? `'${v}` : v;
  return NEEDS_QUOTES.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvRow(values: readonly CsvValue[]): string {
  return values.map(csvField).join(CSV_SEP) + '\r\n';
}
