// Node client for ps_worker.ps1 (one long-lived powershell.exe, JSON-lines RPC over stdin/stdout).
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

const BOOT = readFileSync(new URL('./ps_worker.ps1', import.meta.url), 'utf8');
const MARK = '@@RPC@@';

export class PsWorker {
  constructor({ onLog = () => {} } = {}) {
    this.onLog = onLog; this.seq = 0; this.pending = new Map(); this.proc = null; this.ready = null;
  }
  start() {
    const encoded = Buffer.from(BOOT, 'utf16le').toString('base64');
    const t0 = performance.now();
    this.proc = spawn('powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc.stdout.setEncoding('utf8');            // StringDecoder: safe for multi-byte splits
    let buf = '';
    this.ready = new Promise((resolve, reject) => {
      this.pending.set(0, { resolve: d => resolve({ ...d, startupMs: +(performance.now() - t0).toFixed(1) }), reject, timer: null });
    });
    this.proc.stdout.on('data', chunk => {
      buf += chunk; let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1);
        if (!line.startsWith(MARK)) { if (line.trim()) this.onLog('stray: ' + line); continue; }
        let msg; try { msg = JSON.parse(line.slice(MARK.length)); } catch (e) { this.onLog('bad json: ' + line.slice(0, 200)); continue; }
        const p = this.pending.get(msg.id); if (!p) continue;
        this.pending.delete(msg.id); if (p.timer) clearTimeout(p.timer);
        msg.ok ? p.resolve(msg.data) : p.reject(Object.assign(new Error(msg.error), { errorType: msg.errorType, errorId: msg.errorId }));
      }
    });
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', d => this.onLog('stderr: ' + d.slice(0, 300)));
    this.proc.on('exit', (code, sig) => {
      for (const [, p] of this.pending) { if (p.timer) clearTimeout(p.timer); p.reject(new Error(`powershell exited (${code ?? sig})`)); }
      this.pending.clear(); this.proc = null;
    });
    return this.ready;
  }
  call(cmd, { timeoutMs = 20000, depth = 5, array = false } = {}) {
    if (!this.proc) return Promise.reject(new Error('worker not running'));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {           // a hung cmdlet blocks the single-threaded worker -> kill & let caller restart
        this.pending.delete(id); reject(new Error('ps rpc timeout')); this.proc?.kill();
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin.write(JSON.stringify({ id, cmd, depth, array }) + '\n');
    });
  }
  stop() { this.proc?.stdin.end(); }
}
