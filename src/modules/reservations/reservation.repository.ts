import type { Queryable } from '../../db/pool.js';
import type { ShowSeatStatus } from '../seats/show-seat.types.js';

interface IdRow {
  id: string;
}

export interface LockedSeatRow {
  id: string;
  status: ShowSeatStatus;
}

export interface SeatAvailabilityRow {
  id: string;
  status: ShowSeatStatus;
  /** True when some unexpired active hold still covers this seat. */
  liveHold: boolean;
}

export interface InsertedHoldRow {
  id: string;
  expiresAt: Date;
}

export async function eventExists(db: Queryable, eventId: string): Promise<boolean> {
  const result = await db.query<IdRow>('SELECT id FROM events WHERE id = $1', [eventId]);
  return result.rowCount === 1;
}

export async function userExists(db: Queryable, userId: string): Promise<boolean> {
  const result = await db.query<IdRow>('SELECT id FROM users WHERE id = $1', [userId]);
  return result.rowCount === 1;
}

/**
 * Takes a row-level write lock on each requested seat *of this event*, and
 * returns the rows it locked.
 *
 * This single statement is the concurrency primitive of the whole reservation
 * engine, and it does three jobs at once:
 *
 *  1. `FOR UPDATE` blocks any other transaction that tries to lock the same
 *     seat until this one commits or rolls back. Every path that hands out a
 *     seat starts here, so competing requests are serialised on the seat rows
 *     themselves - PostgreSQL, not the application, decides who wins.
 *  2. `ORDER BY ss.id` fixes the order locks are taken in. Two requests for
 *     overlapping seats therefore queue in the same direction and cannot form
 *     the cycle a deadlock needs. `EXPLAIN` confirms the plan puts `LockRows`
 *     above `Sort`, so rows really are locked in sorted order rather than
 *     locked first and sorted afterwards.
 *  3. `event_id = $2` is the ownership check: a seat id belonging to another
 *     event simply does not come back, so a client cannot reach across events.
 *     Never trust the client's seat list to match the event in the URL.
 *
 * A returned row's `status` is the value visible *after* the lock was granted:
 * if a competing transaction committed while we waited, we observe its result,
 * not the stale value we would have read before blocking.
 */
export async function lockEventSeats(
  db: Queryable,
  eventId: string,
  showSeatIds: readonly string[],
): Promise<LockedSeatRow[]> {
  const result = await db.query<LockedSeatRow>(
    `SELECT ss.id, ss.status
     FROM show_seats ss
     WHERE ss.id = ANY($1::uuid[]) AND ss.event_id = $2
     ORDER BY ss.id
     FOR UPDATE`,
    [showSeatIds, eventId],
  );
  return result.rows;
}

/** Which of these seat ids exist at all, ignoring which event they belong to. */
export async function findExistingSeatIds(
  db: Queryable,
  showSeatIds: readonly string[],
): Promise<string[]> {
  const result = await db.query<IdRow>('SELECT id FROM show_seats WHERE id = ANY($1::uuid[])', [
    showSeatIds,
  ]);
  return result.rows.map((row) => row.id);
}

/**
 * Marks every hold covering one of these seats as `expired` if its time is up.
 *
 * A hold does not expire itself: nothing rewrites the row when the clock passes
 * `expires_at`, so the row still reads `active` long after it stopped meaning
 * anything. Whoever next wants the seat performs the transition, which is why
 * reclamation is correct without a background worker - the worker will only
 * ever be an optimisation that tidies rows nobody asked for.
 *
 * The inner `SELECT ... ORDER BY h.id FOR UPDATE` matters. An `UPDATE` cannot
 * carry an `ORDER BY`, and two transactions holding disjoint seat sets can
 * still meet on a shared old hold (one stale hold may cover seats that two
 * different requests each want a slice of). Locking the hold rows through an
 * ordered sub-select gives that step the same deterministic order the seat
 * lock has, closing the one remaining deadlock window.
 *
 * `expires_at <= now()` is evaluated by PostgreSQL inside this transaction, so
 * a hold that is still alive by the database's clock is never touched.
 */
export async function expireLapsedHoldsForSeats(
  db: Queryable,
  showSeatIds: readonly string[],
): Promise<string[]> {
  const result = await db.query<IdRow>(
    `UPDATE reservation_holds
     SET status = 'expired'
     WHERE id IN (
       SELECT h.id
       FROM reservation_holds h
       WHERE h.id IN (
               SELECT rhs.hold_id
               FROM reservation_hold_seats rhs
               WHERE rhs.show_seat_id = ANY($1::uuid[])
             )
         AND h.status = 'active'
         AND h.expires_at <= now()
       ORDER BY h.id
       FOR UPDATE
     )
     RETURNING id`,
    [showSeatIds],
  );
  return result.rows.map((row) => row.id);
}

/**
 * Returns a seat to `available` when it is flagged `held` but no unexpired
 * active hold covers it any more - the seat-side half of reclaiming a lapsed
 * hold. Runs after `expireLapsedHoldsForSeats`, inside the same transaction, so
 * no other session ever observes the intermediate state where the hold is
 * expired but the seat still looks taken.
 *
 * `booked` seats are deliberately untouched: a sale is permanent here.
 */
export async function releaseSeatsWithoutLiveHold(
  db: Queryable,
  showSeatIds: readonly string[],
): Promise<string[]> {
  const result = await db.query<IdRow>(
    `UPDATE show_seats ss
     SET status = 'available'
     WHERE ss.id = ANY($1::uuid[])
       AND ss.status = 'held'
       AND NOT EXISTS (
         SELECT 1
         FROM reservation_hold_seats rhs
         JOIN reservation_holds h ON h.id = rhs.hold_id
         WHERE rhs.show_seat_id = ss.id
           AND h.status = 'active'
           AND h.expires_at > now()
       )
     RETURNING ss.id`,
    [showSeatIds],
  );
  return result.rows.map((row) => row.id);
}

/**
 * The availability verdict for each seat, read after locking and reclamation.
 *
 * `liveHold` is checked alongside `status` rather than trusting the status
 * column alone: the two are written together in one transaction, but treating
 * a seat as free needs both to agree, so a drifted row fails closed.
 */
export async function readSeatAvailability(
  db: Queryable,
  showSeatIds: readonly string[],
): Promise<SeatAvailabilityRow[]> {
  const result = await db.query<{ id: string; status: ShowSeatStatus; live_hold: boolean }>(
    `SELECT ss.id,
            ss.status,
            EXISTS (
              SELECT 1
              FROM reservation_hold_seats rhs
              JOIN reservation_holds h ON h.id = rhs.hold_id
              WHERE rhs.show_seat_id = ss.id
                AND h.status = 'active'
                AND h.expires_at > now()
            ) AS live_hold
     FROM show_seats ss
     WHERE ss.id = ANY($1::uuid[])
     ORDER BY ss.id`,
    [showSeatIds],
  );

  return result.rows.map((row) => ({ id: row.id, status: row.status, liveHold: row.live_hold }));
}

/**
 * Creates the hold row. `expires_at` is computed by PostgreSQL from its own
 * clock, never from a client-supplied instant: the client says how long, the
 * database says until when. That also keeps every hold on one time source, so
 * comparisons against `now()` elsewhere cannot be skewed by a wrong app-server
 * clock.
 */
export async function insertHold(
  db: Queryable,
  eventId: string,
  userId: string,
  ttlSeconds: number,
): Promise<InsertedHoldRow> {
  const result = await db.query<{ id: string; expires_at: Date }>(
    `INSERT INTO reservation_holds (event_id, user_id, status, expires_at)
     VALUES ($1, $2, 'active', now() + make_interval(secs => $3::double precision))
     RETURNING id, expires_at`,
    [eventId, userId, ttlSeconds],
  );

  const row = result.rows[0];
  if (!row) {
    throw new Error('INSERT INTO reservation_holds returned no row');
  }

  return { id: row.id, expiresAt: row.expires_at };
}

/** Links every requested seat to the hold in one round trip. */
export async function insertHoldSeats(
  db: Queryable,
  holdId: string,
  showSeatIds: readonly string[],
): Promise<number> {
  const result = await db.query(
    `INSERT INTO reservation_hold_seats (hold_id, show_seat_id)
     SELECT $1, show_seat_id
     FROM unnest($2::uuid[]) AS show_seat_id`,
    [holdId, showSeatIds],
  );
  return result.rowCount ?? 0;
}

/**
 * Flips the locked seats to `held`.
 *
 * The `status = 'available'` guard is deliberate belt and braces: by this point
 * the rows are locked and already checked, so the guard can only fail if the
 * logic above is wrong. The caller compares the returned count against what it
 * asked for and aborts the transaction on a mismatch, turning a silent logic
 * bug into a rollback instead of a double-sold seat.
 */
export async function markSeatsHeld(
  db: Queryable,
  showSeatIds: readonly string[],
): Promise<number> {
  const result = await db.query(
    `UPDATE show_seats
     SET status = 'held'
     WHERE id = ANY($1::uuid[]) AND status = 'available'`,
    [showSeatIds],
  );
  return result.rowCount ?? 0;
}
