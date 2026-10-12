// Node-native probes (no admin, no child processes): TCP connect RTT, DNS-over-UDP RTT, SSDP discovery.
import net from 'node:net';
import dgram from 'node:dgram';
import { randomInt } from 'node:crypto';

const nowMs = () => Number(process.hrtime.bigint()) / 1e6;

/** TCP handshake time (SYN -> SYN/ACK, 'connect' fires after our ACK). Closes immediately. */
export function tcpConnect(host, port, { timeoutMs = 3000, localAddress } = {}) {
  return new Promise(resolve => {
    const t0 = nowMs();
    const sock = net.connect({ host, port, noDelay: true, localAddress });
    let settled = false;
    const done = (ok, err) => {
      if (settled) return; settled = true;
      const ms = +(nowMs() - t0).toFixed(3);
      const local = sock.localAddress;
      sock.destroy();
      resolve({ ok, ms, err: err ?? null, local: local ?? null });
    };
    sock.setTimeout(timeoutMs, () => done(false, 'ETIMEDOUT'));
    sock.once('connect', () => done(true));
    sock.once('error', e => done(false, e.code || e.message));
  });
}

/** Build a minimal DNS query (RD=1, one question). */
export function buildDnsQuery(id, name, qtype = 1 /* A */) {
  const parts = [];
  for (const label of name.split('.').filter(Boolean)) {
    const b = Buffer.from(label, 'ascii');
    if (b.length > 63) throw new Error('label too long');
    parts.push(Buffer.from([b.length]), b);
  }
  parts.push(Buffer.from([0]));
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(0x0100, 2); // standard query, recursion desired
  header.writeUInt16BE(1, 4);      // QDCOUNT
  const tail = Buffer.alloc(4);
  tail.writeUInt16BE(qtype, 0);
  tail.writeUInt16BE(1, 2);        // class IN
  return Buffer.concat([header, ...parts, tail]);
}

function skipName(buf, off) { // handles compression pointers
  while (off < buf.length) {
    const len = buf[off];
    if (len === 0) return off + 1;
    if ((len & 0xc0) === 0xc0) return off + 2;
    off += 1 + len;
  }
  throw new Error('bad name');
}

/** Validate a DNS response against the query id/question; extract rcode + A/AAAA answers. */
export function parseDnsResponse(buf, expectId, expectQuestion) {
  if (buf.length < 12) return { valid: false, reason: 'short' };
  const id = buf.readUInt16BE(0), flags = buf.readUInt16BE(2);
  if (id !== expectId) return { valid: false, reason: 'id-mismatch' };
  if (!(flags & 0x8000)) return { valid: false, reason: 'not-a-response' };
  const qd = buf.readUInt16BE(4), an = buf.readUInt16BE(6);
  // question section must echo ours (defends against spoofed/stale datagrams)
  if (expectQuestion && qd >= 1) {
    const q = buf.subarray(12, 12 + expectQuestion.length);
    if (!q.equals(expectQuestion)) return { valid: false, reason: 'question-mismatch' };
  }
  const rcode = flags & 0x0f, tc = !!(flags & 0x0200), ra = !!(flags & 0x0080);
  const answers = [];
  try {
    let off = 12;
    for (let i = 0; i < qd; i++) off = skipName(buf, off) + 4;
    for (let i = 0; i < an; i++) {
      off = skipName(buf, off);
      const type = buf.readUInt16BE(off), ttl = buf.readUInt32BE(off + 4), rdlen = buf.readUInt16BE(off + 8);
      const rd = buf.subarray(off + 10, off + 10 + rdlen);
      if (type === 1 && rdlen === 4) answers.push({ type: 'A', ttl, data: [...rd].join('.') });
      else if (type === 28 && rdlen === 16) answers.push({ type: 'AAAA', ttl, data: rd.toString('hex').match(/.{4}/g).join(':') });
      else answers.push({ type, ttl });
      off += 10 + rdlen;
    }
  } catch { /* truncated/odd answer section - header info still valid */ }
  return { valid: true, rcode, tc, ra, answerCount: an, answers };
}

/** One DNS-over-UDP query; RTT measured from send() callback to first valid matching response. */
export function dnsQuery(server, { name = 'example.com', qtype = 1, port = 53, timeoutMs = 2000 } = {}) {
  return new Promise(resolve => {
    const sock = dgram.createSocket(net.isIPv6(server) ? 'udp6' : 'udp4');
    const id = randomInt(0, 0x10000);
    const query = buildDnsQuery(id, name, qtype);
    const question = query.subarray(12);
    let t0 = 0, settled = false;
    const finish = r => { if (settled) return; settled = true; clearTimeout(timer); try { sock.close(); } catch {} resolve({ server, name, ...r }); };
    const timer = setTimeout(() => finish({ ok: false, err: 'ETIMEDOUT', ms: null }), timeoutMs);
    sock.on('message', (msg, rinfo) => {
      if (rinfo.address !== server || rinfo.port !== port) return; // ignore strays
      const p = parseDnsResponse(msg, id, question);
      if (!p.valid) return;
      finish({ ok: p.rcode === 0, ms: +(nowMs() - t0).toFixed(3), rcode: p.rcode, tc: p.tc, ra: p.ra, answers: p.answers });
    });
    sock.on('error', e => finish({ ok: false, err: e.code || e.message, ms: null }));
    sock.bind(0, () => { t0 = nowMs(); sock.send(query, port, server, err => { if (err) finish({ ok: false, err: err.code, ms: null }); }); });
  });
}

/** SSDP M-SEARCH. On this multi-homed host the socket MUST be bound to the LAN IPv4 (else the query leaves via another interface). */
export function ssdpSearch({ bindAddress, st = 'ssdp:all', mx = 1, waitMs = 2500 } = {}) {
  return new Promise(resolve => {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const found = new Map();
    sock.on('message', (msg, rinfo) => {
      const t = msg.toString('latin1');
      const loc = /^LOCATION:\s*(\S+)/im.exec(t)?.[1] ?? null;
      const server = /^SERVER:\s*(.+)$/im.exec(t)?.[1]?.trim() ?? null;
      if (!found.has(rinfo.address)) found.set(rinfo.address, { from: rinfo.address, location: loc, server, sts: new Set() });
      found.get(rinfo.address).sts.add(/^ST:\s*(.+)$/im.exec(t)?.[1]?.trim());
    });
    sock.on('error', e => { try { sock.close(); } catch {} resolve({ error: e.code || e.message, devices: [] }); });
    sock.bind(0, bindAddress, () => {
      if (bindAddress) sock.setMulticastInterface(bindAddress);
      const m = `M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: ${mx}\r\nST: ${st}\r\n\r\n`;
      sock.send(m, 1900, '239.255.255.250');
    });
    setTimeout(() => { try { sock.close(); } catch {} resolve({ bindAddress: bindAddress ?? '(any)', devices: [...found.values()].map(d => ({ ...d, sts: [...d.sts] })) }); }, waitMs);
  });
}
