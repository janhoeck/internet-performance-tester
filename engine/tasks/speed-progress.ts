// Throttled publisher for speed test progress (bus 'speedtest', at most one message per 250 ms
// → ≤ 4/s). Intermediate updates are coalesced; the final message is never dropped.
import type { SpeedtestProgress } from '../../src/lib/shared/types';

export class ProgressThrottle {
  private last = Number.NEGATIVE_INFINITY;
  private pending: SpeedtestProgress | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly publish: (p: SpeedtestProgress) => void,
    private readonly minIntervalMs = 250,
    private readonly now: () => number = () => performance.now(),
  ) {}

  /** publish now if allowed, else remember it and publish when the interval has passed */
  push(p: SpeedtestProgress): void {
    if (this.remaining() <= 0 && this.timer === null) {
      this.emit(p);
      return;
    }
    this.pending = p;
    if (this.timer === null) this.schedule();
  }

  /** publishes `p` as the last message (waits for the remaining interval, drops pending updates) */
  async final(p: SpeedtestProgress): Promise<void> {
    this.cancel();
    // loop: Node timers may fire ~1 ms early relative to performance.now()
    for (let wait = this.remaining(); wait > 0; wait = this.remaining()) {
      await new Promise<void>((resolve) => setTimeout(resolve, Math.ceil(wait)));
    }
    this.emit(p);
  }

  cancel(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.pending = null;
  }

  /** ms until the next message may be published (≤ 0 = now) */
  private remaining(): number {
    return this.minIntervalMs - (this.now() - this.last);
  }

  private schedule(): void {
    this.timer = setTimeout(() => this.flush(), Math.max(0, Math.ceil(this.remaining())));
  }

  private flush(): void {
    this.timer = null;
    if (this.remaining() > 0) {
      this.schedule(); // fired early – never publish faster than allowed
      return;
    }
    const p = this.pending;
    this.pending = null;
    if (p) this.emit(p);
  }

  private emit(p: SpeedtestProgress): void {
    this.last = this.now();
    this.publish(p);
  }
}
