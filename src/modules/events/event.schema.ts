import { z } from 'zod';

import { EVENT_STATUSES, EVENT_TYPES } from './event.types.js';

/**
 * `organiserId` is absent for the same reason `userId` is absent from the hold
 * schema: it names a user, and a client must not choose which user an event
 * belongs to. The organiser is the authenticated principal.
 *
 * `.strict()` so a client still sending it is told, rather than having it
 * dropped and assuming it took effect.
 */
export const createEventSchema = z
  .object({
    venueId: z.uuid(),
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().max(2000).optional(),
    eventType: z.enum(EVENT_TYPES),
    startsAt: z.iso.datetime({ offset: true }),
    endsAt: z.iso.datetime({ offset: true }),
    status: z.enum(EVENT_STATUSES).optional(),
  })
  .strict()
  .refine((value) => new Date(value.endsAt) > new Date(value.startsAt), {
    message: 'endsAt must be after startsAt',
    path: ['endsAt'],
  });

export type CreateEventBody = z.infer<typeof createEventSchema>;
