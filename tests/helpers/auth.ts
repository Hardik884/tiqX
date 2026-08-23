import { randomUUID } from 'node:crypto';

import { query } from '../../src/db/pool.js';
import { hashPassword } from '../../src/modules/auth/password.js';
import { signAccessToken } from '../../src/modules/auth/token.service.js';
import type { UserRole } from '../../src/modules/users/user.types.js';

interface IdRow {
  id: string;
}

const createdUserIds: string[] = [];

/**
 * Mints a real access token for a user, using the same signer the server
 * verifies with.
 *
 * Tests that only need an authenticated caller use this rather than driving
 * register + login, which would spend an Argon2 hash per test for no extra
 * coverage. The full credential flow is exercised on its own in the auth
 * suites.
 */
export async function accessTokenFor(userId: string, role: UserRole): Promise<string> {
  const { token } = await signAccessToken({ id: userId, role });
  return token;
}

export interface AuthedUser {
  id: string;
  role: UserRole;
  email: string;
  password: string;
  token: string;
  authHeader: { authorization: string };
}

/**
 * Creates a user with a genuinely hashed password and returns them together
 * with a valid bearer token.
 */
export async function seedAuthedUser(role: UserRole = 'customer'): Promise<AuthedUser> {
  const email = `${role}-${randomUUID()}@example.test`;
  const password = `test-password-${randomUUID()}`;
  const passwordHash = await hashPassword(password);

  const result = await query<IdRow>(
    `INSERT INTO users (name, email, password_hash, role)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [`Test ${role}`, email, passwordHash, role],
  );

  const id = result.rows[0]!.id;
  createdUserIds.push(id);

  const token = await accessTokenFor(id, role);
  return { id, role, email, password, token, authHeader: { authorization: `Bearer ${token}` } };
}

export function bearer(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

/** Removes users created by {@link seedAuthedUser}, cascading their tokens. */
export async function cleanupAuthedUsers(): Promise<void> {
  await query('DELETE FROM users WHERE id = ANY($1::uuid[])', [createdUserIds]);
  createdUserIds.length = 0;
}

/**
 * Mints a token for an already-seeded user, reading their real role from the
 * database.
 *
 * Lets a test say "acting as this user" without registering and logging in for
 * every case. The role claim is looked up rather than guessed because a token
 * whose claim disagreed with the row would be testing the wrong thing - though
 * note the middleware re-reads the role anyway, so the database is what
 * actually decides.
 *
 * Falls back to `customer` when no such user exists, which is exactly what a
 * test for "token naming a deleted user" needs.
 */
export async function accessTokenForUser(userId: string): Promise<string> {
  const result = await query<{ role: UserRole }>('SELECT role FROM users WHERE id = $1', [userId]);
  return accessTokenFor(userId, result.rows[0]?.role ?? 'customer');
}
