import { Router } from 'express';

import { requireAuth } from '../../middleware/authenticate.js';
import { acceptWaitlistOfferHandler } from './waitlist.controller.js';

/**
 * Mounted at /api/v1/waitlist/offers, deliberately not nested under
 * /api/v1/events/:eventId - an offer id is already globally unique, and the
 * task specifies this exact path. See event.routes.ts's own note on
 * organiserEventsRouter for the same shape of decision.
 *
 * `requireAuth` lives here rather than at the mount point in routes/index.ts,
 * since this router (unlike waitlistRouter) is not nested under anything else
 * that already applies it.
 */
export const waitlistOfferRouter = Router();

// POST /api/v1/waitlist/offers/:offerId/accept
waitlistOfferRouter.post('/:offerId/accept', requireAuth, acceptWaitlistOfferHandler);
