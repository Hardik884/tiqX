import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';

import { createApp } from '../src/app.js';
import { closePool, query } from '../src/db/pool.js';
import {
  cleanupSeedData,
  seedCustomer,
  seedLapsedHold,
  seedLiveHold,
  seedShow,
} from './helpers/seed.js';

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
  await cleanupSeedData();
  await closePool();
});

interface HoldResponse {
  holdId?: string;
  eventId?: string;
  showSeatIds?: string[];
  status?: string;
  expiresAt?: string;
  error?: { code: string; message: string; details?: unknown };
}

async function postHold(
  eventId: string,
  body: unknown,
): Promise<{ status: number; json: HoldResponse }> {
  const response = await fetch(`${baseUrl}/api/v1/events/${eventId}/holds`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: (await response.json()) as HoldResponse };
}

async function seatStatuses(showSeatIds: readonly string[]): Promise<Record<string, string>> {
  const result = await query<{ id: string; status: string }>(
    'SELECT id, status FROM show_seats WHERE id = ANY($1::uuid[])',
    [showSeatIds],
  );
  return Object.fromEntries(result.rows.map((row) => [row.id, row.status]));
}

async function countHolds(eventId: string): Promise<number> {
  const result = await query<{ count: string }>(
    'SELECT count(*)::text AS count FROM reservation_holds WHERE event_id = $1',
    [eventId],
  );
  return Number(result.rows[0]!.count);
}

describe('POST /api/v1/events/:eventId/holds - success', () => {
  it('holds a single available seat', async () => {
    const { eventId, seats } = await seedShow(3);
    const userId = await seedCustomer();
    const seatId = seats[0]!.id;

    const { status, json } = await postHold(eventId, { userId, showSeatIds: [seatId] });

    assert.equal(status, 201);
    assert.equal(json.eventId, eventId);
    assert.equal(json.status, 'active');
    assert.deepEqual(json.showSeatIds, [seatId]);
    assert.ok(json.holdId);
    assert.equal((await seatStatuses([seatId]))[seatId], 'held');
  });

  it('holds several seats, creating exactly one hold with the right links', async () => {
    const { eventId, seats } = await seedShow(3); // A12, A13, A14
    const userId = await seedCustomer();
    const seatIds = seats.map((seat) => seat.id);

    const { status, json } = await postHold(eventId, { userId, showSeatIds: seatIds });
    assert.equal(status, 201);

    // Exactly one hold, owned by this user, active.
    assert.equal(await countHolds(eventId), 1);
    const hold = await query<{ id: string; user_id: string; status: string }>(
      'SELECT id, user_id, status FROM reservation_holds WHERE event_id = $1',
      [eventId],
    );
    assert.equal(hold.rows[0]!.id, json.holdId);
    assert.equal(hold.rows[0]!.user_id, userId);
    assert.equal(hold.rows[0]!.status, 'active');

    // One link per requested seat, and nothing else.
    const links = await query<{ show_seat_id: string }>(
      'SELECT show_seat_id FROM reservation_hold_seats WHERE hold_id = $1 ORDER BY show_seat_id',
      [json.holdId],
    );
    assert.deepEqual(
      links.rows.map((row) => row.show_seat_id),
      [...seatIds].sort(),
    );

    // Every requested seat is held.
    const statuses = await seatStatuses(seatIds);
    assert.ok(seatIds.every((id) => statuses[id] === 'held'));
  });

  it('derives expiresAt from the database clock and the requested ttl', async () => {
    const { eventId, seats } = await seedShow(1);
    const userId = await seedCustomer();

    const { status, json } = await postHold(eventId, {
      userId,
      showSeatIds: [seats[0]!.id],
      ttlSeconds: 120,
    });
    assert.equal(status, 201);

    const stored = await query<{ delta: string }>(
      `SELECT extract(epoch FROM (expires_at - created_at))::text AS delta
       FROM reservation_holds WHERE id = $1`,
      [json.holdId],
    );
    // created_at and expires_at both come from now() in the same statement.
    assert.equal(Math.round(Number(stored.rows[0]!.delta)), 120);
    assert.ok(new Date(json.expiresAt!).getTime() > Date.now());
  });

  it('defaults ttl when the client omits it', async () => {
    const { eventId, seats } = await seedShow(1);
    const userId = await seedCustomer();

    const { status, json } = await postHold(eventId, { userId, showSeatIds: [seats[0]!.id] });
    assert.equal(status, 201);

    const stored = await query<{ delta: string }>(
      `SELECT extract(epoch FROM (expires_at - created_at))::text AS delta
       FROM reservation_holds WHERE id = $1`,
      [json.holdId],
    );
    assert.equal(Math.round(Number(stored.rows[0]!.delta)), 600);
  });
});

describe('POST /api/v1/events/:eventId/holds - validation', () => {
  it('rejects duplicate seat ids', async () => {
    const { eventId, seats } = await seedShow(2);
    const userId = await seedCustomer();
    const seatId = seats[0]!.id;

    const { status, json } = await postHold(eventId, { userId, showSeatIds: [seatId, seatId] });

    assert.equal(status, 400);
    assert.equal(json.error?.code, 'BAD_REQUEST');
    assert.equal(await countHolds(eventId), 0);
  });

  it('rejects an empty seat selection', async () => {
    const { eventId } = await seedShow(1);
    const userId = await seedCustomer();

    const { status } = await postHold(eventId, { userId, showSeatIds: [] });
    assert.equal(status, 400);
  });

  it('rejects more than the maximum seats per hold', async () => {
    const { eventId, seats } = await seedShow(11);
    const userId = await seedCustomer();

    const { status, json } = await postHold(eventId, {
      userId,
      showSeatIds: seats.map((seat) => seat.id),
    });

    assert.equal(status, 400);
    assert.equal(json.error?.code, 'BAD_REQUEST');
    assert.equal(await countHolds(eventId), 0);
    // Nothing was touched.
    const statuses = await seatStatuses(seats.map((seat) => seat.id));
    assert.ok(Object.values(statuses).every((value) => value === 'available'));
  });

  it('rejects a ttl outside the allowed range', async () => {
    const { eventId, seats } = await seedShow(1);
    const userId = await seedCustomer();
    const seatIds = [seats[0]!.id];

    for (const ttlSeconds of [0, 59, 901, 10.5]) {
      const { status } = await postHold(eventId, { userId, showSeatIds: seatIds, ttlSeconds });
      assert.equal(status, 400, `ttlSeconds=${ttlSeconds} should be rejected`);
    }
    assert.equal(await countHolds(eventId), 0);
  });

  it('rejects a malformed userId', async () => {
    const { eventId, seats } = await seedShow(1);

    const { status } = await postHold(eventId, {
      userId: 'not-a-uuid',
      showSeatIds: [seats[0]!.id],
    });
    assert.equal(status, 400);
  });

  it('rejects a nonexistent user', async () => {
    const { eventId, seats } = await seedShow(1);

    const { status, json } = await postHold(eventId, {
      userId: randomUUID(),
      showSeatIds: [seats[0]!.id],
    });

    assert.equal(status, 404);
    assert.equal(json.error?.code, 'NOT_FOUND');
    assert.equal((await seatStatuses([seats[0]!.id]))[seats[0]!.id], 'available');
  });

  it('rejects a nonexistent event', async () => {
    const { seats } = await seedShow(1);
    const userId = await seedCustomer();

    const { status, json } = await postHold(randomUUID(), {
      userId,
      showSeatIds: [seats[0]!.id],
    });

    assert.equal(status, 404);
    assert.equal(json.error?.code, 'NOT_FOUND');
  });

  it('rejects a nonexistent seat', async () => {
    const { eventId } = await seedShow(1);
    const userId = await seedCustomer();

    const { status, json } = await postHold(eventId, { userId, showSeatIds: [randomUUID()] });

    assert.equal(status, 404);
    assert.equal(json.error?.code, 'NOT_FOUND');
    assert.equal(await countHolds(eventId), 0);
  });

  it('rejects a seat belonging to another event', async () => {
    const mine = await seedShow(2);
    const other = await seedShow(2);
    const userId = await seedCustomer();

    const foreignSeat = other.seats[0]!.id;
    const { status, json } = await postHold(mine.eventId, {
      userId,
      showSeatIds: [mine.seats[0]!.id, foreignSeat],
    });

    assert.equal(status, 400);
    assert.equal(json.error?.code, 'BAD_REQUEST');

    // Scenario G: nothing changed anywhere, in either event.
    assert.equal(await countHolds(mine.eventId), 0);
    assert.equal(await countHolds(other.eventId), 0);
    const statuses = await seatStatuses([mine.seats[0]!.id, foreignSeat]);
    assert.ok(Object.values(statuses).every((value) => value === 'available'));
  });
});

describe('POST /api/v1/events/:eventId/holds - availability', () => {
  it('rejects a booked seat with 409', async () => {
    const { eventId, seats } = await seedShow(2);
    const userId = await seedCustomer();
    const bookedSeat = seats[0]!.id;
    await query("UPDATE show_seats SET status = 'booked' WHERE id = $1", [bookedSeat]);

    const { status, json } = await postHold(eventId, { userId, showSeatIds: [bookedSeat] });

    assert.equal(status, 409);
    assert.equal(json.error?.code, 'CONFLICT');
    assert.equal((await seatStatuses([bookedSeat]))[bookedSeat], 'booked');
    assert.equal(await countHolds(eventId), 0);
  });

  it('rejects a seat under a live hold with 409', async () => {
    const { eventId, seats } = await seedShow(2);
    const owner = await seedCustomer();
    const challenger = await seedCustomer();
    const seatId = seats[0]!.id;

    const liveHoldId = await seedLiveHold(eventId, owner, [seatId]);

    const { status, json } = await postHold(eventId, { userId: challenger, showSeatIds: [seatId] });

    assert.equal(status, 409);
    assert.equal(json.error?.code, 'CONFLICT');

    // The incumbent hold is untouched and still active.
    const hold = await query<{ status: string }>(
      'SELECT status FROM reservation_holds WHERE id = $1',
      [liveHoldId],
    );
    assert.equal(hold.rows[0]!.status, 'active');
    assert.equal(await countHolds(eventId), 1);
  });

  it('reclaims a seat whose hold has lapsed, expiring the old hold', async () => {
    const { eventId, seats } = await seedShow(2);
    const previousOwner = await seedCustomer();
    const newOwner = await seedCustomer();
    const seatId = seats[0]!.id;

    const lapsedHoldId = await seedLapsedHold(eventId, previousOwner, [seatId]);

    const { status, json } = await postHold(eventId, { userId: newOwner, showSeatIds: [seatId] });

    assert.equal(status, 201);
    assert.notEqual(json.holdId, lapsedHoldId);

    // The lapsed hold was transitioned, not deleted: it keeps its seat list.
    const old = await query<{ status: string }>(
      'SELECT status FROM reservation_holds WHERE id = $1',
      [lapsedHoldId],
    );
    assert.equal(old.rows[0]!.status, 'expired');

    const oldLinks = await query<{ count: string }>(
      'SELECT count(*)::text AS count FROM reservation_hold_seats WHERE hold_id = $1',
      [lapsedHoldId],
    );
    assert.equal(oldLinks.rows[0]!.count, '1');

    // The seat now belongs to the new hold and is held again.
    assert.equal((await seatStatuses([seatId]))[seatId], 'held');
    const newLinks = await query<{ show_seat_id: string }>(
      'SELECT show_seat_id FROM reservation_hold_seats WHERE hold_id = $1',
      [json.holdId],
    );
    assert.deepEqual(newLinks.rows.map((row) => row.show_seat_id), [seatId]);
  });

  it('does not expire a hold that is still alive', async () => {
    const { eventId, seats } = await seedShow(2);
    const owner = await seedCustomer();
    const challenger = await seedCustomer();
    const liveSeat = seats[0]!.id;

    const liveHoldId = await seedLiveHold(eventId, owner, [liveSeat], 900);
    await postHold(eventId, { userId: challenger, showSeatIds: [liveSeat] });

    const hold = await query<{ status: string }>(
      'SELECT status FROM reservation_holds WHERE id = $1',
      [liveHoldId],
    );
    assert.equal(hold.rows[0]!.status, 'active');
  });
});

describe('POST /api/v1/events/:eventId/holds - atomicity', () => {
  it('changes nothing when one seat of the selection is unavailable', async () => {
    const { eventId, seats } = await seedShow(3); // A12, A13, A14
    const owner = await seedCustomer();
    const challenger = await seedCustomer();
    const [a12, a13, a14] = [seats[0]!.id, seats[1]!.id, seats[2]!.id];

    // A13 is taken by someone else.
    await seedLiveHold(eventId, owner, [a13]);

    const { status } = await postHold(eventId, { userId: challenger, showSeatIds: [a12, a13, a14] });
    assert.equal(status, 409);

    // A12 and A14 must be exactly as they were: available, and in no hold.
    const statuses = await seatStatuses([a12, a13, a14]);
    assert.equal(statuses[a12], 'available');
    assert.equal(statuses[a14], 'available');
    assert.equal(statuses[a13], 'held');

    // Only the incumbent hold exists, and it still covers only A13.
    assert.equal(await countHolds(eventId), 1);
    const links = await query<{ show_seat_id: string }>(
      'SELECT show_seat_id FROM reservation_hold_seats',
    );
    assert.ok(!links.rows.some((row) => row.show_seat_id === a12 || row.show_seat_id === a14));
  });

  it('rolls the whole transaction back when the hold-seat insert fails', async () => {
    const { eventId, seats } = await seedShow(3);
    const userId = await seedCustomer();
    const seatIds = seats.map((seat) => seat.id);

    // Fault injection: force every reservation_hold_seats insert to fail.
    // NOT VALID leaves rows created by earlier tests untouched.
    await query(
      'ALTER TABLE reservation_hold_seats ADD CONSTRAINT tmp_force_failure CHECK (false) NOT VALID',
    );

    try {
      const { status } = await postHold(eventId, { userId, showSeatIds: seatIds });
      assert.equal(status, 500);

      // No hold, no links, and every seat still available.
      assert.equal(await countHolds(eventId), 0);
      const statuses = await seatStatuses(seatIds);
      assert.ok(Object.values(statuses).every((value) => value === 'available'));
    } finally {
      await query('ALTER TABLE reservation_hold_seats DROP CONSTRAINT tmp_force_failure');
    }
  });

  it('does not leak database internals on an unexpected failure', async () => {
    const { eventId, seats } = await seedShow(1);
    const userId = await seedCustomer();

    await query(
      'ALTER TABLE reservation_hold_seats ADD CONSTRAINT tmp_force_failure CHECK (false) NOT VALID',
    );

    try {
      const { status, json } = await postHold(eventId, { userId, showSeatIds: [seats[0]!.id] });
      assert.equal(status, 500);
      // The client-facing fields carry nothing from PostgreSQL: no SQLSTATE, no
      // constraint or table name, no driver message.
      assert.equal(json.error?.code, 'INTERNAL_SERVER_ERROR');
      assert.equal(json.error?.message, 'Internal server error');
      assert.equal(json.error?.details, undefined);
      // `stack` is a separate, pre-existing debugging aid that the shared error
      // handler adds outside production only (see middleware/error-handler.ts),
      // so it is excluded here rather than asserted on.
    } finally {
      await query('ALTER TABLE reservation_hold_seats DROP CONSTRAINT tmp_force_failure');
    }
  });
});
