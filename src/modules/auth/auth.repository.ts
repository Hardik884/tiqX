import type { Queryable } from '../../db/pool.js';
import type { UserRole } from '../users/user.types.js';
import type { PublicUser } from './auth.types.js';

interface UserRow {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  created_at: Date;
}

interface CredentialRow extends UserRow {
  password_hash: string;
}

export interface UserCredentials extends PublicUser {
  passwordHash: string;
}

export interface RefreshTokenRow {
  id: string;
  userId: string;
  expiresAt: Date;
  revokedAt: Date | null;
  /** True when the row is past its expiry according to the database clock. */
  expired: boolean;
}

function toPublicUser(row: UserRow): PublicUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    createdAt: row.created_at,
  };
}

/**
 * Every SELECT here lists its columns. `SELECT *` on `users` would pull
 * `password_hash` into places that have no business holding it, and the one
 * function that does need it says so in its name.
 */
export async function insertUser(
  db: Queryable,
  input: { email: string; name: string; passwordHash: string; role: UserRole },
): Promise<PublicUser> {
  const result = await db.query<UserRow>(
    `INSERT INTO users (email, name, password_hash, role)
     VALUES ($1, $2, $3, $4)
     RETURNING id, email, name, role, created_at`,
    [input.email, input.name, input.passwordHash, input.role],
  );

  const row = result.rows[0];
  if (!row) {
    throw new Error('INSERT INTO users returned no row');
  }
  return toPublicUser(row);
}

/**
 * Looks a user up for login, including the stored digest.
 *
 * Matched on `lower(email)` so it uses the existing `users_email_lower_key`
 * index and agrees with the uniqueness rule already enforced there - an address
 * that cannot be registered twice must not be findable two different ways
 * either.
 */
export async function findCredentialsByEmail(
  db: Queryable,
  email: string,
): Promise<UserCredentials | null> {
  const result = await db.query<CredentialRow>(
    `SELECT id, email, name, role, created_at, password_hash
     FROM users
     WHERE lower(email) = lower($1)`,
    [email],
  );

  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return { ...toPublicUser(row), passwordHash: row.password_hash };
}

/** Confirms a token's subject still exists, and reports their current role. */
export async function findUserById(db: Queryable, id: string): Promise<PublicUser | null> {
  const result = await db.query<UserRow>(
    'SELECT id, email, name, role, created_at FROM users WHERE id = $1',
    [id],
  );
  const row = result.rows[0];
  return row ? toPublicUser(row) : null;
}

/**
 * Stores a refresh token digest. `expires_at` is computed by PostgreSQL from
 * its own clock, as everywhere else in this schema, so token lifetimes cannot
 * drift with an application server's clock.
 */
export async function insertRefreshToken(
  db: Queryable,
  input: {
    userId: string;
    tokenHash: string;
    ttlSeconds: number;
    rotatedFrom?: string | undefined;
  },
): Promise<{ id: string; expiresAt: Date }> {
  const result = await db.query<{ id: string; expires_at: Date }>(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, rotated_from)
     VALUES ($1, $2, now() + make_interval(secs => $3::double precision), $4)
     RETURNING id, expires_at`,
    [input.userId, input.tokenHash, input.ttlSeconds, input.rotatedFrom ?? null],
  );

  const row = result.rows[0];
  if (!row) {
    throw new Error('INSERT INTO refresh_tokens returned no row');
  }
  return { id: row.id, expiresAt: row.expires_at };
}

/**
 * Finds a refresh token by digest and locks it for the rest of the transaction.
 *
 * `FOR UPDATE` is what stops two simultaneous refreshes of the same token both
 * succeeding: the second waits, and by the time it reads the row the first has
 * already marked it revoked. Without the lock both could pass the "not revoked"
 * check and mint two live successors from one token.
 *
 * Expiry is evaluated by the database rather than compared in JavaScript, for
 * the same reason the column is written from `now()`.
 */
export async function lockRefreshTokenByHash(
  db: Queryable,
  tokenHash: string,
): Promise<RefreshTokenRow | null> {
  const result = await db.query<{
    id: string;
    user_id: string;
    expires_at: Date;
    revoked_at: Date | null;
    expired: boolean;
  }>(
    `SELECT id, user_id, expires_at, revoked_at, (expires_at <= now()) AS expired
     FROM refresh_tokens
     WHERE token_hash = $1
     FOR UPDATE`,
    [tokenHash],
  );

  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    userId: row.user_id,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    expired: row.expired,
  };
}

/**
 * Marks a token revoked. Guarded on `revoked_at IS NULL` so revoking twice is a
 * no-op that keeps the original timestamp, which makes logout safe to repeat.
 * Returns whether this call was the one that revoked it.
 */
export async function revokeRefreshToken(db: Queryable, id: string): Promise<boolean> {
  const result = await db.query(
    'UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL',
    [id],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Revokes every live token a user holds. Used when a revoked token is
 * presented again: the safe reading of that is that a token leaked, and the
 * cheapest correct response is to end every session and make the user sign in
 * again.
 */
export async function revokeAllUserRefreshTokens(db: Queryable, userId: string): Promise<number> {
  const result = await db.query(
    'UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL',
    [userId],
  );
  return result.rowCount ?? 0;
}
