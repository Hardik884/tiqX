import type { PoolClient } from 'pg';

import { config } from '../../config/index.js';
import { PG_ERROR, pgErrorCode, pgErrorConstraint } from '../../db/pg-error.js';
import { withTransaction } from '../../db/pool.js';
import { ConflictError, NotFoundError } from '../../errors/app-error.js';
import { logger } from '../../utils/logger.js';
import { confirmHoldInTransaction } from '../bookings/booking.service.js';
import { createHoldInTransaction } from '../reservations/reservation.service.js';
import type { SeatCategory } from '../events/event.types.js';
import { findEventStatus } from '../events/event.repository.js';
import {
  categoryExistsForEvent,
  findAvailableSeatIdsForCategory,
  findOfferForAcceptance,
  findWaitlistEntryById,
  insertWaitlistEntry,
  insertWaitlistOffer,
  lockNextWaitingEntry,
  markEntryAccepted,
  markEntryCancelled,
  markEntryOffered,
  markOfferAccepted,
} from './waitlist.repository.js';
import { enqueueOfferNotification } from './waitlist-outbox.repository.js';
import type {
  AcceptOfferInput,
  AcceptOfferResult,
  JoinWaitlistInput,
  JoinWaitlistResult,
  LeaveWaitlistInput,
  WaitlistEntryRecord,
  WaitlistOfferNotificationPayload,
} from './waitlist.types.js';

/**
 * A waitlist entry that does not exist or is not yours.
 *
 * Same reasoning as `holdNotFound`/`bookingNotFound` in booking.service.ts:
 * one answer for "no such entry" and "someone else's entry" so the endpoint
 * cannot be used to probe who else is queued for an event.
 */
function entryNotFound(): NotFoundError {
  return new NotFoundError('Waitlist entry not found', { reason: 'WAITLIST_ENTRY_NOT_FOUND' });
}

function offerNotFound(): NotFoundError {
  return new NotFoundError('Waitlist offer not found', { reason: 'WAITLIST_OFFER_NOT_FOUND' });
}

/**
 * Joins the waitlist for one event and seat category.
 *
 * VALIDATION, in the order the task's own spec lists it:
 *
 *   event exists                       -> 404
 *   event is publicly joinable         -> 409 (only `published` events are)
 *   seat category exists for the event -> 404 (a valid category name that this
 *                                          venue simply has none of)
 *   not already actively waiting       -> 409, enforced by the database
 *
 * NOT VALIDATED: current seat availability. The task's own spec is explicit
 * that a join must not be made impossible by a seat freeing up between a
 * check and this transaction, and does not list availability among the
 * checks to make - only the four above. A customer choosing to queue for a
 * category that happens to have seats open right now costs the system
 * nothing; the allocation pass below is what decides who actually gets one.
 *
 * THE RACE THAT MATTERS: two concurrent joins for the same user, event and
 * category. Both can pass every check above and both attempt the INSERT; only
 * one can win `waitlist_entries_active_membership_key`, a partial unique
 * index, and the loser's constraint violation is mapped to the same 409 a
 * client would get from trying again after seeing the first one succeed - see
 * `PG_ERROR.UNIQUE_VIOLATION` below. No `SELECT` precedes the `INSERT` for
 * this reason: a check-then-insert has a window this index closes for free.
 */
export async function joinWaitlistInTransaction(
  client: PoolClient,
  input: JoinWaitlistInput,
  requestId: string | undefined,
): Promise<JoinWaitlistResult> {
  const eventStatus = await findEventStatus(client, input.eventId);
  if (eventStatus === null) {
    throw new NotFoundError('Event not found');
  }
  if (eventStatus !== 'published') {
    logger.warn('Rejected waitlist join', {
      requestId,
      eventId: input.eventId,
      userId: input.userId,
      reason: 'EVENT_NOT_JOINABLE',
    });
    throw new ConflictError('This event is not open for waitlisting', {
      reason: 'EVENT_NOT_JOINABLE',
    });
  }

  if (!(await categoryExistsForEvent(client, input.eventId, input.seatCategory))) {
    throw new NotFoundError('This event has no seats of that category', {
      reason: 'CATEGORY_NOT_FOUND',
    });
  }

  try {
    const entry = await insertWaitlistEntry(client, {
      eventId: input.eventId,
      userId: input.userId,
      seatCategory: input.seatCategory,
    });

    logger.info('Joined waitlist', {
      requestId,
      waitlistEntryId: entry.id,
      eventId: input.eventId,
      seatCategory: input.seatCategory,
    });

    return { entry };
  } catch (error) {
    if (
      pgErrorCode(error) === PG_ERROR.UNIQUE_VIOLATION &&
      pgErrorConstraint(error) === 'waitlist_entries_active_membership_key'
    ) {
      logger.warn('Rejected waitlist join', {
        requestId,
        eventId: input.eventId,
        userId: input.userId,
        reason: 'ALREADY_ON_WAITLIST',
      });
      throw new ConflictError('Already on the waitlist for this event and category', {
        reason: 'ALREADY_ON_WAITLIST',
      });
    }
    throw error;
  }
}

/**
 * Leaves the waitlist: `waiting` -> `cancelled`. Guarded on `status =
 * 'waiting'`, so an entry that has already been offered a seat cannot leave
 * this way - see `markEntryCancelled`. Not part of the task's required test
 * matrix, but part of the state machine it documents (`waiting -> cancelled`),
 * so it exists as the minimal endpoint that reaches it.
 */
export async function leaveWaitlistInTransaction(
  client: PoolClient,
  input: LeaveWaitlistInput,
  requestId: string | undefined,
): Promise<WaitlistEntryRecord> {
  const existing = await findWaitlistEntryById(client, input.entryId);

  if (existing === null || existing.userId !== input.userId) {
    throw entryNotFound();
  }

  if (existing.status !== 'waiting') {
    logger.warn('Rejected waitlist leave', {
      requestId,
      waitlistEntryId: input.entryId,
      reason: 'WAITLIST_ENTRY_NOT_WAITING',
      status: existing.status,
    });
    throw new ConflictError('This waitlist entry can no longer be left', {
      reason: 'WAITLIST_ENTRY_NOT_WAITING',
    });
  }

  const cancelled = await markEntryCancelled(client, input.entryId, input.userId);
  if (cancelled === null) {
    throw new Error('Waitlist entry was no longer waiting when leaving');
  }

  logger.info('Left waitlist', { requestId, waitlistEntryId: cancelled.id });

  return cancelled;
}

export async function leaveWaitlist(
  input: LeaveWaitlistInput,
  requestId?: string,
): Promise<WaitlistEntryRecord> {
  return withTransaction((client) => leaveWaitlistInTransaction(client, input, requestId));
}

/** How many (entry, seat) pairings one allocation pass will attempt at most. */
const MAX_PAIRINGS_PER_PASS = 500;

export interface AllocationPassResult {
  offersCreated: number;
  seatsRaced: number;
}

/**
 * Offers whatever seats are available in this event/category to whoever has
 * waited longest for one, pairing deterministically: seats ascending by id,
 * candidates in FIFO order, one offer per pairing, until either runs out.
 *
 * REUSES `createHoldInTransaction` VERBATIM to give the offer its seat. An
 * offer's seat lock, availability check and expiry all come from the same
 * hold machinery a normal reservation uses - see the waitlist migration's top
 * comment for why this is correct, not merely convenient. This function's own
 * job is entirely about *who* gets *which* seat and in *what order*; owning a
 * seat is `createHoldInTransaction`'s job, done identically either way.
 *
 * A SAVEPOINT wraps each attempted pairing. Without it, a single race lost to
 * an ordinary reservation - the seat this pass just read as available gets
 * claimed by someone else microseconds before `createHoldInTransaction`
 * re-locks it - would abort the whole pass, undoing every offer already made
 * to earlier candidates in the same loop. With it, only that one pairing rolls
 * back: the candidate's `offered` transition reverts to `waiting`, is still
 * held by this transaction's own lock, and is retried against a freshly read
 * seat list on the next iteration.
 *
 * Bounded by `MAX_PAIRINGS_PER_PASS` so a pathological run cannot spin
 * forever; ordinary termination is simply running out of waiting candidates
 * or available seats, whichever comes first.
 */
export async function runAllocationPass(
  client: PoolClient,
  eventId: string,
  seatCategory: SeatCategory,
  requestId: string | undefined,
): Promise<AllocationPassResult> {
  const result: AllocationPassResult = { offersCreated: 0, seatsRaced: 0 };

  for (let attempt = 0; attempt < MAX_PAIRINGS_PER_PASS; attempt += 1) {
    const entry = await lockNextWaitingEntry(client, eventId, seatCategory);
    if (entry === null) {
      break;
    }

    const [seatId] = await findAvailableSeatIdsForCategory(client, eventId, seatCategory, 1);
    if (seatId === undefined) {
      // No seat for this candidate right now. Leave the entry `waiting` -
      // still locked for the rest of this transaction, so a second candidate
      // further back in the queue cannot jump ahead of it within this same
      // pass - and let the loop end; a later signal picks up where this left
      // off.
      break;
    }

    await client.query('SAVEPOINT waitlist_pairing');
    try {
      if (!(await markEntryOffered(client, entry.id))) {
        throw new Error('Waitlist entry was no longer waiting when offering it a seat');
      }

      const hold = await createHoldInTransaction(client, {
        eventId,
        userId: entry.userId,
        showSeatIds: [seatId],
        ttlSeconds: config.waitlist.offerTtlSeconds,
      });

      const offer = await insertWaitlistOffer(client, {
        waitlistEntryId: entry.id,
        showSeatId: seatId,
        holdId: hold.holdId,
      });

      const payload: WaitlistOfferNotificationPayload = {
        v: 1,
        offerId: offer.id,
        waitlistEntryId: entry.id,
        userId: entry.userId,
        eventId,
        showSeatId: seatId,
        expiresAt: offer.expiresAt.toISOString(),
      };
      await enqueueOfferNotification(client, offer.id, 'WAITLIST_OFFER_CREATED', payload);

      await client.query('RELEASE SAVEPOINT waitlist_pairing');
      result.offersCreated += 1;

      logger.info('Waitlist offer created', {
        requestId,
        offerId: offer.id,
        waitlistEntryId: entry.id,
        eventId,
        seatCategory,
        showSeatId: seatId,
        expiresAt: offer.expiresAt.toISOString(),
      });
    } catch (error) {
      await client.query('ROLLBACK TO SAVEPOINT waitlist_pairing');

      // A seat this pass believed was available got claimed - by an ordinary
      // reservation, or another allocation pass for a seat overlap that
      // should not occur under the outbox's coalescing but is still handled
      // safely - between the read above and `createHoldInTransaction`'s own
      // lock. Not an error: retry the same candidate against a fresh read.
      if (error instanceof ConflictError) {
        result.seatsRaced += 1;
        logger.info('Waitlist candidate seat raced away, retrying', {
          requestId,
          waitlistEntryId: entry.id,
          eventId,
          seatCategory,
          showSeatId: seatId,
        });
        continue;
      }

      throw error;
    }
  }

  return result;
}

/**
 * Accepts a time-limited offer, converting it into a real booking through the
 * existing confirmation pipeline.
 *
 * REUSES `confirmHoldInTransaction` VERBATIM. This function's only job is
 * translation: check that the caller owns this offer, hand its backing hold
 * to the exact same code path a direct `POST .../holds/:holdId/confirm` call
 * would use, and afterwards stamp the waitlist-specific rows. Ownership of the
 * *seat* - is it still this hold's to confirm, has it expired, is it already
 * booked - is entirely `confirmHoldInTransaction`'s decision, made under its
 * own locks; this function does not re-check any of that itself; see the note
 * on lock order below for why not.
 *
 * `findOfferForAcceptance` is a plain, unlocked read used only to give an
 * honest 404 for an offer that does not exist or is not this caller's, before
 * doing any real work. It is not the authority on whether the offer can still
 * be accepted - the accept/expire race is decided entirely by
 * `confirmHoldInTransaction`'s own lock on `reservation_holds`.
 *
 * LOCK ORDER AND THE ACCEPT/EXPIRE RACE. `confirmHoldInTransaction` takes
 * `show_seats` then `reservation_holds`, exactly like
 * `expireHoldInTransaction` (see expiration.service.ts) does for the same
 * hold when the offer instead lapses. Both functions touch `waitlist_offers`
 * only *after* that lock is settled - accept via `markOfferAccepted` below,
 * expiry via `markOfferExpiredByHoldId`. So both paths take the same two locks
 * in the same order before either ever reaches `waitlist_offers`, and cannot
 * form a cycle: whichever transaction gets the hold lock first decides the
 * outcome, and the other's guarded UPDATE on `reservation_holds` (inside
 * `confirmHoldInTransaction`, or `markHoldExpired`) simply matches zero rows.
 * If accept loses, `confirmHoldInTransaction` throws with reason
 * `HOLD_EXPIRED` or `HOLD_INVALID`, translated below into `OFFER_EXPIRED`;
 * `HOLD_ALREADY_CONFIRMED` becomes `OFFER_ALREADY_ACCEPTED` for a second
 * accept attempt racing the first.
 */
export async function acceptWaitlistOfferInTransaction(
  client: PoolClient,
  input: AcceptOfferInput,
  requestId: string | undefined,
): Promise<AcceptOfferResult> {
  const found = await findOfferForAcceptance(client, input.offerId);

  if (found === null || found.entryUserId !== input.userId) {
    logger.warn('Rejected waitlist offer acceptance', {
      requestId,
      offerId: input.offerId,
      userId: input.userId,
      reason: found === null ? 'WAITLIST_OFFER_NOT_FOUND' : 'WAITLIST_OFFER_NOT_OWNED',
    });
    throw offerNotFound();
  }

  let confirmation;
  try {
    confirmation = await confirmHoldInTransaction(
      client,
      { userId: input.userId, eventId: found.eventId, holdId: found.offer.holdId },
      requestId,
    );
  } catch (error) {
    if (error instanceof ConflictError) {
      const reason = (error.details as { reason?: string } | undefined)?.reason;

      if (reason === 'HOLD_EXPIRED' || reason === 'HOLD_INVALID') {
        logger.warn('Rejected waitlist offer acceptance', {
          requestId,
          offerId: input.offerId,
          reason: 'OFFER_EXPIRED',
        });
        throw new ConflictError('This offer has expired', { reason: 'OFFER_EXPIRED' });
      }
      if (reason === 'HOLD_ALREADY_CONFIRMED') {
        logger.warn('Rejected waitlist offer acceptance', {
          requestId,
          offerId: input.offerId,
          reason: 'OFFER_ALREADY_ACCEPTED',
        });
        throw new ConflictError('This offer has already been accepted', {
          reason: 'OFFER_ALREADY_ACCEPTED',
        });
      }
    }
    throw error;
  }

  const acceptedOffer = await markOfferAccepted(client, found.offer.id);
  if (acceptedOffer === null) {
    // Unreachable in the ordinary flow: confirmHoldInTransaction just
    // converted this offer's hold, which only ever happens once, so nothing
    // else could have touched this offer first - see the lock-order note
    // above. A safety net, not a path any test should reach.
    throw new Error('Waitlist offer was no longer offered after its hold was confirmed');
  }

  if (!(await markEntryAccepted(client, acceptedOffer.waitlistEntryId))) {
    throw new Error('Waitlist entry was no longer offered after its offer was accepted');
  }

  logger.info('Waitlist offer accepted', {
    requestId,
    offerId: acceptedOffer.id,
    waitlistEntryId: acceptedOffer.waitlistEntryId,
    eventId: found.eventId,
    bookingId: confirmation.booking.id,
  });

  return {
    offer: acceptedOffer,
    eventId: found.eventId,
    bookingId: confirmation.booking.id,
    bookingReference: confirmation.booking.bookingReference,
  };
}
