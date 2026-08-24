import { Router } from 'express';

import { requireAuth } from '../../middleware/authenticate.js';
import { requireRole } from '../../middleware/authorize.js';
import {
  addVenueSeatsHandler,
  createVenueHandler,
  deleteVenueSeatHandler,
  getVenueHandler,
  listVenueSeatsHandler,
  listVenuesHandler,
  updateVenueHandler,
  updateVenueSeatHandler,
} from './venue.controller.js';

/**
 * Mounted at /api/v1/venues.
 *
 * Two role gates, not one. Reading a venue and its layout is something an
 * organiser genuinely needs - picking a venue for an event, and seeing what
 * they are selling before they commit - so the reads stay open to
 * organiser/admin, as the venue listing already was. Changing the physical
 * estate is administration: a venue and its seat layout are shared by every
 * organiser who books it, so those are admin-only.
 *
 * Seat *inventory* for an event is not here at all: `show_seats` is derived
 * from this layout when an event is created and is only ever read publicly
 * through /events/:eventId/seats. Nothing under this router can hold, price,
 * or free a seat for sale.
 */
export const venueRouter = Router();

venueRouter.get('/', requireAuth, requireRole('organiser', 'admin'), listVenuesHandler);
venueRouter.post('/', requireAuth, requireRole('admin'), createVenueHandler);

venueRouter.get('/:venueId', requireAuth, requireRole('organiser', 'admin'), getVenueHandler);
venueRouter.patch('/:venueId', requireAuth, requireRole('admin'), updateVenueHandler);

venueRouter.get(
  '/:venueId/seats',
  requireAuth,
  requireRole('organiser', 'admin'),
  listVenueSeatsHandler,
);
venueRouter.post('/:venueId/seats', requireAuth, requireRole('admin'), addVenueSeatsHandler);
venueRouter.patch(
  '/:venueId/seats/:seatId',
  requireAuth,
  requireRole('admin'),
  updateVenueSeatHandler,
);
venueRouter.delete(
  '/:venueId/seats/:seatId',
  requireAuth,
  requireRole('admin'),
  deleteVenueSeatHandler,
);
