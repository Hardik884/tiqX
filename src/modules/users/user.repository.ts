import type { Queryable } from '../../db/pool.js';
import type { AdminUserView, UserRole } from './user.types.js';

interface UserRow {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  created_at: Date;
}

function toView(row: UserRow): AdminUserView {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    createdAt: row.created_at,
  };
}

/**
 * One page of accounts for the admin user list.
 *
 * `search` matches name or email, case-insensitively, as a substring - the
 * only lookup an admin actually performs here ("find the person who just
 * asked to run events"). Deliberately not the trigram/full-text machinery
 * public event discovery uses: this list is small, admin-only, and never
 * ranked.
 *
 * The password hash is not selected. Not filtered out afterwards - never
 * read, so there is no code path that could return it.
 */
export async function listUsersPage(
  db: Queryable,
  params: { page: number; limit: number; search?: string | undefined },
): Promise<AdminUserView[]> {
  const offset = (params.page - 1) * params.limit;
  const search = params.search === undefined ? null : `%${params.search}%`;

  const result = await db.query<UserRow>(
    `SELECT id, name, email, role, created_at
     FROM users
     WHERE $3::text IS NULL OR name ILIKE $3 OR email ILIKE $3
     ORDER BY created_at DESC, id
     LIMIT $1 OFFSET $2`,
    [params.limit, offset, search],
  );

  return result.rows.map(toView);
}

export async function countUsers(db: Queryable, search?: string | undefined): Promise<number> {
  const pattern = search === undefined ? null : `%${search}%`;
  const result = await db.query<{ count: string }>(
    `SELECT count(*)::text AS count
     FROM users
     WHERE $1::text IS NULL OR name ILIKE $1 OR email ILIKE $1`,
    [pattern],
  );
  return Number(result.rows[0]?.count ?? '0');
}

/**
 * Sets a user's role, returning the updated row.
 *
 * The role reaches SQL only as a bound parameter, and the column's own
 * `users_role_check` constraint is the final say on which values exist - the
 * schema, not this function, is what makes an invented role impossible.
 */
export async function updateUserRole(
  db: Queryable,
  userId: string,
  role: UserRole,
): Promise<AdminUserView | null> {
  const result = await db.query<UserRow>(
    `UPDATE users SET role = $2 WHERE id = $1
     RETURNING id, name, email, role, created_at`,
    [userId, role],
  );

  const row = result.rows[0];
  return row === undefined ? null : toView(row);
}
