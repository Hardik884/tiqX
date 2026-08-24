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
import {
  claimPendingAllocations,
  markAllocationProcessed,
  recordAllocationFailure,
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

async function post(path: string, userId: string, key = randomUUID()): Promise<{ status: number; json: any }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${await accessTokenForUser(userId)}`,
      'idempotency-key': key,
    },
  });
  const raw = await response.text();
  return { status: response.status, json: raw ? JSON.parse(raw) : {} };
}

async function join(eventId: string, userId: string, seatCategory = 'standard') {
  const response = await fetch(`${baseUrl}/api/v1/events/${eventId}/waitlist`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${await accessTokenForUser(userId)}`,
      'idempotency-key': randomUUID(),
    },
    body: JSON.stringify({ seatCategory }),
  });
  const json = (await response.json()) as { waitlistEntryId?: string };
  assert.equal(response.status, 201, 'setup: joining must succeed');
  return json.waitlistEntryId!;
}

interface Show {
  eventId: string;
  organiserId: string;
  seatIds: string[];
}

async function seedPublishedShow(
  seatCount: number,
  category: 'standard' | 'premium' = 'standard',
  rowLabel = 'A',
): Promise<Show> {
  const organiserId = await seedOrganiser();
  const { venueId } = await seedVenue(seatCount, rowLabel, 12, null, category);
  const { event } = await createEvent({
    organiserId,
    venueId,
    title: `Allocation ${randomUUID()}`,
    eventType: 'concert',
    startsAt: new Date('2030-01-01T18:00:00.000Z'),
    endsAt: new Date('2030-01-01T20:00:00.000Z'),
    pricing: { standard: '100.00', premium: '250.00' },
  });
  await publishEvent({ eventId: event.id, userId: organiserId, userRole: 'organiser' }, undefined);

  const seats = await query<{ id: string }>('SELECT id FROM show_seats WHERE event_id = $1 ORDER BY id', [
    event.id,
  ]);
  return { eventId: event.id, organiserId, seatIds: seats.rows.map((row) => row.id) };
}

/** Books one seat for `userId` via the real HTTP hold+confirm path. */
async function book(eventId: string, userId: string, showSeatId: string): Promise<string> {
  const hold = await createHold({ eventId, userId, showSeatIds: [showSeatId], ttlSeconds: 600 });
  const reply = await post(`/api/v1/events/${eventId}/holds/${hold.holdId}/confirm`, userId);
  assert.equal(reply.status, 201, 'setup: booking must confirm');
  return reply.json.bookingId as string;
}

async function cancelBooking(bookingId: string, userId: string): Promise<void> {
  const reply = await post(`/api/v1/bookings/${bookingId}/cancel`, userId);
  assert.equal(reply.status, 200, 'setup: cancellation must succeed');
}

/** Claims and processes every pending allocation signal once - the worker's own loop, run inline. */
async function processAllocationOutbox(): Promise<{ offersCreated: number; failures: number }> {
  return withTransaction(async (client) => {
    const rows = await claimPendingAllocations(client, 100);
    let offersCreated = 0;
    let failures = 0;

    for (const row of rows) {
      try {
        const result = await runAllocationPass(client, row.eventId, row.seatCategory, undefined);
        await markAllocationProcessed(client, row.id);
        offersCreated += result.offersCreated;
      } catch (error) {
        await recordAllocationFailure(client, row.id, String(error), 100, 1_000);
        failures += 1;
      }
    }

    return { offersCreated, failures };
  });
}

async function pendingAllocationCount(eventId: string, category: string): Promise<number> {
  const result = await query<{ count: string }>(
    `SELECT count(*)::text AS count FROM waitlist_allocation_outbox
     WHERE event_id = $1 AND seat_category = $2 AND processed_at IS NULL`,
    [eventId, category],
  );
  return Number(result.rows[0]!.count);
}

interface OfferRow {
  id: string;
  waitlist_entry_id: string;
  show_seat_id: string;
  hold_id: string;
  status: string;
}

async function offersForEntry(entryId: string): Promise<OfferRow[]> {
  const result = await query<OfferRow>('SELECT * FROM waitlist_offers WHERE waitlist_entry_id = $1', [
    entryId,
  ]);
  return result.rows;
}

async function entryStatus(entryId: string): Promise<string> {
  const result = await query<{ status: string }>('SELECT status FROM waitlist_entries WHERE id = $1', [
    entryId,
  ]);
  return result.rows[0]!.status;
}

describe('cancellation creates an allocation opportunity', () => {
  it('enqueues a pending signal for the freed seat\'s event and category', async () => {
    const { eventId, seatIds } = await seedPublishedShow(1);
    const owner = await seedCustomer();
    const bookingId = await book(eventId, owner, seatIds[0]!);

    assert.equal(await pendingAllocationCount(eventId, 'standard'), 0, 'nothing pending before cancellation');

    await cancelBooking(bookingId, owner);

    assert.equal(await pendingAllocationCount(eventId, 'standard'), 1);
  });

  it('coalesces repeat signals for the same event and category into one row', async () => {
    const { eventId, seatIds } = await seedPublishedShow(2);
    const owner = await seedCustomer();
    const first = await book(eventId, owner, seatIds[0]!);
    const second = await book(eventId, owner, seatIds[1]!);

    await cancelBooking(first, owner);
    await cancelBooking(second, owner);

    assert.equal(await pendingAllocationCount(eventId, 'standard'), 1, 'coalesced, not two rows');
  });
});

describe('the allocation pass offers the freed seat to the first waiter', () => {
  it('creates an offer, a backing hold, and a notification row', async () => {
    const { eventId, seatIds } = await seedPublishedShow(1);
    const owner = await seedCustomer();
    const bookingId = await book(eventId, owner, seatIds[0]!);
    const waiter = await seedCustomer();
    const entryId = await join(eventId, waiter);

    await cancelBooking(bookingId, owner);
    const { offersCreated } = await processAllocationOutbox();

    assert.equal(offersCreated, 1);
    assert.equal(await entryStatus(entryId), 'offered');

    const offers = await offersForEntry(entryId);
    assert.equal(offers.length, 1);
    const offer = offers[0]!;
    assert.equal(offer.status, 'offered');
    assert.equal(offer.show_seat_id, seatIds[0]);

    const hold = await query<{ status: string; user_id: string; event_id: string }>(
      'SELECT status, user_id, event_id FROM reservation_holds WHERE id = $1',
      [offer.hold_id],
    );
    assert.equal(hold.rows[0]!.status, 'active');
    assert.equal(hold.rows[0]!.user_id, waiter, 'the hold belongs to the waiter, not the original owner');
    assert.equal(hold.rows[0]!.event_id, eventId);

    const seat = await query<{ status: string }>('SELECT status FROM show_seats WHERE id = $1', [
      seatIds[0],
    ]);
    assert.equal(seat.rows[0]!.status, 'held', 'the seat is held for the offer, not available to anyone else');

    const notifications = await query<{ type: string; payload: Record<string, unknown> }>(
      'SELECT type, payload FROM waitlist_notification_outbox WHERE offer_id = $1',
      [offer.id],
    );
    assert.equal(notifications.rowCount, 1);
    assert.equal(notifications.rows[0]!.type, 'WAITLIST_OFFER_CREATED');
    assert.equal(notifications.rows[0]!.payload.offerId, offer.id);
    assert.equal(notifications.rows[0]!.payload.userId, waiter);
    assert.equal(notifications.rows[0]!.payload.eventId, eventId);
    assert.equal(notifications.rows[0]!.payload.showSeatId, seatIds[0]);

    assert.equal(await pendingAllocationCount(eventId, 'standard'), 0, 'the signal is consumed');
  });

  it('is a no-op when nobody is waiting', async () => {
    const { eventId, seatIds } = await seedPublishedShow(1);
    const owner = await seedCustomer();
    const bookingId = await book(eventId, owner, seatIds[0]!);

    await cancelBooking(bookingId, owner);
    const { offersCreated } = await processAllocationOutbox();

    assert.equal(offersCreated, 0);
    const seat = await query<{ status: string }>('SELECT status FROM show_seats WHERE id = $1', [
      seatIds[0],
    ]);
    assert.equal(seat.rows[0]!.status, 'available');
  });
});

describe('FIFO ordering', () => {
  it('offers to the longest-waiting candidate first', async () => {
    const { eventId, seatIds } = await seedPublishedShow(1);
    const owner = await seedCustomer();
    const bookingId = await book(eventId, owner, seatIds[0]!);

    const first = await seedCustomer();
    const firstEntry = await join(eventId, first);
    await delay(20);
    const second = await seedCustomer();
    const secondEntry = await join(eventId, second);
    await delay(20);
    const third = await seedCustomer();
    const thirdEntry = await join(eventId, third);

    await cancelBooking(bookingId, owner);
    await processAllocationOutbox();

    assert.equal(await entryStatus(firstEntry), 'offered', 'the first joiner gets the offer');
    assert.equal(await entryStatus(secondEntry), 'waiting');
    assert.equal(await entryStatus(thirdEntry), 'waiting');
  });

  it('is decided by joined_at, not insertion order', async () => {
    // Inserted in one order, but with joined_at values that put them in the
    // OPPOSITE order - the only way to catch a missing ORDER BY. A table this
    // small with no other churn tends to return rows in insertion order when
    // unordered, so a test that inserts in FIFO order already would still
    // pass even with the ORDER BY deleted; this one would not.
    const { eventId, seatIds } = await seedPublishedShow(1);
    const owner = await seedCustomer();
    const bookingId = await book(eventId, owner, seatIds[0]!);

    const x = await seedCustomer();
    const y = await seedCustomer();
    const z = await seedCustomer();
    const entryX = await join(eventId, x);
    const entryY = await join(eventId, y);
    const entryZ = await join(eventId, z);

    await query(
      `UPDATE waitlist_entries SET joined_at = CASE id
         WHEN $1 THEN now()
         WHEN $2 THEN now() - interval '1 second'
         WHEN $3 THEN now() - interval '2 seconds'
       END
       WHERE id IN ($1, $2, $3)`,
      [entryX, entryY, entryZ],
    );

    await cancelBooking(bookingId, owner);
    await processAllocationOutbox();

    // Z has the earliest joined_at despite being inserted last.
    assert.equal(await entryStatus(entryZ), 'offered', 'the earliest joined_at wins, not insertion order');
    assert.equal(await entryStatus(entryX), 'waiting');
    assert.equal(await entryStatus(entryY), 'waiting');
  });

  it('breaks a tied joined_at by id, deterministically', async () => {
    // Forces two entries to share the exact same joined_at, which a burst of
    // concurrent joins can genuinely produce - the reason the FIFO index
    // includes `id` as a tie-breaker at all.
    const { eventId, seatIds } = await seedPublishedShow(1);
    const owner = await seedCustomer();
    const bookingId = await book(eventId, owner, seatIds[0]!);

    const a = await seedCustomer();
    const b = await seedCustomer();
    const entryA = await join(eventId, a);
    const entryB = await join(eventId, b);
    const tiedAt = new Date();
    await query('UPDATE waitlist_entries SET joined_at = $1 WHERE id = ANY($2::uuid[])', [
      tiedAt,
      [entryA, entryB],
    ]);

    const expectedWinner = [entryA, entryB].sort()[0]!;

    await cancelBooking(bookingId, owner);
    await processAllocationOutbox();

    assert.equal(await entryStatus(expectedWinner), 'offered');
    const loser = expectedWinner === entryA ? entryB : entryA;
    assert.equal(await entryStatus(loser), 'waiting');
  });
});

describe('multiple available seats', () => {
  it('pairs seats ascending by id with candidates in FIFO order', async () => {
    const { eventId, seatIds } = await seedPublishedShow(3);
    const owner = await seedCustomer();
    const bookingIds = await Promise.all(seatIds.map((seatId) => book(eventId, owner, seatId)));

    const first = await seedCustomer();
    const firstEntry = await join(eventId, first);
    await delay(20);
    const second = await seedCustomer();
    const secondEntry = await join(eventId, second);
    await delay(20);
    const third = await seedCustomer();
    const thirdEntry = await join(eventId, third);

    for (const bookingId of bookingIds) {
      await cancelBooking(bookingId, owner);
    }
    await processAllocationOutbox();

    const sortedSeatIds = [...seatIds].sort();
    const offersFirst = await offersForEntry(firstEntry);
    const offersSecond = await offersForEntry(secondEntry);
    const offersThird = await offersForEntry(thirdEntry);

    assert.equal(offersFirst[0]?.show_seat_id, sortedSeatIds[0]);
    assert.equal(offersSecond[0]?.show_seat_id, sortedSeatIds[1]);
    assert.equal(offersThird[0]?.show_seat_id, sortedSeatIds[2]);
  });

  it('leaves the remaining candidates waiting when seats run out first', async () => {
    const { eventId, seatIds } = await seedPublishedShow(1);
    const owner = await seedCustomer();
    const bookingId = await book(eventId, owner, seatIds[0]!);

    const entries = [];
    for (let i = 0; i < 5; i += 1) {
      const user = await seedCustomer();
      entries.push(await join(eventId, user));
      await delay(5);
    }

    await cancelBooking(bookingId, owner);
    const { offersCreated } = await processAllocationOutbox();

    assert.equal(offersCreated, 1);
    assert.equal(await entryStatus(entries[0]!), 'offered');
    for (const entryId of entries.slice(1)) {
      assert.equal(await entryStatus(entryId), 'waiting');
    }
  });
});

describe('category isolation', () => {
  it('never offers a premium seat to a standard waiter or vice versa', async () => {
    const organiserId = await seedOrganiser();
    const { venueId } = await seedVenue(1, 'A', 12, null, 'standard');
    const premiumVenueSeat = await query<{ id: string }>(
      `INSERT INTO venue_seats (venue_id, row_label, seat_number, category)
       VALUES ($1, 'B', 1, 'premium') RETURNING id`,
      [venueId],
    );
    const { event } = await createEvent({
      organiserId,
      venueId,
      title: `Mixed ${randomUUID()}`,
      eventType: 'concert',
      startsAt: new Date('2030-01-01T18:00:00.000Z'),
      endsAt: new Date('2030-01-01T20:00:00.000Z'),
      pricing: { standard: '100.00', premium: '250.00' },
    });
    await publishEvent({ eventId: event.id, userId: organiserId, userRole: 'organiser' }, undefined);

    const seats = await query<{ id: string; venue_seat_id: string }>(
      'SELECT id, venue_seat_id FROM show_seats WHERE event_id = $1',
      [event.id],
    );
    const standardSeatId = seats.rows.find((row) => row.venue_seat_id !== premiumVenueSeat.rows[0]!.id)!.id;
    const premiumSeatId = seats.rows.find((row) => row.venue_seat_id === premiumVenueSeat.rows[0]!.id)!.id;

    const owner = await seedCustomer();
    const standardBooking = await book(event.id, owner, standardSeatId);
    const premiumBooking = await book(event.id, owner, premiumSeatId);

    const standardWaiter = await seedCustomer();
    const premiumWaiter = await seedCustomer();
    const standardEntry = await join(event.id, standardWaiter, 'standard');
    const premiumEntry = await join(event.id, premiumWaiter, 'premium');

    await cancelBooking(standardBooking, owner);
    await cancelBooking(premiumBooking, owner);
    await processAllocationOutbox();

    const standardOffers = await offersForEntry(standardEntry);
    const premiumOffers = await offersForEntry(premiumEntry);

    assert.equal(standardOffers[0]?.show_seat_id, standardSeatId);
    assert.equal(premiumOffers[0]?.show_seat_id, premiumSeatId);
  });
});

describe('outbox atomicity', () => {
  it('leaves no offer and no notification when the pass fails partway through', async () => {
    const { eventId, seatIds } = await seedPublishedShow(1);
    const owner = await seedCustomer();
    const bookingId = await book(eventId, owner, seatIds[0]!);
    const waiter = await seedCustomer();
    const entryId = await join(eventId, waiter);

    await cancelBooking(bookingId, owner);

    await query(
      `ALTER TABLE waitlist_notification_outbox ADD CONSTRAINT tmp_force_failure CHECK (false) NOT VALID`,
    );
    try {
      const { offersCreated, failures } = await processAllocationOutbox();
      assert.equal(offersCreated, 0);
      assert.equal(failures, 1);
    } finally {
      await query(`ALTER TABLE waitlist_notification_outbox DROP CONSTRAINT tmp_force_failure`);
    }

    assert.equal(await entryStatus(entryId), 'waiting', 'the offered transition rolled back too');
    assert.equal((await offersForEntry(entryId)).length, 0);

    const seat = await query<{ status: string }>('SELECT status FROM show_seats WHERE id = $1', [
      seatIds[0],
    ]);
    assert.equal(seat.rows[0]!.status, 'available', 'the seat was never actually held');

    // The signal itself survives the failed attempt - retried, not lost.
    assert.equal(await pendingAllocationCount(eventId, 'standard'), 1);

    // recordAllocationFailure backs the row off into the future; wait past
    // that delay so the retry actually finds it eligible again.
    await delay(150);
    const retried = await processAllocationOutbox();
    assert.equal(retried.offersCreated, 1, 'a clean retry succeeds');
    assert.equal(await entryStatus(entryId), 'offered');
  });
});

describe('failure injection at the lock points rolls back cleanly', () => {
  for (const step of ['candidate-lock', 'seat-lock'] as const) {
    it(`leaves nothing behind when the transaction dies after the ${step}`, async () => {
      const { eventId, seatIds } = await seedPublishedShow(1);
      const owner = await seedCustomer();
      const bookingId = await book(eventId, owner, seatIds[0]!);
      const waiter = await seedCustomer();
      const entryId = await join(eventId, waiter);

      await cancelBooking(bookingId, owner);

      const { lockNextWaitingEntry } = await import('../src/modules/waitlist/waitlist.repository.js');
      const { lockEventSeats } = await import('../src/modules/reservations/reservation.repository.js');

      await assert.rejects(
        withTransaction(async (client) => {
          const entry = await lockNextWaitingEntry(client, eventId, 'standard');
          assert.ok(entry, 'setup: a candidate must be found');
          if (step === 'seat-lock') {
            await lockEventSeats(client, eventId, [seatIds[0]!]);
          }
          throw new Error('injected failure');
        }),
        /injected failure/,
      );

      assert.equal(await entryStatus(entryId), 'waiting', 'the candidate lock left no trace');
      const seat = await query<{ status: string }>('SELECT status FROM show_seats WHERE id = $1', [
        seatIds[0],
      ]);
      assert.equal(seat.rows[0]!.status, 'available');

      // A clean pass afterwards still works.
      const { offersCreated } = await processAllocationOutbox();
      assert.equal(offersCreated, 1);
    });
  }
});
