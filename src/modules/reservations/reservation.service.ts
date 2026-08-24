import type { PoolClient } from 'pg';

import { withTransaction } from '../../db/pool.js';
import { BadRequestError, ConflictError, NotFoundError } from '../../errors/app-error.js';
import type { CreateHoldInput, CreateHoldResult, UnavailableSeat } from './reservation-hold.types.js';
import {
  enqueueHoldExpiration,
  eventExists,
  expireLapsedHoldsForSeats,
  findExistingSeatIds,
  insertHold,
  insertHoldSeats,
  lockEventSeats,
  markSeatsHeld,
  readSeatAvailability,
  releaseSeatsWithoutLiveHold,
  userExists,
} from './reservation.repository.js';

/**
 * Sorts seat ids so every request presents them in the same order.
 *
 * The lock order that actually matters is imposed by `ORDER BY ss.id` in the
 * locking query, which PostgreSQL applies with its own uuid comparison. Sorting
 * here as well keeps the array parameter, the response and any error detail in
 * that same order, so what the client sees matches what the database did. For
 * lowercase hyphenated uuids JavaScript's string ordering and PostgreSQL's
 * byte-wise uuid ordering agree, so the two never disagree in practice.
 */
function sortSeatIds(showSeatIds: readonly string[]): string[] {
  return [...showSeatIds].sort();
}

function describeUnavailable(seats: readonly UnavailableSeat[]): string {
  const booked = seats.filter((seat) => seat.reason === 'booked').length;
  const held = seats.length - booked;
  const parts: string[] = [];
  if (held > 0) parts.push(`${held} already held`);
  if (booked > 0) parts.push(`${booked} already booked`);
  return `Requested seats are not available (${parts.join(', ')})`;
}

/**
 * Places a temporary hold on every requested seat, or on none of them.
 *
 * The whole operation is one transaction:
 *
 *   BEGIN
 *     verify the event exists
 *     verify the user exists
 *     lock the requested seats FOR UPDATE, in id order, scoped to the event
 *     verify every requested seat came back (exists, and belongs to the event)
 *     expire any lapsed holds covering those seats, and free the seats
 *     re-read availability; abort if any seat is still taken
 *     insert the hold with a database-computed expires_at
 *     insert the hold/seat links
 *     flip the seats to held
 *     queue the expiration event in the outbox
 *   COMMIT
 *
 * Atomicity is not something this function implements - it is what the
 * transaction gives us. Every rejection below throws, `withTransaction` issues
 * ROLLBACK, and the database discards every write the attempt made. There is no
 * compensating cleanup path to get wrong, and no window in which some seats are
 * held and others are not: concurrent readers see either the state before the
 * request or the state after it.
 */
export async function createHoldInTransaction(
  client: PoolClient,
  input: CreateHoldInput,
): Promise<CreateHoldResult> {
  const showSeatIds = sortSeatIds(input.showSeatIds);

  if (!(await eventExists(client, input.eventId))) {
    throw new NotFoundError('Event not found');
  }

  // Checked in-transaction rather than trusted from the request. Until
  // authentication exists this is the only thing standing between a typo and
  // a hold owned by nobody; the foreign key would catch it too, but a clear
  // 404 beats a constraint violation surfacing as a 500.
  if (!(await userExists(client, input.userId))) {
    throw new NotFoundError('User not found');
  }

  // From here on the requested seats are locked: no other transaction can
  // decide anything about them until this one ends.
  const locked = await lockEventSeats(client, input.eventId, showSeatIds);

  if (locked.length !== showSeatIds.length) {
    const returned = new Set(locked.map((seat) => seat.id));
    const missing = showSeatIds.filter((id) => !returned.has(id));
    const existing = new Set(await findExistingSeatIds(client, missing));

    // A seat that exists but did not come back belongs to a different event:
    // a bad selection (400), not a missing resource (404).
    const wrongEvent = missing.filter((id) => existing.has(id));
    if (wrongEvent.length > 0) {
      throw new BadRequestError('Requested seats do not belong to this event', {
        showSeatIds: wrongEvent,
      });
    }

    throw new NotFoundError('Requested seats do not exist', { showSeatIds: missing });
  }

  // Reclaim anything whose time is up. Both halves happen here, under the
  // seat locks, so the expired hold and the freed seat become visible to
  // everyone else at the same instant - at COMMIT.
  await expireLapsedHoldsForSeats(client, showSeatIds);
  await releaseSeatsWithoutLiveHold(client, showSeatIds);

  const availability = await readSeatAvailability(client, showSeatIds);
  const unavailable: UnavailableSeat[] = availability
    .filter((seat) => seat.status !== 'available' || seat.liveHold)
    .map((seat) => ({
      showSeatId: seat.id,
      reason: seat.status === 'booked' ? 'booked' : 'held',
    }));

  // All-or-nothing: one taken seat rejects the entire selection.
  if (unavailable.length > 0) {
    throw new ConflictError(describeUnavailable(unavailable), { unavailableSeats: unavailable });
  }

  const hold = await insertHold(client, input.eventId, input.userId, input.ttlSeconds);

  const linked = await insertHoldSeats(client, hold.id, showSeatIds);
  if (linked !== showSeatIds.length) {
    // Unreachable unless the insert silently dropped rows; refuse to commit a
    // hold that does not cover everything the customer asked for.
    throw new Error(`Expected ${showSeatIds.length} hold seat rows, inserted ${linked}`);
  }

  const heldCount = await markSeatsHeld(client, showSeatIds);
  if (heldCount !== showSeatIds.length) {
    throw new Error(`Expected to hold ${showSeatIds.length} seats, updated ${heldCount}`);
  }

  // Durable intent to publish the Redis expiration signal, committed with
  // everything above. Nothing here talks to Redis: the customer's request is
  // answered on PostgreSQL alone, so a Redis outage cannot fail a reservation
  // the database already accepted, and cannot add its latency to the response
  // either. The worker publishes afterwards.
  await enqueueHoldExpiration(client, hold.id);

  return {
    holdId: hold.id,
    eventId: input.eventId,
    showSeatIds,
    status: 'active',
    expiresAt: hold.expiresAt,
  };
}

/**
 * Standalone entry point: runs {@link createHoldInTransaction} in a transaction
 * of its own. Callers that need the hold to commit together with other work -
 * the idempotency record, for instance - pass their own client to
 * `createHoldInTransaction` instead, so everything shares one COMMIT.
 */
export async function createHold(input: CreateHoldInput): Promise<CreateHoldResult> {
  return withTransaction((client) => createHoldInTransaction(client, input));
}
