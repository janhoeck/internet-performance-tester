// Shared German labels and small helpers for the fact sheet, the charts and the Vodafone annex.
import type { BadClass } from '../../../../src/lib/server/diagnosis/text';
import { DASH, fmtMs, fmtNumber, fmtPct, isNum } from '../../../../src/lib/shared/format';
import type { SecondsRollup, TargetStats } from '../../../../src/lib/shared/types';
import type { AuswertungData } from './data';

export const CLASSES: readonly BadClass[] = ['link', 'lan', 'access', 'aftr', 'backbone', 'remote', 'unknown'];

/** where the disturbed seconds come from – plain German for non-experts */
export const CLASS_TEXT: Readonly<Record<BadClass, { label: string; wo: string; zustaendig: string; color: string }>> = {
  link: { label: 'PC-Kabel / Netzwerkkarte', wo: 'zwischen PC und Router (Link-Abbruch, WLAN-Umschaltung)', zustaendig: 'du selbst', color: '#CB5A00' },
  lan: { label: 'Heimnetz / Router', wo: 'Router antwortet langsam oder gar nicht', zustaendig: 'du selbst / Router', color: '#9E8400' },
  access: { label: 'Kabelnetz (Vodafone)', wo: 'ab dem ersten Vodafone-Knoten hinter deinem Router (CMTS)', zustaendig: 'Vodafone', color: '#C2272D' },
  aftr: { label: 'DS-Lite-Gateway (Vodafone)', wo: 'nur IPv4 gestört, IPv6 sauber (Tunnel-Gateway)', zustaendig: 'Vodafone', color: '#7544CD' },
  backbone: { label: 'Vodafone-Netz / Internet', wo: 'Kabelnetz sauber, dahinter gestört', zustaendig: 'Vodafone bzw. Übergang ins Internet', color: '#0062D4' },
  remote: { label: 'Spieleserver / Route', wo: 'nur einzelne Ziele im Internet gestört', zustaendig: 'Spieleanbieter / Route (nicht dein Anschluss)', color: '#008779' },
  unknown: { label: 'Unklar', wo: 'keinem Abschnitt eindeutig zuzuordnen', zustaendig: 'unklar', color: '#9AA4B2' },
};

/** short names of the key measuring points */
export const TARGET_SHORT: Readonly<Record<string, string>> = {
  gw: 'Router (LAN)',
  isp6: 'Kabelnetz – 1. Vodafone-Knoten (IPv6)',
  aftr: 'DS-Lite-Gateway (IPv4-Tunnel)',
  cf4: 'Internet – Cloudflare IPv4',
  cf6: 'Internet – Cloudflare IPv6',
  'aws-fra': 'Spiele-Region Frankfurt (AWS)',
};

export const SERIES_COLOR: Readonly<Record<string, string>> = {
  gw: '#008779',
  isp6: '#C2272D',
  aftr: '#7544CD',
  cf4: '#0062D4',
  cf6: '#0095B5',
  'aws-fra': '#CB5A00',
};

export function targetName(data: AuswertungData, id: string): string {
  return TARGET_SHORT[id] ?? data.bundle.config.targets.find((t) => t.id === id)?.name ?? id;
}

export function badSeconds(s: SecondsRollup): number {
  return s.link + s.lan + s.access + s.aftr + s.backbone + s.remote + s.unknown;
}

/** part/whole in % with sensible decimals ('0 %', '0,35 %', '4,2 %', '37 %') */
export function share(part: number, whole: number): string {
  if (!(whole > 0)) return DASH;
  const p = (part / whole) * 100;
  return fmtPct(p, p === 0 || p >= 10 ? 0 : p >= 1 ? 1 : 2);
}

export function ms(v: number | null | undefined): string {
  return isNum(v) ? fmtMs(v, v < 10 ? 1 : 0) : DASH;
}

export function pct(v: number | null | undefined): string {
  return isNum(v) ? fmtPct(v, v === 0 || v >= 10 ? 0 : v >= 1 ? 1 : 2) : DASH;
}

export function num(v: number | null | undefined, decimals = 0): string {
  return isNum(v) ? fmtNumber(v, decimals) : DASH;
}

export function statFor(stats: readonly TargetStats[], id: string): TargetStats | undefined {
  return stats.find((s) => s.targetId === id);
}

/** HTML escaping for text and attribute values */
export function esc(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Markdown table cell (no pipes/newlines) */
export function cell(v: unknown): string {
  return String(v ?? '').replace(/\|/g, '/').replace(/\s*\n\s*/g, ' ');
}

export function mdTable(header: readonly string[], rows: readonly (readonly unknown[])[]): string {
  if (rows.length === 0) return '_keine Daten_\n';
  const line = (r: readonly unknown[]) => `| ${r.map(cell).join(' | ')} |`;
  return [line(header), `|${header.map(() => '---').join('|')}|`, ...rows.map(line)].join('\n') + '\n';
}
