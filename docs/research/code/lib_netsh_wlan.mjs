// Tolerant parser for `netsh wlan show interfaces` (de-DE + en-US labels taken from wlancfg.dll.mui of Win11 26200).
// Keys are normalized (diacritics stripped, lowercase, alnum only) so codepage damage on umlauts is tolerated.
const KEYS = {
  name: ['name'],
  description: ['beschreibung', 'description'],
  guid: ['guid'],
  mac: ['physischeadresse', 'physicaladdress'],
  interfaceType: ['benutzeroberflachentyp', 'schnittstellentyp', 'interfacetype'],
  state: ['status', 'state'],
  ssid: ['ssid'],
  bssid: ['apbssid', 'bssid'],
  mldBssid: ['mldapbssid'],
  band: ['bereich', 'band'],
  channel: ['kanal', 'channel'],
  networkType: ['netzwerktyp', 'networktype'],
  radioType: ['funktyp', 'radiotype'],
  authentication: ['authentifizierung', 'authentication'],
  cipher: ['verschlusselungsverfahren', 'verschlusselung', 'cipher'],
  connectionMode: ['verbindungsmodus', 'connectionmode'],
  rxRateMbps: ['empfangsratembits', 'receiveratembps'],
  txRateMbps: ['ubertragungsratembits', 'transmitratembps'],
  signalPct: ['signal'],
  rssiDbm: ['rssi'],
  profile: ['profil', 'profile'],
  radioStatus: ['funkstatus', 'radiostatus'],
  hostedNetworkStatus: ['statusdesgehostetennetzwerks', 'hostednetworkstatus'],
  qosMscsConfigured: ['qosmscskonfiguriert', 'qosmscsconfigured'],
  qosMapConfigured: ['qoszuordnungkonfiguriert', 'qosmapconfigured'],
  akmCipher: ['verbundenesakmverschlusselungsverfahren', 'connectedakmcipher'],
  primaryInterface: ['primarebenutzeroberflache', 'primaryinterface'],
  qosMapAllowedByPolicy: ['durchrichtliniezugelassenqoszuordnung', 'durchrichtliniezugelasseneqoszuordnung', 'qosmapallowedbypolicy'],
};
// Fuzzy fallback (Levenshtein <= 2, keys >= 8 chars) for labels whose umlauts were destroyed by a wrong codepage.
function lev(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
const LOOKUP = new Map(Object.entries(KEYS).flatMap(([canon, alts]) => alts.map(a => [a, canon])));
export const normKey = k => k.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');

const STATES = {
  verbunden: 'connected', connected: 'connected', getrennt: 'disconnected', disconnected: 'disconnected',
  verbindungwirdgetrennt: 'disconnecting', disconnecting: 'disconnecting', wirdzugeordnet: 'associating', associating: 'associating',
  wirdgesucht: 'discovering', discovering: 'discovering', wirdauthentifiziert: 'authenticating', authenticating: 'authenticating',
  nichtbereit: 'not_ready', notready: 'not_ready', dasadhocnetzwerkwurdegebildet: 'adhoc_formed', adhocnetworkformed: 'adhoc_formed',
};
const num = v => { const m = /-?\d+(?:[.,]\d+)?/.exec(v ?? ''); return m ? parseFloat(m[0].replace(',', '.')) : null; };

export function parseNetshWlanInterfaces(text) {
  const ifaces = []; let cur = null; let lastKey = null;
  for (const raw of text.split(/\r?\n/)) {
    if (!/^\s+\S/.test(raw)) { lastKey = null; continue; }        // headers ("Es ist 1 Schnittstelle ...") are not indented
    const i = raw.indexOf(':');
    if (i < 0) {                                                   // continuation line (e.g. "Software Aktiviert")
      if (cur && lastKey) cur.raw[lastKey] = `${cur.raw[lastKey]}; ${raw.trim()}`;
      continue;
    }
    const label = raw.slice(0, i).trim(), value = raw.slice(i + 1).trim();
    const nk = normKey(label);
    let canon = LOOKUP.get(nk) ?? null;
    if (!canon && nk.length >= 8) { let best = 3; for (const [k, c] of LOOKUP) { if (k.length < 8) continue; const dist = lev(nk, k); if (dist < best) { best = dist; canon = c; } } }
    if (canon === 'name' || !cur) { cur = { raw: {}, unknown: {} }; ifaces.push(cur); }
    if (canon) { cur.raw[canon] = value; lastKey = canon; } else { cur.unknown[label] = value; lastKey = null; }
  }
  return ifaces.map(({ raw, unknown }) => ({
    name: raw.name ?? null, description: raw.description ?? null, guid: raw.guid ?? null, mac: raw.mac ?? null,
    state: STATES[normKey(raw.state ?? '')] ?? (raw.state ? 'unknown' : null), stateText: raw.state ?? null,
    ssid: raw.ssid ?? null, bssid: raw.bssid ?? raw.mldBssid ?? null,
    bandGHz: num(raw.band), channel: num(raw.channel),
    networkType: raw.networkType ?? null, radioType: raw.radioType ?? null,
    authentication: raw.authentication ?? null, cipher: raw.cipher ?? null, connectionMode: raw.connectionMode ?? null,
    rxRateMbps: num(raw.rxRateMbps), txRateMbps: num(raw.txRateMbps),
    signalPct: num(raw.signalPct), rssiDbm: num(raw.rssiDbm),
    rssiEstimatedDbm: raw.signalPct != null ? Math.round(num(raw.signalPct) / 2 - 100) : null, // MS mapping: 0%..100% ~ -100..-50 dBm
    akmCipher: raw.akmCipher ?? null, profile: raw.profile ?? null, radioStatus: raw.radioStatus ?? null, hostedNetworkStatus: raw.hostedNetworkStatus ?? null,
    raw, unknown,
  }));
}
