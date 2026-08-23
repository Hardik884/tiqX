import type { NextFunction, Request, Response } from 'express';

import { ForbiddenError } from '../errors/app-error.js';
import type { UserRole } from '../modules/users/user.types.js';
import { requireUser } from './authenticate.js';

/**
 * Restricts a route to the listed roles.
 *
 * Authorisation lives here rather than inside controllers so the rule for a
 * route is visible where the route is declared, and so it cannot be forgotten
 * in one handler out of several. Adding a role to a route is a one-word change;
 * finding every controller that re-implemented a role check is not.
 *
 * Deliberately small: a list of allowed roles, no permission matrix, no
 * inheritance, no wildcard. The three roles the database already recognises are
 * the whole model. When something genuinely needs finer grain - an organiser
 * editing only their own events - it wants a resource-ownership check in the
 * service, which is a different question from "what kind of user is this?" and
 * should not be forced into this shape.
 *
 * Runs after `requireAuth`; an unauthenticated request is a 401 from that
 * middleware and never reaches this one.
 */
export function requireRole(...allowed: readonly [UserRole, ...UserRole[]]) {
  return function authorize(req: Request, _res: Response, next: NextFunction): void {
    try {
      const user = requireUser(req);

      if (!allowed.includes(user.role)) {
        // Says what is required, not what the caller is: the client already
        // knows its own role, and echoing it back adds nothing.
        throw new ForbiddenError(
          `This operation requires one of the following roles: ${allowed.join(', ')}`,
        );
      }

      next();
    } catch (error) {
      next(error);
    }
  };
}
