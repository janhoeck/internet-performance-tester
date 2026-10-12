// Small runtime helpers shared by the engine core (no engine state, no side effects).

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Human-readable message of an unknown thrown value (first line only). */
export function errorMessage(err: unknown): string {
  let msg: string;
  if (err instanceof Error) msg = err.message || err.name;
  else if (typeof err === 'string') msg = err;
  else if (isRecord(err) && typeof err.message === 'string') msg = err.message;
  else {
    try {
      msg = JSON.stringify(err) ?? String(err);
    } catch {
      msg = String(err);
    }
  }
  const firstLine = msg.split(/\r?\n/)[0] ?? '';
  return firstLine.trim() || 'unbekannter Fehler';
}

/** `code` property of a Node.js system error (e.g. 'EADDRINUSE'), if any. */
export function errorCode(err: unknown): string | null {
  return isRecord(err) && typeof err.code === 'string' ? err.code : null;
}

export type Settled<T> =
  | { status: 'fulfilled'; value: T }
  | { status: 'rejected'; reason: unknown }
  | { status: 'timeout' };

/**
 * Waits at most `ms` for a promise. Never rejects and never leaves an unhandled rejection
 * behind (a late rejection is swallowed – the caller already moved on).
 */
export function settleWithin<T>(promise: Promise<T>, ms: number): Promise<Settled<T>> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ status: 'timeout' }), Math.max(0, ms));
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve({ status: 'fulfilled', value });
      },
      (reason: unknown) => {
        clearTimeout(timer);
        resolve({ status: 'rejected', reason });
      },
    );
  });
}

/** Runs a possibly synchronous function and turns throws into a rejected promise. */
export async function invoke<T>(fn: () => T | Promise<T>): Promise<T> {
  return fn();
}

/** Case-insensitive comparison of interface aliases ('Ethernet' vs 'ethernet'). */
export function sameInterface(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export function round(v: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(v * f) / f;
}
