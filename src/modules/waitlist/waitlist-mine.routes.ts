import { Router } from 'express';

import { requireAuth } from '../../middleware/authenticate.js';
import { listMyWaitlistEntriesHandler } from './waitlist.controller.js';

/**
 * Mounted at /api/v1/waitlist/mine - the caller's own waitlist entries across
 * every event, for the frontend's waitlist view. Kept as its own router,
 * separate from waitlistOfferRouter (/api/v1/waitlist/offers), so neither
 * mount point's path prefix ambiguity has to be reasoned about.
 */
export const waitlistMineRouter = Router();

waitlistMineRouter.get('/', requireAuth, listMyWaitlistEntriesHandler);
