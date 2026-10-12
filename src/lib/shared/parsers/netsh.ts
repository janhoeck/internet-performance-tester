// Tolerant parser for `netsh wlan show interfaces` (de-DE + en-US labels from wlancfg.dll.mui of
// Windows 11 26200, see docs/research/windows-collectors.md §8 and lib_netsh_wlan.mjs).
// Labels are normalized (diacritics stripped, lowercase, alphanumerics only) and looked up in an alias
// table; a Levenshtein fallback survives umlauts destroyed by a wrong code page. Values are split at
// the FIRST colon (BSSIDs/MACs contain colons, labels never do). Pure – no Node built-ins.
import type { WlanInfo } from '../types';

export type WlanState =
  | 'connected'
  | 'disconnected'
  | 'disconnecting'
  | 'associating'
  | 'discovering'
  | 'authenticating'
  | 'not_ready'
  | 'adhoc_formed'
  | 'unknown';

export interface NetshWlanInterface {
  name: string | null;
  description: string | null;
  guid: string | null;
  mac: string | null;
  state: WlanState | null;
  stateText: string | null;
  ssid: string | null;
  bssid: string | null;
  /** raw band text, e.g. '5 GHz' / '2,4 GHz' */
  band: string | null;
  bandGHz: number | null;
  channel: number | null;
  networkType: string | null;
  radioType: string | null;
  authentication: string | null;
  cipher: string | null;
  connectionMode: string | null;
  rxMbps: number | null;
  txMbps: number | null;
  signalPct: number | null;
  /** measured RSSI line (Windows 11 26200+), null when absent */
  rssiDbm: number | null;
  /** Microsoft mapping 0..100 % ≈ −100..−50 dBm (only an estimate) */
  rssiEstimatedDbm: number | null;
  profile: string | null;
  radioStatus: string | null;
  hostedNetworkStatus: string | null;
  akmCipher: string | null;
  /** canonical key → raw value for all recognized labels */
  fields: Record<string, string>;
  /** unrecognized label → value */
  unknown: Record<string, string>;
}

const KEYS: Record<string, string[]> = {
  name: ['name'],
  description: ['beschreibung', 'description'],
  guid: ['guid'],
  mac: ['physischeadresse', 'physicaladdress'],
  interfaceType: ['benutzeroberflachentyp', 'schnittstellentyp', 'interfacetype'],
  primaryInterface: ['primarebenutzeroberflache', 'primaryinterface'],
  state: ['status', 'state'],
  ssid: ['ssid'],
  bssid: ['apbssid', 'bssid'],
  mldBssid: ['mldapbssid'],
  band: ['bereich', 'band'],
  channel: ['kanal', 'channel'],
  akmCipher: ['verbundenesakmverschlusselungsverfahren', 'connectedakmcipher'],
  networkType: ['netzwerktyp', 'networktype'],
  radioType: ['funktyp', 'radiotype'],
  authentication: ['authentifizierung', 'authentication'],
  cipher: ['verschlusselungsverfahren', 'verschlusselung', 'cipher'],
  connectionMode: ['verbindungsmodus', 'connectionmode'],
  rxRate: ['empfangsratembits', 'receiveratembps'],
  txRate: ['ubertragungsratembits', 'transmitratembps'],
  signal: ['signal'],
  rssi: ['rssi'],
  profile: ['profil', 'profile'],
  qosMscsConfigured: ['qosmscskonfiguriert', 'qosmscsconfigured'],
  qosMapConfigured: ['qoszuordnungkonfiguriert', 'qosmapconfigured'],
  qosMapAllowedByPolicy: ['durchrichtliniezugelasseneqoszuordnung', 'durchrichtliniezugelassenqoszuordnung', 'qosmapallowedbypolicy'],
  radioStatus: ['funkstatus', 'radiostatus'],
  hostedNetworkStatus: ['statusdesgehostetennetzwerks', 'hostednetworkstatus'],
};

const LOOKUP = new Map<string, string>();
for (const [canon, aliases] of Object.entries(KEYS)) for (const a of aliases) LOOKUP.set(a, canon);

const STATES: Record<string, WlanState> = {
  verbunden: 'connected',
  connected: 'connected',
  getrennt: 'disconnected',
  disconnected: 'disconnected',
  verbindungwirdgetrennt: 'disconnecting',
  disconnecting: 'disconnecting',
  wirdzugeordnet: 'associating',
  associating: 'associating',
  wirdgesucht: 'discovering',
  discovering: 'discovering',
  wirdauthentifiziert: 'authenticating',
  authenticating: 'authenticating',
  nichtbereit: 'not_ready',
  notready: 'not_ready',
  dasadhocnetzwerkwurdegebildet: 'adhoc_formed',
  adhocnetworkformed: 'adhoc_formed',
};

/** NFKD, strip diacritics, lowercase, keep [a-z0-9] */
export function normKey(label: string): string {
  return label
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function levenshtein(a: string, b: string): number {
  const prev = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

function canonicalKey(label: string): string | null {
  const nk = normKey(label);
  const exact = LOOKUP.get(nk);
  if (exact) return exact;
  if (nk.length < 8) return null;
  let best = 3;
  let canon: string | null = null;
  for (const [k, c] of LOOKUP) {
    if (k.length < 8 || Math.abs(k.length - nk.length) > 2) continue;
    const d = levenshtein(nk, k);
    if (d < best) {
      best = d;
      canon = c;
    }
  }
  return canon;
}

/** first number in a value; accepts ',' or '.' as decimal separator ('1200,9', '2,4 GHz', '96% ') */
export function parseLocaleNumber(v: string | null | undefined): number | null {
  if (!v) return null;
  const m = /-?\d+(?:[.,]\d+)?/.exec(v);
  if (!m) return null;
  const n = Number(m[0].replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

export function parseWlanState(v: string | null | undefined): WlanState | null {
  if (!v) return null;
  return STATES[normKey(v)] ?? 'unknown';
}

/** Parse all interface blocks of `netsh wlan show interfaces` (de or en, possibly code-page damaged). */
export function parseNetshWlan(text: string): NetshWlanInterface[] {
  const blocks: { fields: Record<string, string>; unknown: Record<string, string> }[] = [];
  let cur: (typeof blocks)[number] | null = null;
  let lastKey: { kind: 'field' | 'unknown'; key: string } | null = null;
  for (const raw of text.split(/\r?\n/)) {
    if (!/^\s+\S/.test(raw)) {
      // headers ("Es ist 1 Schnittstelle …") are not indented; blank lines end continuations
      lastKey = null;
      continue;
    }
    const i = raw.indexOf(':');
    if (i < 0) {
      // continuation line, e.g. "Software Aktiviert" below "Funkstatus"
      if (cur && lastKey) {
        const bag = lastKey.kind === 'field' ? cur.fields : cur.unknown;
        bag[lastKey.key] = `${bag[lastKey.key]}; ${raw.trim()}`;
      }
      continue;
    }
    const label = raw.slice(0, i).trim();
    const value = raw.slice(i + 1).trim();
    if (!label) continue;
    const canon = canonicalKey(label);
    if (canon === 'name' || !cur) {
      cur = { fields: {}, unknown: {} };
      blocks.push(cur);
    }
    if (canon) {
      cur.fields[canon] = value;
      lastKey = { kind: 'field', key: canon };
    } else {
      cur.unknown[label] = value;
      lastKey = { kind: 'unknown', key: label };
    }
  }
  return blocks.map(({ fields, unknown }) => {
    const f = (k: string): string | null => {
      const v = fields[k];
      return v === undefined || v === '' ? null : v;
    };
    const signalPct = parseLocaleNumber(f('signal'));
    return {
      name: f('name'),
      description: f('description'),
      guid: f('guid'),
      mac: f('mac'),
      state: parseWlanState(f('state')),
      stateText: f('state'),
      ssid: f('ssid'),
      bssid: f('bssid') ?? f('mldBssid'),
      band: f('band'),
      bandGHz: parseLocaleNumber(f('band')),
      channel: parseLocaleNumber(f('channel')),
      networkType: f('networkType'),
      radioType: f('radioType'),
      authentication: f('authentication'),
      cipher: f('cipher'),
      connectionMode: f('connectionMode'),
      rxMbps: parseLocaleNumber(f('rxRate')),
      txMbps: parseLocaleNumber(f('txRate')),
      signalPct,
      rssiDbm: parseLocaleNumber(f('rssi')),
      rssiEstimatedDbm: signalPct === null ? null : Math.round(signalPct / 2 - 100),
      profile: f('profile'),
      radioStatus: f('radioStatus'),
      hostedNetworkStatus: f('hostedNetworkStatus'),
      akmCipher: f('akmCipher'),
      fields,
      unknown,
    };
  });
}

/**
 * Map the parsed output to the WlanInfo contract. `adapterName` selects the interface block (else
 * the first); `mediaConnected` (MSFT_NetAdapter.MediaConnectState) overrides the netsh state –
 * OperationalStatus/netsh can lag behind for soft-disconnected WLAN adapters.
 */
export function wlanInfoFromNetsh(
  ifaces: NetshWlanInterface[],
  ts: number,
  opts: { adapterName?: string | null; mediaConnected?: boolean | null } = {},
): WlanInfo {
  const wanted = opts.adapterName?.toLowerCase() ?? null;
  const iface = (wanted ? ifaces.find((i) => i.name?.toLowerCase() === wanted) : undefined) ?? ifaces[0] ?? null;
  if (!iface) {
    return {
      ts, present: false, connected: false, ssid: null, bssid: null, radioType: null, band: null, channel: null,
      signalPct: null, rssiDbm: null, rxMbps: null, txMbps: null, raw: {},
    };
  }
  const netshConnected = iface.state === 'connected';
  const connected = opts.mediaConnected ?? netshConnected;
  const live = connected && netshConnected;
  const raw: Record<string, string> = { ...iface.unknown, ...iface.fields };
  return {
    ts,
    present: true,
    connected,
    ssid: live ? iface.ssid : null,
    bssid: live ? iface.bssid?.toLowerCase() ?? null : null,
    radioType: live ? iface.radioType : null,
    band: live ? iface.band : null,
    channel: live ? iface.channel : null,
    signalPct: live ? iface.signalPct : null,
    rssiDbm: live ? iface.rssiDbm : null,
    rxMbps: live ? iface.rxMbps : null,
    txMbps: live ? iface.txMbps : null,
    raw,
  };
}
