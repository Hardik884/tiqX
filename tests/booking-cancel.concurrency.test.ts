import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { after, before, describe, it } from 'node:test';

import { createApp } from '../src/app.js';
import { closePool, query } from '../src/db/pool.js';
import {
  expireHold,
  publishPendingExpirations,
  sweepExpiredHolds,
} from '../src/modules/expiration/expiration.service.js';
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
  json: {
    bookingId?: string;
    status?: string;
    releasedSeatCount?: number;
    cancelledAt?: string;
    error?: { code: string; details?: { reason?: string } };
  };
}

/** Builds the request up front, so the burst measures the API and not JWT work. */
async function cancelRequest(bookingId: string, userId: string, key: string) {
  const authorization = `Bearer ${await accessTokenForUser(userId)}`;

  return async (): Promise<Reply> => {
    const response = await fetch(`${baseUrl}/api/v1/bookings/${bookingId}/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization, 'idempotency-key': key },
    });
    const raw = await response.text();
    return { status: response.status, json: raw ? JSON.parse(raw) : {} };
  };
}

async function confirmRequest(eventId: string, holdId: string, userId: string) {
  const authorization = `Bearer ${await accessTokenForUser(userId)}`;
  const key = randomUUID();

  return async (): Promise<Reply> => {
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
    title: `Cancel race ${randomUUID()}`,
    eventType: 'concert',
    startsAt: new Date('2030-01-01T18:00:00.000Z'),
    endsAt: new Date('2030-01-01T20:00:00.000Z'),
    pricing: { standard: price },
  });
  const seats = await query<{ id: string }>(
    'SELECT id FROM show_seats WHERE event_id = $1 ORDER BY id',
    [event.id],
  );
  return { eventId: event.id, seatIds: seats.rows.map((row) => row.id) };
}

async function bookSeats(eventId: string, userId: string, showSeatIds: readonly string[]) {
  const hold = await createHold({ eventId, userId, showSeatIds, ttlSeconds: 600 });
  const send = await confirmRequest(eventId, hold.holdId, userId);
  const reply = await send();
  assert.equal(reply.status, 201, 'setup: the booking must confirm');
  return { bookingId: reply.json.bookingId!, holdId: hold.holdId };
}

async function seatStatuses(ids: readonly string[]): Promise<string[]> {
  const result = await query<{ status: string }>(
    'SELECT status FROM show_seats WHERE id = ANY($1::uuid[]) ORDER BY id',
    [ids],
  );
  return result.rows.map((row) => row.status);
}

async function countZero(label: string, sql: string, params: unknown[]): Promise<void> {
  const result = await query<{ count: string }>(sql, params);
  assert.equal(result.rows[0]!.count, '0', label);
}

/**
 * Every invariant that must hold for one event, whoever won a race.
 *
 * Scoped to a single event rather than the whole table, so a leftover row from
 * another suite cannot turn a real result into a false one - or hide it.
 */
async function assertConsistent(eventId: string): Promise<void> {
  await countZero(
    'a live booking seat implies a booked show seat',
    `SELECT count(*)::text AS count
     FROM booking_seats bs
     JOIN show_seats ss ON ss.id = bs.show_seat_id
     WHERE ss.event_id = $1 AND bs.cancelled_at IS NULL AND ss.status <> 'booked'`,
    [eventId],
  );

  await countZero(
    'a booked show seat belongs to exactly one live booking',
    `SELECT count(*)::text AS count
     FROM show_seats ss
     WHERE ss.event_id = $1 AND ss.status = 'booked'
       AND (
         SELECT count(*) FROM booking_seats bs
         WHERE bs.show_seat_id = ss.id AND bs.cancelled_at IS NULL
       ) <> 1`,
    [eventId],
  );

  await countZero(
    'a live booking seat belongs to a confirmed booking',
    `SELECT count(*)::text AS count
     FROM booking_seats bs
     JOIN bookings b ON b.id = bs.booking_id
     WHERE b.event_id = $1 AND bs.cancelled_at IS NULL AND b.status <> 'confirmed'`,
    [eventId],
  );

  await countZero(
    'a cancelled booking holds no live seats',
    `SELECT count(*)::text AS count
     FROM booking_seats bs
     JOIN bookings b ON b.id = bs.booking_id
     WHERE b.event_id = $1 AND b.status = 'cancelled' AND bs.cancelled_at IS NULL`,
    [eventId],
  );

  // The §15 invariant, both ways round: a seat an active hold owns is never
  // available, and a seat a booking owns is never merely held.
  await countZero(
    'a live hold implies a held seat',
    `SELECT count(*)::text AS count
     FROM reservation_holds rh
     JOIN reservation_hold_seats rhs ON rhs.hold_id = rh.id
     JOIN show_seats ss ON ss.id = rhs.show_seat_id
     WHERE rh.event_id = $1 AND rh.status = 'active' AND rh.expires_at > now()
       AND ss.status <> 'held'`,
    [eventId],
  );
}

describe('50 concurrent cancellations, same idempotency key', () => {
  it('cancels once and replays that answer to every caller', async () => {
    const ATTEMPTS = 50;
    const { eventId, seatIds } = await seedPricedShow(3);
    const userId = await seedCustomer();
    const { bookingId } = await bookSeats(eventId, userId, seatIds);
    const key = randomUUID();

    const requests = await Promise.all(
      Array.from({ length: ATTEMPTS }, () => cancelRequest(bookingId, userId, key)),
    );
    const replies = await Promise.all(requests.map((send) => send()));

    // Idempotency, not contention: every caller gets the cancellation.
    assert.deepEqual([...new Set(replies.map((r) => r.status))], [200]);
    assert.equal(new Set(replies.map((r) => r.json.cancelledAt)).size, 1, 'one moment of cancellation');
    assert.deepEqual([...new Set(replies.map((r) => r.json.releasedSeatCount))], [3]);

    assert.deepEqual(await seatStatuses(seatIds), ['available', 'available', 'available']);

    const seats = await query<{ count: string }>(
      'SELECT count(*)::text AS count FROM booking_seats WHERE booking_id = $1',
      [bookingId],
    );
    assert.equal(seats.rows[0]!.count, '3', 'the history survives, undisturbed');

    await assertConsistent(eventId);
  });
});

describe('50 concurrent cancellations, different idempotency keys', () => {
  it('lets exactly one succeed and tells the rest it is already cancelled', async () => {
    const ATTEMPTS = 50;
    const { eventId, seatIds } = await seedPricedShow(2);
    const userId = await seedCustomer();
    const { bookingId } = await bookSeats(eventId, userId, seatIds);

    // Distinct keys, so idempotency cannot help. Only the row lock and the
    // guarded UPDATE stand between these and a double release.
    const requests = await Promise.all(
      Array.from({ length: ATTEMPTS }, () => cancelRequest(bookingId, userId, randomUUID())),
    );
    const replies = await Promise.all(requests.map((send) => send()));

    const cancelled = replies.filter((r) => r.status === 200);
    const conflicted = replies.filter((r) => r.status === 409);

    // Printed so a failure here says what actually came back, not just that a
    // count was wrong. It is the first thing you want when a guard is broken.
    const tally: Record<string, number> = {};
    for (const reply of replies) {
      const label = `${reply.status} ${reply.json.error?.details?.reason ?? 'ok'}`;
      tally[label] = (tally[label] ?? 0) + 1;
    }
    console.log('cancel-50-distinct-keys:', JSON.stringify(tally));

    assert.equal(cancelled.length, 1, 'exactly one cancellation succeeds');
    assert.equal(conflicted.length, ATTEMPTS - 1, 'the rest are told it is already cancelled');
    assert.equal(cancelled.length + conflicted.length, ATTEMPTS, 'no other status codes');
    assert.ok(
      conflicted.every((r) => r.json.error?.details?.reason === 'BOOKING_ALREADY_CANCELLED'),
      'and told why',
    );

    assert.deepEqual(await seatStatuses(seatIds), ['available', 'available']);

    const stamped = await query<{ count: string }>(
      `SELECT count(*)::text AS count FROM booking_seats
       WHERE booking_id = $1 AND cancelled_at IS NOT NULL`,
      [bookingId],
    );
    assert.equal(stamped.rows[0]!.count, '2', 'each seat row is retired exactly once');

    // One cancellation timestamp across all the rows: they were stamped by a
    // single statement in a single transaction, not by 50 racing ones.
    const moments = await query<{ count: string }>(
      'SELECT count(DISTINCT cancelled_at)::text AS count FROM booking_seats WHERE booking_id = $1',
      [bookingId],
    );
    assert.equal(moments.rows[0]!.count, '1');

    await assertConsistent(eventId);
  });
});

describe('cancellation racing a new reservation', () => {
  it('never leaves a seat available while a live hold owns it', async () => {
    const ROUNDS = 24;
    let reservedAfter = 0;
    let reservationRefused = 0;

    for (let round = 0; round < ROUNDS; round += 1) {
      const { eventId, seatIds } = await seedPricedShow(1);
      const owner = await seedCustomer();
      const challenger = await seedCustomer();
      const { bookingId } = await bookSeats(eventId, owner, seatIds);

      const send = await cancelRequest(bookingId, owner, randomUUID());

      // One transaction wants to release the seat; the other wants it. Both
      // take show_seats locks in ascending id order, so they serialise.
      //
      // The jitter is what makes this a real race. Without it the reservation -
      // an in-process call - always beats a cancellation that has to cross HTTP
      // first, and only one of the two outcomes would ever be exercised.
      const jitter = Math.random() * 12;
      const [cancelResult, reserveResult] = await Promise.allSettled([
        send(),
        delay(jitter).then(() =>
          createHold({ eventId, userId: challenger, showSeatIds: seatIds, ttlSeconds: 600 }),
        ),
      ]);

      assert.equal(cancelResult.status, 'fulfilled', `round ${round}: the API must not error`);
      assert.equal(cancelResult.value.status, 200, `round ${round}: the owner may always cancel`);

      const [seatStatus] = await seatStatuses(seatIds);

      if (reserveResult.status === 'fulfilled') {
        // The reservation got in after the release committed.
        reservedAfter += 1;
        assert.equal(seatStatus, 'held', `round ${round}: the challenger holds it`);
      } else {
        // It ran first, saw a booked seat, and was refused - the cancellation
        // then released a seat nobody else had taken.
        reservationRefused += 1;
        assert.equal(seatStatus, 'available', `round ${round}: released and unclaimed`);
      }

      await assertConsistent(eventId);
    }

    // Not asserting a split - that is timing - only that every round landed in
    // one of the two correct outcomes. Reporting it makes the coverage visible.
    assert.equal(reservedAfter + reservationRefused, ROUNDS);
    console.log(`cancel-vs-reserve: ${reservedAfter} reserved after release, ${reservationRefused} refused`);
  });

  it('never lets a cancellation reclaim a seat someone else has since taken', async () => {
    for (let round = 0; round < 10; round += 1) {
      const { eventId, seatIds } = await seedPricedShow(1);
      const owner = await seedCustomer();
      const challenger = await seedCustomer();
      const { bookingId } = await bookSeats(eventId, owner, seatIds);

      const send = await cancelRequest(bookingId, owner, randomUUID());
      assert.equal((await send()).status, 200);

      // The seat is free, and the challenger takes it. A retried cancellation
      // must not reach through to a seat that is no longer its own.
      await createHold({ eventId, userId: challenger, showSeatIds: seatIds, ttlSeconds: 600 });

      const retry = await cancelRequest(bookingId, owner, randomUUID());
      const stale = await retry();

      assert.equal(stale.status, 409, `round ${round}: refused`);
      assert.deepEqual(await seatStatuses(seatIds), ['held'], `round ${round}: still the challenger's`);

      await assertConsistent(eventId);
    }
  });
});

describe('cancellation racing the expiration worker', () => {
  it('leaves the converted hold alone while the booking is cancelled', async () => {
    for (let round = 0; round < 10; round += 1) {
      const { eventId, seatIds } = await seedPricedShow(2);
      const userId = await seedCustomer();
      const { bookingId, holdId } = await bookSeats(eventId, userId, seatIds);

      // Force the worker to look at this hold: its clock has passed, even
      // though it is converted and therefore terminal.
      await query('UPDATE reservation_holds SET expires_at = now() - interval \'1 minute\' WHERE id = $1', [
        holdId,
      ]);

      const send = await cancelRequest(bookingId, userId, randomUUID());

      const [cancelResult, expireResult, sweepResult] = await Promise.allSettled([
        send(),
        expireHold(holdId),
        sweepExpiredHolds(),
      ]);

      assert.equal(cancelResult.status, 'fulfilled', `round ${round}`);
      assert.equal(cancelResult.value.status, 200, `round ${round}: cancellation succeeds`);
      assert.equal(expireResult.status, 'fulfilled', `round ${round}: the worker must not error`);
      assert.equal(expireResult.value, 'noop', `round ${round}: a converted hold is terminal`);
      assert.equal(sweepResult.status, 'fulfilled', `round ${round}: the sweep must not error`);

      const hold = await query<{ status: string }>(
        'SELECT status FROM reservation_holds WHERE id = $1',
        [holdId],
      );
      assert.equal(hold.rows[0]!.status, 'converted', `round ${round}: still converted`);
      assert.deepEqual(
        await seatStatuses(seatIds),
        ['available', 'available'],
        `round ${round}: released by the cancellation, not by the worker`,
      );

      await assertConsistent(eventId);
    }
  });

  it('never lets the worker release the seats of a booking that is still confirmed', async () => {
    const { eventId, seatIds } = await seedPricedShow(2);
    const userId = await seedCustomer();
    const { holdId } = await bookSeats(eventId, userId, seatIds);

    await query('UPDATE reservation_holds SET expires_at = now() - interval \'1 hour\' WHERE id = $1', [
      holdId,
    ]);

    // The whole pipeline, not just one call: publish, sweep, expire.
    await publishPendingExpirations();
    await sweepExpiredHolds();
    assert.equal(await expireHold(holdId), 'noop');

    assert.deepEqual(await seatStatuses(seatIds), ['booked', 'booked'], 'a sold seat stays sold');
    await assertConsistent(eventId);
  });
});

describe('cancellation racing a confirmation', () => {
  it('lets both commit when they own different seats of one event', async () => {
    for (let round = 0; round < 10; round += 1) {
      const { eventId, seatIds } = await seedPricedShow(4);
      const owner = await seedCustomer();
      const buyer = await seedCustomer();

      const mine = seatIds.slice(0, 2);
      const theirs = seatIds.slice(2);
      const { bookingId } = await bookSeats(eventId, owner, mine);
      const hold = await createHold({ eventId, userId: buyer, showSeatIds: theirs, ttlSeconds: 600 });

      const cancelSend = await cancelRequest(bookingId, owner, randomUUID());
      const confirmSend = await confirmRequest(eventId, hold.holdId, buyer);

      const [cancelResult, confirmResult] = await Promise.allSettled([cancelSend(), confirmSend()]);

      assert.equal(cancelResult.status, 'fulfilled', `round ${round}`);
      assert.equal(confirmResult.status, 'fulfilled', `round ${round}`);
      assert.equal(cancelResult.value.status, 200, `round ${round}: cancellation commits`);
      assert.equal(confirmResult.value.status, 201, `round ${round}: confirmation commits`);

      assert.deepEqual(await seatStatuses(mine), ['available', 'available']);
      assert.deepEqual(await seatStatuses(theirs), ['booked', 'booked']);
      await assertConsistent(eventId);
    }
  });

  it('never gives one seat to a cancellation and a confirmation at once', async () => {
    const ROUNDS = 20;
    let chaseWon = 0;
    let chaseLost = 0;

    for (let round = 0; round < ROUNDS; round += 1) {
      const { eventId, seatIds } = await seedPricedShow(1);
      const owner = await seedCustomer();
      const buyer = await seedCustomer();
      const { bookingId } = await bookSeats(eventId, owner, seatIds);

      const cancelSend = await cancelRequest(bookingId, owner, randomUUID());

      // The buyer chases the seat: hold it the moment it is free, then confirm.
      // Jittered so both outcomes actually occur rather than one always winning.
      const chase = (async () => {
        await delay(Math.random() * 12);
        const hold = await createHold({
          eventId,
          userId: buyer,
          showSeatIds: seatIds,
          ttlSeconds: 600,
        });
        const send = await confirmRequest(eventId, hold.holdId, buyer);
        return send();
      })();

      const [cancelResult, chaseResult] = await Promise.allSettled([cancelSend(), chase]);

      assert.equal(cancelResult.status, 'fulfilled', `round ${round}`);
      assert.equal(cancelResult.value.status, 200, `round ${round}`);

      const [seatStatus] = await seatStatuses(seatIds);
      const bookings = await query<{ id: string; status: string }>(
        'SELECT id, status FROM bookings WHERE event_id = $1 ORDER BY created_at',
        [eventId],
      );

      if (chaseResult.status === 'fulfilled' && chaseResult.value.status === 201) {
        // The chase won the seat after the release. Two bookings exist, only
        // the second is confirmed, and the seat belongs to it.
        chaseWon += 1;
        assert.equal(seatStatus, 'booked', `round ${round}`);
        assert.equal(bookings.rowCount, 2, `round ${round}`);
        assert.deepEqual(
          bookings.rows.map((row) => row.status),
          ['cancelled', 'confirmed'],
          `round ${round}: the cancelled booking never comes back`,
        );
      } else {
        chaseLost += 1;
        assert.equal(seatStatus, 'available', `round ${round}: released and unclaimed`);
        assert.deepEqual(bookings.rows.map((row) => row.status), ['cancelled'], `round ${round}`);
      }

      await assertConsistent(eventId);
    }

    assert.equal(chaseWon + chaseLost, ROUNDS);
    console.log(`cancel-vs-confirm: ${chaseWon} resold, ${chaseLost} released unclaimed`);
  });
});
