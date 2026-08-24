import type { PoolClient } from 'pg';

import { PG_ERROR, pgErrorCode, pgErrorConstraint } from '../../db/pg-error.js';
import { ConflictError, NotFoundError } from '../../errors/app-error.js';
import { logger } from '../../utils/logger.js';
import {
  applyBookingTotal,
  generateBookingReference,
  insertBooking,
  insertBookingSeats,
  lockHoldForConfirmation,
  lockHoldSeats,
  markHoldConverted,
  markSeatsBooked,
} from './booking.repository.js';
import type { ConfirmHoldInput, ConfirmHoldResult } from './booking.types.js';

/**
 * A hold that does not exist, is not yours, or belongs to another event.
 *
 * All three answer identically, and that is a deliberate security choice rather
 * than laziness. Distinguishing "no such hold" from "not your hold" turns the
 * endpoint into an oracle: anyone could confirm whether a given hold id is
 * real, and by extension probe another customer's activity. The client gains
 * nothing from the distinction either - in every case, this caller cannot
 * confirm this hold under this event.
 *
 * The distinction is kept server-side, in the logs, where an operator can see
 * it and an attacker cannot.
 */
function holdNotFound(): NotFoundError {
  return new NotFoundError('Hold not found', { reason: 'HOLD_NOT_FOUND' });
}

/**
 * WHY THIS IS NOT "PAYMENT CONFIRMATION".
 *
 * Confirming here means one thing: the reservation is durably converted into a
 * booking. No money moves, nothing is authorised, and `bookings` deliberately
 * has no payment status - a two-state lifecycle (confirmed, cancelled) rather
 * than a half-built payment machine nobody has designed yet.
 *
 * The shape is chosen so payment can slot in front without disturbing any of
 * this. A future flow becomes:
 *
 *     authorise payment  ->  confirm booking (this transaction)
 *
 * with the authorisation reference carried into the booking row. What must not
 * happen is the reverse - confirming first and reconciling payment afterwards -
 * because that is how you end up owing seats you were never paid for.
 *
 * TRANSACTION. Everything below runs in the caller's transaction, which the
 * idempotency wrapper owns, so the booking, the seat rows, the seat statuses,
 * the hold transition and the stored idempotency response all commit together.
 * There is no ordering of these writes that can be observed from outside.
 *
 * LOCK ORDER: seats first, in ascending id order, then the hold. This is the
 * order the reservation path and the expiration worker already use, and the
 * reason all three can run at once without deadlocking. Confirmation starts
 * from a hold id, so taking the hold lock first would be the natural mistake
 * and the one that cycles against a reservation coming the other way.
 *
 * The full global order, including this path, is:
 *
 *     idempotency_keys  ->  show_seats (by id)  ->  reservation_holds
 */
export async function confirmHoldInTransaction(
  client: PoolClient,
  input: ConfirmHoldInput,
  requestId: string | undefined,
): Promise<ConfirmHoldResult> {
  // Seats before the hold. The set is read from the join table, which is
  // immutable once a hold exists, so this needs no lock of its own.
  const seats = await lockHoldSeats(client, input.holdId);

  const hold = await lockHoldForConfirmation(client, input.holdId);

  if (hold === null || hold.userId !== input.userId || hold.eventId !== input.eventId) {
    logger.warn('Rejected hold confirmation', {
      requestId,
      holdId: input.holdId,
      eventId: input.eventId,
      // Which of the three it was, recorded where only an operator sees it.
      reason:
        hold === null
          ? 'HOLD_NOT_FOUND'
          : hold.userId !== input.userId
            ? 'HOLD_NOT_OWNED'
            : 'HOLD_EVENT_MISMATCH',
    });
    throw holdNotFound();
  }

  // The state machine, checked under the lock. A hold leaves `active` exactly
  // once, and every other state is terminal:
  //
  //     active ──> converted   (this transaction)
  //            └─> expired     (the worker, or opportunistic reclamation)
  //     converted / expired / cancelled ── terminal
  //
  // So expired -> converted and converted -> active are not merely rejected
  // here; they are unreachable, because the UPDATE that performs the
  // transition is itself guarded on `status = 'active'`.
  if (hold.status === 'converted') {
    logger.warn('Rejected hold confirmation', {
      requestId,
      holdId: input.holdId,
      reason: 'HOLD_ALREADY_CONFIRMED',
    });
    throw new ConflictError('This hold has already been confirmed', {
      reason: 'HOLD_ALREADY_CONFIRMED',
    });
  }

  if (hold.status === 'expired' || hold.expired) {
    // `hold.expired` catches the case the worker has not reached yet: the row
    // still reads `active` but its time has passed. PostgreSQL decides that,
    // under the lock - not a Redis key, and not the application clock.
    logger.warn('Rejected hold confirmation', {
      requestId,
      holdId: input.holdId,
      reason: 'HOLD_EXPIRED',
    });
    throw new ConflictError('This hold has expired', { reason: 'HOLD_EXPIRED' });
  }

  if (hold.status !== 'active') {
    logger.warn('Rejected hold confirmation', {
      requestId,
      holdId: input.holdId,
      reason: 'HOLD_INVALID',
    });
    throw new ConflictError('This hold can no longer be confirmed', { reason: 'HOLD_INVALID' });
  }

  // An active, unexpired hold whose seats are not all held would mean the seat
  // and hold tables disagree. It should be unreachable; if it ever happens,
  // refusing is the only safe answer.
  const notHeld = seats.filter((seat) => seat.status !== 'held');
  if (seats.length === 0 || notHeld.length > 0) {
    logger.error('Hold and seat state disagree, refusing to confirm', {
      requestId,
      holdId: input.holdId,
      seats: seats.length,
      notHeld: notHeld.length,
    });
    throw new ConflictError('Seats for this hold are no longer available', {
      reason: 'CONFIRMATION_CONFLICT',
    });
  }

  const showSeatIds = seats.map((seat) => seat.showSeatId);

  const booking = await createBookingRow(client, input, requestId);

  const seatRows = await insertBookingSeats(client, booking.id, showSeatIds);
  if (seatRows !== showSeatIds.length) {
    throw new Error(`Expected ${showSeatIds.length} booking seats, inserted ${seatRows}`);
  }

  // PostgreSQL sums the snapshots; nothing adds money in JavaScript.
  const totalAmount = await applyBookingTotal(client, booking.id);

  const booked = await markSeatsBooked(client, showSeatIds);
  if (booked !== showSeatIds.length) {
    // Guarded on `status = 'held'`, so a shortfall means a seat slipped out of
    // held between the lock and here - impossible while the lock holds, and a
    // reason to abort rather than half-sell.
    throw new Error(`Expected to book ${showSeatIds.length} seats, updated ${booked}`);
  }

  if (!(await markHoldConverted(client, input.holdId))) {
    throw new Error('Hold was no longer active when converting');
  }

  logger.info('Confirmed booking', {
    requestId,
    bookingId: booking.id,
    bookingReference: booking.bookingReference,
    holdId: input.holdId,
    eventId: input.eventId,
    seatCount: showSeatIds.length,
  });

  return {
    booking: { ...booking, totalAmount },
    seatCount: showSeatIds.length,
  };
}

/** How many booking references to try before giving up. */
const REFERENCE_ATTEMPTS = 3;

/** Inserts the booking, tolerating a collision on the random reference. */
async function createBookingRow(
  client: PoolClient,
  input: ConfirmHoldInput,
  requestId: string | undefined,
): Promise<Awaited<ReturnType<typeof insertBooking>>> {
  // A retry needs its own savepoint: a constraint violation aborts the
  // surrounding transaction, and this one still has a booking to write.
  for (let attempt = 1; attempt <= REFERENCE_ATTEMPTS; attempt += 1) {
    await client.query('SAVEPOINT booking_insert');

    try {
      const booking = await insertBooking(client, {
        bookingReference: generateBookingReference(),
        userId: input.userId,
        eventId: input.eventId,
        holdId: input.holdId,
      });
      await client.query('RELEASE SAVEPOINT booking_insert');
      return booking;
    } catch (error) {
      await client.query('ROLLBACK TO SAVEPOINT booking_insert');

      if (pgErrorCode(error) !== PG_ERROR.UNIQUE_VIOLATION) {
        throw error;
      }

      // A collision on hold_id is not a retryable accident: it means another
      // transaction booked this hold. The status check above should have caught
      // it, but the constraint is the real guarantee, and the honest answer to
      // the caller is that the hold is already confirmed - not a 500.
      if (pgErrorConstraint(error) === 'bookings_hold_id_key') {
        throw new ConflictError('This hold has already been confirmed', {
          reason: 'HOLD_ALREADY_CONFIRMED',
        });
      }

      if (pgErrorConstraint(error) !== 'bookings_booking_reference_key') {
        throw error;
      }

      // A reference collision is a 1-in-2^40 coincidence. Retrying with a fresh
      // reference is correct and cheap; giving up on the first one would fail a
      // legitimate booking for no reason.
      logger.warn('Booking reference collided, retrying', {
        requestId,
        holdId: input.holdId,
        attempt,
      });
    }
  }

  throw new Error(`Could not allocate a unique booking reference in ${REFERENCE_ATTEMPTS} attempts`);
}
