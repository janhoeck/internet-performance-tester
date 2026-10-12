// Parser for macOS `route -n get [-inet6] <destination>` (docs/research/macos.md §3/§6): the route
// macOS uses for a destination, its interface and the (path) MTU of the matching route. Pure.
//
//      route to: 1.1.1.1
//   destination: default
//          mask: default
//       gateway: 192.168.0.1
//     interface: en0
//         flags: <UP,GATEWAY,DONE,STATIC,PRCLONING,GLOBAL>
//    recvpipe  sendpipe  ssthresh  rtt,msec    rttvar  hopcount      mtu     expire
//          0         0         0         0         0         0      1500         0

export interface RouteGet {
  routeTo: string | null;
  destination: string | null;
  /** next hop (IPv6 link-local with zone id, e.g. fe80::1%en0); null for on-link routes */
  gateway: string | null;
  /** link-layer gateway of an on-link host route (resolved neighbour MAC), if shown */
  gatewayMac: string | null;
  /** BSD name of the outgoing interface */
  interface: string | null;
  flags: string[];
  /** MTU of the route (path MTU for cloned host routes); null when 0/absent */
  mtu: number | null;
}

const MAC = /^[0-9a-fA-F]{1,2}(:[0-9a-fA-F]{1,2}){5}$/;

/** Null when the output has no interface (no route: "not in table" / "route has not been found"). */
export function parseRouteGet(text: string): RouteGet | null {
  const fields = new Map<string, string>();
  let header: string[] | null = null;
  let mtu: number | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '') continue;
    const kv = /^([a-z ]+):\s*(.*)$/i.exec(line);
    if (kv && !header) {
      fields.set(kv[1].trim().toLowerCase(), kv[2].trim());
      continue;
    }
    if (/\brecvpipe\b/.test(line) && /\bmtu\b/.test(line)) {
      header = line.split(/\s+/);
      continue;
    }
    if (header) {
      const values = line.split(/\s+/);
      const i = header.indexOf('mtu');
      const v = i >= 0 && i < values.length ? Number(values[i]) : NaN;
      mtu = Number.isFinite(v) && v > 0 ? v : null;
      header = null;
    }
  }
  const iface = fields.get('interface') ?? null;
  if (!iface) return null;
  const gw = fields.get('gateway') ?? null;
  const flags = (fields.get('flags') ?? '')
    .replace(/[<>]/g, '')
    .split(',')
    .map((f) => f.trim())
    .filter((f) => f !== '');
  const gwIsMac = gw !== null && MAC.test(gw);
  return {
    routeTo: fields.get('route to') ?? null,
    destination: fields.get('destination') ?? null,
    gateway: gw && !gwIsMac ? gw : null,
    gatewayMac: gw && gwIsMac ? gw.toLowerCase() : null,
    interface: iface,
    flags,
    mtu,
  };
}
