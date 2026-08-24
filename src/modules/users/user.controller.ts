import type { Request, Response } from 'express';

import { BadRequestError } from '../../errors/app-error.js';
import { requireUser } from '../../middleware/authenticate.js';
import { listUsersQuerySchema, updateUserRoleSchema, userIdParamsSchema } from './user.schema.js';
import { listUsers, setUserRole } from './user.service.js';
import type { AdminUserView } from './user.types.js';

interface FieldError {
  field: string;
  message: string;
}

function toFieldErrors(issues: readonly { path: PropertyKey[]; message: string }[]): FieldError[] {
  return issues.map((issue) => ({
    field: issue.path.map(String).join('.') || '(root)',
    message: issue.message,
  }));
}

/** The only user shape this module ever serialises. */
function publicView(user: AdminUserView): Record<string, unknown> {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    createdAt: user.createdAt.toISOString(),
  };
}

/** GET /api/v1/admin/users */
export async function listUsersHandler(req: Request, res: Response): Promise<void> {
  const parsed = listUsersQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    throw new BadRequestError('Invalid query parameters', toFieldErrors(parsed.error.issues));
  }

  const result = await listUsers({
    page: parsed.data.page,
    limit: parsed.data.limit,
    search: parsed.data.q,
  });

  res.status(200).json({ ...result, users: result.users.map(publicView) });
}

/** PATCH /api/v1/admin/users/:userId/role */
export async function updateUserRoleHandler(req: Request, res: Response): Promise<void> {
  const params = userIdParamsSchema.safeParse(req.params);
  if (!params.success) {
    throw new BadRequestError('Invalid user id', toFieldErrors(params.error.issues));
  }

  const body = updateUserRoleSchema.safeParse(req.body);
  if (!body.success) {
    throw new BadRequestError('Invalid role payload', toFieldErrors(body.error.issues));
  }

  const { id: actingUserId } = requireUser(req);

  const user = await setUserRole({
    userId: params.data.userId,
    role: body.data.role,
    actingUserId,
  });

  res.status(200).json({ user: publicView(user) });
}
