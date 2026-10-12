// v4 vs v6 snapshot: 20 interleaved UDP DNS (CH TXT id.server) probes per family on persistent sockets + 20 ICMP via a PowerShell .NET helper.
import dgram from 'node:dgram';
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { spawn } from 'node:child_process';

const N = 20;
function q() {
  const id = crypto.randomInt(0, 65535);
  return { id, buf: Buffer.concat([Buffer.from([id >> 8, id & 255, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 2]), Buffer.from('id'), Buffer.from([6]), Buffer.from('server'), Buffer.from([0, 0, 16, 0, 3])]) };
}
async function udpSeries(fam, host) {
  const s = dgram.createSocket(fam); const pending = new Map(); const rtts = [];
  s.on('message', (m) => { const id = m.readUInt16BE(0); const t0 = pending.get(id); if (t0 !== undefined) { rtts.push(performance.now() - t0); pending.delete(id); } });
  await new Promise((r) => s.bind(0, r));
  for (let i = 0; i < N; i++) { const x = q(); pending.set(x.id, performance.now()); s.send(x.buf, 53, host); await new Promise((r) => setTimeout(r, 250)); }
  await new Promise((r) => setTimeout(r, 1500)); s.close();
  return { sent: N, recv: rtts.length, rtts };
}
const stats = (a) => { const s = [...a].sort((x, y) => x - y); const p = (q) => s.length ? s[Math.min(s.length - 1, Math.floor(q * (s.length - 1)))].toFixed(1) : '-'; return `n=${s.length} min=${p(0)} p50=${p(0.5)} p90=${p(0.9)} max=${p(1)}`; };

const [u4, u6] = await Promise.all([udpSeries('udp4', '1.1.1.1'), udpSeries('udp6', '2606:4700:4700::1111')]);
console.log('UDP v4 1.1.1.1        first=' + (u4.rtts[0]?.toFixed(1)) + ' ' + stats(u4.rtts.slice(1)) + ` loss=${u4.sent - u4.recv}/${u4.sent}`);
console.log('UDP v6 2606:4700::1111 first=' + (u6.rtts[0]?.toFixed(1)) + ' ' + stats(u6.rtts.slice(1)) + ` loss=${u6.sent - u6.recv}/${u6.sent}`);

const ps = `$ErrorActionPreference='Stop'; $p=New-Object System.Net.NetworkInformation.Ping; foreach($i in 1..${N}){ foreach($t in '192.168.0.1','1.1.1.1','2606:4700:4700::1111','2a02:8101:3ff:ff89::3'){ $r=$p.Send($t,2000); '{0};{1};{2}' -f $t,$r.Status,$r.RoundtripTime }; Start-Sleep -Milliseconds 250 }`;
const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true });
let out = ''; child.stdout.on('data', (d) => (out += d)); await new Promise((r) => child.on('close', r));
const by = {};
for (const line of out.split(/\r?\n/).filter(Boolean)) { const [t, st, rtt] = line.split(';'); (by[t] ||= { ok: [], lost: 0 }); if (st === 'Success') by[t].ok.push(Number(rtt)); else by[t].lost++; }
for (const [t, v] of Object.entries(by)) console.log('ICMP ' + t.padEnd(24) + stats(v.ok) + ' lost=' + v.lost);
