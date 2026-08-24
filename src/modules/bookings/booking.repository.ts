import { randomBytes } from 'node:crypto';

import type { Queryable } from '../../db/pool.js';
import type { BookingRecord, BookingStatus } from './booking.types.js';

interface BookingRow {
  id: string;
  booking_reference: string;
  user_id: string;
  event_id: string;
  hold_id: string;
  status: BookingStatus;
  total_amount: string;
  currency: string;
  created_at: Date;
  updated_at: Date;
}

function toBookingRecord(row: BookingRow): BookingRecord {
  return {
    id: row.id,
    bookingReference: row.booking_reference,
    userId: row.user_id,
    eventId: row.event_id,
    holdId: row.hold_id,
    status: row.status,
    // Left as the string PostgreSQL returned. Number() here would be the one
    // place a total could lose precision.
    totalAmount: row.total_amount,
    currency: row.currency,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * A customer-facing booking reference, e.g. TX-2026-K4M9QP2X.
 *
 * Random rather than sequential: a counter would leak how many bookings were
 * sold between any two references, which is commercially sensitive and free for
 * anyone holding two tickets to work out. Crockford-style base32 without the
 * characters people misread aloud, since this is a string support staff will
 * read back over the phone.
 *
 * 8 characters of a 32-symbol alphabet is 40 bits. Collisions are not argued
 * away, though - the unique constraint is the actual guarantee, and the caller
 * retries on the rare violation.
 */
const REFERENCE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function generateBookingReference(now: Date = new Date()): string {
  const bytes = randomBytes(8);
  let suffix = '';
  for (const byte of bytes) {
    suffix += REFERENCE_ALPHABET[byte % REFERENCE_ALPHABET.length];
  }
  return `TX-${now.getUTCFullYear()}-${suffix}`;
}

/**
 * Creates the booking row.
 *
 * `total_amount` starts at 0 and is set from the seat rows a moment later, in
 * SQL. The alternative - summing prices in JavaScript and passing the total in
 * - would do financial arithmetic in binary floating point, where
 * 450.10 + 900.20 is not 1350.30.
 *
 * The currency is copied from the event, so a booking keeps the currency it was
 * sold in even if the event is later re-denominated.
 */
export async function insertBooking(
  db: Queryable,
  input: { bookingReference: string; userId: string; eventId: string; holdId: string },
): Promise<BookingRecord> {
  const result = await db.query<BookingRow>(
    `INSERT INTO bookings (booking_reference, user_id, event_id, hold_id, status, total_amount, currency)
     SELECT $1, $2, $3, $4, 'confirmed', 0, e.currency
     FROM events e
     WHERE e.id = $3
     RETURNING *`,
    [input.bookingReference, input.userId, input.eventId, input.holdId],
  );

  const row = result.rows[0];
  if (!row) {
    throw new Error('INSERT INTO bookings returned no row');
  }
  return toBookingRecord(row);
}

/**
 * Snapshots every seat of the hold into booking_seats, in one statement.
 *
 * Set-based on purpose: a per-seat INSERT would be an N+1 round trip for a
 * ten-seat booking, inside a transaction already holding row locks - the worst
 * possible place to spend network time.
 *
 * The price is read from the show_seats rows this transaction has already
 * locked, so it cannot change between being read and being recorded.
 */
export async function insertBookingSeats(
  db: Queryable,
  bookingId: string,
  showSeatIds: readonly string[],
): Promise<number> {
  const result = await db.query(
    `INSERT INTO booking_seats (booking_id, show_seat_id, price)
     SELECT $1, ss.id, ss.price
     FROM show_seats ss
     WHERE ss.id = ANY($2::uuid[])`,
    [bookingId, showSeatIds],
  );
  return result.rowCount ?? 0;
}

/**
 * Sets the booking total to the sum of its seat snapshots.
 *
 * PostgreSQL adds the money. The total is therefore exactly the sum of what was
 * recorded per seat, by construction rather than by the application and the
 * database happening to agree.
 */
export async function applyBookingTotal(db: Queryable, bookingId: string): Promise<string> {
  const result = await db.query<{ total_amount: string }>(
    `UPDATE bookings
     SET total_amount = (
       SELECT COALESCE(SUM(price), 0) FROM booking_seats WHERE booking_id = $1
     )
     WHERE id = $1
     RETURNING total_amount`,
    [bookingId],
  );

  const row = result.rows[0];
  if (!row) {
    throw new Error('Booking disappeared while applying its total');
  }
  return row.total_amount;
}

/** Marks the locked, verified seats sold. Returns how many actually changed. */
export async function markSeatsBooked(
  db: Queryable,
  showSeatIds: readonly string[],
): Promise<number> {
  // The `status = 'held'` guard makes available -> booked impossible through
  // this path: only a seat currently held can be sold, which is what confines
  // confirmation to seats the caller's hold already owns.
  const result = await db.query(
    `UPDATE show_seats
     SET status = 'booked'
     WHERE id = ANY($1::uuid[]) AND status = 'held'`,
    [showSeatIds],
  );
  return result.rowCount ?? 0;
}

/**
 * Transitions the hold to `converted` - the terminal state the schema already
 * had for this. Guarded on `active`, so it can only ever fire once.
 */
export async function markHoldConverted(db: Queryable, holdId: string): Promise<boolean> {
  const result = await db.query(
    `UPDATE reservation_holds
     SET status = 'converted'
     WHERE id = $1 AND status = 'active'`,
    [holdId],
  );
  return (result.rowCount ?? 0) > 0;
}

export interface LockedHoldForConfirmation {
  userId: string;
  eventId: string;
  status: string;
  /** Evaluated by PostgreSQL under the lock, never against an app clock. */
  expired: boolean;
}

/**
 * Locks the hold and returns what confirmation needs to judge it.
 *
 * Called *after* the seats are locked, to match the lock order the reservation
 * path and the expiration worker already use. Ownership, event and expiry all
 * come from this row, read at the moment the lock is granted, so a hold that
 * expired or was converted while the caller waited is seen in its true state.
 */
export async function lockHoldForConfirmation(
  db: Queryable,
  holdId: string,
): Promise<LockedHoldForConfirmation | null> {
  const result = await db.query<{
    user_id: string;
    event_id: string;
    status: string;
    expired: boolean;
  }>(
    `SELECT user_id, event_id, status, (expires_at <= now()) AS expired
     FROM reservation_holds
     WHERE id = $1
     FOR UPDATE`,
    [holdId],
  );

  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return {
    userId: row.user_id,
    eventId: row.event_id,
    status: row.status,
    expired: row.expired,
  };
}

export interface HoldSeatState {
  showSeatId: string;
  status: string;
}

/**
 * Locks every seat of a hold, in id order, and reports its state.
 *
 * One statement for the whole set - no per-seat query - and `ORDER BY` inside
 * a subquery so the lock is taken in ascending id order, the same order every
 * other path in this system uses.
 */
export async function lockHoldSeats(db: Queryable, holdId: string): Promise<HoldSeatState[]> {
  const result = await db.query<{ show_seat_id: string; status: string }>(
    `SELECT ss.id AS show_seat_id, ss.status
     FROM show_seats ss
     WHERE ss.id IN (
       SELECT rhs.show_seat_id FROM reservation_hold_seats rhs WHERE rhs.hold_id = $1
     )
     ORDER BY ss.id
     FOR UPDATE`,
    [holdId],
  );

  return result.rows.map((row) => ({ showSeatId: row.show_seat_id, status: row.status }));
}

/** The seats of a booking, for building a response or a test assertion. */
export async function findBookingSeats(
  db: Queryable,
  bookingId: string,
): Promise<{ showSeatId: string; price: string }[]> {
  const result = await db.query<{ show_seat_id: string; price: string }>(
    'SELECT show_seat_id, price FROM booking_seats WHERE booking_id = $1 ORDER BY show_seat_id',
    [bookingId],
  );
  return result.rows.map((row) => ({ showSeatId: row.show_seat_id, price: row.price }));
}

export interface LockedBooking {
  userId: string;
  eventId: string;
  status: BookingStatus;
}

/**
 * Locks the booking and returns what cancellation needs to judge it.
 *
 * Taken *before* the seats, which is the reverse of confirmation - and safe,
 * because the two paths can never contend for the same booking row. A
 * confirmation creates a booking that does not yet exist, so nothing else can
 * be holding it; cancellation is the only path that locks an existing booking.
 * The shared resource is `show_seats`, and both paths reach it in the same
 * ascending-id order.
 */
export async function lockBookingForCancellation(
  db: Queryable,
  bookingId: string,
): Promise<LockedBooking | null> {
  const result = await db.query<{ user_id: string; event_id: string; status: BookingStatus }>(
    `SELECT user_id, event_id, status
     FROM bookings
     WHERE id = $1
     FOR UPDATE`,
    [bookingId],
  );

  const row = result.rows[0];
  return row ? { userId: row.user_id, eventId: row.event_id, status: row.status } : null;
}

/**
 * Locks the seats of a booking, ascending by id, and reports their state.
 *
 * Same ordering as every other path that touches `show_seats`. One statement,
 * not one per seat: a ten-seat booking must not become ten round trips inside a
 * transaction that is already holding locks.
 *
 * Only live seat rows are considered. A seat released by an earlier
 * cancellation is history and must not be locked or re-released.
 */
export async function lockBookingSeats(
  db: Queryable,
  bookingId: string,
): Promise<HoldSeatState[]> {
  const result = await db.query<{ show_seat_id: string; status: string }>(
    `SELECT ss.id AS show_seat_id, ss.status
     FROM show_seats ss
     WHERE ss.id IN (
       SELECT bs.show_seat_id FROM booking_seats bs
       WHERE bs.booking_id = $1 AND bs.cancelled_at IS NULL
     )
     ORDER BY ss.id
     FOR UPDATE`,
    [bookingId],
  );

  return result.rows.map((row) => ({ showSeatId: row.show_seat_id, status: row.status }));
}

/**
 * Transitions a booking to cancelled, guarded on its current state.
 *
 * `AND status = 'confirmed'` is what makes cancelled a terminal state: a second
 * cancellation changes zero rows, and the caller treats a zero count as "not
 * mine to do" rather than assuming success. cancelled -> confirmed has no
 * statement anywhere that could perform it.
 */
export async function markBookingCancelled(
  db: Queryable,
  bookingId: string,
): Promise<BookingRecord | null> {
  const result = await db.query<BookingRow>(
    `UPDATE bookings
     SET status = 'cancelled'
     WHERE id = $1 AND status = 'confirmed'
     RETURNING *`,
    [bookingId],
  );

  const row = result.rows[0];
  return row ? toBookingRecord(row) : null;
}

/**
 * Stamps the booking's seat rows as cancelled.
 *
 * The rows stay - they are the historical record of what was sold and at what
 * price, and nothing here touches `price`. The timestamp only drops them out of
 * the partial unique index so the seat can be sold again.
 */
export async function markBookingSeatsCancelled(
  db: Queryable,
  bookingId: string,
): Promise<number> {
  const result = await db.query(
    `UPDATE booking_seats
     SET cancelled_at = now()
     WHERE booking_id = $1 AND cancelled_at IS NULL`,
    [bookingId],
  );
  return result.rowCount ?? 0;
}

/**
 * Releases the seats, guarded on their current state.
 *
 * `AND status = 'booked'` means a seat that is somehow no longer booked is left
 * alone rather than being wrenched to available. The caller compares the count
 * against what it locked and aborts on a mismatch, so a disagreement between
 * the booking and the seats can never be papered over.
 */
export async function releaseBookedSeats(
  db: Queryable,
  showSeatIds: readonly string[],
): Promise<number> {
  const result = await db.query(
    `UPDATE show_seats
     SET status = 'available'
     WHERE id = ANY($1::uuid[]) AND status = 'booked'`,
    [showSeatIds],
  );
  return result.rowCount ?? 0;
}
