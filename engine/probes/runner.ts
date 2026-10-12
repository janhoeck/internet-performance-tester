// Grid-aligned interval scheduling for the Node-side probes (TCP, UDP-DNS, HTTP, egress check).
// Runs are aligned to `k · interval + offset` on the wall clock (so samples of different runs and
// targets line up with the 1 Hz ICMP grid) and never overlap: a slot is skipped while the
// previous run is still in flight.

/** First grid time strictly after `now`. */
export function nextGridTime(now: number, intervalMs: number, offsetMs = 0): number {
  return (Math.floor((now - offsetMs) / intervalMs) + 1) * intervalMs + offsetMs;
}

/** Latest grid time at or before `now`. */
export function prevGridTime(now: number, intervalMs: number, offsetMs = 0): number {
  return Math.floor((now - offsetMs) / intervalMs) * intervalMs + offsetMs;
}

/**
 * Deterministic per-target offset that spreads runs over the interval and keeps them away from
 * whole seconds (the ICMP agent sends there): `sec · 1000 + [minMs, 1000 − minMs)`.
 */
export function staggerOffset(id: string, intervalMs: number, minMs = 100): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  const sub = minMs + (h % Math.max(1, 1000 - 2 * minMs));
  const secs = Math.max(1, Math.floor(intervalMs / 1000));
  const sec = Math.floor(h / 1000) % secs;
  return (sec * 1000 + sub) % intervalMs;
}

export class IntervalRunner {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private stopped = true;

  constructor(
    private readonly intervalMs: number,
    private readonly offsetMs: number,
    private readonly task: (scheduledTs: number) => Promise<void> | void,
    private readonly onError?: (err: unknown) => void,
  ) {}

  get running(): boolean {
    return !this.stopped;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(Date.now());
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(after: number): void {
    const at = nextGridTime(after, this.intervalMs, this.offsetMs);
    this.timer = setTimeout(() => this.fire(at), Math.max(0, at - Date.now()));
  }

  private fire(at: number): void {
    this.timer = null;
    if (this.stopped) return;
    const now = Date.now();
    // timers may fire a little early (never schedule the same slot twice) or very late (standby):
    // a run that is more than one interval late uses the latest slot as its timestamp.
    const slot = now - at >= this.intervalMs ? prevGridTime(now, this.intervalMs, this.offsetMs) : at;
    this.schedule(Math.max(now, slot));
    if (this.busy) return;
    this.busy = true;
    Promise.resolve()
      .then(() => this.task(slot))
      .catch((err: unknown) => this.onError?.(err))
      .finally(() => {
        this.busy = false;
      });
  }
}
