// Parser for macOS `scutil --dns` (docs/research/macos.md §0, identity): the resolver configuration.
// Only the first section ("DNS configuration") is read; the scoped section that follows repeats the
// per-interface resolvers. Not localized. Pure.
//
//   resolver #1
//     search domain[0] : fritz.box
//     nameserver[0] : 192.168.0.1
//     if_index : 16 (en7)
//     flags    : Request A records, Request AAAA records
//   resolver #2
//     domain   : local
//     options  : mdns

export interface ScutilResolver {
  index: number;
  /** match domain (null = default resolver for all queries) */
  domain: string | null;
  nameservers: string[];
  searchDomains: string[];
  ifIndex: number | null;
  /** BSD name from "if_index : 16 (en7)" */
  device: string | null;
  options: string | null;
}

export function parseScutilDns(text: string): ScutilResolver[] {
  const out: ScutilResolver[] = [];
  let cur: ScutilResolver | null = null;
  let sections = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '') continue;
    if (/^DNS configuration/i.test(line)) {
      sections++;
      if (sections > 1) break;
      continue;
    }
    const head = /^resolver\s+#(\d+)/i.exec(line);
    if (head) {
      cur = { index: Number(head[1]), domain: null, nameservers: [], searchDomains: [], ifIndex: null, device: null, options: null };
      out.push(cur);
      continue;
    }
    if (!cur) continue;
    const kv = /^([a-z_ ]+?)(?:\[\d+\])?\s*:\s*(.*)$/i.exec(line);
    if (!kv) continue;
    const key = kv[1].trim().toLowerCase();
    const value = kv[2].trim();
    if (key === 'nameserver' && value !== '') cur.nameservers.push(value);
    else if (key === 'search domain' && value !== '') cur.searchDomains.push(value);
    else if (key === 'domain') cur.domain = value || null;
    else if (key === 'options') cur.options = value || null;
    else if (key === 'if_index') {
      const m = /^(\d+)(?:\s*\((\S+)\))?/.exec(value);
      if (m) {
        cur.ifIndex = Number(m[1]);
        cur.device = m[2] ?? null;
      }
    }
  }
  return out;
}

/** Name servers of the default resolvers (no match domain, no mDNS), in order, without duplicates. */
export function defaultNameservers(resolvers: readonly ScutilResolver[]): string[] {
  const out: string[] = [];
  for (const r of resolvers) {
    if (r.domain !== null || (r.options ?? '').includes('mdns')) continue;
    for (const ns of r.nameservers) if (!out.includes(ns)) out.push(ns);
  }
  return out;
}
