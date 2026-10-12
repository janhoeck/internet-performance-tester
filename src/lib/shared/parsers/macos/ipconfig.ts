// Parser for macOS `ipconfig getpacket <device>` (docs/research/macos.md §0, identity): the last
// DHCP packet of an interface. Not localized. Pure.
//
//   yiaddr = 192.168.0.43
//   server_identifier (ip): 192.168.0.1
//   router (ip_mult): {192.168.0.1}
//   domain_name_server (ip_mult): {192.168.0.1, 192.0.2.53}

export interface DhcpPacket {
  /** assigned address */
  yiaddr: string | null;
  serverIdentifier: string | null;
  routers: string[];
  dnsServers: string[];
  domainName: string | null;
  leaseTimeSec: number | null;
}

const list = (v: string): string[] =>
  v
    .replace(/^\{|\}$/g, '')
    .split(',')
    .map((x) => x.trim())
    .filter((x) => x !== '');

/** Null when the output contains no DHCP packet (manual configuration, no lease). */
export function parseIpconfigPacket(text: string): DhcpPacket | null {
  const p: DhcpPacket = { yiaddr: null, serverIdentifier: null, routers: [], dnsServers: [], domainName: null, leaseTimeSec: null };
  let seen = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    let m: RegExpExecArray | null;
    if ((m = /^yiaddr\s*=\s*(\S+)/.exec(line))) {
      seen = true;
      p.yiaddr = m[1] !== '0.0.0.0' ? m[1] : null;
      continue;
    }
    m = /^([a-z_]+)\s*\(([a-z0-9_]+)\)\s*:\s*(.*)$/i.exec(line);
    if (!m) continue;
    seen = true;
    const value = m[3].trim();
    switch (m[1].toLowerCase()) {
      case 'server_identifier':
        p.serverIdentifier = value || null;
        break;
      case 'router':
        p.routers = list(value);
        break;
      case 'domain_name_server':
        p.dnsServers = list(value);
        break;
      case 'domain_name':
        p.domainName = value || null;
        break;
      case 'lease_time': {
        const n = value.startsWith('0x') ? parseInt(value.slice(2), 16) : Number(value);
        p.leaseTimeSec = Number.isFinite(n) ? n : null;
        break;
      }
    }
  }
  return seen ? p : null;
}
