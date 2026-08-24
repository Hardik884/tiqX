import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { after, before, describe, it } from 'node:test';

import { closePool, query } from '../src/db/pool.js';
import {
  deleteExpiryKey,
  expireHold,
  publishPendingExpirations,
  reconcileExpiryKeys,
  sweepExpiredHolds,
} from '../src/modules/expiration/expiration.service.js';
import { createHold } from '../src/modules/reservations/reservation.service.js';
import { getRedis } from '../src/redis/client.js';
import { holdExpiryKey } from '../src/redis/keys.js';
import { closeTestRedis, connectTestRedis, flushTestNamespace } from './helpers/redis.js';
import { cleanupSeedData, seedCustomer, seedShow } from './helpers/seed.js';

before(async () => {
  await connectTestRedis();
  await flushTestNamespace();
});

after(async () => {
  await flushTestNamespace();
  await closeTestRedis();
  await cleanupSeedData();
  await closePool();
});

interface OutboxRow {
  id: string;
  hold_id: string;
  attempts: number;
  processed_at: Date | null;
  last_error: string | null;
}

async function outboxFor(holdId: string): Promise<OutboxRow | null> {
  const result = await query<OutboxRow>(
    'SELECT id, hold_id, attempts, processed_at, last_error FROM hold_expiration_outbox WHERE hold_id = $1',
    [holdId],
  );
  return result.rows[0] ?? null;
}

async function holdStatus(holdId: string): Promise<string | null> {
  const result = await query<{ status: string }>(
    'SELECT status FROM reservation_holds WHERE id = $1',
    [holdId],
  );
  return result.rows[0]?.status ?? null;
}

async function seatStatus(showSeatId: string): Promise<string> {
  const result = await query<{ status: string }>(
    'SELECT status FROM show_seats WHERE id = $1',
    [showSeatId],
  );
  return result.rows[0]!.status;
}

/** How many unexpired active holds currently cover a seat. Must never exceed 1. */
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

/** Creates a hold directly through the service, so a sub-minute TTL is possible. */
async function makeHold(seatCount: number, ttlSeconds: number) {
  const { eventId, seats } = await seedShow(seatCount);
  const userId = await seedCustomer();
  const hold = await createHold({
    eventId,
    userId,
    showSeatIds: seats.map((seat) => seat.id),
    ttlSeconds,
  });
  return { eventId, userId, seats, hold };
}

describe('hold creation queues a durable expiration event', () => {
  it('writes an outbox row in the same transaction as the hold', async () => {
    const { hold } = await makeHold(2, 600);

    const row = await outboxFor(hold.holdId);
    assert.ok(row, 'the hold must have an outbox row');
    assert.equal(row.processed_at, null, 'not yet published');
    assert.equal(row.attempts, 0);

    // Copied from the hold's authoritative expires_at, not recomputed.
    const matches = await query<{ same: boolean }>(
      `SELECT (o.expires_at = h.expires_at) AS same
       FROM hold_expiration_outbox o JOIN reservation_holds h ON h.id = o.hold_id
       WHERE o.hold_id = $1`,
      [hold.holdId],
    );
    assert.equal(matches.rows[0]!.same, true, 'outbox carries the database-generated expiry');
  });

  it('leaves no outbox row when the hold transaction rolls back', async () => {
    const { eventId, seats } = await seedShow(2);
    const owner = await seedCustomer();
    const loser = await seedCustomer();

    await createHold({ eventId, userId: owner, showSeatIds: [seats[0]!.id], ttlSeconds: 600 });

    const before = await query<{ count: string }>(
      'SELECT count(*)::text AS count FROM hold_expiration_outbox',
    );

    // Contends for a taken seat, so the whole transaction rolls back.
    await assert.rejects(
      createHold({ eventId, userId: loser, showSeatIds: [seats[0]!.id], ttlSeconds: 600 }),
    );

    const afterCount = await query<{ count: string }>(
      'SELECT count(*)::text AS count FROM hold_expiration_outbox',
    );
    assert.equal(afterCount.rows[0]!.count, before.rows[0]!.count, 'no orphan event');
  });

  it('does not require Redis to create a hold', async () => {
    const redis = getRedis();
    redis.disconnect();

    try {
      const { hold } = await makeHold(1, 600);

      // PostgreSQL committed; the signal is queued rather than lost.
      assert.equal(await holdStatus(hold.holdId), 'active');
      const row = await outboxFor(hold.holdId);
      assert.ok(row);
      assert.equal(row.processed_at, null);
    } finally {
      await restoreRedis();
    }
  });
});

describe('publishing the expiration signal', () => {
  it('sets a namespaced key whose TTL matches the hold', async () => {
    const { hold } = await makeHold(1, 300);

    const result = await publishPendingExpirations();
    assert.ok(result.published >= 1);

    const key = holdExpiryKey(hold.holdId);
    assert.equal(await getRedis().exists(key), 1, 'the expiration key must exist');

    const ttl = await getRedis().ttl(key);
    assert.ok(ttl > 0 && ttl <= 300, `ttl was ${ttl}`);
    // Derived from the database clock, so it should land near the full window.
    assert.ok(ttl > 280, `ttl ${ttl} is far from the hold's remaining lifetime`);

    assert.equal(await getRedis().get(key), hold.holdId);

    const row = await outboxFor(hold.holdId);
    assert.ok(row?.processed_at instanceof Date, 'the row is marked processed');
  });

  it('keeps the event pending and retries when Redis is unavailable', async () => {
    const { hold } = await makeHold(1, 300);
    const redis = getRedis();

    redis.disconnect();
    let failed: number;
    try {
      const result = await publishPendingExpirations();
      failed = result.failed;
    } finally {
      await restoreRedis();
    }

    assert.ok(failed >= 1, 'the publish should have failed');

    const afterFailure = await outboxFor(hold.holdId);
    assert.equal(afterFailure?.processed_at, null, 'must NOT be marked processed');
    assert.ok((afterFailure?.attempts ?? 0) >= 1, 'the attempt is recorded');
    assert.ok(afterFailure?.last_error, 'a failure reason is recorded');
    // The reason must not carry connection details that could include a secret.
    assert.ok(!afterFailure!.last_error!.includes('redis://'));

    // Backoff pushed it into the future, so it is not retried in a tight loop.
    const scheduled = await query<{ future: boolean }>(
      'SELECT (available_at > now()) AS future FROM hold_expiration_outbox WHERE hold_id = $1',
      [hold.holdId],
    );
    assert.equal(scheduled.rows[0]!.future, true, 'retry is delayed, not immediate');

    // Once the delay passes and Redis is back, the event is published: it was
    // never lost.
    await query(
      "UPDATE hold_expiration_outbox SET available_at = now() - interval '1 second' WHERE hold_id = $1",
      [hold.holdId],
    );
    await publishPendingExpirations();

    assert.equal(await getRedis().exists(holdExpiryKey(hold.holdId)), 1);
    const recovered = await outboxFor(hold.holdId);
    assert.ok(recovered?.processed_at instanceof Date);
  });

  it('is safe to run repeatedly', async () => {
    const { hold } = await makeHold(1, 300);

    await publishPendingExpirations();
    const first = await outboxFor(hold.holdId);

    // A second pass must not re-claim a processed row or change anything.
    const second = await publishPendingExpirations();
    const after = await outboxFor(hold.holdId);

    assert.equal(second.claimed, 0, 'processed rows are not re-claimed');
    assert.deepEqual(after?.processed_at, first?.processed_at);
  });
});

describe('expiring a hold', () => {
  it('expires the hold and releases its seats atomically', async () => {
    const { hold, seats } = await makeHold(3, 1);
    await publishPendingExpirations();

    await delay(1_200);

    const outcome = await expireHold(hold.holdId);

    assert.equal(outcome, 'expired');
    assert.equal(await holdStatus(hold.holdId), 'expired');
    for (const seat of seats) {
      assert.equal(await seatStatus(seat.id), 'available', `${seat.label} should be released`);
      assert.equal(await liveHoldsForSeat(seat.id), 0);
    }
  });

  it('releases only the seats belonging to that hold', async () => {
    const { eventId, seats } = await seedShow(4);
    const first = await seedCustomer();
    const second = await seedCustomer();

    const expiring = await createHold({
      eventId,
      userId: first,
      showSeatIds: [seats[0]!.id, seats[1]!.id],
      ttlSeconds: 1,
    });
    const surviving = await createHold({
      eventId,
      userId: second,
      showSeatIds: [seats[2]!.id, seats[3]!.id],
      ttlSeconds: 600,
    });

    await delay(1_200);
    assert.equal(await expireHold(expiring.holdId), 'expired');

    assert.equal(await seatStatus(seats[0]!.id), 'available');
    assert.equal(await seatStatus(seats[1]!.id), 'available');
    // The other hold is untouched.
    assert.equal(await holdStatus(surviving.holdId), 'active');
    assert.equal(await seatStatus(seats[2]!.id), 'held');
    assert.equal(await seatStatus(seats[3]!.id), 'held');
  });

  it('does nothing for a hold that has not actually expired', async () => {
    const { hold, seats } = await makeHold(1, 600);

    // A stale or spurious signal must not shorten a live hold: PostgreSQL
    // decides, not the caller.
    assert.equal(await expireHold(hold.holdId), 'noop');
    assert.equal(await holdStatus(hold.holdId), 'active');
    assert.equal(await seatStatus(seats[0]!.id), 'held');
  });

  it('treats an unknown, cancelled or already-expired hold as done', async () => {
    assert.equal(await expireHold(randomUUID()), 'noop', 'unknown hold');

    const cancelled = await makeHold(1, 1);
    await query("UPDATE reservation_holds SET status = 'cancelled' WHERE id = $1", [
      cancelled.hold.holdId,
    ]);
    await delay(1_100);
    assert.equal(await expireHold(cancelled.hold.holdId), 'noop', 'cancelled hold');
    assert.equal(await holdStatus(cancelled.hold.holdId), 'cancelled', 'status is not overwritten');

    const converted = await makeHold(1, 1);
    await query("UPDATE reservation_holds SET status = 'converted' WHERE id = $1", [
      converted.hold.holdId,
    ]);
    await delay(1_100);
    assert.equal(await expireHold(converted.hold.holdId), 'noop', 'converted hold');
    assert.equal(await holdStatus(converted.hold.holdId), 'converted');
  });

  it('is idempotent under duplicate signals, including concurrent ones', async () => {
    const { hold, seats } = await makeHold(2, 1);
    await delay(1_200);

    // Ten simultaneous deliveries of the same signal.
    const outcomes = await Promise.all(Array.from({ length: 10 }, () => expireHold(hold.holdId)));

    assert.equal(
      outcomes.filter((o) => o === 'expired').length,
      1,
      'exactly one delivery performs the transition',
    );
    assert.equal(outcomes.filter((o) => o === 'noop').length, 9);

    assert.equal(await holdStatus(hold.holdId), 'expired');
    for (const seat of seats) {
      assert.equal(await seatStatus(seat.id), 'available');
    }

    // And a much later replay is still harmless.
    assert.equal(await expireHold(hold.holdId), 'noop');
    assert.equal(await holdStatus(hold.holdId), 'expired');
  });

  it('deletes the Redis key after the database transition, as cleanup only', async () => {
    const { hold } = await makeHold(1, 1);
    await publishPendingExpirations();
    assert.equal(await getRedis().exists(holdExpiryKey(hold.holdId)), 1);

    await delay(1_200);
    const result = await sweepExpiredHolds();

    assert.ok(result.expired >= 1);
    assert.equal(await holdStatus(hold.holdId), 'expired');
    assert.equal(await getRedis().exists(holdExpiryKey(hold.holdId)), 0, 'key cleaned up');
  });

  it('keeps the database correct when Redis deletion fails', async () => {
    const { hold, seats } = await makeHold(1, 1);
    await publishPendingExpirations();
    await delay(1_200);

    const redis = getRedis();
    redis.disconnect();
    try {
      // The expiry itself needs only PostgreSQL, so it must still succeed.
      assert.equal(await expireHold(hold.holdId), 'expired');
      assert.equal(await deleteExpiryKey(hold.holdId), false, 'cleanup failed, and said so');
    } finally {
      await restoreRedis();
    }

    // The authoritative transition committed regardless.
    assert.equal(await holdStatus(hold.holdId), 'expired');
    assert.equal(await seatStatus(seats[0]!.id), 'available');
  });
});

describe('the sweep is driven by PostgreSQL, not Redis', () => {
  it('expires a due hold even though its Redis key never existed', async () => {
    const { hold, seats } = await makeHold(2, 1);

    // Never published, and the key is definitely absent.
    await getRedis().del(holdExpiryKey(hold.holdId));
    assert.equal(await getRedis().exists(holdExpiryKey(hold.holdId)), 0);

    await delay(1_200);
    const result = await sweepExpiredHolds();

    assert.ok(result.expired >= 1, 'the sweep does not need the Redis signal');
    assert.equal(await holdStatus(hold.holdId), 'expired');
    assert.equal(await seatStatus(seats[0]!.id), 'available');
  });

  it('does not expire a live hold whose Redis key was deleted', async () => {
    const { hold, seats } = await makeHold(1, 600);
    await publishPendingExpirations();

    // Deleting the signal must not free the seat: Redis is not authoritative.
    await getRedis().del(holdExpiryKey(hold.holdId));

    await sweepExpiredHolds();

    assert.equal(await holdStatus(hold.holdId), 'active');
    assert.equal(await seatStatus(seats[0]!.id), 'held');
    assert.equal(await liveHoldsForSeat(seats[0]!.id), 1);
  });

  it('still refuses the seat to another customer after the key is deleted', async () => {
    const { eventId, seats } = await seedShow(2);
    const owner = await seedCustomer();
    const challenger = await seedCustomer();

    const hold = await createHold({
      eventId,
      userId: owner,
      showSeatIds: [seats[0]!.id],
      ttlSeconds: 600,
    });
    await publishPendingExpirations();
    await getRedis().del(holdExpiryKey(hold.holdId));

    // The proof that Redis is not the source of truth: with no key at all, the
    // seat is still owned, and the reservation path still says so.
    await assert.rejects(
      createHold({ eventId, userId: challenger, showSeatIds: [seats[0]!.id], ttlSeconds: 600 }),
      (error: unknown) => (error as { statusCode?: number }).statusCode === 409,
    );

    assert.equal(await holdStatus(hold.holdId), 'active');
    assert.equal(await liveHoldsForSeat(seats[0]!.id), 1);
  });
});

describe('reconciliation restores missing keys', () => {
  it('recreates a key that was lost, with a sensible TTL', async () => {
    const { hold } = await makeHold(1, 600);
    await publishPendingExpirations();

    const key = holdExpiryKey(hold.holdId);
    await getRedis().del(key);
    assert.equal(await getRedis().exists(key), 0);

    const result = await reconcileExpiryKeys();

    assert.ok(result.restored >= 1);
    assert.equal(await getRedis().exists(key), 1, 'the key is back');
    const ttl = await getRedis().ttl(key);
    assert.ok(ttl > 0 && ttl <= 600, `ttl was ${ttl}`);
  });

  it('leaves existing keys alone', async () => {
    const { hold } = await makeHold(1, 600);
    await publishPendingExpirations();

    const key = holdExpiryKey(hold.holdId);
    const before = await getRedis().ttl(key);

    await reconcileExpiryKeys();

    const afterTtl = await getRedis().ttl(key);
    assert.ok(Math.abs(afterTtl - before) <= 2, 'an existing key is not rewritten');
  });

  it('survives a complete loss of the Redis keyspace', async () => {
    const holds = await Promise.all([makeHold(1, 600), makeHold(1, 600), makeHold(1, 600)]);
    await publishPendingExpirations();

    // Simulates a flush, an eviction, or a failover to an empty replica.
    await flushTestNamespace();
    for (const { hold } of holds) {
      assert.equal(await getRedis().exists(holdExpiryKey(hold.holdId)), 0);
    }

    await reconcileExpiryKeys();

    for (const { hold } of holds) {
      assert.equal(
        await getRedis().exists(holdExpiryKey(hold.holdId)),
        1,
        'every active hold gets its signal back',
      );
      assert.equal(await holdStatus(hold.holdId), 'active', 'and the hold was never at risk');
    }
  });
});

describe('races', () => {
  it('never corrupts state when the worker and a new reservation collide', async () => {
    for (let round = 0; round < 6; round += 1) {
      const { eventId, seats } = await seedShow(1);
      const owner = await seedCustomer();
      const challenger = await seedCustomer();
      const seatId = seats[0]!.id;

      const expiring = await createHold({
        eventId,
        userId: owner,
        showSeatIds: [seatId],
        ttlSeconds: 1,
      });
      await delay(1_100);

      // The worker expiring the lapsed hold, and a customer trying to take the
      // same seat, at the same instant.
      const [, acquisition] = await Promise.allSettled([
        expireHold(expiring.holdId),
        createHold({ eventId, userId: challenger, showSeatIds: [seatId], ttlSeconds: 600 }),
      ]);

      // The old hold is finished either way, by whichever transaction won.
      assert.equal(await holdStatus(expiring.holdId), 'expired', `round ${round}`);

      // The invariant that matters: never two owners, and never a seat left
      // held by nobody.
      assert.ok(await liveHoldsForSeat(seatId) <= 1, `round ${round}: at most one live hold`);

      const status = await seatStatus(seatId);
      if (acquisition.status === 'fulfilled') {
        assert.equal(status, 'held', `round ${round}: the winner holds the seat`);
        assert.equal(await liveHoldsForSeat(seatId), 1);
      } else {
        assert.equal(status, 'available', `round ${round}: nobody holds it`);
        assert.equal(await liveHoldsForSeat(seatId), 0);
      }
    }
  });

  it('coexists with the reservation path reclaiming the same hold', async () => {
    const { eventId, seats } = await seedShow(1);
    const owner = await seedCustomer();
    const challenger = await seedCustomer();
    const seatId = seats[0]!.id;

    const lapsing = await createHold({ eventId, userId: owner, showSeatIds: [seatId], ttlSeconds: 1 });
    await delay(1_100);

    // The reservation path reclaims opportunistically; the worker sweeps. Both
    // target the same hold, and that is expected rather than exceptional.
    const [reclaim, sweep] = await Promise.allSettled([
      createHold({ eventId, userId: challenger, showSeatIds: [seatId], ttlSeconds: 600 }),
      sweepExpiredHolds(),
    ]);

    assert.equal(sweep.status, 'fulfilled', 'the sweep must not error on a reclaimed hold');
    assert.equal(await holdStatus(lapsing.holdId), 'expired');
    assert.ok(await liveHoldsForSeat(seatId) <= 1);

    if (reclaim.status === 'fulfilled') {
      // The new hold must survive: the sweep must never expire a fresh hold.
      assert.equal(await holdStatus(reclaim.value.holdId), 'active');
      assert.equal(await seatStatus(seatId), 'held');
    }
  });
});

/** Restores the shared client after a simulated outage (see redis.failure.test.ts). */
async function restoreRedis(): Promise<void> {
  const redis = getRedis();
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (redis.status === 'end' || redis.status === 'close') {
      try {
        await redis.connect();
      } catch {
        // Raced with ioredis' own state transition; retry.
      }
    }
    if (redis.status === 'ready') {
      try {
        if ((await redis.ping()) === 'PONG') {
          return;
        }
      } catch {
        // Not usable yet.
      }
    }
    await delay(20);
  }
  assert.fail('Redis did not become usable again');
}
