import { z } from 'zod';

/** Both ids come from the URL; there is no request body to validate. */
export const confirmParamsSchema = z.object({
  eventId: z.uuid(),
  holdId: z.uuid(),
});

/** Cancellation is addressed by booking id alone; there is no body either. */
export const cancelParamsSchema = z.object({
  bookingId: z.uuid(),
});

const MIN_PAGE = 1;
const DEFAULT_PAGE_LIMIT = 20;
const MAX_PAGE_LIMIT = 100;

/** GET /api/v1/bookings - the caller's own bookings, paginated. */
export const myBookingsQuerySchema = z.object({
  page: z.coerce.number().int().min(MIN_PAGE).default(1),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT),
});

/** GET /api/v1/bookings/:bookingId */
export const bookingDetailParamsSchema = z.object({
  bookingId: z.uuid(),
});
