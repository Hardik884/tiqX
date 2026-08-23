import type { NextFunction, Request, Response } from 'express';

import { pool } from '../db/pool.js';
import { UnauthorizedError } from '../errors/app-error.js';
import { findUserById } from '../modules/auth/auth.repository.js';
import type { AuthenticatedUser } from '../modules/auth/auth.types.js';
import { verifyAccessToken } from '../modules/auth/token.service.js';

const BEARER_PREFIX = 'Bearer ';

/**
 * Pulls the token out of `Authorization: Bearer <token>`.
 *
 * The scheme is matched case-sensitively and the header must contain exactly
 * one value: a repeated Authorization header arrives as an array, and picking
 * one of them would be guessing at which the client meant.
 */
function readBearerToken(req: Request): string | null {
  const header = req.headers.authorization;

  if (typeof header !== 'string' || !header.startsWith(BEARER_PREFIX)) {
    return null;
  }

  const token = header.slice(BEARER_PREFIX.length).trim();
  return token.length > 0 ? token : null;
}

/**
 * Establishes *who* the caller is. It answers nothing about what they may do -
 * that is `requireRole`'s job, and keeping the two apart is what stops
 * permission logic leaking into identity checks.
 *
 * The user is re-read from the database on every request rather than trusted
 * wholesale from the token. A JWT is a snapshot: without this, a deleted
 * account or a demoted organiser would keep their old powers until the token
 * expired. The role attached to the request is therefore the current one, and
 * the token's `role` claim is only used to detect a token that no longer
 * matches reality.
 *
 * Every failure is the same 401 with the same message. Distinguishing "expired"
 * from "bad signature" from "no such user" would help nobody but someone
 * probing.
 */
export async function requireAuth(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const token = readBearerToken(req);
    if (token === null) {
      throw new UnauthorizedError('Authentication required');
    }

    const claims = await verifyAccessToken(token);
    if (claims === null) {
      throw new UnauthorizedError('Authentication required');
    }

    const user = await findUserById(pool, claims.id);
    if (user === null) {
      throw new UnauthorizedError('Authentication required');
    }

    req.user = { id: user.id, role: user.role };
    next();
  } catch (error) {
    next(error);
  }
}

/**
 * Narrows `req.user` from optional to present for handlers that run behind
 * `requireAuth`.
 *
 * Handlers could assert with `!`, but then a route accidentally mounted without
 * the middleware would fail as an unhelpful runtime error deep in a service.
 * This turns that mistake into an explicit 401 at the edge, and keeps `any` out
 * of the call sites entirely.
 */
export function requireUser(req: Request): AuthenticatedUser {
  if (req.user === undefined) {
    throw new UnauthorizedError('Authentication required');
  }
  return req.user;
}
