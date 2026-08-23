import type { PoolClient } from 'pg';

import { config } from '../../config/index.js';
import { PG_ERROR, pgErrorCode } from '../../db/pg-error.js';
import { pool, withTransaction } from '../../db/pool.js';
import { ConflictError, UnauthorizedError } from '../../errors/app-error.js';
import { DEFAULT_USER_ROLE } from '../users/user.types.js';
import type { UserRole } from '../users/user.types.js';
import {
  findCredentialsByEmail,
  findUserById,
  insertRefreshToken,
  insertUser,
  lockRefreshTokenByHash,
  revokeAllUserRefreshTokens,
  revokeRefreshToken,
} from './auth.repository.js';
import type { IssuedTokens, PublicUser } from './auth.types.js';
import { hashPassword, verifyPassword, verifyPasswordAgainstDecoy } from './password.js';
import { generateRefreshToken, hashRefreshToken, signAccessToken } from './token.service.js';

/**
 * One message for every way authentication can fail.
 *
 * Login must not distinguish "no such account" from "wrong password", or the
 * endpoint becomes a way to test which addresses are registered. The
 * distinction is not logged either: knowing which of the two occurred is worth
 * little next to the risk of it reaching a response.
 */
function invalidCredentials(): UnauthorizedError {
  return new UnauthorizedError('Invalid credentials', 'INVALID_CREDENTIALS');
}

/** The local part of an email, used when a client registers without a name. */
function defaultNameFor(email: string): string {
  const localPart = email.slice(0, email.indexOf('@'));
  return localPart.length > 0 ? localPart : 'user';
}

/**
 * Registers a customer.
 *
 * The role is never taken from the request: it is always the server-side
 * default. Accepting one would let anybody register as an admin, and no
 * legitimate client needs to - privilege changes belong to an administrative
 * path that does not exist yet.
 */
export async function register(input: {
  email: string;
  password: string;
  name?: string | undefined;
}): Promise<PublicUser> {
  const passwordHash = await hashPassword(input.password);

  try {
    return await insertUser(pool, {
      email: input.email,
      name: input.name ?? defaultNameFor(input.email),
      passwordHash,
      role: DEFAULT_USER_ROLE,
    });
  } catch (error) {
    // The case-insensitive unique index is the authority on duplicates. A
    // check-then-insert would race: two simultaneous registrations could both
    // pass the check and only one survive, as a 500.
    if (pgErrorCode(error) === PG_ERROR.UNIQUE_VIOLATION) {
      throw new ConflictError('An account with that email already exists');
    }
    throw error;
  }
}

/**
 * Verifies credentials and issues a token pair.
 *
 * Both branches cost about the same: when no user matches, the password is
 * still verified against a decoy digest, so response time does not disclose
 * whether an address is registered.
 */
export async function login(input: { email: string; password: string }): Promise<{
  user: PublicUser;
  tokens: IssuedTokens;
}> {
  const credentials = await findCredentialsByEmail(pool, input.email);

  if (credentials === null) {
    await verifyPasswordAgainstDecoy(input.password);
    throw invalidCredentials();
  }

  if (!(await verifyPassword(credentials.passwordHash, input.password))) {
    throw invalidCredentials();
  }

  const { passwordHash: _passwordHash, ...user } = credentials;
  const tokens = await issueTokens(pool, { id: user.id, role: user.role });

  return { user, tokens };
}

/** Mints an access token and stores the digest of a fresh refresh token. */
async function issueTokens(
  db: PoolClient | typeof pool,
  principal: { id: string; role: UserRole },
  rotatedFrom?: string,
): Promise<IssuedTokens> {
  const rawRefreshToken = generateRefreshToken();

  const stored = await insertRefreshToken(db, {
    userId: principal.id,
    tokenHash: hashRefreshToken(rawRefreshToken),
    ttlSeconds: config.auth.refreshTokenTtlSeconds,
    rotatedFrom,
  });

  const access = await signAccessToken({ id: principal.id, role: principal.role });

  return {
    accessToken: access.token,
    expiresIn: access.expiresIn,
    tokenType: 'Bearer',
    // The only time the raw token exists outside the client. Only its digest
    // is written down.
    refreshToken: rawRefreshToken,
    refreshTokenExpiresAt: stored.expiresAt,
  };
}

/**
 * Exchanges a refresh token for a new pair, rotating the old one out.
 *
 * The whole rotation is one transaction, and the row is locked before anything
 * is decided:
 *
 *   BEGIN
 *     SELECT ... WHERE token_hash = $1 FOR UPDATE
 *     reject if missing, revoked or expired
 *     UPDATE ... SET revoked_at = now()
 *     INSERT the replacement, rotated_from -> the old row
 *   COMMIT
 *
 * The lock is what makes "a refresh token works exactly once" true under
 * concurrency: two simultaneous refreshes of one token serialise, and the
 * second finds it already revoked. On any failure the ROLLBACK leaves the
 * original live, rather than stranding the caller with no usable token.
 *
 * REUSE. A token that is found but already revoked has been presented twice.
 * The benign reading is a client retry; the alarming one is that it leaked and
 * someone else is using it - and from here the two are indistinguishable. So
 * every live token for that user is revoked and the caller refused: the cost to
 * an honest user is signing in again, the cost to an attacker is the whole
 * session. Full incident response is out of scope; the `rotated_from` chain is
 * left behind for it.
 */
type RefreshOutcome =
  | { kind: 'rotated'; tokens: IssuedTokens }
  | { kind: 'reused'; userId: string }
  | { kind: 'rejected' };

export async function refresh(rawRefreshToken: string): Promise<IssuedTokens> {
  const tokenHash = hashRefreshToken(rawRefreshToken);

  // The transaction *reports* what it found rather than throwing, because two
  // of the three outcomes need to commit something. Throwing from inside would
  // roll back the very revocation the reuse branch exists to perform.
  const outcome = await withTransaction<RefreshOutcome>(async (client) => {
    const existing = await lockRefreshTokenByHash(client, tokenHash);

    // Unknown token: nothing to revoke, and nothing to say beyond "no".
    if (existing === null) {
      return { kind: 'rejected' };
    }

    if (existing.revokedAt !== null) {
      return { kind: 'reused', userId: existing.userId };
    }

    if (existing.expired) {
      return { kind: 'rejected' };
    }

    // Re-read the user so a role change - or a deleted account - takes effect
    // at the next rotation instead of persisting for the life of the session.
    const user = await findUserById(client, existing.userId);
    if (user === null) {
      return { kind: 'rejected' };
    }

    await revokeRefreshToken(client, existing.id);

    return {
      kind: 'rotated',
      tokens: await issueTokens(client, { id: user.id, role: user.role }, existing.id),
    };
  });

  if (outcome.kind === 'rotated') {
    return outcome.tokens;
  }

  if (outcome.kind === 'reused') {
    // Its own transaction, so the revocation is durable before the caller is
    // refused. Doing this in the transaction above and then throwing would
    // undo it, leaving a leaked token's successor live - the exact opposite of
    // what detecting reuse is for.
    await withTransaction((client) => revokeAllUserRefreshTokens(client, outcome.userId));

    throw new UnauthorizedError(
      'Refresh token has already been used; all sessions have been revoked',
      'REFRESH_TOKEN_REUSED',
    );
  }

  throw invalidCredentials();
}

/**
 * Revokes the presented refresh token.
 *
 * Safe to repeat and safe to call with rubbish: an unknown or already-revoked
 * token still reports success. Logout is the one operation a client must always
 * be able to complete, and an error here would tell an unauthenticated caller
 * whether a given token exists.
 *
 * The access token is not invalidated. It cannot be without a revocation list
 * consulted on every request, which is exactly the per-request state JWTs exist
 * to avoid. The mitigation is the short TTL: the refresh chain dies at once,
 * and the access token stops working within its remaining minutes. Anything
 * needing instant kill-switch semantics wants sessions, not JWTs.
 */
export async function logout(rawRefreshToken: string): Promise<void> {
  const tokenHash = hashRefreshToken(rawRefreshToken);

  await withTransaction(async (client) => {
    const existing = await lockRefreshTokenByHash(client, tokenHash);
    if (existing !== null && existing.revokedAt === null) {
      await revokeRefreshToken(client, existing.id);
    }
  });
}
