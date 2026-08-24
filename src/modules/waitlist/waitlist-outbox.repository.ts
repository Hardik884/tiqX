import type { Queryable } from '../../db/pool.js';
import type { SeatCategory } from '../events/event.types.js';
import type { WaitlistOfferNotificationPayload } from './waitlist.types.js';

// ---------------------------------------------------------------------------
// waitlist_allocation_outbox
// ---------------------------------------------------------------------------

/**
 * Signals "there may be an allocation opportunity for this event and
 * category", for every distinct (event, category) pair among the given show
 * seats.
 *
 * Called from exactly two places that release a seat to `available`:
 * `cancelBookingInTransaction` and `expireHoldInTransaction`. Both call it
 * with whichever seats they actually released, and both call it inside their
 * own transaction, so the signal is as durable as the release itself - either
 * both commit or neither does. Set-based and generic on purpose: a burst of
 * cancellations naturally coalesces into as many rows as there are distinct
 * categories, never one row per seat, via `ON CONFLICT ... DO NOTHING`
 * against the partial unique index on unprocessed rows.
 */
export async function enqueueWaitlistAllocationForSeats(
  db: Queryable,
  showSeatIds: readonly string[],
): Promise<void> {
  if (showSeatIds.length === 0) {
    return;
  }
  await db.query(
    `INSERT INTO waitlist_allocation_outbox (event_id, seat_category)
     SELECT DISTINCT ss.event_id, vs.category
     FROM show_seats ss
     JOIN venue_seats vs ON vs.id = ss.venue_seat_id
     WHERE ss.id = ANY($1::uuid[])
     ON CONFLICT (event_id, seat_category) WHERE processed_at IS NULL DO NOTHING`,
    [showSeatIds],
  );
}

/** Same signal, from knowing the event and category directly - offer expiry. */
export async function enqueueWaitlistAllocation(
  db: Queryable,
  eventId: string,
  seatCategory: SeatCategory,
): Promise<void> {
  await db.query(
    `INSERT INTO waitlist_allocation_outbox (event_id, seat_category)
     VALUES ($1, $2)
     ON CONFLICT (event_id, seat_category) WHERE processed_at IS NULL DO NOTHING`,
    [eventId, seatCategory],
  );
}

export interface PendingAllocationRow {
  id: string;
  eventId: string;
  seatCategory: SeatCategory;
  attempts: number;
}

/**
 * Claims a batch of unprocessed allocation signals.
 *
 * `FOR UPDATE SKIP LOCKED`, identical in shape and purpose to
 * `claimPendingOutboxRows` in expiration.repository.ts: worker B takes
 * whatever worker A has not claimed, rather than queuing behind it. Because
 * the coalescing index guarantees at most one pending row per (event,
 * category), claiming a row also gives this worker sole ownership of that
 * category's allocation pass for as long as the transaction holds it - see
 * waitlist.service.ts for why that is what keeps FIFO ordering intact under
 * two workers, on top of the per-candidate `SKIP LOCKED` belt-and-braces.
 */
export async function claimPendingAllocations(
  db: Queryable,
  batchSize: number,
): Promise<PendingAllocationRow[]> {
  const result = await db.query<{
    id: string;
    event_id: string;
    seat_category: SeatCategory;
    attempts: number;
  }>(
    `SELECT id, event_id, seat_category, attempts
     FROM waitlist_allocation_outbox
     WHERE processed_at IS NULL AND available_at <= now()
     ORDER BY available_at, created_at
     LIMIT $1
     FOR UPDATE SKIP LOCKED`,
    [batchSize],
  );
  return result.rows.map((row) => ({
    id: row.id,
    eventId: row.event_id,
    seatCategory: row.seat_category,
    attempts: row.attempts,
  }));
}

export async function markAllocationProcessed(db: Queryable, id: string): Promise<void> {
  await db.query(
    `UPDATE waitlist_allocation_outbox SET processed_at = now(), last_error = NULL WHERE id = $1`,
    [id],
  );
}

/** Records a failed pass and backs the row off, mirroring recordOutboxFailure. */
export async function recordAllocationFailure(
  db: Queryable,
  id: string,
  message: string,
  retryBaseMs: number,
  retryMaxMs: number,
): Promise<void> {
  await db.query(
    `UPDATE waitlist_allocation_outbox
     SET attempts = attempts + 1,
         last_error = left($2, 500),
         available_at = now() + make_interval(
           secs => LEAST($4::double precision, $3::double precision * power(2, attempts)) / 1000.0
         )
     WHERE id = $1`,
    [id, message, retryBaseMs, retryMaxMs],
  );
}

/**
 * Self-healing scan: event/category pairs with a waiting candidate and an
 * available seat, but no pending outbox row.
 *
 * Every path that frees a seat also enqueues a signal, so this exists for the
 * same reason `reconcileExpiryKeys` exists for Redis - not because the primary
 * mechanism is expected to lose events, but because "the worker was down when
 * it mattered" and "a row was claimed, marked processed, and the process died
 * before committing the offers it implied" are both real possibilities worth
 * a slow, bounded backstop for. Bounded by `limit`; a busy result means the
 * worker asks again next cycle rather than draining an unbounded scan in one
 * pass.
 */
export async function findCategoriesNeedingAllocation(
  db: Queryable,
  limit: number,
): Promise<{ eventId: string; seatCategory: SeatCategory }[]> {
  const result = await db.query<{ event_id: string; seat_category: SeatCategory }>(
    `SELECT DISTINCT we.event_id, we.seat_category
     FROM waitlist_entries we
     WHERE we.status = 'waiting'
       AND EXISTS (
         SELECT 1 FROM show_seats ss
         JOIN venue_seats vs ON vs.id = ss.venue_seat_id
         WHERE ss.event_id = we.event_id AND vs.category = we.seat_category AND ss.status = 'available'
       )
       AND NOT EXISTS (
         SELECT 1 FROM waitlist_allocation_outbox o
         WHERE o.event_id = we.event_id AND o.seat_category = we.seat_category AND o.processed_at IS NULL
       )
     LIMIT $1`,
    [limit],
  );
  return result.rows.map((row) => ({ eventId: row.event_id, seatCategory: row.seat_category }));
}

/** Pending count for the worker's periodic summary. */
export async function countPendingAllocations(db: Queryable): Promise<number> {
  const result = await db.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM waitlist_allocation_outbox WHERE processed_at IS NULL',
  );
  return Number(result.rows[0]!.count);
}

// ---------------------------------------------------------------------------
// waitlist_notification_outbox
// ---------------------------------------------------------------------------

/**
 * Records "tell this user" durably, in the same transaction as the offer it
 * describes - see the migration's top comment. Nothing consumes this table
 * yet: email is explicitly out of scope for this task, so this is the
 * producer half only.
 */
export async function enqueueOfferNotification(
  db: Queryable,
  offerId: string,
  type: 'WAITLIST_OFFER_CREATED' | 'WAITLIST_OFFER_EXPIRED',
  payload: WaitlistOfferNotificationPayload,
): Promise<void> {
  await db.query(
    `INSERT INTO waitlist_notification_outbox (offer_id, type, payload)
     VALUES ($1, $2, $3::jsonb)`,
    [offerId, type, JSON.stringify(payload)],
  );
}

export interface NotificationRow {
  id: string;
  offerId: string;
  type: string;
  payload: WaitlistOfferNotificationPayload;
}

/** For tests proving outbox atomicity - no consumer reads this in production yet. */
export async function findNotificationsForOffer(
  db: Queryable,
  offerId: string,
): Promise<NotificationRow[]> {
  const result = await db.query<{ id: string; offer_id: string; type: string; payload: WaitlistOfferNotificationPayload }>(
    'SELECT id, offer_id, type, payload FROM waitlist_notification_outbox WHERE offer_id = $1 ORDER BY created_at',
    [offerId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    offerId: row.offer_id,
    type: row.type,
    payload: row.payload,
  }));
}
