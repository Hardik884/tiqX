import type { PoolClient } from 'pg';

import { PG_ERROR, pgErrorCode, pgErrorConstraint } from '../../db/pg-error.js';
import { ConflictError, NotFoundError } from '../../errors/app-error.js';
import { logger } from '../../utils/logger.js';
import { enqueueTicketEmail } from '../notifications/ticket-email.repository.js';
import { ensureTicketsForBooking } from '../tickets/ticket.service.js';
import { hasUsedTickets } from '../tickets/ticket.repository.js';
import { enqueueWaitlistAllocationForSeats } from '../waitlist/waitlist-outbox.repository.js';
import {
  applyBookingTotal,
  generateBookingReference,
  insertBooking,
  insertBookingSeats,
  lockBookingForCancellation,
  lockBookingSeats,
  lockHoldForConfirmation,
  lockHoldSeats,
  markBookingCancelled,
  markBookingSeatsCancelled,
  markHoldConverted,
  markSeatsBooked,
  releaseBookedSeats,
} from './booking.repository.js';
import type {
  CancelBookingInput,
  CancelBookingResult,
  ConfirmHoldInput,
  ConfirmHoldResult,
} from './booking.types.js';

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
 *     idempotency_keys  ->  show_seats (by id)  ->  reservation_holds  ->  tickets
 *
 * `tickets` sits last because it is only ever *inserted* here, never locked -
 * `ensureTicketsForBooking` runs after the hold conversion above, and the
 * rows it creates cannot have existed a moment earlier, so there is nothing
 * for another transaction to contend with. TICKET CREATION AND EMAIL ARE PART
 * OF THIS TRANSACTION, not a follow-up step: a booking that committed without
 * its tickets would be sellable but unusable, and the outbox row requesting
 * the confirmation email is written here too, alongside the tickets, so an
 * email is requested if and only if the booking - and its tickets - actually
 * exist. See ticket.service.ts::ensureTicketsForBooking and
 * ticket-email.repository.ts::enqueueTicketEmail.
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

  // ENSURE THE BOOKING HAS ITS TICKETS, IN THE SAME TRANSACTION.
  //
  // A booking that commits without its tickets would be a booking a customer
  // paid for (conceptually) and cannot yet enter anything with - so ticket
  // creation happens here, before this transaction commits, not as a
  // follow-up step that could be skipped or run twice. `ensureTicketsForBooking`
  // is the same function the manual issuance endpoint calls; here it always
  // finds no existing tickets, since this booking did not exist a moment ago.
  //
  // Enqueuing the email is the one line that differs from a bare issuance:
  // this is the one call site where "tickets were just created" also means
  // "an email should go out" - see ticket-email.repository.ts. The row is
  // written here, in this transaction, and drained by the notifications
  // worker afterwards - never a direct call to an email provider, which would
  // hold these seat and hold locks open for a network round trip to a
  // service this transaction does not control.
  const { tickets, created: ticketsCreated } = await ensureTicketsForBooking(client, booking.id, requestId);
  if (ticketsCreated) {
    await enqueueTicketEmail(client, booking.id);
  }

  logger.info('Confirmed booking', {
    requestId,
    bookingId: booking.id,
    bookingReference: booking.bookingReference,
    holdId: input.holdId,
    eventId: input.eventId,
    seatCount: showSeatIds.length,
    ticketCount: tickets.length,
  });

  return {
    booking: { ...booking, totalAmount },
    seatCount: showSeatIds.length,
  };
}

/**
 * A booking that does not exist or is not yours.
 *
 * The same reasoning as {@link holdNotFound}, applied to a resource that is
 * worth rather more to probe. Answering 403 for "someone else's booking" and
 * 404 for "no such booking" would let anyone walk booking ids and learn which
 * ones are real - and a real booking id is a support-desk credential in most
 * ticketing systems. One answer for both, and the distinction kept in the log.
 */
function bookingNotFound(): NotFoundError {
  return new NotFoundError('Booking not found', { reason: 'BOOKING_NOT_FOUND' });
}

/**
 * Cancels a confirmed booking and puts its seats back on sale.
 *
 * THE STATE MACHINE.
 *
 *     confirmed ──> cancelled     (this transaction, guarded on `confirmed`)
 *     cancelled ── terminal
 *
 * There is no statement anywhere in this codebase that writes `confirmed` over
 * `cancelled`, and the UPDATE that performs the transition is itself guarded on
 * `status = 'confirmed'`, so a second cancellation changes zero rows rather
 * than repeating the work. That zero is treated as a refusal, never as
 * success - which is what stops a seat being released twice.
 *
 * WHAT MOVES AND WHAT DOES NOT.
 *
 *     bookings.status         confirmed -> cancelled
 *     booking_seats           rows stay; only `cancelled_at` is stamped
 *     booking_seats.price     untouched, it is a historical snapshot
 *     bookings.total_amount   untouched, for the same reason
 *     bookings.currency       untouched
 *     show_seats.status       booked -> available
 *     reservation_holds       untouched - see below
 *
 * THE HOLD STAYS CONVERTED. Cancelling a booking is not undoing the
 * confirmation that created it. The hold was consumed when the booking was
 * made; `converted` is terminal and records that it happened. Rewinding it to
 * `active` would resurrect a reservation nobody asked for, with an `expires_at`
 * long past, and would hand the seats to a hold whose owner has just given them
 * up. After confirmation the booking owns the seats, so the booking - and only
 * the booking - releases them.
 *
 * LOCK ORDER: the booking, then its seats in ascending id order. That extends
 * the existing global order rather than contradicting it:
 *
 *     idempotency_keys  ->  bookings  ->  show_seats (by id)  ->  reservation_holds
 *     idempotency_keys  ->  bookings  ->  tickets
 *
 * Confirmation takes seats then the hold, and never locks an existing `bookings`
 * row - it inserts one that no other transaction can yet see. So `bookings` and
 * `reservation_holds` sit on opposite sides of `show_seats` and no cycle is
 * possible. The only table both paths contend for is `show_seats`, and both
 * reach it in the same ascending-id order, which is what makes reservation,
 * expiration, confirmation and cancellation safe to run at once.
 *
 * Ticket issuance and verification (see ticket.service.ts) both lock this same
 * `bookings` row first, before touching `tickets`, which is what serialises
 * them against this function rather than racing it - the `hasUsedTickets`
 * check below is read under that same lock. Neither ticket path ever locks
 * `show_seats` or `reservation_holds`, so there is no cycle between the two
 * global orders above; they only ever share the `bookings` row.
 *
 * `enqueueWaitlistAllocationForSeats` at the end takes no lock of its own - a
 * plain INSERT against a row nothing else here has touched - so it adds
 * nothing to this ordering. See the waitlist migration's top comment for what
 * reads that signal and how it fits the same global order from the other
 * side, through `show_seats` and `reservation_holds`.
 *
 * WHERE A REFUND WOULD GO. Not here. This function must stay a pure PostgreSQL
 * transaction: it holds row locks on inventory that other customers are queuing
 * for, and an HTTP call to a payment provider inside those locks would hold them
 * for the provider's latency and timeout, not the database's. The boundary is
 * therefore:
 *
 *     cancel booking (this transaction, commits)
 *         -> enqueue a refund intent
 *             -> payment provider
 *                 -> refund webhook updates the refund record
 *
 * The enqueue step is the only piece that would join this transaction, and it
 * would join it the way hold expiration already does: an outbox row written
 * here and drained by a worker afterwards. Nothing external is called while a
 * lock is held.
 */
export async function cancelBookingInTransaction(
  client: PoolClient,
  input: CancelBookingInput,
  requestId: string | undefined,
): Promise<CancelBookingResult> {
  const booking = await lockBookingForCancellation(client, input.bookingId);

  if (booking === null || booking.userId !== input.userId) {
    logger.warn('Rejected booking cancellation', {
      requestId,
      bookingId: input.bookingId,
      userId: input.userId,
      reason: booking === null ? 'BOOKING_NOT_FOUND' : 'BOOKING_NOT_OWNED',
    });
    throw bookingNotFound();
  }

  if (booking.status === 'cancelled') {
    logger.warn('Rejected booking cancellation', {
      requestId,
      bookingId: input.bookingId,
      eventId: booking.eventId,
      userId: input.userId,
      reason: 'BOOKING_ALREADY_CANCELLED',
    });
    throw new ConflictError('This booking has already been cancelled', {
      reason: 'BOOKING_ALREADY_CANCELLED',
    });
  }

  if (booking.status !== 'confirmed') {
    // Unreachable while the status check allows only two values, and kept so
    // that adding a third one fails loudly here instead of cancelling it.
    logger.warn('Rejected booking cancellation', {
      requestId,
      bookingId: input.bookingId,
      eventId: booking.eventId,
      reason: 'BOOKING_INVALID',
    });
    throw new ConflictError('This booking can no longer be cancelled', {
      reason: 'BOOKING_INVALID',
    });
  }

  // A ticket that has already been used is proof someone was let in on it;
  // undoing the sale afterwards would leave that entry unaccounted for. This
  // is checked here, under the booking lock just taken above, which is the
  // same lock ticket verification takes before marking a ticket used - so
  // this can never race a verification that has not committed yet. Either
  // this transaction is the one that finds the used ticket (verification
  // already committed), or verification is still blocked behind this lock and
  // cannot produce one until this transaction ends. See
  // ticket.service.ts::verifyTicketInTransaction for the other half.
  if (await hasUsedTickets(client, input.bookingId)) {
    logger.warn('Rejected booking cancellation', {
      requestId,
      bookingId: input.bookingId,
      eventId: booking.eventId,
      reason: 'BOOKING_HAS_USED_TICKETS',
    });
    throw new ConflictError('This booking has a used ticket and can no longer be cancelled', {
      reason: 'BOOKING_HAS_USED_TICKETS',
    });
  }

  // Seats after the booking, in ascending id order, in one statement.
  const seats = await lockBookingSeats(client, input.bookingId);

  const notBooked = seats.filter((seat) => seat.status !== 'booked');
  if (seats.length === 0 || notBooked.length > 0) {
    // A confirmed booking whose seats are not all booked means the booking and
    // the inventory disagree. Releasing seats on that basis is exactly how a
    // seat held by someone else gets taken away, so refuse instead.
    logger.error('Booking and seat state disagree, refusing to cancel', {
      requestId,
      bookingId: input.bookingId,
      eventId: booking.eventId,
      seats: seats.length,
      notBooked: notBooked.length,
    });
    throw new ConflictError('Seats for this booking are not in a cancellable state', {
      reason: 'CANCELLATION_CONFLICT',
    });
  }

  const showSeatIds = seats.map((seat) => seat.showSeatId);

  // The booking transitions first. Every release below is therefore already
  // covered by a state change that this same transaction has made, so there is
  // no instant - even inside the transaction - where a seat is free while its
  // booking still claims it.
  const cancelled = await markBookingCancelled(client, input.bookingId);
  if (cancelled === null) {
    throw new Error('Booking was no longer confirmed when cancelling');
  }

  const stamped = await markBookingSeatsCancelled(client, input.bookingId);
  if (stamped !== showSeatIds.length) {
    throw new Error(`Expected to retire ${showSeatIds.length} booking seats, updated ${stamped}`);
  }

  const released = await releaseBookedSeats(client, showSeatIds);
  if (released !== showSeatIds.length) {
    // Guarded on `status = 'booked'`, so a shortfall means a seat left `booked`
    // between the lock and here - impossible while the lock holds, and a reason
    // to abort rather than half-release.
    throw new Error(`Expected to release ${showSeatIds.length} seats, updated ${released}`);
  }

  // A released seat is a fresh allocation opportunity for whoever is waitlisted
  // for its category - see the waitlist migration's top comment and
  // expireHoldInTransaction in expiration.service.ts, which enqueues the same
  // signal for the other path that frees a seat. A no-op when nobody is
  // waiting: the signal is cheap and the allocation pass that eventually reads
  // it finds nothing to do.
  await enqueueWaitlistAllocationForSeats(client, showSeatIds);

  logger.info('Cancelled booking', {
    requestId,
    bookingId: cancelled.id,
    bookingReference: cancelled.bookingReference,
    eventId: cancelled.eventId,
    userId: cancelled.userId,
    releasedSeatCount: released,
  });

  return { booking: cancelled, releasedSeatCount: released };
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
