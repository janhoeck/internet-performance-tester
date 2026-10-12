// Deterministic "Messprotokoll" (measurement record) for the provider – appended to the Vodafone
// letter by render.ts. Every number comes straight from the data; no interpretation beyond the
// app's own classification. Pure function: AuswertungData → HTML fragment.
import { BAD_CLASSES, type BadClass } from '../../../../src/lib/server/diagnosis/text';
import { DASH, fmtDateTime, fmtDuration, fmtMbps, fmtNumber, isNum } from '../../../../src/lib/shared/format';
import type { DocsisChannel, NetEvent } from '../../../../src/lib/shared/types';
import { chartAbschnitte, chartStundenprofil, chartVerlauf } from './charts';
import type { AuswertungData } from './data';
import { tariffText } from './digest';
import { CLASS_TEXT, badSeconds, esc, ms, num, pct, share, statFor, targetName } from './text';

const HEALTH_DE: Record<string, string> = { good: 'gut', warn: 'grenzwertig', bad: 'kritisch', unknown: 'unbekannt' };
const OUTAGE_DE: Record<string, string> = {
  client: 'PC/Netzwerkkarte',
  lan: 'Heimnetz',
  docsis: 'Kabelnetz',
  aftr: 'DS-Lite-Gateway',
  isp: 'Vodafone-Netz',
  internet: 'Internet',
  unknown: 'unklar',
};

function table(header: readonly string[], rows: readonly (readonly unknown[])[], cls = ''): string {
  if (rows.length === 0) return '<p class="muted">Keine Einträge im Zeitraum.</p>';
  const th = header.map((h) => `<th>${esc(h)}</th>`).join('');
  const tr = rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('');
  return `<table class="data ${cls}"><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table>`;
}

function dl(items: readonly [string, string][]): string {
  return `<dl class="facts">${items.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`;
}

function durationOf(e: NetEvent): number | null {
  return isNum(e.endTs) ? e.endTs - e.ts : null;
}

function channelRow(c: DocsisChannel): unknown[] {
  return [
    num(c.channelId),
    c.type,
    c.frequencyText ?? num(c.frequencyMHz, 1),
    num(c.powerDbmv, 1),
    c.dir === 'ds' ? num(c.snrDb, 1) : DASH,
    c.modulation ?? DASH,
    c.dir === 'ds' ? num(c.corrected) : DASH,
    c.dir === 'ds' ? num(c.uncorrectable) : DASH,
    HEALTH_DE[c.rating] + (c.ratingNote ? ` – ${c.ratingNote}` : ''),
  ];
}

function setup(data: AuswertungData): string {
  const st = data.bundle.router.status;
  const a = data.client.adapters?.adapters.find((x) => !x.isVirtual && !x.isWifi && x.status === 'Up');
  const z = data.zeitraum;
  const d = data.bundle.diagnosis;
  return `<section class="block">
<h2>1. Messaufbau und Methode</h2>
${dl([
  ['Messzeitraum', `${fmtDateTime(z.from)} – ${fmtDateTime(z.to)} (${fmtDuration(z.to - z.from)})${z.laeuftNoch ? ', Messung läuft weiter' : ''}`],
  ['Gemessene Zeit', `${fmtNumber(data.kennzahlen.seconds.covered / 3600, 1)} h${d ? ` (Abdeckung ${pct(d.dataQuality.coveragePct)}, ${fmtNumber(d.dataQuality.samples)} Einzelmessungen)` : ''}`],
  ['Anschluss', `Vodafone Kabel (DOCSIS)${st?.dsLite ? ', DS-Lite (IPv4 über Tunnel, natives IPv6)' : ''}; Tarif: ${tariffText(data)}`],
  ['Router', `${[st?.vendor, st?.model].filter(Boolean).join(' ') || 'Vodafone Station'}${st?.firmware ? `, Firmware ${st.firmware}` : ''}, LAN-IP ${data.bundle.config.routerIp}`],
  ['Anbindung Mess-PC', a ? `LAN-Kabel, ${a.description}, ${num(a.linkMbps)} Mbit/s` : 'LAN-Kabel'],
  ['Verfahren', 'Jede Sekunde parallele Messungen (ICMP, zusätzlich TCP/UDP) zu: Router, erstem Vodafone-Knoten hinter dem Router (CMTS, IPv6), DS-Lite-Gateway (AFTR), Cloudflare und Google (IPv4 und IPv6) sowie AWS Frankfurt.'],
  ['Auswertung', 'Eine Sekunde gilt als gestört, wenn auf dem Weg ins Internet Pakete verloren gehen oder die Latenz deutlich über dem gleitenden Normalwert liegt. Sie wird dem Abschnitt zugeordnet, ab dem die Störung beginnt (z. B. Router unauffällig, aber erster Vodafone-Knoten gestört → Kabelnetz). Sind nur einzelne Ziele im Internet betroffen, zählt die Sekunde nicht zum Anschluss.'],
  ['Eigene Last ausgeschlossen', 'Minuten mit Speedtests und Sekunden mit eigener Volllast (≥ 80 % der Leitung) sind aus der Bewertung herausgenommen.'],
])}
</section>`;
}

/** seconds in which only single internet targets (AWS) were bad – not attributable to the line */
const NOT_LINE: readonly BadClass[] = ['remote'];

function result(data: AuswertungData): string {
  const s = data.kennzahlen.seconds;
  const bad = badSeconds(s) - s.remote;
  const rows = BAD_CLASSES.filter((c) => s[c] > 0 && !NOT_LINE.includes(c))
    .sort((x, y) => s[y] - s[x])
    .map((c) => [CLASS_TEXT[c].label, CLASS_TEXT[c].wo, fmtNumber(s[c]), share(s[c], s.covered), share(s[c], bad)]);
  const remote = s.remote > 0 ? ` Weitere ${fmtNumber(s.remote)} Sekunden betrafen nur einzelne Ziele im Internet bei sauberem Vodafone-Netz; sie sind dem Anschluss nicht zugeordnet und hier nicht mitgezählt.` : '';
  return `<section class="block">
<h2>2. Ergebnis: Wo entstehen die Störungen?</h2>
<p>Von ${fmtNumber(s.covered)} gemessenen Sekunden waren <strong>${fmtNumber(bad)} gestört (${share(bad, s.covered)})</strong>, davon ${fmtNumber(s.ses)} schwer (Verlust ≥ 50 % oder Latenz ≥ 200 ms).${remote}</p>
${chartAbschnitte(s, NOT_LINE)}
${table(['Abschnitt', 'Bedeutung', 'Sekunden', 'Anteil Messzeit', 'Anteil Störungen'], rows)}
</section>`;
}

function targets(data: AuswertungData): string {
  const rows = data.kennzahlen.stats
    .filter((s) => s.sent > 0)
    .map((s) => [targetName(data, s.targetId), ms(s.p50), ms(s.p95), ms(s.p99), ms(s.max), pct(s.lossPct), num(s.spikesPerHour, 1)]);
  const gw = statFor(data.kennzahlen.stats, 'gw');
  const isp = statFor(data.kennzahlen.stats, 'isp6');
  const note =
    gw && isp && isNum(gw.p99) && isNum(isp.p99)
      ? `<p class="note">Der Router selbst antwortet mit p99 ${ms(gw.p99)} und ${pct(gw.lossPct)} Verlust; ab dem ersten Vodafone-Knoten steigt p99 auf ${ms(isp.p99)} bei ${pct(isp.lossPct)} Verlust.</p>`
      : '';
  return `<section class="block">
<h2>3. Messwerte je Messpunkt (entlang des Weges)</h2>
${table(['Messpunkt', 'Median', 'p95', 'p99', 'Maximum', 'Verlust', 'Spitzen/h'], rows)}
${note}
<p class="muted">p95/p99: 95 bzw. 99 % aller Antworten waren schneller. Ohne Speedtest-Minuten.</p>
</section>`;
}

function timeline(data: AuswertungData): string {
  return `<section class="block">
<h2>4. Zeitlicher Verlauf</h2>
${chartVerlauf(data.stunden, NOT_LINE)}
${chartStundenprofil(data)}
</section>`;
}

function homeNetwork(data: AuswertungData): string {
  const gw = statFor(data.kennzahlen.stats, 'gw');
  const l = data.bundle.link.summary;
  const s = data.kennzahlen.seconds;
  const vpn = data.client.vpn;
  return `<section class="block">
<h2>5. Ausschluss des Heimnetzes</h2>
${dl([
  ['Router-Erreichbarkeit (LAN)', `Median ${ms(gw?.p50)}, p99 ${ms(gw?.p99)}, Verlust ${pct(gw?.lossPct)}`],
  ['Störungen PC/Heimnetz', `${fmtNumber(s.link + s.lan)} Sekunden (${share(s.link + s.lan, s.covered)} der Messzeit)`],
  ['Link-Abbrüche Netzwerkkarte', `${data.kennzahlen.linkDrops} im Zeitraum${l.lastDropTs ? `, letzter ${fmtDateTime(l.lastDropTs)}` : ''}`],
  ['WLAN', data.client.wlan?.connected ? 'parallel verbunden (nur Ausweichweg)' : 'nicht genutzt'],
  ['VPN', vpn?.warp?.connected ? `Cloudflare WARP aktiv (Split-Tunnel ${vpn.warp.splitTunnel === 'include' ? 'nur ausgewählte Netze – Messziele nicht getunnelt' : (vpn.warp.splitTunnel ?? DASH)})` : 'kein VPN aktiv'],
])}
</section>`;
}

function docsis(data: AuswertungData): string {
  const st = data.bundle.router.status;
  const dc = st?.docsis;
  const h = data.bundle.router.docsisHistory;
  const log = data.bundle.router.log.filter((e) => e.severity !== 'info' && (e.ts === null || (e.ts >= data.zeitraum.from && e.ts < data.zeitraum.to)));
  if (!dc && log.length === 0) {
    return `<section class="block"><h2>6. Kabelanschluss (DOCSIS)</h2><p class="muted">Keine DOCSIS-Werte erfasst (kein Router-Login hinterlegt).</p></section>`;
  }
  const hdr = ['Kanal', 'Typ', 'Frequenz (MHz)', 'Pegel (dBmV)', 'SNR/MER (dB)', 'Modulation', 'korrigiert', 'nicht korr.', 'Bewertung'];
  const vals = (a: readonly (number | null)[]) => a.filter(isNum);
  const mm = (a: readonly (number | null)[]) => (vals(a).length ? `${num(Math.min(...vals(a)), 1)} … ${num(Math.max(...vals(a)), 1)}` : DASH);
  // the Vodafone Station reports no codeword counters – never print that as "0"
  const total = (a: readonly (number | null)[]) => (vals(a).length ? num(vals(a).reduce((x, y) => x + y, 0)) : DASH);
  return `<section class="block">
<h2>6. Kabelanschluss (DOCSIS-Werte der Vodafone Station)</h2>
${dc ? `<p>Stand ${fmtDateTime(dc.ts)} · Gesamtbewertung nach Vodafone-Servicetabelle: <strong>${HEALTH_DE[dc.rating]}</strong>${dc.notes.length ? ` · ${esc(dc.notes.join(' · '))}` : ''}</p>
<h3>Downstream (${dc.ds.length} Kanäle)</h3>
${table(hdr, dc.ds.map(channelRow), 'small')}
<h3>Upstream (${dc.us.length} Kanäle)</h3>
${table(hdr, dc.us.map(channelRow), 'small')}` : ''}
${h.ts.length ? `<h3>Verlauf im Messzeitraum (${h.ts.length} Abfragen)</h3>
${table(['Wert', 'Bereich'], [
  ['Downstream-Pegel (min … max aller Kanäle)', `${mm(h.dsPowerMin)} / ${mm(h.dsPowerMax)} dBmV`],
  ['Downstream-SNR (schlechtester Kanal)', `${mm(h.dsSnrMin)} dB`],
  ['Upstream-Pegel', `${mm(h.usPowerMin)} / ${mm(h.usPowerMax)} dBmV`],
  ['Neue korrigierte / nicht korrigierbare Codewörter', `${total(h.corrDelta)} / ${total(h.uncorrDelta)}`],
])}` : ''}
<h3>Router-Ereignisprotokoll (Warnungen und Fehler im Zeitraum)</h3>
${table(['Zeit', 'Kategorie', 'Meldung'], log.slice(0, 40).map((e) => [e.ts !== null ? fmtDateTime(e.ts) : e.timeText, e.category, e.message]), 'small')}
</section>`;
}

function outages(data: AuswertungData): string {
  const list = data.bundle.outages;
  const total = list.reduce((a, e) => a + (durationOf(e) ?? 0), 0);
  const rows = list
    .slice()
    .sort((a, b) => a.ts - b.ts)
    .slice(0, 60)
    .map((e) => [fmtDateTime(e.ts), fmtDuration(durationOf(e)), OUTAGE_DE[String(e.details?.classification ?? '')] ?? String(e.details?.classification ?? DASH)]);
  return `<section class="block">
<h2>7. Verbindungsausfälle</h2>
<p>${list.length} Ausfälle, zusammen ${fmtDuration(total)}.${list.length > 60 ? ' Die Tabelle zeigt die ersten 60.' : ''}</p>
${table(['Beginn', 'Dauer', 'Ort laut Messung'], rows, 'small')}
</section>`;
}

function speed(data: AuswertungData): string {
  const list = data.bundle.speedtests.filter((s) => s.error === null);
  if (list.length === 0) return '';
  const rows = list
    .slice()
    .reverse()
    .map((s) => [fmtDateTime(s.ts), fmtMbps(s.downMbps), fmtMbps(s.upMbps), ms(s.idleLatencyMs), `+${ms(s.bloatDownMs)}`, `+${ms(s.bloatUpMs)}`, s.grade ?? DASH]);
  return `<section class="block">
<h2>8. Geschwindigkeitsmessungen</h2>
<p class="muted">Cloudflare-Speedtest mit Latenzmessung unter Last. Keine zertifizierte Messung im Sinne von § 57 Abs. 4 TKG (dafür: Breitbandmessung der Bundesnetzagentur).</p>
${table(['Zeit', 'Download', 'Upload', 'Ping (leer)', 'Latenz-Zuwachs ↓', 'Latenz-Zuwachs ↑', 'Note'], rows, 'small')}
</section>`;
}

function marks(data: AuswertungData): string {
  if (data.markierungen.length === 0) return '';
  const rows = data.markierungen.map((m) => {
    const isp = statFor(m.stats, 'isp6');
    const gw = statFor(m.stats, 'gw');
    const top = BAD_CLASSES.filter((c) => m.seconds[c] > 0).sort((x, y) => m.seconds[y] - m.seconds[x])[0];
    return [fmtDateTime(m.ts), m.text, `${badSeconds(m.seconds)} s`, top ? CLASS_TEXT[top].label : 'unauffällig', `${ms(gw?.max)} / ${pct(gw?.lossPct)}`, `${ms(isp?.max)} / ${pct(isp?.lossPct)}`];
  });
  return `<section class="block">
<h2>9. Vom Nutzer markierte Lags</h2>
${table(['Zeit', 'Notiz', 'gestörte Sek. (±2 min)', 'Abschnitt', 'Router max/Verlust', '1. Vodafone-Knoten max/Verlust'], rows, 'small')}
</section>`;
}

function route(data: AuswertungData): string {
  const parts: string[] = [];
  for (const fam of [6, 4]) {
    const t = data.bundle.traceroutes.find((x) => x.family === fam);
    if (!t) continue;
    parts.push(`<h3>IPv${fam} zu ${esc(t.target)} (${fmtDateTime(t.ts)})</h3>${table(['Hop', 'IP-Adresse', 'Ø Latenz', 'Verlust'], t.hops.slice(0, 15).map((h) => [h.hop, h.ip ?? '*', ms(h.avgMs), pct(h.lossPct)]), 'small')}`);
  }
  if (parts.length === 0) return '';
  return `<section class="block"><h2>10. Route (Traceroute)</h2>${parts.join('')}</section>`;
}

export function renderAnlage(data: AuswertungData): string {
  return `<div class="anlage">
<header class="anlage-head">
<p class="kicker">Anlage</p>
<h1>Messprotokoll Internetanschluss</h1>
<p class="muted">Automatisch erstellt mit Netzpuls (lokales Langzeit-Messprogramm) am ${fmtDateTime(data.erzeugt)} · Quelle: ${esc(data.zeitraum.quelle)}</p>
</header>
${setup(data)}
${result(data)}
${targets(data)}
${timeline(data)}
${homeNetwork(data)}
${docsis(data)}
${outages(data)}
${speed(data)}
${marks(data)}
${route(data)}
<p class="muted small">Alle Zeiten in deutscher Ortszeit. Rohdaten (sekündliche Messwerte als CSV/JSON) können auf Anfrage nachgereicht werden.</p>
</div>`;
}
