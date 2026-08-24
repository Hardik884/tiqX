import type { PoolClient } from 'pg';

import { config } from '../../config/index.js';
import { withTransaction } from '../../db/pool.js';
import { ConflictError, NotFoundError } from '../../errors/app-error.js';
import { getRedis } from '../../redis/client.js';
import { holdExpiryKey } from '../../redis/keys.js';
import { logger } from '../../utils/logger.js';
import { releaseSeatsWithoutLiveHold } from '../reservations/reservation.repository.js';
import { enqueueOfferNotification, enqueueWaitlistAllocationForSeats } from '../waitlist/waitlist-outbox.repository.js';
import { markEntryExpired, markOfferExpiredByHoldId } from '../waitlist/waitlist.repository.js';
import type { WaitlistOfferNotificationPayload } from '../waitlist/waitlist.types.js';
import {
  claimPendingOutboxRows,
  findActiveHoldsExpiringWithin,
  findDueHoldIds,
  findHoldSeatIds,
  lockHold,
  lockSeats,
  markHoldCancelled,
  markHoldExpired,
  markOutboxProcessed,
  recordOutboxFailure,
} from './expiration.repository.js';

export interface PublishResult {
  claimed: number;
  published: number;
  failed: number;
}

export interface SweepResult {
  examined: number;
  expired: number;
  /** Holds already resolved by someone else - expected, not an error. */
  noop: number;
}

export interface ReconcileResult {
  examined: number;
  restored: number;
}

/**
 * Writes the Redis expiration signal for one hold.
 *
 * The TTL is derived from PostgreSQL's own `expires_at` minus PostgreSQL's own
 * `now()`, computed in the query that read the row. The application's wall
 * clock never participates: a worker running minutes fast would otherwise set
 * keys that lapse early, and one running slow would set keys that outlive the
 * hold.
 *
 * The value is the hold id. It carries nothing sensitive, and it means a key
 * found in redis-cli explains itself.
 */
async function writeExpiryKey(holdId: string, ttlSeconds: number): Promise<void> {
  await getRedis().set(holdExpiryKey(holdId), holdId, 'EX', ttlSeconds);
}

/**
 * Publishes pending outbox events to Redis.
 *
 * The claim, the Redis write and the bookkeeping share one transaction, so the
 * row stays locked for the whole attempt and no second worker can duplicate the
 * work in flight. That does hold a PostgreSQL transaction open across a network
 * call, which is normally worth avoiding; it is acceptable here because the
 * client is configured to fail fast rather than buffer, so the call cannot hang
 * indefinitely, and the alternative - commit a claim, then publish, then commit
 * again - widens the window in which a crash loses track of the row.
 *
 * DELIVERY IS AT-LEAST-ONCE, not exactly-once, and cannot be made otherwise:
 * the worker can set the key and die before recording that it did, after which
 * the row is claimed again. That is harmless because SET is idempotent, and so
 * is the expiry transition it eventually leads to. Nothing here should be read
 * as a claim of exactly-once processing.
 */
export async function publishPendingExpirations(): Promise<PublishResult> {
  return withTransaction(async (client) => {
    const rows = await claimPendingOutboxRows(client, config.expiration.outboxBatchSize);
    const result: PublishResult = { claimed: rows.length, published: 0, failed: 0 };

    for (const row of rows) {
      try {
        await writeExpiryKey(row.holdId, row.ttlSeconds);
        await markOutboxProcessed(client, row.id);
        result.published += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        // The row is not marked processed, so it will be retried. Only the
        // driver's message is recorded - never the Redis URL, which can carry
        // a password.
        await recordOutboxFailure(
          client,
          row.id,
          message,
          config.expiration.outboxRetryBaseMs,
          config.expiration.outboxRetryMaxMs,
        );
        result.failed += 1;

        logger.warn('Failed to publish hold expiration signal, will retry', {
          outboxId: row.id,
          holdId: row.holdId,
          attempts: row.attempts + 1,
          error: message,
        });
      }
    }

    if (result.published > 0) {
      logger.info('Published hold expiration signals', {
        published: result.published,
        failed: result.failed,
      });
    }

    return result;
  });
}

/**
 * The transactional core of {@link expireHold}, usable by a caller that
 * already owns the transaction.
 *
 * LOCK ORDER: seats first, in ascending id order, then the hold. This is the
 * same order the reservation path takes, and matching it is what prevents a
 * deadlock - two transactions that take the same two locks in opposite orders
 * will eventually cycle, and PostgreSQL will kill one of them. Since the
 * caller naturally starts from a hold and the reservation naturally starts
 * from seats, getting this backwards would be the easy mistake.
 *
 * Everything after the locks happens in one transaction, so no observer ever
 * sees the half-state where the hold reads expired but its seats still read
 * held.
 *
 * IDEMPOTENT BY DESIGN. The reservation path already reclaims lapsed holds
 * opportunistically, so the worker regularly arrives to find the work done -
 * and two workers may pick the same candidate. A hold that is missing,
 * cancelled, converted, or already expired is a no-op, not an error: whoever
 * took the lock first performed the transition, and the loser simply agrees.
 *
 * Nothing here is waitlist-specific except the last two lines, and they are
 * deliberately generic rather than conditional on "was this hold backing an
 * offer": every seat this function frees is a fresh opportunity for whoever
 * is queued for its category, whether the hold that lapsed was an ordinary
 * customer's or a waitlist offer's. `enqueueWaitlistAllocationForSeats` is a
 * no-op for an event with no waitlist activity, so this costs nothing extra
 * on the overwhelmingly common path where nobody is waiting.
 *
 * `markOfferExpiredByHoldId`/`markEntryExpired` are the one part that IS
 * conditional - bookkeeping for the waitlist's own state, not for seat
 * release, which has already happened by the time they run. The entry moves
 * to `expired` alongside its offer, deliberately not back to `waiting`: see
 * the waitlist migration's top comment for why a lapsed offer does not
 * re-queue its holder. See waitlist_offers in the waitlist migration
 * for why an offer's expiry rides this sweep instead of a dedicated one: both
 * `POST /waitlist/offers/:offerId/accept` and this function reach
 * `reservation_holds` through the identical lock order - seats, then the hold
 * - and only touch `waitlist_offers` afterwards, which is what makes
 * acceptance and expiry serialise on the hold instead of being able to
 * deadlock against each other. See waitlist.service.ts::acceptWaitlistOffer.
 */
export async function expireHoldInTransaction(
  client: PoolClient,
  holdId: string,
): Promise<'expired' | 'noop'> {
  const seatIds = await findHoldSeatIds(client, holdId);

  // Seats first, ascending - matching the reservation path exactly.
  await lockSeats(client, seatIds);

  const hold = await lockHold(client, holdId);

  if (hold === null || hold.status !== 'active' || !hold.due) {
    // Gone, already resolved, or not actually due. The last case matters:
    // a Redis key can lapse early or a signal arrive stale, and PostgreSQL
    // gets the final say on whether the hold has really expired.
    return 'noop';
  }

  const changed = await markHoldExpired(client, holdId);
  if (!changed) {
    return 'noop';
  }

  // Reuses the reservation path's own release rule, which only frees a seat
  // that no *live* active hold still covers. Our hold is no longer live, so
  // its seats are freed; a seat somehow claimed by another live hold is left
  // alone rather than being handed to nobody.
  const released = await releaseSeatsWithoutLiveHold(client, seatIds);

  logger.info('Expired hold and released seats', {
    holdId,
    seats: seatIds.length,
    released: released.length,
  });

  await enqueueWaitlistAllocationForSeats(client, released);

  const expiredOffer = await markOfferExpiredByHoldId(client, holdId);
  if (expiredOffer !== null) {
    if (!(await markEntryExpired(client, expiredOffer.waitlistEntryId))) {
      throw new Error('Waitlist entry was no longer offered when its offer expired');
    }

    const payload: WaitlistOfferNotificationPayload = {
      v: 1,
      offerId: expiredOffer.id,
      waitlistEntryId: expiredOffer.waitlistEntryId,
      userId: hold.userId,
      eventId: hold.eventId,
      showSeatId: expiredOffer.showSeatId,
      expiresAt: expiredOffer.expiresAt.toISOString(),
    };
    await enqueueOfferNotification(client, expiredOffer.id, 'WAITLIST_OFFER_EXPIRED', payload);

    logger.info('Waitlist offer expired', {
      offerId: expiredOffer.id,
      waitlistEntryId: expiredOffer.waitlistEntryId,
      holdId,
    });
  }

  return 'expired';
}

export async function expireHold(holdId: string): Promise<'expired' | 'noop'> {
  return withTransaction((client) => expireHoldInTransaction(client, holdId));
}

/** A hold that does not exist, is not this caller's, or belongs to a different event. */
function holdNotFound(): NotFoundError {
  return new NotFoundError('Hold not found', { reason: 'HOLD_NOT_FOUND' });
}

export interface CancelHoldInput {
  eventId: string;
  holdId: string;
  /** Always the authenticated principal; never a value from the request body. */
  userId: string;
}

/**
 * Voluntarily releases the caller's own still-active hold, before it is
 * confirmed or has expired - "I changed my mind about these seats," not a
 * cleanup path. Everything below is `expireHoldInTransaction` with two
 * differences: the transition lands on `cancelled` instead of `expired` (see
 * `markHoldCancelled`), and there is an ownership check first, because unlike
 * the sweep - which acts on any due hold with no caller to speak of - this is
 * reached from a customer's own request and must not let them touch a hold
 * that is not theirs.
 *
 * LOCK ORDER: seats first, ascending id, then the hold - identical to every
 * other path that touches `reservation_holds`, for the same deadlock-avoidance
 * reason documented there.
 *
 * The waitlist bookkeeping at the end exists for the same reason it does in
 * `expireHoldInTransaction`: a hold backing a live offer that goes away for
 * any reason - time running out, or its holder giving it up early - ends that
 * offer. In practice a customer's own browse-and-hold flow never reaches a
 * waitlist-offer hold (offers are created by the allocation worker, not by
 * `POST /events/:eventId/holds`), so this branch is normally a no-op; it is
 * kept so the invariant "an offer never outlives its backing hold" holds
 * regardless of why the hold ended.
 */
export async function cancelHoldInTransaction(
  client: PoolClient,
  input: CancelHoldInput,
): Promise<{ releasedSeatCount: number }> {
  const seatIds = await findHoldSeatIds(client, input.holdId);

  // Seats first, ascending - matching the reservation and expiry paths.
  await lockSeats(client, seatIds);

  const hold = await lockHold(client, input.holdId);

  if (hold === null || hold.userId !== input.userId || hold.eventId !== input.eventId) {
    // Not found, not owned, or under the wrong event all answer identically -
    // the same conflation `confirmHoldInTransaction` documents for its own
    // ownership check, and for the same reason: a caller has no legitimate
    // way to tell these apart, and letting them try turns the endpoint into
    // an oracle for which hold ids exist.
    throw holdNotFound();
  }

  if (hold.status !== 'active') {
    throw new ConflictError('This hold is no longer active', { reason: 'HOLD_NOT_ACTIVE' });
  }

  const changed = await markHoldCancelled(client, input.holdId);
  if (!changed) {
    // Unreachable under the lock just taken above, unless something else in
    // this same transaction already moved the hold - kept as a hard failure
    // rather than a silent success either way.
    throw new ConflictError('This hold is no longer active', { reason: 'HOLD_NOT_ACTIVE' });
  }

  const released = await releaseSeatsWithoutLiveHold(client, seatIds);

  logger.info('Cancelled hold and released seats', {
    holdId: input.holdId,
    userId: input.userId,
    seats: seatIds.length,
    released: released.length,
  });

  await enqueueWaitlistAllocationForSeats(client, released);

  const expiredOffer = await markOfferExpiredByHoldId(client, input.holdId);
  if (expiredOffer !== null) {
    if (!(await markEntryExpired(client, expiredOffer.waitlistEntryId))) {
      throw new Error('Waitlist entry was no longer offered when its offer was cancelled');
    }

    const payload: WaitlistOfferNotificationPayload = {
      v: 1,
      offerId: expiredOffer.id,
      waitlistEntryId: expiredOffer.waitlistEntryId,
      userId: hold.userId,
      eventId: hold.eventId,
      showSeatId: expiredOffer.showSeatId,
      expiresAt: expiredOffer.expiresAt.toISOString(),
    };
    await enqueueOfferNotification(client, expiredOffer.id, 'WAITLIST_OFFER_EXPIRED', payload);
  }

  return { releasedSeatCount: released.length };
}

export async function cancelHold(input: CancelHoldInput): Promise<{ releasedSeatCount: number }> {
  return withTransaction((client) => cancelHoldInTransaction(client, input));
}

/**
 * Finds holds whose time is up and expires them.
 *
 * This is the authoritative detection path, and it reads PostgreSQL. Redis key
 * expiry is not consulted, because an expired Redis key is not a durable
 * message: it can be evicted, lost to a flush, or missed entirely if no
 * listener happens to be connected. Correctness cannot rest on a signal with
 * those properties, so the signal is an optimisation and the database is the
 * clock.
 */
export async function sweepExpiredHolds(): Promise<SweepResult> {
  const holdIds = await withTransaction((client) =>
    findDueHoldIds(client, config.expiration.sweepBatchSize),
  );

  const result: SweepResult = { examined: holdIds.length, expired: 0, noop: 0 };

  for (const holdId of holdIds) {
    const outcome = await expireHold(holdId);
    if (outcome === 'expired') {
      result.expired += 1;
      // Cleanup only. The database transition above is the real operation, so
      // a failure here is logged and left for a later pass rather than being
      // allowed to undo anything.
      await deleteExpiryKey(holdId);
    } else {
      result.noop += 1;
    }
  }

  return result;
}

/**
 * Removes a hold's expiration key.
 *
 * Never throws. The PostgreSQL transition has already committed by the time
 * this runs, and rolling that back because a cleanup command failed would trade
 * a stale key for a stuck seat. A leftover key is harmless - nothing reads it
 * to make a decision, and it lapses on its own.
 */
export async function deleteExpiryKey(holdId: string): Promise<boolean> {
  try {
    await getRedis().del(holdExpiryKey(holdId));
    return true;
  } catch (error) {
    logger.warn('Could not delete hold expiration key; it will lapse on its own', {
      holdId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * Restores expiration keys that PostgreSQL expects but Redis does not have.
 *
 * The outbox closes the window between committing a hold and publishing its
 * signal, but it cannot cover what happens to the key afterwards: Redis may be
 * flushed, evicted under memory pressure, restarted without persistence, or
 * failed over to an empty replica. In every case PostgreSQL still holds the
 * truth, and this loop puts the signal back.
 *
 * Bounded by a look-ahead window and a batch size, and served by the existing
 * partial index on active holds, so it never scans the whole table.
 *
 * Note what is *not* required for correctness: if this never ran, the sweep
 * would still expire every hold on time, because the sweep reads PostgreSQL.
 * Reconciliation keeps the Redis view honest; it does not keep the system
 * correct.
 */
export async function reconcileExpiryKeys(): Promise<ReconcileResult> {
  const holds = await withTransaction((client) =>
    findActiveHoldsExpiringWithin(
      client,
      config.expiration.reconcileWindowSeconds,
      config.expiration.reconcileBatchSize,
    ),
  );

  const result: ReconcileResult = { examined: holds.length, restored: 0 };
  if (holds.length === 0) {
    return result;
  }

  const redis = getRedis();

  for (const hold of holds) {
    const key = holdExpiryKey(hold.id);

    if ((await redis.exists(key)) === 1) {
      continue;
    }

    await writeExpiryKey(hold.id, hold.ttlSeconds);
    result.restored += 1;
  }

  if (result.restored > 0) {
    logger.warn('Restored missing hold expiration keys', {
      examined: result.examined,
      restored: result.restored,
    });
  }

  return result;
}
