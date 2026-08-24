import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { after, before, describe, it } from 'node:test';

import { createApp } from '../src/app.js';
import { closePool, query } from '../src/db/pool.js';
import { expireHold, sweepExpiredHolds } from '../src/modules/expiration/expiration.service.js';
import { createEvent } from '../src/modules/events/event.service.js';
import { createHold } from '../src/modules/reservations/reservation.service.js';
import { accessTokenForUser } from './helpers/auth.js';
import { closeTestRedis, connectTestRedis, flushTestNamespace } from './helpers/redis.js';
import { cleanupSeedData, seedCustomer, seedOrganiser, seedVenue } from './helpers/seed.js';

let server: Server;
let baseUrl: string;

before(async () => {
  await connectTestRedis();
  await flushTestNamespace();
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await query('DELETE FROM idempotency_keys');
  await flushTestNamespace();
  await closeTestRedis();
  await cleanupSeedData();
  await closePool();
});

interface Reply {
  status: number;
  json: { bookingId?: string; error?: { code: string; details?: { reason?: string } } };
}

/** Builds a request, minting the token up front so the burst measures the API. */
async function confirmRequest(
  eventId: string,
  holdId: string,
  userId: string,
  key: string,
): Promise<() => Promise<Reply>> {
  const authorization = `Bearer ${await accessTokenForUser(userId)}`;

  return async () => {
    const response = await fetch(`${baseUrl}/api/v1/events/${eventId}/holds/${holdId}/confirm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization, 'idempotency-key': key },
    });
    const raw = await response.text();
    return { status: response.status, json: raw ? JSON.parse(raw) : {} };
  };
}

async function seedPricedShow(seatCount: number, price = '250.00') {
  const organiserId = await seedOrganiser();
  const { venueId } = await seedVenue(seatCount, 'A', 12);
  const { event } = await createEvent({
    organiserId,
    venueId,
    title: `Concurrent ${randomUUID()}`,
    eventType: 'concert',
    startsAt: new Date('2030-01-01T18:00:00.000Z'),
    endsAt: new Date('2030-01-01T20:00:00.000Z'),
    pricing: { standard: price },
  });
  const seats = await query<{ id: string }>(
    'SELECT id FROM show_seats WHERE event_id = $1 ORDER BY id',
    [event.id],
  );
  return { eventId: event.id, seatIds: seats.rows.map((r) => r.id) };
}

async function bookingCount(eventId: string): Promise<number> {
  const result = await query<{ count: string }>(
    'SELECT count(*)::text AS count FROM bookings WHERE event_id = $1',
    [eventId],
  );
  return Number(result.rows[0]!.count);
}

/** Every invariant that must hold no matter who won a race. */
async function assertNoCorruption(eventId: string, holdId: string, seatIds: string[]): Promise<void> {
  const bookings = await query<{ id: string; hold_id: string }>(
    'SELECT id, hold_id FROM bookings WHERE event_id = $1',
    [eventId],
  );
  assert.ok(bookings.rowCount! <= 1, 'at most one booking per hold');

  const hold = await query<{ status: string }>(
    'SELECT status FROM reservation_holds WHERE id = $1',
    [holdId],
  );
  const holdStatus = hold.rows[0]!.status;

  const seats = await query<{ status: string }>(
    'SELECT status FROM show_seats WHERE id = ANY($1::uuid[])',
    [seatIds],
  );
  const seatStates = new Set(seats.rows.map((r) => r.status));

  if (bookings.rowCount === 1) {
    // A booking exists, so the hold must be converted and every seat booked.
    // "hold expired AND booking confirmed" and "seat available AND booking
    // confirmed" are the two states this system must never reach.
    assert.equal(holdStatus, 'converted', 'a booking implies a converted hold');
    assert.deepEqual([...seatStates], ['booked'], 'a booking implies booked seats');
  } else {
    assert.notEqual(holdStatus, 'converted', 'no booking means the hold was not converted');
    assert.ok(!seatStates.has('booked'), 'no booking means no booked seat');
  }

  // No seat is ever sold twice, whatever happened.
  const doubleSold = await query<{ count: string }>(
    `SELECT count(*)::text AS count FROM (
       SELECT show_seat_id FROM booking_seats GROUP BY show_seat_id HAVING count(*) > 1
     ) t`,
  );
  assert.equal(doubleSold.rows[0]!.count, '0', 'no seat belongs to two bookings');
}

describe('50 concurrent confirmations, same idempotency key', () => {
  it('produces one booking and replays it to every caller', async () => {
    const ATTEMPTS = 50;
    const { eventId, seatIds } = await seedPricedShow(3);
    const userId = await seedCustomer();
    const hold = await createHold({ eventId, userId, showSeatIds: seatIds, ttlSeconds: 600 });
    const key = randomUUID();

    const requests = await Promise.all(
      Array.from({ length: ATTEMPTS }, () => confirmRequest(eventId, hold.holdId, userId, key)),
    );
    const replies = await Promise.all(requests.map((send) => send()));

    // Idempotency, not contention: every caller gets the booking.
    assert.deepEqual([...new Set(replies.map((r) => r.status))], [201]);
    const bookingIds = new Set(replies.map((r) => r.json.bookingId));
    assert.equal(bookingIds.size, 1, 'all 50 responses name the same booking');

    assert.equal(await bookingCount(eventId), 1);

    const seatRows = await query<{ count: string }>(
      'SELECT count(*)::text AS count FROM booking_seats WHERE booking_id = $1',
      [[...bookingIds][0]],
    );
    assert.equal(seatRows.rows[0]!.count, '3', 'no duplicate booking seats');

    await assertNoCorruption(eventId, hold.holdId, seatIds);
  });
});

describe('50 concurrent confirmations, different idempotency keys', () => {
  it('lets exactly one succeed and the rest observe the hold is spent', async () => {
    const ATTEMPTS = 50;
    const { eventId, seatIds } = await seedPricedShow(2);
    const userId = await seedCustomer();
    const hold = await createHold({ eventId, userId, showSeatIds: seatIds, ttlSeconds: 600 });

    // Distinct keys, so idempotency cannot help. Only the row locks and the
    // hold state machine stand between these and a double booking - which is
    // precisely why this test exists alongside the one above.
    const requests = await Promise.all(
      Array.from({ length: ATTEMPTS }, () =>
        confirmRequest(eventId, hold.holdId, userId, randomUUID()),
      ),
    );
    const replies = await Promise.all(requests.map((send) => send()));

    const created = replies.filter((r) => r.status === 201);
    const conflicted = replies.filter((r) => r.status === 409);

    assert.equal(created.length, 1, 'exactly one confirmation succeeds');
    assert.equal(conflicted.length, ATTEMPTS - 1, 'the rest are told the hold is spent');
    assert.equal(created.length + conflicted.length, ATTEMPTS, 'no other status codes');

    assert.ok(
      conflicted.every((r) => r.json.error?.details?.reason === 'HOLD_ALREADY_CONFIRMED'),
      'and told why',
    );

    assert.equal(await bookingCount(eventId), 1);
    await assertNoCorruption(eventId, hold.holdId, seatIds);
  });
});

describe('confirmation racing the expiration worker', () => {
  it('never lets both win, over many rounds', async () => {
    const ROUNDS = 15;
    let confirmedWins = 0;
    let expiredWins = 0;

    for (let round = 0; round < ROUNDS; round += 1) {
      const { eventId, seatIds } = await seedPricedShow(2);
      const userId = await seedCustomer();
      // A hold right on the edge: by the time both racers start, it is about to
      // expire, so either can plausibly win.
      const hold = await createHold({ eventId, userId, showSeatIds: seatIds, ttlSeconds: 1 });
      await delay(950);

      const send = await confirmRequest(eventId, hold.holdId, userId, randomUUID());

      const [confirmResult, expireResult] = await Promise.allSettled([
        send(),
        expireHold(hold.holdId),
      ]);

      assert.equal(expireResult.status, 'fulfilled', `round ${round}: the worker must not error`);
      assert.equal(confirmResult.status, 'fulfilled', `round ${round}: the API must not error`);

      const reply = confirmResult.value;
      const holdRow = await query<{ status: string }>(
        'SELECT status FROM reservation_holds WHERE id = $1',
        [hold.holdId],
      );
      const status = holdRow.rows[0]!.status;

      if (reply.status === 201) {
        confirmedWins += 1;
        assert.equal(status, 'converted', `round ${round}: confirmation won, hold is converted`);
        // The worker must have become a harmless no-op.
        assert.equal(expireResult.value, 'noop', `round ${round}: the worker yielded`);
      } else {
        expiredWins += 1;
        assert.equal(reply.status, 409, `round ${round}: confirmation failed cleanly`);
        assert.ok(
          ['HOLD_EXPIRED', 'HOLD_INVALID'].includes(reply.json.error?.details?.reason ?? ''),
          `round ${round}: with an expiry reason, got ${reply.json.error?.details?.reason}`,
        );
        assert.equal(status, 'expired', `round ${round}: expiry won`);
      }

      await assertNoCorruption(eventId, hold.holdId, seatIds);
    }

    // Not asserting a particular split - that is timing - only that both
    // outcomes are handled. Reporting it makes the coverage visible.
    assert.equal(confirmedWins + expiredWins, ROUNDS);
    assert.ok(confirmedWins > 0 || expiredWins > 0);
  });

  it('survives the full sweep running against a confirming hold', async () => {
    for (let round = 0; round < 8; round += 1) {
      const { eventId, seatIds } = await seedPricedShow(2);
      const userId = await seedCustomer();
      const hold = await createHold({ eventId, userId, showSeatIds: seatIds, ttlSeconds: 1 });
      await delay(950);

      const send = await confirmRequest(eventId, hold.holdId, userId, randomUUID());

      // The real sweep, not a single-hold call: it scans, picks candidates and
      // locks them in the same order confirmation does.
      const [confirmResult, sweepResult] = await Promise.allSettled([send(), sweepExpiredHolds()]);

      assert.equal(sweepResult.status, 'fulfilled', `round ${round}: the sweep must not error`);
      assert.equal(confirmResult.status, 'fulfilled');
      await assertNoCorruption(eventId, hold.holdId, seatIds);
    }
  });

  it('refuses to expire a hold that was confirmed a moment earlier', async () => {
    const { eventId, seatIds } = await seedPricedShow(2);
    const userId = await seedCustomer();
    const hold = await createHold({ eventId, userId, showSeatIds: seatIds, ttlSeconds: 1 });

    const send = await confirmRequest(eventId, hold.holdId, userId, randomUUID());
    const reply = await send();
    assert.equal(reply.status, 201);

    // The hold's clock passes while it is already converted. The worker sees a
    // terminal state and leaves it alone - a booked seat must never be released.
    await delay(1_200);
    assert.equal(await expireHold(hold.holdId), 'noop');
    await sweepExpiredHolds();

    const holdRow = await query<{ status: string }>(
      'SELECT status FROM reservation_holds WHERE id = $1',
      [hold.holdId],
    );
    assert.equal(holdRow.rows[0]!.status, 'converted', 'a converted hold is terminal');

    const seats = await query<{ status: string }>(
      'SELECT DISTINCT status FROM show_seats WHERE id = ANY($1::uuid[])',
      [seatIds],
    );
    assert.deepEqual(seats.rows.map((r) => r.status), ['booked'], 'the seats stay sold');
  });
});

describe('confirmation racing a new reservation', () => {
  it('never leaves a seat both booked and re-held', async () => {
    for (let round = 0; round < 8; round += 1) {
      const { eventId, seatIds } = await seedPricedShow(1);
      const owner = await seedCustomer();
      const challenger = await seedCustomer();
      const hold = await createHold({ eventId, userId: owner, showSeatIds: seatIds, ttlSeconds: 1 });
      await delay(950);

      const send = await confirmRequest(eventId, hold.holdId, owner, randomUUID());

      // One transaction wants to sell the seat; the other wants to reclaim and
      // re-hold it. Both take seat locks first, so they serialise.
      const [confirmResult, reserveResult] = await Promise.allSettled([
        send(),
        createHold({ eventId, userId: challenger, showSeatIds: seatIds, ttlSeconds: 600 }),
      ]);

      assert.equal(confirmResult.status, 'fulfilled', `round ${round}`);

      const seat = await query<{ status: string }>(
        'SELECT status FROM show_seats WHERE id = $1',
        [seatIds[0]],
      );
      const seatStatus = seat.rows[0]!.status;

      if (confirmResult.value.status === 201) {
        assert.equal(seatStatus, 'booked', `round ${round}: sold`);
        assert.equal(
          reserveResult.status,
          'rejected',
          `round ${round}: a sold seat cannot also be newly held`,
        );
      } else if (reserveResult.status === 'fulfilled') {
        assert.equal(seatStatus, 'held', `round ${round}: re-held by the challenger`);
        assert.equal(await bookingCount(eventId), 0);
      }

      await assertNoCorruption(eventId, hold.holdId, seatIds);
    }
  });
});
