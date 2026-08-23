import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';

import { createApp } from '../src/app.js';
import { closePool, query } from '../src/db/pool.js';
import { accessTokenForUser } from './helpers/auth.js';
import { cleanupSeedData, seedCustomer, seedLiveHold, seedShow } from './helpers/seed.js';

let server: Server;
let baseUrl: string;

before(async () => {
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await query('DELETE FROM idempotency_keys');
  await cleanupSeedData();
  await closePool();
});

interface HoldResponse {
  holdId?: string;
  eventId?: string;
  showSeatIds?: string[];
  status?: string;
  expiresAt?: string;
  error?: { code: string; message: string; details?: { reason?: string } };
}

interface HoldRequest {
  /**
   * A test convenience meaning "act as this user". The helper turns it into a
   * bearer token; the wire body has no userId field at all.
   */
  userId: string;
  showSeatIds: string[];
  ttlSeconds?: number;
}

async function postHold(
  eventId: string,
  body: HoldRequest,
  idempotencyKey: string | null,
): Promise<{ status: number; json: HoldResponse }> {
  const { userId, ...payload } = body;

  const response = await fetch(`${baseUrl}/api/v1/events/${eventId}/holds`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${await accessTokenForUser(userId)}`,
      ...(idempotencyKey === null ? {} : { 'idempotency-key': idempotencyKey }),
    },
    body: JSON.stringify(payload),
  });
  return { status: response.status, json: (await response.json()) as HoldResponse };
}

async function countHolds(eventId: string): Promise<number> {
  const result = await query<{ count: string }>(
    'SELECT count(*)::text AS count FROM reservation_holds WHERE event_id = $1',
    [eventId],
  );
  return Number(result.rows[0]!.count);
}

async function countHoldSeats(eventId: string): Promise<number> {
  const result = await query<{ count: string }>(
    `SELECT count(*)::text AS count
     FROM reservation_hold_seats rhs
     JOIN reservation_holds h ON h.id = rhs.hold_id
     WHERE h.event_id = $1`,
    [eventId],
  );
  return Number(result.rows[0]!.count);
}

async function countIdempotencyRecords(userId: string): Promise<number> {
  const result = await query<{ count: string }>(
    'SELECT count(*)::text AS count FROM idempotency_keys WHERE user_id = $1',
    [userId],
  );
  return Number(result.rows[0]!.count);
}

describe('idempotent hold creation - replay', () => {
  it('creates exactly one hold for a new key', async () => {
    const { eventId, seats } = await seedShow(2);
    const userId = await seedCustomer();
    const key = randomUUID();

    const { status, json } = await postHold(
      eventId,
      { userId, showSeatIds: [seats[0]!.id] },
      key,
    );

    assert.equal(status, 201);
    assert.equal(await countHolds(eventId), 1);

    const record = await query<{ status: string; response_status: number; request_hash: string }>(
      'SELECT status, response_status, request_hash FROM idempotency_keys WHERE user_id = $1 AND key = $2',
      [userId, key],
    );
    assert.equal(record.rowCount, 1);
    assert.equal(record.rows[0]!.status, 'completed');
    assert.equal(record.rows[0]!.response_status, 201);
    assert.match(record.rows[0]!.request_hash, /^[0-9a-f]{64}$/);
    assert.ok(json.holdId);
  });

  it('replays the identical response on retry without creating a second hold', async () => {
    const { eventId, seats } = await seedShow(3);
    const userId = await seedCustomer();
    const seatIds = seats.map((seat) => seat.id);
    const key = randomUUID();
    const body = { userId, showSeatIds: seatIds, ttlSeconds: 600 };

    const first = await postHold(eventId, body, key);
    assert.equal(first.status, 201);

    const retry = await postHold(eventId, body, key);

    // Same status and byte-for-byte the same body, expiresAt included: the
    // second call replayed rather than recomputing anything.
    assert.equal(retry.status, first.status);
    assert.deepEqual(retry.json, first.json);
    assert.equal(retry.json.expiresAt, first.json.expiresAt);

    // Nothing was created or changed a second time.
    assert.equal(await countHolds(eventId), 1);
    assert.equal(await countHoldSeats(eventId), seatIds.length);
    assert.equal(await countIdempotencyRecords(userId), 1);
  });

  it('does not touch seat state again on retry', async () => {
    const { eventId, seats } = await seedShow(2);
    const userId = await seedCustomer();
    const key = randomUUID();
    const body = { userId, showSeatIds: [seats[0]!.id] };

    await postHold(eventId, body, key);

    const before = await query<{ status: string; updated_at: Date }>(
      'SELECT status, updated_at FROM show_seats WHERE id = $1',
      [seats[0]!.id],
    );

    await postHold(eventId, body, key);

    const after = await query<{ status: string; updated_at: Date }>(
      'SELECT status, updated_at FROM show_seats WHERE id = $1',
      [seats[0]!.id],
    );

    assert.equal(after.rows[0]!.status, 'held');
    // updated_at is trigger-maintained, so an unchanged value proves no second
    // UPDATE reached the row.
    assert.equal(
      after.rows[0]!.updated_at.getTime(),
      before.rows[0]!.updated_at.getTime(),
    );
  });

  it('replays instead of re-holding even when the seats became free again', async () => {
    const { eventId, seats } = await seedShow(2);
    const userId = await seedCustomer();
    const seatId = seats[0]!.id;
    const key = randomUUID();
    const body = { userId, showSeatIds: [seatId] };

    const first = await postHold(eventId, body, key);
    assert.equal(first.status, 201);

    // Release the seat, as an expiry sweep or a cancellation eventually would.
    // Seat contention can no longer stop a second hold from being created, so
    // from here only the idempotency record prevents a duplicate.
    await query("UPDATE reservation_holds SET status = 'cancelled' WHERE id = $1", [
      first.json.holdId,
    ]);
    await query("UPDATE show_seats SET status = 'available' WHERE id = $1", [seatId]);

    const retry = await postHold(eventId, body, key);

    assert.equal(retry.status, 201);
    assert.deepEqual(retry.json, first.json, 'the retry replays the original response');
    assert.equal(await countHolds(eventId), 1, 'no second hold was created');
    // The replay reports the original hold; it does not re-hold the seat.
    const seat = await query<{ status: string }>('SELECT status FROM show_seats WHERE id = $1', [
      seatId,
    ]);
    assert.equal(seat.rows[0]!.status, 'available');
  });

  it('reuses the key across differently formatted but logically identical requests', async () => {
    const { eventId, seats } = await seedShow(3);
    const userId = await seedCustomer();
    const [a, b, c] = [seats[0]!.id, seats[1]!.id, seats[2]!.id];
    const key = randomUUID();

    const first = await postHold(eventId, { userId, showSeatIds: [a, b, c], ttlSeconds: 600 }, key);
    assert.equal(first.status, 201);

    // Same seats, different order: the same logical request, so the hash must
    // match and the response must replay.
    const retry = await postHold(eventId, { userId, showSeatIds: [c, a, b], ttlSeconds: 600 }, key);

    assert.equal(retry.status, 201);
    assert.deepEqual(retry.json, first.json);
    assert.equal(await countHolds(eventId), 1);
  });
});

describe('idempotent hold creation - key reuse conflicts', () => {
  it('rejects the same key with a different seat selection', async () => {
    const { eventId, seats } = await seedShow(3);
    const userId = await seedCustomer();
    const key = randomUUID();

    await postHold(eventId, { userId, showSeatIds: [seats[0]!.id] }, key);

    const { status, json } = await postHold(eventId, { userId, showSeatIds: [seats[1]!.id] }, key);

    assert.equal(status, 409);
    assert.equal(json.error?.code, 'CONFLICT');
    assert.equal(json.error?.details?.reason, 'idempotency_key_reuse');

    // The second seat was never touched and no second hold exists.
    assert.equal(await countHolds(eventId), 1);
    const seatB = await query<{ status: string }>('SELECT status FROM show_seats WHERE id = $1', [
      seats[1]!.id,
    ]);
    assert.equal(seatB.rows[0]!.status, 'available');
  });

  it('rejects the same key with a different ttl', async () => {
    const { eventId, seats } = await seedShow(2);
    const userId = await seedCustomer();
    const key = randomUUID();
    const seatIds = [seats[0]!.id];

    await postHold(eventId, { userId, showSeatIds: seatIds, ttlSeconds: 600 }, key);
    const { status, json } = await postHold(
      eventId,
      { userId, showSeatIds: seatIds, ttlSeconds: 300 },
      key,
    );

    assert.equal(status, 409);
    assert.equal(json.error?.details?.reason, 'idempotency_key_reuse');
    assert.equal(await countHolds(eventId), 1);
  });

  it('rejects the same key against a different event', async () => {
    const first = await seedShow(2);
    const second = await seedShow(2);
    const userId = await seedCustomer();
    const key = randomUUID();

    await postHold(first.eventId, { userId, showSeatIds: [first.seats[0]!.id] }, key);
    const { status, json } = await postHold(
      second.eventId,
      { userId, showSeatIds: [second.seats[0]!.id] },
      key,
    );

    assert.equal(status, 409);
    assert.equal(json.error?.details?.reason, 'idempotency_key_reuse');
    assert.equal(await countHolds(second.eventId), 0);
  });

  it('lets different keys create independent holds', async () => {
    const { eventId, seats } = await seedShow(3);
    const userId = await seedCustomer();

    const first = await postHold(eventId, { userId, showSeatIds: [seats[0]!.id] }, randomUUID());
    const second = await postHold(eventId, { userId, showSeatIds: [seats[1]!.id] }, randomUUID());

    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.notEqual(first.json.holdId, second.json.holdId);
    assert.equal(await countHolds(eventId), 2);
    assert.equal(await countIdempotencyRecords(userId), 2);
  });
});

describe('idempotent hold creation - key scoping and privacy', () => {
  it('does not let one user read another user\'s response through the same key', async () => {
    const { eventId, seats } = await seedShow(3);
    const userOne = await seedCustomer();
    const userTwo = await seedCustomer();
    const sharedKey = 'shared-key-value';

    const first = await postHold(eventId, { userId: userOne, showSeatIds: [seats[0]!.id] }, sharedKey);
    assert.equal(first.status, 201);

    // Same key string, different user: a brand new request, not a replay.
    const second = await postHold(
      eventId,
      { userId: userTwo, showSeatIds: [seats[1]!.id] },
      sharedKey,
    );

    assert.equal(second.status, 201);
    assert.notEqual(second.json.holdId, first.json.holdId);
    assert.deepEqual(second.json.showSeatIds, [seats[1]!.id]);

    // Two separate records, one per user, each keyed the same string.
    assert.equal(await countIdempotencyRecords(userOne), 1);
    assert.equal(await countIdempotencyRecords(userTwo), 1);

    // And user two cannot reach user one's hold by replaying the key against
    // user one's seat: that is a different request under their own key.
    const probe = await postHold(
      eventId,
      { userId: userTwo, showSeatIds: [seats[0]!.id] },
      sharedKey,
    );
    assert.equal(probe.status, 409);
    assert.equal(probe.json.error?.details?.reason, 'idempotency_key_reuse');
    assert.ok(!JSON.stringify(probe.json).includes(first.json.holdId!));
  });
});

describe('idempotent hold creation - header validation', () => {
  it('rejects a missing Idempotency-Key', async () => {
    const { eventId, seats } = await seedShow(1);
    const userId = await seedCustomer();

    const { status, json } = await postHold(eventId, { userId, showSeatIds: [seats[0]!.id] }, null);

    assert.equal(status, 400);
    assert.equal(json.error?.code, 'BAD_REQUEST');
    assert.match(json.error!.message, /idempotency-key/i);
    assert.equal(await countHolds(eventId), 0);
  });

  it('rejects an empty, oversized or malformed key', async () => {
    const { eventId, seats } = await seedShow(1);
    const userId = await seedCustomer();
    const body = { userId, showSeatIds: [seats[0]!.id] };

    const invalidKeys = [
      '', // empty
      'x'.repeat(256), // oversized
      'has space', // whitespace
      'tab\there', // control character
      'ünicode', // outside printable ASCII
    ];

    for (const key of invalidKeys) {
      const { status } = await postHold(eventId, body, key);
      assert.equal(status, 400, `key ${JSON.stringify(key)} should be rejected`);
    }

    assert.equal(await countHolds(eventId), 0);
    assert.equal(await countIdempotencyRecords(userId), 0);
  });

  it('accepts a key of exactly the maximum length', async () => {
    const { eventId, seats } = await seedShow(1);
    const userId = await seedCustomer();

    const { status } = await postHold(
      eventId,
      { userId, showSeatIds: [seats[0]!.id] },
      'k'.repeat(255),
    );
    assert.equal(status, 201);
  });
});

describe('idempotent hold creation - failure semantics', () => {
  it('stores no record when the reservation fails, and lets the retry re-run', async () => {
    const { eventId, seats } = await seedShow(3);
    const owner = await seedCustomer();
    const customer = await seedCustomer();
    const [a12, a13] = [seats[0]!.id, seats[1]!.id];
    const key = randomUUID();

    // A13 is held by someone else, so the selection cannot succeed.
    const blockingHold = await seedLiveHold(eventId, owner, [a13], 600);

    const failed = await postHold(eventId, { userId: customer, showSeatIds: [a12, a13] }, key);
    assert.equal(failed.status, 409);

    // The rollback took the idempotency claim with it: no phantom success, and
    // nothing that could later be replayed as one.
    assert.equal(await countIdempotencyRecords(customer), 0);

    // Retrying the same key repeats the failure rather than replaying a hold
    // that never existed.
    const retried = await postHold(eventId, { userId: customer, showSeatIds: [a12, a13] }, key);
    assert.equal(retried.status, 409);
    assert.equal(await countIdempotencyRecords(customer), 0);

    // Once the blocker is gone the very same key succeeds, because the failed
    // attempt never bound it.
    await query("UPDATE reservation_holds SET status = 'cancelled' WHERE id = $1", [blockingHold]);
    await query("UPDATE show_seats SET status = 'available' WHERE id = $1", [a13]);

    const succeeded = await postHold(eventId, { userId: customer, showSeatIds: [a12, a13] }, key);
    assert.equal(succeeded.status, 201);
    assert.equal(await countIdempotencyRecords(customer), 1);

    // And that success is now the replayable one.
    const replay = await postHold(eventId, { userId: customer, showSeatIds: [a12, a13] }, key);
    assert.equal(replay.status, 201);
    assert.deepEqual(replay.json, succeeded.json);
  });

  it('stores no record when the transaction fails unexpectedly', async () => {
    const { eventId, seats } = await seedShow(2);
    const userId = await seedCustomer();
    const key = randomUUID();

    await query(
      'ALTER TABLE reservation_hold_seats ADD CONSTRAINT tmp_force_failure CHECK (false) NOT VALID',
    );

    try {
      const { status } = await postHold(eventId, { userId, showSeatIds: [seats[0]!.id] }, key);
      assert.equal(status, 500);

      // The claim rolled back with everything else.
      assert.equal(await countIdempotencyRecords(userId), 0);
      assert.equal(await countHolds(eventId), 0);
    } finally {
      await query('ALTER TABLE reservation_hold_seats DROP CONSTRAINT tmp_force_failure');
    }

    // With the fault removed the same key works, proving it was never consumed.
    const { status } = await postHold(eventId, { userId, showSeatIds: [seats[0]!.id] }, key);
    assert.equal(status, 201);
  });
});
