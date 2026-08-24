import type { NextFunction, Request, Response } from 'express';

import { AppError } from '../errors/app-error.js';
import {
  RateLimitUnavailableError,
  consumeRateLimit,
} from '../modules/rate-limit/rate-limit.service.js';
import type { RateLimitPolicy } from '../modules/rate-limit/rate-limit.types.js';
import { identifierDigest } from '../redis/keys.js';
import { logger } from '../utils/logger.js';

/** 429. A stable code, so clients can back off on the code rather than parse prose. */
export class RateLimitedError extends AppError {
  constructor(readonly retryAfterSeconds: number) {
    super('Too many requests. Try again later.', 429, 'RATE_LIMITED');
  }
}

/**
 * 503. Redis is down, and these endpoints refuse to run unprotected.
 *
 * Deliberately not a 429: the caller has not exceeded anything, and telling
 * them they have would be a lie that also invites them to retry on a schedule
 * that has nothing to do with the real problem.
 */
export class ProtectionUnavailableError extends AppError {
  constructor() {
    super('Service temporarily unavailable. Please retry shortly.', 503, 'DEPENDENCY_UNAVAILABLE');
  }
}

/**
 * Derives the client IP.
 *
 * `req.ip` honours X-Forwarded-For only when `trust proxy` is enabled, which is
 * a deployment fact rather than a default (see TRUST_PROXY in config). Falls
 * back to a constant when Express cannot determine an address, so an
 * unidentifiable caller shares one bucket instead of getting a free pass.
 */
function clientIp(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}

/**
 * Picks the identifier a policy counts against.
 *
 * Each choice is a tradeoff between stopping the attack and punishing innocents,
 * and they differ per endpoint:
 *
 *   login: email + IP.
 *     Email alone would let anyone lock a victim out of their own account by
 *     failing logins on their behalf - the limiter becomes the attack. IP alone
 *     punishes everyone behind one NAT or campus gateway. The pair targets what
 *     credential stuffing actually looks like: many guesses at one account from
 *     one source. It does not stop a single guess per account across thousands
 *     of IPs; that needs different signals and is out of scope here.
 *
 *   register: IP.
 *     The abuse is mass account creation, and the attacker chooses the email
 *     every time, so keying on it would hand out a fresh allowance per attempt.
 *     IP is the only part they cannot vary for free.
 *
 *   refresh: IP.
 *     The presented token would be a tempting key - it identifies a session
 *     precisely - but an attacker submits a *different* invalid token each
 *     time, so every request would mint a new Redis key: unbounded cardinality,
 *     a memory-exhaustion vector, and no limiting at all. The authenticated
 *     user is not known either, because resolving the token is the work being
 *     protected. IP is bounded and is the axis abuse actually travels on.
 *
 *   ticket verification: the authenticated user.
 *     Unlike the three above, this endpoint sits behind `requireAuth`, so a
 *     principal already exists by the time the limiter runs - there is no
 *     "becoming authenticated" problem to work around. The abuse this guards
 *     against is a single organiser/admin credential being used to hammer or
 *     enumerate ticket ids, which is an axis IP cannot see (venue staff on one
 *     gate network share an address, and would otherwise share one bucket) and
 *     the user id can: it is the actual unit the door-scanning role is granted
 *     to.
 */
export type IdentifierSource = 'ip' | 'email-and-ip' | 'user';

function resolveIdentifier(source: IdentifierSource, req: Request): string {
  const ip = clientIp(req);

  if (source === 'ip') {
    return identifierDigest(ip);
  }

  if (source === 'user') {
    // Mounted behind `requireAuth`, so `req.user` is always present; digested
    // like every other identifier so a leaked rate-limit key still reveals no
    // user id.
    return identifierDigest(req.user?.id ?? ip);
  }

  // Body may be anything; read defensively and normalise. An absent or
  // non-string email still yields a stable bucket rather than throwing, so a
  // malformed payload cannot slip past the limiter on its way to a 400.
  const body: unknown = req.body;
  const rawEmail =
    typeof body === 'object' && body !== null && 'email' in body
      ? (body as { email: unknown }).email
      : undefined;
  const email = typeof rawEmail === 'string' ? rawEmail : '';

  return identifierDigest(email, ip);
}

/**
 * Builds rate-limit middleware for one policy.
 *
 * Mounted before authentication, because the endpoints it guards are the ones a
 * caller uses to *become* authenticated - there is no principal to key on yet.
 *
 * FAIL CLOSED. If Redis cannot answer, the request is refused with 503 rather
 * than allowed through.
 *
 * That is the less convenient choice and it is deliberate. Failing open on
 * these three endpoints turns a Redis outage into an unmetered window against
 * the credential surface: exactly when monitoring is already noisy, login stops
 * counting attempts and an attacker who notices gets free rein. Failing closed
 * costs availability of sign-in during an outage, which is real but bounded,
 * visible, and self-announcing - and the readiness probe already reports Redis
 * down, so an orchestrator pulls the instance from rotation on its own.
 *
 * The reasoning is specific to these endpoints. A read-only listing endpoint
 * would sensibly fail open: degraded protection beats an outage when there is
 * no credential to guess. That is why the policy lives in the middleware rather
 * than in the limiter, which stays neutral and only reports what happened.
 *
 * Either way the failure is never silent - it is logged with the request id -
 * and there is no in-memory fallback. A process-local counter would be worse
 * than nothing here: it would report protection that does not hold across
 * instances, which is precisely the guarantee this feature exists to make.
 */
export function rateLimit(policy: RateLimitPolicy, source: IdentifierSource) {
  return async function enforceRateLimit(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const identifier = resolveIdentifier(source, req);
    const requestId = typeof res.locals.requestId === 'string' ? res.locals.requestId : undefined;

    try {
      const decision = await consumeRateLimit(policy, identifier);

      // Standard headers, so a well-behaved client can slow down before it is
      // refused. The identifier is never echoed back.
      res.setHeader('RateLimit-Limit', decision.limit);
      res.setHeader('RateLimit-Remaining', decision.remaining);
      res.setHeader('RateLimit-Reset', decision.resetSeconds);

      if (!decision.allowed) {
        res.setHeader('Retry-After', decision.resetSeconds);

        // The digest, not the email or IP: enough to correlate repeated abuse
        // without writing credentials or personal data to the log.
        logger.warn('Rate limit exceeded', {
          requestId,
          policy: policy.name,
          identifier,
          limit: decision.limit,
          resetSeconds: decision.resetSeconds,
        });

        throw new RateLimitedError(decision.resetSeconds);
      }

      next();
    } catch (error) {
      if (error instanceof RateLimitUnavailableError) {
        logger.error('Rate limiting degraded, refusing request', {
          requestId,
          policy: policy.name,
          // The driver's message only. Never the Redis URL, which may carry a
          // password, and never the error object, which repeats the options.
          error: error.reason instanceof Error ? error.reason.message : 'unknown error',
        });

        next(new ProtectionUnavailableError());
        return;
      }

      next(error);
    }
  };
}
