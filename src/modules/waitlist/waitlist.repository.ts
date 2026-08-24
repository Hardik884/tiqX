import type { Queryable } from '../../db/pool.js';
import type { SeatCategory } from '../events/event.types.js';
import type {
  WaitlistEntryRecord,
  WaitlistEntryStatus,
  WaitlistOfferRecord,
  WaitlistOfferStatus,
} from './waitlist.types.js';

interface WaitlistEntryRow {
  id: string;
  event_id: string;
  user_id: string;
  seat_category: SeatCategory;
  status: WaitlistEntryStatus;
  joined_at: Date;
  updated_at: Date;
}

function toEntryRecord(row: WaitlistEntryRow): WaitlistEntryRecord {
  return {
    id: row.id,
    eventId: row.event_id,
    userId: row.user_id,
    seatCategory: row.seat_category,
    status: row.status,
    joinedAt: row.joined_at,
    updatedAt: row.updated_at,
  };
}

interface WaitlistOfferRow {
  id: string;
  waitlist_entry_id: string;
  show_seat_id: string;
  hold_id: string;
  expires_at: Date;
  status: WaitlistOfferStatus;
  created_at: Date;
  accepted_at: Date | null;
  expired_at: Date | null;
}

function toOfferRecord(row: WaitlistOfferRow): WaitlistOfferRecord {
  return {
    id: row.id,
    waitlistEntryId: row.waitlist_entry_id,
    showSeatId: row.show_seat_id,
    holdId: row.hold_id,
    expiresAt: row.expires_at,
    status: row.status,
    createdAt: row.created_at,
    acceptedAt: row.accepted_at,
    expiredAt: row.expired_at,
  };
}

// ---------------------------------------------------------------------------
// Availability - read for the join decision and the allocation pass
// ---------------------------------------------------------------------------

/** Whether the venue behind this event has any seat of the given category. */
export async function categoryExistsForEvent(
  db: Queryable,
  eventId: string,
  seatCategory: SeatCategory,
): Promise<boolean> {
  const result = await db.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM show_seats ss
       JOIN venue_seats vs ON vs.id = ss.venue_seat_id
       WHERE ss.event_id = $1 AND vs.category = $2
     ) AS exists`,
    [eventId, seatCategory],
  );
  return result.rows[0]!.exists;
}

/**
 * How many seats of this category are sellable right now.
 *
 * Unlocked, and deliberately so: this answers "does joining make sense?", not
 * "reserve me a seat". A seat freed by another transaction a moment after this
 * count runs is not a bug to close - see the migration's note on why the
 * allocation signal is "event + category", not "this seat".
 */
export async function countAvailableSeatsForCategory(
  db: Queryable,
  eventId: string,
  seatCategory: SeatCategory,
): Promise<number> {
  const result = await db.query<{ count: string }>(
    `SELECT count(*)::text AS count
     FROM show_seats ss
     JOIN venue_seats vs ON vs.id = ss.venue_seat_id
     WHERE ss.event_id = $1 AND vs.category = $2 AND ss.status = 'available'`,
    [eventId, seatCategory],
  );
  return Number(result.rows[0]!.count);
}

/**
 * The next available seats of a category, ascending by id - the deterministic
 * order allocation hands them out in. Unlocked: the allocation pass re-reads
 * this fresh on every loop iteration, and the actual claim is a blocking
 * `FOR UPDATE` taken inside `createHoldInTransaction`, not here.
 */
export async function findAvailableSeatIdsForCategory(
  db: Queryable,
  eventId: string,
  seatCategory: SeatCategory,
  limit: number,
): Promise<string[]> {
  const result = await db.query<{ id: string }>(
    `SELECT ss.id
     FROM show_seats ss
     JOIN venue_seats vs ON vs.id = ss.venue_seat_id
     WHERE ss.event_id = $1 AND vs.category = $2 AND ss.status = 'available'
     ORDER BY ss.id
     LIMIT $3`,
    [eventId, seatCategory, limit],
  );
  return result.rows.map((row) => row.id);
}

// ---------------------------------------------------------------------------
// waitlist_entries
// ---------------------------------------------------------------------------

/**
 * Joins the queue. A plain INSERT, not `ON CONFLICT DO NOTHING`: the caller
 * needs to tell "you joined" from "you were already active" apart to answer
 * correctly, and a duplicate here is the exception, not the common case
 * idempotency retries produce. See waitlist.service.ts for how the unique
 * violation on `waitlist_entries_active_membership_key` is turned into a
 * clean 409 rather than a 500.
 */
export async function insertWaitlistEntry(
  db: Queryable,
  input: { eventId: string; userId: string; seatCategory: SeatCategory },
): Promise<WaitlistEntryRecord> {
  const result = await db.query<WaitlistEntryRow>(
    `INSERT INTO waitlist_entries (event_id, user_id, seat_category, status)
     VALUES ($1, $2, $3, 'waiting')
     RETURNING *`,
    [input.eventId, input.userId, input.seatCategory],
  );
  return toEntryRecord(result.rows[0]!);
}

export async function findWaitlistEntryById(
  db: Queryable,
  entryId: string,
): Promise<WaitlistEntryRecord | null> {
  const result = await db.query<WaitlistEntryRow>('SELECT * FROM waitlist_entries WHERE id = $1', [
    entryId,
  ]);
  const row = result.rows[0];
  return row ? toEntryRecord(row) : null;
}

/**
 * Leaving the queue, guarded on `status = 'waiting'`. An entry that has
 * already been offered a seat cannot leave through this path - accepting or
 * letting the offer lapse are the only two ways out from there - and a second
 * `leave` call changes zero rows, exactly like a second booking cancellation.
 */
export async function markEntryCancelled(
  db: Queryable,
  entryId: string,
  userId: string,
): Promise<WaitlistEntryRecord | null> {
  const result = await db.query<WaitlistEntryRow>(
    `UPDATE waitlist_entries
     SET status = 'cancelled'
     WHERE id = $1 AND user_id = $2 AND status = 'waiting'
     RETURNING *`,
    [entryId, userId],
  );
  const row = result.rows[0];
  return row ? toEntryRecord(row) : null;
}

/**
 * Claims the next candidate in FIFO order for one event and category.
 *
 * `FOR UPDATE SKIP LOCKED` is deliberate here, unlike the seat lock the caller
 * takes next: a candidate already locked by a concurrent allocation pass for
 * the *same* category (the outbox's coalescing index makes this rare, but
 * does not make it impossible - see waitlist.service.ts) is simply not this
 * pass's to offer, and skipping it costs nothing. The seat itself is never
 * skip-locked - see `createHoldInTransaction` - because silently abandoning a
 * specific seat is a different kind of mistake than silently deferring to
 * another worker on a queue position.
 */
export async function lockNextWaitingEntry(
  db: Queryable,
  eventId: string,
  seatCategory: SeatCategory,
): Promise<WaitlistEntryRecord | null> {
  const result = await db.query<WaitlistEntryRow>(
    `SELECT *
     FROM waitlist_entries
     WHERE event_id = $1 AND seat_category = $2 AND status = 'waiting'
     ORDER BY joined_at, id
     FOR UPDATE SKIP LOCKED
     LIMIT 1`,
    [eventId, seatCategory],
  );
  const row = result.rows[0];
  return row ? toEntryRecord(row) : null;
}

/** Transitions the locked candidate to `offered`. Guarded belt-and-braces. */
export async function markEntryOffered(db: Queryable, entryId: string): Promise<boolean> {
  const result = await db.query(
    `UPDATE waitlist_entries SET status = 'offered' WHERE id = $1 AND status = 'waiting'`,
    [entryId],
  );
  return (result.rowCount ?? 0) > 0;
}

/** Transitions an offered entry to `accepted`. */
export async function markEntryAccepted(db: Queryable, entryId: string): Promise<boolean> {
  const result = await db.query(
    `UPDATE waitlist_entries SET status = 'accepted' WHERE id = $1 AND status = 'offered'`,
    [entryId],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Transitions an offered entry to `expired`. Terminal, deliberately: a
 * customer whose offer lapsed does not go back to `waiting` and re-queue at
 * the front of a line they already had their turn at - they are done, and the
 * next candidate gets the next offer. Joining again starts a fresh entry.
 */
export async function markEntryExpired(db: Queryable, entryId: string): Promise<boolean> {
  const result = await db.query(
    `UPDATE waitlist_entries SET status = 'expired' WHERE id = $1 AND status = 'offered'`,
    [entryId],
  );
  return (result.rowCount ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// waitlist_offers
// ---------------------------------------------------------------------------

export async function insertWaitlistOffer(
  db: Queryable,
  input: { waitlistEntryId: string; showSeatId: string; holdId: string },
): Promise<WaitlistOfferRecord> {
  const result = await db.query<WaitlistOfferRow>(
    `INSERT INTO waitlist_offers (waitlist_entry_id, show_seat_id, hold_id, expires_at, status)
     SELECT $1, $2, $3, h.expires_at, 'offered'
     FROM reservation_holds h
     WHERE h.id = $3
     RETURNING *`,
    [input.waitlistEntryId, input.showSeatId, input.holdId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error('INSERT INTO waitlist_offers returned no row');
  }
  return toOfferRecord(row);
}

export interface OfferForAcceptance {
  offer: WaitlistOfferRecord;
  entryUserId: string;
  eventId: string;
}

/**
 * The offer joined with what acceptance needs to judge ownership and reach
 * the backing hold's event - a plain read, not a lock. The authoritative
 * check is the one `confirmHoldInTransaction` makes under its own locks; this
 * exists only to answer "is this even this caller's offer?" cheaply and
 * honestly before attempting the real work. See waitlist.service.ts.
 */
export async function findOfferForAcceptance(
  db: Queryable,
  offerId: string,
): Promise<OfferForAcceptance | null> {
  const result = await db.query<WaitlistOfferRow & { entry_user_id: string; event_id: string }>(
    `SELECT o.*, e.user_id AS entry_user_id, h.event_id
     FROM waitlist_offers o
     JOIN waitlist_entries e ON e.id = o.waitlist_entry_id
     JOIN reservation_holds h ON h.id = o.hold_id
     WHERE o.id = $1`,
    [offerId],
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return { offer: toOfferRecord(row), entryUserId: row.entry_user_id, eventId: row.event_id };
}

/**
 * Transitions `offered` -> `accepted`, guarded, and only ever called after
 * `confirmHoldInTransaction` has already converted the backing hold into a
 * booking within the same transaction - see waitlist.service.ts for why this
 * ordering is what keeps acceptance and expiry from being able to deadlock.
 */
export async function markOfferAccepted(db: Queryable, offerId: string): Promise<WaitlistOfferRecord | null> {
  const result = await db.query<WaitlistOfferRow>(
    `UPDATE waitlist_offers
     SET status = 'accepted', accepted_at = now()
     WHERE id = $1 AND status = 'offered'
     RETURNING *`,
    [offerId],
  );
  const row = result.rows[0];
  return row ? toOfferRecord(row) : null;
}

/**
 * Transitions `offered` -> `expired` for whichever offer is backed by this
 * hold, guarded. Bookkeeping only - the seat's release and the next
 * allocation signal are both handled generically by
 * `enqueueWaitlistAllocationForSeats` regardless of whether the hold being
 * expired happened to back an offer, so this function's only job is to keep
 * the waitlist's own state honest about what happened to *this* entry's
 * offer specifically.
 *
 * Called from expiration.service.ts, after the hold itself has already been
 * expired and its seat released in the same transaction - see the migration's
 * top comment for why an offer's expiry rides the existing hold sweep instead
 * of a second one. A hold with no offer (the ordinary case - most expired
 * holds were never a waitlist offer) simply matches no row here, which is not
 * an error.
 */
export async function markOfferExpiredByHoldId(
  db: Queryable,
  holdId: string,
): Promise<WaitlistOfferRecord | null> {
  const result = await db.query<WaitlistOfferRow>(
    `UPDATE waitlist_offers
     SET status = 'expired', expired_at = now()
     WHERE hold_id = $1 AND status = 'offered'
     RETURNING *`,
    [holdId],
  );
  const row = result.rows[0];
  return row ? toOfferRecord(row) : null;
}
