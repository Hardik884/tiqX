import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { after, before, describe, it } from 'node:test';

import { createApp } from '../src/app.js';
import { closePool, query, withTransaction } from '../src/db/pool.js';
import { createEvent, publishEvent } from '../src/modules/events/event.service.js';
import { createHold } from '../src/modules/reservations/reservation.service.js';
import { expireHold } from '../src/modules/expiration/expiration.service.js';
import {
  claimPendingAllocations,
  markAllocationProcessed,
} from '../src/modules/waitlist/waitlist-outbox.repository.js';
import { runAllocationPass } from '../src/modules/waitlist/waitlist.service.js';
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
  json: { waitlistEntryId?: string; bookingId?: string; error?: { code: string; details?: { reason?: string } } };
}

async function joinRequest(eventId: string, userId: string, key: string) {
  const authorization = `Bearer ${await accessTokenForUser(userId)}`;
  return async (): Promise<Reply> => {
    const response = await fetch(`${baseUrl}/api/v1/events/${eventId}/waitlist`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization, 'idempotency-key': key },
      body: JSON.stringify({ seatCategory: 'standard' }),
    });
    const raw = await response.text();
    return { status: response.status, json: raw ? JSON.parse(raw) : {} };
  };
}

async function acceptRequest(offerId: string, userId: string, key: string) {
  const authorization = `Bearer ${await accessTokenForUser(userId)}`;
  return async (): Promise<Reply> => {
    const response = await fetch(`${baseUrl}/api/v1/waitlist/offers/${offerId}/accept`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization, 'idempotency-key': key },
    });
    const raw = await response.text();
    return { status: response.status, json: raw ? JSON.parse(raw) : {} };
  };
}

async function post(path: string, userId: string): Promise<Reply> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${await accessTokenForUser(userId)}`,
      'idempotency-key': randomUUID(),
    },
  });
  const raw = await response.text();
  return { status: response.status, json: raw ? JSON.parse(raw) : {} };
}

interface Show {
  eventId: string;
  seatIds: string[];
}

async function seedPublishedShow(seatCount: number): Promise<Show> {
  const organiserId = await seedOrganiser();
  const { venueId } = await seedVenue(seatCount, 'A', 12, null, 'standard');
  const { event } = await createEvent({
    organiserId,
    venueId,
    title: `Waitlist race ${randomUUID()}`,
    eventType: 'concert',
    startsAt: new Date('2030-01-01T18:00:00.000Z'),
    endsAt: new Date('2030-01-01T20:00:00.000Z'),
    pricing: { standard: '100.00' },
  });
  await publishEvent({ eventId: event.id, userId: organiserId, userRole: 'organiser' }, undefined);
  const seats = await query<{ id: string }>('SELECT id FROM show_seats WHERE event_id = $1 ORDER BY id', [
    event.id,
  ]);
  return { eventId: event.id, seatIds: seats.rows.map((row) => row.id) };
}

async function book(eventId: string, userId: string, showSeatId: string): Promise<string> {
  const hold = await createHold({ eventId, userId, showSeatIds: [showSeatId], ttlSeconds: 600 });
  const reply = await post(`/api/v1/events/${eventId}/holds/${hold.holdId}/confirm`, userId);
  assert.equal(reply.status, 201, 'setup: booking must confirm');
  return reply.json.bookingId!;
}

async function cancelBooking(bookingId: string, userId: string): Promise<void> {
  const reply = await post(`/api/v1/bookings/${bookingId}/cancel`, userId);
  assert.equal(reply.status, 200, 'setup: cancellation must succeed');
}

async function processAllocationOutbox(): Promise<void> {
  await withTransaction(async (client) => {
    const rows = await claimPendingAllocations(client, 100);
    for (const row of rows) {
      await runAllocationPass(client, row.eventId, row.seatCategory, undefined);
      await markAllocationProcessed(client, row.id);
    }
  });
}

/** Runs `count` independent allocation-worker transactions concurrently. */
async function processAllocationOutboxConcurrently(count: number): Promise<void> {
  await Promise.all(Array.from({ length: count }, () => processAllocationOutbox()));
}

/** Every invariant that must hold for one event, whoever won a race. */
async function assertConsistent(eventId: string): Promise<void> {
  const countZero = async (label: string, sql: string, params: unknown[]): Promise<void> => {
    const result = await query<{ count: string }>(sql, params);
    assert.equal(result.rows[0]!.count, '0', label);
  };

  await countZero(
    'a held seat has at most one live claim on it (offer or hold)',
    `SELECT count(*)::text AS count
     FROM show_seats ss
     WHERE ss.event_id = $1 AND ss.status = 'held'
       AND (
         SELECT count(*) FROM reservation_holds rh
         WHERE rh.event_id = ss.event_id AND rh.status = 'active'
           AND EXISTS (
             SELECT 1 FROM reservation_hold_seats rhs
             WHERE rhs.hold_id = rh.id AND rhs.show_seat_id = ss.id
           )
       ) <> 1`,
    [eventId],
  );

  await countZero(
    'a live offer implies its seat is held',
    `SELECT count(*)::text AS count
     FROM waitlist_offers wo
     JOIN show_seats ss ON ss.id = wo.show_seat_id
     WHERE ss.event_id = $1 AND wo.status = 'offered' AND ss.status <> 'held'`,
    [eventId],
  );

  await countZero(
    'no seat backs two live offers',
    `SELECT count(*)::text AS count FROM (
       SELECT show_seat_id FROM waitlist_offers WHERE status = 'offered' GROUP BY show_seat_id HAVING count(*) > 1
     ) t`,
    [],
  );

  await countZero(
    'no waitlist entry holds two live offers',
    `SELECT count(*)::text AS count FROM (
       SELECT waitlist_entry_id FROM waitlist_offers WHERE status = 'offered' GROUP BY waitlist_entry_id HAVING count(*) > 1
     ) t`,
    [],
  );

  await countZero(
    'no waitlist entry has two active memberships for the same event/category',
    `SELECT count(*)::text AS count FROM (
       SELECT event_id, user_id, seat_category FROM waitlist_entries
       WHERE event_id = $1 AND status IN ('waiting', 'offered')
       GROUP BY event_id, user_id, seat_category HAVING count(*) > 1
     ) t`,
    [eventId],
  );

  await countZero(
    'an accepted offer implies a booked seat',
    `SELECT count(*)::text AS count
     FROM waitlist_offers wo
     JOIN show_seats ss ON ss.id = wo.show_seat_id
     WHERE ss.event_id = $1 AND wo.status = 'accepted' AND ss.status <> 'booked'`,
    [eventId],
  );

  await countZero(
    'an offer is never both accepted and expired',
    `SELECT count(*)::text AS count FROM waitlist_offers WHERE accepted_at IS NOT NULL AND expired_at IS NOT NULL`,
    [],
  );
}

describe('50 concurrent joins, same idempotency key', () => {
  it('produces one entry and replays it to every caller', async () => {
    const ATTEMPTS = 50;
    const { eventId } = await seedPublishedShow(1);
    const userId = await seedCustomer();
    const key = randomUUID();

    const requests = await Promise.all(Array.from({ length: ATTEMPTS }, () => joinRequest(eventId, userId, key)));
    const replies = await Promise.all(requests.map((send) => send()));

    assert.deepEqual([...new Set(replies.map((r) => r.status))], [201]);
    const entryIds = new Set(replies.map((r) => r.json.waitlistEntryId));
    assert.equal(entryIds.size, 1);

    const count = await query<{ count: string }>(
      'SELECT count(*)::text AS count FROM waitlist_entries WHERE event_id = $1 AND user_id = $2',
      [eventId, userId],
    );
    assert.equal(count.rows[0]!.count, '1');

    await assertConsistent(eventId);
  });
});

describe('50 concurrent joins, different users', () => {
  it('produces 50 independent queue entries in a deterministic order', async () => {
    const ATTEMPTS = 50;
    const { eventId } = await seedPublishedShow(1);
    const userIds = await Promise.all(Array.from({ length: ATTEMPTS }, () => seedCustomer()));

    const requests = await Promise.all(userIds.map((userId) => joinRequest(eventId, userId, randomUUID())));
    const replies = await Promise.all(requests.map((send) => send()));

    assert.deepEqual([...new Set(replies.map((r) => r.status))], [201]);
    assert.equal(new Set(replies.map((r) => r.json.waitlistEntryId)).size, ATTEMPTS);

    const count = await query<{ count: string }>(
      'SELECT count(*)::text AS count FROM waitlist_entries WHERE event_id = $1',
      [eventId],
    );
    assert.equal(count.rows[0]!.count, String(ATTEMPTS));

    // The queue order is well-defined even though every join raced: reading it
    // back with the same ORDER BY the allocator uses must not throw or return
    // duplicates, and every entry must appear exactly once.
    const ordered = await query<{ id: string }>(
      `SELECT id FROM waitlist_entries WHERE event_id = $1 ORDER BY joined_at, id`,
      [eventId],
    );
    assert.equal(new Set(ordered.rows.map((row) => row.id)).size, ATTEMPTS);

    await assertConsistent(eventId);
  });
});

describe('50 concurrent duplicate joins, same user, different keys', () => {
  it('lets exactly one succeed', async () => {
    const ATTEMPTS = 50;
    const { eventId } = await seedPublishedShow(1);
    const userId = await seedCustomer();

    const requests = await Promise.all(
      Array.from({ length: ATTEMPTS }, () => joinRequest(eventId, userId, randomUUID())),
    );
    const replies = await Promise.all(requests.map((send) => send()));

    const created = replies.filter((r) => r.status === 201);
    const conflicted = replies.filter((r) => r.status === 409);

    assert.equal(created.length, 1, 'exactly one join succeeds');
    assert.equal(conflicted.length, ATTEMPTS - 1);
    assert.ok(conflicted.every((r) => r.json.error?.details?.reason === 'ALREADY_ON_WAITLIST'));

    const count = await query<{ count: string }>(
      'SELECT count(*)::text AS count FROM waitlist_entries WHERE event_id = $1 AND user_id = $2',
      [eventId, userId],
    );
    assert.equal(count.rows[0]!.count, '1');

    await assertConsistent(eventId);
  });
});

describe('50 candidates, multiple allocation workers, one seat', () => {
  it('produces exactly one offer, then the next after it expires, repeatedly', async () => {
    const { eventId, seatIds } = await seedPublishedShow(1);
    const owner = await seedCustomer();
    const bookingId = await book(eventId, owner, seatIds[0]!);

    const CANDIDATES = 50;
    const users: string[] = [];
    for (let i = 0; i < CANDIDATES; i += 1) {
      const userId = await seedCustomer();
      const send = await joinRequest(eventId, userId, randomUUID());
      const reply = await send();
      assert.equal(reply.status, 201);
      users.push(userId);
      await delay(2);
    }

    await cancelBooking(bookingId, owner);

    // Several "workers" race for the same signal.
    await processAllocationOutboxConcurrently(5);

    let offered = await query<{ user_id: string; hold_id: string; id: string }>(
      `SELECT we.user_id, wo.hold_id, wo.id
       FROM waitlist_offers wo
       JOIN waitlist_entries we ON we.id = wo.waitlist_entry_id
       WHERE wo.status = 'offered'`,
    );
    assert.equal(offered.rowCount, 1, 'exactly one offer exists, however many workers raced for it');
    assert.equal(offered.rows[0]!.user_id, users[0], 'FIFO: the first joiner was offered first');

    await assertConsistent(eventId);

    // Expire it and let the workers race again, several times, proving FIFO
    // survives repeated multi-worker allocation.
    for (let round = 1; round < 6; round += 1) {
      await query("UPDATE reservation_holds SET expires_at = now() - interval '1 minute' WHERE id = $1", [
        offered.rows[0]!.hold_id,
      ]);
      await expireHold(offered.rows[0]!.hold_id);
      await processAllocationOutboxConcurrently(5);

      offered = await query<{ user_id: string; hold_id: string; id: string }>(
        `SELECT we.user_id, wo.hold_id, wo.id
         FROM waitlist_offers wo
         JOIN waitlist_entries we ON we.id = wo.waitlist_entry_id
         WHERE wo.status = 'offered'`,
      );
      assert.equal(offered.rowCount, 1, `round ${round}: exactly one live offer`);
      assert.equal(offered.rows[0]!.user_id, users[round], `round ${round}: FIFO order preserved`);

      await assertConsistent(eventId);
    }
  });
});

describe('cancellation vs multiple waiters vs a normal reservation', () => {
  it('never gives one seat to two owners, whoever wins', async () => {
    const ROUNDS = 10;

    for (let round = 0; round < ROUNDS; round += 1) {
      const { eventId, seatIds } = await seedPublishedShow(1);
      const owner = await seedCustomer();
      const bookingId = await book(eventId, owner, seatIds[0]!);

      const waiter = await seedCustomer();
      await joinRequest(eventId, waiter, randomUUID()).then((send) => send());
      const challenger = await seedCustomer();

      // Cancellation, allocation and an ordinary reservation all reach for the
      // same seat at once.
      const [cancelResult, reserveResult] = await Promise.allSettled([
        cancelBooking(bookingId, owner),
        delay(Math.random() * 8).then(() =>
          createHold({ eventId, userId: challenger, showSeatIds: [seatIds[0]!], ttlSeconds: 600 }),
        ),
      ]);
      assert.equal(cancelResult.status, 'fulfilled', `round ${round}`);

      await processAllocationOutboxConcurrently(3);

      const seat = await query<{ status: string }>('SELECT status FROM show_seats WHERE id = $1', [
        seatIds[0],
      ]);
      const offer = await query<{ status: string }>(
        'SELECT status FROM waitlist_offers WHERE show_seat_id = $1 AND status = $2',
        [seatIds[0], 'offered'],
      );

      if (reserveResult.status === 'fulfilled') {
        // The ordinary reservation won the seat before allocation could; the
        // waitlist candidate must not also have an offer for it.
        assert.equal(seat.rows[0]!.status, 'held', `round ${round}`);
        assert.equal(offer.rowCount, 0, `round ${round}: no offer for a seat the challenger already holds`);
      } else {
        // Allocation won; the challenger's reservation must have been refused.
        assert.equal(offer.rowCount, 1, `round ${round}: the waiter has the offer`);
        assert.equal(seat.rows[0]!.status, 'held', `round ${round}`);
      }

      await assertConsistent(eventId);
    }
  });
});

describe('accept vs expire, run repeatedly', () => {
  it('never lets both win', async () => {
    const ROUNDS = 15;
    let accepted = 0;
    let expired = 0;

    for (let round = 0; round < ROUNDS; round += 1) {
      const { eventId, seatIds } = await seedPublishedShow(1);
      const owner = await seedCustomer();
      const bookingId = await book(eventId, owner, seatIds[0]!);
      const waiter = await seedCustomer();
      await joinRequest(eventId, waiter, randomUUID()).then((send) => send());

      await cancelBooking(bookingId, owner);
      await processAllocationOutbox();

      const offer = await query<{ id: string; hold_id: string }>(
        'SELECT id, hold_id FROM waitlist_offers WHERE show_seat_id = $1',
        [seatIds[0]],
      );
      const { id: offerId, hold_id: holdId } = offer.rows[0]!;

      // Right on the edge: by the time both race, either can plausibly win.
      await query("UPDATE reservation_holds SET expires_at = now() + interval '1 second' WHERE id = $1", [
        holdId,
      ]);
      await delay(950);

      const send = await acceptRequest(offerId, waiter, randomUUID());
      const [acceptResult, expireResult] = await Promise.allSettled([send(), expireHold(holdId)]);

      assert.equal(acceptResult.status, 'fulfilled', `round ${round}`);
      assert.equal(expireResult.status, 'fulfilled', `round ${round}: the worker must not error`);

      const offerRow = await query<{ status: string }>('SELECT status FROM waitlist_offers WHERE id = $1', [
        offerId,
      ]);
      const status = offerRow.rows[0]!.status;

      if (acceptResult.value.status === 200) {
        accepted += 1;
        assert.equal(status, 'accepted', `round ${round}: accept won`);
        assert.equal(expireResult.value, 'noop', `round ${round}: the worker yielded`);
      } else {
        expired += 1;
        assert.equal(acceptResult.value.status, 409, `round ${round}: acceptance failed cleanly`);
        assert.equal(status, 'expired', `round ${round}: expiry won`);
      }

      await assertConsistent(eventId);
    }

    assert.equal(accepted + expired, ROUNDS);
    assert.ok(accepted > 0 || expired > 0);
  });
});
