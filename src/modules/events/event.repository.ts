import type { Queryable } from '../../db/pool.js';
import type { CreateEventInput, EventRecord, EventStatus, EventType } from './event.types.js';

interface EventRow {
  id: string;
  organiser_id: string;
  venue_id: string;
  title: string;
  description: string | null;
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
    eventType: row.event_type,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    status: row.status,
    currency: row.currency,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function insertEvent(db: Queryable, input: CreateEventInput): Promise<EventRecord> {
  const result = await db.query<EventRow>(
    `INSERT INTO events (organiser_id, venue_id, title, description, event_type, starts_at, ends_at, status, currency)
     VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, 'draft'), COALESCE($9, 'INR'))
     RETURNING *`,
    [
      input.organiserId,
      input.venueId,
      input.title,
      input.description ?? null,
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

/** An event joined with the one venue field the public view needs: its name. */
export interface EventWithVenueName {
  event: EventRecord;
  venueName: string;
}

/** Unlocked read for the public/private GET - nothing here is about to change it. */
export async function findEventWithVenueName(
  db: Queryable,
  eventId: string,
): Promise<EventWithVenueName | null> {
  const result = await db.query<EventRow & { venue_name: string }>(
    `SELECT e.*, v.name AS venue_name
     FROM events e
     JOIN venues v ON v.id = e.venue_id
     WHERE e.id = $1`,
    [eventId],
  );

  const row = result.rows[0];
  return row ? { event: toEventRecord(row), venueName: row.venue_name } : null;
}

/** How many of an event's seats are still available - the public headline number. */
export async function countAvailableSeats(db: Queryable, eventId: string): Promise<number> {
  const result = await db.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM show_seats WHERE event_id = $1 AND status = 'available'`,
    [eventId],
  );
  return Number(result.rows[0]!.count);
}

/**
 * Available-seat counts for a whole page of events in one statement.
 *
 * Used by the organiser listing instead of one `countAvailableSeats` call per
 * row: a page of, say, 20 events must not become 20 round trips just to fill
 * in a summary number. Events with no available seats (or no seats at all)
 * are simply absent from the result and read back as 0.
 */
export async function countAvailableSeatsForEvents(
  db: Queryable,
  eventIds: readonly string[],
): Promise<Map<string, number>> {
  if (eventIds.length === 0) {
    return new Map();
  }

  const result = await db.query<{ event_id: string; count: string }>(
    `SELECT event_id, count(*)::text AS count
     FROM show_seats
     WHERE event_id = ANY($1::uuid[]) AND status = 'available'
     GROUP BY event_id`,
    [eventIds],
  );

  return new Map(result.rows.map((row) => [row.event_id, Number(row.count)]));
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
         starts_at = COALESCE($4, starts_at),
         ends_at = COALESCE($5, ends_at)
     WHERE id = $1
     RETURNING *`,
    [eventId, patch.title ?? null, patch.description ?? null, patch.startsAt ?? null, patch.endsAt ?? null],
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
): Promise<EventWithVenueName[]> {
  const offset = (page - 1) * limit;

  const result = await db.query<EventRow & { venue_name: string }>(
    organiserId === null
      ? `SELECT e.*, v.name AS venue_name
         FROM events e
         JOIN venues v ON v.id = e.venue_id
         ORDER BY e.created_at DESC, e.id DESC
         LIMIT $1 OFFSET $2`
      : `SELECT e.*, v.name AS venue_name
         FROM events e
         JOIN venues v ON v.id = e.venue_id
         WHERE e.organiser_id = $1
         ORDER BY e.created_at DESC, e.id DESC
         LIMIT $2 OFFSET $3`,
    organiserId === null ? [limit, offset] : [organiserId, limit, offset],
  );

  return result.rows.map((row) => ({ event: toEventRecord(row), venueName: row.venue_name }));
}
