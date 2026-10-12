// Parser for macOS `networksetup -listallhardwareports` (docs/research/macos.md §3): hardware port
// names ("Ethernet", "Wi-Fi", "USB 10/100/1000 LAN") per BSD device. Pure.
//
//   Hardware Port: Wi-Fi
//   Device: en0
//   Ethernet Address: 3c:22:fb:aa:bb:02

export interface HardwarePort {
  /** user visible name, e.g. 'Wi-Fi' */
  port: string;
  /** BSD name, e.g. 'en0' */
  device: string;
  mac: string | null;
}

export function parseHardwarePorts(text: string): HardwarePort[] {
  const out: HardwarePort[] = [];
  let port: string | null = null;
  let device: string | null = null;
  let mac: string | null = null;
  const flush = () => {
    if (port && device) out.push({ port, device, mac });
    port = device = mac = null;
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    let m: RegExpExecArray | null;
    if ((m = /^Hardware Port:\s*(.+)$/.exec(line))) {
      flush();
      port = m[1].trim();
    } else if ((m = /^Device:\s*(\S+)/.exec(line))) {
      device = m[1];
    } else if ((m = /^Ethernet Address:\s*(\S+)/.exec(line))) {
      mac = /^[0-9a-fA-F]{1,2}(:[0-9a-fA-F]{1,2}){5}$/.test(m[1]) ? m[1].toLowerCase() : null;
    } else if (line === '' || /^VLAN Configurations/.test(line)) {
      flush();
    }
  }
  flush();
  return out;
}

const WIFI_PORT = /wi-?fi|wlan|airport|wireless/i;
const BRIDGE_PORT = /bridge/i;

export function isWifiPort(port: string): boolean {
  return WIFI_PORT.test(port);
}

/** Hardware ports that are no physical link of their own (Thunderbolt Bridge). */
export function isBridgePort(port: string, device: string): boolean {
  return BRIDGE_PORT.test(port) || /^bridge\d+$/.test(device);
}
