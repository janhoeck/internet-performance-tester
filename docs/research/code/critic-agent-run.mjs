import { spawn } from 'node:child_process';
import readline from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const dir = path.dirname(fileURLToPath(import.meta.url));
const cfg = { durationSec: 4, nicName: 'Ethernet', wlanName: 'WLAN', targets: [
  { id: 'gw4', host: '192.168.0.1', intervalMs: 1000, timeoutMs: 2000 },
  { id: 'gw6ll', host: 'fe80::de73:6ff:fe12:34df%4', intervalMs: 1000, timeoutMs: 2000 },
  { id: 'cf4', host: '1.1.1.1', intervalMs: 1000, timeoutMs: 2000 },
  { id: 'nobody', host: '192.168.0.2', intervalMs: 2000, timeoutMs: 1000 } ] };
const b64 = Buffer.from(JSON.stringify(cfg), 'utf8').toString('base64');
const t0 = Date.now();
const ch = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(dir, 'agent-test.ps1'), '-ConfigB64', b64], { windowsHide: true });
let n = 0;
readline.createInterface({ input: ch.stdout }).on('line', (l) => { n++; const m = JSON.parse(l); if (m.k === 'icmp' || n < 4) console.log(`+${Date.now() - t0}ms`, JSON.stringify(m)); });
ch.stderr.on('data', (d) => process.stdout.write('ERR ' + d));
ch.on('close', (c) => console.log('exit', c, 'lines', n, 'startup+run ms', Date.now() - t0));
