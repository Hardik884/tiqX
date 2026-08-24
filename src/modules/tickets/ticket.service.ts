import type { PoolClient } from 'pg';

import { withTransaction } from '../../db/pool.js';
import { PG_ERROR, pgErrorCode, pgErrorConstraint } from '../../db/pg-error.js';
import { ConflictError, NotFoundError } from '../../errors/app-error.js';
import { logger } from '../../utils/logger.js';
import {
  findLiveBookingSeatIds,
  findTicketBookingId,
  findTicketById,
  findTicketsForBooking,
  findTicketVerificationContext,
  generateTicketReference,
  insertTicketsForSeats,
  lockBookingForTickets,
  markTicketUsed,
} from './ticket.repository.js';
import type { IssueTicketsInput, IssueTicketsResult, TicketRecord, VerifyTicketInput, VerifyTicketResult } from './ticket.types.js';

/**
 * A booking that does not exist or that this caller has no standing over.
 *
 * Same reasoning as `bookingNotFound` in booking.service.ts: answering 403 for
 * "someone else's booking" and 404 for "no such booking" would let anyone walk
 * booking ids and learn which are real. One answer for both; the distinction
 * stays in the log.
 */
function bookingNotFound(): NotFoundError {
  return new NotFoundError('Booking not found', { reason: 'BOOKING_NOT_FOUND' });
}

function ticketNotFound(): NotFoundError {
  return new NotFoundError('Ticket not found', { reason: 'TICKET_NOT_FOUND' });
}

/** How many ticket-reference collisions to tolerate before giving up. */
const REFERENCE_ATTEMPTS = 3;

/**
 * Inserts the ticket batch, tolerating a collision on the random references.
 *
 * A savepoint, not the whole transaction: a unique violation aborts only the
 * statement it wraps, and the booking lock this runs under must survive a
 * retry.
 */
async function insertTicketsWithRetry(
  client: PoolClient,
  bookingId: string,
  bookingSeatIds: readonly string[],
  requestId: string | undefined,
): Promise<TicketRecord[]> {
  for (let attempt = 1; attempt <= REFERENCE_ATTEMPTS; attempt += 1) {
    await client.query('SAVEPOINT ticket_insert');

    const references = bookingSeatIds.map(() => generateTicketReference());

    try {
      const tickets = await insertTicketsForSeats(client, bookingId, bookingSeatIds, references);
      await client.query('RELEASE SAVEPOINT ticket_insert');
      return tickets;
    } catch (error) {
      await client.query('ROLLBACK TO SAVEPOINT ticket_insert');

      if (pgErrorCode(error) !== PG_ERROR.UNIQUE_VIOLATION) {
        throw error;
      }

      if (pgErrorConstraint(error) === 'tickets_booking_seat_id_key') {
        // A concurrent issuance already claimed one of these seats. The
        // booking lock held for this whole transaction should make this
        // unreachable - this is the database backstop behind the count check
        // in `issueTicketsInTransaction`, not a substitute for it.
        throw new ConflictError('Tickets have already been issued for this booking', {
          reason: 'TICKETS_ALREADY_ISSUED',
        });
      }

      if (pgErrorConstraint(error) !== 'tickets_ticket_reference_key') {
        throw error;
      }

      // A reference collision is a 1-in-2^60 coincidence per ticket. Retrying
      // the whole batch with fresh references is correct and cheap; giving up
      // on the first one would fail a legitimate issuance for no reason.
      logger.warn('Ticket reference collided, retrying', { requestId, bookingId, attempt });
    }
  }

  throw new Error(`Could not allocate unique ticket references in ${REFERENCE_ATTEMPTS} attempts`);
}

export interface EnsureTicketsResult {
  tickets: TicketRecord[];
  /** False when tickets already existed and nothing new was created. */
  created: boolean;
}

/**
 * The core ticket-issuance mechanics: idempotent, and ignorant of who is
 * asking.
 *
 * Shared by two callers with different obligations - automatic issuance at
 * booking confirmation, and the manual issuance endpoint - which is exactly
 * why authorisation, ownership and booking-status checks are *not* done here.
 * `confirmHoldInTransaction` calls this the instant a booking is created, when
 * there is no separate "caller" to authorise; `issueTicketsInTransaction`
 * does its own ownership/status checks first, under the same booking lock,
 * and only reaches this once they pass.
 *
 * Idempotent by construction, not by a flag this function invents: if
 * tickets already exist for the booking, they are returned unchanged and
 * `created` is false. The `tickets_booking_seat_id_key` unique constraint is
 * the actual backstop - this check is what makes the common case cheap
 * (skip straight to "already have them") rather than what makes it correct.
 */
export async function ensureTicketsForBooking(
  client: PoolClient,
  bookingId: string,
  requestId: string | undefined,
): Promise<EnsureTicketsResult> {
  const existing = await findTicketsForBooking(client, bookingId);
  if (existing.length > 0) {
    return { tickets: existing, created: false };
  }

  const bookingSeatIds = await findLiveBookingSeatIds(client, bookingId);
  if (bookingSeatIds.length === 0) {
    // Unreachable while confirmation always creates at least one seat and
    // cancellation never deletes a booking_seats row - kept as a refusal
    // rather than an assumption, the same way confirmation and cancellation
    // both refuse on a seat/state disagreement instead of guessing.
    logger.error('Confirmed booking has no seats, refusing to issue tickets', {
      requestId,
      bookingId,
    });
    throw new ConflictError('This booking has no seats to issue tickets for', {
      reason: 'BOOKING_HAS_NO_SEATS',
    });
  }

  const tickets = await insertTicketsWithRetry(client, bookingId, bookingSeatIds, requestId);
  if (tickets.length !== bookingSeatIds.length) {
    throw new Error(`Expected ${bookingSeatIds.length} tickets, inserted ${tickets.length}`);
  }

  return { tickets, created: true };
}

/**
 * Issues one ticket per live seat of a confirmed booking, on request.
 *
 * In the ordinary case there is nothing left to do: booking confirmation
 * already called `ensureTicketsForBooking` the moment the booking was
 * created (see booking.service.ts), so this almost always finds tickets
 * already present and answers `TICKETS_ALREADY_ISSUED`. It stays as a
 * separate, callable endpoint rather than being removed, both because a
 * booking confirmed before this behaviour existed would otherwise have no
 * way to backfill tickets, and because `ensureTicketsForBooking`'s own
 * idempotence means calling it again here is always safe.
 *
 * THE AUTHORISATION MODEL. Three principals may issue tickets for a booking:
 * the customer who owns it, any admin, or the organiser of the event it
 * belongs to. Anyone else is answered with the same "booking not found" as a
 * booking that does not exist, for the reason given at `bookingNotFound`.
 *
 * TRANSACTION. Everything below runs in the caller's transaction, which the
 * idempotency wrapper owns:
 *
 *     BEGIN
 *       lock the booking (and read its event's organiser) FOR UPDATE
 *       verify it exists, verify ownership/authorisation
 *       verify status = 'confirmed'
 *       ensureTicketsForBooking - already-issued is a conflict here
 *     COMMIT
 *
 * LOCK ORDER: `bookings`, then `tickets` (via the insert). This is the same
 * first step booking cancellation takes - `lockBookingForCancellation` locks
 * the identical row - so the two paths serialise on it rather than racing.
 * Neither issuance nor verification ever locks `show_seats` or
 * `reservation_holds`, so nothing here can cycle against confirmation's
 * `show_seats -> reservation_holds` order or cancellation's own
 * `bookings -> show_seats` order. The full picture, across every path that
 * touches a booking or a ticket:
 *
 *     idempotency_keys -> bookings -> show_seats (by id) -> reservation_holds
 *     idempotency_keys -> bookings -> tickets
 *
 * WHY THIS IS ENOUGH TO STOP "ISSUE THEN CANCEL" FROM RACING. Cancellation's
 * very first statement is `SELECT ... FROM bookings WHERE id = $1 FOR UPDATE`
 * - the same row this function locks first. Whichever transaction acquires it
 * first runs to completion before the other is even allowed to read the
 * booking's status, so there is no instant where issuance proceeds against a
 * booking that is concurrently being cancelled, or cancellation proceeds
 * without knowing tickets were just issued. See `cancelBookingInTransaction`
 * for the matching half: it refuses to cancel a booking with a used ticket,
 * which is the only outcome this ordering does not already prevent by itself.
 *
 * TRADEOFF. Locking the whole booking row means two *different* seats of the
 * same booking cannot be issued and verified concurrently by different
 * requests - they serialise on this lock rather than running in parallel.
 * That is deliberate: the alternative is locking nothing shared, which is
 * exactly what lets a ticket be issued for a booking that is committing its
 * own cancellation one row-lock-wait away.
 */
export async function issueTicketsInTransaction(
  client: PoolClient,
  input: IssueTicketsInput,
  requestId: string | undefined,
): Promise<IssueTicketsResult> {
  const booking = await lockBookingForTickets(client, input.bookingId);

  if (booking === null) {
    logger.warn('Rejected ticket issuance', {
      requestId,
      bookingId: input.bookingId,
      reason: 'BOOKING_NOT_FOUND',
    });
    throw bookingNotFound();
  }

  const isOwner = booking.userId === input.userId;
  const isAdmin = input.userRole === 'admin';
  const isEventOrganiser = input.userRole === 'organiser' && booking.eventOrganiserId === input.userId;

  if (!isOwner && !isAdmin && !isEventOrganiser) {
    logger.warn('Rejected ticket issuance', {
      requestId,
      bookingId: input.bookingId,
      userId: input.userId,
      reason: 'BOOKING_NOT_OWNED',
    });
    throw bookingNotFound();
  }

  if (booking.status !== 'confirmed') {
    logger.warn('Rejected ticket issuance', {
      requestId,
      bookingId: input.bookingId,
      reason: 'BOOKING_NOT_CONFIRMED',
    });
    throw new ConflictError('Only a confirmed booking can have tickets issued', {
      reason: booking.status === 'cancelled' ? 'BOOKING_CANCELLED' : 'BOOKING_INVALID',
    });
  }

  const { tickets, created } = await ensureTicketsForBooking(client, input.bookingId, requestId);

  if (!created) {
    logger.warn('Rejected ticket issuance', {
      requestId,
      bookingId: input.bookingId,
      reason: 'TICKETS_ALREADY_ISSUED',
    });
    throw new ConflictError('Tickets have already been issued for this booking', {
      reason: 'TICKETS_ALREADY_ISSUED',
    });
  }

  logger.info('Issued tickets', {
    requestId,
    bookingId: input.bookingId,
    eventId: booking.eventId,
    ticketCount: tickets.length,
  });

  return { bookingId: input.bookingId, eventId: booking.eventId, tickets };
}

/**
 * Accepts a ticket for entry: `issued` -> `used`, exactly once.
 *
 * THE DOUBLE-SCAN GUARANTEE lives entirely in `markTicketUsed`'s guarded
 * UPDATE - see its doc comment. Fifty concurrent calls here for the same
 * ticket produce exactly one row with `status = 'used'` and forty-nine that
 * observe it already used, because PostgreSQL's row lock on the UPDATE target
 * is the serialisation point, not anything in this function.
 *
 * THE CANCELLATION RACE is what the rest of this function exists for. The
 * booking is looked up and locked with the same `lockBookingForTickets` call
 * issuance uses, *before* the ticket is touched:
 *
 *   - If a cancellation already holds the lock, this blocks until it commits
 *     or rolls back, then reads the booking's true, final status. A committed
 *     cancellation is seen as `cancelled` and verification is refused - the
 *     ticket is left exactly as it was, still `issued`, never forced to
 *     `void`, because the booking's status is what makes it unusable and
 *     nothing on the ticket row needs to change to express that.
 *   - If this acquires the lock first, a concurrent cancellation blocks behind
 *     it. This function reads `confirmed`, accepts the ticket, and commits -
 *     releasing the lock. Cancellation then proceeds, but `hasUsedTickets`
 *     (called under the same lock cancellation just acquired) now finds the
 *     ticket this transaction just marked `used`, and refuses to cancel.
 *
 * Either way, `bookings.status = 'cancelled' AND tickets.status = 'used'` is
 * unreachable for this ticket - not merely unlikely.
 *
 * RESOURCE AUTHORIZATION. `lockBookingForTickets` already resolves the
 * event's organiser as part of the same lookup ticket issuance uses it for,
 * so verification spends no extra round trip to also require the caller be
 * *that* event's organiser (or an admin) - not merely *an* organiser, which
 * is all the route's role gate can tell. An organiser who does not own this
 * ticket's event gets exactly `TICKET_NOT_FOUND`, before the ticket row is
 * touched at all, so they learn nothing about it - not its state, not
 * whether it has been used - by probing a ticket id that is not theirs.
 *
 * No Idempotency-Key: a retried scan is not the same request as the first
 * one succeeding. The state machine already answers a retry correctly and
 * distinctly - `TICKET_ALREADY_USED` - which is the honest answer to "was
 * this ticket already accepted", not a replay of someone else's success.
 */
export async function verifyTicketInTransaction(
  client: PoolClient,
  input: VerifyTicketInput,
  requestId: string | undefined,
): Promise<VerifyTicketResult> {
  const bookingId = await findTicketBookingId(client, input.ticketId);
  if (bookingId === null) {
    logger.warn('Rejected ticket verification', {
      requestId,
      ticketId: input.ticketId,
      reason: 'TICKET_NOT_FOUND',
    });
    throw ticketNotFound();
  }

  const booking = await lockBookingForTickets(client, bookingId);
  if (booking === null) {
    // Unreachable: tickets.booking_id is ON DELETE RESTRICT against bookings.
    logger.error('Ticket references a booking that no longer exists', {
      requestId,
      ticketId: input.ticketId,
      bookingId,
    });
    throw ticketNotFound();
  }

  if (input.userRole !== 'admin' && booking.eventOrganiserId !== input.userId) {
    // Resource authorization: role gets an organiser/admin this far (see
    // ticket.routes.ts), but being *an* organiser does not mean owning *this*
    // ticket's event. Checked before the booking-status check and before the
    // ticket is even read, so an organiser who does not own this event learns
    // nothing about it - not even whether it has already been used - and
    // gets the same answer as a ticket id that does not exist at all.
    logger.warn('Rejected ticket verification', {
      requestId,
      ticketId: input.ticketId,
      bookingId,
      userId: input.userId,
      reason: 'TICKET_NOT_OWNED',
    });
    throw ticketNotFound();
  }

  if (booking.status !== 'confirmed') {
    // The booking is authoritative: rejected here, under its lock, before the
    // ticket row is even read. The ticket keeps whatever status it already
    // had - there is no `void` transition to make, because "the booking says
    // no" is already sufficient and does not need restating on the ticket.
    logger.warn('Rejected ticket verification', {
      requestId,
      ticketId: input.ticketId,
      bookingId,
      reason: 'BOOKING_CANCELLED',
    });
    throw new ConflictError('This booking has been cancelled; the ticket cannot be verified', {
      reason: 'BOOKING_CANCELLED',
    });
  }

  const used = await markTicketUsed(client, input.ticketId);

  if (used === null) {
    // Zero rows: the ticket exists (we already resolved its booking above)
    // but was not `issued`. One diagnostic read to say which, without
    // guessing - the caller needs to know "already used" from "void" to act
    // correctly at the door.
    const current = await findTicketById(client, input.ticketId);
    const reason =
      current?.status === 'used'
        ? 'TICKET_ALREADY_USED'
        : current?.status === 'void'
          ? 'TICKET_VOID'
          : 'TICKET_INVALID';

    logger.warn('Rejected ticket verification', { requestId, ticketId: input.ticketId, bookingId, reason });

    throw new ConflictError(
      reason === 'TICKET_ALREADY_USED' ? 'This ticket has already been used' : 'This ticket cannot be verified',
      { reason },
    );
  }

  const context = await findTicketVerificationContext(client, input.ticketId);
  if (context === null) {
    throw new Error('Ticket verification context disappeared after acceptance');
  }

  logger.info('Verified ticket', {
    requestId,
    ticketId: used.id,
    bookingId,
    eventId: context.eventId,
  });

  return { ticket: used, eventId: context.eventId, showSeatId: context.showSeatId };
}

/**
 * Standalone entry point for verification: runs in a transaction of its own.
 * There is no idempotency wrapper to share one with, unlike issuance - see
 * the "no Idempotency-Key" note above.
 */
export async function verifyTicket(
  input: VerifyTicketInput,
  requestId: string | undefined,
): Promise<VerifyTicketResult> {
  return withTransaction((client) => verifyTicketInTransaction(client, input, requestId));
}
