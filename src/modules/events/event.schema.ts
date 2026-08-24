import { z } from 'zod';

import {
  EVENT_CATEGORIES,
  EVENT_SORT_MODES,
  EVENT_STATUSES,
  EVENT_TYPES,
  SEAT_CATEGORIES,
} from './event.types.js';
import type { EventCursor } from './event.types.js';

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
    // Optional, defaulting to 'other' server-side (see insertEvent): making it
    // mandatory would be a breaking change to every existing caller of this
    // endpoint for a field that only public discovery, added in this task,
    // actually needs.
    category: z.enum(EVENT_CATEGORIES).optional(),
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
    category: z.enum(EVENT_CATEGORIES).optional(),
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

/** GET /api/v1/organiser/dashboard - same `all` escape hatch, no pagination. */
export const organiserDashboardQuerySchema = z.object({
  all: booleanFromQuery.default(false),
});

/** GET /api/v1/organiser/events/:eventId/bookings */
export const eventBookingListQuerySchema = z.object({
  page: z.coerce.number().int().min(MIN_PAGE).default(1),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT),
});

// ---------------------------------------------------------------------------
// Public discovery: GET /api/v1/events
// ---------------------------------------------------------------------------

/** Current cursor format. Bumping this the day the shape ever changes makes an old cursor fail cleanly instead of being misread. */
const CURSOR_VERSION = 1 as const;

const eventCursorPayloadSchema = z.object({
  v: z.literal(CURSOR_VERSION),
  sort: z.enum(EVENT_SORT_MODES),
  key: z.string().min(1),
  id: z.uuid(),
});

export function encodeEventCursor(cursor: EventCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

/**
 * Decodes and validates a cursor, or returns null for "no cursor" - the
 * first page. Every failure mode (not base64url, not JSON, wrong shape,
 * wrong version) collapses to the same outcome for the caller: `null` paired
 * with `ok: false`, so a 400 is returned without ever surfacing a parser
 * exception or stack trace - see `publicEventListQuerySchema` for where that
 * becomes the actual HTTP response.
 *
 * Deliberately unsigned. The cursor is opaque but is not a trust boundary: it
 * encodes a pagination *position* (a value already visible in the previous
 * page's own results), never an authorization decision, and the same
 * visibility predicates are re-applied on every request regardless of what a
 * cursor claims. A forged cursor can only make the query start somewhere
 * unexpected in an otherwise-identical, identically-authorized result set -
 * exactly what a client could already do by hand-crafting `startFrom`.
 * Signing it would add a second use of the JWT secret (or a new one) to guard
 * against a threat that does not exist here.
 */
function decodeEventCursor(raw: string): { ok: true; cursor: EventCursor } | { ok: false } {
  let parsed: unknown;
  try {
    const json = Buffer.from(raw, 'base64url').toString('utf8');
    parsed = JSON.parse(json);
  } catch {
    return { ok: false };
  }

  const result = eventCursorPayloadSchema.safeParse(parsed);
  return result.success ? { ok: true, cursor: result.data } : { ok: false };
}

const searchTextSchema = z.string().trim().min(1).max(200);
const citySchema = z.string().trim().min(1).max(100);

/**
 * `sort` and `cursor` are validated together, not independently: a cursor
 * minted under `start_asc` must not be silently reinterpreted under
 * `name_desc`. Decoding happens here, in the schema, so the service only ever
 * sees either a fully-validated `EventCursor` bound to the requested sort, or
 * a 400 that never reaches it.
 */
export const publicEventListQuerySchema = z
  .object({
    q: searchTextSchema.optional(),
    category: z.enum(EVENT_CATEGORIES).optional(),
    eventType: z.enum(EVENT_TYPES).optional(),
    city: citySchema.optional(),
    venueId: z.uuid().optional(),
    startFrom: z.iso.datetime({ offset: true }).optional(),
    startTo: z.iso.datetime({ offset: true }).optional(),
    sort: z.enum(EVENT_SORT_MODES).default('start_asc'),
    limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT),
    cursor: z.string().max(2000).optional(),
  })
  .refine(
    (value) =>
      value.startFrom === undefined ||
      value.startTo === undefined ||
      new Date(value.startFrom) <= new Date(value.startTo),
    { message: 'startFrom must not be after startTo', path: ['startTo'] },
  )
  .transform((value, ctx) => {
    if (value.cursor === undefined) {
      return { ...value, decodedCursor: null as EventCursor | null };
    }

    const decoded = decodeEventCursor(value.cursor);
    if (!decoded.ok) {
      ctx.addIssue({ code: 'custom', message: 'Invalid cursor', path: ['cursor'] });
      return z.NEVER;
    }

    if (decoded.cursor.sort !== value.sort) {
      // A cursor is bound to the sort it was minted under - reusing one
      // against a different sort would silently reinterpret `key` as the
      // wrong column's value.
      ctx.addIssue({ code: 'custom', message: 'Cursor does not match the requested sort', path: ['cursor'] });
      return z.NEVER;
    }

    return { ...value, decodedCursor: decoded.cursor };
  });

export type PublicEventListQuery = z.infer<typeof publicEventListQuerySchema>;
