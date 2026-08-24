import { Router } from 'express';

import { requireAuth } from '../../middleware/authenticate.js';
import { issueTicketsHandler } from '../tickets/ticket.controller.js';
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
 * Authentication but no role check on either route - the booking owner acts on
 * their own booking, and an organiser/admin issuing on someone else's behalf is
 * also legitimate. Both cases are ownership/authorisation checks made in the
 * service, under the row lock, rather than a role gate here. Ticket
 * *verification* is the opposite shape - a role gate with no ownership
 * involved - which is why it lives under /api/v1/tickets instead; see
 * ticket.routes.ts.
 */
export const bookingRouter = Router();

// POST /api/v1/bookings/:bookingId/cancel
bookingRouter.post('/:bookingId/cancel', requireAuth, cancelBookingHandler);

// POST /api/v1/bookings/:bookingId/tickets/issue
bookingRouter.post('/:bookingId/tickets/issue', requireAuth, issueTicketsHandler);
