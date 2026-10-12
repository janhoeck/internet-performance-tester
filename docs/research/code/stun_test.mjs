// STUN (RFC 5389/8489) binding test: same local socket -> several servers.
// Usage: node stun_test.mjs
import dgram from 'node:dgram';
import dns from 'node:dns/promises';
import crypto from 'node:crypto';

const MAGIC = 0x2112a442;

function buildBindingRequest() {
  const txId = crypto.randomBytes(12);
  const buf = Buffer.alloc(20);
  buf.writeUInt16BE(0x0001, 0); // Binding Request
  buf.writeUInt16BE(0x0000, 2); // message length (no attributes)
  buf.writeUInt32BE(MAGIC, 4); // magic cookie
  txId.copy(buf, 8);
  return { buf, txId };
}

function parseResponse(msg, txId) {
  if (msg.length < 20) return { error: 'short' };
  const type = msg.readUInt16BE(0);
  const len = msg.readUInt16BE(2);
  const cookie = msg.readUInt32BE(4);
  if (cookie !== MAGIC) return { error: 'bad cookie' };
  if (!msg.subarray(8, 20).equals(txId)) return { error: 'txid mismatch' };
  if (type !== 0x0101) return { error: 'type 0x' + type.toString(16) };
  let off = 20;
  const out = { attrs: [] };
  while (off + 4 <= 20 + len && off + 4 <= msg.length) {
    const at = msg.readUInt16BE(off);
    const al = msg.readUInt16BE(off + 2);
    const v = msg.subarray(off + 4, off + 4 + al);
    out.attrs.push('0x' + at.toString(16).padStart(4, '0'));
    if (at === 0x0020 || at === 0x0001 || at === 0x802b || at === 0x802c) {
      const fam = v[1];
      let port = v.readUInt16BE(2);
      let addr;
      if (at === 0x0020) port ^= MAGIC >>> 16;
      if (fam === 0x01) {
        const a = Buffer.from(v.subarray(4, 8));
        if (at === 0x0020) {
          const m = Buffer.alloc(4); m.writeUInt32BE(MAGIC, 0);
          for (let i = 0; i < 4; i++) a[i] ^= m[i];
        }
        addr = [...a].join('.');
      } else if (fam === 0x02) {
        const a = Buffer.from(v.subarray(4, 20));
        if (at === 0x0020) {
          const m = Buffer.concat([Buffer.from([0x21, 0x12, 0xa4, 0x42]), txId]);
          for (let i = 0; i < 16; i++) a[i] ^= m[i];
        }
        addr = a.toString('hex').match(/.{4}/g).join(':').replace(/(^|:)0{1,3}/g, '$1');
      }
      const name = { 0x0020: 'xorMapped', 0x0001: 'mapped', 0x802b: 'responseOrigin', 0x802c: 'otherAddress' }[at];
      out[name] = `${fam === 2 ? '[' + addr + ']' : addr}:${port}`;
    }
    off += 4 + al + ((4 - (al % 4)) % 4);
  }
  return out;
}

async function query(sock, host, port, family) {
  let ip;
  try {
    const r = await dns.lookup(host, { family });
    ip = r.address;
  } catch (e) {
    return { host, error: 'dns ' + e.code };
  }
  const { buf, txId } = buildBindingRequest();
  return new Promise((resolve) => {
    let tries = 0;
    const t0 = process.hrtime.bigint();
    let timer;
    const onMsg = (msg, rinfo) => {
      if (msg.length >= 20 && msg.subarray(8, 20).equals(txId)) {
        clearTimeout(timer);
        sock.off('message', onMsg);
        const rtt = Number(process.hrtime.bigint() - t0) / 1e6;
        resolve({ host, ip, port, rttMs: +rtt.toFixed(2), tries, from: rinfo.address, ...parseResponse(msg, txId) });
      }
    };
    sock.on('message', onMsg);
    const send = () => {
      tries++;
      sock.send(buf, port, ip);
      timer = setTimeout(() => {
        if (tries < 3) send();
        else { sock.off('message', onMsg); resolve({ host, ip, port, error: 'timeout' }); }
      }, 700 * tries);
    };
    send();
  });
}

async function run(family) {
  const sock = dgram.createSocket(family === 6 ? 'udp6' : 'udp4');
  await new Promise((r) => sock.bind(0, r));
  const local = sock.address();
  const servers = [
    ['stun.l.google.com', 19302],
    ['stun1.l.google.com', 19302],
    ['stun.cloudflare.com', 3478],
  ];
  const results = [];
  for (const [h, p] of servers) results.push(await query(sock, h, p, family));
  // second query to the first server from the same socket (mapping lifetime / port stability)
  results.push(await query(sock, servers[0][0], servers[0][1], family));
  sock.close();
  const mapped = results.filter((r) => r.xorMapped).map((r) => r.xorMapped);
  const uniq = [...new Set(mapped)];
  const verdict = mapped.length < 2 ? 'insufficient' : uniq.length === 1 ? 'endpoint-independent mapping (EIM)' : 'address/port-dependent mapping (EDM, symmetric-like)';
  console.log(JSON.stringify({ family, local: `${local.address}:${local.port}`, results, verdict }, null, 2));
}

await run(4);
await run(6);
