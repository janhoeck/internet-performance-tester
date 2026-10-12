// Child process helpers: kill a whole process tree on shutdown (taskkill /T /F on Windows).
import { type ChildProcess, spawn } from 'node:child_process';
import path from 'node:path';

export function systemExe(name: string): string {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  return path.join(root, 'System32', name);
}

export function isAlive(child: ChildProcess): boolean {
  return typeof child.pid === 'number' && child.exitCode === null && child.signalCode === null;
}

/** Kills a process and all its descendants. Resolves when done or after `timeoutMs`; never rejects. */
export function killTree(child: ChildProcess, timeoutMs = 3000): Promise<void> {
  const pid = child.pid;
  if (!isAlive(child) || pid === undefined) return Promise.resolve();
  if (process.platform !== 'win32') {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let done = false;
    let killer: ChildProcess | null = null;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      // fallback: TerminateProcess on the direct child (children die with the job object anyway)
      if (isAlive(child)) {
        try {
          child.kill();
        } catch {
          /* already gone */
        }
      }
      resolve();
    };
    const timer = setTimeout(() => {
      try {
        killer?.kill();
      } catch {
        /* ignore */
      }
      finish();
    }, timeoutMs);
    try {
      killer = spawn(systemExe('taskkill.exe'), ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
        shell: false,
      });
      killer.once('exit', finish);
      killer.once('error', finish);
    } catch {
      finish();
    }
  });
}
