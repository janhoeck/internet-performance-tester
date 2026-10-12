// CLI: turns an HTML fragment written by Claude into a styled, printable document (+ PDF via the
// installed Edge/Chrome in headless mode). Charts are inserted for <!--GRAFIK:name--> markers,
// [[Platzhalter]] become highlighted fields the user still has to fill in.
//
//   npx tsx .claude/skills/netz-auswertung/scripts/render.ts <ordner> <auswertung|vodafone|messprotokoll> [--kein-pdf]
//     auswertung     <ordner>/auswertung-inhalt.html    → auswertung.html/.pdf
//     vodafone       <ordner>/vodafone-anschreiben.html → vodafone-stoerungsmeldung.html/.pdf (+ Messprotokoll)
//     messprotokoll  (nur Daten)                        → messprotokoll.html/.pdf
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { fmtDateTime } from '../../../../src/lib/shared/format';
import { renderAnlage } from './anlage';
import { GRAFIKEN, renderGrafik } from './charts';
import type { AuswertungData } from './data';
import { esc } from './text';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PDF_TIMEOUT_MS = 90_000;

type DocKind = 'auswertung' | 'vodafone' | 'messprotokoll';

/** `head`: Netzpuls header line on top – not on a letter (the annex brings its own header) */
const DOCS: Record<DocKind, { input: string | null; output: string; title: string; head: boolean }> = {
  auswertung: { input: 'auswertung-inhalt.html', output: 'auswertung', title: 'Auswertung Internetanschluss', head: true },
  vodafone: { input: 'vodafone-anschreiben.html', output: 'vodafone-stoerungsmeldung', title: 'Störungsmeldung Internetanschluss', head: false },
  messprotokoll: { input: null, output: 'messprotokoll', title: 'Messprotokoll Internetanschluss', head: true },
};

function fail(message: string): never {
  console.error(`FEHLER: ${message}`);
  process.exit(1);
}

/** replaces chart markers; unknown names are reported and left visible */
export function insertGrafiken(html: string, data: AuswertungData, unknown: string[] = []): string {
  return html.replace(/<!--\s*GRAFIK:([a-z-]+)\s*-->/g, (m, name: string) => {
    const svg = renderGrafik(name, data);
    if (svg === null) {
      unknown.push(name);
      return `<p class="fill">Unbekannte Grafik „${esc(name)}“</p>`;
    }
    return svg;
  });
}

/** drops HTML comments (template instructions) except the chart markers */
export function stripComments(html: string): string {
  return html.replace(/<!--(?!\s*GRAFIK:)[\s\S]*?-->\s*/g, '');
}

/** [[Kundennummer]] → highlighted fill-in field; returns the field names */
export function markPlaceholders(html: string): { html: string; fields: string[] } {
  const fields: string[] = [];
  const out = html.replace(/\[\[([^\]\n]{1,80})\]\]/g, (_m, name: string) => {
    fields.push(name.trim());
    return `<span class="fill">${name.trim()}</span>`;
  });
  return { html: out, fields };
}

export function wrapDocument(title: string, body: string, data: AuswertungData, css: string, head = true): string {
  const header = head
    ? `<header class="doc-head">
<div><div class="brand">Netzpuls · Leitungsdiagnose</div><div class="muted small">${esc(data.zeitraum.quelle)}</div></div>
<div class="meta">${esc(fmtDateTime(data.zeitraum.from))} – ${esc(fmtDateTime(data.zeitraum.to))}<br>erstellt ${esc(fmtDateTime(data.erzeugt))}</div>
</header>
`
    : '';
  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${css}</style>
</head>
<body>
${header}${body}
</body>
</html>
`;
}

/** Chromium-based browsers in the standard macOS install locations (system-wide and per user). */
function macBrowserCandidates(): string[] {
  const apps = ['/Applications', path.join(os.homedir(), 'Applications')];
  const bundles: [string, string][] = [
    ['Google Chrome.app', 'Google Chrome'],
    ['Microsoft Edge.app', 'Microsoft Edge'],
    ['Chromium.app', 'Chromium'],
    ['Brave Browser.app', 'Brave Browser'],
  ];
  return apps.flatMap((dir) => bundles.map(([app, bin]) => path.join(dir, app, 'Contents', 'MacOS', bin)));
}

function findBrowser(): string | null {
  if (process.platform === 'darwin') return macBrowserCandidates().find((p) => fs.existsSync(p)) ?? null;
  const pf = process.env.ProgramFiles ?? 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
  const local = process.env.LOCALAPPDATA ?? '';
  const candidates = [
    path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    local ? path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
  ];
  return candidates.find((p) => p !== '' && fs.existsSync(p)) ?? null;
}

/** prints the HTML file to PDF with a headless browser in a throw-away profile */
function printPdf(browser: string, htmlFile: string, pdfFile: string): Promise<void> {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'netzpuls-pdf-'));
  const argv = [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    `--user-data-dir=${profile}`,
    '--no-pdf-header-footer',
    '--print-to-pdf-no-header',
    `--print-to-pdf=${pdfFile}`,
    pathToFileURL(htmlFile).href,
  ];
  return new Promise<void>((resolve, reject) => {
    const child = spawn(browser, argv, { stdio: 'ignore', windowsHide: true });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Zeitüberschreitung beim PDF-Druck'));
    }, PDF_TIMEOUT_MS);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('exit', () => {
      clearTimeout(timer);
      if (fs.existsSync(pdfFile) && fs.statSync(pdfFile).size > 0) resolve();
      else reject(new Error('Browser hat keine PDF-Datei erzeugt'));
    });
  }).finally(() => {
    try {
      fs.rmSync(profile, { recursive: true, force: true });
    } catch {
      /* the browser may still hold files for a moment – the temp folder is harmless */
    }
  });
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ options: { 'kein-pdf': { type: 'boolean', default: false } }, allowPositionals: true });
  const [dirArg, kindArg] = positionals;
  if (!dirArg || !kindArg) fail('Aufruf: render.ts <ordner> <auswertung|vodafone|messprotokoll> [--kein-pdf]');
  if (!(kindArg in DOCS)) fail(`Unbekannter Dokumenttyp „${kindArg}“ (auswertung, vodafone oder messprotokoll)`);
  const kind = kindArg as DocKind;
  const doc = DOCS[kind];
  const dir = path.resolve(dirArg);
  const dataFile = path.join(dir, 'daten.json');
  if (!fs.existsSync(dataFile)) fail(`${dataFile} fehlt – zuerst collect.ts ausführen`);
  const data = JSON.parse(fs.readFileSync(dataFile, 'utf8')) as AuswertungData;

  let body = '';
  if (doc.input) {
    const inputFile = path.join(dir, doc.input);
    if (!fs.existsSync(inputFile)) fail(`${inputFile} fehlt – zuerst den Inhalt schreiben (Vorlage: templates/${doc.input})`);
    body = fs.readFileSync(inputFile, 'utf8');
  }
  if (kind === 'vodafone') body += `\n<div class="page-break"></div>\n${renderAnlage(data)}`;
  if (kind === 'messprotokoll') body = renderAnlage(data);

  const unknown: string[] = [];
  const marked = markPlaceholders(insertGrafiken(stripComments(body), data, unknown));
  const css = fs.readFileSync(path.join(HERE, 'style.css'), 'utf8');
  const htmlFile = path.join(dir, `${doc.output}.html`);
  fs.writeFileSync(htmlFile, wrapDocument(doc.title, marked.html, data, css, doc.head), 'utf8');
  console.log(`HTML:       ${htmlFile}`);
  if (unknown.length) console.log(`WARNUNG:    unbekannte Grafiken: ${unknown.join(', ')} (verfügbar: ${GRAFIKEN.join(', ')})`);
  if (marked.fields.length) console.log(`AUSFÜLLEN:  ${[...new Set(marked.fields)].join(' · ')}`);

  if (values['kein-pdf']) return;
  const browser = findBrowser();
  if (!browser) {
    console.log(`PDF:        kein Edge/Chrome gefunden – HTML im Browser öffnen und mit ${process.platform === 'darwin' ? '⌘P' : 'Strg+P'} „Als PDF speichern“.`);
    return;
  }
  const pdfFile = path.join(dir, `${doc.output}.pdf`);
  try {
    await printPdf(browser, htmlFile, pdfFile);
    console.log(`PDF:        ${pdfFile}`);
  } catch (err) {
    console.log(`PDF:        fehlgeschlagen (${err instanceof Error ? err.message : String(err)}) – HTML im Browser öffnen und mit Strg+P als PDF speichern.`);
  }
}

const isCli = !!process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (isCli) await main();
