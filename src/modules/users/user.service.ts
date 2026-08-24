import { pool } from '../../db/pool.js';
import { ConflictError, NotFoundError } from '../../errors/app-error.js';
import { logger } from '../../utils/logger.js';
import { countUsers, listUsersPage, updateUserRole } from './user.repository.js';
import type { AdminUserView, ListUsersResult, UserRole } from './user.types.js';

export async function listUsers(params: {
  page: number;
  limit: number;
  search?: string | undefined;
}): Promise<ListUsersResult> {
  const [users, total] = await Promise.all([
    listUsersPage(pool, params),
    countUsers(pool, params.search),
  ]);

  return {
    users,
    page: params.page,
    limit: params.limit,
    total,
    totalPages: total === 0 ? 0 : Math.ceil(total / params.limit),
  };
}

export interface SetUserRoleInput {
  /** The account being changed. */
  userId: string;
  role: UserRole;
  /** The admin making the change - never the same account, see below. */
  actingUserId: string;
}

/**
 * Grants or revokes a role.
 *
 * This exists because registration deliberately never accepts a role from the
 * client (see auth.service.ts): everyone starts a customer, so without an
 * administrative way to promote an account there is no way for an organiser
 * to come into existence at all. Keeping promotion here rather than relaxing
 * registration is the whole point - self-assignment of privilege stays
 * impossible, and every promotion has a named admin behind it.
 *
 * An admin cannot change their own role. Not a permissions subtlety: the last
 * admin demoting themselves would leave the deployment with no account able
 * to promote anyone ever again, and no endpoint to recover through.
 *
 * The change takes effect on the target's very next request, not on their next
 * login: `requireAuth` re-reads the user's role from the database on every
 * request rather than trusting the token's claim.
 */
export async function setUserRole(input: SetUserRoleInput): Promise<AdminUserView> {
  if (input.userId === input.actingUserId) {
    throw new ConflictError('You cannot change your own role');
  }

  const user = await updateUserRole(pool, input.userId, input.role);
  if (user === null) {
    throw new NotFoundError('User not found');
  }

  logger.info('User role changed', {
    userId: user.id,
    role: user.role,
    changedBy: input.actingUserId,
  });

  return user;
}
