// RFC 5780 NAT behaviour discovery (mapping + filtering) against one RFC5780-capable server.
// Usage: node stun5780.mjs stun.sonetel.com 3478
import dgram from 'node:dgram';
import dns from 'node:dns/promises';
import crypto from 'node:crypto';

const MAGIC = 0x2112a442;
const [host = 'stun.sonetel.com', portArg = '3478'] = process.argv.slice(2);
const PORT = Number(portArg);

function req(changeFlags = 0) {
  const txId = crypto.randomBytes(12);
  const attrs = [];
  if (changeFlags) {
    const a = Buffer.alloc(8);
    a.writeUInt16BE(0x0003, 0); // CHANGE-REQUEST
    a.writeUInt16BE(4, 2);
    a.writeUInt32BE(changeFlags, 4); // 0x04 change IP, 0x02 change port
    attrs.push(a);
  }
  const body = Buffer.concat(attrs);
  const h = Buffer.alloc(20);
  h.writeUInt16BE(0x0001, 0);
  h.writeUInt16BE(body.length, 2);
  h.writeUInt32BE(MAGIC, 4);
  txId.copy(h, 8);
  return { buf: Buffer.concat([h, body]), txId };
}

function addr(v, xor, txId) {
  const fam = v[1];
  let port = v.readUInt16BE(2);
  if (xor) port ^= MAGIC >>> 16;
  if (fam !== 1) return null;
  const a = Buffer.from(v.subarray(4, 8));
  if (xor) { const m = Buffer.alloc(4); m.writeUInt32BE(MAGIC); for (let i = 0; i < 4; i++) a[i] ^= m[i]; }
  return { ip: [...a].join('.'), port };
}

function parse(msg, txId) {
  const out = {};
  if (msg.readUInt16BE(0) !== 0x0101) return { error: 'type ' + msg.readUInt16BE(0).toString(16) };
  const len = msg.readUInt16BE(2);
  let off = 20;
  while (off + 4 <= 20 + len) {
    const t = msg.readUInt16BE(off), l = msg.readUInt16BE(off + 2), v = msg.subarray(off + 4, off + 4 + l);
    if (t === 0x0020) out.mapped = addr(v, true, txId);
    else if (t === 0x0001 && !out.mapped) out.mapped = addr(v, false, txId);
    else if (t === 0x802c || t === 0x0005) out.other = addr(v, false, txId); // OTHER-ADDRESS / CHANGED-ADDRESS
    else if (t === 0x802b || t === 0x0004) out.origin = addr(v, false, txId); // RESPONSE-ORIGIN / SOURCE-ADDRESS
    off += 4 + l + ((4 - (l % 4)) % 4);
  }
  return out;
}

function send(sock, ip, port, flags = 0, timeoutMs = 1500) {
  const { buf, txId } = req(flags);
  return new Promise((resolve) => {
    let tries = 0, timer;
    const onMsg = (m, rinfo) => {
      if (m.length >= 20 && m.subarray(8, 20).equals(txId)) {
        clearTimeout(timer); sock.off('message', onMsg);
        resolve({ from: `${rinfo.address}:${rinfo.port}`, ...parse(m, txId) });
      }
    };
    sock.on('message', onMsg);
    const go = () => {
      tries++; sock.send(buf, port, ip);
      timer = setTimeout(() => { if (tries < 3) go(); else { sock.off('message', onMsg); resolve(null); } }, timeoutMs / 3);
    };
    go();
  });
}

const { address: ip } = await dns.lookup(host, { family: 4 });
const sock = dgram.createSocket('udp4');
await new Promise((r) => sock.bind(0, r));
const t1 = await send(sock, ip, PORT);
const result = { server: `${host} (${ip}:${PORT})`, local: sock.address().port, test1: t1 };
if (t1?.other) {
  // Mapping tests (RFC 5780 4.3)
  result.mapTest2 = await send(sock, t1.other.ip, PORT);
  result.mapTest3 = await send(sock, t1.other.ip, t1.other.port);
  const m = (r) => (r?.mapped ? `${r.mapped.ip}:${r.mapped.port}` : null);
  const a = m(t1), b = m(result.mapTest2), c = m(result.mapTest3);
  result.mapping = !b ? 'unknown' : a === b ? 'endpoint-independent' : b === c ? 'address-dependent' : 'address-and-port-dependent';
  // Filtering tests (RFC 5780 4.4) - fresh socket so no prior permission to other address
  const s2 = dgram.createSocket('udp4');
  await new Promise((r) => s2.bind(0, r));
  const f1 = await send(s2, ip, PORT);
  const f2 = await send(s2, ip, PORT, 0x06); // change IP + port
  const f3 = f2 ? null : await send(s2, ip, PORT, 0x02); // change port only
  result.filterTest2 = f2; result.filterTest3 = f3;
  result.filtering = !f1 ? 'unknown' : f2 ? 'endpoint-independent' : f3 ? 'address-dependent' : 'address-and-port-dependent';
  s2.close();
}
sock.close();
console.log(JSON.stringify(result, null, 2));
