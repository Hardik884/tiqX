import { Router } from 'express';

import { requireAuth } from '../../middleware/authenticate.js';
import { requireRole } from '../../middleware/authorize.js';
import { reservationRouter } from '../reservations/reservation.routes.js';
import { createEventHandler } from './event.controller.js';

export const eventRouter = Router();

// Identity first, then permission, then the handler. Selling tickets is an
// organiser's job; admins are included because they administer the same
// resources.
eventRouter.post('/', requireAuth, requireRole('organiser', 'admin'), createEventHandler);

// Holds are scoped to an event: POST /api/v1/events/:eventId/holds
// Any authenticated user may hold seats - buying tickets is what a customer
// account is for - so this needs identity but no role restriction.
eventRouter.use('/:eventId/holds', requireAuth, reservationRouter);
