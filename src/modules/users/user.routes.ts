import { Router } from 'express';

import { requireAuth } from '../../middleware/authenticate.js';
import { requireRole } from '../../middleware/authorize.js';
import { listUsersHandler, updateUserRoleHandler } from './user.controller.js';

/**
 * Mounted at /api/v1/admin/users - admin only, both routes.
 *
 * Path-prefixed `admin/` rather than nested under a generic `/users`, because
 * every route here is administration of other people's accounts. There is no
 * self-service surface in this router at all: a caller reading or changing
 * their *own* account does that through /api/v1/auth.
 */
export const adminUserRouter = Router();

adminUserRouter.get('/', requireAuth, requireRole('admin'), listUsersHandler);
adminUserRouter.patch('/:userId/role', requireAuth, requireRole('admin'), updateUserRoleHandler);
