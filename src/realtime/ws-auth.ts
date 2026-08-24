import type { IncomingMessage } from 'node:http';

import { pool } from '../db/pool.js';
import type { AuthenticatedUser } from '../modules/auth/auth.types.js';
import { findUserById } from '../modules/auth/auth.repository.js';
import { verifyAccessToken } from '../modules/auth/token.service.js';

const BEARER_PREFIX = 'Bearer ';

/**
 * Resolves the caller of a WebSocket connection, from the plain HTTP request
 * that begins its upgrade handshake - before any Express middleware runs, and
 * without one.
 *
 * Reading `Authorization` off the *upgrade* request rather than a query
 * string keeps the token out of URLs: it would otherwise end up in access
 * logs, browser history and any proxy that logs request lines.
 *
 * MIRRORS `optionalAuth`, NOT `requireAuth`. A subscription's authorization
 * (see event-visibility.ts) is decided per `SUBSCRIBE_EVENT` message against
 * whatever identity this resolves to, exactly like `getPublicSeatMapHandler`
 * decides what to return per request against whatever `optionalAuth` found.
 * No token, an expired token, a bad signature, or a token naming a user who
 * no longer exists are therefore all the same outcome here: connect
 * anonymously, and let the per-subscription check decide what an anonymous
 * caller may see. A connection is not blocked for presenting a credential
 * that turned out to be no better than presenting none - the identical
 * reasoning `optionalAuth`'s own doc comment gives for the REST equivalent of
 * this same endpoint.
 */
export async function authenticateUpgrade(req: IncomingMessage): Promise<AuthenticatedUser | undefined> {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith(BEARER_PREFIX)) {
    return undefined;
  }

  const token = header.slice(BEARER_PREFIX.length).trim();
  if (token.length === 0) {
    return undefined;
  }

  const claims = await verifyAccessToken(token);
  if (claims === null) {
    return undefined;
  }

  const user = await findUserById(pool, claims.id);
  if (user === null) {
    return undefined;
  }

  return { id: user.id, role: user.role };
}
