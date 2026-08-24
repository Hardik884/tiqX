import { Router } from 'express';

import { requireAuth } from '../../middleware/authenticate.js';
import { cancelBookingHandler } from './booking.controller.js';

/**
 * Mounted at /api/v1/bookings.
 *
 * A booking is addressed on its own, not under its event: it is globally
 * unique, and a cancellation URL that also carried an event id would only give
 * a caller a second thing to get wrong. Confirmation stays where it is, under
 * /events/:eventId/holds/:holdId/confirm, because a hold genuinely is scoped to
 * an event.
 *
 * Authentication but no role check - a customer cancels their own booking, and
 * ownership is enforced in the service, under the row lock, rather than by a
 * role.
 */
export const bookingRouter = Router();

// POST /api/v1/bookings/:bookingId/cancel
bookingRouter.post('/:bookingId/cancel', requireAuth, cancelBookingHandler);
