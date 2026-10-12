// Dependency-free inline SVG charts for the printable documents (A4, light paper colours).
// Pure functions: data in, SVG string out. Placeholders <!--GRAFIK:name--> in the documents are
// replaced by renderGrafik() (render.ts).
import { fmtNumber } from '../../../../src/lib/shared/format';
import type { BadClass } from '../../../../src/lib/server/diagnosis/text';
import type { SecondsRollup } from '../../../../src/lib/shared/types';
import type { AuswertungData } from './data';
import { CLASSES, CLASS_TEXT, SERIES_COLOR, esc, share, targetName } from './text';

const W = 720;
const FONT = 'font-family="Segoe UI, Arial, sans-serif"';
const GRID = '#E6EBF1';
const AXIS = '#C0C8D3';
const INK = '#394353';
const MUTED = '#586475';

/** 1-2-5 "nice" upper bound for an axis */
export function niceMax(v: number): number {
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (v <= m * p) return m * p;
  return 10 * p;
}

function frame(h: number, body: string, title: string): string {
  return `<svg class="chart" viewBox="0 0 ${W} ${h}" role="img" aria-label="${esc(title)}" xmlns="http://www.w3.org/2000/svg" ${FONT}>${body}</svg>`;
}

/** legend that wraps into rows; returns the SVG and the height it needs */
function legend(items: readonly { label: string; color: string }[], top = 4, x0 = 56): { svg: string; height: number } {
  const maxX = W - 12;
  let x = x0;
  let row = 0;
  let svg = '';
  for (const it of items) {
    const w = 24 + it.label.length * 6.1;
    if (x > x0 && x + w > maxX) {
      row++;
      x = x0;
    }
    const y = top + 12 + row * 17;
    svg += `<rect x="${x}" y="${y - 9}" width="12" height="12" rx="2" fill="${it.color}"/><text x="${x + 17}" y="${y + 1}" font-size="11" fill="${INK}">${esc(it.label)}</text>`;
    x += w;
  }
  return { svg, height: items.length ? top + 12 + row * 17 + 10 : 0 };
}

/** 4 or 5 grid steps, whichever gives round tick values for a niceMax() upper bound */
export function tickCount(max: number): number {
  for (const t of [4, 5]) {
    const step = max / t;
    const q = step / 10 ** Math.floor(Math.log10(step));
    if ([1, 2, 2.5, 5, 10].some((m) => Math.abs(q - m) < 1e-9)) return t;
  }
  return 4;
}

function yAxis(x0: number, x1: number, top: number, bottom: number, max: number, unit: string, ticks = tickCount(max)): string {
  let out = '';
  const step = max / ticks;
  const decimals = step < 1 ? 2 : step % 1 ? 1 : 0;
  for (let i = 0; i <= ticks; i++) {
    const y = bottom - ((bottom - top) * i) / ticks;
    out += `<line x1="${x0}" x2="${x1}" y1="${y}" y2="${y}" stroke="${i === 0 ? AXIS : GRID}"/>`;
    out += `<text x="${x0 - 6}" y="${y + 4}" font-size="10" fill="${MUTED}" text-anchor="end">${fmtNumber(step * i, decimals)}${unit}</text>`;
  }
  return out;
}

const EMPTY = (title: string) => frame(60, `<text x="${W / 2}" y="34" font-size="12" fill="${MUTED}" text-anchor="middle">${esc(title)}: keine Daten</text>`, title);

/** p95 latency per hour of day (all days merged) for router, cable network, DS-Lite and internet */
export function chartStundenprofil(data: AuswertungData): string {
  const title = 'Latenz (p95) je Tageszeit';
  const ids = ['gw', 'isp6', 'aftr', 'cf4'].filter((id) => data.bundle.timeProfile[id]?.some((e) => e.minutes > 0));
  if (ids.length === 0) return EMPTY(title);
  const lg = legend(ids.map((id) => ({ label: targetName(data, id), color: SERIES_COLOR[id] ?? INK })));
  const T = lg.height + 10;
  const H = T + 200;
  const L = 56, R = W - 16, B = H - 34;
  let max = 0;
  for (const id of ids) for (const e of data.bundle.timeProfile[id] ?? []) if (e.minutes > 0 && e.p95 !== null) max = Math.max(max, e.p95);
  max = niceMax(max * 1.08);
  const x = (h: number) => L + ((R - L) * (h + 0.5)) / 24;
  const y = (v: number) => B - ((B - T) * Math.min(v, max)) / max;
  let body = yAxis(L, R, T, B, max, ' ms');
  for (let h = 0; h < 24; h += 3) body += `<text x="${x(h)}" y="${B + 16}" font-size="10" fill="${MUTED}" text-anchor="middle">${h} Uhr</text>`;
  body += `<rect x="${x(18) - (R - L) / 48}" y="${T}" width="${((R - L) * 5) / 24}" height="${B - T}" fill="#F5DFAC" opacity="0.35"/>`;
  body += `<text x="${x(20.5)}" y="${T + 12}" font-size="10" fill="${MUTED}" text-anchor="middle">Abend</text>`;
  for (const id of ids) {
    const pts = (data.bundle.timeProfile[id] ?? []).filter((e) => e.minutes > 0 && e.p95 !== null);
    const color = SERIES_COLOR[id] ?? INK;
    const d = pts.map((e, i) => `${i === 0 ? 'M' : 'L'}${x(e.hour).toFixed(1)},${y(e.p95 ?? 0).toFixed(1)}`).join('');
    body += `<path d="${d}" fill="none" stroke="${color}" stroke-width="2.2" stroke-linejoin="round"/>`;
    for (const e of pts) body += `<circle cx="${x(e.hour).toFixed(1)}" cy="${y(e.p95 ?? 0).toFixed(1)}" r="2.6" fill="${color}"/>`;
  }
  body += lg.svg;
  return frame(H, body, title);
}

/** disturbed seconds per hour over the whole range, stacked by segment (share of measured time) */
export function chartVerlauf(stunden: readonly SecondsRollup[], exclude: readonly BadClass[] = []): string {
  const classes = CLASSES.filter((c) => !exclude.includes(c));
  const title = 'Gestörte Sekunden je Stunde nach Abschnitt';
  const rows = stunden.filter((b) => b.covered > 0);
  if (rows.length === 0) return EMPTY(title);
  const used = classes.filter((c) => rows.some((b) => b[c] > 0));
  const lg = legend(used.map((c) => ({ label: CLASS_TEXT[c].label, color: CLASS_TEXT[c].color })));
  const T = lg.height + 10;
  const H = T + 210;
  const L = 56, R = W - 16, B = H - 40;
  const first = stunden[0].ts;
  const step = stunden.length > 1 ? stunden[1].ts - stunden[0].ts : 3_600_000;
  const n = Math.max(1, Math.round((stunden[stunden.length - 1].ts - first) / step) + 1);
  let max = 0;
  for (const b of rows) max = Math.max(max, (classes.reduce((a, c) => a + b[c], 0) / b.covered) * 100);
  max = niceMax(Math.max(1, max * 1.05));
  const bw = (R - L) / n;
  const y = (pctv: number) => B - ((B - T) * pctv) / max;
  let body = yAxis(L, R, T, B, max, ' %');
  let lastDay = '';
  for (const b of stunden) {
    const i = Math.round((b.ts - first) / step);
    const x0 = L + i * bw;
    const d = new Date(b.ts);
    const day = d.toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' });
    if (day !== lastDay && (d.getHours() === 0 || lastDay === '')) {
      body += `<line x1="${x0}" x2="${x0}" y1="${T}" y2="${B + 4}" stroke="${AXIS}" stroke-dasharray="2 3"/><text x="${x0 + 3}" y="${B + 16}" font-size="10" fill="${MUTED}">${esc(day)}</text>`;
      lastDay = day;
    } else if (n <= 96 && d.getHours() % 6 === 0) {
      body += `<text x="${x0 + bw / 2}" y="${B + 28}" font-size="9" fill="${MUTED}" text-anchor="middle">${d.getHours()}h</text>`;
    }
    if (b.covered <= 0) continue;
    let acc = 0;
    for (const c of classes) {
      const v = (b[c] / b.covered) * 100;
      if (v <= 0) continue;
      body += `<rect x="${(x0 + bw * 0.08).toFixed(1)}" y="${y(acc + v).toFixed(1)}" width="${Math.max(0.8, bw * 0.84).toFixed(1)}" height="${(y(acc) - y(acc + v)).toFixed(1)}" fill="${CLASS_TEXT[c].color}"/>`;
      acc += v;
    }
  }
  body += lg.svg;
  return frame(H, body, title);
}

/** horizontal bars: share of all disturbed seconds per segment */
export function chartAbschnitte(s: SecondsRollup, exclude: readonly BadClass[] = []): string {
  const classes = CLASSES.filter((c) => !exclude.includes(c));
  const title = 'Wo die Störungen entstehen';
  const bad = classes.reduce((a, c) => a + s[c], 0);
  if (bad === 0) return EMPTY(title);
  const used = classes.filter((c) => s[c] > 0).sort((a, b) => s[b] - s[a]);
  const rowH = 30;
  const H = 18 + used.length * rowH;
  const L = 230, R = W - 90;
  let body = '';
  used.forEach((c, i) => {
    const y = 10 + i * rowH;
    const w = ((R - L) * s[c]) / bad;
    body += `<text x="${L - 10}" y="${y + 15}" font-size="12" fill="${INK}" text-anchor="end">${esc(CLASS_TEXT[c].label)}</text>`;
    body += `<rect x="${L}" y="${y + 3}" width="${R - L}" height="16" rx="3" fill="${GRID}"/>`;
    body += `<rect x="${L}" y="${y + 3}" width="${Math.max(2, w).toFixed(1)}" height="16" rx="3" fill="${CLASS_TEXT[c].color}"/>`;
    body += `<text x="${R + 8}" y="${y + 15}" font-size="12" font-weight="600" fill="${INK}">${esc(share(s[c], bad))}</text>`;
  });
  return frame(H, body, title);
}

/** chart names for <!--GRAFIK:name--> markers; '-anschluss' variants leave out 'remote' (not the line) */
export const GRAFIKEN = ['stundenprofil', 'verlauf', 'verlauf-anschluss', 'abschnitte', 'abschnitte-anschluss'] as const;

export function renderGrafik(name: string, data: AuswertungData): string | null {
  switch (name) {
    case 'stundenprofil':
      return chartStundenprofil(data);
    case 'verlauf':
      return chartVerlauf(data.stunden);
    case 'verlauf-anschluss':
      return chartVerlauf(data.stunden, ['remote']);
    case 'abschnitte':
      return chartAbschnitte(data.kennzahlen.seconds);
    case 'abschnitte-anschluss':
      return chartAbschnitte(data.kennzahlen.seconds, ['remote']);
    default:
      return null;
  }
}
