import { z } from 'zod';

/** Both ids come from the URL; there is no request body to validate. */
export const confirmParamsSchema = z.object({
  eventId: z.uuid(),
  holdId: z.uuid(),
});
