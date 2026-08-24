import { z } from 'zod';

/** Both endpoints are addressed entirely by URL id; neither has a request body. */
export const issueTicketsParamsSchema = z.object({
  bookingId: z.uuid(),
});

export const verifyTicketParamsSchema = z.object({
  ticketId: z.uuid(),
});
