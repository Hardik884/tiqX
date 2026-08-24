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
