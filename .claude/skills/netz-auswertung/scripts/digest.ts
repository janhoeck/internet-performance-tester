// Builds fakten.md – a compact, complete German fact sheet of one evaluation range. It is the
// input for Claude's written evaluation (SKILL.md), so it states numbers, not conclusions.
import { BAD_CLASSES, CLASS_LABELS } from '../../../../src/lib/server/diagnosis/text';
import { DASH, fmtDateTime, fmtDateTimeShort, fmtDuration, fmtMbps, fmtNumber, isNum } from '../../../../src/lib/shared/format';
import type { DocsisChannel, NetEvent, SecondsRollup } from '../../../../src/lib/shared/types';
import type { AuswertungData, Kennzahlen } from './data';
import { CLASS_TEXT, badSeconds, mdTable, ms, num, pct, share, statFor, targetName } from './text';

const SEVERITY_DE: Record<string, string> = { info: 'Info', warn: 'Warnung', critical: 'kritisch' };
const CONFIDENCE_DE: Record<string, string> = { low: 'gering', medium: 'mittel', high: 'hoch' };
const HEALTH_DE: Record<string, string> = { good: 'gut', warn: 'auffällig', bad: 'kritisch', unknown: 'unbekannt' };

const MIN_HOURS_SOLID = 24;
const EVENING_FROM = 18;
const EVENING_TO = 23;

function durationOf(e: NetEvent): number | null {
  return isNum(e.endTs) ? e.endTs - e.ts : null;
}

function range(values: readonly (number | null)[]): { min: number | null; max: number | null } {
  const v = values.filter(isNum);
  return v.length ? { min: Math.min(...v), max: Math.max(...v) } : { min: null, max: null };
}

function sum(values: readonly (number | null)[]): number | null {
  const v = values.filter(isNum);
  return v.length ? v.reduce((a, b) => a + b, 0) : null;
}

/** hours (local) covered by the hourly buckets, used for the "evening included?" check */
function eveningMinutes(stunden: readonly SecondsRollup[]): number {
  let covered = 0;
  for (const b of stunden) {
    const h = new Date(b.ts).getHours();
    if (h >= EVENING_FROM && h < EVENING_TO) covered += b.covered;
  }
  return covered / 60;
}

function head(data: AuswertungData): string {
  const z = data.zeitraum;
  const d = data.bundle.diagnosis;
  const spanH = (z.to - z.from) / 3_600_000;
  const coveredH = (data.kennzahlen.seconds.covered ?? 0) / 3600;
  const warnings: string[] = [];
  if (coveredH < MIN_HOURS_SOLID) warnings.push(`Nur ${fmtNumber(coveredH, 1)} h Messdaten – Ergebnis ist VORLÄUFIG (für belastbare Aussagen ≥ 24 h, besser 48–72 h inkl. zweier Abende).`);
  if (eveningMinutes(data.stunden) < 60) warnings.push('Kein Abend (18–23 Uhr) gemessen – Überlastung zu Stoßzeiten kann noch nicht beurteilt werden.');
  if (z.laeuftNoch) warnings.push('Der Test läuft noch – Zahlen sind ein Zwischenstand.');
  if (d && d.dataQuality.coveragePct < 80) warnings.push(`Messabdeckung nur ${pct(d.dataQuality.coveragePct)} (Lücken durch Standby/Neustart?).`);
  const s = data.bundle.sessions.map((x) => `#${x.id} ${x.label ?? ''} (${fmtDateTimeShort(x.startedAt)} – ${x.endedAt ? fmtDateTimeShort(x.endedAt) : 'läuft'})`);
  return [
    '# Netzpuls – Fakten zur Auswertung',
    '',
    `- **Quelle:** ${z.quelle}`,
    `- **Zeitraum:** ${fmtDateTime(z.from)} – ${fmtDateTime(z.to)} (${fmtDuration(z.to - z.from)}, ${fmtNumber(spanH, 1)} h)`,
    `- **Gemessene Zeit:** ${fmtNumber(coveredH, 1)} h${d ? ` · Abdeckung ${pct(d.dataQuality.coveragePct)} · ${fmtNumber(d.dataQuality.samples)} Einzelmessungen · ${d.dataQuality.gaps} Lücken` : ''}`,
    `- **Erzeugt:** ${fmtDateTime(data.erzeugt)}`,
    `- **Tarif laut Einstellungen:** ${tariffText(data)}`,
    `- **Tests im Zeitraum:** ${s.join('; ') || 'keine'}`,
    '',
    warnings.length ? `> **Hinweise zur Aussagekraft:**\n${warnings.map((w) => `> - ${w}`).join('\n')}\n` : '> Datenbasis ausreichend (≥ 24 h, Abend enthalten).\n',
  ].join('\n');
}

export function tariffText(data: AuswertungData): string {
  const t = data.bundle.config.tariff;
  if (!isNum(t.downMbps) && !isNum(t.upMbps)) return 'nicht eingetragen';
  return `${t.name ? `${t.name}: ` : ''}${fmtMbps(t.downMbps)} ↓ / ${fmtMbps(t.upMbps)} ↑`;
}

function verdict(data: AuswertungData): string {
  const d = data.bundle.diagnosis;
  if (!d) return `## 1. Diagnose der App\n\n${data.bundle.diagnosisError ?? 'Keine Diagnose verfügbar.'}\n`;
  const g = d.gamingScore;
  const lines = [
    '## 1. Diagnose der App (Regelwerk R01–R20)',
    '',
    `- **Urteil (${SEVERITY_DE[d.verdict.severity]}):** ${d.verdict.title}`,
    `- **Begründung:** ${d.verdict.text}`,
    `- **Hauptabschnitt:** ${d.verdict.primarySegment ?? DASH}`,
  ];
  if (g) {
    lines.push(`- **Gaming-Score:** ${g.score}/100, Note ${g.grade}${isNum(g.mos) ? ` (MOS ≈ ${fmtNumber(g.mos, 1)})` : ''}; begrenzender Faktor: ${g.parts.find((p) => p.key === g.limiting)?.label ?? 'keiner'}`);
    lines.push(`  - ${g.parts.map((p) => `${p.label} ${p.value} (Faktor ${fmtNumber(p.factor, 2)})`).join(' · ')}`);
  } else lines.push('- **Gaming-Score:** noch nicht berechenbar (zu wenig Daten)');
  return lines.join('\n') + '\n';
}

function secondsSection(data: AuswertungData): string {
  const s = data.kennzahlen.seconds;
  const bad = badSeconds(s);
  const rows = BAD_CLASSES.filter((c) => s[c] > 0).map((c) => [CLASS_TEXT[c].label, CLASS_TEXT[c].zustaendig, fmtNumber(s[c]), share(s[c], s.covered), share(s[c], bad)]);
  return [
    '## 2. Gestörte Sekunden nach Abschnitt (Kern der Ursachenanalyse)',
    '',
    'Jede gemessene Sekunde wird eingestuft: gut, oder gestört (Verlust bzw. Latenzspitze bei den Internet-Referenzzielen) – dann wird sie dem Abschnitt zugeordnet, ab dem die Störung beginnt.',
    '',
    `- Gemessene Sekunden: ${fmtNumber(s.covered)} · gestört: ${fmtNumber(bad)} (${share(bad, s.covered)}) · davon schwer gestört (SES): ${fmtNumber(s.ses)} (${share(s.ses, s.covered)})`,
    `- Sekunden mit eigener Volllast (z. B. Download/Speedtest, aus der Bewertung ausgenommen): ${fmtNumber(s.selfLoad)}`,
    '',
    mdTable(['Abschnitt', 'zuständig', 'Sekunden', 'Anteil an Messzeit', 'Anteil an Störungen'], rows),
    `Interne Klassen-Namen: ${BAD_CLASSES.map((c) => `${c} = ${CLASS_LABELS[c]}`).join(', ')}`,
    '',
  ].join('\n');
}

function perDay(data: AuswertungData): string {
  const rows = data.bundle.secondsPerDay
    .filter((b) => b.covered > 0)
    .map((b) => {
      const bad = badSeconds(b);
      const top = BAD_CLASSES.filter((c) => b[c] > 0).sort((x, y) => b[y] - b[x])[0];
      return [new Date(b.ts).toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' }), fmtNumber(b.covered / 3600, 1) + ' h', share(bad, b.covered), share(b.ses, b.covered), top ? `${CLASS_TEXT[top].label} (${share(b[top], bad)})` : DASH];
    });
  return ['### Je Tag', '', mdTable(['Tag', 'gemessen', 'gestört', 'schwer gestört', 'häufigster Abschnitt'], rows)].join('\n');
}

function perHour(data: AuswertungData): string {
  const rows = data.stunden
    .filter((b) => b.covered >= 600)
    .map((b) => {
      const bad = badSeconds(b);
      return { b, bad, rate: bad / b.covered };
    })
    .sort((x, y) => y.rate - x.rate)
    .slice(0, 12)
    .map(({ b, bad }) => [fmtDateTimeShort(b.ts), share(bad, b.covered), share(b.access, b.covered), share(b.aftr, b.covered), share(b.link + b.lan, b.covered), share(b.remote, b.covered)]);
  return ['### Schlimmste Stunden (≥ 10 min gemessen)', '', mdTable(['Stunde ab', 'gestört gesamt', 'Kabelnetz', 'DS-Lite', 'PC/Heimnetz', 'Spieleserver/Route'], rows)].join('\n');
}

function findings(data: AuswertungData): string {
  const d = data.bundle.diagnosis;
  if (!d || d.findings.length === 0) return '## 3. Befunde\n\nKeine Befunde.\n';
  const out = ['## 3. Befunde der Regeln (nach Relevanz)', ''];
  for (const f of d.findings) {
    out.push(`### ${f.title}`);
    out.push(`- Regel \`${f.id}\` · Schwere: ${SEVERITY_DE[f.severity]} · Sicherheit: ${CONFIDENCE_DE[f.confidence]} · Relevanz ${f.score}/100 · Abschnitt: ${f.segment}`);
    out.push(`- ${f.summary}`);
    if (f.evidence.length) out.push(`- Belege: ${f.evidence.map((e) => `${e.label}: ${e.value}${isNum(e.ts) ? ` (${fmtDateTimeShort(e.ts)})` : ''}`).join(' · ')}`);
    if (f.recommendations.length) out.push(`- Empfehlungen der App:\n${f.recommendations.map((r) => `  - ${r}`).join('\n')}`);
    out.push('');
  }
  return out.join('\n');
}

function segments(data: AuswertungData): string {
  const d = data.bundle.diagnosis;
  if (!d) return '';
  const rows = d.segments.map((s) => [s.label, HEALTH_DE[s.status], s.summary, s.kpis.map((k) => `${k.label}: ${k.value}`).join(', ')]);
  return ['## 4. Zustand je Abschnitt', '', mdTable(['Abschnitt', 'Zustand', 'Zusammenfassung', 'Kennzahlen'], rows)].join('\n');
}

function targetsSection(data: AuswertungData): string {
  const t = data.bundle.config.targets;
  const rows = data.bundle.stats
    .filter((s) => s.sent > 0)
    .map((s) => {
      const cfg = t.find((x) => x.id === s.targetId);
      return [s.targetId, cfg?.name ?? '', cfg?.segment ?? '', ms(s.p50), ms(s.p95), ms(s.p99), ms(s.max), pct(s.lossPct), ms(s.jitter), num(s.spikesPerHour, 1), pct(s.coveragePct)];
    });
  return [
    '## 5. Messziele (ohne Speedtest-Minuten)',
    '',
    'Reihenfolge entlang des Weges: Router (gw*) → Kabelnetz/1. Vodafone-Knoten (isp6) → DS-Lite-Gateway (aftr, isp4) → Internet (cf*, g*) → Spiele-Regionen (aws-*).',
    '',
    mdTable(['Ziel', 'Name', 'Abschnitt', 'p50', 'p95', 'p99', 'max', 'Verlust', 'Jitter', 'Spitzen/h', 'Abdeckung'], rows),
  ].join('\n');
}

function hourProfile(data: AuswertungData): string {
  const ids = ['gw', 'isp6', 'aftr', 'cf4'].filter((id) => data.bundle.timeProfile[id]);
  if (ids.length === 0) return '';
  const rows: string[][] = [];
  for (let h = 0; h < 24; h++) {
    const entries = ids.map((id) => data.bundle.timeProfile[id]?.find((e) => e.hour === h));
    if (!entries.some((e) => e && e.minutes > 0)) continue;
    rows.push([`${String(h).padStart(2, '0')} Uhr`, fmtNumber(entries[0]?.minutes ?? 0), ...entries.map((e) => (e && e.minutes > 0 ? `${ms(e.p95)} / ${pct(e.lossPct)} / ${e.spikes}` : DASH))]);
  }
  return ['## 6. Tagesprofil (p95 / Verlust / Spitzen je Stunde, alle Tage zusammengefasst)', '', mdTable(['Stunde', 'Minuten', ...ids.map((id) => targetName(data, id))], rows)].join('\n');
}

function outages(data: AuswertungData): string {
  const list = data.bundle.outages;
  const total = sum(list.map(durationOf)) ?? 0;
  const byClass = new Map<string, number>();
  for (const e of list) {
    const c = String(e.details?.classification ?? e.segment ?? 'unknown');
    byClass.set(c, (byClass.get(c) ?? 0) + 1);
  }
  const rows = list
    .slice()
    .sort((a, b) => (durationOf(b) ?? 0) - (durationOf(a) ?? 0))
    .slice(0, 25)
    .map((e) => [fmtDateTime(e.ts), fmtDuration(durationOf(e)), String(e.details?.classification ?? e.segment ?? DASH), e.title]);
  return [
    '## 7. Ausfälle (Internet komplett weg)',
    '',
    `- Anzahl: ${list.length} · Gesamtdauer: ${fmtDuration(total)} · nach Ursache: ${[...byClass].map(([k, v]) => `${k} ${v}×`).join(', ') || DASH}`,
    '',
    mdTable(['Beginn', 'Dauer', 'Klasse', 'Titel'], rows),
  ].join('\n');
}

function linkSection(data: AuswertungData): string {
  const l = data.bundle.link;
  const a = data.client.adapters?.adapters.find((x) => !x.isVirtual && !x.isWifi && x.status === 'Up') ?? data.client.adapters?.adapters.find((x) => !x.isVirtual && !x.isWifi);
  const days = l.days.slice(-14).map((d) => [d.day, d.down, d.up1g, d.up100m, d.upOther]);
  const events = l.events.slice(0, 15).map((e) => [fmtDateTime(e.ts), e.type === 'nic_link_down' ? 'Link weg' : 'Link da', String(e.details?.cause ?? DASH), num(isNum(e.details?.speedMbps) ? (e.details?.speedMbps as number) : isNum(e.details?.relinkMbps) ? (e.details?.relinkMbps as number) : null), e.details?.wlanFailover ? 'ja' : '']);
  const vpn = data.client.vpn;
  const wlan = data.client.wlan;
  return [
    '## 8. PC, Netzwerkkarte, WLAN, VPN',
    '',
    `- Kabel-Adapter: ${a ? `${a.description} · Status ${a.status} · ${num(a.linkMbps)} Mbit/s · Treiber ${a.driverVersion ?? DASH}` : 'unbekannt'}`,
    `- Echte Link-Abbrüche im Betrieb: im Zeitraum ${data.kennzahlen.linkDrops} · letzte 24 h ${l.summary.runtimeDrops24h} · letzte 7 Tage ${l.summary.runtimeDrops7d} · letzter: ${fmtDateTime(l.summary.lastDropTs)}`,
    `- Neuverbindungen unter 1 Gbit/s: ${pct(l.summary.relinkBelow1gPct)} · WLAN-Umschaltungen (24 h): ${l.summary.wlanFailovers24h} · Boot-Relinks: ${l.summary.bootRelinks}`,
    `- WLAN: ${wlan ? (wlan.connected ? `verbunden (${wlan.band ?? ''} Kanal ${wlan.channel ?? DASH}, Signal ${pct(wlan.signalPct)})` : 'nicht verbunden') : 'unbekannt'}`,
    `- VPN/WARP: ${vpn?.warp ? `installiert, ${vpn.warp.connected ? 'verbunden' : 'getrennt'}, Split-Tunnel ${vpn.warp.splitTunnel ?? DASH}` : 'kein WARP'}${vpn && vpn.otherTunnels.length ? ` · weitere Tunnel: ${vpn.otherTunnels.join(', ')}` : ''}`,
    '',
    '### Link-Ereignisse je Tag (Windows-Ereignisprotokoll, letzte 14 Tage mit Ereignissen)',
    '',
    mdTable(['Tag', 'Abbrüche', 'wieder mit 1 Gbit/s', 'mit 100 Mbit/s', 'andere'], days),
    '### Letzte Link-Ereignisse im Zeitraum',
    '',
    mdTable(['Zeit', 'Ereignis', 'Ursache', 'Mbit/s', 'WLAN-Ausweichen'], events),
  ].join('\n');
}

function speedSection(data: AuswertungData): string {
  const list = data.bundle.speedtests;
  const k = data.kennzahlen.speed;
  const rows = list.slice(0, 20).map((s) => [fmtDateTime(s.ts), s.error ? `Fehler: ${s.error}` : `${num(s.downMbps)} / ${num(s.upMbps)}`, ms(s.idleLatencyMs), ms(s.bloatDownMs), ms(s.bloatUpMs), s.grade ?? DASH, num(s.nicLinkMbps)]);
  return [
    '## 9. Speedtests (Cloudflare, mit Bufferbloat-Messung)',
    '',
    `- Anzahl erfolgreich: ${k.n} · Median ↓ ${fmtMbps(k.downMedian)} · ↑ ${fmtMbps(k.upMedian)} · Bufferbloat-Median ↓ +${ms(k.bloatDownMedian)} / ↑ +${ms(k.bloatUpMedian)} · Tarif: ${tariffText(data)}`,
    '',
    mdTable(['Zeit', '↓ / ↑ Mbit/s', 'Ping leer', 'Bloat ↓', 'Bloat ↑', 'Note', 'Link Mbit/s'], rows),
  ].join('\n');
}

function channelRows(ch: readonly DocsisChannel[]): string[][] {
  return ch
    .filter((c) => c.rating === 'bad' || c.rating === 'warn')
    .slice(0, 20)
    .map((c) => [c.dir.toUpperCase(), num(c.channelId), c.type, c.frequencyText ?? num(c.frequencyMHz, 1), num(c.powerDbmv, 1), num(c.snrDb, 1), c.modulation ?? DASH, HEALTH_DE[c.rating], c.ratingNote ?? '']);
}

function routerSection(data: AuswertungData): string {
  const r = data.bundle.router;
  const st = r.status;
  const out = ['## 10. Router (Vodafone Station) und Kabelanschluss (DOCSIS)', ''];
  if (!st) out.push('- Keine Router-Daten.');
  else {
    out.push(`- Gerät: ${[st.vendor, st.model].filter(Boolean).join(' ') || DASH} · Firmware ${st.firmware ?? DASH} · Status „${st.connectionStatus ?? DASH}“ · DS-Lite: ${st.dsLite === null ? DASH : st.dsLite ? 'ja' : 'nein'}`);
    out.push(`- Laufzeit seit Neustart: ${isNum(st.uptimeSec) ? fmtDuration(st.uptimeSec * 1000) : DASH} · letzter Neustart-Grund: ${st.lastRebootReason ?? DASH} · Login: ${st.loggedIn ? 'ok' : st.loginConfigured ? `konfiguriert${st.loginError ? ` (Fehler: ${st.loginError})` : ''}` : 'kein Passwort hinterlegt → keine DOCSIS-Werte'}`);
    const dc = st.docsis;
    if (dc) {
      const dsLocked = dc.ds.filter((c) => c.locked !== false).length;
      const p = range(dc.ds.map((c) => c.powerDbmv));
      const snr = range(dc.ds.map((c) => c.snrDb));
      const up = range(dc.us.map((c) => c.powerDbmv));
      out.push(`- DOCSIS (Stand ${fmtDateTime(dc.ts)}): Gesamtbewertung **${HEALTH_DE[dc.rating]}** · Downstream ${dc.ds.length} Kanäle (${dsLocked} eingerastet), Pegel ${num(p.min, 1)} … ${num(p.max, 1)} dBmV, SNR/MER min ${num(snr.min, 1)} dB · Upstream ${dc.us.length} Kanäle, Pegel ${num(up.min, 1)} … ${num(up.max, 1)} dBmV`);
      out.push(`- Fehlerkorrektur (kumuliert seit Router-Start): korrigiert ${num(sum(dc.ds.map((c) => c.corrected)))} · nicht korrigierbar ${num(sum(dc.ds.map((c) => c.uncorrectable)))}`);
      if (dc.notes.length) out.push(`- Hinweise: ${dc.notes.join(' · ')}`);
      out.push('', '### Auffällige Kanäle (Bewertung nach Vodafone-Servicetabelle)', '', mdTable(['Richtung', 'Kanal', 'Typ', 'Frequenz', 'Pegel dBmV', 'SNR dB', 'Modulation', 'Bewertung', 'Grund'], channelRows([...dc.ds, ...dc.us])));
    } else out.push('- Keine DOCSIS-Kanalwerte (Router-Passwort fehlt oder Login nicht erlaubt).');
  }
  const h = r.docsisHistory;
  if (h.ts.length) {
    out.push(
      `### DOCSIS-Verlauf im Zeitraum (${h.ts.length} Abfragen)`,
      '',
      mdTable(
        ['Wert', 'min', 'max'],
        [
          ['Downstream-Pegel min (dBmV)', num(range(h.dsPowerMin).min, 1), num(range(h.dsPowerMin).max, 1)],
          ['Downstream-Pegel max (dBmV)', num(range(h.dsPowerMax).min, 1), num(range(h.dsPowerMax).max, 1)],
          ['Downstream-SNR min (dB)', num(range(h.dsSnrMin).min, 1), num(range(h.dsSnrMin).max, 1)],
          ['Upstream-Pegel min (dBmV)', num(range(h.usPowerMin).min, 1), num(range(h.usPowerMin).max, 1)],
          ['Upstream-Pegel max (dBmV)', num(range(h.usPowerMax).min, 1), num(range(h.usPowerMax).max, 1)],
        ],
      ),
      `- Zuwachs Fehlerkorrektur im Zeitraum: korrigiert ${num(sum(h.corrDelta))} · nicht korrigierbar ${num(sum(h.uncorrDelta))}`,
      '',
    );
  }
  const log = r.log.filter((e) => e.ts === null || (e.ts >= data.zeitraum.from && e.ts < data.zeitraum.to));
  const cats = new Map<string, number>();
  for (const e of log) cats.set(e.category, (cats.get(e.category) ?? 0) + 1);
  const important = log.filter((e) => e.severity !== 'info');
  out.push(
    `### Router-Ereignisprotokoll im Zeitraum (${log.length} Einträge, ${important.length} Warnungen/Fehler)`,
    '',
    `- Kategorien: ${[...cats].map(([k, v]) => `${k} ${v}×`).join(', ') || DASH} (T3/T4 = Zeitüberschreitungen der Kabelmodem-Kommunikation mit dem CMTS, „ranging“/„sync“ = Neueinmessung)`,
    '',
    mdTable(
      ['Zeit', 'Schwere', 'Kategorie', 'Meldung'],
      (important.length ? important : log).slice(0, 25).map((e) => [e.ts !== null ? fmtDateTime(e.ts) : e.timeText, SEVERITY_DE[e.severity], e.category, e.message]),
    ),
  );
  return out.join('\n');
}

function pathSection(data: AuswertungData): string {
  const out = ['## 11. Route, MTU, NAT', ''];
  const trs = data.bundle.traceroutes;
  for (const fam of [6, 4]) {
    const t = trs.find((x) => x.family === fam);
    if (!t) continue;
    out.push(`### Letzte Route IPv${fam} zu ${t.target} (${fmtDateTime(t.ts)}, Ziel ${t.reached ? 'erreicht' : 'nicht erreicht'})`, '');
    out.push(mdTable(['Hop', 'IP', 'Ø', 'Verlust'], t.hops.slice(0, 15).map((h) => [h.hop, h.ip ?? '*', ms(h.avgMs), pct(h.lossPct)])));
  }
  out.push(`- Routenwechsel im Zeitraum: ${trs.filter((t) => t.changed).length}`);
  for (const m of data.bundle.path.mtu) out.push(`- MTU IPv${m.family}: ${num(m.mtu)} Byte${m.note ? ` (${m.note})` : ''}`);
  for (const n of data.bundle.path.nat) out.push(`- NAT IPv${n.family}: ${n.mapping}${n.cgnat ? ' · Carrier-NAT/DS-Lite' : ''}`);
  return out.join('\n') + '\n';
}

function marks(data: AuswertungData): string {
  if (data.markierungen.length === 0) return '## 12. Lag-Markierungen\n\nKeine „Lag markieren“-Einträge im Zeitraum.\n';
  const rows = data.markierungen.map((m) => {
    const bad = badSeconds(m.seconds);
    const top = BAD_CLASSES.filter((c) => m.seconds[c] > 0).sort((x, y) => m.seconds[y] - m.seconds[x])[0];
    const gw = statFor(m.stats, 'gw');
    const isp = statFor(m.stats, 'isp6');
    const cf = statFor(m.stats, 'cf4');
    return [fmtDateTime(m.ts), m.text, `${bad} von ${m.seconds.covered}`, top ? CLASS_TEXT[top].label : 'nichts auffällig', `${ms(gw?.max)} / ${pct(gw?.lossPct)}`, `${ms(isp?.max)} / ${pct(isp?.lossPct)}`, `${ms(cf?.max)} / ${pct(cf?.lossPct)}`];
  });
  return [
    '## 12. Lag-Markierungen (2 min davor bis 1 min danach)',
    '',
    mdTable(['Zeit', 'Notiz', 'gestörte Sekunden', 'häufigster Abschnitt', 'Router max/Verlust', 'Kabelnetz max/Verlust', 'Internet max/Verlust'], rows),
  ].join('\n');
}

function notable(data: AuswertungData): string {
  const ev = data.bundle.notableEvents;
  const byType = new Map<string, { n: number; crit: number }>();
  for (const e of ev) {
    const x = byType.get(e.type) ?? { n: 0, crit: 0 };
    x.n++;
    if (e.severity === 'critical') x.crit++;
    byType.set(e.type, x);
  }
  const rows = ev
    .filter((e) => e.type !== 'latency_spike' && e.type !== 'router_log')
    .slice(0, 25)
    .map((e) => [fmtDateTime(e.ts), SEVERITY_DE[e.severity], e.type, e.title]);
  return [
    '## 13. Auffällige Ereignisse (Warnung/kritisch)',
    '',
    `- Nach Typ: ${[...byType].map(([k, v]) => `${k} ${v.n}× (${v.crit} kritisch)`).join(', ') || DASH}${ev.length >= 2000 ? ' – Liste auf 2000 begrenzt' : ''}`,
    '',
    mdTable(['Zeit', 'Schwere', 'Typ', 'Titel'], rows),
  ].join('\n');
}

export function kennzahlenRows(k: Kennzahlen): string[] {
  const s = k.seconds;
  const bad = badSeconds(s);
  const st = (id: string) => statFor(k.stats, id);
  return [
    fmtNumber(s.covered / 3600, 1) + ' h',
    share(bad, s.covered),
    share(s.access + s.aftr + s.backbone, s.covered),
    share(s.link + s.lan, s.covered),
    `${ms(st('gw')?.p99)} / ${pct(st('gw')?.lossPct)}`,
    `${ms(st('isp6')?.p99)} / ${pct(st('isp6')?.lossPct)}`,
    `${ms(st('cf4')?.p99)} / ${pct(st('cf4')?.lossPct)}`,
    String(k.linkDrops),
    k.speed.n ? `${fmtMbps(k.speed.downMedian)} / ${fmtMbps(k.speed.upMedian)}, Bloat ↑ +${ms(k.speed.bloatUpMedian)}` : DASH,
  ];
}

export const KENNZAHLEN_HEADER = ['Test', 'gemessen', 'gestört', 'davon Vodafone-Seite', 'davon PC/Heimnetz', 'Router p99/Verlust', 'Kabelnetz p99/Verlust', 'Internet p99/Verlust', 'Link-Abbrüche', 'Speed (Median)'];

function compare(data: AuswertungData): string {
  if (!data.vergleich) return '';
  return [
    '## 14. Vergleich zweier Tests (vorher/nachher)',
    '',
    mdTable(KENNZAHLEN_HEADER, [
      [data.vergleich.label, ...kennzahlenRows(data.vergleich)],
      [data.kennzahlen.label, ...kennzahlenRows(data.kennzahlen)],
    ]),
  ].join('\n');
}

export function buildFacts(data: AuswertungData): string {
  return [
    head(data),
    verdict(data),
    secondsSection(data),
    perDay(data),
    perHour(data),
    findings(data),
    segments(data),
    targetsSection(data),
    hourProfile(data),
    outages(data),
    linkSection(data),
    speedSection(data),
    routerSection(data),
    pathSection(data),
    marks(data),
    notable(data),
    compare(data),
    '## Datenqualität',
    '',
    ...(data.bundle.diagnosis?.dataQuality.notes.map((n) => `- ${n}`) ?? []),
    data.bundle.diagnosisError ? `- ${data.bundle.diagnosisError}` : '',
    '',
  ].join('\n');
}
