import type { UserRole } from '../users/user.types.js';

/**
 * Everything downstream code is allowed to know about the caller.
 *
 * Deliberately two fields. A decoded JWT, a database row or a full user profile
 * would all carry more than authorisation needs, and once such an object is in
 * circulation it tends to get read for things it should not decide. Identity
 * and role are enough to answer "who is this?" and "may they?".
 */
export interface AuthenticatedUser {
  id: string;
  role: UserRole;
}

/** The public shape of a user. Never carries the password hash. */
export interface PublicUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  createdAt: Date;
}

export interface IssuedTokens {
  accessToken: string;
  /** Seconds until the access token expires; the refresh token outlives it. */
  expiresIn: number;
  tokenType: 'Bearer';
  /** Returned exactly once, at issue time. Only its digest is stored. */
  refreshToken: string;
  refreshTokenExpiresAt: Date;
}
