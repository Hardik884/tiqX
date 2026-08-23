import { Router } from 'express';

import { createHoldHandler } from './reservation.controller.js';

/**
 * Mounted under /events/:eventId/holds, so `mergeParams` is required for the
 * controller to see `eventId`.
 */
export const reservationRouter = Router({ mergeParams: true });

reservationRouter.post('/', createHoldHandler);
