import type { AuthenticatedUser } from '../modules/auth/auth.types.js';

/**
 * Teaches Express about the principal the authentication middleware attaches.
 *
 * Declaration merging rather than casting at each use site, so a handler that
 * reads `req.user` is type-checked instead of asserting. It is optional because
 * the property only exists on routes that ran `requireAuth`; handlers behind
 * that middleware use `requireUser(req)` to turn the optional into a value
 * without an `any` or a non-null assertion.
 */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}

export {};
