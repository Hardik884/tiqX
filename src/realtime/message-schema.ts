import { z } from 'zod';

/**
 * Validates a decoded client message.
 *
 * A plain `z.uuid()` on `eventId` is also the SQL-injection defence for this
 * layer: every query downstream binds `eventId` as a parameter, never
 * interpolates it, so the only way a malicious string could matter is by
 * reaching a query at all - and this schema stops anything that is not a
 * well-formed UUID before it does.
 */
export const clientMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('SUBSCRIBE_EVENT'),
    eventId: z.uuid(),
  }),
  z.object({
    type: z.literal('UNSUBSCRIBE_EVENT'),
    eventId: z.uuid(),
  }),
]);
