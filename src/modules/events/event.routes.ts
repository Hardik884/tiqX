import { Router } from 'express';

import { config } from '../../config/index.js';
import { optionalAuth, requireAuth } from '../../middleware/authenticate.js';
import { requireRole } from '../../middleware/authorize.js';
import { rateLimit } from '../../middleware/rate-limit.js';
import { reservationRouter } from '../reservations/reservation.routes.js';
import { waitlistRouter } from '../waitlist/waitlist.routes.js';
import {
  createEventHandler,
  deleteEventHandler,
  getEventHandler,
  getPublicSeatMapHandler,
  listOrganiserEventsHandler,
  listPublicEventsHandler,
  publishEventHandler,
  updateEventHandler,
} from './event.controller.js';

export const eventRouter = Router();

// GET /api/v1/events - public discovery. Mounted first and matched only on
// an exact empty path, so it cannot be confused with `/:eventId` below.
// Rate limited per IP - see rate-limit.ts and config.rateLimit.search - since
// this is the one event endpoint anonymous traffic can call at volume with no
// identity to key on yet; the detail and seat-map reads are not, matching how
// the rest of this API only limits the endpoints with a demonstrated abuse
// shape rather than blanket-limiting every GET.
eventRouter.get('/', rateLimit(config.rateLimit.search, 'ip'), listPublicEventsHandler);

// Identity first, then permission, then the handler. Selling tickets is an
// organiser's job; admins are included because they administer the same
// resources. Resource-level ownership - "does *this* organiser own *this*
// event?" - is not checked here: RBAC only answers "is this an organiser at
// all?", and the finer question belongs to the service, under the row lock,
// so it applies equally to any non-HTTP caller - see event.service.ts.
eventRouter.post('/', requireAuth, requireRole('organiser', 'admin'), createEventHandler);

// GET /api/v1/events/:eventId - public discovery, not gated on role or even
// on being signed in. `optionalAuth` populates `req.user` when a valid token
// is presented and otherwise lets the request through anonymous; the service
// decides how much of the event to reveal from whatever identity, if any, it
// finds there.
eventRouter.get('/:eventId', optionalAuth, getEventHandler);

// GET /api/v1/events/:eventId/seats - the public seat map, same visibility
// rule as the event itself. Read-only: nothing under this route can create a
// hold, change a seat's status, or touch a booking - see
// show-seat.repository.ts::findPublicSeatMap.
eventRouter.get('/:eventId/seats', optionalAuth, getPublicSeatMapHandler);

// PATCH/DELETE/publish all require identity and the organiser/admin role, the
// same coarse gate as creation. Ownership of *this* event is, again, the
// service's job.
eventRouter.patch('/:eventId', requireAuth, requireRole('organiser', 'admin'), updateEventHandler);
eventRouter.delete('/:eventId', requireAuth, requireRole('organiser', 'admin'), deleteEventHandler);
eventRouter.post('/:eventId/publish', requireAuth, requireRole('organiser', 'admin'), publishEventHandler);

// Holds are scoped to an event: POST /api/v1/events/:eventId/holds
// Any authenticated user may hold seats - buying tickets is what a customer
// account is for - so this needs identity but no role restriction.
eventRouter.use('/:eventId/holds', requireAuth, reservationRouter);

// Waitlist join/leave, scoped to an event the same way holds are: POST
// /api/v1/events/:eventId/waitlist. Accepting an offer is not scoped this
// way - see waitlist-offer.routes.ts.
eventRouter.use('/:eventId/waitlist', requireAuth, waitlistRouter);

/**
 * Mounted at /api/v1/organiser/events, deliberately not nested under
 * /api/v1/events: this lists events *by ownership*, not one event by id, and
 * giving it a sibling top-level path keeps that distinction visible in the
 * URL rather than only in the query string.
 */
export const organiserEventsRouter = Router();

organiserEventsRouter.get(
  '/',
  requireAuth,
  requireRole('organiser', 'admin'),
  listOrganiserEventsHandler,
);
