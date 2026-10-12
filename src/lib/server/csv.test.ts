import { describe, expect, it } from 'vitest';
import { CSV_BOM, csvField, csvNumber, csvRow } from './csv';

describe('csv', () => {
  it('formats numbers with decimal comma, no exponent, trimmed decimals', () => {
    expect(csvNumber(12.5)).toBe('12,5');
    expect(csvNumber(0.000123)).toBe('0');
    expect(csvNumber(1791564719000)).toBe('1791564719000');
    expect(csvNumber(1.23456, 2)).toBe('1,23');
    expect(csvNumber(-3.1)).toBe('-3,1');
    expect(csvNumber(Number.NaN)).toBe('');
  });

  it('quotes separators/quotes/newlines and neutralizes spreadsheet formulas', () => {
    expect(csvField('a;b')).toBe('"a;b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('line1\nline2')).toBe('"line1\nline2"');
    expect(csvField('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvField('-5 dBmV')).toBe("'-5 dBmV");
    expect(csvField(null)).toBe('');
    expect(csvField(true)).toBe('ja');
    expect(csvField(false)).toBe('nein');
  });

  it('builds CRLF rows; BOM marks UTF-8 for Excel', () => {
    expect(csvRow(['Zeit', 1.5, null, 'Ü'])).toBe('Zeit;1,5;;Ü\r\n');
    expect(CSV_BOM.charCodeAt(0)).toBe(0xfeff);
  });
});
