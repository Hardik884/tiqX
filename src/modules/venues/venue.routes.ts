import { Router } from 'express';

import { requireAuth } from '../../middleware/authenticate.js';
import { requireRole } from '../../middleware/authorize.js';
import { listVenuesHandler } from './venue.controller.js';

/**
 * Mounted at /api/v1/venues. Read-only: there is no venue creation/edit API
 * anywhere in this codebase, so listing is the entire surface. Gated to
 * organiser/admin, the only callers - picking a venue for an event.
 */
export const venueRouter = Router();

venueRouter.get('/', requireAuth, requireRole('organiser', 'admin'), listVenuesHandler);
