import type { Queryable } from '../../db/pool.js';
import type {
  CreateEventInput,
  EventCategory,
  EventRecord,
  EventSortMode,
  EventStatus,
  EventType,
} from './event.types.js';

interface EventRow {
  id: string;
  organiser_id: string;
  venue_id: string;
  title: string;
  description: string | null;
  category: EventCategory;
  event_type: EventType;
  starts_at: Date;
  ends_at: Date;
  status: EventStatus;
  currency: string;
  created_at: Date;
  updated_at: Date;
}

function toEventRecord(row: EventRow): EventRecord {
  return {
    id: row.id,
    organiserId: row.organiser_id,
    venueId: row.venue_id,
    title: row.title,
    description: row.description,
    category: row.category,
    eventType: row.event_type,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    status: row.status,
    currency: row.currency,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * The event's status alone, unlocked - for a caller that needs to answer
 * "does this exist and is it public-facing?" without taking part in
 * `event.service.ts`'s ownership lock order. Used by waitlist.service.ts's
 * join check; nothing here mutates the row, so no lock is warranted.
 */
export async function findEventStatus(db: Queryable, eventId: string): Promise<EventStatus | null> {
  const result = await db.query<{ status: EventStatus }>('SELECT status FROM events WHERE id = $1', [
    eventId,
  ]);
  return result.rows[0]?.status ?? null;
}

export async function insertEvent(db: Queryable, input: CreateEventInput): Promise<EventRecord> {
  const result = await db.query<EventRow>(
    `INSERT INTO events (organiser_id, venue_id, title, description, category, event_type, starts_at, ends_at, status, currency)
     VALUES ($1, $2, $3, $4, COALESCE($5, 'other'), $6, $7, $8, COALESCE($9, 'draft'), COALESCE($10, 'INR'))
     RETURNING *`,
    [
      input.organiserId,
      input.venueId,
      input.title,
      input.description ?? null,
      input.category ?? null,
      input.eventType,
      input.startsAt,
      input.endsAt,
      input.status ?? null,
      input.currency ?? null,
    ],
  );

  const row = result.rows[0];
  if (!row) {
    throw new Error('INSERT INTO events returned no row');
  }

  return toEventRecord(row);
}

/** An event joined with the venue fields the public view needs: its name and city. */
export interface EventWithVenue {
  event: EventRecord;
  venueName: string;
  venueCity: string | null;
}

/** Unlocked read for the public/private GET - nothing here is about to change it. */
export async function findEventWithVenue(db: Queryable, eventId: string): Promise<EventWithVenue | null> {
  const result = await db.query<EventRow & { venue_name: string; venue_city: string | null }>(
    `SELECT e.*, v.name AS venue_name, v.city AS venue_city
     FROM events e
     JOIN venues v ON v.id = e.venue_id
     WHERE e.id = $1`,
    [eventId],
  );

  const row = result.rows[0];
  return row ? { event: toEventRecord(row), venueName: row.venue_name, venueCity: row.venue_city } : null;
}

/** How many of an event's seats are still available - used only where a bare count is enough (the publish guard). */
export async function countAvailableSeats(db: Queryable, eventId: string): Promise<number> {
  const result = await db.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM show_seats WHERE event_id = $1 AND status = 'available'`,
    [eventId],
  );
  return Number(result.rows[0]!.count);
}

/**
 * Just the organiser id of an event, unlocked - for a read-only "does this
 * caller own this event?" check (the organiser dashboard's summary/bookings
 * views) that has no business taking `lockEventForOwnership`'s row lock,
 * since nothing there is about to change the row.
 */
export async function findEventOwnerId(db: Queryable, eventId: string): Promise<string | null> {
  const result = await db.query<{ organiser_id: string }>('SELECT organiser_id FROM events WHERE id = $1', [
    eventId,
  ]);
  return result.rows[0]?.organiser_id ?? null;
}

export interface SeatInventorySummary {
  available: number;
  held: number;
  booked: number;
}

/** Seat counts by status for one event - the dashboard's "seats sold"/"available seats" numbers, computed by PostgreSQL. */
export async function getSeatInventorySummary(db: Queryable, eventId: string): Promise<SeatInventorySummary> {
  const result = await db.query<{ available: string; held: string; booked: string }>(
    `SELECT
       count(*) FILTER (WHERE status = 'available')::text AS available,
       count(*) FILTER (WHERE status = 'held')::text AS held,
       count(*) FILTER (WHERE status = 'booked')::text AS booked
     FROM show_seats
     WHERE event_id = $1`,
    [eventId],
  );
  const row = result.rows[0]!;
  return { available: Number(row.available), held: Number(row.held), booked: Number(row.booked) };
}

export interface SeatSummary {
  availableSeats: number;
  /** The lowest price among currently available seats, or null if none are available. */
  startingPrice: string | null;
}

const EMPTY_SEAT_SUMMARY: SeatSummary = { availableSeats: 0, startingPrice: null };

/**
 * Availability and starting price for a whole page of events, in one
 * statement.
 *
 * Used everywhere an event view is built instead of one query per row: a
 * page of, say, 20 events must not become 20 round trips to fill in two
 * summary numbers. Events with no available seats (or no seats at all) are
 * simply absent from the result and read back as the zero/null default.
 *
 * `MIN(price)` is computed by PostgreSQL over the NUMERIC column and read
 * back as the string PostgreSQL returns - never summed, divided or otherwise
 * touched by JavaScript arithmetic.
 */
export async function getSeatSummaryForEvents(
  db: Queryable,
  eventIds: readonly string[],
): Promise<Map<string, SeatSummary>> {
  if (eventIds.length === 0) {
    return new Map();
  }

  const result = await db.query<{ event_id: string; count: string; min_price: string | null }>(
    `SELECT event_id, count(*)::text AS count, min(price)::text AS min_price
     FROM show_seats
     WHERE event_id = ANY($1::uuid[]) AND status = 'available'
     GROUP BY event_id`,
    [eventIds],
  );

  return new Map(
    result.rows.map((row) => [
      row.event_id,
      { availableSeats: Number(row.count), startingPrice: row.min_price },
    ]),
  );
}

/** Convenience wrapper over {@link getSeatSummaryForEvents} for a single event. */
export async function getSeatSummaryForEvent(db: Queryable, eventId: string): Promise<SeatSummary> {
  const summaries = await getSeatSummaryForEvents(db, [eventId]);
  return summaries.get(eventId) ?? EMPTY_SEAT_SUMMARY;
}

export interface LockedEvent {
  organiserId: string;
  venueId: string;
  status: EventStatus;
}

/**
 * Locks the event and reports what every mutating operation - update,
 * publish, delete - needs to judge it: who owns it, and its current state.
 *
 * Taken first in every one of those paths, which is what makes them serialise
 * against each other rather than racing - see event.service.ts for the full
 * lock-order discussion.
 */
export async function lockEventForOwnership(db: Queryable, eventId: string): Promise<LockedEvent | null> {
  const result = await db.query<{ organiser_id: string; venue_id: string; status: EventStatus }>(
    `SELECT organiser_id, venue_id, status FROM events WHERE id = $1 FOR UPDATE`,
    [eventId],
  );

  const row = result.rows[0];
  return row ? { organiserId: row.organiser_id, venueId: row.venue_id, status: row.status } : null;
}

export interface EventFieldUpdate {
  title?: string | undefined;
  description?: string | undefined;
  category?: EventCategory | undefined;
  startsAt?: Date | undefined;
  endsAt?: Date | undefined;
}

/**
 * Updates only the fields actually supplied, in one statement.
 *
 * Built as `COALESCE(new, existing)` per column rather than a dynamically
 * assembled SET list: the parameter count and the SQL text are then fixed and
 * reviewable, and an absent field genuinely means "leave this column alone"
 * rather than "set it to null".
 *
 * No `organiser_id` in the WHERE clause: by the time this runs, the caller has
 * already locked the row with `lockEventForOwnership` and made the
 * owner-or-admin decision under that lock, in application code - the same
 * division of labour `issueTicketsInTransaction` uses. Re-encoding ownership
 * here would not add safety, only a second place for it to drift from the
 * first.
 */
export async function updateEventFields(
  db: Queryable,
  eventId: string,
  patch: EventFieldUpdate,
): Promise<EventRecord | null> {
  const result = await db.query<EventRow>(
    `UPDATE events
     SET title = COALESCE($2, title),
         description = COALESCE($3, description),
         category = COALESCE($4, category),
         starts_at = COALESCE($5, starts_at),
         ends_at = COALESCE($6, ends_at)
     WHERE id = $1
     RETURNING *`,
    [
      eventId,
      patch.title ?? null,
      patch.description ?? null,
      patch.category ?? null,
      patch.startsAt ?? null,
      patch.endsAt ?? null,
    ],
  );

  const row = result.rows[0];
  return row ? toEventRecord(row) : null;
}

/**
 * The guarded transition `draft` -> `published`. Guarded on `status = 'draft'`
 * so it can only ever fire once; a second call, from anyone, changes zero rows
 * - see `publishEventInTransaction` for how the caller tells that apart from
 * "not found" or "not yours".
 */
export async function markEventPublished(db: Queryable, eventId: string): Promise<EventRecord | null> {
  const result = await db.query<EventRow>(
    `UPDATE events SET status = 'published' WHERE id = $1 AND status = 'draft' RETURNING *`,
    [eventId],
  );
  const row = result.rows[0];
  return row ? toEventRecord(row) : null;
}

/**
 * Whether this event has ever had any real activity: a hold or a booking.
 *
 * This is the line between a pristine draft - safe to delete outright - and
 * an event with history, which `deleteEventInTransaction` refuses to remove.
 * Both halves of the OR read from an indexed, event-scoped predicate
 * (`reservation_holds_event_id_status_idx`, `bookings_event_id_idx`), so this
 * is two indexed existence checks, not a scan of either table.
 */
export async function hasEventHistory(db: Queryable, eventId: string): Promise<boolean> {
  const result = await db.query<{ has_history: boolean }>(
    `SELECT
       EXISTS (SELECT 1 FROM bookings WHERE event_id = $1)
       OR EXISTS (SELECT 1 FROM reservation_holds WHERE event_id = $1)
       AS has_history`,
    [eventId],
  );
  return result.rows[0]!.has_history;
}

/** Deletes the event, cascading its show_seats. Returns whether a row existed. */
export async function deleteEventRow(db: Queryable, eventId: string): Promise<boolean> {
  const result = await db.query('DELETE FROM events WHERE id = $1', [eventId]);
  return (result.rowCount ?? 0) > 0;
}

export interface OrganiserDashboardTotals {
  upcomingEvents: number;
  totalBookings: number;
  seatsSold: number;
  availableSeats: number;
  revenue: string;
}

/**
 * The organiser dashboard's headline numbers, aggregated across every event
 * the caller owns (or, for an admin with `all=true`, every event) in three
 * indexed queries - never a page of events fetched and summed in JavaScript.
 *
 * Revenue is summed across whatever currencies those events happen to use;
 * this system has no multi-currency conversion anywhere, so the figure is
 * only meaningful when an organiser's events share one currency, same as
 * every other unconverted total in this codebase.
 */
export async function getOrganiserDashboardTotals(
  db: Queryable,
  organiserId: string | null,
): Promise<OrganiserDashboardTotals> {
  const scoped = organiserId !== null;
  const params = scoped ? [organiserId] : [];

  const upcomingResult = await db.query<{ count: string }>(
    scoped
      ? `SELECT count(*)::text AS count FROM events WHERE organiser_id = $1 AND status = 'published' AND starts_at > now()`
      : `SELECT count(*)::text AS count FROM events WHERE status = 'published' AND starts_at > now()`,
    params,
  );

  const bookingResult = await db.query<{ total_bookings: string; revenue: string }>(
    scoped
      ? `SELECT count(*)::text AS total_bookings, COALESCE(SUM(b.total_amount), 0)::text AS revenue
         FROM bookings b
         JOIN events e ON e.id = b.event_id
         WHERE e.organiser_id = $1 AND b.status = 'confirmed'`
      : `SELECT count(*)::text AS total_bookings, COALESCE(SUM(total_amount), 0)::text AS revenue
         FROM bookings
         WHERE status = 'confirmed'`,
    params,
  );

  const seatResult = await db.query<{ available: string; booked: string }>(
    scoped
      ? `SELECT
           count(*) FILTER (WHERE ss.status = 'available')::text AS available,
           count(*) FILTER (WHERE ss.status = 'booked')::text AS booked
         FROM show_seats ss
         JOIN events e ON e.id = ss.event_id
         WHERE e.organiser_id = $1`
      : `SELECT
           count(*) FILTER (WHERE status = 'available')::text AS available,
           count(*) FILTER (WHERE status = 'booked')::text AS booked
         FROM show_seats`,
    params,
  );

  return {
    upcomingEvents: Number(upcomingResult.rows[0]!.count),
    totalBookings: Number(bookingResult.rows[0]!.total_bookings),
    revenue: bookingResult.rows[0]!.revenue,
    availableSeats: Number(seatResult.rows[0]!.available),
    seatsSold: Number(seatResult.rows[0]!.booked),
  };
}

export interface ListEventsPage {
  /** Scopes the listing to one organiser's events; null lists every organiser's (admin only). */
  organiserId: string | null;
  page: number;
  limit: number;
}

/** Total events matching a listing's scope - the denominator for pagination. */
export async function countEventsForListing(db: Queryable, organiserId: string | null): Promise<number> {
  const result = await db.query<{ count: string }>(
    organiserId === null
      ? 'SELECT count(*)::text AS count FROM events'
      : 'SELECT count(*)::text AS count FROM events WHERE organiser_id = $1',
    organiserId === null ? [] : [organiserId],
  );
  return Number(result.rows[0]!.count);
}

/**
 * One page of events with their venue name, newest first, filtered
 * server-side by `organiser_id` when the listing is scoped to one organiser -
 * never fetched wholesale and filtered in JavaScript.
 *
 * `events_organiser_id_idx` already answers the scoped `WHERE`; ordering and
 * pagination are then applied over that filtered set. See event.service.ts
 * for the EXPLAIN finding behind not adding a composite index for this.
 */
export async function listEventsPage(
  db: Queryable,
  { organiserId, page, limit }: ListEventsPage,
): Promise<EventWithVenue[]> {
  const offset = (page - 1) * limit;

  const result = await db.query<EventRow & { venue_name: string; venue_city: string | null }>(
    organiserId === null
      ? `SELECT e.*, v.name AS venue_name, v.city AS venue_city
         FROM events e
         JOIN venues v ON v.id = e.venue_id
         ORDER BY e.created_at DESC, e.id DESC
         LIMIT $1 OFFSET $2`
      : `SELECT e.*, v.name AS venue_name, v.city AS venue_city
         FROM events e
         JOIN venues v ON v.id = e.venue_id
         WHERE e.organiser_id = $1
         ORDER BY e.created_at DESC, e.id DESC
         LIMIT $2 OFFSET $3`,
    organiserId === null ? [limit, offset] : [organiserId, limit, offset],
  );

  return result.rows.map((row) => ({
    event: toEventRecord(row),
    venueName: row.venue_name,
    venueCity: row.venue_city,
  }));
}

// ---------------------------------------------------------------------------
// Public discovery: GET /api/v1/events
// ---------------------------------------------------------------------------

/**
 * The entire sort surface, fixed at compile time.
 *
 * This is what "never accept raw SQL through `sort`" actually means in code:
 * the API's `sort` value is used only as a *key into this object*, and every
 * value it can produce is a hand-written literal that never touches user
 * input. `keyColumn` is what the keyset predicate compares against; `castKey`
 * says how to turn a cursor's string `key` back into the right bound
 * parameter type for that column.
 */
const SORT_CONFIG: Record<
  EventSortMode,
  { orderBy: string; keyColumn: string; direction: 'ASC' | 'DESC'; castKey: (key: string) => string | Date }
> = {
  start_asc: {
    orderBy: 'e.starts_at ASC, e.id ASC',
    keyColumn: 'e.starts_at',
    direction: 'ASC',
    castKey: (key) => new Date(key),
  },
  start_desc: {
    orderBy: 'e.starts_at DESC, e.id DESC',
    keyColumn: 'e.starts_at',
    direction: 'DESC',
    castKey: (key) => new Date(key),
  },
  name_asc: {
    orderBy: 'e.title ASC, e.id ASC',
    keyColumn: 'e.title',
    direction: 'ASC',
    castKey: (key) => key,
  },
  name_desc: {
    orderBy: 'e.title DESC, e.id DESC',
    keyColumn: 'e.title',
    direction: 'DESC',
    castKey: (key) => key,
  },
};

export interface PublicEventFilters {
  q?: string | undefined;
  category?: EventCategory | undefined;
  eventType?: EventType | undefined;
  city?: string | undefined;
  venueId?: string | undefined;
  startFrom?: Date | undefined;
  startTo?: Date | undefined;
}

export interface PublicEventQuery {
  filters: PublicEventFilters;
  sort: EventSortMode;
  /** One page's worth *plus one* - see event.service.ts's `hasMore` detection. */
  fetchLimit: number;
  cursor: { key: string; id: string } | null;
}

/**
 * The public discovery query: one statement, every filter a bound parameter,
 * `sort` resolved only through {@link SORT_CONFIG}.
 *
 * VISIBILITY IS A SQL PREDICATE, NOT A JAVASCRIPT FILTER. `status <> 'draft'`
 * is unconditional - the first condition, always present, never optional -
 * so there is no code path through this function that can return a draft
 * event. This is deliberate: "fetch everything, filter afterwards" would mean
 * a bug in the filtering step leaks a draft; a predicate that is always part
 * of the WHERE clause cannot be bypassed by forgetting to call something.
 *
 * `status <> 'draft'`, not `status = 'published'`: this list mirrors
 * `getEventById`'s existing rule (only `draft` is hidden) for consistency
 * with the model already established for the single-event endpoint, rather
 * than inventing a stricter one - see the final report.
 *
 * TEXT SEARCH is two independent conditions, OR'd: the generated
 * `search_vector` column (title/category/description, GIN-indexed) for the
 * fields that live on `events`, and a plain `ILIKE` against `venues.name` for
 * the one field that does not. Folding venue name into the same tsvector
 * would mean denormalising it onto `events` and keeping it in sync with a
 * trigger every time a venue is renamed - real, ongoing complexity - for a
 * table (`venues`) small enough that `ILIKE` over it, joined in, costs
 * nothing at any realistic scale. See the migration and the final report for
 * the full comparison against trigram search.
 *
 * PREFIX MATCHING, NOT `websearch_to_tsquery` ALONE. `websearch_to_tsquery`
 * only ever matches complete (stemmed) lexemes: searching "inter" against a
 * title of "Interstellar" is `false`, because "inter" and "interstellar" are
 * two different lexemes to the English dictionary - a query is not
 * meaningfully searchable while a customer has to finish typing every word.
 * The subquery below tokenises and stems the caller's search text the same
 * way `to_tsvector` would (so "Journey" and "journeys" still normalise the
 * same), then re-joins those lexemes into a `:*`-suffixed, `&`-separated
 * prefix query - the standard construction for "search-as-you-type" over
 * `tsvector`.
 *
 * THE REASSEMBLY MUST BE `::tsquery`, NEVER `to_tsquery(config, text)`.
 * `to_tsquery` re-runs its argument through the *same tokeniser and
 * dictionary pipeline* `to_tsvector` uses, on every lexeme, even one already
 * extracted from a tsvector - so a lexeme containing a hyphen (a UUID
 * fragment in a title, a compound word) gets re-split into a `<->` phrase
 * of sub-lexemes instead of staying the one atomic token it already was.
 * That silently drops real matches: PostgreSQL's parser resolves a
 * hyphenated span like "2fe0-437b" into non-obvious sub-tokens - which
 * digit/letter boundary looks numeric to it is undocumented and
 * inconsistent - so a lexeme this codebase's own tokenisation already
 * produced can come back different, or missing, on the second pass. Casting
 * a `'lexeme':*`-shaped string straight to `::tsquery` uses tsquery's
 * external *input* syntax instead: a single-quoted span is taken as one
 * already-finished lexeme, verbatim, with no further tokenising or
 * stemming. `quote_literal` is what produces that single-quoted, correctly
 * '' - escaped span - the same escaping convention tsquery's own syntax
 * uses - so nothing here is ever concatenated into a query string
 * PostgreSQL parses as SQL or as a raw search string, and a caller cannot
 * smuggle tsquery syntax through `q`.
 *
 * A `q` that is entirely stop words (`the`, `a`, ...) reduces to zero
 * lexemes, `string_agg` returns `NULL`, and `NULL::tsquery` is `NULL`, so
 * `@@ NULL` is `NULL` (never a match, never an error) - the same "no
 * full-text match" outcome `websearch_to_tsquery` already produced for that
 * case, so this is not a behaviour change for a query that was already
 * unsearchable.
 */
export async function findPublicEventsPage(
  db: Queryable,
  { filters, sort, fetchLimit, cursor }: PublicEventQuery,
): Promise<EventWithVenue[]> {
  const config = SORT_CONFIG[sort];
  const conditions: string[] = [`e.status <> 'draft'`];
  const params: unknown[] = [];

  function bind(value: unknown): number {
    params.push(value);
    return params.length;
  }

  if (filters.category !== undefined) {
    conditions.push(`e.category = $${bind(filters.category)}`);
  }
  if (filters.eventType !== undefined) {
    conditions.push(`e.event_type = $${bind(filters.eventType)}`);
  }
  if (filters.venueId !== undefined) {
    conditions.push(`e.venue_id = $${bind(filters.venueId)}`);
  }
  if (filters.city !== undefined) {
    // Exact, case-insensitive match - a city is a filter value a client picks
    // from a list, not free text to search within. See event.service.ts.
    conditions.push(`lower(v.city) = lower($${bind(filters.city)})`);
  }
  if (filters.startFrom !== undefined) {
    conditions.push(`e.starts_at >= $${bind(filters.startFrom)}`);
  }
  if (filters.startTo !== undefined) {
    conditions.push(`e.starts_at <= $${bind(filters.startTo)}`);
  }
  if (filters.q !== undefined) {
    const qParam = bind(filters.q);
    const likeParam = bind(`%${filters.q}%`);
    conditions.push(
      `(e.search_vector @@ (
         SELECT string_agg(quote_literal(lexeme) || ':*', ' & ')::tsquery
         FROM unnest(tsvector_to_array(to_tsvector('english', $${qParam}))) AS lexeme
       ) OR v.name ILIKE $${likeParam})`,
    );
  }

  if (cursor !== null) {
    const keyParam = bind(config.castKey(cursor.key));
    const idParam = bind(cursor.id);
    const op = config.direction === 'ASC' ? '>' : '<';
    // Standard keyset predicate: strictly past the last row of the previous
    // page, by the sort's own ordering, with `id` breaking a tie on the
    // primary key exactly the way the `ORDER BY` does.
    conditions.push(
      `(${config.keyColumn} ${op} $${keyParam} OR (${config.keyColumn} = $${keyParam} AND e.id ${op} $${idParam}))`,
    );
  }

  const limitParam = bind(fetchLimit);

  const result = await db.query<EventRow & { venue_name: string; venue_city: string | null }>(
    `SELECT e.*, v.name AS venue_name, v.city AS venue_city
     FROM events e
     JOIN venues v ON v.id = e.venue_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY ${config.orderBy}
     LIMIT $${limitParam}`,
    params,
  );

  return result.rows.map((row) => ({
    event: toEventRecord(row),
    venueName: row.venue_name,
    venueCity: row.venue_city,
  }));
}
