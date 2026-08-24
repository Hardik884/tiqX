import { z } from 'zod';

import { USER_ROLES } from './user.types.js';

export const MIN_PAGE = 1;
export const DEFAULT_PAGE_LIMIT = 20;
export const MAX_PAGE_LIMIT = 100;

/** GET /api/v1/admin/users */
export const listUsersQuerySchema = z.object({
  page: z.coerce.number().int().min(MIN_PAGE).default(1),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT),
  q: z.string().trim().min(1).max(200).optional(),
});

export const userIdParamsSchema = z.object({
  userId: z.uuid(),
});

/**
 * The role list is the same `as const` the database's `users_role_check`
 * mirrors, so this endpoint can never name a role the schema would reject.
 * `.strict()` keeps a caller from smuggling any other user field through a
 * route whose whole purpose is the one field.
 */
export const updateUserRoleSchema = z
  .object({
    role: z.enum(USER_ROLES),
  })
  .strict();

export type ListUsersQuery = z.infer<typeof listUsersQuerySchema>;
export type UpdateUserRoleBody = z.infer<typeof updateUserRoleSchema>;
