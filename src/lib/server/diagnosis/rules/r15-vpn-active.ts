// R15 vpn-active: a VPN tunnels the game traffic (WARP in exclude/full-tunnel mode, other active
// tunnel adapters) → warn; comparison WARP on/off (≥ 2 h each side): ≥ 20 % and ≥ 10 ms worse
// p95 with WARP → warn, otherwise "WARP is not the cause" (info). WARP in include mode
// (split tunnel, only company networks) is reported as a cleared suspect (info).
// Sources: critique.md R15/E6, environment.md §5.
import { fmtDuration } from '../../../shared/format';
import type { Finding, FindingEvidence } from '../../../shared/types';
import { joinDe, ms, pct } from '../text';
import { HOUR } from '../time';
import type { DiagnosisInput, VpnCompare } from '../types';
import { findingScore } from '../util';

export const VPN_ACTIVE = 'vpn-active';

const MIN_SIDE_MS = 2 * HOUR;

export type VpnCompareVerdict = 'worse' | 'same' | 'better' | null;

export function compareVpn(c: VpnCompare | null): VpnCompareVerdict {
  if (!c || c.onMs < MIN_SIDE_MS || c.offMs < MIN_SIDE_MS) return null;
  const a = c.on.p95;
  const b = c.off.p95;
  if (a === null || b === null) return null;
  const lossDiff = (c.on.lossPct ?? 0) - (c.off.lossPct ?? 0);
  if ((a - b >= 10 && a >= 1.2 * b) || lossDiff >= 0.5) return 'worse';
  if ((b - a >= 10 && b >= 1.2 * a) || lossDiff <= -0.5) return 'better';
  return 'same';
}

export function vpnActive(input: DiagnosisInput): Finding | null {
  const v = input.vpn;
  const warp = v?.warp ?? null;
  const fullTunnel = warp !== null && warp.connected === true && warp.splitTunnel === 'exclude';
  const others = (v?.otherTunnels ?? []).filter((n) => n.trim() !== '');
  const verdict = compareVpn(input.vpnCompare);
  const c = input.vpnCompare;
  const compareEvidence: FindingEvidence[] = c && verdict !== null
    ? [
        { label: 'Internet p95 mit / ohne WARP', value: `${ms(c.on.p95)} / ${ms(c.off.p95)}` },
        { label: 'Verlust mit / ohne WARP', value: `${pct(c.on.lossPct)} / ${pct(c.off.lossPct)}` },
        { label: 'Messzeit mit / ohne WARP', value: `${fmtDuration(c.onMs)} / ${fmtDuration(c.offMs)}` },
      ]
    : [];
  const stateEvidence: FindingEvidence[] = [];
  if (warp) {
    stateEvidence.push({
      label: 'Cloudflare WARP',
      value: `${warp.connected === true ? 'verbunden' : warp.connected === false ? 'getrennt' : 'Status unbekannt'}${warp.splitTunnel ? `, Split-Tunnel „${warp.splitTunnel}“` : ''}${warp.mode ? `, Modus ${warp.mode}` : ''}`,
      ts: v?.ts,
    });
  }
  if (others.length > 0) stateEvidence.push({ label: 'Weitere aktive Tunnel-Adapter', value: joinDe(others) });

  if (fullTunnel || others.length > 0 || verdict === 'worse') {
    const parts: string[] = [];
    if (fullTunnel) parts.push('Cloudflare WARP leitet den gesamten Datenverkehr durch den Tunnel (Split-Tunnel-Modus „exclude“) – auch den Spieleverkehr. Das kostet Latenz und verkleinert die Paketgröße (MTU 1280).');
    if (others.length > 0) parts.push(`Zusätzlich ${others.length === 1 ? 'ist ein Tunnel-Adapter' : 'sind Tunnel-Adapter'} aktiv (${joinDe(others)}); ob Spieleverkehr hindurchläuft, hängt von dessen Einstellungen ab.`);
    if (verdict === 'worse' && c) parts.push(`Mit WARP waren die Spitzen deutlich höher (p95 ${ms(c.on.p95)} statt ${ms(c.off.p95)}).`);
    const confidence = verdict === 'worse' || fullTunnel ? 'high' : 'medium';
    return {
      id: VPN_ACTIVE,
      severity: 'warn',
      confidence,
      segment: 'client',
      title: 'VPN leitet Spieleverkehr um',
      summary: parts.join(' '),
      evidence: [...stateEvidence, ...compareEvidence],
      recommendations: [
        'VPN beim Spielen trennen oder Spiele vom Tunnel ausnehmen (Split-Tunnel nur für Firmennetze, Modus „include“).',
        'Bei einem Firmen-VPN die WARP-Einstellungen mit der IT klären.',
      ],
      score: findingScore('warn', confidence, 0, verdict === 'worse' ? 10 : 0),
    };
  }

  if (verdict === 'same' || verdict === 'better') {
    return {
      id: VPN_ACTIVE,
      severity: 'info',
      confidence: 'high',
      segment: 'client',
      title: 'VPN (WARP) ist nicht die Ursache',
      summary: c
        ? `Mit und ohne Cloudflare WARP sind Latenz und Verlust gleich (${ms(c.on.p95)} vs. ${ms(c.off.p95)} p95) – WARP ist nicht die Ursache.`
        : 'Mit und ohne Cloudflare WARP sind Latenz und Verlust gleich – WARP ist nicht die Ursache.',
      evidence: [...stateEvidence, ...compareEvidence],
      recommendations: ['Keine Änderung nötig.'],
      score: findingScore('info', 'high'),
    };
  }

  if (warp?.installed && warp.splitTunnel === 'include') {
    return {
      id: VPN_ACTIVE,
      severity: 'info',
      confidence: 'medium',
      segment: 'client',
      title: 'VPN (WARP) leitet nur Firmennetze um',
      summary:
        'Cloudflare WARP (Firmen-VPN) leitet nur Firmennetze durch den Tunnel, der Spieleverkehr läuft direkt. WARP reagiert auf LAN-Abbrüche, verursacht sie aber nicht.',
      evidence: stateEvidence,
      recommendations: ['Keine Änderung nötig.'],
      score: findingScore('info', 'medium'),
    };
  }
  return null;
}
