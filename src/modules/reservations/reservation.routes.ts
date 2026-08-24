import { Router } from 'express';

import { confirmHoldHandler } from '../bookings/booking.controller.js';
import { createHoldHandler, releaseHoldHandler } from './reservation.controller.js';

/**
 * Mounted under /events/:eventId/holds, so `mergeParams` is required for the
 * controller to see `eventId`.
 */
export const reservationRouter = Router({ mergeParams: true });

reservationRouter.post('/', createHoldHandler);

// POST /api/v1/events/:eventId/holds/:holdId/confirm
// Authentication is applied where this router is mounted, so the confirmation
// handler always has a principal.
reservationRouter.post('/:holdId/confirm', confirmHoldHandler);

// POST /api/v1/events/:eventId/holds/:holdId/release - voluntarily give up a
// still-active hold before it is confirmed or expires on its own.
reservationRouter.post('/:holdId/release', releaseHoldHandler);
