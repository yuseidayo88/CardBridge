/**
 * Per-host request pacing.
 *
 * These are partner shops that granted permission, not adversaries — which
 * makes restraint more important, not less. Permission to crawl is not
 * permission to hammer, and a partnership is easier to lose than to get.
 *
 * The limiter serialises requests per host and holds a minimum gap between
 * them. It is deliberately a queue rather than a token bucket: bursts are
 * exactly what we are avoiding, so there is no allowance to save up.
 */

export interface RateLimiterOptions {
  minIntervalMs: number;
  /** Random extra delay, 0..jitterMs, so repeated runs are not lockstep. */
  jitterMs?: number;
  maxConcurrency?: number;
}

export class RateLimiter {
  private readonly queues = new Map<string, Promise<void>>();
  private readonly lastRequestAt = new Map<string, number>();
  private readonly inFlight = new Map<string, number>();

  constructor(private readonly options: RateLimiterOptions) {
    if (options.minIntervalMs < 0) {
      throw new Error('minIntervalMs cannot be negative');
    }
  }

  /**
   * Run `task` once the host's pacing allows it.
   *
   * Chaining onto the host's queue promise is what serialises the work: each
   * caller waits for the previous one, then for the remaining gap.
   */
  async schedule<T>(host: string, task: () => Promise<T>): Promise<T> {
    const maxConcurrency = this.options.maxConcurrency ?? 1;

    const previous = this.queues.get(host) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.queues.set(
      host,
      previous.then(() => current),
    );

    await previous;

    try {
      while ((this.inFlight.get(host) ?? 0) >= maxConcurrency) {
        await sleep(25);
      }
      this.inFlight.set(host, (this.inFlight.get(host) ?? 0) + 1);

      const waitMs = this.remainingWaitMs(host);
      if (waitMs > 0) {
        await sleep(waitMs);
      }
      this.lastRequestAt.set(host, Date.now());
      return await task();
    } finally {
      this.inFlight.set(host, Math.max(0, (this.inFlight.get(host) ?? 1) - 1));
      release();
    }
  }

  private remainingWaitMs(host: string): number {
    const last = this.lastRequestAt.get(host);
    if (last === undefined) return 0;
    const jitter = this.options.jitterMs ? Math.random() * this.options.jitterMs : 0;
    const elapsed = Date.now() - last;
    return Math.max(0, this.options.minIntervalMs + jitter - elapsed);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Exponential backoff with full jitter.
 *
 * Full jitter rather than fixed doubling because several workers retrying a
 * shop that just returned 503 in unison is how a struggling site gets pushed
 * over.
 */
export function backoffDelayMs(attempt: number, baseMs = 2000, maxMs = 60_000): number {
  const exponential = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(Math.random() * exponential);
}
