// Parser for macOS `system_profiler SPAirPortDataType -json` (docs/research/macos.md §4) → WlanInfo.
// The only Wi-Fi source without admin rights since `airport` was removed (macOS 14.4): RSSI/noise,
// transmit rate, channel/band, PHY mode. No BSSID; the SSID is "<redacted>" without Location
// Services. [unverified: key names from public samples – every field is optional] Pure.
import type { WlanInfo } from '../../types';

export interface AirportInterface {
  /** BSD name, e.g. 'en0' */
  device: string;
  /** spairport_status_information, e.g. 'spairport_status_connected' */
  status: string | null;
  connected: boolean;
  ssid: string | null;
  channel: number | null;
  /** '2,4 GHz' | '5 GHz' | '6 GHz' (same wording as netsh) */
  band: string | null;
  /** channel width in MHz, e.g. 80 */
  widthMhz: number | null;
  phyMode: string | null;
  /** transmit rate (Mbit/s) */
  txMbps: number | null;
  rssiDbm: number | null;
  noiseDbm: number | null;
  mcs: number | null;
  security: string | null;
  countryCode: string | null;
  mac: string | null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : typeof v === 'number' ? String(v) : null);

function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const m = /-?\d+(?:\.\d+)?/.exec(v);
    if (m) return Number(m[0]);
  }
  return null;
}

/** '36 (5GHz, 80MHz)' → { channel 36, band '5 GHz', width 80 }; bare numbers infer 2.4/5 GHz. */
export function parseAirportChannel(v: unknown): { channel: number | null; band: string | null; widthMhz: number | null } {
  const text = typeof v === 'number' ? String(v) : typeof v === 'string' ? v : '';
  const ch = /^\s*(\d+)/.exec(text);
  const channel = ch ? Number(ch[1]) : null;
  const ghz = /(\d(?:\.\d)?)\s*GHz/i.exec(text);
  const width = /(\d+)\s*MHz/i.exec(text);
  let band: string | null = null;
  if (ghz) {
    const g = Number(ghz[1]);
    band = g < 3 ? '2,4 GHz' : g < 5.9 ? '5 GHz' : '6 GHz';
  } else if (channel !== null) {
    band = channel <= 14 ? '2,4 GHz' : channel >= 32 ? '5 GHz' : null;
  }
  return { channel, band, widthMhz: width ? Number(width[1]) : null };
}

/** '-54 dBm / -95 dBm' → rssi, noise */
export function parseSignalNoise(v: unknown): { rssiDbm: number | null; noiseDbm: number | null } {
  const text = typeof v === 'string' ? v : '';
  const m = /(-?\d+)\s*dBm\s*\/\s*(-?\d+)\s*dBm/i.exec(text);
  if (m) return { rssiDbm: Number(m[1]), noiseDbm: Number(m[2]) };
  const one = /(-?\d+)\s*dBm/i.exec(text);
  return { rssiDbm: one ? Number(one[1]) : null, noiseDbm: null };
}

/** spairport_security_mode_wpa2_personal → 'wpa2_personal' */
const stripKey = (v: string | null, prefix: string) => (v && v.startsWith(prefix) ? v.slice(prefix.length) : v);

function parseInterface(v: Record<string, unknown>): AirportInterface | null {
  const device = str(v._name);
  if (!device) return null;
  const status = str(v.spairport_status_information);
  const net = isRecord(v.spairport_current_network_information) ? v.spairport_current_network_information : null;
  const ssidRaw = net ? str(net._name) : null;
  const ch = parseAirportChannel(net?.spairport_network_channel);
  const sn = parseSignalNoise(net?.spairport_signal_noise);
  const connected = status !== null ? /status_connected$/.test(status) : net !== null;
  return {
    device,
    status,
    connected,
    ssid: ssidRaw && !/^<redacted>$/i.test(ssidRaw) ? ssidRaw : null,
    channel: ch.channel,
    band: ch.band,
    widthMhz: ch.widthMhz,
    phyMode: net ? str(net.spairport_network_phymode) : null,
    txMbps: net ? num(net.spairport_network_rate) : null,
    rssiDbm: sn.rssiDbm,
    noiseDbm: sn.noiseDbm,
    mcs: net ? num(net.spairport_network_mcs) : null,
    security: net ? stripKey(str(net.spairport_security_mode), 'spairport_security_mode_') : null,
    countryCode: net ? str(net.spairport_network_country_code) : null,
    mac: str(v.spairport_wireless_mac_address)?.toLowerCase() ?? null,
  };
}

/** All Wi-Fi interfaces of the report (awdl0/llw0 entries without Wi-Fi data are kept – callers pick by device). */
export function parseAirportJson(json: unknown): AirportInterface[] {
  if (!isRecord(json)) return [];
  const sections = Array.isArray(json.SPAirPortDataType) ? json.SPAirPortDataType : [];
  const out: AirportInterface[] = [];
  for (const s of sections) {
    if (!isRecord(s) || !Array.isArray(s.spairport_airport_interfaces)) continue;
    for (const i of s.spairport_airport_interfaces) {
      if (!isRecord(i)) continue;
      const parsed = parseInterface(i);
      if (parsed) out.push(parsed);
    }
  }
  return out;
}

/** Windows' 0…100 % ↔ −100…−50 dBm mapping, so the UI shows a comparable signal quality. */
export function signalPctFromRssi(rssi: number | null): number | null {
  if (rssi === null) return null;
  return Math.max(0, Math.min(100, Math.round(2 * (rssi + 100))));
}

/**
 * WlanInfo for the wanted interface (BSD name) or the first Wi-Fi interface (en*). `mediaConnected`
 * (adapters snapshot) wins over the report's status; radio values only while both say connected.
 */
export function wlanInfoFromAirport(list: readonly AirportInterface[], ts: number, opts: { device?: string | null; mediaConnected?: boolean | null } = {}): WlanInfo {
  const wanted = opts.device ? list.find((i) => i.device === opts.device) : undefined;
  const iface = wanted ?? list.find((i) => /^en\d+$/.test(i.device)) ?? list[0] ?? null;
  if (!iface) {
    return {
      ts, present: false, connected: false, ssid: null, bssid: null, radioType: null, band: null, channel: null,
      signalPct: null, rssiDbm: null, rxMbps: null, txMbps: null, raw: {},
    };
  }
  const connected = opts.mediaConnected ?? iface.connected;
  const live = connected && iface.connected;
  const raw: Record<string, string> = { interface: iface.device };
  const put = (k: string, v: string | number | null) => {
    if (v !== null) raw[k] = String(v);
  };
  put('status', iface.status);
  put('phyMode', iface.phyMode);
  put('channelWidthMhz', iface.widthMhz);
  put('noiseDbm', iface.noiseDbm);
  put('mcs', iface.mcs);
  put('security', iface.security);
  put('countryCode', iface.countryCode);
  if (live && iface.ssid === null) raw.ssid = 'nicht verfügbar (macOS-Ortungsdienste)';
  return {
    ts,
    present: true,
    connected,
    ssid: live ? iface.ssid : null,
    bssid: null,
    radioType: live ? iface.phyMode : null,
    band: live ? iface.band : null,
    channel: live ? iface.channel : null,
    signalPct: live ? signalPctFromRssi(iface.rssiDbm) : null,
    rssiDbm: live ? iface.rssiDbm : null,
    rxMbps: null,
    txMbps: live ? iface.txMbps : null,
    raw,
  };
}
