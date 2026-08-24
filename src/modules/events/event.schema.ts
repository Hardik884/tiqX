import { z } from 'zod';

import { EVENT_STATUSES, EVENT_TYPES, SEAT_CATEGORIES } from './event.types.js';

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
    // Decimal strings so the value reaches NUMERIC without passing through a
    // float. Two decimal places, non-negative, bounded.
    pricing: z
      .record(z.enum(SEAT_CATEGORIES), z.string().regex(/^\d{1,8}(\.\d{1,2})?$/, 'must be a decimal amount'))
      .optional(),
    currency: z.string().regex(/^[A-Z]{3}$/, 'must be a 3-letter ISO code').optional(),
  })
  .strict()
  .refine((value) => new Date(value.endsAt) > new Date(value.startsAt), {
    message: 'endsAt must be after startsAt',
    path: ['endsAt'],
  });

export type CreateEventBody = z.infer<typeof createEventSchema>;

export const eventIdParamsSchema = z.object({
  eventId: z.uuid(),
});

/**
 * `venueId`, `eventType` and `status` are absent, not merely optional.
 *
 * `venueId`/`eventType` are structural: changing either would leave the
 * event's already-derived `show_seats` inventory pointing at the wrong venue
 * or category pricing, which this task does not implement re-deriving.
 * `status` is absent because every transition here has its own guarded
 * endpoint (`/publish`, ...) with its own state-machine rule; a plain field
 * update could otherwise jump straight from `draft` to `completed`.
 *
 * `.strict()` so a client sending any of them is told, rather than having the
 * field silently dropped and assuming it took effect - the same reasoning as
 * `createEventSchema` omitting `organiserId`.
 */
export const updateEventSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(2000).optional(),
    startsAt: z.iso.datetime({ offset: true }).optional(),
    endsAt: z.iso.datetime({ offset: true }).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field must be provided',
  });

export type UpdateEventBody = z.infer<typeof updateEventSchema>;

export const MIN_PAGE = 1;
export const DEFAULT_PAGE_LIMIT = 20;
export const MAX_PAGE_LIMIT = 100;

/**
 * Query strings arrive as text, and `z.coerce.boolean()` would make `?all=false`
 * true - `Boolean('false')` is `true` - so this enumerates the values a query
 * string can actually spell, the same way `booleanFromEnv` does for env vars.
 */
const booleanFromQuery = z
  .enum(['true', 'false', '1', '0'])
  .transform((value) => value === 'true' || value === '1');

/**
 * `all` is accepted from any caller but only honoured for an admin - see
 * event.service.ts. Rejecting it outright for an organiser would tell an
 * organiser this flag exists at all; silently ignoring it is the same
 * "answer identically" choice made everywhere else ownership is involved.
 */
export const organiserEventListQuerySchema = z.object({
  page: z.coerce.number().int().min(MIN_PAGE).default(1),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT),
  all: booleanFromQuery.default(false),
});
