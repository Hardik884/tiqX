import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { closePool, query } from '../src/db/pool.js';
import { AppError } from '../src/errors/app-error.js';
import { pgErrorCode } from '../src/db/pg-error.js';
import { createHold } from '../src/modules/reservations/reservation.service.js';
import { cleanupSeedData, seedCustomer, seedLapsedHold, seedShow } from './helpers/seed.js';

/** PostgreSQL raises this when it breaks a lock cycle. Must never happen here. */
const PG_DEADLOCK_DETECTED = '40P01';

interface Outcome {
  succeeded: number;
  conflicts: number;
  deadlocks: number;
  other: string[];
}

/**
 * Runs every attempt concurrently and classifies the results.
 *
 * `Promise.all` on already-started promises is what makes this a real test:
 * each `createHold` call opens its own pooled connection and its own
 * transaction, so PostgreSQL genuinely has to arbitrate between them. Awaiting
 * them one at a time would prove nothing.
 */
async function runConcurrently(attempts: readonly (() => Promise<unknown>)[]): Promise<Outcome> {
  const settled = await Promise.allSettled(attempts.map((attempt) => attempt()));

  const outcome: Outcome = { succeeded: 0, conflicts: 0, deadlocks: 0, other: [] };

  for (const result of settled) {
    if (result.status === 'fulfilled') {
      outcome.succeeded += 1;
    } else if (result.reason instanceof AppError && result.reason.statusCode === 409) {
      outcome.conflicts += 1;
    } else if (pgErrorCode(result.reason) === PG_DEADLOCK_DETECTED) {
      outcome.deadlocks += 1;
    } else {
      outcome.other.push(
        result.reason instanceof Error ? result.reason.message : String(result.reason),
      );
    }
  }

  return outcome;
}

/** How many unexpired active holds currently cover this seat. */
async function liveHoldsForSeat(showSeatId: string): Promise<number> {
  const result = await query<{ count: string }>(
    `SELECT count(*)::text AS count
     FROM reservation_hold_seats rhs
     JOIN reservation_holds h ON h.id = rhs.hold_id
     WHERE rhs.show_seat_id = $1 AND h.status = 'active' AND h.expires_at > now()`,
    [showSeatId],
  );
  return Number(result.rows[0]!.count);
}

async function seatStatus(showSeatId: string): Promise<string> {
  const result = await query<{ status: string }>(
    'SELECT status FROM show_seats WHERE id = $1',
    [showSeatId],
  );
  return result.rows[0]!.status;
}

async function countHolds(eventId: string): Promise<number> {
  const result = await query<{ count: string }>(
    'SELECT count(*)::text AS count FROM reservation_holds WHERE event_id = $1',
    [eventId],
  );
  return Number(result.rows[0]!.count);
}

after(async () => {
  await cleanupSeedData();
  await closePool();
});

describe('concurrent holds on the same seat', () => {
  it('lets exactly one of 50 simultaneous attempts win', async () => {
    const ATTEMPTS = 50;
    const { eventId, seats } = await seedShow(1);
    const seatId = seats[0]!.id;

    const users = await Promise.all(
      Array.from({ length: ATTEMPTS }, () => seedCustomer()),
    );

    const outcome = await runConcurrently(
      users.map((userId) => () =>
        createHold({ eventId, userId, showSeatIds: [seatId], ttlSeconds: 600 }),
      ),
    );

    assert.deepEqual(outcome.other, [], 'no unexpected failures');
    assert.equal(outcome.deadlocks, 0, 'no deadlocks');
    assert.equal(outcome.succeeded, 1, 'exactly one hold succeeds');
    assert.equal(outcome.conflicts, ATTEMPTS - 1, 'everyone else gets a conflict');

    // The database agrees with the API: one hold, one live claim, seat held.
    assert.equal(await countHolds(eventId), 1);
    assert.equal(await liveHoldsForSeat(seatId), 1, 'no duplicate active holds');
    assert.equal(await seatStatus(seatId), 'held');
  });
});

describe('concurrent holds on overlapping seats', () => {
  it('never produces a partial hold when two requests share a seat', async () => {
    const ROUNDS = 10;

    for (let round = 0; round < ROUNDS; round += 1) {
      const { eventId, seats } = await seedShow(3); // A12, A13, A14
      const [a12, a13, a14] = [seats[0]!.id, seats[1]!.id, seats[2]!.id];
      const userA = await seedCustomer();
      const userB = await seedCustomer();

      // Deliberately opposite orders in the request: the service sorts, and the
      // locking query orders by id, so both still take locks the same way.
      const outcome = await runConcurrently([
        () => createHold({ eventId, userId: userA, showSeatIds: [a12, a13], ttlSeconds: 600 }),
        () => createHold({ eventId, userId: userB, showSeatIds: [a14, a13], ttlSeconds: 600 }),
      ]);

      assert.deepEqual(outcome.other, [], `round ${round}: no unexpected failures`);
      assert.equal(outcome.deadlocks, 0, `round ${round}: no deadlocks`);
      assert.equal(outcome.succeeded, 1, `round ${round}: exactly one hold succeeds`);
      assert.equal(outcome.conflicts, 1, `round ${round}: the other conflicts`);

      // The contested seat has exactly one claim.
      assert.equal(await liveHoldsForSeat(a13), 1, `round ${round}: one claim on the shared seat`);

      // No partial hold: the winner holds both of its seats, and the loser's
      // exclusive seat is untouched.
      const held = await query<{ id: string }>(
        "SELECT id FROM show_seats WHERE event_id = $1 AND status = 'held' ORDER BY id",
        [eventId],
      );
      const heldIds = held.rows.map((row) => row.id).sort();
      const expectedA = [a12, a13].sort();
      const expectedB = [a13, a14].sort();
      assert.ok(
        JSON.stringify(heldIds) === JSON.stringify(expectedA) ||
          JSON.stringify(heldIds) === JSON.stringify(expectedB),
        `round ${round}: held seats ${JSON.stringify(heldIds)} are not a complete single hold`,
      );

      // Exactly one hold row, covering exactly two seats.
      assert.equal(await countHolds(eventId), 1, `round ${round}: one hold row`);
      const links = await query<{ count: string }>(
        'SELECT count(*)::text AS count FROM reservation_hold_seats rhs JOIN reservation_holds h ON h.id = rhs.hold_id WHERE h.event_id = $1',
        [eventId],
      );
      assert.equal(links.rows[0]!.count, '2', `round ${round}: two seat links`);
    }
  });

  it('lets disjoint requests succeed together', async () => {
    const { eventId, seats } = await seedShow(4); // A12..A15
    const [a12, a13, a14, a15] = [seats[0]!.id, seats[1]!.id, seats[2]!.id, seats[3]!.id];
    const userA = await seedCustomer();
    const userB = await seedCustomer();

    const outcome = await runConcurrently([
      () => createHold({ eventId, userId: userA, showSeatIds: [a12, a13], ttlSeconds: 600 }),
      () => createHold({ eventId, userId: userB, showSeatIds: [a14, a15], ttlSeconds: 600 }),
    ]);

    assert.deepEqual(outcome.other, []);
    assert.equal(outcome.deadlocks, 0);
    assert.equal(outcome.succeeded, 2, 'disjoint selections do not block each other out');
    assert.equal(outcome.conflicts, 0);

    assert.equal(await countHolds(eventId), 2);
    for (const seatId of [a12, a13, a14, a15]) {
      assert.equal(await seatStatus(seatId), 'held');
      assert.equal(await liveHoldsForSeat(seatId), 1);
    }
  });
});

describe('concurrent reclamation of a lapsed hold', () => {
  it('lets exactly one attempt reclaim the seat, expiring the old hold once', async () => {
    const ATTEMPTS = 20;
    const { eventId, seats } = await seedShow(1);
    const seatId = seats[0]!.id;
    const previousOwner = await seedCustomer();

    const lapsedHoldId = await seedLapsedHold(eventId, previousOwner, [seatId]);

    const users = await Promise.all(Array.from({ length: ATTEMPTS }, () => seedCustomer()));

    const outcome = await runConcurrently(
      users.map((userId) => () =>
        createHold({ eventId, userId, showSeatIds: [seatId], ttlSeconds: 600 }),
      ),
    );

    assert.deepEqual(outcome.other, [], 'no unexpected failures');
    assert.equal(outcome.deadlocks, 0, 'no deadlocks');
    // The first attempt through reclaims the seat; the rest meet its new hold.
    assert.equal(outcome.succeeded, 1, 'exactly one attempt reclaims the seat');
    assert.equal(outcome.conflicts, ATTEMPTS - 1);

    const old = await query<{ status: string }>(
      'SELECT status FROM reservation_holds WHERE id = $1',
      [lapsedHoldId],
    );
    assert.equal(old.rows[0]!.status, 'expired', 'the lapsed hold was transitioned exactly once');

    // One lapsed hold plus one new hold, and a single live claim on the seat.
    assert.equal(await countHolds(eventId), 2);
    assert.equal(await liveHoldsForSeat(seatId), 1, 'no duplicate active holds');
    assert.equal(await seatStatus(seatId), 'held');
  });
});
