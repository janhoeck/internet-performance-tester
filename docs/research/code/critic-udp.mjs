// Small UDP verification: source-address trick, DNS CH TXT id.server, STUN mapping. A handful of packets only.
import dgram from 'node:dgram';
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';

const mask = (ip) => (ip.includes(':') ? ip.split(':').slice(0, 3).join(':') + ':…' : ip.split('.').slice(0, 2).join('.') + '.x.x');

function srcAddr(fam, host) {
  return new Promise((res) => {
    const s = dgram.createSocket(fam);
    s.on('error', (e) => { res('ERR ' + e.code); s.close(); });
    s.connect(53, host, () => { const a = s.address(); s.close(); res(a.address); });
  });
}

function dnsQuery(name, type, cls) {
  const id = crypto.randomInt(0, 65535);
  const parts = [Buffer.from([id >> 8, id & 255, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0])];
  for (const l of name.split('.').filter(Boolean)) { parts.push(Buffer.from([l.length])); parts.push(Buffer.from(l, 'ascii')); }
  parts.push(Buffer.from([0, type >> 8, type & 255, cls >> 8, cls & 255]));
  return { id, buf: Buffer.concat(parts) };
}
function skipName(b, o) { while (true) { const l = b[o]; if (l === 0) return o + 1; if ((l & 0xc0) === 0xc0) return o + 2; o += l + 1; } }
function parseTxt(b) {
  const an = b.readUInt16BE(6); let o = skipName(b, 12) + 4; const out = [];
  for (let i = 0; i < an; i++) {
    o = skipName(b, o); const type = b.readUInt16BE(o); const rdlen = b.readUInt16BE(o + 8); o += 10;
    if (type === 16) { let p = o; while (p < o + rdlen) { const l = b[p]; out.push(b.subarray(p + 1, p + 1 + l).toString()); p += l + 1; } }
    o += rdlen;
  }
  return { rcode: b[3] & 15, txt: out };
}
function udpReq(fam, host, port, buf, timeout = 2000, sock) {
  return new Promise((res) => {
    const s = sock || dgram.createSocket(fam);
    const t0 = performance.now();
    const timer = setTimeout(() => { s.removeAllListeners('message'); if (!sock) s.close(); res({ err: 'timeout' }); }, timeout);
    s.once('message', (msg) => { clearTimeout(timer); const rtt = performance.now() - t0; if (!sock) s.close(); res({ msg, rtt }); });
    s.send(buf, port, host);
  });
}
function stunReq() {
  const tid = crypto.randomBytes(12);
  return { tid, buf: Buffer.concat([Buffer.from([0x00, 0x01, 0x00, 0x00, 0x21, 0x12, 0xa4, 0x42]), tid]) };
}
function stunParse(m, tid) {
  let o = 20;
  while (o + 4 <= m.length) {
    const t = m.readUInt16BE(o), l = m.readUInt16BE(o + 2), v = m.subarray(o + 4, o + 4 + l);
    if (t === 0x0020) {
      const fam = v[1], port = v.readUInt16BE(2) ^ 0x2112;
      if (fam === 1) { const a = v.readUInt32BE(4) ^ 0x2112a442; return { port, ip: [a >>> 24, (a >> 16) & 255, (a >> 8) & 255, a & 255].join('.') }; }
      const key = Buffer.concat([Buffer.from([0x21, 0x12, 0xa4, 0x42]), tid]); const x = Buffer.alloc(16);
      for (let i = 0; i < 16; i++) x[i] = v[4 + i] ^ key[i];
      return { port, ip: x.toString('hex').match(/.{4}/g).join(':') };
    }
    o += 4 + l + ((4 - (l % 4)) % 4);
  }
  return null;
}

console.log('src v4 for 1.1.1.1 =', await srcAddr('udp4', '1.1.1.1'));
console.log('src v6 for 2606:4700:4700::1111 =', mask(await srcAddr('udp6', '2606:4700:4700::1111')));

for (const [fam, host] of [['udp4', '1.1.1.1'], ['udp6', '2606:4700:4700::1111']]) {
  const q = dnsQuery('id.server', 16, 3);
  const r = await udpReq(fam, host, 53, q.buf);
  console.log('CH TXT id.server @' + host, r.err || JSON.stringify(parseTxt(r.msg)), r.rtt ? r.rtt.toFixed(1) + 'ms' : '');
}
{
  const q = dnsQuery('o-o.myaddr.l.google.com', 16, 1);
  const r = await udpReq('udp4', '8.8.8.8', 53, q.buf);
  if (r.err) console.log('myaddr', r.err); else { const p = parseTxt(r.msg); console.log('o-o.myaddr TXT via 8.8.8.8 ->', p.txt.map((t) => (/^[\d.]+$/.test(t) || t.includes(':') ? mask(t) : t)).join(' | '), r.rtt.toFixed(1) + 'ms'); }
}
// NAT mapping behaviour: same local socket -> two STUN servers -> compare mapped ports
for (const fam of ['udp4', 'udp6']) {
  const s = dgram.createSocket(fam);
  await new Promise((r) => s.bind(0, r));
  const results = [];
  for (const [host, port] of [['stun.cloudflare.com', 3478], ['stun.l.google.com', 19302]]) {
    const q = stunReq();
    const r = await udpReq(fam, host, port, q.buf, 2000, s).catch((e) => ({ err: e.message }));
    const m = r.msg ? stunParse(r.msg, q.tid) : null;
    results.push({ host, err: r.err, rtt: r.rtt && r.rtt.toFixed(1), mappedIp: m && mask(m.ip), mappedPort: m && m.port });
  }
  console.log(fam, 'local port', s.address().port, JSON.stringify(results));
  s.close();
}
