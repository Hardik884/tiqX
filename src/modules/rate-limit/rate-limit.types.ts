/**
 * A rate-limit rule: how many requests, over how long, under what name.
 *
 * The name becomes part of the Redis key, so `login` and `register` count
 * independently even for the same identifier.
 */
export interface RateLimitPolicy {
  name: string;
  max: number;
  windowSeconds: number;
}

/** The limiter's verdict for one request. */
export interface RateLimitDecision {
  allowed: boolean;
  /** Requests permitted in this window. */
  limit: number;
  /** Requests left after this one; never negative. */
  remaining: number;
  /** Seconds until the current window ends and the counter resets. */
  resetSeconds: number;
}
