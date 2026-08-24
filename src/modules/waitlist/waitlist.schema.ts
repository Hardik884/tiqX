import { z } from 'zod';

import { SEAT_CATEGORIES } from '../events/event.types.js';

/** POST /api/v1/events/:eventId/waitlist */
export const joinParamsSchema = z.object({
  eventId: z.uuid(),
});

export const joinBodySchema = z.object({
  seatCategory: z.enum(SEAT_CATEGORIES),
});

/** POST /api/v1/events/:eventId/waitlist/:entryId/leave */
export const leaveParamsSchema = z.object({
  eventId: z.uuid(),
  entryId: z.uuid(),
});

/** POST /api/v1/waitlist/offers/:offerId/accept */
export const acceptOfferParamsSchema = z.object({
  offerId: z.uuid(),
});
