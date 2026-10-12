// Locale-tolerant classifier for Windows ping.exe lines (de-DE + en-US). Uses ASCII-only fragments so a
// wrong codepage (CP850 vs UTF-8 vs 1252) can never break classification.
export function classifyPingLine(line) {
  const s = line.trim();
  if (!s) return { kind: 'blank' };
  let m;
  if ((m = /(?:Zeit|time)([=<])(\d+)\s?ms/i.exec(s))) {
    const ttl = /TTL=(\d+)/i.exec(s);
    const bytes = /bytes=(\d+)/i.exec(s);
    const from = /^(?:Antwort von|Reply from)\s+(.+?):\s/i.exec(s); // IPv6 contains ':' -> address ends at ': '
    return { kind: 'reply', rttMs: m[1] === '<' ? 0 : +m[2], subMs: m[1] === '<', ttl: ttl ? +ttl[1] : null, bytes: bytes ? +bytes[1] : null, from: from ? from[1] : null };
  }
  const from = /^(?:Antwort von|Reply from)\s+(.+?):\s/i.exec(s)?.[1] ?? null;
  if (/Zielhost nicht erreichbar|Destination host unreachable/i.test(s)) return { kind: 'host_unreachable', from };
  if (/Zielnetz nicht erreichbar|Destination net unreachable/i.test(s)) return { kind: 'net_unreachable', from };
  if (/Zielport nicht erreichbar|Destination port unreachable/i.test(s)) return { kind: 'port_unreachable', from };
  if (/Zielprotokoll nicht erreichbar|Destination protocol unreachable/i.test(s)) return { kind: 'proto_unreachable', from };
  if (/berschreitung der Anforderung|Request timed out/i.test(s)) return { kind: 'timeout' };
  if (/fragmentiert werden|needs to be fragmented/i.test(s)) return { kind: 'frag_needed', from };
  if (/^PING: Fehler bei der|^PING: transmit failed/i.test(s)) return { kind: 'transmit_failed', detail: s.replace(/^PING:\s*(?:Fehler bei der \S+|transmit failed)\.?\s*/i, '') };
  if (/Allgemeiner Fehler|General failure/i.test(s)) return { kind: 'general_failure' };
  if (/Hardwarefehler|Hardware error/i.test(s)) return { kind: 'hardware_error' };
  if (/bei der .{1,2}bertragung .{1,2}berschritten|TTL expired in transit/i.test(s)) return { kind: 'ttl_expired', from };
  if (/Keine Ressourcen|No resources/i.test(s)) return { kind: 'no_resources' };
  if (/^Ping wird ausgef|^Pinging /i.test(s)) return { kind: 'header' };
  if (/^Ping-Statistik|^Ping statistics/i.test(s)) return { kind: 'stats_header' };
  if ((m = /(?:Gesendet|Sent) = (\d+), (?:Empfangen|Received) = (\d+), (?:Verloren|Lost) = (\d+)/i.exec(s))) return { kind: 'stats_packets', sent: +m[1], received: +m[2], lost: +m[3] };
  if ((m = /Minimum = (\d+)ms, Maximum = (\d+)ms, (?:Mittelwert|Average) = (\d+)ms/i.exec(s))) return { kind: 'stats_rtt', min: +m[1], max: +m[2], avg: +m[3] };
  if (/^\(\d+% (Verlust|loss)\)|^Ca\. Zeitangaben|^Approximate round trip/i.test(s)) return { kind: 'stats_other' };
  if (/konnte Host .* nicht finden|could not find host/i.test(s)) return { kind: 'resolve_failed' };
  return { kind: 'unknown', text: s };
}
// Loss semantics: everything except kind==='reply' counts as LOST for an echo line. NOTE: Windows itself counts
// "Zielhost nicht erreichbar" as *received* in its statistics - never trust ping's own summary.
export const ECHO_KINDS = new Set(['reply', 'host_unreachable', 'net_unreachable', 'port_unreachable', 'proto_unreachable', 'timeout', 'frag_needed', 'transmit_failed', 'general_failure', 'hardware_error', 'ttl_expired', 'no_resources']);
