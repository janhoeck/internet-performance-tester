import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeConsole, decodeCp850 } from '../cp850';
import { normKey, parseLocaleNumber, parseNetshWlan, parseWlanState, wlanInfoFromNetsh } from './netsh';

const fixture = (name: string) => new URL(`../../../../fixtures/windows/${name}`, import.meta.url);
const readText = (name: string) => fs.readFileSync(fixture(name), 'utf8');

/** Real capture on Jan-PC (Windows 11 26200, de-DE), 2026-10-09 ~16:00, WLAN connected (UTF-8 bytes). */
const REAL_CONNECTED_DE =
  '\r\nEs ist 1 Schnittstelle auf dem System vorhanden:\r\n\r\n    Name                   : WLAN\r\n    Beschreibung            : Intel(R) Wi-Fi 6E AX211 160MHz\r\n    GUID                   : 1cdb0ef5-cb64-4b03-9b8d-3de53ab40921\r\n    Physische Adresse       : e4:60:17:12:34:01\r\n    Benutzeroberflächentyp         : Primär\r\n    Status                  : Verbunden\r\n    SSID                   : Vodafone-43FE\r\n    AP BSSID               : dc:73:06:12:34:de\r\n    Bereich                   : 5 GHz\r\n    Kanal                : 100\r\n    VerbundeneS Akm-Verschlüsselungsverfahren : [ akm = 00-0f-ac:02, Chiffre = 00-0f-ac:04 ]\r\n    Netzwerktyp            : Infrastruktur\r\n    Funktyp                   : 802.11ax\r\n    Authentifizierung   : WPA2-Personal\r\n    Verschlüsselungsverfahren                 : CCMP\r\n    Verbindungsmodus        : Automat. Verbindung\r\n    Empfangsrate (MBit/s)  : 865\r\n    Übertragungsrate (MBit/s) : 721\r\n    Signal              : 82% \r\n    RSSI                   : -60\r\n    Profil                 : Vodafone-43FE \r\n    QoS MSCS konfiguriert         : 0\r\n    QoS-Zuordnung konfiguriert         : 0\r\n    Durch Richtlinie zugelassene QoS-Zuordnung   :  0\r\n\r\n';

/** Crafted from the de-DE wlancfg.dll.mui labels: 2.4 GHz with decimal commas, associating state, two interfaces. */
const CRAFTED_TWO_IFACES_DE = [
  '',
  'Es sind 2 Schnittstellen auf dem System vorhanden:',
  '',
  '    Name                   : WLAN',
  '    Beschreibung            : Intel(R) Wi-Fi 6E AX211 160MHz',
  '    GUID                   : 1cdb0ef5-cb64-4b03-9b8d-3de53ab40921',
  '    Physische Adresse       : e4:60:17:12:34:01',
  '    Benutzeroberflächentyp         : Primär',
  '    Status                  : Verbunden',
  '    SSID                   : Vodafone-43FE',
  '    MLD-AP-BSSID               : DC:73:06:12:34:E1',
  '    Bereich                   : 2,4 GHz',
  '    Kanal                : 6',
  '    Funktyp                   : 802.11n',
  '    Empfangsrate (MBit/s)  : 144,4',
  '    Übertragungsrate (MBit/s) : 72,2',
  '    Signal              : 41% ',
  '    Profil                 : Vodafone-43FE ',
  '',
  '    Name                   : WLAN 2',
  '    Beschreibung            : USB-WLAN',
  '    State                  : Wird zugeordnet.',
  '    Funkstatus           : Hardware Aktiviert',
  '                             Software Deaktiviert',
  '',
].join('\r\n');

describe('normKey / helpers', () => {
  it('normalizes German labels', () => {
    expect(normKey('Benutzeroberflächentyp')).toBe('benutzeroberflachentyp');
    expect(normKey('Übertragungsrate (MBit/s)')).toBe('ubertragungsratembits');
    expect(normKey('AP BSSID')).toBe('apbssid');
  });
  it('parses numbers with comma or dot', () => {
    expect(parseLocaleNumber('1200,9')).toBe(1200.9);
    expect(parseLocaleNumber('1200.9')).toBe(1200.9);
    expect(parseLocaleNumber('2,4 GHz')).toBe(2.4);
    expect(parseLocaleNumber('96% ')).toBe(96);
    expect(parseLocaleNumber('-48')).toBe(-48);
    expect(parseLocaleNumber('n/a')).toBeNull();
  });
  it('maps state texts', () => {
    expect(parseWlanState('Verbunden')).toBe('connected');
    expect(parseWlanState('getrennt')).toBe('disconnected');
    expect(parseWlanState('Wird zugeordnet.')).toBe('associating');
    expect(parseWlanState('connected')).toBe('connected');
    expect(parseWlanState('irgendwas')).toBe('unknown');
    expect(parseWlanState(null)).toBeNull();
  });
});

describe('parseNetshWlan', () => {
  it('parses the real disconnected capture (raw UTF-8 bytes)', () => {
    const text = decodeConsole(fs.readFileSync(fixture('netsh_wlan_show_interfaces_disconnected.raw.bin')));
    const [w, ...rest] = parseNetshWlan(text);
    expect(rest).toHaveLength(0);
    expect(w.name).toBe('WLAN');
    expect(w.description).toBe('Intel(R) Wi-Fi 6E AX211 160MHz');
    expect(w.guid).toBe('1cdb0ef5-cb64-4b03-9b8d-3de53ab40921');
    expect(w.mac).toBe('e4:60:17:12:34:01');
    expect(w.state).toBe('disconnected');
    expect(w.stateText).toBe('getrennt');
    expect(w.ssid).toBeNull();
    expect(w.signalPct).toBeNull();
    expect(w.radioStatus).toBe('Hardware Aktiviert; Software Aktiviert');
    expect(w.fields.interfaceType).toBe('Primär');
    expect(Object.keys(w.unknown)).toHaveLength(0);
  });

  it('parses the real connected capture (no blank lines, integer rates, RSSI line)', () => {
    const [w] = parseNetshWlan(REAL_CONNECTED_DE);
    expect(w.state).toBe('connected');
    expect(w.ssid).toBe('Vodafone-43FE');
    expect(w.bssid).toBe('dc:73:06:12:34:de');
    expect(w.band).toBe('5 GHz');
    expect(w.bandGHz).toBe(5);
    expect(w.channel).toBe(100);
    expect(w.radioType).toBe('802.11ax');
    expect(w.authentication).toBe('WPA2-Personal');
    expect(w.cipher).toBe('CCMP');
    expect(w.akmCipher).toBe('[ akm = 00-0f-ac:02, Chiffre = 00-0f-ac:04 ]');
    expect(w.connectionMode).toBe('Automat. Verbindung');
    expect(w.networkType).toBe('Infrastruktur');
    expect(w.rxMbps).toBe(865);
    expect(w.txMbps).toBe(721);
    expect(w.signalPct).toBe(82);
    expect(w.rssiDbm).toBe(-60);
    expect(w.rssiEstimatedDbm).toBe(-59);
    expect(w.profile).toBe('Vodafone-43FE');
    expect(w.fields.qosMapAllowedByPolicy).toBe('0');
    expect(Object.keys(w.unknown)).toEqual([]);
  });

  it('parses the synthetic connected de-DE and en-US fixtures identically', () => {
    const [de] = parseNetshWlan(readText('netsh_wlan_show_interfaces_CONNECTED_synthetic.de-DE.txt'));
    const [en] = parseNetshWlan(readText('netsh_wlan_show_interfaces_CONNECTED_synthetic.en-US.txt'));
    for (const w of [de, en]) {
      expect(w.state).toBe('connected');
      expect(w.ssid).toBe('Vodafone-43FE');
      expect(w.bssid).toBe('dc:73:06:12:34:e0');
      expect(w.bandGHz).toBe(5);
      expect(w.channel).toBe(36);
      expect(w.rxMbps).toBe(1200.9);
      expect(w.txMbps).toBe(1200.9);
      expect(w.signalPct).toBe(96);
      expect(w.rssiDbm).toBe(-48);
      expect(w.radioType).toBe('802.11ax');
      expect(w.cipher).toBe('CCMP');
      expect(w.profile).toBe('Vodafone-43FE');
      expect(Object.keys(w.unknown)).toEqual([]);
    }
    expect(de.hostedNetworkStatus).toBe('Nicht verfügbar');
    expect(en.hostedNetworkStatus).toBe('Not available');
    expect(en.radioStatus).toBe('Hardware On; Software On');
  });

  it('survives umlauts destroyed by a wrong code page (UTF-8 bytes decoded as CP850)', () => {
    const mangled = decodeCp850(new TextEncoder().encode(REAL_CONNECTED_DE));
    expect(mangled).not.toContain('Übertragungsrate');
    const [w] = parseNetshWlan(mangled);
    expect(w.txMbps).toBe(721);
    expect(w.cipher).toBe('CCMP');
    expect(w.fields.interfaceType).toBeDefined();
    expect(w.signalPct).toBe(82);
  });

  it('handles several interfaces, MLD BSSID, decimal commas and continuation lines', () => {
    const list = parseNetshWlan(CRAFTED_TWO_IFACES_DE);
    expect(list).toHaveLength(2);
    expect(list[0].bssid).toBe('DC:73:06:12:34:E1');
    expect(list[0].bandGHz).toBe(2.4);
    expect(list[0].rxMbps).toBe(144.4);
    expect(list[0].txMbps).toBe(72.2);
    expect(list[0].rssiDbm).toBeNull();
    expect(list[0].rssiEstimatedDbm).toBe(-79); // 41 % → −79.5 dBm
    expect(list[1].name).toBe('WLAN 2');
    expect(list[1].state).toBe('associating');
    expect(list[1].radioStatus).toBe('Hardware Aktiviert; Software Deaktiviert');
  });

  it('returns no interfaces for service/no-adapter messages', () => {
    expect(parseNetshWlan('Der Dienst "WLAN-AutoKonfig" wird nicht ausgeführt.\r\n')).toEqual([]);
    expect(parseNetshWlan('There is no wireless interface on the system.\r\n')).toEqual([]);
    expect(parseNetshWlan('')).toEqual([]);
  });
});

describe('wlanInfoFromNetsh', () => {
  const ts = 1_791_555_000_000;
  it('maps a connected interface', () => {
    const info = wlanInfoFromNetsh(parseNetshWlan(REAL_CONNECTED_DE), ts, { adapterName: 'WLAN', mediaConnected: true });
    expect(info).toMatchObject({
      ts, present: true, connected: true, ssid: 'Vodafone-43FE', bssid: 'dc:73:06:12:34:de', band: '5 GHz', channel: 100,
      signalPct: 82, rssiDbm: -60, rxMbps: 865, txMbps: 721, radioType: '802.11ax',
    });
    expect(info.raw.ssid).toBe('Vodafone-43FE');
  });
  it('MediaConnectState overrides the netsh state', () => {
    const info = wlanInfoFromNetsh(parseNetshWlan(REAL_CONNECTED_DE), ts, { mediaConnected: false });
    expect(info.connected).toBe(false);
    expect(info.ssid).toBeNull();
    expect(info.signalPct).toBeNull();
  });
  it('disconnected and absent adapters', () => {
    const dis = wlanInfoFromNetsh(parseNetshWlan(readText('netsh_wlan_show_interfaces_disconnected.txt')), ts);
    expect(dis).toMatchObject({ present: true, connected: false, ssid: null, channel: null });
    const none = wlanInfoFromNetsh([], ts);
    expect(none).toMatchObject({ present: false, connected: false, raw: {} });
  });
  it('selects the interface by adapter name', () => {
    const info = wlanInfoFromNetsh(parseNetshWlan(CRAFTED_TWO_IFACES_DE), ts, { adapterName: 'wlan 2' });
    expect(info.connected).toBe(false);
    expect(info.raw.name).toBe('WLAN 2');
  });
});
