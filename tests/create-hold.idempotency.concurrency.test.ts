import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';

import { createApp } from '../src/app.js';
import { closePool, query } from '../src/db/pool.js';
import { cleanupSeedData, seedCustomer, seedShow } from './helpers/seed.js';

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
  error?: { code: string; message: string };
}

interface Attempt {
  status: number;
  json: HoldResponse;
}

function holdRequest(
  eventId: string,
  body: unknown,
  idempotencyKey: string,
): () => Promise<Attempt> {
  return async () => {
    const response = await fetch(`${baseUrl}/api/v1/events/${eventId}/holds`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
      body: JSON.stringify(body),
    });
    return { status: response.status, json: (await response.json()) as HoldResponse };
  };
}

/**
 * Fires every request before awaiting any of them, so the server and PostgreSQL
 * really do see them at once. Awaiting one at a time would test nothing.
 */
async function runConcurrently(attempts: readonly (() => Promise<Attempt>)[]): Promise<Attempt[]> {
  const settled = await Promise.allSettled(attempts.map((attempt) => attempt()));

  const failures = settled.flatMap((result) =>
    result.status === 'rejected' ? [String(result.reason)] : [],
  );
  assert.deepEqual(failures, [], 'every request should get an HTTP response');

  return settled.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
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

describe('concurrent duplicate requests (same idempotency key)', () => {
  it('creates exactly one hold across 50 simultaneous identical requests', async () => {
    const ATTEMPTS = 50;
    const { eventId, seats } = await seedShow(3);
    const userId = await seedCustomer();
    const seatIds = seats.map((seat) => seat.id);
    const key = randomUUID();
    const body = { userId, showSeatIds: seatIds, ttlSeconds: 600 };

    const results = await runConcurrently(
      Array.from({ length: ATTEMPTS }, () => holdRequest(eventId, body, key)),
    );

    // Every caller gets the same successful answer: one did the work, the rest
    // replayed it.
    const statuses = new Set(results.map((result) => result.status));
    assert.deepEqual([...statuses], [201], 'every duplicate request should succeed');

    const holdIds = new Set(results.map((result) => result.json.holdId));
    assert.equal(holdIds.size, 1, 'all responses must name the same hold');
    assert.ok([...holdIds][0]);

    // And the database agrees.
    assert.equal(await countHolds(eventId), 1, 'exactly one hold row');
    assert.equal(await countHoldSeats(eventId), seatIds.length, 'no duplicate hold-seat rows');

    const records = await query<{ status: string; response_status: number }>(
      'SELECT status, response_status FROM idempotency_keys WHERE user_id = $1',
      [userId],
    );
    assert.equal(records.rowCount, 1, 'exactly one idempotency record');
    assert.equal(records.rows[0]!.status, 'completed', 'no record left in processing');
    assert.equal(records.rows[0]!.response_status, 201);

    // Every seat is held exactly once.
    const claims = await query<{ show_seat_id: string; claims: string }>(
      `SELECT rhs.show_seat_id, count(*)::text AS claims
       FROM reservation_hold_seats rhs
       JOIN reservation_holds h ON h.id = rhs.hold_id
       WHERE h.event_id = $1 AND h.status = 'active' AND h.expires_at > now()
       GROUP BY rhs.show_seat_id`,
      [eventId],
    );
    assert.equal(claims.rowCount, seatIds.length);
    assert.ok(claims.rows.every((row) => row.claims === '1'), 'no seat claimed twice');
  });
});

describe('concurrent distinct requests (different idempotency keys)', () => {
  it('falls back to ordinary seat contention: one winner, the rest conflict', async () => {
    const ATTEMPTS = 50;
    const { eventId, seats } = await seedShow(1);
    const userId = await seedCustomer();
    const seatIds = [seats[0]!.id];
    const body = { userId, showSeatIds: seatIds, ttlSeconds: 600 };

    // Same user, same seats, same ttl - but a distinct key each time, so these
    // are 50 different logical requests rather than 50 retries of one.
    const results = await runConcurrently(
      Array.from({ length: ATTEMPTS }, () => holdRequest(eventId, body, randomUUID())),
    );

    const created = results.filter((result) => result.status === 201);
    const conflicted = results.filter((result) => result.status === 409);

    assert.equal(created.length, 1, 'exactly one request acquires the seat');
    assert.equal(conflicted.length, ATTEMPTS - 1, 'the rest are told the seat is taken');
    assert.equal(created.length + conflicted.length, ATTEMPTS, 'no other status codes');

    assert.equal(await countHolds(eventId), 1, 'no duplicate active hold');
    assert.equal(await countHoldSeats(eventId), 1);

    // The 49 failures rolled their claims back, so only the winner's key
    // persisted: failure semantics hold under load, not just in isolation.
    const records = await query<{ count: string }>(
      'SELECT count(*)::text AS count FROM idempotency_keys WHERE user_id = $1',
      [userId],
    );
    assert.equal(records.rows[0]!.count, '1', 'only the successful request kept its key');
  });

  it('lets 50 concurrent requests for distinct seats all succeed', async () => {
    const SEATS = 10;
    const { eventId, seats } = await seedShow(SEATS);
    const userId = await seedCustomer();

    // One request per seat, each with its own key: no contention, no dedup.
    const results = await runConcurrently(
      seats.map((seat) =>
        holdRequest(eventId, { userId, showSeatIds: [seat.id], ttlSeconds: 600 }, randomUUID()),
      ),
    );

    assert.ok(
      results.every((result) => result.status === 201),
      'disjoint seats should not block each other',
    );
    assert.equal(new Set(results.map((r) => r.json.holdId)).size, SEATS, 'distinct holds');
    assert.equal(await countHolds(eventId), SEATS);
  });
});
