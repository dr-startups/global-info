/**
 * Simple token-bucket rate limiter (30 req/min Arsenkin hard cap).
 */

export type RateLimiter = {
  /** Wait until a request slot is available, then consume one. */
  acquire: () => Promise<void>;
};

export function createTokenBucket(options: {
  capacity: number;
  refillPerMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): RateLimiter {
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  let tokens = options.capacity;
  let last = now();

  function refill() {
    const t = now();
    const elapsed = Math.max(0, t - last);
    const add = (elapsed / options.refillPerMs) * options.capacity;
    if (add > 0) {
      tokens = Math.min(options.capacity, tokens + add);
      last = t;
    }
  }

  return {
    async acquire() {
      for (;;) {
        refill();
        if (tokens >= 1) {
          tokens -= 1;
          return;
        }
        const need = 1 - tokens;
        const waitMs = Math.ceil((need / options.capacity) * options.refillPerMs);
        await sleep(Math.max(50, waitMs));
      }
    },
  };
}

export function createArsenkinRateLimiter(requestsPerMinute: number, deps?: {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): RateLimiter {
  const rpm = Math.max(1, Math.min(30, requestsPerMinute));
  return createTokenBucket({
    capacity: rpm,
    refillPerMs: 60_000,
    now: deps?.now,
    sleep: deps?.sleep,
  });
}
