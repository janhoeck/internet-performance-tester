import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseAirportChannel, parseAirportJson, parseSignalNoise, signalPctFromRssi, wlanInfoFromAirport } from './airport';
import { parsePmsetLog, pmsetPowerEntries } from './pmset';
import { parseKernTimes, parseTimeval } from './sysctl';
import { kernelLinkEvent, parseKernelLinkEvents, parseLogNdjson, parseLogTimestamp } from './unified-log';

const readText = (name: string) => fs.readFileSync(new URL(`../../../../../fixtures/macos/${name}`, import.meta.url), 'utf8');
const readJson = (name: string): unknown => JSON.parse(readText(name));
/** local time with offset → epoch ms */
const at = (iso: string) => new Date(iso).getTime();

describe('pmset -g log', () => {
  const all = parsePmsetLog(readText('pmset_g_log.txt'));

  it('parses timestamped lines (header, UUID and summary skipped) with the offset', () => {
    expect(all).toHaveLength(9);
    expect(all[0]).toEqual({ ts: at('2026-10-11T08:01:02+02:00'), domain: 'Start', message: 'powerd process is started', kind: 'start', maintenance: false });
    expect(all.find((e) => e.domain === 'Kernel Client Acks')?.kind).toBeNull();
    expect(all.find((e) => e.domain === 'Wake Requests')?.kind).toBeNull();
  });

  it('power transitions incl. dark wake and maintenance sleep', () => {
    const p = pmsetPowerEntries(readText('pmset_g_log.txt'));
    expect(p.map((e) => `${e.kind}${e.maintenance ? '*' : ''}`)).toEqual(['start', 'sleep', 'darkwake', 'sleep*', 'wake', 'shutdown']);
    expect(p[1].message).toBe("Entering Sleep state due to 'Idle Sleep':TCPKeepAlive=active Using AC (Charge:100%)");
    expect(p[4]).toMatchObject({ ts: at('2026-10-12T07:30:05+02:00'), message: 'Wake from Deep Idle [CDNVA] : due to EC.LidOpen/Lid Open Using AC (Charge:100%)' });
  });

  it('tolerates space-separated columns and negative offsets', () => {
    const [e] = parsePmsetLog('2026-10-12 22:10:01 -0500 DarkWake            DarkWake from Normal Sleep [CDN] : due to NUB.SPMI0.SW3');
    expect(e).toMatchObject({ ts: at('2026-10-12T22:10:01-05:00'), domain: 'DarkWake', kind: 'darkwake', message: 'DarkWake from Normal Sleep [CDN] : due to NUB.SPMI0.SW3' });
    expect(parsePmsetLog('Time stamp   Domain   Message\n')).toEqual([]);
  });
});

describe('sysctl kern times', () => {
  it('parses timevals', () => {
    expect(parseTimeval('{ sec = 1791698462, usec = 345678 } Sun Oct 11 08:01:02 2026')).toBe(1791698462345);
    expect(parseTimeval('{ sec = 0, usec = 0 } Thu Jan  1 01:00:00 1970')).toBeNull();
    expect(parseTimeval('kaputt')).toBeNull();
  });

  it('boot, sleep and wake by name', () => {
    expect(parseKernTimes(readText('sysctl_kern_times.txt'))).toEqual({
      boot: at('2026-10-11T08:01:02.345+02:00'),
      sleep: at('2026-10-12T01:40:58.120+02:00'),
      wake: at('2026-10-12T07:30:05.640+02:00'),
    });
    expect(parseKernTimes(readText('sysctl_kern_times_fresh_boot.txt'))).toEqual({ boot: at('2026-10-11T08:01:02.345+02:00'), sleep: null, wake: null });
    expect(parseKernTimes("sysctl: unknown oid 'kern.waketime'\nkern.boottime: { sec = 10, usec = 0 } x")).toEqual({ boot: 10_000, sleep: null, wake: null });
  });
});

describe('system_profiler SPAirPortDataType -json', () => {
  it('channel, band and width', () => {
    expect(parseAirportChannel('36 (5GHz, 80MHz)')).toEqual({ channel: 36, band: '5 GHz', widthMhz: 80 });
    expect(parseAirportChannel('6 (2GHz, 20MHz)')).toEqual({ channel: 6, band: '2,4 GHz', widthMhz: 20 });
    expect(parseAirportChannel('37 (6GHz, 160MHz)')).toEqual({ channel: 37, band: '6 GHz', widthMhz: 160 });
    expect(parseAirportChannel(149)).toEqual({ channel: 149, band: '5 GHz', widthMhz: null });
    expect(parseAirportChannel('11')).toEqual({ channel: 11, band: '2,4 GHz', widthMhz: null });
    expect(parseAirportChannel(undefined)).toEqual({ channel: null, band: null, widthMhz: null });
  });

  it('signal / noise and the Windows-like percentage', () => {
    expect(parseSignalNoise('-54 dBm / -95 dBm')).toEqual({ rssiDbm: -54, noiseDbm: -95 });
    expect(parseSignalNoise('-61 dBm')).toEqual({ rssiDbm: -61, noiseDbm: null });
    expect(parseSignalNoise(null)).toEqual({ rssiDbm: null, noiseDbm: null });
    expect([-40, -50, -58, -75, -100, -110, null].map(signalPctFromRssi)).toEqual([100, 100, 84, 50, 0, 0, null]);
  });

  it('connected 5 GHz network', () => {
    const list = parseAirportJson(readJson('system_profiler_airport_connected.json'));
    expect(list.map((i) => i.device)).toEqual(['en0', 'awdl0']);
    expect(list[0]).toMatchObject({ connected: true, ssid: 'Vodafone-43FE', channel: 100, band: '5 GHz', widthMhz: 80, phyMode: '802.11ax', txMbps: 1201, rssiDbm: -58, noiseDbm: -94, mcs: 9, security: 'wpa2_personal' });
    const info = wlanInfoFromAirport(list, 5, { device: 'en0', mediaConnected: true });
    expect(info).toEqual({
      ts: 5, present: true, connected: true, ssid: 'Vodafone-43FE', bssid: null, radioType: '802.11ax', band: '5 GHz', channel: 100,
      signalPct: 84, rssiDbm: -58, rxMbps: null, txMbps: 1201,
      raw: { interface: 'en0', status: 'spairport_status_connected', phyMode: '802.11ax', channelWidthMhz: '80', noiseDbm: '-94', mcs: '9', security: 'wpa2_personal', countryCode: 'DE' },
    });
  });

  it('redacted SSID (no Location Services) and string rates', () => {
    const info = wlanInfoFromAirport(parseAirportJson(readJson('system_profiler_airport_redacted_24ghz.json')), 1);
    expect(info).toMatchObject({ connected: true, ssid: null, band: '2,4 GHz', channel: 6, txMbps: 144, rssiDbm: -71, signalPct: 58 });
    expect(info.raw.ssid).toContain('Ortungsdienste');
  });

  it('Wi-Fi off, adapter snapshot overrides, no Wi-Fi at all', () => {
    const off = parseAirportJson(readJson('system_profiler_airport_off.json'));
    expect(wlanInfoFromAirport(off, 1)).toMatchObject({ present: true, connected: false, ssid: null, channel: null, signalPct: null });
    const conn = parseAirportJson(readJson('system_profiler_airport_connected.json'));
    expect(wlanInfoFromAirport(conn, 1, { mediaConnected: false })).toMatchObject({ connected: false, rssiDbm: null });
    expect(wlanInfoFromAirport([], 1)).toMatchObject({ present: false, connected: false });
    expect(parseAirportJson({ SPAirPortDataType: 'x' })).toEqual([]);
    expect(parseAirportJson(null)).toEqual([]);
  });
});

describe('unified log (ndjson)', () => {
  it('timestamps with microseconds and offsets', () => {
    expect(parseLogTimestamp('2026-10-12 21:03:04.123456+0200')).toBe(at('2026-10-12T21:03:04.123+02:00'));
    expect(parseLogTimestamp('2026-10-12T19:03:04Z')).toBe(at('2026-10-12T19:03:04Z'));
    expect(parseLogTimestamp('gestern')).toBeNull();
  });

  it('kernel link messages of different drivers', () => {
    expect(kernelLinkEvent('Link up on en7, 1-Gigabit, Full-duplex, Symmetric flow-control, Debug [796d]')).toEqual({ device: 'en7', up: true, mbps: 1000, duplex: 'full' });
    expect(kernelLinkEvent('AppleBCM5701Ethernet [en0]: Link down on en0')).toEqual({ device: 'en0', up: false, mbps: null, duplex: null });
    expect(kernelLinkEvent('Link up on en8, 2.5-Gigabit, Half-duplex')).toEqual({ device: 'en8', up: true, mbps: 2500, duplex: 'half' });
    expect(kernelLinkEvent('Link up on en5')).toEqual({ device: 'en5', up: true, mbps: null, duplex: null });
    expect(kernelLinkEvent('en7: Link quality changed')).toBeNull();
  });

  it('parses the ndjson output (garbage and summary skipped)', () => {
    const text = readText('log_show_kernel_link.ndjson');
    expect(parseLogNdjson(text)).toHaveLength(6);
    const links = parseKernelLinkEvents(text);
    expect(links.map((l) => `${l.device}:${l.up ? 'up' : 'down'}:${l.mbps ?? '-'}`)).toEqual(['en7:up:1000', 'en7:down:-', 'en7:up:100', 'en0:down:-', 'en8:up:2500']);
    expect(links[1].ts).toBe(at('2026-10-11T19:12:01.004+02:00'));
  });
});
