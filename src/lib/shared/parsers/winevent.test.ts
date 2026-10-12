import { describe, expect, it } from 'vitest';
import {
  LOG_NCSI,
  LOG_SYSTEM,
  LOG_WLAN,
  SYSTEM_SELECTOR,
  analyzeLinkDrops,
  buildEventQuery,
  decodeUtf16le,
  decodeXmlEntities,
  eventDedupeKey,
  fmtLinkSpeed,
  linkDownEvent,
  linkKindOf,
  markerOf,
  ncsiChangeOf,
  parseSystemTime,
  parseWevtutilXml,
  winEventToNetEvent,
  type WinEvent,
} from './winevent';

// ─── real captures (wevtutil qe … /f:xml /uni:true on Jan-PC, 2026-10-09; Binary payloads shortened) ───

/** NIC driver update at 15:26 local: 7045 (e2fn NetAdapter driver installed), then link resets of both drivers. */
const REAL_DRIVER_SWITCH = [
  `<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='Service Control Manager' Guid='{555908d1-a6d7-4695-8e1e-26931d2012f4}' EventSourceName='Service Control Manager'/><EventID Qualifiers='16384'>7045</EventID><Version>0</Version><Level>4</Level><Task>0</Task><Opcode>0</Opcode><Keywords>0x8080000000000000</Keywords><TimeCreated SystemTime='2026-10-09T13:26:34.0062609Z'/><EventRecordID>7804</EventRecordID><Correlation/><Execution ProcessID='1732' ThreadID='32960'/><Channel>System</Channel><Computer>Jan-PC</Computer><Security UserID='S-1-5-18'/></System><EventData><Data Name='ServiceName'>Intel(R) PCI Express Network Connection NetAdapter Driver</Data><Data Name='ImagePath'>\\SystemRoot\\System32\\DriverStore\\FileRepository\\e2fn.inf_amd64_5075999c7c415a1d\\e2fn.sys</Data><Data Name='ServiceType'>Kernelmodustreiber</Data><Data Name='StartType'>Manuell starten</Data><Data Name='AccountName'></Data></EventData></Event>`,
  `<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='e2fexpress'/><EventID Qualifiers='40964'>27</EventID><Version>0</Version><Level>3</Level><Task>0</Task><Opcode>0</Opcode><Keywords>0x80000000000000</Keywords><TimeCreated SystemTime='2026-10-09T13:26:34.0708350Z'/><EventRecordID>7805</EventRecordID><Correlation/><Execution ProcessID='4' ThreadID='32220'/><Channel>System</Channel><Computer>Jan-PC</Computer><Security/></System><EventData><Data></Data><Data>Intel(R) Ethernet Controller (3) I225-V</Data><Binary>0000040002003000000000001B0004A0</Binary></EventData></Event>`,
  `<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='e2fnexpress'/><EventID Qualifiers='40964'>27</EventID><Version>0</Version><Level>3</Level><Task>0</Task><Opcode>0</Opcode><Keywords>0x80000000000000</Keywords><TimeCreated SystemTime='2026-10-09T13:26:34.7392189Z'/><EventRecordID>7808</EventRecordID><Correlation/><Execution ProcessID='4' ThreadID='4276'/><Channel>System</Channel><Computer>Jan-PC</Computer><Security/></System><EventData><Data></Data><Data>Intel(R) Ethernet Controller (3) I225-V</Data><Binary>0000000002002800000000001B0004A0</Binary></EventData></Event>`,
  `<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='e2fnexpress'/><EventID Qualifiers='40964'>27</EventID><Version>0</Version><Level>3</Level><Task>0</Task><Opcode>0</Opcode><Keywords>0x80000000000000</Keywords><TimeCreated SystemTime='2026-10-09T13:26:36.9288354Z'/><EventRecordID>7811</EventRecordID><Correlation/><Execution ProcessID='4' ThreadID='3536'/><Channel>System</Channel><Computer>Jan-PC</Computer><Security/></System><EventData><Data></Data><Data>Intel(R) Ethernet Controller (3) I225-V</Data><Binary>0000000002002800000000001B0004A0</Binary></EventData></Event>`,
  `<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='e2fnexpress'/><EventID Qualifiers='24580'>33</EventID><Version>0</Version><Level>4</Level><Task>0</Task><Opcode>0</Opcode><Keywords>0x80000000000000</Keywords><TimeCreated SystemTime='2026-10-09T13:26:42.3007619Z'/><EventRecordID>7812</EventRecordID><Correlation/><Execution ProcessID='4' ThreadID='42340'/><Channel>System</Channel><Computer>Jan-PC</Computer><Security/></System><EventData><Data></Data><Data>Intel(R) Ethernet Controller (3) I225-V</Data><Binary>00000000020028000000000021000460</Binary></EventData></Event>`,
].join('\r\n');

/** NCSI around the driver switch: Ethernet loses internet, WLAN takes over 0.4 s later. */
const REAL_NCSI_SWITCH = [
  `<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='Microsoft-Windows-NCSI' Guid='{314de49f-ce63-4779-ba2b-d616f6963a88}'/><EventID>4042</EventID><Version>0</Version><Level>4</Level><Task>0</Task><Opcode>0</Opcode><Keywords>0x4000000000000020</Keywords><TimeCreated SystemTime='2026-10-09T13:26:35.4551713Z'/><EventRecordID>693</EventRecordID><Correlation/><Execution ProcessID='2560' ThreadID='13164'/><Channel>Microsoft-Windows-NCSI/Operational</Channel><Computer>Jan-PC</Computer><Security UserID='S-1-5-20'/></System><EventData><Data Name='InterfaceGuid'>{178af0a6-93f5-4ace-ace2-2ecdf78704f2}</Data><Data Name='IfLuid'>1689399632855040</Data><Data Name='Family'>0</Data><Data Name='Capability'>0</Data><Data Name='CapabilityChangeReason'>14</Data><Data Name='PreviousCapability'>2</Data></EventData></Event>`,
  `<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='Microsoft-Windows-NCSI' Guid='{314de49f-ce63-4779-ba2b-d616f6963a88}'/><EventID>4042</EventID><Version>0</Version><Level>4</Level><Task>0</Task><Opcode>0</Opcode><Keywords>0x4000000000000020</Keywords><TimeCreated SystemTime='2026-10-09T13:26:35.8589746Z'/><EventRecordID>698</EventRecordID><Correlation ActivityID='{a8908dbf-535c-000c-cb8d-90a85c53dd01}'/><Execution ProcessID='2560' ThreadID='21448'/><Channel>Microsoft-Windows-NCSI/Operational</Channel><Computer>Jan-PC</Computer><Security UserID='S-1-5-20'/></System><EventData><Data Name='InterfaceGuid'>{1cdb0ef5-cb64-4b03-9b8d-3de53ab40921}</Data><Data Name='IfLuid'>19985273102270464</Data><Data Name='Family'>0</Data><Data Name='Capability'>2</Data><Data Name='CapabilityChangeReason'>4</Data><Data Name='PreviousCapability'>1</Data></EventData></Event>`,
].join('\r\n');

const REAL_WLAN = [
  `<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='Microsoft-Windows-WLAN-AutoConfig' Guid='{9580d7dd-0379-4658-9870-d5be7d52d6de}'/><EventID>8001</EventID><Version>0</Version><Level>4</Level><Task>24010</Task><Opcode>190</Opcode><Keywords>0x8000000000000600</Keywords><TimeCreated SystemTime='2026-10-09T13:57:05.7002463Z'/><EventRecordID>481</EventRecordID><Correlation/><Execution ProcessID='4796' ThreadID='34340'/><Channel>Microsoft-Windows-WLAN-AutoConfig/Operational</Channel><Computer>Jan-PC</Computer><Security UserID='S-1-5-18'/></System><EventData><Data Name='InterfaceGuid'>{1cdb0ef5-cb64-4b03-9b8d-3de53ab40921}</Data><Data Name='InterfaceDescription'>Intel(R) Wi-Fi 6E AX211 160MHz</Data><Data Name='ConnectionMode'>Automatische Verbindung mit einem Profil</Data><Data Name='ProfileName'>Vodafone-43FE</Data><Data Name='SSID'>Vodafone-43FE</Data><Data Name='BSSType'>Infrastructure</Data><Data Name='PHYType'>802.11ax</Data><Data Name='AuthenticationAlgorithm'>WPA2-Personal</Data><Data Name='CipherAlgorithm'>AES-CCMP</Data><Data Name='OnexEnabled'>0</Data><Data Name='ConnectionId'>0x7</Data><Data Name='NonBroadcast'>false</Data></EventData></Event>`,
  `<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='Microsoft-Windows-WLAN-AutoConfig' Guid='{9580d7dd-0379-4658-9870-d5be7d52d6de}'/><EventID>8003</EventID><Version>0</Version><Level>4</Level><Task>24010</Task><Opcode>192</Opcode><Keywords>0x8000000000000600</Keywords><TimeCreated SystemTime='2026-10-09T13:27:13.6791494Z'/><EventRecordID>475</EventRecordID><Correlation/><Execution ProcessID='4796' ThreadID='9192'/><Channel>Microsoft-Windows-WLAN-AutoConfig/Operational</Channel><Computer>Jan-PC</Computer><Security UserID='S-1-5-18'/></System><EventData><Data Name='InterfaceGuid'>{1cdb0ef5-cb64-4b03-9b8d-3de53ab40921}</Data><Data Name='InterfaceDescription'>Intel(R) Wi-Fi 6E AX211 160MHz</Data><Data Name='ConnectionMode'>Automatische Verbindung mit einem Profil</Data><Data Name='ProfileName'>Vodafone-43FE</Data><Data Name='SSID'>Vodafone-43FE</Data><Data Name='BSSType'>Infrastructure</Data><Data Name='Reason'>Das Netzwerk wird aufgrund einer Richtlinie getrennt, die die automatische Verbindungsherstellung auf dieser Schnittstelle deaktiviert.</Data><Data Name='ConnectionId'>0x6</Data><Data Name='ReasonCode'>5</Data></EventData></Event>`,
  `<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='Microsoft-Windows-WLAN-AutoConfig' Guid='{9580d7dd-0379-4658-9870-d5be7d52d6de}'/><EventID>8002</EventID><Version>0</Version><Level>2</Level><Task>24010</Task><Opcode>191</Opcode><Keywords>0x8000000000000600</Keywords><TimeCreated SystemTime='2026-10-09T16:35:44.7374307Z'/><EventRecordID>487</EventRecordID><Correlation/><Execution ProcessID='4796' ThreadID='4992'/><Channel>Microsoft-Windows-WLAN-AutoConfig/Operational</Channel><Computer>Jan-PC</Computer><Security UserID='S-1-5-18'/></System><EventData><Data Name='InterfaceGuid'>{1cdb0ef5-cb64-4b03-9b8d-3de53ab40921}</Data><Data Name='InterfaceDescription'>Intel(R) Wi-Fi 6E AX211 160MHz</Data><Data Name='ConnectionMode'>Automatische Verbindung mit einem Profil</Data><Data Name='ProfileName'>Vodafone-43FE</Data><Data Name='SSID'>Vodafone-43FE</Data><Data Name='BSSType'>Infrastructure</Data><Data Name='FailureReason'>Fehler beim Herstellen der Verbindung, da kein verbindungsfähiger Zugriffspunkt sichtbar war.</Data><Data Name='ReasonCode'>229396</Data><Data Name='ConnectionId'>0x8</Data><Data Name='RSSI'>255</Data></EventData></Event>`,
].join('\r\n');

const REAL_POWER = [
  `<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='Microsoft-Windows-Kernel-Power' Guid='{331c3b3a-2005-44c2-ac5e-77220c37d6b4}'/><EventID>107</EventID><Version>1</Version><Level>4</Level><Task>102</Task><Opcode>0</Opcode><Keywords>0x8000000000000444</Keywords><TimeCreated SystemTime='2026-10-08T17:11:28.1572761Z'/><EventRecordID>7727</EventRecordID><Correlation/><Execution ProcessID='4' ThreadID='42040'/><Channel>System</Channel><Computer>Jan-PC</Computer><Security/></System><EventData><Data Name='TargetState'>6</Data><Data Name='EffectiveState'>5</Data><Data Name='WakeFromState'>5</Data><Data Name='ProgrammedWakeTimeAc'>1601-01-01T00:00:00.0000000Z</Data><Data Name='ProgrammedWakeTimeDc'>1601-01-01T00:00:00.0000000Z</Data><Data Name='WakeRequesterTypeAc'>0</Data><Data Name='WakeRequesterTypeDc'>0</Data></EventData></Event>`,
  `<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='Microsoft-Windows-Kernel-Power' Guid='{331c3b3a-2005-44c2-ac5e-77220c37d6b4}'/><EventID>42</EventID><Version>3</Version><Level>4</Level><Task>64</Task><Opcode>0</Opcode><Keywords>0x8000000000000404</Keywords><TimeCreated SystemTime='2026-10-08T17:11:26.4511101Z'/><EventRecordID>7724</EventRecordID><Correlation/><Execution ProcessID='4' ThreadID='42040'/><Channel>System</Channel><Computer>Jan-PC</Computer><Security/></System><EventData><Data Name='TargetState'>6</Data><Data Name='EffectiveState'>5</Data><Data Name='Reason'>4</Data><Data Name='Flags'>0</Data><Data Name='TransitionsToOn'>6</Data></EventData></Event>`,
  `<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='Microsoft-Windows-Kernel-General' Guid='{a68ca8b7-004f-d7b6-a698-07e2de0f1f5d}'/><EventID>12</EventID><Version>0</Version><Level>4</Level><Task>1</Task><Opcode>0</Opcode><Keywords>0x8000000000000080</Keywords><TimeCreated SystemTime='2026-10-03T17:28:52.1500969Z'/><EventRecordID>7029</EventRecordID><Correlation/><Execution ProcessID='4' ThreadID='8'/><Channel>System</Channel><Computer>Jan-PC</Computer><Security UserID='S-1-5-18'/></System><EventData><Data Name='MajorVersion'>10</Data><Data Name='MinorVersion'>0</Data><Data Name='BuildVersion'>26100</Data><Data Name='QfeVersion'>9444</Data><Data Name='ServiceVersion'>0</Data><Data Name='BootMode'>0</Data><Data Name='StartTime'>2026-10-03T17:28:51.5000000Z</Data></EventData></Event>`,
  `<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='Microsoft-Windows-Kernel-General' Guid='{a68ca8b7-004f-d7b6-a698-07e2de0f1f5d}'/><EventID>13</EventID><Version>0</Version><Level>4</Level><Task>2</Task><Opcode>0</Opcode><Keywords>0x8000000000000080</Keywords><TimeCreated SystemTime='2026-10-03T17:28:34.0331364Z'/><EventRecordID>7028</EventRecordID><Correlation/><Execution ProcessID='4' ThreadID='22956'/><Channel>System</Channel><Computer>Jan-PC</Computer><Security/></System><EventData><Data Name='StopTime'>2026-10-03T17:28:34.0331357Z</Data></EventData></Event>`,
  `<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='Microsoft-Windows-Power-Troubleshooter' Guid='{cdc05e28-c449-49c6-b9d2-88cf761644df}'/><EventID>1</EventID><Version>3</Version><Level>4</Level><Task>0</Task><Opcode>0</Opcode><Keywords>0x8000000000000000</Keywords><TimeCreated SystemTime='2026-10-09T11:37:55.1732398Z'/><EventRecordID>7743</EventRecordID><Correlation ActivityID='{5256efcd-7ca4-4c81-87db-0579a9140240}'/><Execution ProcessID='5500' ThreadID='42368'/><Channel>System</Channel><Computer>Jan-PC</Computer><Security UserID='S-1-5-19'/></System><EventData><Data Name='SleepTime'>2026-10-08T17:11:26.2823131Z</Data><Data Name='WakeTime'>2026-10-09T11:37:54.1393021Z</Data><Data Name='SleepDuration'>903</Data><Data Name='WakeSourceText'></Data></EventData></Event>`,
  `<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='Microsoft-Windows-Kernel-Boot' Guid='{15ca44ff-4d7a-4baa-bba5-0998955e531e}'/><EventID>27</EventID><Version>1</Version><Level>4</Level><Task>33</Task><Opcode>0</Opcode><Keywords>0x8000000000000000</Keywords><TimeCreated SystemTime='2026-10-09T11:37:54.1172277Z'/><EventRecordID>7734</EventRecordID><Correlation/><Execution ProcessID='4' ThreadID='42040'/><Channel>System</Channel><Computer>Jan-PC</Computer><Security/></System><EventData><Data Name='BootType'>1</Data><Data Name='LoadOptions'></Data></EventData></Event>`,
  `<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='EventLog'/><EventID Qualifiers='32768'>6013</EventID><Version>0</Version><Level>4</Level><Task>0</Task><Opcode>0</Opcode><Keywords>0x80000000000000</Keywords><TimeCreated SystemTime='2026-10-07T10:00:00.7987171Z'/><EventRecordID>7515</EventRecordID><Correlation/><Execution ProcessID='3608' ThreadID='3768'/><Channel>System</Channel><Computer>Jan-PC</Computer><Security/></System><EventData><Data></Data><Data></Data><Data></Data><Data></Data><Data>318674</Data><Data>60</Data><Data>-60 Mitteleuropäische Zeit</Data><Binary>31002E00310000003000</Binary></EventData></Event>`,
].join('\r\n');

// ─── synthetic sequences in the same XML shape ───

const BASE = Date.UTC(2026, 9, 8, 16, 29, 13); // 2026-10-08 18:29:13 local – suspected router reboot
let rec = 9000;

function iso(ms: number): string {
  return new Date(ms).toISOString().replace('Z', '0000Z');
}

function x(provider: string, id: number, atMs: number, data: Record<string, string> | string[] = {}, channel = LOG_SYSTEM): string {
  const body = Array.isArray(data)
    ? data.map((v) => `<Data>${v}</Data>`).join('')
    : Object.entries(data).map(([k, v]) => `<Data Name='${k}'>${v}</Data>`).join('');
  rec++;
  return `<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='${provider}'/><EventID>${id}</EventID><Version>0</Version><Level>4</Level><Task>0</Task><Opcode>0</Opcode><Keywords>0x80000000000000</Keywords><TimeCreated SystemTime='${iso(atMs)}'/><EventRecordID>${rec}</EventRecordID><Correlation/><Execution ProcessID='4' ThreadID='1'/><Channel>${channel}</Channel><Computer>Jan-PC</Computer><Security/></System><EventData>${body}</EventData></Event>`;
}

const NIC = ['', 'Intel(R) Ethernet Controller (3) I225-V'];
const down = (t: number) => x('e2fexpress', 27, t, NIC);
const up = (t: number, id = 32) => x('e2fexpress', id, t, NIC);
const ncsi = (t: number, guid: string, cap: number, prev: number, family = 0) =>
  x('Microsoft-Windows-NCSI', 4042, t, { InterfaceGuid: guid, Family: String(family), Capability: String(cap), CapabilityChangeReason: '4', PreviousCapability: String(prev) }, LOG_NCSI);
const wlan = (id: number, t: number, extra: Record<string, string> = {}) =>
  x('Microsoft-Windows-WLAN-AutoConfig', id, t, { SSID: 'Vodafone-43FE', ...extra }, LOG_WLAN);
const ETH = '{178af0a6-93f5-4ace-ace2-2ecdf78704f2}';
const WIFI = '{1cdb0ef5-cb64-4b03-9b8d-3de53ab40921}';
const S = 1000;

function parse(...parts: string[]): WinEvent[] {
  return parseWevtutilXml(parts.join('\r\n'));
}

// ─── tests ───

describe('helpers', () => {
  it('parses SystemTime with 7 fractional digits and offsets', () => {
    expect(parseSystemTime('2026-10-09T13:26:34.0708350Z')).toBe(Date.UTC(2026, 9, 9, 13, 26, 34, 70));
    expect(parseSystemTime('2026-10-09T13:26:34Z')).toBe(Date.UTC(2026, 9, 9, 13, 26, 34));
    expect(parseSystemTime('2026-10-09T15:26:34.5+02:00')).toBe(Date.UTC(2026, 9, 9, 13, 26, 34, 500));
    expect(parseSystemTime('gestern')).toBeNull();
    expect(parseSystemTime(null)).toBeNull();
  });
  it('decodes XML entities', () => {
    expect(decodeXmlEntities('a &lt;b&gt; &amp; &quot;c&quot; &apos;d&apos; &#228;&#xFC;')).toBe('a <b> & "c" \'d\' äü');
    expect(decodeXmlEntities('&unknown;')).toBe('&unknown;');
  });
  it('decodes wevtutil /uni:true output (UTF-16LE with BOM)', () => {
    const text = '\uFEFF<Event>Mitteleuropäische Zeit</Event>';
    const bytes = new Uint8Array(Buffer.from(text, 'utf16le'));
    expect(decodeUtf16le(bytes)).toBe('<Event>Mitteleuropäische Zeit</Event>');
  });
  it('builds XPath queries with cursor and age', () => {
    expect(buildEventQuery('EventID=4042')).toBe('*[System[(EventID=4042)]]');
    expect(buildEventQuery('EventID=4042', { afterRecordId: 715 })).toBe('*[System[(EventID=4042) and (EventRecordID > 715)]]');
    expect(buildEventQuery('EventID=1', { maxAgeMs: 86_400_000, afterRecordId: 0 })).toBe(
      '*[System[(EventID=1) and TimeCreated[timediff(@SystemTime) <= 86400000]]]',
    );
    expect(SYSTEM_SELECTOR).toContain("@Name='e2fnexpress'");
    expect(SYSTEM_SELECTOR).not.toContain('6013');
  });
  it('formats link speeds', () => {
    expect(fmtLinkSpeed(1000)).toBe('1 Gbit/s');
    expect(fmtLinkSpeed(2500)).toBe('2,5 Gbit/s');
    expect(fmtLinkSpeed(100)).toBe('100 Mbit/s');
  });
});

describe('parseWevtutilXml (real captures)', () => {
  it('parses the driver switch sequence incl. unnamed Data and 7045 EventData', () => {
    const evs = parseWevtutilXml(REAL_DRIVER_SWITCH);
    expect(evs.map((e) => [e.provider, e.id, e.recordId])).toEqual([
      ['Service Control Manager', 7045, 7804],
      ['e2fexpress', 27, 7805],
      ['e2fnexpress', 27, 7808],
      ['e2fnexpress', 27, 7811],
      ['e2fnexpress', 33, 7812],
    ]);
    expect(evs[0].data.ServiceName).toBe('Intel(R) PCI Express Network Connection NetAdapter Driver');
    expect(evs[0].data.ImagePath).toContain('e2fn.inf_amd64');
    expect(evs[1]).toMatchObject({ log: 'System', level: 3, ts: Date.UTC(2026, 9, 9, 13, 26, 34, 70), data: { p0: '', p1: 'Intel(R) Ethernet Controller (3) I225-V' } });
    expect(eventDedupeKey(evs[1])).toBe('evtlog:System:7805');
  });
  it('keeps umlauts and unnamed positions (EventLog 6013)', () => {
    const e = parseWevtutilXml(REAL_POWER).find((v) => v.id === 6013);
    expect(e?.data.p6).toBe('-60 Mitteleuropäische Zeit');
    expect(e?.data.p4).toBe('318674');
  });
  it('parses WLAN and NCSI channels', () => {
    const w = parseWevtutilXml(REAL_WLAN);
    expect(w.map((e) => e.log)).toEqual([LOG_WLAN, LOG_WLAN, LOG_WLAN]);
    expect(w[2].data).toMatchObject({ ReasonCode: '229396', RSSI: '255', SSID: 'Vodafone-43FE' });
    const n = parseWevtutilXml(REAL_NCSI_SWITCH).map(ncsiChangeOf);
    expect(n[0]).toMatchObject({ guid: ETH, family: 0, capability: 0, previous: 2 });
    expect(n[1]).toMatchObject({ guid: WIFI, capability: 2, previous: 1 });
  });
  it('handles self-closing Data, <Events> wrapper, UserData and garbage', () => {
    const wrapped = `<Events>${x('Tcpip', 4199, BASE, { IpAddress: '192.168.0.192' }).replace(
      "<Data Name='IpAddress'>192.168.0.192</Data>",
      "<Data Name='IpAddress'>192.168.0.192</Data><Data Name='Empty'/>",
    )}</Events>`;
    const [e] = parseWevtutilXml(wrapped);
    expect(e.data).toEqual({ IpAddress: '192.168.0.192', Empty: '' });
    const ud = parseWevtutilXml(
      `<Event><System><Provider Name='X'/><EventID>5</EventID><TimeCreated SystemTime='2026-10-09T10:00:00.0000000Z'/><EventRecordID>1</EventRecordID><Channel>System</Channel></System><UserData><EventXML xmlns='x'><Param1>a&amp;b</Param1></EventXML></UserData></Event>`,
    );
    expect(ud[0].data).toEqual({ Param1: 'a&b' });
    expect(parseWevtutilXml('')).toEqual([]);
    expect(parseWevtutilXml('Fehler beim Öffnen der Ereignisabfrage.')).toEqual([]);
  });
});

describe('event kinds', () => {
  it('maps Intel link events and markers', () => {
    const evs = parseWevtutilXml(REAL_DRIVER_SWITCH);
    expect(markerOf(evs[0])).toBe('driver');
    expect(linkKindOf(evs[1])).toEqual({ kind: 'down' });
    expect(linkKindOf(evs[4])).toEqual({ kind: 'up', mbps: 100, duplex: 'full' });
    const p = parseWevtutilXml(REAL_POWER);
    const kinds = Object.fromEntries(p.map((e) => [`${e.provider}:${e.id}`, markerOf(e)]));
    expect(kinds).toEqual({
      'Microsoft-Windows-Kernel-Power:107': 'resume',
      'Microsoft-Windows-Kernel-Power:42': 'sleep',
      'Microsoft-Windows-Kernel-General:12': 'boot',
      'Microsoft-Windows-Kernel-General:13': 'shutdown',
      'Microsoft-Windows-Power-Troubleshooter:1': 'resume',
      'Microsoft-Windows-Kernel-Boot:27': 'boot',
      'EventLog:6013': null, // also logged daily at 12:00 – not a marker
    });
  });
  it('ignores 7045 for unrelated services', () => {
    const [e] = parse(x('Service Control Manager', 7045, BASE, { ServiceName: 'MSI Center Service', ImagePath: 'C:\\MSI\\MSI_Central_Service.exe' }));
    expect(markerOf(e)).toBeNull();
    expect(winEventToNetEvent(e)).toBeNull();
  });
});

describe('analyzeLinkDrops', () => {
  const NOW_LATER = BASE + 86_400_000;

  it('classifies the real driver switch as boot/driver artefacts with relink speed', () => {
    const evs = parseWevtutilXml(`${REAL_DRIVER_SWITCH}\r\n${REAL_NCSI_SWITCH}`);
    const res = analyzeLinkDrops(evs, { now: Date.UTC(2026, 9, 9, 18, 0), wlanLogAvailable: true });
    expect(res).toHaveLength(3);
    expect(res.map((a) => a.cause)).toEqual(['boot', 'boot', 'boot']);
    expect(res.every((a) => a.marker?.kind === 'driver')).toBe(true);
    expect(res[0].up).toBeNull(); // next link event is another down
    expect(res[2]).toMatchObject({ relinkMbps: 100, duplex: 'full', downtimeMs: 5372, final: true });
    expect(res[0].internetSource).toBe('ncsi');
    expect(res[0].internetDownMs).toBe(1788); // WLAN had internet 1.8 s after the first down
    const ev = linkDownEvent(res[2]);
    expect(ev).toMatchObject({ type: 'nic_link_down', severity: 'info', segment: 'client', endTs: Date.UTC(2026, 9, 9, 13, 26, 42, 300), dedupeKey: 'evtlog:System:7811' });
    expect(ev.title).toBe('Link-Neuaufbau beim Treiberwechsel/-neustart (danach 100 Mbit/s)');
    expect(ev.details).toMatchObject({ cause: 'boot', relinkMbps: 100, downtimeMs: 5372, adapter: 'Intel(R) Ethernet Controller (3) I225-V' });
  });

  it('boot artefact after Kernel-General 12 and resume artefact before Power-Troubleshooter 1', () => {
    const t = BASE;
    const evs = parse(
      x('Microsoft-Windows-Kernel-General', 12, t),
      down(t + 12 * S),
      up(t + 16 * S, 33),
      down(t + 3_600_000),
      x('Microsoft-Windows-Power-Troubleshooter', 1, t + 3_600_000 + 3 * S),
      up(t + 3_600_000 + 7 * S),
    );
    const [a, b] = analyzeLinkDrops(evs, { now: NOW_LATER });
    expect(a).toMatchObject({ cause: 'boot', relinkMbps: 100, marker: { kind: 'boot', deltaMs: 12 * S } });
    expect(b).toMatchObject({ cause: 'boot', relinkMbps: 1000, marker: { kind: 'resume', deltaMs: -3 * S } });
    expect(linkDownEvent(a).title).toBe('Link-Neuaufbau beim Systemstart (danach 100 Mbit/s)');
  });

  it('pre_sleep: link down 64 s before Kernel-Power 42 (2026-09-08 19:40:21)', () => {
    const t = BASE;
    const [a] = analyzeLinkDrops(parse(down(t), up(t + 10 * S, 33), x('Microsoft-Windows-Kernel-Power', 42, t + 64 * S, { Reason: '4' })), { now: NOW_LATER });
    expect(a.cause).toBe('pre_sleep');
    expect(a.marker).toMatchObject({ kind: 'sleep', deltaMs: -64 * S });
    expect(linkDownEvent(a)).toMatchObject({ severity: 'info', title: 'Link getrennt beim Wechsel in den Standby' });
  });

  it('runtime flap with WLAN failover (LAN link-flap signature)', () => {
    const t = BASE;
    const evs = parse(
      down(t),
      wlan(8001, t + 400),
      ncsi(t + 900, ETH, 0, 2),
      ncsi(t + 1600, WIFI, 2, 1),
      up(t + 6 * S, 33),
      ncsi(t + 7 * S, ETH, 2, 1),
      wlan(8003, t + 40 * S, { ReasonCode: '5' }),
    );
    const [a] = analyzeLinkDrops(evs, { now: NOW_LATER, wlanLogAvailable: true });
    expect(a).toMatchObject({
      cause: 'runtime', relinkMbps: 100, downtimeMs: 6000, wlanFailover: true, wlanAlreadyConnected: false,
      internetDownMs: 1600, internetSource: 'ncsi', moreDowns: 0, noAccessPoint: false, final: true,
    });
    const ev = linkDownEvent(a);
    expect(ev).toMatchObject({ severity: 'warn', segment: 'client', endTs: t + 6000 });
    expect(ev.title).toBe('Netzwerkverbindung am PC unterbrochen (6 s, danach 100 Mbit/s)');
  });

  it('router reboot (2026-10-08 18:29 signature) and merging of the follow-up flaps', () => {
    const t = BASE;
    const evs = parse(
      down(t),
      ncsi(t + 500, ETH, 0, 2),
      up(t + 11 * S),
      ncsi(t + 12 * S, ETH, 1, 0),
      wlan(8002, t + 20 * S, { ReasonCode: '229396' }),
      down(t + 53 * S),
      up(t + 75 * S, 33),
      wlan(8002, t + 100 * S, { ReasonCode: '229396' }),
      down(t + 110 * S),
      up(t + 124 * S),
      ncsi(t + 247 * S, ETH, 2, 1),
      down(t + 248 * S),
      ncsi(t + 249 * S, ETH, 0, 2),
      up(t + 255 * S),
      ncsi(t + 256 * S, ETH, 2, 1),
    );
    const res = analyzeLinkDrops(evs, { now: NOW_LATER, wlanLogAvailable: true });
    expect(res.map((a) => a.cause)).toEqual(['router_reboot', 'router_reboot', 'router_reboot', 'runtime']);
    expect(res[0]).toMatchObject({ internetDownMs: 247 * S, noAccessPoint: true, moreDowns: 2, mergedInto: null, wlanFailover: false });
    expect(res[1].mergedInto).toBe(res[0].down.recordId);
    expect(res[2].mergedInto).toBe(res[0].down.recordId);
    expect(res[3].internetDownMs).toBe(8 * S);
    const ev = linkDownEvent(res[0]);
    expect(ev).toMatchObject({ severity: 'warn', segment: 'router' });
    expect(ev.title).toBe('Netzwerkverbindung unterbrochen – vermutlich Router-Neustart (Internet nach 4 min 07 s wieder da)');
  });

  it('three quick flaps without internet loss > 120 s stay runtime (2026-10-07 11:24)', () => {
    const t = BASE;
    const flap = (at: number, relink: number) => [down(at), ncsi(at + 800, ETH, 0, 2), up(at + 5 * S, relink), ncsi(at + 7 * S, ETH, 2, 1)];
    const evs = parse(...flap(t, 33), ...flap(t + 27 * S, 32), ...flap(t + 144 * S, 33));
    const res = analyzeLinkDrops(evs, { now: NOW_LATER, wlanLogAvailable: true });
    expect(res.map((a) => a.cause)).toEqual(['runtime', 'runtime', 'runtime']);
    expect(res[0].moreDowns).toBe(2);
    expect(res.map((a) => a.relinkMbps)).toEqual([100, 1000, 100]);
  });

  it('WLAN already connected → no failover flag; WLAN log unavailable → null', () => {
    const t = BASE;
    const evs = parse(wlan(8001, t - 30 * S), down(t), up(t + 5 * S));
    expect(analyzeLinkDrops(evs, { now: NOW_LATER, wlanLogAvailable: true })[0]).toMatchObject({ wlanFailover: false, wlanAlreadyConnected: true });
    expect(analyzeLinkDrops(parse(down(t), up(t + 5 * S)), { now: NOW_LATER, wlanLogAvailable: false })[0].wlanFailover).toBeNull();
  });

  it('is provisional while the look-ahead windows are open; ongoing outage counts as lower bound', () => {
    const t = BASE;
    const evs = parse(down(t), ncsi(t + 500, ETH, 0, 2), wlan(8002, t + 20 * S, { ReasonCode: '229396' }));
    const early = analyzeLinkDrops(evs, { now: t + 60 * S, wlanLogAvailable: true })[0];
    expect(early).toMatchObject({ cause: 'runtime', final: false, internetDownMs: 60 * S, internetOngoing: true, up: null });
    expect(linkDownEvent(early).title).toBe('Netzwerkverbindung am PC unterbrochen');
    const later = analyzeLinkDrops(evs, { now: t + 200 * S, wlanLogAvailable: true })[0];
    expect(later).toMatchObject({ cause: 'router_reboot', internetOngoing: true, final: false });
    expect(linkDownEvent(later).title).toBe('Netzwerkverbindung unterbrochen – vermutlich Router-Neustart');
  });

  it('prefers the engine samples for internet recovery', () => {
    const t = BASE;
    const evs = parse(down(t), ncsi(t + 500, ETH, 0, 2), ncsi(t + 300 * S, ETH, 2, 1), down(t + 30 * S), down(t + 60 * S));
    const viaNcsi = analyzeLinkDrops(evs, { now: NOW_LATER })[0];
    expect(viaNcsi.cause).toBe('router_reboot');
    const viaSamples = analyzeLinkDrops(evs, { now: NOW_LATER, internetRecovery: (ts) => (ts === t ? { recoveredTs: t + 2 * S, coveredUntil: t + 600 * S } : null) })[0];
    expect(viaSamples).toMatchObject({ cause: 'runtime', internetDownMs: 2 * S, internetSource: 'samples' });
  });

  it("re-enabled adapter (2026-10-09 18:50:58): wired link without connectivity for hours → 'boot' (inactive)", () => {
    const t = BASE;
    const evs = parse(
      ncsi(t - 3 * 3600_000, ETH, 0, 2), // adapter disabled at 15:57 (CapabilityReset)
      wlan(8001, t - 3 * 3600_000 + 100),
      ncsi(t - 3 * 3600_000 + 1200, WIFI, 2, 0),
      down(t),
      up(t + 3 * S),
      ncsi(t + 4 * S, ETH, 2, 0),
    );
    const withGuids = analyzeLinkDrops(evs, { now: NOW_LATER, wlanLogAvailable: true, wiredGuids: [ETH.toUpperCase()] })[0];
    expect(withGuids).toMatchObject({ cause: 'boot', marker: { kind: 'inactive', id: 4042, deltaMs: 3 * 3600_000 }, relinkMbps: 1000, wlanAlreadyConnected: true });
    expect(linkDownEvent(withGuids).title).toBe('Link-Neuaufbau beim Aktivieren der Verbindung (danach 1 Gbit/s)');
    expect(analyzeLinkDrops(evs, { now: NOW_LATER, wlanLogAvailable: true })[0].cause).toBe('runtime');
  });

  it('a second drop shortly after a relink stays runtime although NCSI has not re-probed yet (18:33:21/18:33:33)', () => {
    const t = BASE;
    const evs = parse(ncsi(t - 600 * S, ETH, 2, 1), down(t), ncsi(t + 500, ETH, 0, 2), up(t + 7 * S), down(t + 12 * S), up(t + 20 * S), ncsi(t + 21 * S, ETH, 2, 0));
    const res = analyzeLinkDrops(evs, { now: NOW_LATER, wiredGuids: [ETH] });
    expect(res.map((a) => a.cause)).toEqual(['runtime', 'runtime']);
  });

  it('a link-up later than 10 min does not belong to the down; no NCSI loss → unknown', () => {
    const t = BASE;
    const [a] = analyzeLinkDrops(parse(down(t), up(t + 11 * 60 * S)), { now: NOW_LATER });
    expect(a).toMatchObject({ up: null, downtimeMs: null, internetDownMs: null, internetSource: null, cause: 'runtime' });
    expect(linkDownEvent(a).title).toBe('Netzwerkverbindung am PC unterbrochen (keine Wiederverbindung erkannt)');
  });
});

describe('winEventToNetEvent', () => {
  it('maps link-ups, power, WLAN and driver events', () => {
    const drv = parseWevtutilXml(REAL_DRIVER_SWITCH);
    expect(winEventToNetEvent(drv[1])).toBeNull(); // link-down → linkDownEvent()
    expect(winEventToNetEvent(drv[4])).toMatchObject({
      type: 'nic_link_up', severity: 'warn', title: 'Netzwerkverbindung hergestellt: 100 Mbit/s Vollduplex',
      details: { speedMbps: 100, duplex: 'full', provider: 'e2fnexpress' }, dedupeKey: 'evtlog:System:7812', source: 'eventlog',
    });
    expect(winEventToNetEvent(drv[0])).toMatchObject({ type: 'adapter_change', title: 'Netzwerktreiber installiert: Intel(R) PCI Express Network Connection NetAdapter Driver' });

    const p = parseWevtutilXml(REAL_POWER);
    const byId = (id: number) => winEventToNetEvent(p.find((e) => e.id === id) as WinEvent);
    expect(byId(42)).toMatchObject({ type: 'standby', details: { kind: 'sleep', reason: '4' } });
    expect(byId(107)).toMatchObject({ type: 'resume', title: 'PC aus dem Standby/Ruhezustand aufgewacht' });
    expect(byId(12)).toMatchObject({ type: 'resume', title: 'PC gestartet', details: { kind: 'boot' } });
    expect(byId(13)).toMatchObject({ type: 'standby', title: 'PC heruntergefahren', details: { kind: 'shutdown' } });
    expect(byId(1)).toBeNull(); // Power-Troubleshooter: marker only
    expect(byId(6013)).toBeNull();

    const w = parseWevtutilXml(REAL_WLAN);
    expect(winEventToNetEvent(w[0])).toMatchObject({ type: 'wlan_connect', title: 'WLAN verbunden (Vodafone-43FE)', details: { phyType: '802.11ax', cipher: 'AES-CCMP' } });
    expect(winEventToNetEvent(w[1])).toMatchObject({ type: 'wlan_disconnect', title: 'WLAN getrennt (Vodafone-43FE) – Kabelverbindung wieder aktiv', details: { reasonCode: '5' } });
    expect(winEventToNetEvent(w[2])).toMatchObject({
      type: 'wlan_disconnect', severity: 'warn', title: 'WLAN-Verbindung fehlgeschlagen (Vodafone-43FE) – kein Zugangspunkt sichtbar',
      details: { kind: 'connect_failed', reasonCode: '229396' }, dedupeKey: `evtlog:${LOG_WLAN}:487`,
    });
  });
  it('maps address conflicts and Intel adapter conditions', () => {
    const [conflict, smart, removed, unknown] = parse(
      x('Tcpip', 4199, BASE, ['192.168.0.192', 'D8-43-AE-12-34-56']),
      x('e2fexpress', 40, BASE, NIC),
      x('e2fexpress', 56, BASE, NIC),
      x('e2fexpress', 99, BASE, NIC),
    );
    expect(winEventToNetEvent(conflict)).toMatchObject({ type: 'identity_change', severity: 'critical', segment: 'lan', details: { kind: 'address_conflict', data: { p0: '192.168.0.192' } } });
    expect(winEventToNetEvent(smart)).toMatchObject({ type: 'adapter_change', severity: 'warn', title: 'Intel SmartSpeed hat die Link-Geschwindigkeit herabgestuft' });
    expect(winEventToNetEvent(removed)?.severity).toBe('warn');
    expect(winEventToNetEvent(unknown)).toBeNull();
  });
});
