// R09 docsis-values: DOCSIS values outside the Vodafone guide values (rated snapshot), T3 clusters
// (≥ 3 in 10 min or ≥ 10 per day), any T4 / sync loss / ranging failure / critical CM-STATUS,
// partial service or lost channels (docs/research/critique.md R09, docsis-thresholds.md §11/§14).
// Single T3 timeouts are tolerated ("vereinzelt") and never trigger on their own.
import { fmtDb, fmtNumber } from '../../../shared/format';
import type { DocsisChannel, Finding, FindingEvidence, NetEvent } from '../../../shared/types';
import { isSevereLineEntry, isUpstreamPartial, lineLogKind } from '../router-log';
import { fmtCount, joinDe } from '../text';
import { MINUTE, maxInWindow, maxPerLocalDay } from '../time';
import type { DiagnosisInput } from '../types';
import { eventCount, eventIds, eventsOf, findingScore, segmentImpact } from '../util';

export const DOCSIS_VALUES = 'docsis-values';

export const LINE_RECOMMENDATIONS: readonly string[] = [
  'Koaxialkabel zwischen Vodafone Station und Kabeldose prüfen bzw. tauschen (keine Verlängerung, kein Verteiler), Stecker fest auf die Dose schrauben.',
  'Ungenutzte Koax-Kabel und offene Anschlüsse im Haushalt entfernen; Powerline-Adapter testweise abziehen (sie stören den Rückkanal).',
  'Vodafone-Techniker anfordern (Hausverkabelung, Dose, Verstärker prüfen und einpegeln) und den Bericht dieser App mit DOCSIS-Werten und Router-Protokoll vorlegen.',
];

export function channelLabel(c: DocsisChannel): string {
  const dir = c.dir === 'ds' ? 'Downstream' : 'Upstream';
  const freq = c.frequencyText
    ? `${c.frequencyText} MHz`
    : c.frequencyMHz !== null
      ? `${fmtNumber(c.frequencyMHz, c.frequencyMHz % 1 === 0 ? 0 : 1)} MHz`
      : `Kanal ${c.channelId ?? '?'}`;
  return `${dir} ${c.type} ${freq}`;
}

function channelValue(c: DocsisChannel): string {
  const parts: string[] = [];
  if (c.powerDbmv !== null) parts.push(`Pegel ${fmtDb(c.powerDbmv, 'dBmV')}`);
  if (c.snrDb !== null) parts.push(`${c.type === 'OFDM' ? 'MER' : 'SNR'} ${fmtDb(c.snrDb)}`);
  if (c.locked === false) parts.push('nicht gelockt');
  const note = c.ratingNote ? ` – ${c.ratingNote}` : '';
  return `${parts.join(', ') || 'Werte unvollständig'}${note}`;
}

interface LineLog {
  t3: NetEvent[];
  severe: NetEvent[];
  partial: NetEvent[];
  t3Cluster: ReturnType<typeof maxInWindow>;
  t3PerDay: ReturnType<typeof maxPerLocalDay>;
}

export function summarizeLineLog(input: DiagnosisInput): LineLog {
  const logs = eventsOf(input, 'router_log');
  const t3 = logs.filter((e) => lineLogKind(e) === 'T3');
  const t3ts = t3.map((e) => e.ts).sort((a, b) => a - b);
  return {
    t3,
    severe: logs.filter(isSevereLineEntry),
    partial: logs.filter((e) => lineLogKind(e) === 'partial'),
    t3Cluster: maxInWindow(t3ts, 10 * MINUTE),
    t3PerDay: maxPerLocalDay(t3ts),
  };
}

export function docsisValues(input: DiagnosisInput): Finding | null {
  const snap = input.docsis;
  const channels = snap ? [...snap.ds, ...snap.us] : [];
  const badCh = channels.filter((c) => c.rating === 'bad');
  const warnCh = channels.filter((c) => c.rating === 'warn');
  const snapBad = snap?.rating === 'bad' || badCh.length > 0;
  const snapWarn = !snapBad && (snap?.rating === 'warn' || warnCh.length > 0);

  const log = summarizeLineLog(input);
  const t3Critical = log.t3Cluster.count >= 3 || log.t3PerDay.count >= 10;
  const usPartial = log.partial.some(isUpstreamPartial);

  const locked = input.metrics['docsis.ds.locked'];
  const lostChannels = locked && locked.max !== null && locked.min !== null && locked.count >= 2 ? locked.max - locked.min : 0;
  const changes = eventsOf(input, 'docsis_change').filter((e) => e.severity !== 'info');

  const logFault = t3Critical || log.severe.length > 0 || log.partial.length > 0;
  if (!snapBad && !snapWarn && !logFault && lostChannels < 1 && changes.length === 0) return null;

  const severity = snapBad || t3Critical || log.severe.length > 0 || usPartial || lostChannels >= 2 ? 'critical' : 'warn';
  const valueEvidence = snapBad || snapWarn;
  const confidence = valueEvidence && logFault ? 'high' : snapBad || logFault ? 'medium' : 'low';

  const issues: string[] = [];
  if (snapBad) issues.push(`${fmtCount(badCh.length || 1, 'Kanal', 'Kanäle')} im kritischen Bereich`);
  else if (snapWarn) issues.push(`${fmtCount(warnCh.length || 1, 'Kanal', 'Kanäle')} grenzwertig`);
  if (t3Critical) issues.push(`gehäufte T3-Timeouts (bis ${log.t3Cluster.count} in 10 min, bis ${log.t3PerDay.count} an einem Tag)`);
  if (log.severe.length > 0) issues.push(`${fmtCount(log.severe.length, 'schwerer Leitungsfehler', 'schwere Leitungsfehler')} im Router-Protokoll (T4/Sync-Verlust/Ranging)`);
  if (log.partial.length > 0) issues.push(`${log.partial.length}× Teilbetrieb (Kanäle verloren)`);
  if (lostChannels >= 1) issues.push(`zeitweise ${fmtCount(lostChannels, 'Downstream-Kanal', 'Downstream-Kanäle')} weniger gelockt`);
  if (issues.length === 0 && changes.length > 0) issues.push(`${changes.length} auffällige Änderungen der Kanalwerte`);

  const summary =
    `Die Werte des Kabelanschlusses sind auffällig: ${joinDe(issues)}. ` +
    'Solche Leitungsprobleme verursachen Latenzspitzen, Paketverlust und kurze Abbrüche – zuständig ist Vodafone (Hausverkabelung, Dose, Verstärker oder Segment).';

  const evidence: FindingEvidence[] = [];
  if (snap) {
    const label = snap.rating === 'bad' ? 'kritisch' : snap.rating === 'warn' ? 'grenzwertig' : snap.rating === 'good' ? 'gut' : 'unbekannt';
    evidence.push({ label: 'DOCSIS-Bewertung (letzte Abfrage)', value: label, ts: input.docsisTs ?? snap.ts });
  }
  for (const c of [...badCh, ...warnCh].slice(0, 4)) evidence.push({ label: channelLabel(c), value: channelValue(c) });
  for (const n of (snap?.notes ?? []).slice(0, 3)) evidence.push({ label: 'Hinweis der Router-Auswertung', value: n });
  const snr = input.metrics['docsis.ds.snr_min'];
  if (snr?.min != null) evidence.push({ label: 'Niedrigster Downstream-SNR im Zeitraum', value: fmtDb(snr.min) });
  const usMax = input.metrics['docsis.us.power_max'];
  if (usMax?.max != null) evidence.push({ label: 'Höchster Upstream-Sendepegel im Zeitraum', value: fmtDb(usMax.max, 'dBmV') });
  if (log.t3.length > 0) {
    evidence.push({
      label: 'T3-Timeouts im Router-Protokoll',
      value: `${log.t3.length} (max. ${log.t3Cluster.count} in 10 min)`,
      ts: log.t3Cluster.startTs ?? undefined,
      tsEnd: log.t3Cluster.endTs ?? undefined,
    });
  }
  for (const e of log.severe.slice(-3).reverse()) evidence.push({ label: 'Router-Protokoll', value: e.title, ts: e.ts });
  for (const e of log.partial.slice(-2).reverse()) evidence.push({ label: 'Teilbetrieb', value: e.title, ts: e.ts, tsEnd: e.endTs ?? undefined });
  if (lostChannels >= 1 && locked) evidence.push({ label: 'Gelockte Downstream-Kanäle (min/max)', value: `${locked.min} / ${locked.max}` });
  const reboots = eventCount(input, 'router_reboot');
  if (reboots > 0) evidence.push({ label: 'Router-Neustarts im Zeitraum', value: String(reboots) });
  if (input.seconds && input.seconds.access > 0) evidence.push({ label: 'ACCESS-Sekunden (Kabelnetz)', value: `${fmtNumber(input.seconds.access)} s` });

  return {
    id: DOCSIS_VALUES,
    severity,
    confidence,
    segment: 'docsis',
    title: 'Kabelanschluss: Leitungswerte auffällig',
    summary,
    evidence,
    recommendations: [...LINE_RECOMMENDATIONS],
    score: findingScore(severity, confidence, segmentImpact(input, 'docsis')),
    relatedEventIds: eventIds([...log.severe, ...log.partial, ...log.t3, ...changes]),
  };
}
