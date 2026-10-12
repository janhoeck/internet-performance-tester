// Test utility (only imported by *.test.ts): a ToolRunner that answers macOS tool invocations from
// canned outputs instead of spawning processes.
import fs from 'node:fs';
import type { RunOptions, RunResult } from '../util';

export interface FakeAnswer {
  stdout?: string;
  stderr?: string;
  code?: number | null;
  error?: (Error & { code?: string }) | null;
  timedOut?: boolean;
}

export interface FakeCall {
  file: string;
  args: string[];
  opts: RunOptions;
}

/** Reads a file of fixtures/macos/. */
export function macFixture(name: string): string {
  return fs.readFileSync(new URL(`../../../fixtures/macos/${name}`, import.meta.url), 'utf8');
}

/**
 * `answers` maps "<file> <args…>" (exact) or a predicate to the result; unknown invocations fail
 * with ENOENT like a missing tool.
 */
export class FakeToolRunner {
  readonly calls: FakeCall[] = [];
  killed = 0;

  constructor(private readonly answers: Record<string, FakeAnswer | (() => FakeAnswer)> = {}) {}

  set(command: string, answer: FakeAnswer | (() => FakeAnswer)): void {
    this.answers[command] = answer;
  }

  run(file: string, args: string[], opts: RunOptions): Promise<RunResult> {
    this.calls.push({ file, args, opts });
    const key = [file, ...args].join(' ');
    const entry = this.answers[key];
    const a: FakeAnswer =
      typeof entry === 'function' ? entry() : (entry ?? { error: Object.assign(new Error(`spawn ${file} ENOENT`), { code: 'ENOENT' }), code: null });
    return Promise.resolve({
      code: a.code === undefined ? 0 : a.code,
      stdout: Buffer.from(a.stdout ?? '', 'utf8'),
      stderr: Buffer.from(a.stderr ?? '', 'utf8'),
      timedOut: a.timedOut ?? false,
      error: a.error ?? null,
      durationMs: 1,
    });
  }

  killAll(): void {
    this.killed++;
  }

  commands(): string[] {
    return this.calls.map((c) => [c.file, ...c.args].join(' '));
  }
}
