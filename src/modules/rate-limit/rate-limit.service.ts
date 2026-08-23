import { getRedis } from '../../redis/client.js';
import { rateLimitKey } from '../../redis/keys.js';
import type { RateLimitDecision, RateLimitPolicy } from './rate-limit.types.js';

/**
 * Increment-and-expire, as one indivisible Redis operation.
 *
 * The obvious implementation - GET, add one in JavaScript, SET - is a lost
 * update waiting to happen: two requests read the same value and both write
 * back the same increment, so the counter under-counts exactly when traffic is
 * heaviest. INCR alone fixes that, but introduces a subtler bug: the key must
 * also be given a TTL, and
 *
 *     INCR key
 *     EXPIRE key window
 *
 * as two round trips can fail between them. A crash, a dropped connection or a
 * failover in that gap leaves a counter with no expiry - a key that never
 * resets, silently locking an identifier out forever. Even without a crash, two
 * requests can interleave so the second EXPIRE extends a window the first
 * already started.
 *
 * Redis runs a Lua script atomically: nothing else touches the keyspace while
 * it executes. So the increment and the conditional expiry are one step, and
 * the TTL is set only on the increment that created the key - the window starts
 * at the first request and is never extended by later ones.
 *
 * The script returns the count and the remaining TTL together, so the caller
 * gets a consistent view rather than reading the TTL in a second round trip
 * where it may already have changed.
 */
const CONSUME_SCRIPT = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('TTL', KEYS[1])
return { current, ttl }
`;

/** Raised when Redis cannot answer. Distinct so callers can apply a policy. */
export class RateLimitUnavailableError extends Error {
  /** Named `reason` rather than `cause`, which Error already defines. */
  readonly reason: unknown;

  constructor(reason: unknown) {
    super('Rate limit backend unavailable');
    this.name = 'RateLimitUnavailableError';
    this.reason = reason;
  }
}

/**
 * Records one request against a policy and reports whether it may proceed.
 *
 * ALGORITHM: fixed window. The counter is keyed on the policy and identifier,
 * created by the first request, and expires `windowSeconds` later; every
 * request in between shares it.
 *
 * The tradeoff is real and worth stating plainly: a fixed window does not
 * smooth traffic. With 10 per 5 minutes, a caller can spend 10 at 04:59:59 and
 * 10 more at 05:00:01 - 20 requests in two seconds, twice the nominal rate, and
 * entirely within the rules. What it does guarantee is a ceiling per window,
 * which is what stops sustained credential stuffing; it is not a defence
 * against a single short burst.
 *
 * A sliding window or token bucket would smooth that, at the cost of storing
 * timestamps per identifier rather than one integer. The interface here returns
 * a decision rather than exposing the counter, so swapping the algorithm later
 * changes this file and nothing else.
 *
 * Throws {@link RateLimitUnavailableError} when Redis cannot be reached; it
 * never decides on its own what that should mean for the request. That policy
 * belongs to the middleware, and differs per endpoint.
 */
export async function consumeRateLimit(
  policy: RateLimitPolicy,
  identifier: string,
): Promise<RateLimitDecision> {
  const key = rateLimitKey(policy.name, identifier);

  let count: number;
  let ttl: number;

  try {
    const result = (await getRedis().eval(
      CONSUME_SCRIPT,
      1,
      key,
      String(policy.windowSeconds),
    )) as [number, number];

    [count, ttl] = result;
  } catch (error) {
    throw new RateLimitUnavailableError(error);
  }

  // TTL returns -1 for a key with no expiry, which this script should make
  // impossible. Reporting the full window rather than a negative number keeps a
  // Retry-After header sane if it ever happens.
  const resetSeconds = ttl >= 0 ? ttl : policy.windowSeconds;

  return {
    allowed: count <= policy.max,
    limit: policy.max,
    remaining: Math.max(0, policy.max - count),
    resetSeconds,
  };
}

/**
 * Clears one identifier's counter. Used by tests; there is deliberately no
 * endpoint for it, since letting a caller reset its own limit would undo the
 * limit.
 */
export async function resetRateLimit(
  policy: RateLimitPolicy,
  identifier: string,
): Promise<void> {
  await getRedis().del(rateLimitKey(policy.name, identifier));
}
