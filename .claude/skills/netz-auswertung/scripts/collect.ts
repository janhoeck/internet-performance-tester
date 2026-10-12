// CLI: collects the evaluation data of one range into berichte/<stamp>/ (daten.json + fakten.md).
// Opens the measurement database READ-ONLY, so it can run while the engine keeps measuring.
//
//   npx tsx .claude/skills/netz-auswertung/scripts/collect.ts [optionen]
//     --liste                 vorhandene Langzeittests anzeigen und beenden
//     --session <id>          bestimmter Langzeittest (Standard: laufender, sonst letzter ≥ 30 min)
//     --tage <n>              die letzten n Tage
//     --von <datum> --bis <datum>   freier Zeitraum, z. B. "2026-10-10 18:00"
//     --vergleich <id>        zusätzlich mit einem früheren Langzeittest vergleichen
//     --db <pfad>             andere Datenbank (Standard: data/netdiag.db bzw. NETDIAG_DB)
//     --out <ordner>          Ausgabeordner (Standard: berichte/<JJJJ-MM-TT_HHMM>)
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

// node:sqlite prints an ExperimentalWarning on Node 22 – keep the output readable
process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (w.name !== 'ExperimentalWarning') console.warn(`${w.name}: ${w.message}`);
});

function fail(message: string): never {
  console.error(`FEHLER: ${message}`);
  process.exit(1);
}

const { values: args } = parseArgs({
  options: {
    liste: { type: 'boolean', default: false },
    session: { type: 'string' },
    tage: { type: 'string' },
    von: { type: 'string' },
    bis: { type: 'string' },
    vergleich: { type: 'string' },
    db: { type: 'string' },
    out: { type: 'string' },
  },
  allowPositionals: false,
});

if (args.db) process.env.NETDIAG_DB = args.db;

const { resolveDbPath } = await import('../../../../src/lib/shared/db/path');
const { DatabaseSync } = await import('node:sqlite');
const dbPath = resolveDbPath();
if (!fs.existsSync(dbPath)) fail(`Keine Messdatenbank unter ${dbPath}. Zuerst Netzpuls starten (npm run start:all) und einen Langzeittest laufen lassen.`);

// read-only connection, handed to the app's db.ts singleton (src/lib/server/db.ts reuses it)
const db = new DatabaseSync(dbPath, { readOnly: true });
db.exec('PRAGMA busy_timeout = 5000');
(globalThis as typeof globalThis & { __netdiagDb?: { db: InstanceType<typeof DatabaseSync>; path: string } }).__netdiagDb = { db, path: dbPath };

const { collectData, listSessions, parseLocalDate, sessionLabel } = await import('./data');
const { buildFacts } = await import('./digest');
const { badSeconds, share } = await import('./text');
const { fmtDateTime, fmtDuration, fmtNumber } = await import('../../../../src/lib/shared/format');

if (args.liste) {
  const sessions = listSessions();
  if (sessions.length === 0) console.log('Noch keine Langzeittests vorhanden.');
  for (const s of sessions) {
    const end = s.endedAt ?? Date.now();
    console.log(`#${s.id}  ${sessionLabel(s)}  ${fmtDateTime(s.startedAt)} – ${s.endedAt ? fmtDateTime(s.endedAt) : 'läuft'}  (${fmtDuration(end - s.startedAt)}, ${s.status})`);
  }
  process.exit(0);
}

function intArg(name: string, v: string | undefined): number | null {
  if (v === undefined) return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) fail(`--${name} erwartet eine positive ganze Zahl, nicht „${v}“`);
  return n;
}

const session = intArg('session', args.session);
const tage = intArg('tage', args.tage);
const vergleich = intArg('vergleich', args.vergleich);
const now = Date.now();

let range: Parameters<typeof collectData>[0]['range'] = { kind: 'auto' };
try {
  if (session !== null) range = { kind: 'session', id: session };
  else if (tage !== null) range = { kind: 'days', days: tage };
  else if (args.von) range = { kind: 'range', from: parseLocalDate(args.von), to: args.bis ? parseLocalDate(args.bis) : now };
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}

const pad = (n: number) => String(n).padStart(2, '0');
const d = new Date(now);
const outDir = path.resolve(args.out ?? path.join('berichte', `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`));

let data: Awaited<ReturnType<typeof collectData>>;
try {
  data = await collectData({ range, vergleich, now });
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'daten.json'), JSON.stringify(data));
fs.writeFileSync(path.join(outDir, 'fakten.md'), buildFacts(data), 'utf8');
db.close();

const s = data.kennzahlen.seconds;
const bad = badSeconds(s);
console.log(`Ordner:     ${outDir}`);
console.log(`Zeitraum:   ${data.zeitraum.quelle}, ${fmtDateTime(data.zeitraum.from)} – ${fmtDateTime(data.zeitraum.to)}${data.zeitraum.laeuftNoch ? ' (läuft noch)' : ''}`);
console.log(`Gemessen:   ${fmtNumber(s.covered / 3600, 1)} h, gestört ${share(bad, s.covered)}`);
console.log(`Urteil:     ${data.bundle.diagnosis?.verdict.title ?? data.bundle.diagnosisError ?? '–'}`);
console.log('Dateien:    fakten.md (lesen), daten.json (für render.ts)');
