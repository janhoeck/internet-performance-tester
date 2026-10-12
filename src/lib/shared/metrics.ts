// Registry of metric keys stored in the `metrics` table (generic numeric time series).
// Engine modules MUST only write keys listed here (or matching a dynamic pattern below),
// so the UI can label and chart them.

export type MetricGroup = 'pc' | 'wlan' | 'system' | 'router' | 'docsis' | 'path' | 'udp';

export interface MetricDef {
  label: string;
  unit: string;
  group: MetricGroup;
  decimals: number;
  /** how to aggregate when downsampling: avg (default), max, sum, last */
  agg?: 'avg' | 'max' | 'sum' | 'last';
}

export const METRICS: Record<string, MetricDef> = {
  // primary network adapter of the PC (polled every adapterPollSec)
  'nic.up': { label: 'Link aktiv', unit: '', group: 'pc', decimals: 0, agg: 'last' },
  'nic.link_mbps': { label: 'Link-Geschwindigkeit', unit: 'Mbit/s', group: 'pc', decimals: 0, agg: 'last' },
  'nic.rx_mbps': { label: 'Empfangen (PC)', unit: 'Mbit/s', group: 'pc', decimals: 2 },
  'nic.tx_mbps': { label: 'Gesendet (PC)', unit: 'Mbit/s', group: 'pc', decimals: 2 },
  'nic.rx_errors': { label: 'Empfangsfehler', unit: '', group: 'pc', decimals: 0, agg: 'sum' },
  'nic.tx_errors': { label: 'Sendefehler', unit: '', group: 'pc', decimals: 0, agg: 'sum' },
  'nic.rx_discards': { label: 'Verworfen (Empfang)', unit: '', group: 'pc', decimals: 0, agg: 'sum' },
  'nic.tx_discards': { label: 'Verworfen (Senden)', unit: '', group: 'pc', decimals: 0, agg: 'sum' },

  // WLAN (only while connected)
  'wlan.signal_pct': { label: 'WLAN-Signal', unit: '%', group: 'wlan', decimals: 0 },
  'wlan.rssi_dbm': { label: 'WLAN-RSSI', unit: 'dBm', group: 'wlan', decimals: 0 },
  'wlan.rx_mbps': { label: 'WLAN-Empfangsrate', unit: 'Mbit/s', group: 'wlan', decimals: 0 },
  'wlan.tx_mbps': { label: 'WLAN-Senderate', unit: 'Mbit/s', group: 'wlan', decimals: 0 },
  'wlan.channel': { label: 'WLAN-Kanal', unit: '', group: 'wlan', decimals: 0, agg: 'last' },

  // PC / engine health
  'sys.cpu_pct': { label: 'CPU-Last', unit: '%', group: 'system', decimals: 0 },
  'sys.mem_pct': { label: 'Arbeitsspeicher', unit: '%', group: 'system', decimals: 0 },
  'engine.loop_lag_ms': { label: 'Engine-Verzögerung (p99)', unit: 'ms', group: 'system', decimals: 1, agg: 'max' },
  'tcp.retrans_pct': { label: 'TCP-Neuübertragungen (IPv4)', unit: '%', group: 'system', decimals: 2 },
  'tcp6.retrans_pct': { label: 'TCP-Neuübertragungen (IPv6)', unit: '%', group: 'system', decimals: 2 },
  'pc.gaming': { label: 'Spiel aktiv', unit: '', group: 'system', decimals: 0, agg: 'max' },
  'net.on_expected_if': { label: 'Auf erwarteter Schnittstelle', unit: '', group: 'pc', decimals: 0, agg: 'last' },

  // router device
  'router.reachable': { label: 'Router erreichbar', unit: '', group: 'router', decimals: 0, agg: 'last' },
  'router.http_ms': { label: 'Router-Antwortzeit (HTTP)', unit: 'ms', group: 'router', decimals: 0 },
  'router.uptime_s': { label: 'Router-Laufzeit', unit: 's', group: 'router', decimals: 0, agg: 'last' },

  // DOCSIS summary values (per poll)
  'docsis.ds.count': { label: 'Downstream-Kanäle', unit: '', group: 'docsis', decimals: 0, agg: 'last' },
  'docsis.ds.locked': { label: 'Downstream-Kanäle gelockt', unit: '', group: 'docsis', decimals: 0, agg: 'last' },
  'docsis.ds.power_min': { label: 'DS-Pegel min', unit: 'dBmV', group: 'docsis', decimals: 1 },
  'docsis.ds.power_max': { label: 'DS-Pegel max', unit: 'dBmV', group: 'docsis', decimals: 1 },
  'docsis.ds.power_avg': { label: 'DS-Pegel Ø', unit: 'dBmV', group: 'docsis', decimals: 1 },
  'docsis.ds.snr_min': { label: 'DS-SNR/MER min', unit: 'dB', group: 'docsis', decimals: 1 },
  'docsis.ds.snr_avg': { label: 'DS-SNR/MER Ø', unit: 'dB', group: 'docsis', decimals: 1 },
  'docsis.ds.corrected_delta': { label: 'Korrigierte Codewörter (Δ)', unit: '', group: 'docsis', decimals: 0, agg: 'sum' },
  'docsis.ds.uncorrectable_delta': { label: 'Nicht korrigierbare Codewörter (Δ)', unit: '', group: 'docsis', decimals: 0, agg: 'sum' },
  'docsis.ofdm.power_avg': { label: 'OFDM-Pegel Ø', unit: 'dBmV', group: 'docsis', decimals: 1 },
  'docsis.ofdm.snr_min': { label: 'OFDM-MER min', unit: 'dB', group: 'docsis', decimals: 1 },
  'docsis.us.count': { label: 'Upstream-Kanäle', unit: '', group: 'docsis', decimals: 0, agg: 'last' },
  'docsis.us.power_min': { label: 'US-Pegel min', unit: 'dBmV', group: 'docsis', decimals: 1 },
  'docsis.us.power_max': { label: 'US-Pegel max', unit: 'dBmV', group: 'docsis', decimals: 1 },
  'docsis.us.power_avg': { label: 'US-Pegel Ø', unit: 'dBmV', group: 'docsis', decimals: 1 },
  'docsis.ofdma.power_avg': { label: 'OFDMA-Pegel Ø', unit: 'dBmV', group: 'docsis', decimals: 1 },

  // path properties
  'mtu.v4': { label: 'Pfad-MTU IPv4', unit: 'Byte', group: 'path', decimals: 0, agg: 'last' },
  'mtu.v6': { label: 'Pfad-MTU IPv6', unit: 'Byte', group: 'path', decimals: 0, agg: 'last' },
};

/** Dynamic keys: `udp.burst.<targetId>.<stat>` written by the UDP burst test. */
export const UDP_BURST_STATS = {
  loss_pct: { label: 'Burst-Verlust', unit: '%', decimals: 2 },
  avg_ms: { label: 'Burst-Latenz Ø', unit: 'ms', decimals: 1 },
  p99_ms: { label: 'Burst-Latenz p99', unit: 'ms', decimals: 1 },
  jitter_ms: { label: 'Burst-Jitter', unit: 'ms', decimals: 1 },
} as const;
export type UdpBurstStat = keyof typeof UDP_BURST_STATS;

export function udpBurstKey(targetId: string, stat: UdpBurstStat): string {
  return `udp.burst.${targetId}.${stat}`;
}

export function metricDef(key: string): MetricDef | null {
  const fixed = METRICS[key];
  if (fixed) return fixed;
  const m = /^udp\.burst\.([a-z0-9-]+)\.(loss_pct|avg_ms|p99_ms|jitter_ms)$/.exec(key);
  if (m) {
    const s = UDP_BURST_STATS[m[2] as UdpBurstStat];
    return { label: `${s.label} (${m[1]})`, unit: s.unit, group: 'udp', decimals: s.decimals };
  }
  return null;
}
