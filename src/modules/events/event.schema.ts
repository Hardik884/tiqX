import { z } from 'zod';

import { EVENT_STATUSES, EVENT_TYPES } from './event.types.js';

export const createEventSchema = z
  .object({
    organiserId: z.uuid(),
    venueId: z.uuid(),
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().max(2000).optional(),
    eventType: z.enum(EVENT_TYPES),
    startsAt: z.iso.datetime({ offset: true }),
    endsAt: z.iso.datetime({ offset: true }),
    status: z.enum(EVENT_STATUSES).optional(),
  })
  .refine((value) => new Date(value.endsAt) > new Date(value.startsAt), {
    message: 'endsAt must be after startsAt',
    path: ['endsAt'],
  });

export type CreateEventBody = z.infer<typeof createEventSchema>;
